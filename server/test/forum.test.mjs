/*
 * The forum end to end: a real server on a spare port with a scratch database,
 * driven over HTTP the way a browser would. This is where the rules about who
 * may do what are checked.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimed, device, open } from "./receiving.mjs";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-test-"));
process.env.DATA_DIR = scratch;

const auth = await import("../src/auth.mjs");
const { db, media, mentions, notes, posts, revisions, users } = await import("../src/db.mjs");
const { pages, pageVersions, projects, proposals } = await import("../src/projects.mjs");
const { messages, rooms } = await import("../src/chat.mjs");
const { subscriptions } = await import("../src/push.mjs");

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

let base;
let child;
const people = {};

/* A push service of our own, on this machine: it keeps what the forum sends to the devices that
   subscribe with it, and says that an address under /gone is a subscription that has ended. */
let service;
let pushBase;
const pushed = [];
/* how long the forum waits, here, before telling devices of something said */
const PUSH_DELAY = 120;

before(async () => {
  for (const [username, name, role] of [
    ["zan", "Zan Huang", "admin"],
    ["mira", "Mira Okafor", "member"],
    ["tomas", "Tomás Lindqvist", "member"],
  ]) {
    const id = users.create({ username, name, role, passwordHash: await auth.hashPassword(`${username}-password`) });
    const token = auth.createSession(id);
    people[username] = { id, cookie: `session=${token}`, csrf: auth.findSession(token).csrf };
  }

  service = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      pushed.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.startsWith("/gone") ? 410 : 201).end();
    });
  });
  await new Promise((ready) => service.listen(0, "127.0.0.1", ready));
  pushBase = `http://127.0.0.1:${service.address().port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_ROOT,
    // LaTeX is switched off here, so that these tests say the same on every machine; test/tex.test.mjs draws
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: scratch,
      PUBLIC_URL: "",
      LATEX: "off",
      PUSH_HOSTS: new URL(pushBase).host,
      PUSH_DELAY_MS: String(PUSH_DELAY),
      // these tests ask for pages far faster than a reader does; the pace itself is tested apart, below
      PACE: "off",
      // conversations and projects are put away unless they are asked for. They are asked for here,
      // so that what is kept for the day they come back is still held to what it did; that a
      // forum without them has neither is tested apart, below
      MESSAGES: "on",
      PROJECTS: "on",
      NOTIFICATIONS: "on",
      // and so are the versions of a piece, and the list of those who are to be invited
      VERSIONS: "on",
      INVITATIONS: "on",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ready, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`the server stopped early (${code})`)));
    child.stdout.on("data", (chunk) => String(chunk).includes("listening") && ready());
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise((done) => child.once("exit", done));
    child.kill();
    await gone;
  }
  service?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- helpers */

const get = (path, who) =>
  fetch(base + path, { redirect: "manual", headers: who ? { Cookie: people[who].cookie } : {} });

/** posts a form as a browser would, with the member's CSRF token unless told otherwise */
function post(path, who, fields = {}, { csrf = true } = {}) {
  const body = new URLSearchParams(fields);
  if (who && csrf) body.set("_csrf", people[who].csrf);
  return fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: base, ...(who ? { Cookie: people[who].cookie } : {}) },
    body,
  });
}

/** the response sent the browser on to another page; gives back where */
function sentTo(response) {
  assert.ok(response.status >= 300 && response.status < 400, `expected a redirect, got ${response.status}`);
  return response.headers.get("location");
}

const noteId = (location) => Number(location.match(/#note-(\d+)$/)[1]);

const read = async (path, who) => (await get(path, who)).text();

/** asks as a browser does when an address is opened by itself, which says so in a header fetch will not send */
const opened = (path, who, how = { "Sec-Fetch-Dest": "document" }) =>
  new Promise((done, fail) => {
    request(base + path, { headers: { Cookie: people[who].cookie, ...how } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, type: res.headers["content-type"], text: Buffer.concat(chunks).toString("utf8") }));
    })
      .on("error", fail)
      .end();
  });

async function publish(fields, who = "zan") {
  const response = await post("/write", who, { status: "published", ...fields });
  return Number(sentTo(response).match(/^\/p\/(\d+)$/)[1]);
}

/**
 * Lets a member publish for as long as `work` takes, as a sub-admin given that would: a member
 * with nothing more than any member has writes nothing for the corpus.
 */
async function publishing(who, work) {
  users.setPermissions(people[who].id, ["write"]);
  try {
    return await work();
  } finally {
    users.setPermissions(people[who].id, []);
  }
}

/** saves a post again, as its edit form would */
const revise = (id, fields, who = "zan") => post(`/p/${id}/edit`, who, { status: "published", ...fields });

/** sends a file the way the editor does: the file is the body, and the token goes in a header */
function upload(who, bytes, { csrf = true } = {}) {
  return fetch(base + "/media", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: base,
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("a picture.png"),
      ...(who ? { Cookie: people[who].cookie } : {}),
      ...(who && csrf ? { "X-CSRF-Token": people[who].csrf } : {}),
    },
    body: bytes,
  });
}

/** the smallest PNG there is: one transparent dot */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/* ----------------------------------------------------------------- tests */

test("nothing is shown to someone who has not signed in", async () => {
  const id = await publish({ title: "Behind the door", body: "For members." });

  assert.equal(sentTo(await get("/")), "/login");
  assert.equal(sentTo(await get(`/p/${id}`)), `/login?next=${encodeURIComponent(`/p/${id}`)}`);
  assert.equal(sentTo(await get("/write")), "/login?next=%2Fwrite");
  assert.equal(sentTo(await post("/write", null, { body: "Let me in." })), "/login");
  assert.equal(sentTo(await post(`/p/${id}/notes`, null, { body: "Let me in." })), "/login");

  const page = await get("/login");
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /Behind the door/);
});

test("signing in takes a name and its password", async () => {
  const wrong = await post("/login", null, { username: "mira", password: "not-her-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const right = await post("/login", null, { username: "Mira", password: "mira-password", next: "/p/1" });
  assert.equal(sentTo(right), "/p/1");
  const cookie = right.headers.get("set-cookie");
  assert.match(cookie, /^session=[^;]+;.*HttpOnly/i);

  const journal = await fetch(base + "/", { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(journal.status, 200);
  assert.match(await journal.text(), /Mira Okafor/);
});

test("every member can read what an admin publishes", async () => {
  const id = await publish({ title: "On reading slowly", body: "Good things take a second reading." });

  // those who keep the forum come to the list of every piece; a member comes to the corpus, where it is drawn
  assert.match(await read("/", "zan"), /On reading slowly/);
  for (const who of ["mira", "tomas"]) {
    assert.equal(sentTo(await get("/", who)), "/corpus");
    assert.match(await read("/corpus", who), /On reading slowly/, `${who} sees it on the corpus`);
  }
  for (const who of ["zan", "mira", "tomas"]) {
    const page = await get(`/p/${id}`, who);
    assert.equal(page.status, 200);
    // the opening capital is set apart as a drop capital, so match what follows it
    assert.match(await page.text(), /ood things take a second reading\./);
  }
});

test("only those who keep the corpus change or delete what is published", async () => {
  const id = await publish({ title: "The admin's own", body: "Written by an admin." });
  const before = posts.ledger().length;

  assert.equal((await get(`/p/${id}/edit`, "mira")).status, 403);
  assert.equal((await post(`/p/${id}/edit`, "mira", { title: "Mine now", body: "Rewritten." })).status, 403);
  assert.equal((await post(`/p/${id}/delete`, "mira")).status, 403);

  assert.equal(posts.ledger().length, before, "nothing was added or taken away");
  assert.equal(posts.byId(id).title, "The admin's own");
  assert.equal(posts.byId(id).body, "Written by an admin.");

  // and a member is not offered what they cannot do
  const asMember = await (await get(`/p/${id}`, "mira")).text();
  assert.doesNotMatch(asMember, /href="\/write|\/edit"|\/delete"/);
  assert.match(await read("/", "zan"), /<a class="button" href="\/write">New Piece<\/a>/);
  const asAdmin = await (await get(`/p/${id}`, "zan")).text();
  assert.match(asAdmin, new RegExp(`/p/${id}/edit"`));

  assert.equal(sentTo(await post(`/p/${id}/edit`, "zan", { title: "Revised", body: "Second thoughts." })), `/p/${id}`);
  assert.equal(posts.byId(id).title, "Revised");
  assert.equal(sentTo(await post(`/p/${id}/delete`, "zan")), "/");
  assert.equal((await get(`/p/${id}`, "zan")).status, 404);
});

test("only those who keep the corpus write for it: a member is not offered it, and is refused", async () => {
  // nothing a member is shown leads to writing a piece or adding a work
  for (const path of ["/corpus", "/account", "/canon"]) assert.doesNotMatch(await read(path, "mira"), /href="\/write"|href="\/submit"/, path);
  for (const path of ["/write", "/submit"]) assert.equal((await get(path, "mira")).status, 403, path);

  const before = posts.ledger().length;
  for (const status of ["draft", "published"])
    assert.equal((await post("/write", "mira", { title: "Mine, for your eyes", body: "By a member.", status })).status, 403);
  assert.equal((await post("/submit", "mira", { title: "A book I liked", creator: "Someone" })).status, 403);
  assert.equal(posts.ledger().length, before, "nothing was kept");

  // those who keep it are offered both over the corpus, and the writing of a piece on the page it is kept from
  assert.match(
    await read("/corpus", "zan"),
    /<a class="button" href="\/write">New Piece<\/a>\s*<a class="button button--quiet" href="\/submit">Antecedent<\/a>/
  );
  const kept = await read("/", "zan");
  assert.match(kept, /<a class="button" href="\/write">New Piece<\/a>/);
  assert.doesNotMatch(kept, /href="\/submit"/, "an antecedent is added from the corpus");
  // and so is a sub-admin who has been given the writing of it
  await publishing("mira", async () => {
    for (const path of ["/write", "/submit"]) assert.equal((await get(path, "mira")).status, 200, path);
    assert.match(await read("/corpus", "mira"), /href="\/write">New Piece<\/a>/);
  });
});

test("a piece is written under a title, with a letter to set after it, and is published or saved", async () => {
  const blank = await read("/write", "zan");
  assert.match(blank, /<h1 class="page-title page-title--form">New Piece<\/h1>/);
  assert.match(blank, /<main class="column column--desk" id="main">/);
  assert.match(blank, /<label for="title">Title<\/label>\s*<input id="title" name="title" value="" maxlength="200" autocomplete="off" \/>/);
  assert.match(blank, /<label for="hand">Superscript<\/label>\s*<input id="hand" name="hand" value="" maxlength="2"/);
  assert.match(blank, /<label for="body">Text<\/label>/);
  // the two things that are so or not so of it are boxes to tick, with their names and nothing more
  assert.match(
    blank,
    /<div class="checks">\s*<label class="check"><input type="checkbox" name="show_tell" value="1"\s*\/> <span>Show and Tell<\/span><\/label>\s*<label class="check"><input type="checkbox" name="missionaria" value="1"\s*\/> <span>Missionaria<\/span><\/label>\s*<\/div>/
  );
  assert.match(
    blank,
    /<button class="button" type="submit" name="status" value="published">Publish<\/button>\s*<button class="button button--quiet" type="submit" name="status" value="draft">Save<\/button>/
  );
  // nothing is explained, counted or offered besides
  assert.doesNotMatch(
    blank,
    /class="hint"|data-count|Save for review|Open a text file|Writing it as plain text|class="guide"|<fieldset|<legend|What changed|type="file"[^>]*data-load-into|Optional/
  );

  // saved, it is not published; what its form offers then is the same, with the way to delete it
  const id = Number(sentTo(await post("/write", "zan", { title: "Saved for later", body: "Half of it.", status: "draft", show_tell: "1" })).match(/\d+/)[0]);
  assert.deepEqual([posts.byId(id).status, posts.byId(id).stage, posts.byId(id).show_tell], ["draft", "in-progress", 1]);
  const editing = await read(`/p/${id}/edit`, "zan");
  assert.match(editing, /<h1 class="page-title page-title--form">Edit<\/h1>/);
  assert.match(editing, /name="show_tell" value="1" checked \/>/);
  assert.match(editing, />Publish<\/button>\s*<button[^>]*value="draft">Save<\/button>/);
  assert.match(editing, /data-confirm="Delete this post for good\?">Delete this post<\/button>/);
  assert.doesNotMatch(editing, /Take back for review|Save as version|What changed/);

  // its page says how far along it is, and has no date and no margin
  const page = await read(`/p/${id}`, "zan");
  assert.match(page, /<p class="post__meta"><span>In Progress<\/span>/);
  assert.doesNotMatch(page, /<time|id="notes"|Margin notes|class="flourish"|id="commentaries"/);

  // published, there is one thing to press, which saves it; nothing is said of versions or of taking it back
  assert.equal(sentTo(await revise(id, { title: "Saved for later", body: "All of it." })), `/p/${id}`);
  const after = await read(`/p/${id}/edit`, "zan");
  assert.match(after, /<button class="button" type="submit" name="status" value="published">Save<\/button>\s*<a class="compose__cancel"/);
  assert.doesNotMatch(after, /value="draft"|Take back for review|Save as version/);
  const published = await read(`/p/${id}`, "mira");
  assert.match(published, /id="notes"/);
  assert.doesNotMatch(published, /<time|In Progress|Published/);

  // a piece can be saved as its title alone, as one that has not been started; with neither a title nor a word there is nothing to save
  const bare = Number(sentTo(await post("/write", "zan", { title: "Only a title so far", body: "", status: "draft" })).match(/\d+/)[0]);
  assert.deepEqual([posts.byId(bare).status, posts.byId(bare).stage], ["draft", "not-started"]);
  assert.match(await read(`/p/${bare}`, "zan"), /<p class="post__meta"><span>Not Started<\/span>/);
  sentTo(await revise(bare, { title: "Only a title so far", body: "And now a first line.", status: "draft" }));
  assert.equal(posts.byId(bare).stage, "in-progress", "begun, it is in progress");
  const refused = await post("/write", "zan", { title: " ", body: " ", status: "draft" });
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /There is nothing to save yet\./);

  for (const each of [id, bare]) sentTo(await post(`/p/${each}/delete`, "zan"));
});

test("the page the corpus is kept from lists every piece in two tables, each with how far along it is", async () => {
  const written = await publish({ title: "Listed among the succession", body: "Written here." });
  const waiting = await publish({ title: "Listed, and not yet out", body: "Written here too.", status: "draft" });
  const work = await addWork({ title: "Listed among the antecedents", creator: "Mary Ann Evans", medium: "Essay" });
  const nameless = await addWork({ title: "By nobody in particular", medium: "" });

  const list = await read("/", "zan");
  assert.match(list, /<title>Editorial · Gesserit<\/title>/);
  assert.match(list, /<h1 class="page-title">Editorial<\/h1>/);
  // two tables, the succession and then the antecedents, each headed by its name
  const tables = [...list.matchAll(/<table class="members ledger">[\s\S]*?<\/table>/g)].map((found) => found[0]);
  assert.equal(tables.length, 2);
  const heads = (table) => [...table.matchAll(/<th scope="col">(?:<span class="visually-hidden">)?([^<]+)/g)].map((found) => found[1]);
  assert.deepEqual(tables.map(heads), [["Succession", "Status", "Actions"], ["Antecedent", "Status", "Actions"]]);
  const [succession, antecedents] = tables;
  for (const id of [written, waiting]) {
    assert.match(succession, new RegExp(`<tr data-id="${id}">`));
    assert.doesNotMatch(antecedents, new RegExp(`<tr data-id="${id}">`));
  }
  for (const id of [work, nameless]) {
    assert.match(antecedents, new RegExp(`<tr data-id="${id}">`));
    assert.doesNotMatch(succession, new RegExp(`<tr data-id="${id}">`));
  }
  // what is written here is its title and nothing else; an antecedent has under its title whose it is, by their last name, and what it is
  const row = (id) => list.match(new RegExp(`<tr data-id="${id}">[\\s\\S]*?</tr>`))[0];
  assert.match(row(written), new RegExp(`<strong><a href="/p/${written}">Listed among the succession</a></strong>\\s*</td>`));
  assert.match(row(work), new RegExp(`<strong><a href="/p/${work}"><cite>Listed among the antecedents</cite></a></strong>\\s*<span class="ledger__more">Evans · Essay</span>`));
  assert.match(row(nameless), new RegExp(`<cite>By nobody in particular</cite></a></strong>\\s*</td>`));
  // each says how far along it is, in a list of the five there are, and leads to the form it is changed with
  const chosen = (id) => row(id).match(/<option value="([^"]+)" selected>([^<]+)<\/option>/).slice(1);
  assert.deepEqual(chosen(written), ["published", "Published"]);
  assert.deepEqual(chosen(waiting), ["in-progress", "In Progress"]);
  assert.deepEqual(chosen(work), ["published", "Published"]);
  assert.deepEqual(
    [...row(written).matchAll(/<option value="[^"]+"[^>]*>([^<]+)<\/option>/g)].map((found) => found[1]),
    ["Not Started", "In Progress", "Drafted", "Finished", "Published"]
  );
  assert.match(row(waiting), new RegExp(`<form method="post" action="/p/${waiting}/status" data-status>`));
  assert.match(row(waiting), new RegExp(`<a class="link" href="/p/${waiting}/edit">Edit</a>`));
  // nothing says when a piece was written, whose it is, or sorts them by how far along they are
  assert.doesNotMatch(list, /<time|Yours|From Zan|Show:|show=reviewing|show=published|Reviewing|class="tag|Add an antecedent|href="\/submit"/);
  assert.match(list, /<script src="\/static\/scribe\.js\?v=\w+" defer><\/script>/);

  // how far along a piece is, is said from the list: any of the stages leaves it unpublished, and Published publishes it
  const say = (id, status, who = "zan") => post(`/p/${id}/status`, who, { status });
  for (const [status, stage] of [["drafted", "drafted"], ["not-started", "not-started"], ["finished", "finished"]]) {
    assert.equal(sentTo(await say(waiting, status)), "/");
    assert.deepEqual([posts.byId(waiting).status, posts.byId(waiting).stage], ["draft", stage]);
  }
  assert.equal((await get(`/p/${waiting}`, "mira")).status, 404);
  assert.match(await read(`/p/${waiting}`, "zan"), /<p class="post__meta"><span>Finished<\/span>/);
  assert.equal(sentTo(await say(waiting, "published")), "/");
  assert.equal(posts.byId(waiting).status, "published");
  assert.equal((await get(`/p/${waiting}`, "mira")).status, 200);
  assert.match(await read("/corpus", "mira"), /Listed, and not yet out/);
  // said of what is published, a stage takes it back out of the corpus
  assert.equal(sentTo(await say(written, "drafted")), "/");
  assert.deepEqual([posts.byId(written).status, posts.byId(written).stage], ["draft", "drafted"]);
  assert.equal((await get(`/p/${written}`, "mira")).status, 404);
  assert.doesNotMatch(await read("/corpus", "mira"), /Listed among the succession/);
  sentTo(await say(written, "published"));
  // to the script that says it as soon as it is chosen, the answer is a word and not a page
  const quiet = await fetch(base + `/p/${work}/status`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: base, Cookie: people.zan.cookie, Accept: "application/json" },
    body: new URLSearchParams({ _csrf: people.zan.csrf, status: "finished" }),
  });
  assert.equal(quiet.status, 200);
  assert.deepEqual(await quiet.json(), { ok: true });
  assert.deepEqual([posts.byId(work).status, posts.byId(work).stage], ["draft", "finished"]);
  sentTo(await say(work, "published"));

  // it is said by those who keep the corpus, of what there is, in one of the five words, with the page's token
  assert.equal((await say(written, "published", "mira")).status, 403);
  assert.equal((await say(written, "reviewing")).status, 400);
  assert.equal((await say(written, "")).status, 400);
  assert.equal((await say(999999, "published")).status, 404);
  assert.equal((await post(`/p/${written}/status`, "zan", { status: "drafted" }, { csrf: false })).status, 403);
  assert.equal(posts.byId(written).status, "published");

  for (const id of [written, waiting, work, nameless]) sentTo(await post(`/p/${id}/delete`, "zan"));
});

test("the pieces of each table stand in the order their keeper puts them in, the newest first until then", async () => {
  const first = await publish({ title: "Ordered: the first written", body: "One." });
  const second = await publish({ title: "Ordered: the second written", body: "Two." });
  const third = await publish({ title: "Ordered: the third written", body: "Three.", status: "draft" });
  const work = await addWork({ title: "Ordered: a work" });
  const order = async () => {
    const list = await read("/", "zan");
    return [...list.matchAll(/<tr data-id="(\d+)">/g)].map((found) => Number(found[1])).filter((id) => [first, second, third, work].includes(id));
  };
  // a new piece comes in at the head of its table
  assert.deepEqual(await order(), [third, second, first, work]);

  // those who edit are given a handle on each row and the form the order is sent with; it is the script that shows the handles
  const list = await read("/", "zan");
  assert.match(list, /<tbody data-order>/);
  assert.match(list, new RegExp(`<tr data-id="${first}">\\s*<td class="ledger__move">\\s*<button class="ledger__grip" type="button" data-grip aria-label="Move Ordered: the first written: drag it, or use the arrow keys" hidden>`));
  assert.match(list, /<form method="post" action="\/order" data-order-form hidden>/);

  const arrange = (ids, who = "zan", how) => post("/order", who, { ids: ids.join(" ") }, how);
  assert.equal(sentTo(await arrange([first, third, second])), "/");
  assert.deepEqual(await order(), [first, third, second, work]);
  // the order holds whatever is said of a piece afterwards, and a newer piece still comes in at the head
  sentTo(await post(`/p/${third}/status`, "zan", { status: "published" }));
  sentTo(await revise(second, { title: "Ordered: the second written", body: "Two, reworded." }));
  assert.deepEqual(await order(), [first, third, second, work]);
  const fourth = await publish({ title: "Ordered: the fourth written", body: "Four." });
  assert.equal((await read("/", "zan")).match(/<tr data-id="(\d+)">/)[1], String(fourth));

  // it is for those who edit, and takes the ids of pieces and nothing else
  await publishing("mira", async () => {
    assert.equal((await arrange([second, first], "mira")).status, 403);
    assert.doesNotMatch(await read("/", "mira"), /data-grip|data-order|action="\/order"/);
  });
  assert.equal((await arrange([second, first], "zan", { csrf: false })).status, 403);
  for (const ids of [[], ["x"], [first, first], ["1;drop"], ["-1"]]) assert.equal((await arrange(ids)).status, 400, String(ids));
  assert.deepEqual(await order(), [first, third, second, work]);

  for (const id of [first, second, third, fourth, work]) sentTo(await post(`/p/${id}/delete`, "zan"));
});

test("the members' list is for admins alone, and nobody is added from it", async () => {
  assert.equal((await get("/members", "mira")).status, 403);
  // a member is added from the server itself: the page has no form for it, and takes none
  for (const who of ["mira", "zan"]) assert.equal((await post("/members", who, { name: "A Friend", username: "friend" })).status, 405, who);
  assert.equal(users.byUsername("friend"), undefined);
  const list = await read("/members", "zan");
  assert.doesNotMatch(list, /Add a member|action="\/members"|name="username"|class="hint"/);
  // each is listed by the name they go by, with the name they sign in with under it
  assert.match(list, /<strong><a href="\/m\/mira">Mira Okafor<\/a><\/strong\s*>\s*<span class="members__username">mira<\/span>/);
  assert.equal((await post(`/members/${people.tomas.id}/remove`, "mira")).status, 403);
  assert.equal((await get("/corpus", "tomas")).status, 200, "tomas is still a member");

  // it is reached from the page the forum is kept from, which a member does not have
  assert.equal((await get("/members", "zan")).status, 200);
  assert.match(await read("/", "zan"), /href="\/members"/);
  assert.doesNotMatch(await read("/corpus", "mira"), /href="\/members"/);
});

test("what is not published is seen by those who edit, and by no other member", async () => {
  const id = await publish({ title: "Not ready yet", body: "Half a thought.", status: "draft" });

  assert.equal((await get(`/p/${id}`, "zan")).status, 200);
  assert.match(await read("/", "zan"), /Not ready yet/);

  assert.equal((await get(`/p/${id}`, "mira")).status, 404);
  assert.doesNotMatch(await read("/corpus", "mira"), /Not ready yet/);
  assert.equal((await post(`/p/${id}/notes`, "mira", { body: "I can see this." })).status, 404);
});

test("members add margin notes and reply to each other", async () => {
  const id = await publish({ title: "A talking point", body: "Something worth an argument." });
  const path = `/p/${id}/notes`;

  const note = noteId(sentTo(await post(path, "mira", { body: "I am not sure this holds." })));
  const reply = noteId(sentTo(await post(path, "tomas", { body: "It holds on Thursdays.", parent: String(note) })));
  assert.equal(notes.byId(reply).parent_id, note);

  // a reply to a reply joins the same thread
  const second = noteId(sentTo(await post(path, "mira", { body: "Then see you Thursday.", parent: String(reply) })));
  assert.equal(notes.byId(second).parent_id, note);

  const [thread] = notes.threads(id);
  assert.equal(thread.id, note);
  assert.deepEqual(thread.replies.map((each) => each.id), [reply, second]);

  const page = await (await get(`/p/${id}`, "zan")).text();
  const inOrder = ["I am not sure this holds.", "It holds on Thursdays.", "Then see you Thursday."].map((words) =>
    page.indexOf(words)
  );
  assert.ok(inOrder.every((at) => at > 0), "all three are on the page");
  assert.deepEqual(inOrder, [...inOrder].sort((a, b) => a - b), "in the order they were written");
  assert.match(await read("/canon", "zan"), /1 margin note · 2 replies/);
});

test("a reply needs words, a living note to hang from, and the form it was sent with", async () => {
  const id = await publish({ title: "Rules of the margin", body: "Short and to the point." });
  const elsewhere = await publish({ title: "Another page", body: "With its own margin." });
  const path = `/p/${id}/notes`;
  const note = noteId(sentTo(await post(path, "mira", { body: "A note to hang replies from." })));
  const count = () => notes.threads(id).reduce((sum, thread) => sum + 1 + thread.replies.length, 0);

  const empty = await post(path, "tomas", { body: "   ", parent: String(note) });
  assert.equal(empty.status, 422);
  assert.match(await empty.text(), /A reply needs some words\./);

  assert.equal((await post(path, "tomas", { body: "x".repeat(5001), parent: String(note) })).status, 422);
  assert.equal((await post(path, "tomas", { body: "Hello?", parent: "999999" })).status, 404);
  assert.equal((await post(path, "tomas", { body: "Hello?", parent: "nonsense" })).status, 404);
  assert.equal((await post(`/p/${elsewhere}/notes`, "tomas", { body: "Wrong page.", parent: String(note) })).status, 404);
  assert.equal((await post(path, "tomas", { body: "No token.", parent: String(note) }, { csrf: false })).status, 403);

  assert.equal(count(), 1, "none of those were kept");
  assert.equal(notes.threads(elsewhere).length, 0);
});

test("a note is removed by its author or an admin, and no one else", async () => {
  const id = await publish({ title: "Second thoughts", body: "Some things are better unsaid." });
  const path = `/p/${id}/notes`;
  const note = noteId(sentTo(await post(path, "mira", { body: "Mira regrets this one." })));
  const reply = noteId(sentTo(await post(path, "tomas", { body: "Tomas answered it anyway.", parent: String(note) })));
  const lone = noteId(sentTo(await post(path, "tomas", { body: "Tomas thinks aloud." })));

  assert.equal((await post(`/notes/${note}/remove`, "tomas")).status, 403);
  assert.equal((await post(`/notes/${note}/remove`, "mira", {}, { csrf: false })).status, 403);
  assert.match(await (await get(`/p/${id}`, "zan")).text(), /Mira regrets this one\./);

  // her own note goes, but the answer to it is left standing under a placeholder
  assert.equal(sentTo(await post(`/notes/${note}/remove`, "mira")), `/p/${id}#notes`);
  let page = await (await get(`/p/${id}`, "zan")).text();
  assert.doesNotMatch(page, /Mira regrets this one\./);
  assert.match(page, /This note was removed\./);
  assert.match(page, /Tomas answered it anyway\./);

  // a thread whose note is gone takes no more replies
  assert.equal((await post(path, "zan", { body: "Too late.", parent: String(note) })).status, 404);
  assert.equal((await post(path, "zan", { body: "Too late.", parent: String(reply) })).status, 404);

  // an admin may remove anyone's; once nothing is left the thread disappears
  assert.equal(sentTo(await post(`/notes/${reply}/remove`, "zan")), `/p/${id}#notes`);
  assert.equal(sentTo(await post(`/notes/${lone}/remove`, "zan")), `/p/${id}#notes`);
  page = await (await get(`/p/${id}`, "zan")).text();
  assert.doesNotMatch(page, /Tomas answered it anyway\.|Tomas thinks aloud\.|This note was removed\./);
  assert.equal((await post(`/notes/${lone}/remove`, "zan")).status, 404, "it cannot be removed twice");
});

/* ------------------------------------ commentaries, tags, links, the graph */

test("a piece is answered with a commentary by those who publish, and by no other member", async () => {
  const id = await publish({ title: "A piece worth answering", body: "Say what you think." });
  const draft = await publish({ title: "Still being written", body: "Soon.", status: "draft" });

  // a member is not offered a commentary, and is refused one
  assert.equal((await get(`/write?on=${id}`, "mira")).status, 403);
  assert.equal((await post("/write", "mira", { on: String(id), title: "Nope", body: "No." })).status, 403);
  assert.doesNotMatch(await read(`/p/${id}`, "mira"), /href="\/write\?on=|id="commentaries"/);

  const answer = await publishing("mira", async () => {
    // given that she publishes, she has the page for one
    const blank = await get(`/write?on=${id}`, "mira");
    assert.equal(blank.status, 200);
    assert.match(await blank.text(), /Write a commentary[\s\S]*A piece worth answering/);
    assert.match(await read(`/p/${id}`, "mira"), new RegExp(`href="/write\\?on=${id}"`));

    // only what is published and still there can be answered
    for (const on of [String(draft), "999999", "nonsense"]) {
      assert.equal((await get(`/write?on=${on}`, "mira")).status, 404);
      assert.equal((await post("/write", "mira", { on, title: "Nope", body: "No." })).status, 404);
    }

    const made = await publish({ on: String(id), title: "An answer at length", body: "Here is what I think." }, "mira");
    assert.equal(posts.byId(made).parent_id, id);
    assert.equal(posts.byId(made).author_id, people.mira.id);

    // it is an article of its own, shown with what it answers, and listed under that
    assert.match(await read(`/p/${made}`, "tomas"), new RegExp(`A commentary on\\s+<a href="/p/${id}">A piece worth answering</a>`));
    const parent = await read(`/p/${id}`, "tomas");
    assert.match(parent, new RegExp(`id="commentaries"[\\s\\S]*href="/p/${made}">An answer at length</a>`));
    assert.doesNotMatch(parent, /href="\/write\?on=/, "which a member reads, and is not asked to add to");
    assert.match(await read("/canon", "tomas"), /A piece worth answering[\s\S]*?1 commentary/);

    // whoever wrote it and those who edit may change it; no one else
    assert.match(await read(`/p/${made}`, "mira"), new RegExp(`/p/${made}/edit"`));
    assert.doesNotMatch(await read(`/p/${made}`, "tomas"), /\/edit"/);
    assert.equal((await get(`/p/${made}/edit`, "tomas")).status, 403);
    assert.equal((await post(`/p/${made}/edit`, "tomas", { title: "Defaced", body: "Ha." })).status, 403);
    assert.equal((await post(`/p/${made}/delete`, "tomas")).status, 403);
    assert.equal(sentTo(await post(`/p/${made}/edit`, "mira", { title: "An answer, revised", body: "On reflection." })), `/p/${made}`);
    assert.equal(sentTo(await post(`/p/${made}/edit`, "zan", { title: "An answer, corrected", body: "On reflection." })), `/p/${made}`);
    assert.equal(posts.byId(made).title, "An answer, corrected");
    assert.equal(posts.byId(made).parent_id, id, "editing does not detach it");
    return made;
  });

  // once she no longer publishes, what she published is the corpus's, and not hers to change
  assert.equal((await get(`/p/${answer}/edit`, "mira")).status, 403);
  assert.equal((await post(`/p/${answer}/delete`, "mira")).status, 403);
});

test("a commentary that is not published is seen by whoever wrote it and those who edit", async () => {
  const id = await publish({ title: "Open to answers", body: "Go on." });
  await publishing("mira", async () => {
    const draft = await publish({ on: String(id), title: "Half an answer", body: "Not yet.", status: "draft" }, "mira");

    assert.equal((await get(`/p/${draft}`, "mira")).status, 200);
    assert.equal((await get(`/p/${draft}`, "zan")).status, 200);
    assert.equal((await get(`/p/${draft}`, "tomas")).status, 404);
    assert.equal((await get(`/p/${draft}/edit`, "tomas")).status, 404);

    // each of them has it in the list of every piece, which for her is her own and what is published
    assert.match(await read("/", "mira"), /Half an answer/);
    assert.match(await read("/", "zan"), /Half an answer/);
    assert.doesNotMatch(await read("/corpus", "tomas"), /Half an answer/);
    assert.doesNotMatch(await read(`/p/${id}`, "tomas"), /Half an answer/);

    // published, everyone has it; deleted by its author, they are sent back to what it answered
    await post(`/p/${draft}/edit`, "mira", { title: "A whole answer", body: "Now." });
    assert.match(await read(`/p/${id}`, "tomas"), /A whole answer/);
    assert.equal(sentTo(await post(`/p/${draft}/delete`, "mira")), `/p/${id}#commentaries`);
    assert.equal((await get(`/p/${draft}`, "mira")).status, 404);
  });
});

test("a sub-admin who publishes sees in the list what is published and their own, not what others have unfinished", async () => {
  const others = await publish({ title: "The keeper's unfinished piece", body: "Not for showing.", status: "draft" });
  const out = await publish({ title: "The keeper's finished piece", body: "For showing." });
  await publishing("mira", async () => {
    const own = await publish({ title: "Mira's unfinished piece", body: "Hers.", status: "draft" }, "mira");
    const list = await read("/", "mira");
    assert.match(list, /<h1 class="page-title">Editorial<\/h1>/);
    assert.match(list, /Mira(&#39;|’)s unfinished piece/);
    assert.match(list, /The keeper(&#39;|’)s finished piece/);
    assert.doesNotMatch(list, /The keeper(&#39;|’)s unfinished piece/);
    assert.equal((await get(`/p/${others}`, "mira")).status, 404);
    // what is hers she says the status of, and changes; what is another's she reads
    const row = (id) => list.match(new RegExp(`<tr data-id="${id}">[\\s\\S]*?</tr>`))[0];
    assert.match(row(own), new RegExp(`action="/p/${own}/status"[\\s\\S]*href="/p/${own}/edit">Edit</a>`));
    assert.match(row(out), /<td class="ledger__status">\s*Published\s*<\/td>/);
    assert.doesNotMatch(row(out), /<select|\/edit"/);
    assert.equal((await post(`/p/${out}/status`, "mira", { status: "drafted" })).status, 403);
    assert.equal((await post(`/p/${others}/status`, "mira", { status: "published" })).status, 404);
    assert.equal(sentTo(await post(`/p/${own}/status`, "mira", { status: "drafted" })), "/");
    assert.equal(posts.byId(own).stage, "drafted");
    assert.equal(sentTo(await post(`/p/${own}/edit`, "mira", { title: "Mira's finished piece", body: "Hers.", status: "published" })), `/p/${own}`);
    assert.equal(posts.byId(own).status, "published");
    assert.equal((await get(`/p/${own}/edit`, "mira")).status, 200);
    await post(`/p/${own}/delete`, "mira");
  });
  await post(`/p/${others}/delete`, "zan");
  await post(`/p/${out}/delete`, "zan");
});

test("a commentary outlives the post it answered", async () => {
  const id = await publish({ title: "Soon to be withdrawn", body: "Briefly here." });
  const answer = await publishing("tomas", () =>
    publish({ on: String(id), title: "An answer left standing", body: "Still here." }, "tomas")
  );

  assert.equal(sentTo(await post(`/p/${id}/delete`, "zan")), "/");
  const page = await get(`/p/${answer}`, "mira");
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /A commentary on/);
  assert.equal(posts.byId(answer).parent_id, null);
});

test("members tag one another with @name, and where each was tagged is kept", async () => {
  const id = await publish({ title: "Something to point at", body: "Look here." });
  const path = `/p/${id}/notes`;
  // no page lists where a member was tagged now; what is kept is what a page would list
  const tagged = (who) => mentions.forUser(people[who].id).filter((tag) => tag.post_id === id);

  const note = noteId(sentTo(await post(path, "tomas", { body: "@mira, you will want to see this. So will @tomas and @nobody." })));
  const page = await read(`/p/${id}`, "zan");
  assert.match(page, /<a class="mention" href="\/m\/mira">@Mira Okafor<\/a>, you will want/);
  assert.match(page, /and @nobody\./, "a name no member has stays as it was typed");

  assert.deepEqual(tagged("mira").map((tag) => [tag.note_id, tag.by_name]), [[note, "Tomás Lindqvist"]]);
  // tagging yourself tells no one
  assert.deepEqual(tagged("tomas"), []);

  // a reply tags too; a removed note no longer does
  const reply = noteId(sentTo(await post(path, "zan", { body: "And @Mira again.", parent: String(note) })));
  assert.deepEqual(tagged("mira").map((tag) => tag.note_id), [reply, note]);
  await post(`/notes/${reply}/remove`, "zan");
  assert.deepEqual(tagged("mira").map((tag) => tag.note_id), [note]);

  // nothing in the menu counts them, and Preferences does not list them
  assert.doesNotMatch(await read("/corpus", "mira"), /class="badge"/);
  assert.doesNotMatch(await read("/account", "mira"), /tagged you|Something to point at/);
});

test("a post tags the members it names once it is published", async () => {
  const tagged = () => mentions.forUser(people.tomas.id).filter((tag) => tag.post_title === "With thanks");
  const id = await publish({ title: "With thanks", body: "This began with something @tomas said.", status: "draft" });
  assert.deepEqual(tagged(), [], "what is not published tags no one");

  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something @tomas said." });
  assert.deepEqual(tagged().map((tag) => [tag.post_id, tag.note_id, tag.by_name]), [[id, null, "Zan Huang"]]);
  assert.match(await read(`/p/${id}`, "mira"), /<a class="mention" href="\/m\/tomas">@Tomás Lindqvist<\/a>/);

  // saving it again does not tag him a second time; taking his name out withdraws the tag
  const first = tagged()[0].id;
  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something @tomas said. Revised." });
  assert.deepEqual(tagged().map((tag) => tag.id), [first]);
  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something somebody said." });
  assert.deepEqual(tagged(), []);
});

test("articles link to one another by title, and each lists what links to it", async () => {
  const first = await publish({ title: "The first of a pair", body: "To be pointed at." });
  const second = await publish({
    title: "The second of a pair",
    body: `See [[the first of a pair]], or [by its address](/p/${first}), and [[One not written yet]].`,
  });

  const page = await read(`/p/${second}`, "mira");
  assert.match(page, new RegExp(`<a class="wikilink" href="/p/${first}">The first of a pair</a>`));
  assert.match(page, /wikilink--missing[^>]*>One not written yet</);
  assert.match(await read(`/p/${first}`, "mira"), new RegExp(`id="linked-from"[\\s\\S]*href="/p/${second}">The second of a pair</a>`));
  assert.doesNotMatch(await read(`/p/${second}`, "mira"), /id="linked-from"/);

  // a name written before its article exists begins to lead there once it does
  const third = await publish({ title: "One not written yet", body: "Now written." });
  assert.match(await read(`/p/${second}`, "mira"), new RegExp(`<a class="wikilink" href="/p/${third}">One not written yet</a>`));
  assert.match(await read(`/p/${third}`, "mira"), new RegExp(`id="linked-from"[\\s\\S]*href="/p/${second}"`));

  // a draft is not led to, and what links to a post goes when the linking post does
  await post(`/p/${third}/edit`, "zan", { title: "One not written yet", body: "Withdrawn.", status: "draft" });
  assert.match(await read(`/p/${second}`, "mira"), /wikilink--missing[^>]*>One not written yet</);
  await post(`/p/${second}/delete`, "zan");
  assert.doesNotMatch(await read(`/p/${first}`, "mira"), /id="linked-from"/);
});

test("the corpus draws what is published as its titles, with no lines between them; what touches a piece is drawn around it", async () => {
  const article = await publish({ title: "A node in the graph", body: "At the centre." });
  const answer = await publishing("mira", () =>
    publish({ on: String(article), title: "A node beside it", body: "See [[A node in the graph]]." }, "mira")
  );
  await post(`/p/${article}/notes`, "tomas", { body: "Noted." });
  const hidden = await publish({ title: "Not on the graph", body: "A draft.", status: "draft" });

  assert.equal(sentTo(await get("/corpus")), "/login?next=%2Fcorpus");
  const response = await get("/corpus", "tomas");
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /<a href="\/corpus" aria-current="page">Corpus<\/a>/);
  assert.match(page, /<script src="\/static\/corpus\.js\?v=\w+" defer><\/script>/);
  const has = (pattern) => assert.match(page, pattern);

  // what is written here is the succession, which is lettered in green whoever wrote it
  has(new RegExp(`class="node node--article node--leaf"\\s+href="/p/${article}"\\s+data-id="p${article}"`));
  has(new RegExp(`class="node node--commentary node--leaf"\\s+href="/p/${answer}"`));
  assert.doesNotMatch(page, new RegExp(`data-id="p${hidden}"`), "what is not published is not drawn");
  assert.doesNotMatch(page, /Not on the graph/);
  // the whole of it is titles on the page and nothing else: no lines, no arrowheads, no rings, no members, whatever is asked for
  has(/<div\s+class="graph graph--whole"\s+data-graph\s+data-origin="[\d.]+ [\d.]+"\s*>/);
  for (const whole of [page, await read("/corpus?show=people", "tomas")])
    assert.doesNotMatch(whole, /class="edge|<marker|marker-end|class="ring|node--person|node--lineage|show=people/);

  // a piece is drawn as its title, and its author is not named
  assert.match(page, new RegExp(`data-id="p${answer}"\\s+data-name="A node beside it"[\\s\\S]*?<rect class="node__plate"[^>]*/>\\s*<text[^>]*><tspan class="node__title"[^>]*>A node beside it</tspan></text>`));
  assert.match(page, new RegExp(`data-id="p${answer}"[\\s\\S]*?aria-label="A node beside it — a commentary[ ·"]`));
  assert.doesNotMatch(page, /a commentary by|an article by/);

  // around one piece, what touches it is drawn with the lines between them, which have no arrowheads; and, asked for, who had a hand in it
  const near = await read(`/corpus?around=p${article}&show=people`, "tomas");
  assert.match(near, /<div\s+class="graph"\s+data-graph\s*>/);
  for (const pattern of [
    new RegExp(`class="node node--person"\\s+href="/m/tomas"\\s+data-id="u${people.tomas.id}"`),
    new RegExp(`class="edge edge--commentary"\\s+data-from="p${answer}"\\s+data-to="p${article}"`),
    new RegExp(`class="edge edge--link"\\s+data-from="p${answer}"\\s+data-to="p${article}"`),
    new RegExp(`class="edge edge--wrote"\\s+data-from="u${people.zan.id}"\\s+data-to="p${article}"`),
    new RegExp(`class="edge edge--note"\\s+data-from="u${people.tomas.id}"\\s+data-to="p${article}"`),
  ])
    assert.match(near, pattern);
  assert.doesNotMatch(near, /<marker|marker-end|class="ring/);
  assert.doesNotMatch(await read(`/corpus?around=p${article}`, "tomas"), /node--person|edge--wrote|edge--note/, "the members are left out unless they are asked for");

  // it was the graph, and is still found where the graph was
  assert.equal(sentTo(await get("/graph", "tomas")), "/corpus");
  assert.equal(sentTo(await get(`/graph?around=p${article}&show=articles`, "tomas")), `/corpus?around=p${article}`);
  assert.equal(sentTo(await get("/graph")), "/login?next=%2Fgraph");
});

test("each member has a page of what they have written", async () => {
  const id = await publish({ title: "Something Mira answered", body: "An opening." });
  await publishing("mira", () => publish({ on: String(id), title: "A reply at length from Mira", body: "At length." }, "mira"));
  await post(`/p/${id}/notes`, "mira", { body: "And a note in the margin as well." });

  assert.equal(sentTo(await get("/m/mira")), "/login?next=%2Fm%2Fmira");
  const page = await read("/m/MIRA", "tomas");
  assert.match(page, /<h1 class="page-title">Mira Okafor<\/h1>/);
  assert.match(page, /A reply at length from Mira/);
  assert.match(page, /And a note in the margin as well\./);
  assert.match(page, /<code>@mira<\/code>/);
  assert.equal((await get("/m/nobody", "tomas")).status, 404);

  // the name beside a note leads here; a piece names no author over it
  const piece = await read(`/p/${id}`, "tomas");
  assert.match(piece, /<a href="\/m\/mira">Mira Okafor<\/a>/);
  assert.doesNotMatch(piece, /href="\/m\/zan"/);
});

test("names are offered while writing, to members only", async () => {
  await publish({ title: "A title to be offered", body: "By name." });
  assert.equal(sentTo(await get("/suggest.json")), "/login?next=%2Fsuggest.json");

  const response = await get("/suggest.json", "mira");
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const offered = await response.json();
  assert.deepEqual(offered.people.map((person) => person.username).sort(), ["tomas", "zan"], "everyone but herself");
  assert.deepEqual(Object.keys(offered.people[0]).sort(), ["name", "username"], "and nothing else about them");
  assert.ok(offered.articles.includes("A title to be offered"));
  assert.ok(!offered.articles.includes("Not on the graph"), "drafts are not offered");
});

/* --------------------------------------------- versions of what is posted */

test("every wording a post is published with is kept as a version", async () => {
  const id = await publish({ title: "On second thoughts", body: "The first wording, set down in haste." });
  const numbers = () => revisions.list(id).map((version) => version.n);
  assert.deepEqual(numbers(), [1], "publishing makes the first");
  assert.doesNotMatch(await read(`/p/${id}`, "mira"), new RegExp(`/p/${id}/history`), "with one version there is no history to offer");

  // a save that changes the text makes another, with the line saying what changed
  sentTo(await revise(id, { title: "On second thoughts", body: "The second wording, set down at leisure.", summary: "  Slowed   down " }));
  assert.deepEqual(numbers(), [2, 1]);
  const [second, first] = revisions.list(id);
  assert.equal(second.summary, "Slowed down");
  assert.equal(second.editor_username, "zan");
  assert.deepEqual([second.added, second.removed], [3, 3]);
  assert.equal(first.body, "The first wording, set down in haste.");
  assert.equal(posts.byId(id).version, 2);

  // one that changes nothing makes none, and neither does a change to the line about it
  sentTo(await revise(id, { title: "On second thoughts", body: "The second wording, set down at leisure.", summary: "Nothing, really" }));
  assert.deepEqual(numbers(), [2, 1]);

  // a new title alone is a new version
  sentTo(await revise(id, { title: "On third thoughts", body: "The second wording, set down at leisure." }));
  assert.deepEqual(numbers(), [3, 2, 1]);

  // any member can see that it was revised, read each version as it stood, and see what changed
  const page = await read(`/p/${id}`, "mira");
  assert.match(page, new RegExp(`<a href="/p/${id}/history">Version 3</a>, revised`));

  const history = await read(`/p/${id}/history`, "mira");
  assert.match(history, /Version 3<\/a>\s*<span class="tag">Current<\/span>/);
  assert.match(history, /<p class="version__summary">Slowed down<\/p>/);
  assert.match(history, /Title changed to “On third thoughts”/);
  assert.match(history, /3 words added, 3 removed/);
  assert.doesNotMatch(history, /Restore this version/, "which is not for a member to do");
  assert.match(await read(`/p/${id}/history`, "zan"), /Restore this version/);

  const old = await read(`/p/${id}/v/1`, "mira");
  assert.match(old, /This is <strong>version 1<\/strong> of 3/);
  assert.match(old, /<h1 class="post__title">On second thoughts<\/h1>/);
  assert.match(old, /he first wording, set down in haste\./);
  assert.doesNotMatch(old, /at leisure/);
  assert.match(await read(`/p/${id}/v/3`, "mira"), /This is <strong>version 3<\/strong>, the current one/);

  const changed = await read(`/p/${id}/changes?from=1&to=2`, "mira");
  assert.match(changed, /The <del>first<\/del>\s*<ins>second<\/ins> wording, set down <del>in haste<\/del>\s*<ins>at leisure<\/ins>\./);
  // with nothing asked for, it is what the latest version changed: here, the title
  const latest = await read(`/p/${id}/changes`, "mira");
  assert.match(latest, /<del>On second thoughts<\/del>\s*<ins>On third thoughts<\/ins>/);
  assert.doesNotMatch(latest, /class="diff"/);

  for (const path of [`/p/${id}/v/4`, `/p/${id}/v/0`, `/p/${id}/v/x`, `/p/${id}/changes?from=1&to=9`, `/p/${id}/changes?to=1`, "/p/999999/history"]) {
    assert.equal((await get(path, "mira")).status, 404, path);
  }
  for (const path of [`/p/${id}/history`, `/p/${id}/v/1`, `/p/${id}/changes`]) {
    assert.equal(sentTo(await get(path)), `/login?next=${encodeURIComponent(path)}`, "and none of it without signing in");
  }
});

test("a draft leaves no versions until it is published, and keeps them if it is withdrawn", async () => {
  const id = await publish({ title: "Still in the drawer", body: "A first try.", status: "draft" });
  await revise(id, { title: "Still in the drawer", body: "A second try.", status: "draft" });
  assert.equal(revisions.list(id).length, 0);
  assert.match(await read(`/p/${id}/history`, "zan"), /This has not been published yet\./);
  assert.equal((await get(`/p/${id}/history`, "mira")).status, 404, "a draft's history is as private as the draft");

  await revise(id, { title: "Out of the drawer", body: "A third try." });
  assert.deepEqual(
    revisions.list(id).map((version) => [version.n, version.body]),
    [[1, "A third try."]],
    "what it said as a draft is nobody's business"
  );

  await revise(id, { title: "Out of the drawer", body: "A fourth try, not shown yet.", status: "draft" });
  assert.equal(revisions.list(id).length, 1);
  assert.equal((await get(`/p/${id}/v/1`, "mira")).status, 404);
  assert.match(await read(`/p/${id}/history`, "zan"), /This is unpublished at present\./);

  await revise(id, { title: "Out of the drawer", body: "A fourth try, not shown yet." });
  assert.deepEqual(revisions.list(id).map((version) => version.n), [2, 1]);
});

test("an earlier version is put back as a new one, by those who may edit the post", async () => {
  const id = await publish({ title: "Back and forth", body: "As it first was." });
  await revise(id, { title: "Back and forth, revised", body: "As it was changed to be.", summary: "Changed" });

  assert.equal((await post(`/p/${id}/restore`, "mira", { n: "1" })).status, 403);
  assert.equal((await post(`/p/${id}/restore`, "zan", { n: "1" }, { csrf: false })).status, 403);
  for (const n of ["7", "0", "", "1 OR 1=1"]) assert.equal((await post(`/p/${id}/restore`, "zan", { n })).status, 404, n);
  assert.equal(posts.byId(id).body, "As it was changed to be.");
  assert.equal(revisions.list(id).length, 2);

  assert.equal(sentTo(await post(`/p/${id}/restore`, "zan", { n: "1" })), `/p/${id}`);
  const [third, second] = revisions.list(id);
  assert.deepEqual([third.n, third.title, third.body, third.summary], [3, "Back and forth", "As it first was.", "Restored version 1"]);
  assert.equal(second.body, "As it was changed to be.", "and what it replaced is still there to be read");
  assert.equal(posts.byId(id).title, "Back and forth");
  assert.match(await read(`/p/${id}/v/2`, "tomas"), /s it was changed to be\./);

  // what a sub-admin who publishes has written is theirs to restore, though they are no admin
  await publishing("mira", async () => {
    const answer = await publish({ on: String(id), title: "A member's answer", body: "First." }, "mira");
    await revise(answer, { title: "A member's answer", body: "Second." }, "mira");
    assert.equal((await post(`/p/${answer}/restore`, "tomas", { n: "1" })).status, 403);
    assert.equal(sentTo(await post(`/p/${answer}/restore`, "mira", { n: "1" })), `/p/${answer}`);
    assert.equal(posts.byId(answer).body, "First.");
  });
});

test("a save begun from an older wording does not silently replace a newer one", async () => {
  const id = await publish({ title: "Two hands at once", body: "As both of them found it." });
  const baseOf = (page) => page.match(/name="base" value="([^"]+)"/)[1];
  const begun = baseOf(await read(`/p/${id}/edit`, "zan"));

  // someone else saves while the form is open
  await new Promise((done) => setTimeout(done, 5));
  sentTo(await revise(id, { title: "Two hands at once", body: "As the first to save left it." }));

  const late = await revise(id, { title: "Two hands at once", body: "As the second meant to leave it.", base: begun });
  assert.equal(late.status, 409);
  const page = await late.text();
  assert.match(page, /This was changed while you were writing\./);
  assert.match(page, /As the second meant to leave it\./, "what was written is still in the form");
  assert.equal(posts.byId(id).body, "As the first to save left it.");

  // sent again from that page, knowingly, it goes through
  sentTo(await revise(id, { title: "Two hands at once", body: "As the second meant to leave it.", base: baseOf(page) }));
  assert.equal(posts.byId(id).body, "As the second meant to leave it.");
  assert.deepEqual(revisions.list(id).map((version) => version.n), [3, 2, 1]);
});

test("a note is reworded by its author alone, and what it said before is kept", async () => {
  const id = await publish({ title: "Words to take back", body: "Something to be hasty about." });
  const path = `/p/${id}/notes`;
  const note = noteId(sentTo(await post(path, "mira", { body: "This is plainly wrong." })));
  const reply = noteId(sentTo(await post(path, "tomas", { body: "Is it?", parent: String(note) })));

  assert.equal((await post(`/notes/${note}/edit`, "tomas", { body: "I agree with everything." })).status, 403);
  assert.equal((await post(`/notes/${note}/edit`, "zan", { body: "I agree with everything." })).status, 403, "not even an admin puts words in her mouth");
  assert.equal((await post(`/notes/${note}/edit`, "mira", { body: "Without the token." }, { csrf: false })).status, 403);
  assert.equal((await post("/notes/999999/edit", "mira", { body: "To nothing." })).status, 404);
  const empty = await post(`/notes/${note}/edit`, "mira", { body: "   " });
  assert.equal(empty.status, 422);
  assert.match(await empty.text(), /A note needs some words\./);
  assert.equal(notes.byId(note).body, "This is plainly wrong.");
  assert.equal(notes.byId(note).edited_at, null);
  assert.doesNotMatch(await read(`/p/${id}`, "mira"), /class="fold was"/);

  // only the author is offered it
  assert.match(await read(`/p/${id}`, "mira"), new RegExp(`action="/notes/${note}/edit"`));
  assert.doesNotMatch(await read(`/p/${id}`, "zan"), new RegExp(`action="/notes/${note}/edit"`));

  assert.equal(sentTo(await post(`/notes/${note}/edit`, "mira", { body: "I am not sure this is right." })), `/p/${id}#note-${note}`);
  assert.equal(sentTo(await post(`/notes/${reply}/edit`, "tomas", { body: "Is it, though?" })), `/p/${id}#note-${reply}`);
  // saved again with nothing changed, it is not counted as reworded twice
  sentTo(await post(`/notes/${note}/edit`, "mira", { body: "I am not sure this is right." }));

  const [thread] = notes.threads(id);
  assert.equal(thread.body, "I am not sure this is right.");
  assert.deepEqual(thread.earlier.map((wording) => wording.body), ["This is plainly wrong."]);
  assert.deepEqual(thread.replies[0].earlier.map((wording) => wording.body), ["Is it?"]);
  assert.ok(notes.byId(note).edited_at);

  const page = await read(`/p/${id}`, "zan");
  assert.match(page, /I am not sure this is right\./);
  assert.match(page, /class="note__edited">edited/);
  assert.match(page, /<summary>Earlier wording<\/summary>[\s\S]*This is plainly wrong\./);

  // a removed note is past rewording
  await post(`/notes/${reply}/remove`, "tomas");
  assert.equal((await post(`/notes/${reply}/edit`, "tomas", { body: "One more thing." })).status, 404);
});

test("rewording a note tags whoever it now names, and no longer those it does not", async () => {
  const id = await publish({ title: "A change of address", body: "Who is this for?" });
  const tagged = (who) => mentions.forUser(people[who].id).filter((tag) => tag.post_id === id).map((tag) => [tag.note_id, tag.by_name]);

  const note = noteId(sentTo(await post(`/p/${id}/notes`, "mira", { body: "One for @tomas." })));
  assert.deepEqual(tagged("tomas"), [[note, "Mira Okafor"]]);
  sentTo(await post(`/notes/${note}/edit`, "mira", { body: "One for @zan, rather." }));
  assert.deepEqual(tagged("tomas"), []);
  assert.deepEqual(tagged("zan"), [[note, "Mira Okafor"]]);
});

test("a note remembers which version of the post it was written on", async () => {
  const id = await publish({ title: "A moving target", body: "The passage as first written." });
  const early = noteId(sentTo(await post(`/p/${id}/notes`, "mira", { body: "On this.", quote: "as first written", pos: "12" })));
  await revise(id, { title: "A moving target", body: "The passage as it now stands." });
  const late = noteId(sentTo(await post(`/p/${id}/notes`, "tomas", { body: "And on this." })));

  assert.equal(notes.byId(early).version, 1);
  assert.equal(notes.byId(late).version, 2);
  // the page says so, for the script that leads a reader back to the passage as it was
  const page = await read(`/p/${id}`, "zan");
  assert.match(page, new RegExp(`id="note-${early}"[^>]*data-version="1"`));
  assert.match(page, new RegExp(`data-article data-post="${id}" data-version="2"`));
});

/* ----------------------------------------- pictures, formulas, diagrams */

test("members upload pictures, which are kept as what their bytes say they are", async () => {
  const response = await upload("mira", DOT);
  assert.equal(response.status, 201);
  const { url } = await response.json();
  assert.match(url, /^\/media\/[a-z0-9]+\.png$/);
  const kept = media.byName(url.slice("/media/".length));
  assert.deepEqual([kept.type, kept.bytes, kept.user_id, kept.original], ["image/png", DOT.length, people.mira.id, "a picture.png"]);

  // shown to members, never to anyone else, and never as anything that could run
  const shown = await get(url, "tomas");
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.match(shown.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
  // the picture is as it was uploaded, to the last dot; the file has had written into it who fetched it
  const sent = Buffer.from(await shown.arrayBuffer());
  assert.equal(Number(shown.headers.get("content-length")), sent.length);
  const note = sent.subarray(33, sent.length - (DOT.length - 33));
  assert.deepEqual(Buffer.concat([sent.subarray(0, 33), sent.subarray(33 + note.length)]), DOT);
  assert.match(note.toString("latin1"), /^.{4}tEXtComment\0Gesserit: fetched by tomas on \d{4}-\d\d-\d\d \(sign-in \d+\).{4}$/s);
  assert.doesNotMatch((await get(url, "mira").then((hers) => hers.arrayBuffer()).then((bytes) => Buffer.from(bytes))).toString("latin1"), /tomas/);
  assert.equal(sentTo(await get(url)), `/login?next=${encodeURIComponent(url)}`);

  // opened by itself, as a browser does from "open image in new tab", it is shown on a page of the forum
  const alone = await opened(url, "tomas");
  assert.match(alone.type, /^text\/html/);
  const page = alone.text;
  assert.match(page, new RegExp(`<figure class="alone">\\s*<img src="${url}" alt="" />`));
  assert.match(page, /<div class="mark" aria-hidden="true" style="background-image:url\(\/mark\/\d+-\d+-paper\.svg\?v=\d+\)"><\/div>/);
  assert.equal((await opened("/media/nothing.png", "tomas")).status, 404);
  // so it is in a frame or an app's own window, which are gone to as a tab is; set in a page it is the picture
  assert.match((await opened(url, "tomas", { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" })).type, /^text\/html/);
  assert.equal((await opened(url, "tomas", { "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors" })).type, "image/png");

  // an SVG is a picture too, and one with a script in it is served so that the script cannot run
  const drawing = await upload("tomas", Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  assert.equal(drawing.status, 201);
  const vector = await get((await drawing.json()).url, "mira");
  assert.equal(vector.headers.get("content-type"), "image/svg+xml");
  assert.match(vector.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
});

test("an upload needs a member, their token, and something that is a picture", async () => {
  const count = () => media.count();

  const before = count();
  const signedOut = await upload(null, DOT);
  assert.equal(signedOut.status, 401);
  assert.match((await signedOut.json()).error, /signed out/);

  const noToken = await upload("mira", DOT, { csrf: false });
  assert.equal(noToken.status, 403);
  assert.match((await noToken.json()).error, /out of date/);

  for (const [bytes, status, says] of [
    [Buffer.from("<html><script>alert(1)</script></html>"), 415, /not a picture/],
    [Buffer.from("%PDF-1.7 and so on"), 415, /not a picture/],
    [Buffer.from("PNG in name only"), 415, /not a picture/],
    [Buffer.alloc(0), 400, /empty/],
  ]) {
    const refused = await upload("mira", bytes);
    assert.equal(refused.status, status);
    assert.match((await refused.json()).error, says);
  }
  assert.equal(count(), before, "none of those were kept");

  for (const path of ["/media/nothing.png", "/media/..%2Fgesserit.db", "/media/GESSERIT.DB", "/media/gesserit.db"]) {
    assert.equal((await get(path, "mira")).status, 404, path);
  }
});

test("a post shows its pictures as figures, its formulas typeset, and its diagrams", async () => {
  const { url } = await (await upload("zan", DOT)).json();
  const square = "\\begin{tikzcd}\n  A \\arrow[r] & B\n\\end{tikzcd}";
  const id = await publish({
    title: "Shown, not told",
    body: [
      "Euler wrote $e^{i\\pi} + 1 = 0$ and it cost $5 to print, or $10 bound.",
      `![A dot](${url} "A dot, much enlarged")`,
      "$$\n\\int_0^1 x^2 \\, dx\n$$",
      `\`\`\`tikz Half a square.\n${square}\n\`\`\``,
    ].join("\n\n"),
  });

  const page = await read(`/p/${id}`, "mira");
  assert.match(page, new RegExp(`<figure class="figure"><img src="${url}" alt="A dot"[^>]*><figcaption>A dot, much enlarged</figcaption></figure>`));
  assert.equal(page.match(/<span class="katex">/g)?.length, 2, "one formula in the line and one set apart");
  assert.match(page, /<div class="math"><span class="katex-display">/);
  assert.match(page, /cost \$5 to print, or \$10 bound\./);
  assert.match(page, /href="\/katex\/katex\.min\.css/, "and the page brings the stylesheet that sets them");
  // this server was started without LaTeX, so the diagram is shown as its source, with the reason
  assert.match(page, /<figure class="figure figure--undrawn"><pre><code>\\begin\{tikzcd\}/);
  assert.match(page, /This diagram could not be drawn\. LaTeX is not installed on this server\./);

  // a page with no formula does without the stylesheet
  const plain = await publish({ title: "Told, not shown", body: "Only words." });
  assert.doesNotMatch(await read(`/p/${plain}`, "mira"), /katex/);

  // where its opening lines are quoted in a list, the formula is as typed and the picture is left out
  const listed = await read("/canon", "mira");
  assert.match(listed, /Euler wrote e\^\{i\\pi\} \+ 1 = 0 and it cost/);

  const sheet = await get("/katex/katex.min.css");
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get("content-type"), /^text\/css/);
  assert.equal((await get("/katex/fonts/KaTeX_Main-Regular.woff2")).status, 200);
  assert.equal((await get("/katex/fonts/..%2Fkatex.min.css")).status, 404);
  for (const path of [`/tex/${"0".repeat(32)}.svg`, "/tex/nonsense.svg", `/tex/${"0".repeat(32)}`]) {
    assert.equal((await get(path, "mira")).status, 404, path);
  }
});

test("the preview shows a text as it would be published, and saves nothing", async () => {
  const before = posts.ledger().length;
  const preview = (who, fields, options) =>
    fetch(base + "/preview", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, Accept: "application/json", ...(who ? { Cookie: people[who].cookie } : {}) },
      body: new URLSearchParams({ ...(who && options?.csrf !== false ? { _csrf: people[who].csrf } : {}), ...fields }),
    });

  const response = await preview("mira", {
    title: "A title",
    body: "Gardens are **made**, and $x^2$ grows.\r\n\r\n<script>alert(1)</script>\r\n\r\n- one\r\n- two",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const { html } = await response.json();
  assert.match(html, /^<p class="opens"><span class="initial" data-letter="G">G<\/span>ardens are <strong>made<\/strong>, and <span class="katex">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  // without a title it is a short post, which opens on no capital
  assert.doesNotMatch((await (await preview("mira", { body: "Gardens are made." })).json()).html, /initial/);

  const noToken = await preview("mira", { body: "Words." }, { csrf: false });
  assert.equal(noToken.status, 403);
  assert.ok((await noToken.json()).error);
  assert.equal((await preview(null, { body: "Words." })).status, 401);
  assert.equal(posts.ledger().length, before);
});

/* ----------------------------------------------------- parts of the corpus */

test("the corpus can be narrowed to what surrounds one post or one member", async () => {
  const centre = await publish({ title: "The middle of things", body: "Where it starts." });
  const beside = await publishing("mira", () => publish({ on: String(centre), title: "One step away", body: "An answer." }, "mira"));
  const beyond = await publishing("tomas", () =>
    publish({ on: String(beside), title: "Two steps away", body: "An answer to the answer." }, "tomas")
  );
  const apart = await publish({ title: "Nothing to do with it", body: "Off by itself." });
  const node = (id) => new RegExp(`data-id="p${id}"`);

  // the members are not drawn unless asked for, so being by the same hand does not make two posts neighbours
  const near = await read(`/corpus?around=p${centre}`, "mira");
  assert.match(near, node(centre));
  assert.match(near, node(beside));
  assert.doesNotMatch(near, node(beyond));
  assert.doesNotMatch(near, node(apart));
  assert.match(near, new RegExp(`class="node node--article node--leaf is-centre"\\s+href="/p/${centre}"`));
  assert.match(near, /Around <a[^>]*><strong>The middle of things<\/strong><\/a/);
  assert.match(near, /2 of \d+ shown/);

  const further = await read(`/corpus?around=p${centre}&reach=2`, "mira");
  assert.match(further, node(beyond));
  assert.doesNotMatch(further, node(apart));
  const connected = await read(`/corpus?around=p${centre}&reach=all`, "mira");
  assert.match(connected, node(beyond));
  assert.doesNotMatch(connected, node(apart));
  // a reach that makes no sense is the nearest one
  assert.doesNotMatch(await read(`/corpus?around=p${centre}&reach=lots`, "mira"), node(beyond));

  // around a member: what they wrote, and the members are shown without being asked for
  const hers = await read(`/corpus?around=u${people.mira.id}`, "tomas");
  assert.match(hers, new RegExp(`class="node node--person is-centre"\\s+href="/m/mira"`));
  assert.match(hers, node(beside));
  assert.doesNotMatch(hers, node(apart));

  // something that is not in the corpus: all of it is shown, with a word to say so
  for (const around of ["p999999", `u999999`]) {
    const whole = await read(`/corpus?around=${around}`, "mira");
    assert.match(whole, /That is not in the corpus/);
    assert.match(whole, node(apart));
  }
  const nonsense = await read("/corpus?around=%3Cscript%3E", "mira");
  assert.doesNotMatch(nonsense, /That is not in the corpus|is-centre/);
  assert.match(nonsense, node(apart));

  // the post's page leads to its place on the corpus, and the member's page to their corner of it
  assert.match(await read(`/p/${centre}`, "mira"), new RegExp(`href="/corpus#p${centre}">Link to corpus</a>`));
  assert.match(await read("/m/mira", "tomas"), new RegExp(`href="/corpus\\?around=u${people.mira.id}">In the corpus</a>`));
});

/* ------------------------------------------------------- the antecedents */

/** adds a work as the form does, as one who keeps the corpus, and gives back its id */
async function addWork(fields, who = "zan") {
  const to = sentTo(await post("/submit", who, { medium: "Book (whole)", ...fields }));
  return Number(to.match(/^\/p\/(\d+)$/)[1]);
}

test("an antecedent is added by those who keep the corpus, is published as it is added, and has a page of what is said of it", async () => {
  assert.equal(sentTo(await get("/submit")), "/login?next=%2Fsubmit");
  assert.equal(sentTo(await get("/works/new", "zan")), "/submit", "where a work was added from, before");
  const form = await read("/submit", "zan");
  assert.match(form, /<title>Antecedent · Gesserit<\/title>/);
  assert.match(form, /<h1 class="page-title page-title--form">Submit<\/h1>/);
  assert.match(form, /<form class="form compose compose--work" method="post" action="\/submit">/);
  // what is asked of it, each by a word: its title, whose it is and when, what it is and where, and what is said of it
  assert.deepEqual(
    [...form.matchAll(/<label for="\w+">([^<]+)<\/label>/g)].map((found) => found[1]),
    ["Title", "Author", "Date", "Type", "Link", "Annotations"]
  );
  assert.deepEqual(
    [...form.match(/<select id="medium" name="medium">([\s\S]*?)<\/select>/)[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((found) => [found[1], found[2]]),
    ["Book (whole)", "Book (part)", "Essay", "Paper", "Passage", "Image", "Video", "Painting"].map((type) => [type, type])
  );
  assert.match(
    form,
    /<div class="checks">\s*<label class="check"><input type="checkbox" name="show_tell" value="1"\s*\/> <span>Show and Tell<\/span><\/label>\s*<label class="check"><input type="checkbox" name="missionaria" value="1"\s*\/> <span>Missionaria<\/span><\/label>\s*<\/div>/
  );
  // there is one thing to press, which publishes it; nothing is explained, and nothing is asked that was asked before
  assert.match(form, /<button class="button" type="submit">Publish<\/button>\s*<a class="compose__cancel" href="\/corpus">Cancel<\/a>/);
  assert.doesNotMatch(form, /name="lineage"|name="annotation"|name="status"|class="hint"|class="rubric"|Existing media|to Selection|On the corpus|<fieldset|<legend|Save for review/);

  // it must have a title, a link must be one, and it is not taken without the page's token
  const before = posts.ledger().length;
  for (const [fields, said] of [
    [{ title: " " }, /A work needs its title\./],
    [{ title: "Leviathan", link: "javascript:alert(1)" }, /web address/],
  ]) {
    const refused = await post("/submit", "zan", { medium: "Essay", ...fields });
    assert.equal(refused.status, 422);
    assert.match(await refused.text(), said);
  }
  assert.equal((await post("/submit", "zan", { title: "Leviathan" }, { csrf: false })).status, 403);
  assert.equal(posts.ledger().length, before);

  const fields = {
    title: "Leviathan",
    creator: "Thomas Hobbes",
    year: "1651",
    medium: "Scroll",
    link: "https://example.org/leviathan",
    body: "Where the sovereign is *made*.",
    show_tell: "1",
  };
  const id = await addWork({ ...fields, status: "draft", lineage: "The social contract", annotation: "Said twice." });
  let work = posts.byId(id);
  assert.equal(work.kind, "work");
  assert.deepEqual([work.status, work.stage], ["published", "finished"], "there is nothing to review: it is on the corpus as it is added");
  assert.ok(!work.medium, "a kind of thing that is not offered is no kind in particular");
  assert.deepEqual([work.show_tell, work.missionaria, work.annotation, work.lineage], [1, 0, null, null]);
  assert.match(await read("/corpus", "tomas"), /Leviathan/);
  sentTo(await post(`/p/${id}/edit`, "zan", { ...fields, medium: "Book (part)" }));

  // its page is its title, whose it is and what it is, and what is said of it: no date, nobody's name, no margin, nothing under it
  const page = await read(`/p/${id}`, "tomas");
  assert.match(page, /<h1 class="post__title post__title--work">\s*<a href="https:\/\/example\.org\/leviathan" rel="noopener noreferrer" title="Where it is to be found"><cite>Leviathan<\/cite><\/a>\s*<\/h1>/);
  assert.match(page, new RegExp(`<p class="work__acts">\\s*<a href="/corpus#p${id}">Link to corpus</a>\\s*</p>`));
  assert.match(page, /<p class="work__by">Thomas Hobbes · Book \(part\)<\/p>/);
  assert.match(page, /<div class="prose">[\s\S]*Where the sovereign is <em>made<\/em>\./);
  assert.match(page, /<a href="\/corpus" aria-current="true">Corpus<\/a>/, "it stands under the corpus in the menu");
  assert.doesNotMatch(
    page,
    /1651|<time|Recommended by|Zan Huang|class="rubric|class="flourish|id="notes"|Margin notes|id="commentaries"|\/notes"|In the corpus|class="fold annotation"|tag--canon|\/edit"|post__centre|href="\/write\?on=/
  );
  // those who keep the corpus have the way to change it beside the way to its place
  assert.match(await read(`/p/${id}`, "zan"), new RegExp(`<p class="work__acts">\\s*<a href="/p/${id}/edit">Edit</a>\\s*<a href="/corpus#p${id}">Link to corpus</a>\\s*</p>`));
  // a work with no link is its title and no more
  const mine = await addWork({ title: "De Cive", creator: "thomas hobbes", year: "1642" });
  assert.match(await read(`/p/${mine}`, "mira"), /<h1 class="post__title post__title--work">\s*<cite>De Cive<\/cite>\s*<\/h1>/);
  // it has no margin to write in
  assert.equal((await post(`/p/${id}/notes`, "tomas", { body: "A note in the margin of a book." })).status, 403);

  // it is not writing: listed among the antecedents, and not in the canon whoever added it
  assert.match(await read("/", "zan"), new RegExp(`href="/p/${mine}"><cite>De Cive</cite></a></strong>\\s*<span class="ledger__more">hobbes · Book \\(whole\\)</span>`));
  assert.doesNotMatch(await read("/canon", "mira"), /De Cive/);
  // but it is found by searching, by its title or by whose it is
  assert.match(await read("/search?q=leviathan", "tomas"), new RegExp(`href="/p/${id}"`));
  assert.match(await read("/search?q=hobbes", "tomas"), new RegExp(`href="/p/${mine}"`));
  // an author who is there already is offered when another of theirs is added, once, as first written
  const offered = await read("/submit", "zan");
  assert.equal(offered.match(/<option value="Thomas Hobbes"><\/option>/g)?.length, 1);
  assert.doesNotMatch(offered, /<option value="thomas hobbes">/);

  // it is changed by those who edit, with the form it was added with, and by nobody else
  for (const who of ["mira", "tomas"]) {
    assert.equal((await get(`/p/${id}/edit`, who)).status, 403);
    assert.equal((await post(`/p/${id}/edit`, who, { title: "Mine now" })).status, 403);
    assert.equal((await post(`/p/${id}/delete`, who)).status, 403);
  }
  const edit = await read(`/p/${id}/edit`, "zan");
  assert.match(edit, /<h1 class="page-title page-title--form">Edit<\/h1>/);
  assert.match(edit, new RegExp(`<form class="form compose compose--work" method="post" action="/p/${id}/edit">`));
  assert.match(edit, /<input id="creator" name="creator" value="Thomas Hobbes"/);
  assert.match(edit, /<option value="Book \(part\)" selected>Book \(part\)<\/option>/);
  assert.match(edit, /name="show_tell" value="1" checked \/>/);
  assert.match(edit, /<button class="button" type="submit">Save<\/button>/);
  assert.match(edit, /data-confirm="Delete this post for good\?">Delete this post<\/button>/);
  assert.equal((await post(`/p/${id}/edit`, "zan", { title: "" })).status, 422);
  assert.equal(sentTo(await post(`/p/${id}/edit`, "zan", { title: "Leviathan", creator: "Hobbes", year: "1651", medium: "Book (whole)" })), `/p/${id}`);
  work = posts.byId(id);
  assert.deepEqual([work.creator, work.medium, work.link, work.kind, work.status], ["Hobbes", "Book (whole)", null, "work", "published"]);

  // there are no lineages any more, and their pages are not there
  for (const path of ["/lineages", "/lineages?renamed=x"]) assert.equal((await get(path, "zan")).status, 404, path);
  assert.equal((await post("/lineages/rename", "zan", { from: "a", to: "b" })).status, 404);

  // deleted, it is gone
  assert.equal(sentTo(await post(`/p/${mine}/delete`, "zan")), "/");
  assert.equal(sentTo(await post(`/p/${id}/delete`, "zan")), "/");
  assert.equal((await get(`/p/${id}`, "mira")).status, 404);
});

test("the corpus is set out about one essay, the antecedents to its left and the succession to its right, and either layer can be shown alone", async () => {
  const essay = await publish({ title: "The essay of essays", body: "What everything here answers." });
  const beside = await publishing("mira", () => publish({ on: String(essay), title: "Beside the essay", body: "An answer." }, "mira"));
  const old = await addWork({ title: "An old book", creator: "Someone long dead", year: "1200" });
  const older = await addWork({ title: "An older book", year: "c. 400 BC", medium: "Book (part)" });
  const loose = await addWork({ title: "A film apart", medium: "Video" });
  await publishing("tomas", () => publish({ on: String(old), title: "On an old book", body: "A commentary on a work." }, "tomas"));

  // choosing the centre is for those who edit, and only an article that is published can be it
  const offer = new RegExp(`<form class="post__centre" method="post" action="/p/${essay}/centre">`);
  assert.doesNotMatch(await read(`/p/${essay}`, "mira"), offer);
  assert.match(await read(`/p/${essay}`, "zan"), offer);
  assert.equal((await post(`/p/${essay}/centre`, "mira")).status, 403);
  assert.equal((await post(`/p/${beside}/centre`, "zan")).status, 422, "a commentary answers something else");
  assert.equal((await post(`/p/${old}/centre`, "zan")).status, 422, "a work was not written here");
  assert.equal((await post("/p/999999/centre", "zan")).status, 422);
  const earlier = posts.centre();
  assert.ok(earlier && earlier.id !== essay, "until one is chosen it is the earliest of the canon");
  assert.equal(sentTo(await post(`/p/${essay}/centre`, "zan")), `/p/${essay}`);
  assert.equal(posts.centre().id, essay);
  const chosen = await read(`/p/${essay}`, "zan");
  assert.match(chosen, /At the centre of the corpus/);
  assert.doesNotMatch(chosen, offer);

  const corpus = await read("/corpus", "mira");
  const node = (id) => new RegExp(`data-id="p${id}"`);
  assert.match(corpus, new RegExp(`class="node node--article node--leaf"\\s+href="/p/${essay}"\\s+data-id="p${essay}"\\s+data-name="The essay of essays"\\s+data-main`));
  assert.equal(corpus.match(/\sdata-main\s/g).length, 1, "there is one centre");
  // the essay is in the middle of the sheet; the works stand to its left, and what is written here to its right
  const [, width, height] = corpus.match(/<svg\s+class="graph__sheet"\s+viewBox="0 0 (\d+) (\d+)"/).map(Number);
  const place = (id) => corpus.match(new RegExp(`data-id="p${id}"[^>]*transform="translate\\(([\\d.-]+) ([\\d.-]+)\\)"`)).slice(1).map(Number);
  assert.ok(Math.hypot(place(essay)[0] - width / 2, place(essay)[1] - height / 2) < 1, "the essay is at the centre");
  assert.match(corpus, new RegExp(`data-origin="${place(essay)[0]} ${place(essay)[1]}"`));
  for (const id of [old, older, loose]) assert.ok(place(id)[0] < width / 2 - 60, "a work is to the left");
  assert.ok(place(beside)[0] > width / 2 + 60, "what is written here is to the right");
  // a work is its title in one of the browns of bark, with a glow, and under it what kind of thing it is
  assert.match(
    corpus,
    new RegExp(
      `class="node node--work node--bark node--bark-\\d"\\s+href="/p/${old}"[\\s\\S]*?<rect class="node__plate"[^>]*/>\\s*<text[^>]*filter="url\\(#glow\\)"[^>]*><tspan class="node__title"[^>]*>An old book</tspan><tspan class="node__extent" x="0" dy="[\\d.]+"[^>]*>Book \\(whole\\)</tspan></text>`
    )
  );
  assert.match(corpus, new RegExp(`data-id="p${older}"[\\s\\S]*?<tspan class="node__extent" x="0" dy="[\\d.]+"[^>]*>Book \\(part\\)</tspan>`));
  assert.match(corpus, new RegExp(`data-id="p${loose}"[\\s\\S]*?<tspan class="node__extent" x="0" dy="[\\d.]+"[^>]*>Video</tspan>`));
  assert.doesNotMatch(corpus, /\(entire book\)|\(film\)|node__dot/);
  // it says whose it is and what it is, and not who put it here nor when it was made
  assert.match(corpus, new RegExp(`href="/p/${old}"\\s+data-id="p${old}"\\s+data-name="An old book"\\s+data-by="Someone long dead · Book \\(whole\\)"`));
  assert.match(corpus, /aria-label="An old book — Someone long dead · Book \(whole\)"/);
  assert.doesNotMatch(corpus, /1200|400 BC|In the lineage/);
  // nothing joins them and nothing rings them
  assert.doesNotMatch(corpus, /class="edge|<marker|marker-end|class="ring|node--lineage/);
  // over the drawing there is its name and the layers; a member is offered nothing to add to it or arrange it by, and nothing is explained
  assert.match(corpus, /<div class="page-head page-head--corpus">\s*<h1 class="page-title">Corpus<\/h1>\s*<\/div>/);
  assert.doesNotMatch(corpus, /href="\/write"|href="\/submit"|Submit to Selection|arrange=1|data-edit=|Everything here|class="lede"|class="key"|graph__tally|graph__how|in the canon/);

  // either layer by itself: the essay stays where it is in both
  assert.match(corpus, /Show:\s*<strong>All<\/strong> · <a href="\/corpus\?layer=antecedents">Antecedents<\/a> · <a href="\/corpus\?layer=succession">Succession<\/a>/);
  const written = await read("/corpus?layer=succession", "mira");
  assert.match(written, node(essay));
  assert.match(written, node(beside));
  assert.doesNotMatch(written, /node--work/);
  assert.match(written, /<strong>Succession<\/strong>/);
  const works = await read("/corpus?layer=antecedents", "mira");
  assert.match(works, node(essay));
  assert.match(works, node(old));
  assert.doesNotMatch(works, node(beside));
  assert.match(works, /<strong>Antecedents<\/strong>/);
  assert.match(await read("/corpus?layer=nonsense", "mira"), /<strong>All<\/strong>/);
  // the layers are still found by the names they had
  assert.match(await read("/corpus?layer=written", "mira"), /<strong>Succession<\/strong>/);
  assert.match(await read("/corpus?layer=lineages", "mira"), /<strong>Antecedents<\/strong>/);

  // around a work: the essay it leads in to, and what was written on it, with the lines between
  const around = await read(`/corpus?around=p${old}`, "mira");
  assert.match(around, new RegExp(`class="node node--work node--bark node--bark-\\d is-centre"\\s+href="/p/${old}"`));
  assert.match(around, new RegExp(`class="edge edge--descent"\\s+data-from="p${old}"\\s+data-to="p${essay}"`));
  assert.match(around, /On an old book/);
  assert.doesNotMatch(around, node(loose));

  // without the works there is nothing outside what is written
  for (const id of [old, older, loose]) sentTo(await post(`/p/${id}/delete`, "zan"));
  // and the centre, unpublished, gives way to the one before
  sentTo(await revise(essay, { title: "The essay of essays", body: "Withdrawn.", status: "draft" }));
  assert.equal(posts.centre().id, earlier.id);
  sentTo(await revise(essay, { title: "The essay of essays", body: "Back again." }));
  assert.equal(posts.centre().id, essay);
  posts.setCentre(earlier.id);
});

test("those who edit arrange the corpus by hand, and a title stays where it was put", async () => {
  const work = await addWork({ title: "Placed by hand" });
  const written = await publish({ title: "Left to find its own place", body: "Unplaced." });
  const unseen = await publish({ title: "Not there to be placed", body: "Unpublished.", status: "draft" });
  const placesFor = async (who = "mira") => {
    const corpus = await read("/corpus", who);
    const origin = corpus.match(/data-origin="([\d.]+) ([\d.]+)"/).slice(1).map(Number);
    const place = (id) => corpus.match(new RegExp(`data-id="p${id}"[^>]*transform="translate\\(([\\d.-]+) ([\\d.-]+)\\)"`)).slice(1).map(Number);
    return (id) => place(id).map((n, i) => Math.round((n - origin[i]) * 10) / 10);
  };
  const before = await placesFor();

  // it is offered to those who edit, over the whole corpus, and is theirs alone to do
  assert.match(await read("/corpus", "zan"), /<a href="\/corpus\?arrange=1">Arrange<\/a>/);
  assert.doesNotMatch(await read("/corpus?arrange=1", "mira"), /data-arrange|\/corpus\/arrange|Start again/);
  assert.equal((await post("/corpus/arrange", "mira", { places: `p${work}:-300,120` })).status, 403);
  await publishing("mira", async () => assert.equal((await post("/corpus/arrange", "mira", { places: `p${work}:-300,120` })).status, 403));
  const arranging = await read("/corpus?arrange=1&layer=succession&mark=show-tell", "zan");
  assert.match(arranging, /<div\s+class="graph graph--whole"\s+data-graph\s+data-arrange\s+data-origin="[\d.]+ [\d.]+"\s*>/);
  assert.match(arranging, /<form method="post" action="\/corpus\/arrange" data-arrange-form>[\s\S]*?<input type="hidden" name="places" value="" \/>\s*<button class="button" type="submit">Save<\/button>/);
  assert.match(arranging, new RegExp(`data-id="p${work}"`), "every title is there to be moved, whichever layer was asked for");
  assert.doesNotMatch(arranging, /Show:|node__star/);

  // where each is put is said from the essay at the centre; what cannot be read is refused, and nothing is moved by it
  for (const places of ["p1", `p${work}:1`, `p${work}:1e3,2`, `u${people.mira.id}:1,2`, `p${work}:1,2;`, `p${work}:123456,2`])
    assert.equal((await post("/corpus/arrange", "zan", { places })).status, 400, places);
  assert.equal((await post("/corpus/arrange", "zan", { places: `p${work}:-300,120` }, { csrf: false })).status, 403);
  assert.deepEqual((await placesFor())(work), before(work));

  assert.equal(sentTo(await post("/corpus/arrange", "zan", { places: `p${work}:-300.5,120 p${unseen}:10,10 p999999:1,1` })), "/corpus");
  let now = await placesFor();
  assert.deepEqual(now(work), [-300.5, 120]);
  assert.deepEqual([posts.byId(unseen).corpus_x, posts.byId(unseen).corpus_y], [null, null], "what is not on the corpus has no place on it");
  // it stays there when the corpus grows, and can be put on either side
  const later = await addWork({ title: "Added after the arranging" });
  assert.deepEqual((await placesFor())(work), [-300.5, 120]);
  sentTo(await post("/corpus/arrange", "zan", { places: `p${work}:420,-64.25` }));
  assert.ok((await placesFor())(work)[0] > 0, "it is where it was put, though the works stand to the left");
  assert.deepEqual([posts.byId(work).corpus_x, posts.byId(work).corpus_y], [420, -64.25]);
  // and no further off than the sheet could be read at
  sentTo(await post("/corpus/arrange", "zan", { places: `p${work}:-99999,99999` }));
  assert.deepEqual([posts.byId(work).corpus_x, posts.byId(work).corpus_y], [-4000, 4000]);

  // begun again, every title goes back to where it would stand by itself
  assert.equal(sentTo(await post("/corpus/arrange", "zan", { reset: "1" })), "/corpus");
  assert.deepEqual([posts.byId(work).corpus_x, posts.byId(work).corpus_y], [null, null]);
  now = await placesFor();
  assert.ok(now(work)[0] < 0 && now(written)[0] > 0);

  for (const id of [work, written, unseen, later]) sentTo(await post(`/p/${id}/delete`, "zan"));
});

/* ---------------------------------------------------------------- the canon */

const CANON_TAG = /<a class="tag tag--canon" href="\/canon">Canon<\/a>/;

test("what the main admin publishes is the canon, which has a page of its own", async () => {
  const article = await publish({ title: "A text of the canon", body: "Set down by the main admin." });
  const short = await publish({ body: "A short remark that is canon all the same." });
  const draft = await publish({ title: "Not canon until it is published", body: "Waiting.", status: "draft" });
  const answer = await publishing("mira", () =>
    publish({ on: String(article), title: "An answer from outside the canon", body: "By Mira." }, "mira")
  );
  const gloss = await publish({ on: String(answer), title: "The canon answers back", body: "By the main admin." });

  assert.equal(users.main().id, people.zan.id, "the first admin is the main one until another is named");
  assert.equal(sentTo(await get("/canon")), "/login?next=%2Fcanon");

  // the page: for every member, with everything the main admin published and nothing else
  const response = await get("/canon", "mira");
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /<a href="\/corpus" aria-current="true">Corpus<\/a>/, "it stands under the corpus in the menu");
  assert.match(page, /<a href="\/m\/zan">Zan Huang<\/a>/);
  for (const id of [article, short, gloss]) assert.match(page, new RegExp(`href="/p/${id}"`));
  assert.doesNotMatch(page, new RegExp(`href="/p/${draft}"`), "a draft is not in the canon");
  assert.doesNotMatch(page, /Not canon until it is published/);
  assert.doesNotMatch(page, new RegExp(`href="/p/${answer}"`), "nor is what someone else wrote");
  assert.match(page, />Articles<[\s\S]*>Commentaries<[\s\S]*>Short posts</);
  assert.ok(page.indexOf(`href="/p/${article}"`) < page.indexOf(`href="/p/${gloss}"`), "articles come before commentaries");

  // a piece of the canon says so under its title
  assert.match(await read(`/p/${article}`, "mira"), CANON_TAG);
  assert.match(await read(`/p/${gloss}`, "mira"), CANON_TAG);
  assert.doesNotMatch(await read(`/p/${answer}`, "mira"), /tag--canon/);
  assert.doesNotMatch(await read(`/p/${draft}`, "zan"), /tag--canon/);

  // what the main admin puts here for someone else, with a letter after its title to say so, is not the main admin's own
  const theirs = await publish({ title: "Put here for another", body: "By Bryce.", hand: "b" });
  const lettered = await read(`/p/${theirs}`, "mira");
  assert.match(lettered, /<h1 class="post__title">Put here for another<sup class="hand">b<\/sup><\/h1>/);
  assert.doesNotMatch(lettered, /tag--canon|Zan Huang/);
  assert.doesNotMatch(await read("/canon", "mira"), /Put here for another/);
  assert.doesNotMatch(await read("/m/zan", "mira"), /Put here for another/);
  assert.match(await read("/m/zan", "mira"), /A text of the canon/);

  // on the corpus the canon is not set apart: what is written here is one layer, whoever wrote it
  const graph = await read("/corpus", "tomas");
  for (const [kind, id] of [["article", article], ["post", short], ["commentary", gloss], ["commentary", answer]])
    assert.match(graph, new RegExp(`class="node node--${kind} node--leaf"\\s+href="/p/${id}"`));
  assert.match(graph, new RegExp(`aria-label="A text of the canon — an article[ ·"]`));
  assert.doesNotMatch(graph, /node--canon|node__halo|In the canon|an article by/);
  // where the members are drawn, around a piece, the main admin is said to be that
  assert.match(await read(`/corpus?around=p${article}&show=people`, "tomas"), /aria-label="Zan Huang · Main admin, whose writing is the canon/);

  // and each member's page says who is the main admin
  assert.match(await read("/m/zan", "mira"), /Main admin, whose writing is <a href="\/canon">the canon<\/a>/);
  assert.doesNotMatch(await read("/m/mira", "zan"), /Main admin/);
});

test("there is one main admin, who alone can hand the canon on, and only to another admin", async () => {
  const id = users.create({
    username: "ines",
    name: "Inés Marchetti",
    role: "admin",
    passwordHash: await auth.hashPassword("ines-password"),
  });
  const token = auth.createSession(id);
  people.ines = { id, cookie: `session=${token}`, csrf: auth.findSession(token).csrf };
  const hers = await publish({ title: "Written by the second admin", body: "Not canon yet." }, "ines");
  const his = await publish({ title: "Canon for the time being", body: "By the first admin." });
  const main = `/members/${people.ines.id}/main`;

  // another admin's writing is not canon, however much of an admin they are
  assert.doesNotMatch(await read(`/p/${hers}`, "mira"), /tag--canon/);
  assert.doesNotMatch(await read("/canon", "mira"), /Written by the second admin/);
  assert.equal(users.all().filter((each) => each.main).length, 1, "exactly one");

  // the main admin is shown as such, and is offered the handing on; other admins are not
  const list = await read("/members", "zan");
  assert.match(list, /Main admin <a class="tag tag--canon"/);
  assert.match(list, new RegExp(`action="${main}"`));
  assert.doesNotMatch(list, new RegExp(`action="/members/${people.mira.id}/main"`), "a member cannot be offered it");
  assert.doesNotMatch(await read("/members", "ines"), /\/main"/);

  // nobody else can do it, to anyone
  assert.equal((await post(main, "mira")).status, 403);
  assert.equal((await post(main, "ines")).status, 403);
  assert.equal((await post(`/members/${people.zan.id}/main`, "ines")).status, 403);
  assert.equal((await post(main, "zan", {}, { csrf: false })).status, 403);
  // and it goes to an admin or to no one
  assert.equal((await post(`/members/${people.mira.id}/main`, "zan")).status, 400);
  assert.equal((await post("/members/999999/main", "zan")).status, 404);
  assert.equal(users.main().id, people.zan.id);

  // another admin cannot take the place by way of the main admin's password
  assert.doesNotMatch(await read("/members", "ines"), new RegExp(`action="/members/${people.zan.id}/password"`));
  assert.equal((await post(`/members/${people.zan.id}/password`, "ines")).status, 400);
  assert.equal((await get("/", "zan")).status, 200, "zan is still signed in");

  // handed on: the canon is now what the new main admin wrote
  assert.equal(sentTo(await post(main, "zan")), "/members");
  assert.equal(users.main().id, people.ines.id);
  const canon = await read("/canon", "mira");
  assert.match(canon, /Written by the second admin/);
  assert.match(canon, /<a href="\/m\/ines">Inés Marchetti<\/a>/);
  assert.doesNotMatch(canon, /Canon for the time being/);
  assert.match(await read(`/p/${hers}`, "mira"), CANON_TAG);
  assert.doesNotMatch(await read(`/p/${his}`, "mira"), /tag--canon/);
  assert.match(await read(`/corpus?around=p${hers}&show=people`, "mira"), /aria-label="Inés Marchetti · Main admin, whose writing is the canon/);
  assert.equal(users.all().filter((each) => each.main).length, 1, "still exactly one");

  // the one who handed it on cannot take it back
  assert.equal((await post(`/members/${people.zan.id}/main`, "zan")).status, 403);
  assert.equal(users.main().id, people.ines.id);

  // whoever runs the server can name the main admin from its command line: an admin, and no one else
  const name = (username) =>
    new Promise((done) => {
      const run = spawn(process.execPath, ["bin/add-user.mjs", "--main", username], {
        cwd: SERVER_ROOT,
        env: { ...process.env, DATA_DIR: scratch },
        stdio: "ignore",
      });
      run.once("exit", done);
    });
  assert.equal(await name("mira"), 1);
  assert.equal(await name("nobody"), 1);
  assert.equal(users.main().id, people.ines.id);
  assert.equal(await name("zan"), 0);
  assert.equal(users.main().id, people.zan.id);
  assert.match(await read(`/p/${his}`, "mira"), CANON_TAG);

  // if the one named is no longer an admin, the place falls to the admin who has been here longest
  users.setMain(people.mira.id);
  assert.equal(users.main().id, people.zan.id);
  users.setMain(people.zan.id);
});

/* --------------------------------------------------------------- typography */

test("quotation marks are set curled wherever a text is read, and kept as typed where it is edited", async () => {
  const body = `He called it "the slow art" and it's stuck. Type \`"this"\` to try.`;
  const id = await publish({ title: `On "slowness"`, body });

  const page = await read(`/p/${id}`, "mira");
  assert.match(page, /<title>On “slowness” · Gesserit<\/title>/);
  assert.match(page, /<h1[^>]*>On “slowness”<\/h1>/);
  assert.match(page, /e called it “the slow art” and it’s stuck\./);
  assert.match(page, /<code>&quot;this&quot;<\/code>/);
  // so is its name in the list of every piece, and on the page of what a search finds, which is cut from the text
  assert.match(await read("/", "zan"), /<a href="\/p\/\d+">On “slowness”<\/a>/);
  assert.match(await read("/search?q=slow+art", "mira"), /On “slowness”[\s\S]*?e called it “the <mark class="hit">slow<\/mark> <mark class="hit">art<\/mark>” and it’s stuck\./);

  // what is stored is what was typed, and that is what the editing box holds
  assert.equal(posts.byId(id).body, body);
  const editing = await read(`/p/${id}/edit`, "zan");
  assert.match(editing, /value="On &quot;slowness&quot;"/);
  assert.match(editing, /<textarea[^>]*>He called it &quot;the slow art&quot; and it&#39;s stuck\./);

  // a margin note, and the passage it quotes, which is kept in an attribute for finding it again
  await post(`/p/${id}/notes`, "mira", { body: `Isn't "art" too grand?`, quote: `"the slow art"`, pos: "10" });
  const noted = await read(`/p/${id}`, "tomas");
  assert.match(noted, /Isn’t “art” too grand\?/);
  assert.match(noted, /data-quote="&quot;the slow art&quot;"/);

  // what the preview and a conversation send to an open page is set as the page would be
  const preview = await fetch(base + "/preview", {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people.mira.cookie },
    body: new URLSearchParams({ _csrf: people.mira.csrf, body: `She said "wait".` }),
  });
  assert.match((await preview.json()).html, /She said “wait”\./);
});

test("the menu is the corpus and preferences, and for those who keep the corpus the page it is kept from", async () => {
  const menu = (html) =>
    [...html.match(/<nav class="masthead__nav" aria-label="Site">([\s\S]*?)<\/nav>/)[1].matchAll(/<a href="([^"]+)"[^>]*>\s*(\w+)/g)].map(
      (found) => [found[1], found[2]]
    );
  // a member comes to the corpus first, and has no other place but their preferences
  assert.equal(sentTo(await get("/", "mira")), "/corpus");
  const hers = await read("/corpus", "mira");
  assert.deepEqual(menu(hers), [
    ["/corpus", "Corpus"],
    ["/account", "Preferences"],
  ]);
  assert.match(hers, /<a href="\/corpus" aria-current="page">Corpus<\/a>/);
  assert.match(hers, /<a class="masthead__mark" href="\/corpus">/);
  // messages go with who is signed in, since they open beside the page and are not a place of their own
  const [, you] = hers.match(/<div class="masthead__you">([\s\S]*?)<\/div>/);
  assert.match(you, /<a\s+class="masthead__icon masthead__messages"\s+href="\/chat"\s+data-messages\s+title="Messages"\s*>\s*<svg[\s\S]*?<\/svg><span class="visually-hidden">Messages<\/span><span data-unread\s*><\/span\s*><\/a\s*>/);
  assert.match(you, /action="\/logout"[\s\S]*<button class="masthead__icon" type="submit" title="Sign out \(Mira Okafor\)">\s*<svg[\s\S]*?<\/svg><span class="visually-hidden">Sign out<\/span>/);
  // and the script that opens them is on every page
  assert.match(hers, /<script src="\/static\/chat\.js\?v=\w+" defer><\/script>/);

  // whoever keeps the corpus has Scribe before those, and comes to it first; the page itself is headed Editorial
  const his = await read("/", "zan");
  assert.deepEqual(menu(his), [
    ["/", "Scribe"],
    ["/corpus", "Corpus"],
    ["/account", "Preferences"],
  ]);
  assert.match(his, /<a href="\/" aria-current="page">Scribe<\/a>/);
  assert.match(his, /<a class="masthead__mark" href="\/">/);
  assert.match(his, /<h1 class="page-title">Editorial<\/h1>/);
  assert.doesNotMatch(his, /Ascribe/);
  assert.match(his, /<p class="page-head__acts"><a class="button" href="\/write">New Piece<\/a><\/p>/);
  // the members and, for an admin, those who are to be invited; and for the main admin the page that sends to the chats elsewhere
  assert.match(his, /<p class="views">\s*<a href="\/members">Members<\/a>\s*<a href="\/invitations">Invitations<\/a>\s*<a href="\/send">Send<\/a>\s*<\/p>/);

  // a page that stands under a place says so, and the place's own page says it is that page
  assert.match(await read("/account", "mira"), /<a href="\/account" aria-current="page">Preferences<\/a>/);
  assert.match(await read("/members", "zan"), /<a href="\/" aria-current="true">Scribe<\/a>/);
  assert.match(await read("/write", "zan"), /<a href="\/" aria-current="true">Scribe<\/a>/);
  assert.match(await read("/canon", "mira"), /<a href="\/corpus" aria-current="true">Corpus<\/a>/);
  assert.match(await read("/submit", "zan"), /<a href="\/corpus" aria-current="true">Corpus<\/a>/);

  // every page stands between the vines of the landing page, which are pictures and say nothing
  for (const page of [hers, his, await read("/account", "mira")])
    assert.match(
      page,
      /<div class="leaf[^"]*" style="--vine:url\(\/assets\/vine\.svg\?v=\w+\);--vine-tip:url\(\/assets\/vine-tip\.svg\?v=\w+\)">\s*<div class="vines" aria-hidden="true">\s*<div class="vines__side vines__side--left">[\s\S]*?<div class="vines__side vines__side--right">[\s\S]*?<\/div>\s*<\/div>\s*<main class="column/
    );
  for (const picture of ["/assets/vine.svg", "/assets/vine-tip.svg"]) {
    const drawn = await get(picture, "mira");
    assert.equal(drawn.status, 200, picture);
    assert.match(drawn.headers.get("content-type"), /^image\/svg\+xml/);
  }

  // under every page there is the way back to the public one, and nothing else
  for (const page of [hers, his])
    assert.match(page, /<footer class="footer">\s*<span class="footer__rule" aria-hidden="true"><\/span>\s*<a href="[^"]+">gesserit\.org<\/a>\s*<\/footer>/);
});

/* ---------------------------------------------------------------- the guide */

test("there is no guide: nothing leads to one, and its address is no page", async () => {
  assert.equal((await get("/guide", "mira")).status, 404);
  assert.equal((await get("/guide", "zan")).status, 404);
  for (const [path, who] of [["/corpus", "mira"], ["/account", "mira"], ["/", "zan"], ["/members", "zan"], ["/submit", "tomas"]])
    assert.doesNotMatch(await read(path, who), /href="\/guide|>Guide</, path);
});

/* ----------------------------------------------------------------- projects */

/** starts a project as its form would; `who` are the members ticked to work on it */
async function startProject(owner, fields = {}, who = []) {
  const form = [...Object.entries({ title: "A project", open: "0", ...fields }), ...who.map((name) => ["who", String(people[name].id)])];
  const response = await post("/projects", owner, form);
  return Number(sentTo(response).match(/^\/projects\/(\d+)$/)[1]);
}

async function addPage(project, who, fields) {
  const response = await post(`/projects/${project}/pages`, who, fields);
  return Number(sentTo(response).match(/^\/pages\/(\d+)$/)[1]);
}

/** saves a page as its edit form would, from the version the form was opened on */
const savePage = (id, who, fields) => post(`/pages/${id}/edit`, who, { do: "save", ...fields });

const THREE = "The first paragraph.\n\nThe second paragraph.\n\nThe third paragraph.\n";

test("a project is seen by those working on it, and by no other member", async () => {
  const id = await startProject("mira", { title: "On the commons", about: "Notes towards a paper." });
  assert.match(await read(`/projects/${id}`, "mira"), /<a href="\/projects">Projects<\/a> · Private to those working on it/);

  // not there at all for a member who is not on it, by any door
  for (const path of [`/projects/${id}`, `/projects/${id}/log`, `/projects/${id}/settings`, `/projects/${id}/new`, `/projects/${id}/talk`])
    assert.equal((await get(path, "tomas")).status, 404, path);
  assert.equal((await post(`/projects/${id}/pages`, "tomas", { title: "Mine", body: "Words." })).status, 404);
  assert.doesNotMatch(await read("/projects", "tomas"), /On the commons/);
  assert.equal(sentTo(await get(`/projects/${id}`)), `/login?next=%2Fprojects%2F${id}`);

  // an admin sees it, and is told that it is private
  const list = await read("/projects", "zan");
  assert.match(list, /Private projects of others[\s\S]*On the commons/);
  assert.match(await read(`/projects/${id}`, "zan"), /as an admin you can do what its owner can/);

  // its owner lists it as theirs
  assert.match(await read("/projects", "mira"), /Yours[\s\S]*On the commons[\s\S]*Private/);
});

test("the owner chooses who works on a project; they can leave, and only the owner can change that", async () => {
  const id = await startProject("mira", { title: "Chosen company" }, ["tomas"]);
  assert.deepEqual(projects.people(id).map((each) => each.username), ["tomas"]);
  const page = await read(`/projects/${id}`, "tomas");
  assert.match(page, /Chosen company/);
  assert.match(page, /Leave this project/);
  assert.doesNotMatch(page, new RegExp(`/projects/${id}/settings`));

  // someone working on it cannot change its settings, its people, or delete it
  assert.equal((await get(`/projects/${id}/settings`, "tomas")).status, 403);
  assert.equal((await post(`/projects/${id}/settings`, "tomas", { title: "Taken over", open: "1" })).status, 403);
  assert.equal((await post(`/projects/${id}/people`, "tomas", { who: String(people.zan.id) })).status, 403);
  assert.equal((await post(`/projects/${id}/delete`, "tomas")).status, 403);
  assert.equal(projects.byId(id).title, "Chosen company");

  // they can take themselves off it, and then it is no longer theirs to see
  assert.equal(sentTo(await post(`/projects/${id}/people/${people.tomas.id}/remove`, "tomas")), "/projects");
  assert.equal((await get(`/projects/${id}`, "tomas")).status, 404);

  // the owner adds them again, and takes them off
  assert.equal(sentTo(await post(`/projects/${id}/people`, "mira", { who: String(people.tomas.id) })), `/projects/${id}/settings#people`);
  assert.equal((await get(`/projects/${id}`, "tomas")).status, 200);
  assert.equal((await post(`/projects/${id}/people/${people.mira.id}/remove`, "tomas")).status, 403);
  sentTo(await post(`/projects/${id}/people/${people.tomas.id}/remove`, "mira"));
  assert.equal((await get(`/projects/${id}`, "tomas")).status, 404);
  assert.equal((await post(`/projects/${id}/people/${people.tomas.id}/remove`, "mira")).status, 404);

  // a project needs a name, and the form it was sent with
  assert.equal((await post("/projects", "mira", { title: "  ", open: "0" })).status, 422);
  assert.equal((await post("/projects", "mira", { title: "Forged" }, { csrf: false })).status, 403);
  assert.equal(sentTo(await post("/projects", null, { title: "Nobody's" })), "/login");
});

test("every saving of a page is kept as a version, which can be read, compared and put back", async () => {
  const project = await startProject("mira", { title: "Versions" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Draft", body: "The first wording." });
  assert.equal(pages.byId(id).version, 1);
  // (a text opens on a capital set apart from the rest of its first word)
  assert.match(await read(`/pages/${id}`, "tomas"), /he first wording\./);

  // a page needs a title and some words
  assert.equal((await post(`/projects/${project}/pages`, "mira", { title: "", body: "Words." })).status, 422);
  assert.equal((await post(`/projects/${project}/pages`, "mira", { title: "Empty", body: " \n" })).status, 422);

  assert.equal(sentTo(await savePage(id, "tomas", { base: "1", title: "Draft", body: "The second wording.", summary: "Said again" })), `/pages/${id}`);
  assert.equal(pages.byId(id).version, 2);
  // saving what it already says saves nothing
  assert.equal(sentTo(await savePage(id, "mira", { base: "2", title: "Draft", body: "The second wording." })), `/pages/${id}?same`);
  assert.equal(pages.byId(id).version, 2);

  const history = await read(`/pages/${id}/history`, "mira");
  assert.match(history, /Version 2[\s\S]*Said again[\s\S]*Version 1/);
  assert.match(history, /Tomás Lindqvist/);
  assert.match(await read(`/pages/${id}/v/1`, "mira"), /he first wording\./);
  assert.equal((await get(`/pages/${id}/v/9`, "mira")).status, 404);
  const changed = await read(`/pages/${id}/changes?from=1&to=2`, "mira");
  assert.match(changed, /<del>first<\/del>\s*<ins>second<\/ins>/);

  // an earlier version is put back as a new one
  sentTo(await post(`/pages/${id}/restore`, "mira", { n: "1" }));
  const now = pages.byId(id);
  assert.equal(now.version, 3);
  assert.equal(now.body, "The first wording.");
  assert.equal(pageVersions.get(id, 3).summary, "Restored version 1");
  assert.equal((await post(`/pages/${id}/restore`, "mira", { n: "7" })).status, 404);

  // the project keeps a record of all of it
  const log = await read(`/projects/${project}/log`, "tomas");
  assert.match(log, /began[\s\S]*Draft/);
  assert.match(log, /Restored version 1/);
  // a save from a version the page never had is refused, not guessed at
  assert.equal((await savePage(id, "mira", { base: "12", title: "Draft", body: "From nowhere." })).status, 400);
});

test("two members who change a page at the same time both keep what they changed", async () => {
  const project = await startProject("mira", { title: "At once" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Shared", body: THREE });

  // both open version 1; she changes the first paragraph and saves, he the third
  sentTo(await savePage(id, "mira", { base: "1", title: "Shared", body: THREE.replace("first", "opening") }));
  const his = await savePage(id, "tomas", { base: "1", title: "Shared, with a subtitle", body: THREE.replace("third", "closing") });
  assert.equal(sentTo(his), `/pages/${id}?merged`);

  const now = pages.byId(id);
  assert.equal(now.version, 3);
  assert.equal(now.body, "The opening paragraph.\n\nThe second paragraph.\n\nThe closing paragraph.\n");
  assert.equal(now.title, "Shared, with a subtitle");
  assert.equal(pageVersions.get(id, 3).merged, 1);
  // hers is still there to be read as it stood
  assert.equal(pageVersions.get(id, 2).body, THREE.replace("first", "opening"));
  assert.match(await read(`/pages/${id}?merged`, "tomas"), /what they changed and what you changed are both here/);
  assert.match(await read(`/pages/${id}/history`, "mira"), /joined with what others had changed/);

  // different words of the same paragraph are joined too
  const line = "Alpha beta gamma delta epsilon zeta eta theta.";
  const other = await addPage(project, "mira", { title: "One line", body: line });
  sentTo(await savePage(other, "mira", { base: "1", title: "One line", body: line.replace("beta", "BETA") }));
  assert.equal(sentTo(await savePage(other, "tomas", { base: "1", title: "One line", body: line.replace("eta theta", "eta THETA") })), `/pages/${other}?merged`);
  assert.equal(pages.byId(other).body, "Alpha BETA gamma delta epsilon zeta eta THETA.");
});

test("where two members changed the same words, the one saving chooses between the wordings", async () => {
  const project = await startProject("mira", { title: "Clashing" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Shared", body: THREE });
  const hers = THREE.replace("second paragraph", "second paragraph, as Mira has it").replace("first", "opening");
  const his = THREE.replace("second paragraph", "second paragraph, as Tomás has it").replace("third", "closing");
  sentTo(await savePage(id, "mira", { base: "1", title: "Shared", body: hers }));

  const refused = await savePage(id, "tomas", { base: "1", title: "Shared", body: his });
  assert.equal(refused.status, 409);
  const asked = await refused.text();
  assert.match(asked, /Two wordings of the same passage/);
  assert.match(asked, /Mira Okafor saved this page/);
  assert.match(asked, /as Tomás has it/);
  assert.match(asked, /as Mira has it/);
  assert.match(asked, /name="pick-0" value="ours"/);
  assert.match(asked, /name="pick-0" value="theirs"/);
  assert.match(asked, /name="pick-0" value="both"/);
  assert.doesNotMatch(asked, /name="pick-1"/);
  assert.match(asked, /name="against" value="2"/);
  // what each made of the passage is marked in it
  assert.match(asked, /The second paragraph<ins>, as Tomás has it<\/ins>\./);
  assert.match(asked, /The second paragraph<ins>, as Mira has it<\/ins>\./);
  // nothing has been saved, and nobody's words are marked up with anything
  assert.equal(pages.byId(id).version, 2);
  assert.equal(pages.byId(id).body, hers);

  // he can go back to his writing instead, with what he wrote still in the box
  const back = await savePage(id, "tomas", { do: "back", base: "1", against: "2", title: "Shared", body: his });
  assert.equal(back.status, 200);
  const box = await back.text();
  assert.match(box, /<textarea id="body"[^>]*>The first paragraph\.\n\nThe second paragraph, as Tomás has it\./);
  assert.match(box, /name="base" value="1"/);
  assert.match(box, /has been saved by someone else since you began \(it is now at version 2\)/);
  assert.equal(pages.byId(id).version, 2);

  // he keeps his wording of that passage; what else each changed is joined
  const chosen = { base: "1", against: "2", title: "Shared", body: his, "pick-0": "ours" };
  assert.equal(sentTo(await savePage(id, "tomas", chosen)), `/pages/${id}?merged`);
  assert.equal(pages.byId(id).body, "The opening paragraph.\n\nThe second paragraph, as Tomás has it.\n\nThe closing paragraph.\n");
  assert.equal(pageVersions.get(id, 2).body, hers);

  // a choice made against a page that has moved on again is asked for afresh
  const next = await addPage(project, "mira", { title: "Moving", body: "A line.\n" });
  sentTo(await savePage(next, "mira", { base: "1", title: "Moving", body: "A line, hers.\n" }));
  assert.equal((await savePage(next, "tomas", { base: "1", title: "Moving", body: "A line, his.\n" })).status, 409);
  sentTo(await savePage(next, "mira", { base: "2", title: "Moving", body: "A line, hers again.\n" }));
  const stale = await savePage(next, "tomas", { base: "1", against: "2", title: "Moving", body: "A line, his.\n", "pick-0": "ours" });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /name="against" value="3"/);
  assert.equal(pages.byId(next).body, "A line, hers again.\n");
  // keeping both sets one after the other
  sentTo(await savePage(next, "tomas", { base: "1", against: "3", title: "Moving", body: "A line, his.\n", "pick-0": "both" }));
  assert.equal(pages.byId(next).body, "A line, his.\nA line, hers again.\n");
  // a choice that is not one of the three is not taken for one
  assert.equal(
    (await savePage(next, "mira", { base: "1", against: "4", title: "Moving", body: "A line, another.\n", "pick-0": "mine!" })).status,
    409
  );
});

test("an open project can be read by every member, who can suggest changes but not make them", async () => {
  const project = await startProject("mira", { title: "Open house", open: "1" });
  const id = await addPage(project, "mira", { title: "Welcome", body: THREE });
  assert.match(await read("/projects", "tomas"), /Open to everyone[\s\S]*Open house/);
  const page = await read(`/pages/${id}`, "tomas");
  assert.match(page, /The second paragraph\./);
  assert.match(page, new RegExp(`<a href="/pages/${id}/edit">Suggest a change</a>`));
  assert.match(await read(`/projects/${project}`, "tomas"), /You are reading this as a member/);
  assert.equal((await get(`/pages/${id}/history`, "tomas")).status, 200);

  // none of what those working on it can do
  assert.equal((await get(`/projects/${project}/new`, "tomas")).status, 403);
  assert.equal((await post(`/projects/${project}/pages`, "tomas", { title: "Mine", body: "Words." })).status, 403);
  assert.equal((await post(`/pages/${id}/restore`, "tomas", { n: "1" })).status, 403);
  assert.equal((await post(`/pages/${id}/remove`, "tomas")).status, 403);
  assert.equal((await get(`/projects/${project}/talk`, "tomas")).status, 403);
  assert.equal((await get(`/projects/${project}/settings`, "tomas")).status, 403);

  // a save from a reader is a suggestion, whatever the form says
  const sent = await savePage(id, "tomas", { base: "1", title: "Welcome", body: THREE.replace("third", "last"), summary: "A better word" });
  const where = sentTo(sent);
  assert.match(where, /^\/suggestions\/\d+\?sent$/);
  const suggestion = Number(where.match(/\d+/)[0]);
  assert.equal(pages.byId(id).version, 1);
  assert.equal(pages.byId(id).body, THREE);
  // a suggestion that changes nothing is not one
  assert.equal((await savePage(id, "tomas", { base: "1", title: "Welcome", body: THREE })).status, 422);

  const shown = await read(`/suggestions/${suggestion}`, "mira");
  assert.match(shown, /A better word/);
  assert.match(shown, /<del>third<\/del>\s*<ins>last<\/ins>/);
  assert.match(shown, new RegExp(`action="/suggestions/${suggestion}/accept"`));
  assert.match(await read(`/projects/${project}`, "mira"), /Suggestions awaiting an answer[\s\S]*A better word/);
  // its author can withdraw it but not take it in
  const his = await read(`/suggestions/${suggestion}`, "tomas");
  assert.match(his, /Withdraw it/);
  assert.doesNotMatch(his, /Take it in/);
  assert.equal((await post(`/suggestions/${suggestion}/accept`, "tomas")).status, 403);
  assert.equal((await post(`/suggestions/${suggestion}/decline`, "tomas")).status, 403);

  // meanwhile the page moves on; taking the suggestion in joins it with that
  sentTo(await savePage(id, "mira", { base: "1", title: "Welcome", body: THREE.replace("first", "opening") }));
  assert.equal(sentTo(await post(`/suggestions/${suggestion}/accept`, "mira")), `/pages/${id}`);
  assert.equal(pages.byId(id).body, "The opening paragraph.\n\nThe second paragraph.\n\nThe last paragraph.\n");
  const version = pageVersions.get(id, 3);
  assert.equal(version.user_id, people.tomas.id);
  assert.equal(version.via, people.mira.id);
  assert.equal(version.summary, "A better word");
  assert.equal(proposals.byId(suggestion).status, "accepted");
  assert.match(await read(`/pages/${id}/history`, "tomas"), /Tomás Lindqvist<\/a>, taken in by Mira Okafor/);
  // it cannot be answered twice
  assert.equal((await post(`/suggestions/${suggestion}/accept`, "mira")).status, 409);
  assert.equal((await post(`/suggestions/${suggestion}/withdraw`, "tomas")).status, 409);

  // declined, and withdrawn: the page stays as it was
  const suggest = async (body) =>
    Number(sentTo(await savePage(id, "tomas", { base: "3", title: "Welcome", body })).match(/\d+/)[0]);
  const declined = await suggest("Something else altogether.");
  assert.equal((await post(`/suggestions/${declined}/withdraw`, "mira")).status, 403);
  sentTo(await post(`/suggestions/${declined}/decline`, "mira"));
  assert.equal(proposals.byId(declined).status, "declined");
  assert.match(await read(`/suggestions/${declined}`, "tomas"), /Declined by Mira Okafor/);
  const withdrawn = await suggest("On second thoughts.");
  sentTo(await post(`/suggestions/${withdrawn}/withdraw`, "tomas"));
  assert.equal(proposals.byId(withdrawn).status, "withdrawn");
  assert.equal(pages.byId(id).version, 3);

  // a suggestion that clashes with what the page has become asks whoever takes it in to choose
  const clashing = await suggest("The opening paragraph.\n\nThe second paragraph.\n\nThe final paragraph.\n");
  sentTo(await savePage(id, "mira", { base: "3", title: "Welcome", body: "The opening paragraph.\n\nThe second paragraph.\n\nThe closing paragraph.\n" }));
  const asked = await post(`/suggestions/${clashing}/accept`, "mira");
  assert.equal(asked.status, 409);
  assert.match(await asked.text(), /The suggestion[\s\S]*What the page now says[\s\S]*name="pick-0"/);
  assert.equal(proposals.byId(clashing).status, "open");
  sentTo(await post(`/suggestions/${clashing}/accept`, "mira", { against: "4", "pick-0": "ours" }));
  assert.match(pages.byId(id).body, /The final paragraph\./);
  assert.equal(proposals.byId(clashing).status, "accepted");

  // once the project is made private, the member who was reading it is shut out of all of it
  sentTo(await post(`/projects/${project}/settings`, "mira", { title: "Open house", open: "0" }));
  for (const path of [`/projects/${project}`, `/pages/${id}`, `/pages/${id}/history`, `/suggestions/${suggestion}`])
    assert.equal((await get(path, "tomas")).status, 404, path);
});

test("someone working on a project can suggest instead of saving", async () => {
  const project = await startProject("mira", { title: "Careful" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Plan", body: "Do it one way." });
  const where = sentTo(await post(`/pages/${id}/edit`, "tomas", { do: "suggest", base: "1", title: "Plan", body: "Do it the other way." }));
  assert.match(where, /^\/suggestions\/\d+\?sent$/);
  assert.equal(pages.byId(id).version, 1);
  // the page says that a suggestion is waiting
  assert.match(await read(`/pages/${id}`, "mira"), /1 suggestion for this page awaits an answer/);
  sentTo(await post(`${where.replace("?sent", "")}/accept`, "mira"));
  assert.equal(pages.byId(id).body, "Do it the other way.");
  assert.doesNotMatch(await read(`/pages/${id}`, "mira"), /awaits an answer/);
});

test("a page taken out of a project is kept and can be put back; a deleted project is gone", async () => {
  const project = await startProject("mira", { title: "Coming and going" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Aside", body: "Not sure about this." });
  sentTo(await savePage(id, "tomas", { base: "1", title: "Aside", body: "Still not sure about this." }));

  assert.equal(sentTo(await post(`/pages/${id}/remove`, "tomas")), `/projects/${project}?out`);
  for (const path of [`/pages/${id}`, `/pages/${id}/edit`, `/pages/${id}/history`, `/pages/${id}/v/1`])
    assert.equal((await get(path, "mira")).status, 404, path);
  assert.equal((await savePage(id, "mira", { base: "2", title: "Aside", body: "Too late." })).status, 404);
  const without = await read(`/projects/${project}`, "mira");
  assert.match(without, /1 page taken out/);
  assert.match(without, new RegExp(`action="/pages/${id}/putback"`));

  assert.equal(sentTo(await post(`/pages/${id}/putback`, "mira")), `/projects/${project}?back`);
  assert.match(await read(`/pages/${id}`, "tomas"), /till not sure about this\./);
  assert.equal(pageVersions.list(id).length, 2);
  // a page that is in its project cannot be put back again
  assert.equal((await post(`/pages/${id}/putback`, "mira")).status, 404);

  // deleting the project takes its pages, their versions and its conversation with it
  const room = rooms.forProject(project).id;
  assert.equal((await get(`/chat/${room}`, "tomas")).status, 200);
  assert.equal(sentTo(await post(`/projects/${project}/delete`, "mira")), "/projects");
  assert.equal(projects.byId(project), undefined);
  assert.equal(pages.byId(id), undefined);
  assert.equal(pageVersions.list(id).length, 0);
  assert.equal(rooms.byId(room), undefined);
  for (const path of [`/projects/${project}`, `/pages/${id}`, `/chat/${room}`]) assert.equal((await get(path, "mira")).status, 404, path);
});

test("an admin can do in any project what its owner can", async () => {
  const project = await startProject("mira", { title: "Overseen" });
  const id = await addPage(project, "mira", { title: "Page", body: "Hers." });
  sentTo(await savePage(id, "zan", { base: "1", title: "Page", body: "Hers, and the keeper's." }));
  assert.equal(pages.byId(id).version, 2);
  sentTo(await post(`/projects/${project}/people`, "zan", { who: String(people.tomas.id) }));
  assert.equal(projects.has(project, people.tomas.id), true);
  sentTo(await post(`/projects/${project}/settings`, "zan", { title: "Overseen, renamed", open: "0" }));
  assert.equal(projects.byId(project).title, "Overseen, renamed");
  sentTo(await post(`/projects/${project}/delete`, "zan"));
  assert.equal(projects.byId(project), undefined);
});

/* --------------------------------------------------------------------- chat */

/** says something in a room as the page's script does, and gives back the message's id */
async function sayIn(room, who, body) {
  const response = await fetch(`${base}/chat/${room}`, {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people[who].cookie },
    body: new URLSearchParams({ _csrf: people[who].csrf, body }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

/** how many unread messages the menu shows a member */
async function unreadShown(who) {
  const found = (await read("/canon", who)).match(/(\d+) unread messages?<\/span>/);
  return found ? Number(found[1]) : 0;
}

/** the conversation between a member and those they tick */
async function conversation(who, ...withWhom) {
  const response = await post("/chat", who, withWhom.map((name) => ["who", String(people[name].id)]));
  return Number(sentTo(response).match(/^\/chat\/(\d+)$/)[1]);
}

test("the common room is every member's, and the menu counts what has not been read", async () => {
  const common = rooms.common().id;
  assert.equal(sentTo(await get(`/chat/${common}`)), `/login?next=%2Fchat%2F${common}`);
  // he has been there, so what is said from now on counts
  assert.match(await read(`/chat/${common}`, "tomas"), /Everyone/);
  const before = await unreadShown("tomas");
  const hers = await unreadShown("mira");

  const id = await sayIn(common, "mira", "Good morning to @tomas and everyone. See https://example.org/a?b=1.");
  await sayIn(common, "mira", "And a second thing.");
  assert.equal(await unreadShown("tomas"), before + 2);
  // what she said herself is not unread to her
  assert.equal(await unreadShown("mira"), hers);
  assert.match(await read("/chat", "tomas"), /room--unread[\s\S]*Mira Okafor: And a second thing\./);

  const room = await read(`/chat/${common}`, "tomas");
  assert.match(room, new RegExp(`id="m${id}"`));
  assert.match(room, /<a class="mention" href="\/m\/tomas">/);
  assert.match(room, /<a href="https:\/\/example\.org\/a\?b=1" rel="noopener noreferrer">/);
  // the one straight after is set under it without the name again
  assert.match(room, /class="say say--run"/);
  // he cannot remove hers; she and an admin can
  assert.doesNotMatch(room, new RegExp(`/m/${id}/remove`));
  assert.match(await read(`/chat/${common}`, "zan"), new RegExp(`/m/${id}/remove`));
  // having looked, he has none of it unread
  assert.equal(await unreadShown("tomas"), before);

  // without the script the form posts and comes back to the message
  const plain = await post(`/chat/${common}`, "tomas", { body: "<b>Plainly</b> said." });
  const where = sentTo(plain);
  assert.match(where, new RegExp(`^/chat/${common}#m\\d+$`));
  assert.match(await read(`/chat/${common}`, "mira"), /&lt;b&gt;Plainly&lt;\/b&gt; said\./);

  // a message needs words, not too many, and the form it was sent with
  assert.equal((await post(`/chat/${common}`, "tomas", { body: "  \n " })).status, 422);
  const long = await post(`/chat/${common}`, "tomas", { body: "x".repeat(4001) });
  assert.equal(long.status, 422);
  assert.match(await long.text(), /Keep a message under 4000 characters/);
  assert.equal((await post(`/chat/${common}`, "tomas", { body: "Forged." }, { csrf: false })).status, 403);
  assert.equal(sentTo(await post(`/chat/${common}`, null, { body: "Nobody." })), "/login");
  assert.equal((await get("/chat/999999", "mira")).status, 404);
});

test("a conversation is between the members chosen for it, and shown to no one else", async () => {
  const room = await conversation("mira", "tomas");
  // the same people always come back to the same one, whoever opens it
  assert.equal(await conversation("mira", "tomas"), room);
  assert.equal(await conversation("tomas", "mira"), room);
  assert.notEqual(await conversation("mira", "tomas", "zan"), room);
  assert.notEqual(await conversation("mira", "zan"), room);

  const id = await sayIn(room, "mira", "Between ourselves.");
  assert.match(await read(`/chat/${room}`, "tomas"), /Between ourselves\./);
  assert.match(await read("/chat", "tomas"), new RegExp(`href="/chat/${room}">Mira Okafor</a>`));
  assert.match(await read("/chat", "mira"), new RegExp(`href="/chat/${room}">Tomás Lindqvist</a>`));

  // an admin is no more in it than anyone else
  assert.equal((await get(`/chat/${room}`, "zan")).status, 404);
  assert.equal((await get(`/chat/${room}/stream`, "zan")).status, 404);
  assert.equal((await post(`/chat/${room}`, "zan", { body: "Let me in." })).status, 404);
  assert.equal((await post(`/chat/${room}/read`, "zan")).status, 404);
  assert.equal((await post(`/chat/${room}/m/${id}/remove`, "zan")).status, 404);
  assert.doesNotMatch(await read("/chat", "zan"), /Between ourselves/);
  assert.equal(messages.byId(id).removed_at, null);

  // it needs someone to be with, who is a member
  assert.equal((await post("/chat", "mira", {})).status, 422);
  assert.equal((await post("/chat", "mira", { who: String(people.mira.id) })).status, 422);
  assert.equal((await post("/chat", "mira", { who: "999999" })).status, 422);
});

test("a message is removed by whoever wrote it, or by an admin", async () => {
  const common = rooms.common().id;
  const hers = await sayIn(common, "mira", "Said in haste.");
  const his = await sayIn(common, "tomas", "Said at leisure.");

  assert.equal((await post(`/chat/${common}/m/${hers}/remove`, "tomas")).status, 403);
  assert.equal(sentTo(await post(`/chat/${common}/m/${hers}/remove`, "mira")), `/chat/${common}#m${hers}`);
  sentTo(await post(`/chat/${common}/m/${his}/remove`, "zan"));
  const room = await read(`/chat/${common}`, "tomas");
  assert.doesNotMatch(room, /Said in haste|Said at leisure/);
  assert.match(room, /A message was removed\./);
  // it cannot be removed twice, nor from a room it is not in
  assert.equal((await post(`/chat/${common}/m/${hers}/remove`, "mira")).status, 404);
  const other = await conversation("mira", "tomas");
  const kept = await sayIn(common, "mira", "Stays.");
  assert.equal((await post(`/chat/${other}/m/${kept}/remove`, "mira")).status, 404);
  assert.equal(messages.byId(kept).removed_at, null);
});

test("each project has a room for those working on it, where what is done is noted", async () => {
  const project = await startProject("mira", { title: "Talked over", open: "1" }, ["tomas"]);
  const id = await addPage(project, "mira", { title: "Agenda", body: "One item." });
  const room = Number(sentTo(await get(`/projects/${project}/talk`, "tomas")).match(/^\/chat\/(\d+)$/)[1]);

  const talk = await read(`/chat/${room}`, "tomas");
  assert.match(talk, /Talked over/);
  assert.match(talk, /Mira Okafor\s+<a href="\/projects\/\d+">started the project<\/a>/);
  assert.match(talk, /added Tomás Lindqvist to the project/);
  assert.match(talk, new RegExp(`<a href="/pages/${id}">began the page “Agenda”</a>`));
  // what was said before he was added is not counted as unread; that he was added, and what came after, is
  assert.equal(rooms.of(people.tomas.id).find((each) => each.id === room).unread, 0);
  await addPage(project, "mira", { title: "Minutes", body: "None yet." });
  const listed = rooms.of(people.tomas.id).find((each) => each.id === room);
  assert.equal(listed.unread, 1);
  assert.match(await read("/chat", "tomas"), /room--unread[\s\S]*Talked over[\s\S]*Mira Okafor began the page “Minutes”/);

  await sayIn(room, "tomas", "Shall we add a second item?");
  assert.match(await read(`/chat/${room}`, "mira"), /Shall we add a second item\?/);
  // an admin may look in; a member who is only reading the project may not
  assert.equal((await get(`/chat/${room}`, "zan")).status, 200);
  sentTo(await post(`/projects/${project}/people/${people.tomas.id}/remove`, "mira"));
  assert.equal((await get(`/pages/${id}`, "tomas")).status, 200);
  assert.equal((await get(`/chat/${room}`, "tomas")).status, 404);
  assert.equal((await get(`/chat/${room}/stream`, "tomas")).status, 404);
  assert.doesNotMatch(await read("/chat", "tomas"), /Talked over/);
});

test("messages can be shown beside any page: the list and a room come as parts as well as pages", async () => {
  const room = await conversation("mira", "tomas");
  await sayIn(room, "mira", "Shown beside the page.");
  const before = await unreadShown("tomas");
  assert.ok(before > 0);

  // the list, without a page around it
  const list = await read("/chat?part=1", "tomas");
  assert.doesNotMatch(list, /<html|masthead/);
  assert.match(list, new RegExp(`^<div data-part="list" data-unread="${before}">`));
  assert.match(list, new RegExp(`room--unread[\\s\\S]*href="/chat/${room}">Mira Okafor</a>`));
  assert.match(list, /<form class="form" method="post" action="\/chat" data-start>/);

  // a room: what has been said is in a box of its own, its fields named apart from the page's, and it is read
  const part = await read(`/chat/${room}?part=1`, "tomas");
  assert.doesNotMatch(part, /<html|masthead/);
  assert.match(part, /^<div data-part="room" data-unread="(\d+)">/);
  assert.ok(Number(part.match(/data-unread="(\d+)"/)[1]) < before);
  assert.match(part, /<a href="\/chat">All messages<\/a>/);
  assert.match(part, /data-talking="panel"[\s\S]*data-talk-scroll[\s\S]*id="panel-talk"[\s\S]*Shown beside the page\.[\s\S]*id="panel-body"/);
  assert.doesNotMatch(part, /id="(talk|say|body)"/);
  assert.ok((await unreadShown("tomas")) < before);

  // looking back at earlier messages is a page of its own, and so is everything for someone not signed in
  assert.match(await read(`/chat/${room}?part=1&before=999999`, "tomas"), /<html/);
  assert.equal(sentTo(await get("/chat?part=1")), "/login?next=%2Fchat%3Fpart%3D1");
  assert.equal((await get(`/chat/${room}?part=1`, "zan")).status, 404);

  // a conversation begun from a page is answered with where it is, for the page to open beside itself
  const begun = await fetch(base + "/chat", {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people.tomas.cookie },
    body: new URLSearchParams({ _csrf: people.tomas.csrf, who: String(people.mira.id) }),
  });
  assert.deepEqual(await begun.json(), { id: room });
  const none = await fetch(base + "/chat", {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people.tomas.cookie },
    body: new URLSearchParams({ _csrf: people.tomas.csrf }),
  });
  assert.equal(none.status, 422);
  assert.match((await none.json()).error, /Choose at least one member/);

  // a member's page has the way to write to them, and one's own does not
  const hers = await read("/m/mira", "tomas");
  assert.match(hers, new RegExp(`action="/chat" data-start>[\\s\\S]*name="who" value="${people.mira.id}"[\\s\\S]*Send Mira Okafor a message`));
  assert.doesNotMatch(await read("/m/tomas", "tomas"), /data-start/);
});

test("a project's conversation is on the project's page, for those working on it", async () => {
  const project = await startProject("mira", { title: "Said in place", open: "1" }, ["tomas"]);
  const room = rooms.forProject(project).id;
  await sayIn(room, "mira", "Shall we begin with the outline?");

  const his = await read(`/projects/${project}`, "tomas");
  assert.match(his, /<a href="#conversation"\s*>Conversation <span class="badge" data-talk-unread aria-hidden="true">2<\/span><\/a\s*>/);
  assert.match(his, /<section class="conversation" id="conversation"/);
  assert.match(his, new RegExp(`data-talking="project" data-unread="2"[\\s\\S]*data-room="${room}"[\\s\\S]*Shall we begin with the outline\\?`));
  assert.match(his, new RegExp(`<form class="form talk__form" id="project-say" method="post" action="/chat/${room}" data-chat>`));
  assert.match(his, new RegExp(`<a href="/chat/${room}">Open it on a page of its own</a>`));
  // (that he was added counts with what she said.) Seeing the page is not yet reading the
  // conversation; the page says so when it has been looked at
  assert.equal(rooms.unreadIn(room, people.tomas.id), 2);
  const told = await fetch(base + `/chat/${room}/read`, {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people.tomas.cookie },
    body: new URLSearchParams({ _csrf: people.tomas.csrf }),
  });
  assert.equal(told.status, 200);
  assert.equal(rooms.unreadIn(room, people.tomas.id), 0);
  assert.doesNotMatch(await read(`/projects/${project}`, "tomas"), /data-talk-unread/);

  // it can be answered from there with or without a script
  assert.equal(sentTo(await post(`/chat/${room}`, "tomas", { body: "Yes, the outline first." })).split("#")[0], `/chat/${room}`);
  assert.match(await read(`/projects/${project}`, "mira"), /Yes, the outline first\./);

  // someone only reading the project is not shown it; an admin looking in is, with nothing counted as unread
  const apart = await startProject("mira", { title: "Read, not worked on", open: "1" }, []);
  await sayIn(rooms.forProject(apart).id, "mira", "A note to myself.");
  const reader = await read(`/projects/${apart}`, "tomas");
  assert.match(reader, /Read, not worked on/);
  assert.doesNotMatch(reader, /id="conversation"|A note to myself/);
  assert.match(await read(`/projects/${project}`, "zan"), /data-talking="project" data-unread="0"/);
  // the old way to it still leads there
  assert.equal(sentTo(await get(`/projects/${project}/talk`, "tomas")), `/chat/${room}`);
});

test("the projects have their place at the head of the journal", async () => {
  const project = await startProject("tomas", { title: "On the shelf" }, []);
  sentTo(await grant("tomas", ["write"]));
  const his = await read("/", "tomas");
  const [, shelf] = his.match(/<nav class="shelf" aria-labelledby="shelf-title">([\s\S]*?)<\/nav>/);
  assert.match(shelf, /<a href="\/projects">Projects<\/a>/);
  assert.match(shelf, new RegExp(`<li><a href="/projects/${project}">On the shelf</a></li>`));
  assert.match(shelf, /<a href="\/projects">All projects<\/a>\s*<a href="\/projects\/new">Start one<\/a>/);
  sentTo(await grant("tomas", []));
  // a private project of someone else's is not named to those who are not working on it
  const [, hers] = (await read("/", "zan")).match(/<nav class="shelf" aria-labelledby="shelf-title">([\s\S]*?)<\/nav>/);
  assert.doesNotMatch(hers, /On the shelf/);
  // the list of them all is still a page, for every member, and a project leads back to it
  assert.equal((await get("/projects", "tomas")).status, 200);
  assert.match(await read(`/projects/${project}`, "tomas"), /<p class="rubric"><a href="\/projects">Projects<\/a> · /);
});

/* ------------------------------------------------- marks of who is reading */

test("every signed-in page carries its reader's mark, and the door carries none", async () => {
  const hers = await read("/corpus", "mira");
  const [, address] = hers.match(/<div class="mark" aria-hidden="true" style="background-image:url\((\/mark\/\d+-\d+-paper\.svg\?v=\d+)\)"><\/div>\s*<\/body>/);
  for (const path of ["/account", "/chat", "/projects", "/canon", "/submit", "/write", "/nowhere"])
    assert.ok((await read(path, "mira")).includes(`url(${address})`), path);
  assert.doesNotMatch(await read("/login"), /class="mark"/);
  // the parts set beside a page have none of their own: the page they are set beside has
  assert.doesNotMatch(await read("/chat?part=1", "mira"), /class="mark"/);

  // the mark names her, today, and her sign-in; it is a picture in which nothing can run, and hers alone
  const mark = await get(address, "mira");
  assert.equal(mark.status, 200);
  assert.equal(mark.headers.get("content-type"), "image/svg+xml");
  assert.equal(mark.headers.get("cache-control"), "private, max-age=86400");
  assert.match(mark.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
  const svg = await mark.text();
  const today = new Date().toISOString().slice(0, 10);
  const id = address.match(/\/mark\/(\d+)-/)[1];
  assert.equal(svg.match(/<text[^>]*>([^<]*)<\/text>/g).length, 2);
  assert.ok(svg.includes(`>mira · ${today} · ${id}</text>`));
  // too faint for the eye: a single step of a screen's brightness, which a screenshot keeps exactly
  const strength = Number(svg.match(/fill-opacity="(0\.\d+)"/)[1]);
  assert.ok(strength >= 0.004 && strength < 0.006, `drawn at ${strength}`);
  assert.doesNotMatch(svg, /<script|href=|url\(/);

  // nobody is given another's, nor one for a day yet to come, nor without signing in
  assert.equal((await get(address, "tomas")).status, 404);
  assert.equal((await get(address.replace(/-\d+-paper\.svg/, "-99999-paper.svg"), "mira")).status, 404);
  assert.equal((await get("/mark/1.svg", "mira")).status, 404);
  assert.equal(sentTo(await get(address)), `/login?next=${encodeURIComponent(address)}`);

  // on the paper page it is drawn in ink, where on the night one it is in gold; and it is
  // at another address, so that a browser which kept the ink one asks for the gold
  assert.match(svg, /fill="#3f2e28"/);
  sentTo(await post("/account/theme", "mira", { theme: "night" }));
  const byNight = address.replace("-paper.svg", "-night.svg");
  assert.ok((await read("/corpus", "mira")).includes(`url(${byNight})`));
  const gold = await (await get(byNight, "mira")).text();
  assert.match(gold, /fill="#d6c391"/);
  assert.equal(Number(gold.match(/fill-opacity="(0\.\d+)"/)[1]), strength, "and as faintly");
  sentTo(await post("/account/theme", "mira", { theme: "paper" }));
  assert.ok((await read("/corpus", "mira")).includes(`url(${address})`));
});

test("a member who asks for pages faster than anyone reads is refused for a while, and it is noted", async () => {
  const { member } = await import("../src/gate.mjs");
  const { LIMITS, paced, resetPace } = await import("../src/pace.mjs");
  const { adminLog } = await import("../src/db.mjs");
  resetPace();
  const session = auth.findSession(people.tomas.cookie.slice("session=".length));
  const asking = (path, headers = {}, method = "GET") => ({ session, req: { method, headers }, url: new URL(path, base) });
  const [{ most }] = LIMITS.pages;
  const noted = () => adminLog.latest(500).filter((entry) => entry.action === "paced" && entry.member_id === people.tomas.id).length;
  const before = noted();

  // what a page's own script asks for as it works is not reading, however much of it there is
  for (let i = 0; i < most * 2; i++) {
    member(asking("/suggest.json"));
    member(asking("/chat/1/stream", { accept: "text/event-stream" }));
    member(asking("/account/push", { accept: "application/json" }));
    member(asking("/mark/1-1-night.svg", { "sec-fetch-dest": "image" }));
    member(asking("/preview", { accept: "application/json" }, "POST"));
    member(asking("/static/forum.css", { "sec-fetch-dest": "style" }));
  }
  // as many pages as a window full of tabs coming back at once are let through
  for (let i = 0; i < most; i++) member(asking(`/p/${i + 1}`, { "sec-fetch-dest": "document" }));
  assert.equal(noted(), before);
  // the next is refused, whether a browser asks or a program that says nothing of itself
  for (const headers of [{ "sec-fetch-dest": "document" }, {}, { "sec-fetch-dest": "empty" }])
    assert.throws(
      () => member(asking("/p/1", headers)),
      (err) => err.status === 429 && /faster than anyone reads/.test(err.message) && Number(err.headers["Retry-After"]) > 0 && Number(err.headers["Retry-After"]) <= 60
    );
  // it is written down once for the admins, not once for every page refused
  assert.equal(noted(), before + 1);
  // what is not reading still goes through, so that nothing being written is lost, and so does everyone else
  member(asking("/preview", { accept: "application/json" }, "POST"));
  member({ ...asking("/p/1", { "sec-fetch-dest": "document" }), session: auth.findSession(people.mira.cookie.slice("session=".length)) });

  // a minute on the pages turn again; an hour of reading at that pace is past what the hour allows
  const start = Date.now() + 61_000;
  assert.equal(paced(people.tomas.id, "pages", start), null);
  let refused = null;
  for (let i = 0; i < LIMITS.pages[1].most && refused === null; i++) refused = paced(people.tomas.id, "pages", start + i * 500);
  assert.ok(refused > 60, "refused for the rest of the hour, not of the minute");
  // pictures are counted apart, and more freely: a page may hold many
  assert.equal(paced(people.tomas.id, "pictures", start), null);
  resetPace();
});

/* ------------------------------------------------------------ notifications */

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** posts as a page's own script does, and gives back the answer */
const ask = (path, who, fields = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { Origin: base, Accept: "application/json", Cookie: people[who].cookie },
    body: new URLSearchParams({ _csrf: people[who].csrf, ...fields }),
  });

const postNote = (id, who, fields) => post(`/p/${id}/notes`, who, fields);

/** turns notifications on for a browser signed in as `who`, subscribed at `path` of the push service */
async function subscribe(who, path, phone = device()) {
  const response = await ask("/account/push", who, { endpoint: pushBase + path, p256dh: phone.p256dh, auth: phone.auth });
  assert.equal(response.status, 201);
  return phone;
}

/** what the push service was sent for a device since `from`, read as the device would read it */
const toldTo = (path, phone, from = 0) =>
  pushed
    .slice(from)
    .filter((each) => each.path === path)
    .map((each) => ({ ...JSON.parse(open(each.body, phone)), headers: each.headers }));

test("a device that asks is told of messages and tags, sealed so that only it can read them", async () => {
  // what a browser needs is there for the asking, and says nothing of anyone
  const worker = await get("/sw.js");
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type"), /^text\/javascript/);
  assert.equal(worker.headers.get("cache-control"), "no-cache");
  assert.doesNotMatch(await worker.text(), /addEventListener\("fetch"/, "it answers no requests: pages load as they always have");
  const manifest = await get("/manifest.webmanifest");
  assert.match(manifest.headers.get("content-type"), /^application\/manifest\+json/);
  const about = await manifest.json();
  assert.equal(about.display, "standalone");
  for (const icon of about.icons) assert.equal((await get(icon.src)).status, 200, icon.src);
  assert.match(await read("/login"), /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);

  // nothing is on until a member turns it on, and only a member can
  assert.equal(sentTo(await get("/account/push")), "/login?next=%2Faccount%2Fpush");
  const before = await (await get("/account/push", "tomas")).json();
  assert.equal(before.on, false);
  assert.match(await read("/account", "tomas"), /<html lang="en" data-theme="paper" data-me="\d+" data-session="\d+" data-pushed="0">/);
  assert.equal((await ask("/account/push/test", "tomas")).status, 409);

  // an address that is not a push service's is not kept: the forum is not to be made to call wherever it is told
  const phone = device();
  for (const endpoint of ["https://example.org/hook", `${base}/account`, "http://127.0.0.1:1/x", ""])
    assert.equal((await ask("/account/push", "tomas", { endpoint, p256dh: phone.p256dh, auth: phone.auth })).status, 422, endpoint);
  assert.equal((await ask("/account/push", "tomas", { endpoint: `${pushBase}/send/x`, p256dh: "nonsense", auth: phone.auth })).status, 422);
  const unasked = await post("/account/push", "tomas", { endpoint: `${pushBase}/send/x`, p256dh: phone.p256dh, auth: phone.auth }, { csrf: false });
  assert.equal(unasked.status, 403);
  assert.equal(subscriptions.of(people.tomas.id).length, 0);

  await subscribe("tomas", "/send/tomas-phone", phone);
  assert.equal((await (await get("/account/push", "tomas")).json()).on, true);
  assert.match(await read("/account", "tomas"), /data-pushed="1"/);

  // a test is sent at once, to the service's address, signed as the forum's and sealed to the device
  let from = pushed.length;
  assert.deepEqual(await (await ask("/account/push/test", "tomas")).json(), { sent: true });
  const [test] = toldTo("/send/tomas-phone", phone, from);
  assert.equal(test.title, "Gesserit");
  assert.equal(test.url, "/account#notifications");
  assert.equal(test.headers["content-encoding"], "aes128gcm");
  assert.equal(test.headers.ttl, "86400");
  const word = claimed(test.headers.authorization);
  assert.equal(word.key, before.key);
  assert.equal(word.claims.aud, pushBase);
  assert.ok(word.claims.exp > Date.now() / 1000 && word.claims.exp < Date.now() / 1000 + 24 * 60 * 60);
  assert.doesNotMatch(pushed[from].body.toString("latin1"), /Gesserit|Notifications/);
  assert.throws(() => open(pushed[from].body, device()), "another device cannot read it");

  // a message in a conversation reaches him a moment after it is said
  const room = await conversation("mira", "tomas");
  from = pushed.length;
  await sayIn(room, "mira", "Are you free on Thursday?");
  assert.equal(toldTo("/send/tomas-phone", phone, from).length, 0, "not at once: he may be looking at it");
  await pause(PUSH_DELAY + 250);
  const [said] = toldTo("/send/tomas-phone", phone, from);
  assert.deepEqual(
    { title: said.title, body: said.body, url: said.url, tag: said.tag },
    { title: "Mira Okafor", body: "Are you free on Thursday?", url: `/chat/${room}`, tag: `room-${room}` }
  );
  assert.equal(said.headers.topic, `room-${room}`);
  // she is not told of what she said herself, nor is anyone who has not asked
  assert.equal(pushed.length, from + 1);

  // what he has before him, and has read by then, he is not told of again
  from = pushed.length;
  await sayIn(room, "mira", "Never mind, I see you are here.");
  rooms.markRead(room, people.tomas.id);
  await pause(PUSH_DELAY + 250);
  assert.equal(pushed.length, from);
  // nor of a message that was taken back before the moment was up
  const taken = await sayIn(room, "mira", "Sent to the wrong person.");
  sentTo(await post(`/chat/${room}/m/${taken}/remove`, "mira"));
  await pause(PUSH_DELAY + 250);
  assert.equal(pushed.length, from);

  // a project's conversation says which project; what the forum notes there of its own accord is not sent
  const project = await startProject("mira", { title: "Told about" }, ["tomas"]);
  const talk = rooms.forProject(project).id;
  from = pushed.length;
  await sayIn(talk, "mira", "The first page is up.");
  await pause(PUSH_DELAY + 250);
  const told = toldTo("/send/tomas-phone", phone, from);
  assert.deepEqual(told.map((each) => each.title), ["Mira Okafor · Told about"]);

  // the common room is not sent unless asked for; being tagged there is
  const common = rooms.common().id;
  from = pushed.length;
  await sayIn(common, "mira", "Good evening, all.");
  await sayIn(common, "mira", "And to @tomas in particular.");
  await pause(PUSH_DELAY + 250);
  assert.deepEqual(
    toldTo("/send/tomas-phone", phone, from).map((each) => [each.title, each.body]),
    [["Mira Okafor · Everyone", "And to @tomas in particular."]]
  );

  // a tag in a margin note is sent as it is made, and leads to the note
  const article = await publish({ title: "Tagged from afar", body: "A post to hang a note on." });
  from = pushed.length;
  const note = noteId(sentTo(await postNote(article, "mira", { body: "What does @tomas make of this?" })));
  await pause(150);
  const [tag] = toldTo("/send/tomas-phone", phone, from);
  assert.deepEqual(
    { title: tag.title, body: tag.body, url: tag.url },
    { title: "Mira Okafor tagged you", body: "in a note on Tagged from afar: What does @tomas make of this?", url: `/p/${article}#note-${note}` }
  );
  // and so is one in a post, once: saving the post again does not say it again
  from = pushed.length;
  const tagging = await publish({ title: "For Tomás", body: "This one is for @tomas." }, "zan");
  sentTo(await revise(tagging, { title: "For Tomás", body: "This one is for @tomas. Reworded." }));
  await pause(150);
  assert.deepEqual(
    toldTo("/send/tomas-phone", phone, from).map((each) => [each.title, each.body, each.url]),
    [["Zan Huang tagged you", "in For Tomás", `/p/${tagging}`]]
  );

  // what he is told of is his to choose, for all his devices: here tags only, and without the words
  assert.equal(sentTo(await post("/account/notify", "tomas", [["about", "tags"], ["about", "nonsense"]])), "/account?done=notify#notifications");
  assert.equal(users.byId(people.tomas.id).notify, "tags");
  from = pushed.length;
  await sayIn(room, "mira", "Not sent to his telephone.");
  const quiet = noteId(sentTo(await postNote(article, "mira", { body: "A second word for @tomas, kept off his locked screen." })));
  await pause(PUSH_DELAY + 250);
  assert.deepEqual(
    toldTo("/send/tomas-phone", phone, from).map((each) => [each.title, each.body, each.url]),
    [["Mira Okafor tagged you", "in a note on Tagged from afar", `/p/${article}#note-${quiet}`]]
  );
  sentTo(await post("/account/notify", "tomas", [["about", "direct"], ["about", "project"], ["about", "tags"], ["about", "words"]]));
});

test("a device is told nothing once it is signed out, turned off, or gone", async () => {
  const room = await conversation("mira", "tomas");
  const quiet = async (path, phone) => {
    const from = pushed.length;
    await sayIn(room, "mira", "Is anyone told of this?");
    await pause(PUSH_DELAY + 250);
    return toldTo(path, phone, from).length === 0;
  };

  // a second browser of his, with a sign-in of its own
  const token = auth.createSession(people.tomas.id);
  people.laptop = { id: people.tomas.id, cookie: `session=${token}`, csrf: auth.findSession(token).csrf };
  const laptop = await subscribe("laptop", "/send/tomas-laptop");
  assert.equal(await quiet("/send/tomas-laptop", laptop), false);
  assert.equal(subscriptions.of(people.tomas.id).length, 2);
  // a browser has one subscription: subscribing again takes the place of the first
  const again = await subscribe("laptop", "/send/tomas-laptop-2");
  assert.equal(subscriptions.of(people.tomas.id).length, 2);
  assert.equal(await quiet("/send/tomas-laptop", laptop), true);
  assert.equal(await quiet("/send/tomas-laptop-2", again), false);

  // from one device he can turn another off; not someone else's
  const [{ id }] = subscriptions.of(people.tomas.id).filter((each) => each.session_hash === auth.findSession(token).tokenHash);
  assert.equal((await post(`/account/push/${id}/remove`, "mira")).status, 404);

  assert.equal(sentTo(await post(`/account/push/${id}/remove`, "tomas")), "/account?done=device#notifications");
  assert.equal(await quiet("/send/tomas-laptop-2", again), true);

  // signing out ends it with the session, and so does being signed out from elsewhere
  const back = await subscribe("laptop", "/send/tomas-laptop-3");
  sentTo(await post("/logout", "laptop"));
  assert.equal(subscriptions.of(people.tomas.id).length, 1);
  assert.equal(await quiet("/send/tomas-laptop-3", back), true);

  // a session that has run out is told nothing, even before it is swept away
  const old = auth.createSession(people.tomas.id);
  people.old = { id: people.tomas.id, cookie: `session=${old}`, csrf: auth.findSession(old).csrf };
  const stale = await subscribe("old", "/send/tomas-old");
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run("2000-01-01T00:00:00.000Z", auth.findSession(old)?.tokenHash ?? "");
  assert.equal(await quiet("/send/tomas-old", stale), true);
  auth.sweepSessions();
  assert.equal(subscriptions.of(people.tomas.id).length, 1);

  // a subscription the push service says has ended is forgotten
  const other = auth.createSession(people.mira.id);
  people.tablet = { id: people.mira.id, cookie: `session=${other}`, csrf: auth.findSession(other).csrf };
  await subscribe("tablet", "/gone/mira-tablet");
  assert.equal(subscriptions.of(people.mira.id).length, 1);
  assert.equal((await ask("/account/push/test", "tablet")).status, 502);
  assert.equal(subscriptions.of(people.mira.id).length, 0);

  // turning it off on the device itself
  await subscribe("tablet", "/send/mira-tablet");
  assert.deepEqual(await (await ask("/account/push/off", "tablet")).json(), { on: false });
  assert.equal(subscriptions.of(people.mira.id).length, 0);

  // a member who has been removed is told nothing
  const kit = await newcomer("kit", "Kit Marlowe");
  const pocket = await subscribe("kit", "/send/kit-phone");
  const theirs = await conversation("mira", "kit");
  users.setActive(kit.id, false);
  const from = pushed.length;
  await sayIn(theirs, "mira", "Are you still there?");
  await pause(PUSH_DELAY + 250);
  assert.equal(toldTo("/send/kit-phone", pocket, from).length, 0);
});

test("a page that is open on a room is sent what is said there as it is said", async () => {
  const room = await conversation("mira", "tomas");
  const earlier = await sayIn(room, "mira", "Before he was listening.");

  /** opens the connection a page keeps, and reads from it */
  async function listenTo(path, headers = {}) {
    const stop = new AbortController();
    const stream = await fetch(base + path, { headers: { Cookie: people.tomas.cookie, ...headers }, signal: stop.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const line = { heard: "", stop: () => stop.abort() };
    /** reads on until what has come in holds `pattern` */
    line.hear = async (pattern) => {
      const deadline = Date.now() + 5000;
      while (!pattern.test(line.heard)) {
        assert.ok(Date.now() < deadline, `nothing like ${pattern} was heard in: ${line.heard}`);
        const { value, done } = await reader.read();
        assert.equal(done, false, "the connection was closed");
        line.heard += decoder.decode(value, { stream: true });
      }
    };
    return line;
  }

  const line = await listenTo(`/chat/${room}/stream?after=${earlier}`);
  const id = await sayIn(room, "mira", "Can you hear this?");
  await line.hear(/Can you hear this\?/);
  assert.match(line.heard, new RegExp(`id: ${id}\\nevent: said\\ndata: \\{"id":${id},"html":"<li class=\\\\"say\\\\"`));
  // only what came after the message the page said it had
  assert.doesNotMatch(line.heard, /Before he was listening/);
  // it is drawn for the one listening: he is not offered the removing of her message
  assert.doesNotMatch(line.heard, /remove/);

  sentTo(await post(`/chat/${room}/m/${id}/remove`, "mira"));
  await line.hear(/event: removed/);
  assert.match(line.heard, new RegExp(`event: removed\\ndata: \\{"id":${id},"html":"<li class=\\\\"say say--gone\\\\"`));
  line.stop();

  // a page that comes back after a break says what it had last, and is sent what it missed
  const missed = await sayIn(room, "mira", "Said while he was away.");
  const again = await listenTo(`/chat/${room}/stream`, { "Last-Event-ID": String(id) });
  await again.hear(/Said while he was away\./);
  assert.match(again.heard, new RegExp(`id: ${missed}\\n`));
  assert.doesNotMatch(again.heard, /Before he was listening|say--gone/);

  // someone signed out stops being sent anything: the connection is closed on them
  const token = auth.createSession(people.tomas.id);
  const brief = new AbortController();
  const stream = await fetch(`${base}/chat/${room}/stream?after=${missed}`, { headers: { Cookie: `session=${token}` }, signal: brief.signal });
  const reader = stream.body.getReader();
  await reader.read();
  auth.destroySession(auth.findSession(token).tokenHash);
  await sayIn(room, "mira", "Not for a session that has ended.");
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  assert.doesNotMatch(rest, /Not for a session that has ended/);
  await again.hear(/Not for a session that has ended\./);
  again.stop();
});

test("a long conversation shows its latest messages, and leads back to the earlier ones", async () => {
  const room = await conversation("tomas", "zan");
  for (let i = 1; i <= 64; i++) messages.create({ roomId: room, userId: people.tomas.id, body: `Message number ${i}.` });
  const latest = await read(`/chat/${room}`, "zan");
  assert.match(latest, /Message number 64\./);
  assert.match(latest, /Message number 5\./);
  assert.doesNotMatch(latest, /Message number 4\./);
  const back = latest.match(new RegExp(`href="(/chat/${room}\\?before=\\d+)">Earlier messages`));
  assert.ok(back, "there is a way back to earlier messages");

  const earlier = await read(back[1], "zan");
  assert.match(earlier, /Message number 1\./);
  assert.match(earlier, /Message number 4\./);
  assert.doesNotMatch(earlier, /Message number 5\./);
  assert.doesNotMatch(earlier, /Earlier messages/);
  // looking back is reading, not writing: no box, and nothing live
  assert.doesNotMatch(earlier, /data-chat|data-live/);
});

/* ------------------------------------------- the door, and what guards it */

/** someone new, signed in, for the tests that would otherwise disturb the others */
async function newcomer(username, name, role = "member") {
  const id = users.create({ username, name, role, passwordHash: await auth.hashPassword(`${username}-password`) });
  const token = auth.createSession(id, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15");
  people[username] = { id, cookie: `session=${token}`, csrf: auth.findSession(token).csrf };
  return people[username];
}

/** sends a request exactly as written, which fetch will not do, and gives back the status line */
function raw(request) {
  const { port } = new URL(base);
  return new Promise((done, fail) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(request));
    let heard = "";
    socket.on("data", (chunk) => (heard += chunk));
    socket.on("end", () => done(heard.split("\r\n")[0]));
    socket.on("error", fail);
  });
}

test("an address that cannot be read is turned away, and the server is still there afterwards", async () => {
  const ask = (target) => raw(`GET ${target} HTTP/1.1\r\nHost: forum\r\nConnection: close\r\n\r\n`);
  assert.match(await ask("http://["), /^HTTP\/1\.1 400 /);
  assert.match(await ask("//["), /^HTTP\/1\.1 (302|404) /, "a doubled slash is not the name of another site");
  assert.match(await ask("/%"), /^HTTP\/1\.1 (302|404) /);
  assert.match(await ask("//evil.example/login"), /^HTTP\/1\.1 (302|404) /, "nor is it sent on to one");
  assert.equal((await get("/login")).status, 200);
});

test("every page says what a browser may do with it, and asks nothing of any other site", async () => {
  const page = await get("/", "mira");
  const policy = page.headers.get("content-security-policy");
  for (const part of ["default-src 'self'", "script-src 'self'", "font-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"])
    assert.ok(policy.includes(part), `the policy has ${part}`);
  assert.doesNotMatch(policy, /googleapis|gstatic|unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(await page.text(), /fonts\.googleapis|fonts\.gstatic/, "the typeface is served from here");

  // the door itself is as guarded as what is behind it
  const door = await get("/login");
  assert.equal(door.headers.get("x-frame-options"), "DENY");
  const sheet = (await door.text()).match(/href="(\/assets\/fonts\/eb-garamond\.css[^"]*)"/);
  assert.ok(sheet, "the sign-in page uses the typeface kept here");

  const faces = await get(sheet[1]);
  assert.equal(faces.status, 200);
  assert.match(faces.headers.get("content-type"), /^text\/css/);
  assert.equal(faces.headers.get("x-content-type-options"), "nosniff");
  const font = await get("/assets/fonts/EBGaramond-Roman-latin.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.deepEqual([...new Uint8Array(await font.arrayBuffer()).slice(0, 4)], [0x77, 0x4f, 0x46, 0x32], "wOF2");
  for (const path of ["/assets/fonts/..%2F..%2Fserver%2Fserver.mjs", "/assets/fonts/%2e%2e%2f%2e%2e%2fCNAME", "/assets/fonts/nothing.woff2"])
    assert.equal((await get(path)).status, 404, path);
});

test("a form sent from a page on another site is refused, whatever it carries", async () => {
  const id = await publish({ title: "Not to be written on from outside", body: "A post." });
  const written = () => db.prepare("SELECT COUNT(*) AS n FROM notes WHERE post_id = ?").get(id).n;
  const from = (site, origin = base) =>
    fetch(`${base}/p/${id}/notes`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: origin, Cookie: people.mira.cookie, ...(site ? { "Sec-Fetch-Site": site } : {}) },
      body: new URLSearchParams({ _csrf: people.mira.csrf, body: `Sent from ${site || "nowhere it says"}.` }),
    });
  assert.equal((await from("cross-site")).status, 403);
  assert.equal((await from("same-site")).status, 403, "another part of the same domain is another site");
  assert.equal((await from("same-origin", "https://evil.example")).status, 403);
  assert.equal(written(), 0);
  sentTo(await from("same-origin"));
  sentTo(await from("none"));
  sentTo(await from(null));
  assert.equal(written(), 3);
});

test("guessing at a password is cut off for that name, and a right guess afterwards is not let in", async () => {
  await newcomer("guessed", "Gus Guessed");
  const tryWith = (password, username = "guessed") => post("/login", null, { username, password });
  for (let i = 0; i < 8; i++) assert.equal((await tryWith(`wrong-${i}`)).status, 401);
  const shut = await tryWith("guessed-password");
  assert.equal(shut.status, 429);
  assert.equal(shut.headers.get("set-cookie"), null);
  assert.match(await shut.text(), /Too many attempts\. Wait a quarter of an hour and try again\./);
  // nobody else is kept out by it
  sentTo(await tryWith("tomas-password", "tomas"));
  // a password too long to be one is not weighed at all
  assert.equal((await tryWith("x".repeat(5000), "tomas")).status, 401);
});

test("a new password has to be worth having, and changing it signs the member out everywhere else", async () => {
  const lena = await newcomer("lena", "Lena Brandt");
  const elsewhere = `session=${auth.createSession(lena.id)}`;
  const change = (current, password) => post("/account/password", "lena", { current, password });
  const refused = async (current, password, saying) => {
    const response = await change(current, password);
    assert.equal(response.status, 422, password);
    assert.match(await response.text(), saying);
  };
  await refused("not-it", "a perfectly good one", /That is not your current password\./);
  await refused("lena-password", "short", /A new password needs at least 10 characters\./);
  await refused("lena-password", "aaaaaaaaaaaaaa", /the same few characters over again/);
  await refused("lena-password", "Password1234", /among the first anyone would try/);
  await refused("lena-password", "lena.brandt.99", /made of your own name/);
  await refused("lena-password", "lena-password", /That is the password you have now\./);
  assert.equal((await post("/account/password", "lena", { current: "lena-password", password: "a perfectly good one" }, { csrf: false })).status, 403);
  assert.equal((await fetch(base + "/account", { redirect: "manual", headers: { Cookie: elsewhere } })).status, 200, "nothing has changed yet");

  assert.equal(sentTo(await change("lena-password", "a perfectly good one")), "/account?done=password");
  assert.match(await read("/account?done=password", "lena"), /Your password has been changed, and you have been signed out everywhere else\./);
  assert.equal(sentTo(await fetch(base + "/account", { redirect: "manual", headers: { Cookie: elsewhere } })), "/login?next=%2Faccount");
  assert.equal((await post("/login", null, { username: "lena", password: "lena-password" })).status, 401);
  sentTo(await post("/login", null, { username: "lena", password: "a perfectly good one" }));
  // what a page is told to say comes from a short list, not from its address
  assert.doesNotMatch(await read("/account?done=<b>anything</b>", "lena"), /anything/);
});

test("the pages are paper for a member until they choose the night, and the door is always paper", async () => {
  const ada = await newcomer("ada", "Ada Morrow");
  const light = await read("/corpus", "ada");
  assert.match(light, /<html lang="en" data-theme="paper" data-me="\d+" data-session="\d+" data-pushed="0">/);
  assert.match(light, /<meta name="theme-color" content="#e4d9c4"/);
  assert.match(light, /<meta name="color-scheme" content="light"/);
  const account = await read("/account", "ada");
  const chosen = (look, pressed) => new RegExp(`class="look look--${look}"\\s+type="submit"\\s+name="theme"\\s+value="${look}"\\s+aria-pressed="${pressed}"`);
  assert.match(account, chosen("paper", true));
  assert.match(account, chosen("night", false));
  assert.ok(account.indexOf('value="paper"') < account.indexOf('value="night"'), "the paper is offered first");

  assert.equal((await post("/account/theme", "ada", { theme: "night" }, { csrf: false })).status, 403);
  assert.equal((await post("/account/theme", "ada", { theme: "neon" })).status, 400);
  assert.equal(sentTo(await post("/account/theme", "ada", { theme: "night" })), "/account#lighting");
  const dark = await read("/write-is-at-the-root", "ada");
  assert.match(dark, /<html lang="en" data-theme="night" data-me="\d+" data-session="\d+" data-pushed="0">/, "even the page for what is not there");
  assert.match(await read("/corpus", "ada"), /<meta name="theme-color" content="#0b0a08"/);
  assert.match(await read("/corpus", "ada"), /<meta name="color-scheme" content="dark"/);
  assert.match(await read("/account", "ada"), chosen("night", true));
  assert.equal(users.byId(ada.id).theme, "night");
  assert.match(await read("/corpus", "mira"), /data-theme="paper"/, "it is each member's own choice");

  assert.match(await read("/login"), /<html lang="en" data-theme="paper">/);
  sentTo(await post("/account/theme", "ada", { theme: "paper" }));
  assert.match(await read("/corpus", "ada"), /data-theme="paper"/);
});

test("preferences are the lighting of the pages and the password, and nothing else", async () => {
  assert.equal(sentTo(await get("/account")), "/login?next=%2Faccount");
  for (const who of ["mira", "zan"]) {
    const page = await read("/account", who);
    assert.match(page, /<title>Preferences · Gesserit<\/title>/);
    assert.match(page, /<h1 class="page-title page-title--preferences">Preferences<\/h1>/);
    assert.deepEqual(
      [...page.matchAll(/<h2 class="section-title"[^>]*>([^<]+)<\/h2>/g)].map((found) => found[1]),
      ["Lighting", "Change password"]
    );
    assert.match(page, /<form class="looks" method="post" action="\/account\/theme">/);
    // each lighting is a leaf of itself with its name beside it: which is chosen is shown by its frame, and nothing is said of either
    assert.deepEqual([...page.matchAll(/<span class="look__name">([^<]*)<\/span>/g)].map((found) => found[1]), ["Paper", "Night"]);
    assert.equal(page.match(/aria-pressed="true"/g).length, 1);
    assert.doesNotMatch(page, /Chosen|look__says|Ink on paper|Gold on black/);
    assert.match(page, /<label for="current">Current password<\/label>[\s\S]*<label for="new-password">New password<\/label>/);
    // none of what stood here before, nor the lines that explained these two
    assert.doesNotMatch(
      page,
      /Kept with your account|At least \d+ characters|class="hint"|class="places"|signed in as|tagged|Notifications|data-notify|Where you are signed in|\/account\/sessions|Your page|\/members|How the pages look/
    );
  }
  // where a member was signed in was shown here, and ended from here: neither is any more
  const sam = await newcomer("sam", "Sam Oduya");
  const phone = auth.createSession(sam.id, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)");
  assert.equal((await post(`/account/sessions/${auth.findSession(phone).id}/end`, "sam")).status, 404);
  assert.equal((await post("/account/sessions/end", "sam")).status, 404);
  assert.ok(auth.findSession(phone), "it is still signed in");
});

test("an admin sees when each member last signed in", async () => {
  const id = users.create({ username: "unseen", name: "Una Unseen", passwordHash: await auth.hashPassword("unseen-password") });
  const row = (list, name) => list.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*${name}(?:(?!</tr>)[\\s\\S])*</tr>`))[0];
  assert.match(row(await read("/members", "zan"), "Una Unseen"), /No sign-in on record/);
  sentTo(await post("/login", null, { username: "unseen", password: "unseen-password" }));
  assert.match(row(await read("/members", "zan"), "Una Unseen"), /Last signed in\s*<time datetime="/);
  assert.match(users.byId(id).signed_in_at, /^\d{4}-\d\d-\d\dT/);
});

test("one member cannot hold more than a dozen connections open on conversations", async () => {
  const kai = await newcomer("kai", "Kai Renner");
  const common = rooms.common().id;
  const stops = [];
  const open = async () => {
    const stop = new AbortController();
    stops.push(stop);
    return fetch(`${base}/chat/${common}/stream`, { headers: { Cookie: kai.cookie }, signal: stop.signal });
  };
  try {
    for (let i = 0; i < 12; i++) assert.equal((await open()).status, 200);
    const over = await open();
    assert.equal(over.status, 429);
    await over.text();
    // it is counted by member: someone else is still heard
    const other = new AbortController();
    stops.push(other);
    const theirs = await fetch(`${base}/chat/${common}/stream`, { headers: { Cookie: people.mira.cookie }, signal: other.signal });
    assert.equal(theirs.status, 200);
  } finally {
    for (const stop of stops) stop.abort();
  }
  // and once some are closed there is room again
  const deadline = Date.now() + 3000;
  for (;;) {
    const stop = new AbortController();
    const again = await fetch(`${base}/chat/${common}/stream`, { headers: { Cookie: kai.cookie }, signal: stop.signal });
    stop.abort();
    if (again.status === 200) break;
    assert.ok(Date.now() < deadline, "closed connections are not counted against him for ever");
    await new Promise((done) => setTimeout(done, 50));
  }
});

/* --------------------------------------------------------------- searching */

test("a search finds what the member asking could read anyway, and nothing else", async () => {
  const find = async (q, who = "tomas") => read(`/search?q=${encodeURIComponent(q)}`, who);
  assert.equal(sentTo(await get("/search?q=quince")), "/login?next=%2Fsearch%3Fq%3Dquince");
  // the box to search from is on the page the corpus is kept from; what it finds is any member's to ask for
  assert.match(await read("/", "zan"), /<form class="search" action="\/search" method="get" role="search">/);

  const article = await publish({ title: "On the quince", body: "A hard fruit, and *fragrant*; the medlar is softer. It costs 100% more." });
  const other = await publish({ title: "Orchards", body: "Where the Quince grows beside the pear, and the wall is warm." });
  const draft = Number(sentTo(await post("/write", "zan", { status: "draft", title: "Quince, unfinished", body: "Not yet." })).match(/\d+/)[0]);
  const kept = noteId(sentTo(await post(`/p/${article}/notes`, "mira", { body: "My grandmother made quince paste." })));
  const gone = noteId(sentTo(await post(`/p/${article}/notes`, "mira", { body: "A quince remark I regret." })));
  sentTo(await post(`/notes/${gone}/remove`, "mira"));
  const closed = await startProject("mira", { title: "A private herbal" });
  const hidden = await addPage(closed, "mira", { title: "Quince, medicinal", body: "Kept between us." });
  const open = await startProject("mira", { title: "An open herbal", open: "1" });
  const shown = await addPage(open, "mira", { title: "Pear", body: "Grafted onto quince stock." });

  const found = await find("QUINCE");
  assert.match(found, new RegExp(`<a class="index__title" href="/p/${article}">On the quince</a>`));
  assert.match(found, new RegExp(`href="/p/${other}">Orchards</a>`));
  assert.ok(found.indexOf("On the quince</a>") < found.indexOf("Orchards</a>"), "what is named for it comes first");
  assert.match(found, /Where the <mark class="hit">Quince<\/mark> grows beside the pear/);
  assert.match(found, new RegExp(`href="/p/${article}#note-${kept}"\\s*>Mira Okafor in a margin note on\\s+On the quince</a\\s*>`));
  assert.match(found, /My grandmother made <mark class="hit">quince<\/mark> paste\./);
  assert.match(found, new RegExp(`<a class="index__title" href="/pages/${shown}">Pear</a>`));
  assert.match(found, /In the project <a href="\/projects\/\d+">An open herbal<\/a>/);
  // not the draft, not the note taken back, not the project that is not his
  assert.doesNotMatch(found, /unfinished|I regret|medicinal|private herbal/);
  assert.doesNotMatch(found, new RegExp(`/p/${draft}"`));

  // those working on a project find its pages, and so does an admin; even an admin finds no one's draft
  assert.match(await find("quince", "mira"), new RegExp(`href="/pages/${hidden}">Quince, medicinal</a>`));
  const forAdmin = await find("quince", "zan");
  assert.match(forAdmin, /Quince, medicinal/);
  assert.doesNotMatch(forAdmin, /unfinished/);

  // every word must be there, in any order; the text is searched as it reads, not as it was typed
  assert.match(await find("medlar fruit"), /On the quince/);
  assert.doesNotMatch(await find("medlar orchard"), /On the quince/);
  assert.match(await find("medlar orchard"), /Nothing here has all of those words\./);
  assert.match(await find("fragrant"), /and <mark class="hit">fragrant<\/mark>; the medlar/);
  // what means "anything" to the database means only itself here
  assert.match(await find("100%"), /costs <mark class="hit">100%<\/mark> more/);
  assert.doesNotMatch(await find("10_%"), /On the quince/);
  assert.doesNotMatch(await find("%"), /index__title/);
  assert.match(await find("q"), /Give at least two letters to look for\./);
  assert.doesNotMatch(await find(""), /index__title|Nothing here/);

  // what was asked is shown back as text, and never as markup
  const odd = await find(`"><script>alert(1)</script>`);
  assert.doesNotMatch(odd, /<script>alert/);
  assert.match(odd, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.equal((await get(`/search?q=${"long ".repeat(400)}`, "tomas")).status, 200);
});

/* --------------------------------------------------------------- sub-admins */

/** an admin ticks what a member is to be able to do, as the page for it would send it */
const grant = (who, keys, by = "zan") =>
  post(`/members/${people[who].id}/permissions`, by, keys.map((key) => ["can", key]));

test("an admin makes a member a sub-admin by choosing what they may do, and can take it back", async () => {
  const petra = await newcomer("petra", "Petra Vance");
  const path = `/members/${petra.id}/permissions`;

  // the page that offers it is an admin's; nothing is ticked for a member
  const offered = await read(path, "zan");
  assert.match(offered, /What Petra Vance may do/);
  for (const key of ["write", "edit", "moderate", "members", "projects"])
    assert.match(offered, new RegExp(`<input type="checkbox" name="can" value="${key}"\\s*/>`));
  assert.equal((await get(path, "mira")).status, 403);
  assert.equal((await get(path, "petra")).status, 403);
  assert.match(await read("/members", "zan"), new RegExp(`<a class="link" href="${path}">Make sub-admin</a>`));

  // nobody but an admin gives it, not even to themselves, and not without the page's token
  assert.equal((await grant("petra", ["write"], "mira")).status, 403);
  assert.equal((await grant("petra", ["write", "edit", "moderate", "members", "projects"], "petra")).status, 403);
  assert.equal((await post(path, "zan", { can: "write" }, { csrf: false })).status, 403);
  assert.equal(users.byId(petra.id).permissions, "");

  // what is ticked is what she has; what is not a permission is passed over
  assert.equal(sentTo(await grant("petra", ["moderate", "write", "crown", "admin"])), `/members?changed=${petra.id}`);
  assert.equal(users.byId(petra.id).permissions, "write moderate");
  const list = await read(`/members?changed=${petra.id}`, "zan");
  assert.match(list, /Petra Vance is a sub-admin, and can now: scribe, moderate\./);
  assert.match(list, /Sub-admin\s+<span class="members__can">\s*Scribe · Moderate\s*<\/span>/);
  assert.match(list, new RegExp(`<a class="link" href="${path}">Permissions</a>`));
  assert.match(await read(path, "zan"), /name="can" value="write" checked \/>[\s\S]*name="can" value="edit"\s*\/>[\s\S]*name="can" value="moderate" checked \/>/);

  // it holds from her next page, without signing in again: she has the page the corpus is kept from, and its place in the menu
  const hers = await read("/", "petra");
  assert.match(hers, /<a href="\/" aria-current="page">Scribe<\/a>/);
  assert.match(hers, /<a class="button" href="\/write">New Piece<\/a>/);
  assert.doesNotMatch(hers, /href="\/members"/);
  assert.match(await read("/corpus", "petra"), /<a href="\/"\s*>Scribe<\/a>/);
  assert.match(await read("/m/petra", "tomas"), /<p class="hint">\s*Sub-admin ·/);

  // an admin has no need of it, nobody chooses their own, and there must be someone to give it to
  const hale = await newcomer("hale", "Hale Whitlow", "admin");
  assert.equal((await grant("hale", ["write"])).status, 400);
  assert.equal((await get(`/members/${hale.id}/permissions`, "zan")).status, 400);
  assert.equal((await grant("zan", ["write"])).status, 400);
  assert.equal((await post("/members/999999/permissions", "zan", { can: "write" })).status, 404);
  assert.equal(users.byId(hale.id).permissions, "");
  // one admin's sub-admin is every admin's to change
  sentTo(await grant("petra", ["edit"], "hale"));
  assert.equal(users.byId(petra.id).permissions, "edit");

  // with nothing ticked she is a member again, and her menu is a member's
  assert.equal(sentTo(await grant("petra", [])), `/members?changed=${petra.id}`);
  assert.equal(users.byId(petra.id).permissions, "");
  assert.match(await read(`/members?changed=${petra.id}`, "zan"), /Petra Vance is a member, with nothing more than any member can do\./);
  assert.equal(sentTo(await get("/", "petra")), "/corpus");
  assert.doesNotMatch(await read("/corpus", "petra"), />Scribe</);
});

test("a sub-admin can do what they were given, and nothing else that an admin can", async () => {
  await newcomer("wren", "Wren Abara");
  const article = await publish({ title: "Kept by the keeper", body: "As the main admin wrote it." });
  const draft = Number(sentTo(await post("/write", "zan", { status: "draft", title: "Not yet for reading", body: "Unfinished." })).match(/\d+/)[0]);
  const note = () => post(`/p/${article}/notes`, "mira", { body: "A note that may have to go." }).then((sent) => noteId(sentTo(sent)));
  const common = rooms.common().id;
  const project = await startProject("mira", { title: "Behind a closed door" });
  const hidden = await addPage(project, "mira", { title: "Wormwood", body: "Bitter, and kept between us." });
  const room = Number(sentTo(await get(`/projects/${project}/talk`, "mira")).match(/^\/chat\/(\d+)$/)[1]);

  /** what she can do just now, each named for the permission that would allow it */
  async function reach() {
    const noted = await note();
    const said = await sayIn(common, "tomas", "Something said in the common room.");
    return {
      // to answer a piece with a commentary is for those who publish what they write
      write: (await get(`/write?on=${article}`, "wren")).status === 200,
      edit:
        (await get(`/p/${draft}`, "wren")).status === 200 &&
        (await get(`/p/${article}/edit`, "wren")).status === 200 &&
        /Not yet for reading/.test(await read("/", "wren")),
      moderate:
        (await post(`/notes/${noted}/remove`, "wren")).status === 303 &&
        (await post(`/chat/${common}/m/${said}/remove`, "wren")).status === 303,
      members: (await get("/members", "wren")).status === 200,
      projects:
        (await get(`/projects/${project}`, "wren")).status === 200 &&
        (await get(`/chat/${room}`, "wren")).status === 200 &&
        (await get(`/projects/${project}/settings`, "wren")).status === 200 &&
        /Behind a closed door/.test(await read("/projects", "wren")) &&
        /Wormwood/.test(await read("/search?q=wormwood", "wren")),
    };
  }
  const none = { write: false, edit: false, moderate: false, members: false, projects: false };

  assert.deepEqual(await reach(), none, "a member has none of it");
  for (const key of Object.keys(none)) {
    sentTo(await grant("wren", [key]));
    assert.deepEqual(await reach(), { ...none, [key]: true }, `given "${key}", that and nothing else`);
  }
  sentTo(await grant("wren", ["edit", "projects"]));
  assert.deepEqual(await reach(), { ...none, edit: true, projects: true }, "any of them can be given together");

  // editing the journal is changing it: what she saves is kept as a version like anyone's
  assert.equal(sentTo(await revise(article, { title: "Kept by the keeper", body: "As the main admin wrote it, and Wren mended it." }, "wren")), `/p/${article}`);
  assert.equal(posts.byId(article).body, "As the main admin wrote it, and Wren mended it.");
  assert.match(await read(`/projects/${project}`, "wren"), /as a sub-admin who oversees the projects you can do what its owner can/);
  assert.equal(hidden > 0 && (await get(`/pages/${hidden}`, "wren")).status, 200);

  // what stays with the admins whatever she is given
  sentTo(await grant("wren", ["write", "edit", "moderate", "members", "projects"]));
  assert.equal((await get(`/members/${people.mira.id}/permissions`, "wren")).status, 403);
  assert.equal((await grant("mira", ["write"], "wren")).status, 403);
  assert.equal((await grant("wren", [], "wren")).status, 403);
  assert.equal((await post(`/members/${people.wren.id}/main`, "zan")).status, 400, "a sub-admin is not an admin, and cannot be the main one");
  assert.equal((await post(`/members/${people.zan.id}/main`, "wren")).status, 403);
  assert.equal(users.byId(people.mira.id).permissions, "");
  // and a private conversation is no more hers than it is an admin's
  const between = await conversation("mira", "tomas");
  assert.equal((await get(`/chat/${between}`, "wren")).status, 404);

  sentTo(await grant("wren", []));
  assert.deepEqual(await reach(), none, "taken back, it is gone at once");
});

test("a sub-admin who manages the members reaches members, and no admin or other sub-admin", async () => {
  await newcomer("odile", "Odile Marsh");
  const basil = await newcomer("basil", "Basil Crane");
  const cato = await newcomer("cato", "Cato Finch");
  const hale = people.hale ?? (await newcomer("hale", "Hale Whitlow", "admin"));
  sentTo(await grant("odile", ["members"]));
  sentTo(await grant("basil", ["moderate"]));

  // the list is hers to read, with what she can do in it and nothing she cannot
  const list = await read("/members", "odile");
  assert.match(list, new RegExp(`action="/members/${cato.id}/password"`));
  assert.match(list, new RegExp(`action="/members/${cato.id}/remove"`));
  assert.doesNotMatch(list, new RegExp(`action="/members/(${basil.id}|${hale.id}|${people.zan.id})/`));
  assert.doesNotMatch(list, /\/permissions"|Make sub-admin|Make main admin/);
  // she has the page the corpus is kept from, for the way to the members; she publishes nothing from it
  const kept = await read("/", "odile");
  assert.match(kept, /<p class="views">\s*<a href="\/members">Members<\/a>\s*<\/p>/);
  assert.doesNotMatch(kept, /href="\/write"/);

  // nobody is added from the list, by her or by anyone
  assert.equal((await post("/members", "odile", { name: "Runa Vale", username: "runa", can: "members", role: "admin" })).status, 405);
  assert.equal(users.byUsername("runa"), undefined);

  // a member's password is hers to issue, and a member hers to remove and restore
  const issued = await post(`/members/${cato.id}/password`, "odile");
  assert.equal(issued.status, 200);
  assert.match(await issued.text(), /<dd><code>cato<\/code><\/dd>/);
  assert.equal(sentTo(await get("/", "cato")), "/login", "he is signed out with his old password");
  sentTo(await post(`/members/${cato.id}/remove`, "odile"));
  assert.equal(users.byId(cato.id).active, 0);
  sentTo(await post(`/members/${cato.id}/restore`, "odile"));
  assert.equal(users.byId(cato.id).active, 1);

  // an admin's password would be the admin's place, and another sub-admin's would be theirs
  const before = (id) => users.byId(id).password_hash;
  for (const target of [hale, basil, people.zan]) {
    const hash = before(target.id);
    assert.equal((await post(`/members/${target.id}/password`, "odile")).status, 403);
    assert.equal((await post(`/members/${target.id}/remove`, "odile")).status, 403);
    assert.equal(before(target.id), hash);
    assert.equal(users.byId(target.id).active, 1);
  }
  assert.equal((await post(`/members/${people.odile.id}/password`, "odile")).status, 400, "her own is changed from her account");
  assert.equal((await post(`/members/${cato.id}/password`, "odile", {}, { csrf: false })).status, 403);
  assert.equal((await post(`/members/${cato.id}/password`, "basil")).status, 403, "moderating is not managing the members");

  // an admin still reaches a sub-admin; removed, a sub-admin is one no longer, and comes back as a member
  assert.equal((await post(`/members/${basil.id}/password`, "zan")).status, 200);
  sentTo(await post(`/members/${basil.id}/remove`, "zan"));
  assert.equal(users.byId(basil.id).permissions, "");
  assert.equal((await grant("basil", ["moderate"])).status, 400, "nothing is given to someone who has been removed");
  sentTo(await post(`/members/${basil.id}/restore`, "odile"));
  assert.equal(users.byId(basil.id).active, 1);
  assert.equal(users.byId(basil.id).permissions, "");
  assert.match(await read("/members", "zan"), new RegExp(`href="/members/${basil.id}/permissions">Make sub-admin</a>`));
});

/* ------------------------------------------------- what the corpus says of a piece */

test("those who edit say what the corpus says of a piece: its claims or annotation, its colour, the letter after its title", async () => {
  const essay = await publish({
    title: "For those to come",
    body: "The essay everything is drawn about.",
    annotation: "- Vitality can be *seen*\n  - and so it can be shown\n- What is shown can be handed on",
  });
  assert.equal(sentTo(await post(`/p/${essay}/centre`, "zan")), `/p/${essay}`);
  const light = await publish({ title: "A priestess", body: "Written in the lighter green.", tone: "light" });
  const graft = await publish({ title: "Grafted on an older stock", body: "Half theirs, half ours.", tone: "graft", hand: "c", missionaria: "1" });
  const plain = await publish({ title: "An ordinary leaf", body: "Dark green, like most.", tone: "neon" });
  assert.deepEqual([posts.byId(light).tone, posts.byId(graft).tone, posts.byId(plain).tone], ["light", "graft", ""]);
  assert.deepEqual([posts.byId(graft).hand, posts.byId(graft).missionaria, posts.byId(plain).missionaria], ["c", 1, 0]);
  // of a work, what is said of it on the corpus is its annotations, which are the whole of its text
  const passage = await addWork({
    title: "The Gay Science",
    creator: "Friedrich Nietzsche",
    medium: "Passage",
    body: "Strong on what health looks like; weak on how it is kept.",
    show_tell: "1",
  });
  const book = await addWork({ title: "On the Genealogy of Morals", creator: "Friedrich Nietzsche" });
  assert.deepEqual([posts.byId(passage).show_tell, posts.byId(book).show_tell], [1, 0]);

  // the form that says it is the one the piece was written or added with, for those who edit: set on the page itself, with nothing round it
  const editing = await read(`/p/${graft}/edit`, "zan");
  assert.match(editing, /<div class="curation">/);
  assert.doesNotMatch(editing, /<fieldset class="curation">|<legend>On the corpus<\/legend>|class="grant__says"|class="hint"/);
  assert.match(editing, /<option value="graft" selected>Brown into green<\/option>/);
  assert.match(editing, /<label for="hand">Superscript<\/label>\s*<input id="hand" name="hand" value="c" maxlength="2"/);
  assert.match(editing, /<input type="checkbox" name="show_tell" value="1"\s*\/> <span>Show and Tell<\/span>/);
  assert.match(editing, /<input type="checkbox" name="missionaria" value="1" checked \/> <span>Missionaria<\/span>/);
  assert.match(editing, /<label for="annotation">Annotation<\/label>/);
  assert.match(await read(`/p/${essay}/edit`, "zan"), /<label for="annotation">Claims<\/label>/, "of the essay at the centre it is its claims");
  const working = await read(`/p/${passage}/edit`, "zan");
  assert.match(working, /<input type="checkbox" name="show_tell" value="1" checked \/> <span>Show and Tell<\/span>/);
  assert.match(working, /<label for="body">Annotations<\/label>\s*<textarea id="body" name="body" rows="7" maxlength="20000" data-suggest="people articles">Strong on what health looks like; weak on how it is kept\.<\/textarea>/);
  assert.doesNotMatch(working, /name="tone"|name="hand"|name="annotation"|class="grant__says"|Writing that both shows and tells/);

  // a letter is a letter or two, and what is said is kept short; nothing is saved of a form that is refused
  for (const [fields, said] of [
    [{ hand: "<b" }, /The superscript is one letter, or two/],
    [{ hand: "abc" }, /The superscript is one letter, or two/],
    [{ annotation: "x".repeat(3001) }, /under 3000 characters/],
  ]) {
    const refused = await revise(plain, { title: "An ordinary leaf", body: "Dark green, like most.", ...fields });
    assert.equal(refused.status, 422);
    assert.match(await refused.text(), said);
  }
  assert.deepEqual([posts.byId(plain).hand, posts.byId(plain).annotation], [null, null]);

  // it is not for those who publish without editing: what they send of it is passed over, and what was said stays
  await publishing("mira", async () => {
    const hers = await publish({ title: "Hers, and unadorned", body: "By Mira.", tone: "light", hand: "b", annotation: "Mine to say?", missionaria: "1" }, "mira");
    const kept = posts.byId(hers);
    assert.deepEqual([kept.tone, kept.hand, kept.annotation, kept.missionaria], ["", null, null, 0]);
    assert.doesNotMatch(await read(`/p/${hers}/edit`, "mira"), /class="curation"|name="hand"|name="missionaria"|name="show_tell"/);
    sentTo(await revise(hers, { title: "Hers, and unadorned", body: "By Mira, reworded." }, "mira"));
    sentTo(await revise(hers, { title: "Hers, and unadorned", body: "By Mira, reworded.", tone: "graft" }, "zan"));
    sentTo(await revise(hers, { title: "Hers, and unadorned", body: "By Mira, reworded again.", tone: "light" }, "mira"));
    assert.equal(posts.byId(hers).tone, "graft");
  });

  // on the corpus: what is written here is green, lighter where it was said to be, and brown running into green for a graft
  const corpus = await read("/corpus", "mira");
  const drawn = (id) => corpus.match(new RegExp(`<a\\s+class="([^"]+)"\\s+href="/p/${id}"[\\s\\S]*?</a>`))?.[0] ?? "";
  assert.match(drawn(plain), /class="node node--article node--leaf"/);
  assert.match(drawn(light), /class="node node--article node--leaf node--light"/);
  assert.match(drawn(graft), /class="node node--article node--leaf node--graft"/);
  // a title too long for one line is set on two, about the place it stands at; the letter follows its last word, raised
  assert.match(drawn(graft), /<text[^>]*fill="url\(#graft\)"[^>]*><tspan class="node__title"[^>]*>Grafted on an<\/tspan><tspan class="node__title" x="0" dy="[\d.]+"[^>]*>older stock<\/tspan><tspan class="node__hand"[^>]*>c<\/tspan><\/text>/);
  assert.doesNotMatch(drawn(light), /url\(#graft\)|node__hand/);
  assert.match(corpus, /<linearGradient id="graft"/);
  assert.match(corpus, /<filter id="glow"/);
  // a work is bark, with a glow, and says under its title what kind of thing it is
  assert.match(drawn(passage), /class="node node--work node--bark node--bark-\d"/);
  assert.match(drawn(passage), /<text[^>]*filter="url\(#glow\)"[^>]*><tspan class="node__title"[^>]*>The Gay Science<\/tspan><tspan class="node__extent" x="0" dy="[\d.]+"[^>]*>Passage<\/tspan><tspan class="node__fold"[^>]*>▾<\/tspan><\/text>/);
  assert.match(drawn(book), /<tspan class="node__extent" x="0" dy="[\d.]+"[^>]*>Book \(whole\)<\/tspan><\/text>/, "one with nothing said of it has nothing to open");

  // what is said of a piece is not shown until its title is chosen: it is kept beside the drawing for then, with no heading of its own
  assert.match(corpus, new RegExp(`<template data-graph-note="p${passage}">\\s*<div class="prose annotation__text">[\\s\\S]*?Strong on what health looks like; weak on how it is kept\\.[\\s\\S]*?</template>`));
  assert.doesNotMatch(corpus, /graph__card-label/);
  const [, claims] = corpus.match(new RegExp(`<template data-graph-note="p${essay}">([\\s\\S]*?)</template>`));
  assert.match(claims, /<ul>\s*<li>\s*(<p>)?Vitality can be <em>seen<\/em>[\s\S]*?<ul>\s*<li>\s*(<p>)?and so it can be shown[\s\S]*?<\/ul>[\s\S]*?<li>\s*(<p>)?What is shown can be handed on/);
  assert.doesNotMatch(corpus, new RegExp(`data-graph-note="p(${book}|${plain})"`));
  // on the page of a piece written here it is folded away under its name; a work's page is what is said of it, set out under its title
  assert.match(await read(`/p/${essay}`, "mira"), /<details class="fold annotation">\s*<summary>Claims<\/summary>\s*<div class="prose annotation__text"><ul>/);
  assert.match(await read(`/p/${passage}`, "mira"), /<p class="work__by">Friedrich Nietzsche · Passage<\/p>\s*<\/header>\s*<div class="prose">[\s\S]*?Strong on what health looks like/);
  assert.doesNotMatch(await read(`/p/${passage}`, "mira"), /class="fold annotation"/);

  // a piece that shows and tells is no different until that is asked for, when a star is set before its title
  assert.doesNotMatch(corpus, /node__star|is-marked|graph--marked/);
  assert.match(corpus, /<a href="\/corpus\?mark=show-tell">✧ Show and Tell<\/a>/);
  const marked = await read("/corpus?mark=show-tell", "mira");
  assert.match(marked, /class="graph graph--marked graph--whole"/);
  assert.match(marked, new RegExp(`class="node node--work node--bark node--bark-\\d is-marked"\\s+href="/p/${passage}"[\\s\\S]*?<tspan class="node__star"[^>]*>✧</tspan><tspan class="node__title"[^>]*>The Gay Science</tspan>`));
  assert.equal(marked.match(/class="node__star"/g).length, 1);
  assert.match(marked, /<strong>✧ Show and Tell<\/strong>/);
  assert.match(await read("/corpus?mark=show-tell&layer=antecedents", "mira"), /<strong>Antecedents<\/strong>[\s\S]*<strong>✧ Show and Tell<\/strong>/, "with either layer");

  // those who edit go from a piece on the corpus back to the form it was written or added with; nobody else is offered it
  assert.doesNotMatch(corpus, /data-edit=/);
  const keepers = await read("/corpus", "zan");
  for (const id of [essay, graft, passage, book]) assert.match(keepers, new RegExp(`href="/p/${id}"[^>]*data-edit="/p/${id}/edit"`));
  assert.doesNotMatch(keepers, /href="\/m\/[^"]+"[^>]*data-edit/);

  // that a piece is for the wider public is said to those who keep the corpus, and to no one else yet
  assert.match(await read(`/p/${graft}`, "zan"), /<span class="tag tag--quiet">Missionaria<\/span>/);
  assert.doesNotMatch(await read(`/p/${graft}`, "mira"), /Missionaria/);
  assert.match(await read("/", "zan"), new RegExp(`href="/p/${graft}">Grafted on an older stock<sup class="hand">c</sup></a>`));

  // deleted from the form, a piece is gone from the corpus
  assert.equal(sentTo(await post(`/p/${plain}/delete`, "zan")), "/");
  assert.doesNotMatch(await read("/corpus", "mira"), /An ordinary leaf/);
});

/* --------------------------------------------- what is put away unless it is asked for */

/** a second forum on the same database, as it runs when nothing is asked of it but the forum itself */
async function plainForum(work) {
  const port = await freePort();
  const forum = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: scratch, PUBLIC_URL: "", LATEX: "off", PACE: "off", MESSAGES: "", PROJECTS: "", NOTIFICATIONS: "", VERSIONS: "", INVITATIONS: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((ready, fail) => {
      forum.once("error", fail);
      forum.once("exit", (code) => fail(new Error(`the second server stopped early (${code})`)));
      forum.stdout.on("data", (chunk) => String(chunk).includes("listening") && ready());
    });
    const at = `http://127.0.0.1:${port}`;
    await work({
      get: (path, who) => fetch(at + path, { redirect: "manual", headers: who ? { Cookie: people[who].cookie } : {} }),
      post(path, who, fields = {}) {
        const body = new URLSearchParams(fields);
        body.set("_csrf", people[who].csrf);
        return fetch(at + path, { method: "POST", redirect: "manual", headers: { Origin: at, Cookie: people[who].cookie }, body });
      },
    });
  } finally {
    forum.removeAllListeners("exit");
    const gone = new Promise((done) => forum.once("exit", done));
    forum.kill();
    await gone;
  }
}

test("unless they are asked for there are no messages, no projects and no notifications, and nothing leads to them", async () => {
  const project = await startProject("mira", { title: "Put away with the rest", open: "1" });
  const page = await addPage(project, "mira", { title: "Sorrel", body: "A page about sorrel, put away." });
  const article = await publish({ title: "Sorrel soup", body: "Still here to be found, with a word for @tomas." });
  const phone = await subscribe("tomas", "/send/tomas-put-away");
  const common = rooms.common().id;

  await plainForum(async (plain) => {
    const text = async (path, who) => (await plain.get(path, who)).text();
    // the pages are not there, for a member or an admin, to read or to send to
    for (const who of ["mira", "zan"]) {
      for (const path of ["/chat", `/chat/${common}`, "/chat?part=1", "/projects", `/projects/${project}`, `/pages/${page}`, "/projects/new", "/account/push"])
        assert.equal((await plain.get(path, who)).status, 404, `${path} for ${who}`);
      assert.equal((await plain.post(`/chat/${common}`, who, { body: "Is anyone there?" })).status, 404);
      assert.equal((await plain.post("/projects", who, { title: "A new one" })).status, 404);
      assert.equal((await plain.post("/account/notify", who, { about: "tags" })).status, 404);
    }
    const before = subscriptions.of(people.mira.id).length;
    const device1 = device();
    assert.equal((await plain.post("/account/push", "mira", { endpoint: `${pushBase}/send/x`, p256dh: device1.p256dh, auth: device1.auth })).status, 404);
    assert.equal(subscriptions.of(people.mira.id).length, before, "no device is taken on");

    // and no page leads to them: not the menu, not the script, not the first page, not a member's
    for (const [path, who] of [["/corpus", "mira"], ["/account", "mira"], ["/m/tomas", "mira"], ["/", "zan"], ["/members", "zan"], [`/p/${article}`, "mira"]]) {
      const html = await text(path, who);
      assert.doesNotMatch(html, /href="\/chat|action="\/chat|data-messages|static\/chat\.js|static\/notify\.js|href="\/projects|class="shelf"|unread message/, path);
      assert.match(html, /data-pushed="0"/, path);
    }
    // a search finds what is written here, and not the pages of a project
    const found = await text("/search?q=sorrel", "mira");
    assert.match(found, new RegExp(`href="/p/${article}"`));
    assert.doesNotMatch(found, /Put away with the rest|\/pages\//);

    // what a device had asked to be told of it is not told: here a tag in a note, which was sent as it was made
    const from = pushed.length;
    assert.equal((await plain.post(`/p/${article}/notes`, "mira", { body: "A word for @tomas while it is quiet." })).status, 303);
    await pause(250);
    assert.equal(toldTo("/send/tomas-put-away", phone, from).length, 0);

    // the rest of the forum is as it is with them
    assert.equal((await plain.get("/corpus", "mira")).status, 200);
    assert.equal((await plain.get("/submit", "zan")).status, 200);

    // the earlier wordings of a piece are kept, and are not shown: their pages are not there, and nothing leads to them
    for (const path of [`/p/${article}/history`, `/p/${article}/v/1`, `/p/${article}/changes`])
      assert.equal((await plain.get(path, "zan")).status, 404, path);
    assert.equal((await plain.post(`/p/${article}/restore`, "zan", { n: "1" })).status, 404);
    assert.equal((await plain.post(`/p/${article}/edit`, "zan", { title: "Sorrel soup", body: "Still here to be found, with a word for @tomas. And a second wording.", status: "published", summary: "Said more" })).status, 303);
    assert.equal(revisions.list(article).length, 2, "the wording it had is still kept");
    assert.doesNotMatch(await text(`/p/${article}`, "zan"), /\/history|Version 2|revised/);
    assert.doesNotMatch(await text(`/p/${article}/edit`, "zan"), /name="summary"|What changed/);

    // and so is the list of those who are to be invited: to an admin too it is not there
    for (const path of ["/invitations", "/invitations/1"]) assert.equal((await plain.get(path, "zan")).status, 404, path);
    assert.equal((await plain.post("/invitations", "zan", { name: "Someone New" })).status, 404);
    for (const path of ["/", "/members"]) assert.doesNotMatch(await text(path, "zan"), /href="\/invitations"/, path);
    assert.equal((await plain.get(`/p/${article}`, "tomas")).status, 200);
  });

  // nothing was lost by it: with them asked for again, what was written is where it was
  assert.equal((await get(`/pages/${page}`, "mira")).status, 200);
  assert.match(await read("/chat", "mira"), /Everyone/);
});
