/*
 * The forum end to end: a real server on a spare port with a scratch database,
 * driven over HTTP the way a browser would. This is where the rules about who
 * may do what are checked.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-test-"));
process.env.DATA_DIR = scratch;

const auth = await import("../src/auth.mjs");
const { db, media, notes, posts, revisions, users } = await import("../src/db.mjs");
const { pages, pageVersions, projects, proposals } = await import("../src/projects.mjs");
const { messages, rooms } = await import("../src/chat.mjs");

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

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_ROOT,
    // LaTeX is switched off here, so that these tests say the same on every machine; test/tex.test.mjs draws
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: scratch, PUBLIC_URL: "", LATEX: "off" },
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

async function publish(fields, who = "zan") {
  const response = await post("/write", who, { status: "published", ...fields });
  return Number(sentTo(response).match(/^\/p\/(\d+)$/)[1]);
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

  for (const who of ["zan", "mira", "tomas"]) {
    const journal = await (await get("/", who)).text();
    assert.match(journal, /On reading slowly/, `${who} sees it in the journal`);
    const page = await get(`/p/${id}`, who);
    assert.equal(page.status, 200);
    // the opening capital is set apart as a drop capital, so match what follows it
    assert.match(await page.text(), /ood things take a second reading\./);
  }
});

test("only an admin can write, edit or delete a post", async () => {
  const id = await publish({ title: "The admin's own", body: "Written by an admin." });
  const before = posts.publishedCount();

  assert.equal((await get("/write", "mira")).status, 403);
  assert.equal((await get(`/p/${id}/edit`, "mira")).status, 403);
  assert.equal((await post("/write", "mira", { title: "Mine", body: "By a member.", status: "published" })).status, 403);
  assert.equal((await post(`/p/${id}/edit`, "mira", { title: "Mine now", body: "Rewritten." })).status, 403);
  assert.equal((await post(`/p/${id}/delete`, "mira")).status, 403);

  assert.equal(posts.publishedCount(), before, "nothing was added or taken away");
  assert.equal(posts.byId(id).title, "The admin's own");
  assert.equal(posts.byId(id).body, "Written by an admin.");

  // and a member is not offered what they cannot do
  const asMember = await (await get(`/p/${id}`, "mira")).text();
  assert.doesNotMatch(asMember, /href="\/write"|\/edit"|\/delete"/);
  const asAdmin = await (await get(`/p/${id}`, "zan")).text();
  assert.match(asAdmin, /href="\/write"/);
  assert.match(asAdmin, new RegExp(`/p/${id}/edit"`));

  assert.equal(sentTo(await post(`/p/${id}/edit`, "zan", { title: "Revised", body: "Second thoughts." })), `/p/${id}`);
  assert.equal(posts.byId(id).title, "Revised");
  assert.equal(sentTo(await post(`/p/${id}/delete`, "zan")), "/");
  assert.equal((await get(`/p/${id}`, "zan")).status, 404);
});

test("the members' list is for admins alone", async () => {
  assert.equal((await get("/members", "mira")).status, 403);
  assert.equal((await post("/members", "mira", { name: "A Friend", username: "friend" })).status, 403);
  assert.equal(users.byUsername("friend"), undefined);
  assert.equal((await post(`/members/${people.tomas.id}/remove`, "mira")).status, 403);
  assert.equal((await get("/", "tomas")).status, 200, "tomas is still a member");

  assert.equal((await get("/members", "zan")).status, 200);
  assert.doesNotMatch(await (await get("/", "mira")).text(), /href="\/members"/);
});

test("a draft is seen by admins only", async () => {
  const id = await publish({ title: "Not ready yet", body: "Half a thought.", status: "draft" });

  assert.equal((await get(`/p/${id}`, "zan")).status, 200);
  assert.match(await (await get("/", "zan")).text(), /Not ready yet/);

  assert.equal((await get(`/p/${id}`, "mira")).status, 404);
  assert.doesNotMatch(await (await get("/", "mira")).text(), /Not ready yet/);
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
  assert.match(await (await get("/", "zan")).text(), /1 margin note · 2 replies/);
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

test("any member can answer a post with a commentary; only admins start a new one", async () => {
  const id = await publish({ title: "A piece worth answering", body: "Say what you think." });
  const draft = await publish({ title: "Still being written", body: "Soon.", status: "draft" });

  // a member has no page for a new post, but has one for a commentary
  assert.equal((await get("/write", "mira")).status, 403);
  const blank = await get(`/write?on=${id}`, "mira");
  assert.equal(blank.status, 200);
  assert.match(await blank.text(), /Write a commentary[\s\S]*A piece worth answering/);

  // only what is published and still there can be answered
  for (const on of [String(draft), "999999", "nonsense"]) {
    assert.equal((await get(`/write?on=${on}`, "mira")).status, 404);
    assert.equal((await post("/write", "mira", { on, title: "Nope", body: "No." })).status, 404);
  }

  const answer = await publish({ on: String(id), title: "An answer at length", body: "Here is what I think." }, "mira");
  assert.equal(posts.byId(answer).parent_id, id);
  assert.equal(posts.byId(answer).author_id, people.mira.id);

  // it is an article of its own, shown with what it answers, and listed under that
  assert.match(await read(`/p/${answer}`, "tomas"), new RegExp(`A commentary on\\s+<a href="/p/${id}">A piece worth answering</a>`));
  assert.match(await read("/", "tomas"), /An answer at length/);
  const parent = await read(`/p/${id}`, "tomas");
  assert.match(parent, new RegExp(`id="commentaries"[\\s\\S]*href="/p/${answer}">An answer at length</a>`));
  assert.match(parent, new RegExp(`href="/write\\?on=${id}"`));
  assert.match(await read("/", "tomas"), /1 commentary/);

  // its author and the admins may change it; no one else
  assert.match(await read(`/p/${answer}`, "mira"), new RegExp(`/p/${answer}/edit"`));
  assert.doesNotMatch(await read(`/p/${answer}`, "tomas"), /\/edit"/);
  assert.equal((await get(`/p/${answer}/edit`, "tomas")).status, 403);
  assert.equal((await post(`/p/${answer}/edit`, "tomas", { title: "Defaced", body: "Ha." })).status, 403);
  assert.equal((await post(`/p/${answer}/delete`, "tomas")).status, 403);
  assert.equal(sentTo(await post(`/p/${answer}/edit`, "mira", { title: "An answer, revised", body: "On reflection." })), `/p/${answer}`);
  assert.equal(sentTo(await post(`/p/${answer}/edit`, "zan", { title: "An answer, corrected", body: "On reflection." })), `/p/${answer}`);
  assert.equal(posts.byId(answer).title, "An answer, corrected");
  assert.equal(posts.byId(answer).parent_id, id, "editing does not detach it");

  // a member's own post is still no licence to start one that answers nothing
  assert.equal((await post("/write", "mira", { title: "Mine alone", body: "Standing by itself." })).status, 403);
});

test("a draft commentary is seen by its author and the admins", async () => {
  const id = await publish({ title: "Open to answers", body: "Go on." });
  const draft = await publish({ on: String(id), title: "Half an answer", body: "Not yet.", status: "draft" }, "mira");

  assert.equal((await get(`/p/${draft}`, "mira")).status, 200);
  assert.equal((await get(`/p/${draft}`, "zan")).status, 200);
  assert.equal((await get(`/p/${draft}`, "tomas")).status, 404);
  assert.equal((await get(`/p/${draft}/edit`, "tomas")).status, 404);

  assert.match(await read("/", "mira"), /Half an answer/);
  assert.match(await read("/", "zan"), /Half an answer/);
  assert.doesNotMatch(await read("/", "tomas"), /Half an answer/);
  assert.doesNotMatch(await read(`/p/${id}`, "tomas"), /Half an answer/);

  // published, everyone has it; deleted by its author, they are sent back to what it answered
  await post(`/p/${draft}/edit`, "mira", { title: "A whole answer", body: "Now." });
  assert.match(await read(`/p/${id}`, "tomas"), /A whole answer/);
  assert.equal(sentTo(await post(`/p/${draft}/delete`, "mira")), `/p/${id}#commentaries`);
  assert.equal((await get(`/p/${draft}`, "mira")).status, 404);
});

test("a commentary outlives the post it answered", async () => {
  const id = await publish({ title: "Soon to be withdrawn", body: "Briefly here." });
  const answer = await publish({ on: String(id), title: "An answer left standing", body: "Still here." }, "tomas");

  assert.equal(sentTo(await post(`/p/${id}/delete`, "zan")), "/");
  const page = await get(`/p/${answer}`, "mira");
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /A commentary on/);
  assert.equal(posts.byId(answer).parent_id, null);
});

test("members tag one another with @name, and the one tagged is told", async () => {
  const id = await publish({ title: "Something to point at", body: "Look here." });
  const path = `/p/${id}/notes`;
  const badge = /class="badge"[^>]*>(\d+)</;
  await get("/account", "mira"); // whatever came before has been seen

  const note = noteId(sentTo(await post(path, "tomas", { body: "@mira, you will want to see this. So will @tomas and @nobody." })));
  const page = await read(`/p/${id}`, "zan");
  assert.match(page, /<a class="mention" href="\/m\/mira">@Mira Okafor<\/a>, you will want/);
  assert.match(page, /and @nobody\./, "a name no member has stays as it was typed");

  // the count beside her name, the list on her account page, and then the count is gone
  assert.equal((await read("/", "mira")).match(badge)?.[1], "1");
  const account = await read("/account", "mira");
  assert.match(account, new RegExp(`href="/p/${id}#note-${note}">Tomás Lindqvist tagged you in a margin note on Something to point at</a>`));
  assert.match(account, /tag--new/);
  assert.doesNotMatch(await read("/", "mira"), badge);
  assert.doesNotMatch(await read("/account", "mira"), /tag--new/, "seen once, it is no longer new");

  // tagging yourself tells no one
  assert.doesNotMatch(await read("/", "tomas"), badge);
  assert.doesNotMatch(await read("/account", "tomas"), /Something to point at/);

  // a reply tags too; a removed note no longer does
  const reply = noteId(sentTo(await post(path, "zan", { body: "And @Mira again.", parent: String(note) })));
  assert.equal((await read("/", "mira")).match(badge)?.[1], "1");
  await post(`/notes/${reply}/remove`, "zan");
  assert.doesNotMatch(await read("/", "mira"), badge);
  assert.doesNotMatch(await read("/account", "mira"), /in a reply on Something to point at/);
});

test("a post tags the members it names once it is published", async () => {
  await get("/account", "tomas");
  const badge = /class="badge"/;
  const id = await publish({ title: "With thanks", body: "This began with something @tomas said.", status: "draft" });
  assert.doesNotMatch(await read("/", "tomas"), badge, "a draft tags no one");

  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something @tomas said." });
  assert.match(await read("/", "tomas"), badge);
  assert.match(await read(`/p/${id}`, "mira"), /<a class="mention" href="\/m\/tomas">@Tomás Lindqvist<\/a>/);
  assert.match(await read("/account", "tomas"), new RegExp(`href="/p/${id}">Zan Huang tagged you in With thanks</a>`));

  // saving it again does not tag him a second time; taking his name out withdraws the tag
  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something @tomas said. Revised." });
  assert.doesNotMatch(await read("/", "tomas"), badge);
  await post(`/p/${id}/edit`, "zan", { title: "With thanks", body: "This began with something somebody said." });
  assert.doesNotMatch(await read("/account", "tomas"), /With thanks/);
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

test("the graph draws what is published and who has had a hand in it", async () => {
  const article = await publish({ title: "A node in the graph", body: "At the centre." });
  const answer = await publish({ on: String(article), title: "A node beside it", body: "See [[A node in the graph]]." }, "mira");
  await post(`/p/${article}/notes`, "tomas", { body: "Noted." });
  const hidden = await publish({ title: "Not on the graph", body: "A draft.", status: "draft" });

  assert.equal(sentTo(await get("/graph")), "/login?next=%2Fgraph");
  const response = await get("/graph", "tomas");
  assert.equal(response.status, 200);
  const page = await response.text();
  const has = (pattern) => assert.match(page, pattern);

  // zan is the main admin, so what zan wrote is of the canon; that is tested further down
  has(new RegExp(`class="node node--article node--canon"\\s+href="/p/${article}"\\s+data-id="p${article}"`));
  has(new RegExp(`class="node node--commentary"\\s+href="/p/${answer}"`));
  has(new RegExp(`class="node node--person"\\s+href="/m/tomas"\\s+data-id="u${people.tomas.id}"`));
  has(new RegExp(`class="edge edge--commentary"\\s+data-from="p${answer}"\\s+data-to="p${article}"`));
  has(new RegExp(`class="edge edge--link"\\s+data-from="p${answer}"\\s+data-to="p${article}"`));
  has(new RegExp(`class="edge edge--wrote"\\s+data-from="u${people.mira.id}"\\s+data-to="p${answer}"`));
  has(new RegExp(`class="edge edge--note"\\s+data-from="u${people.tomas.id}"\\s+data-to="p${article}"`));
  assert.doesNotMatch(page, new RegExp(`data-id="p${hidden}"`), "drafts are not drawn");
  assert.doesNotMatch(page, /Not on the graph/);

  const writing = await read("/graph?show=articles", "tomas");
  assert.match(writing, new RegExp(`data-id="p${article}"`));
  assert.doesNotMatch(writing, /node--person|edge--wrote|edge--note/);
});

test("each member has a page of what they have written", async () => {
  const id = await publish({ title: "Something Mira answered", body: "An opening." });
  await publish({ on: String(id), title: "A reply at length from Mira", body: "At length." }, "mira");
  await post(`/p/${id}/notes`, "mira", { body: "And a note in the margin as well." });

  assert.equal(sentTo(await get("/m/mira")), "/login?next=%2Fm%2Fmira");
  const page = await read("/m/MIRA", "tomas");
  assert.match(page, /<h1 class="page-title">Mira Okafor<\/h1>/);
  assert.match(page, /A reply at length from Mira/);
  assert.match(page, /And a note in the margin as well\./);
  assert.match(page, /<code>@mira<\/code>/);
  assert.equal((await get("/m/nobody", "tomas")).status, 404);

  // names in a dateline and beside a note lead here
  assert.match(await read(`/p/${id}`, "tomas"), /<a href="\/m\/zan">Zan Huang<\/a>[\s\S]*<a href="\/m\/mira">Mira Okafor<\/a>/);
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

  // a commentary is its author's to restore, though they are no admin
  const answer = await publish({ on: String(id), title: "A member's answer", body: "First." }, "mira");
  await revise(answer, { title: "A member's answer", body: "Second." }, "mira");
  assert.equal((await post(`/p/${answer}/restore`, "tomas", { n: "1" })).status, 403);
  assert.equal(sentTo(await post(`/p/${answer}/restore`, "mira", { n: "1" })), `/p/${answer}`);
  assert.equal(posts.byId(answer).body, "First.");
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
  assert.match(page, /This was changed, and is now at version 2, while you were writing\./);
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
  await get("/account", "tomas");
  await get("/account", "zan");
  const badge = /class="badge"/;

  const note = noteId(sentTo(await post(`/p/${id}/notes`, "mira", { body: "One for @tomas." })));
  assert.match(await read("/", "tomas"), badge);
  sentTo(await post(`/notes/${note}/edit`, "mira", { body: "One for @zan, rather." }));
  assert.doesNotMatch(await read("/", "tomas"), badge);
  assert.doesNotMatch(await read("/account", "tomas"), /A change of address/);
  assert.match(await read("/account", "zan"), new RegExp(`href="/p/${id}#note-${note}">Mira Okafor tagged you in a margin note on A change of address</a>`));
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
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), DOT);
  assert.equal(sentTo(await get(url)), `/login?next=${encodeURIComponent(url)}`);

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

  // in the journal's opening lines, the formula is as typed and the picture is left out
  const journal = await read("/", "mira");
  assert.match(journal, /Euler wrote e\^\{i\\pi\} \+ 1 = 0 and it cost/);

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
  const before = posts.publishedCount();
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
  assert.equal(posts.publishedCount(), before);
});

/* ------------------------------------------------------ parts of the graph */

test("the graph can be narrowed to what surrounds one post or one member", async () => {
  const centre = await publish({ title: "The middle of things", body: "Where it starts." });
  const beside = await publish({ on: String(centre), title: "One step away", body: "An answer." }, "mira");
  const beyond = await publish({ on: String(beside), title: "Two steps away", body: "An answer to the answer." }, "tomas");
  const apart = await publish({ title: "Nothing to do with it", body: "Off by itself." });
  const node = (id) => new RegExp(`data-id="p${id}"`);

  // only the writing, so that being by the same hand does not make two posts neighbours
  const near = await read(`/graph?around=p${centre}&show=articles`, "mira");
  assert.match(near, node(centre));
  assert.match(near, node(beside));
  assert.doesNotMatch(near, node(beyond));
  assert.doesNotMatch(near, node(apart));
  assert.match(near, new RegExp(`class="node node--article node--canon is-centre"\\s+href="/p/${centre}"`));
  assert.match(near, /Around <a[^>]*><strong>The middle of things<\/strong><\/a/);
  assert.match(near, /2 of \d+ shown/);

  const further = await read(`/graph?around=p${centre}&reach=2&show=articles`, "mira");
  assert.match(further, node(beyond));
  assert.doesNotMatch(further, node(apart));
  const connected = await read(`/graph?around=p${centre}&reach=all&show=articles`, "mira");
  assert.match(connected, node(beyond));
  assert.doesNotMatch(connected, node(apart));
  // a reach that makes no sense is the nearest one
  assert.doesNotMatch(await read(`/graph?around=p${centre}&reach=lots&show=articles`, "mira"), node(beyond));

  // around a member: what they wrote, and the people are shown whatever was asked
  const hers = await read(`/graph?around=u${people.mira.id}&show=articles`, "tomas");
  assert.match(hers, new RegExp(`class="node node--person is-centre"\\s+href="/m/mira"`));
  assert.match(hers, node(beside));
  assert.doesNotMatch(hers, node(apart));

  // something that is not on the graph: all of it is shown, with a word to say so
  for (const around of ["p999999", `u999999`]) {
    const whole = await read(`/graph?around=${around}`, "mira");
    assert.match(whole, /That is not on the graph/);
    assert.match(whole, node(apart));
  }
  const nonsense = await read("/graph?around=%3Cscript%3E", "mira");
  assert.doesNotMatch(nonsense, /That is not on the graph|is-centre/);
  assert.match(nonsense, node(apart));

  // the post's page and the member's page lead to their corner of it
  assert.match(await read(`/p/${centre}`, "mira"), new RegExp(`href="/graph\\?around=p${centre}">On the graph</a>`));
  assert.match(await read("/m/mira", "tomas"), new RegExp(`href="/graph\\?around=u${people.mira.id}">On the graph</a>`));
});

/* ---------------------------------------------------------------- the canon */

const CANON_TAG = /<a class="tag tag--canon" href="\/canon">Canon<\/a>/;

test("what the main admin publishes is the canon, which has a page of its own", async () => {
  const article = await publish({ title: "A text of the canon", body: "Set down by the main admin." });
  const short = await publish({ body: "A short remark that is canon all the same." });
  const draft = await publish({ title: "Not canon until it is published", body: "Waiting.", status: "draft" });
  const answer = await publish({ on: String(article), title: "An answer from outside the canon", body: "By Mira." }, "mira");
  const gloss = await publish({ on: String(answer), title: "The canon answers back", body: "By the main admin." });

  assert.equal(users.main().id, people.zan.id, "the first admin is the main one until another is named");
  assert.equal(sentTo(await get("/canon")), "/login?next=%2Fcanon");

  // the page: for every member, with everything the main admin published and nothing else
  const response = await get("/canon", "mira");
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /<a href="\/canon" aria-current="page">Canon<\/a>/, "it has its place in the menu");
  assert.match(page, /<a href="\/m\/zan">Zan Huang<\/a>/);
  assert.match(page, new RegExp(`href="/graph\\?around=u${people.zan.id}"`));
  for (const id of [article, short, gloss]) assert.match(page, new RegExp(`href="/p/${id}"`));
  assert.doesNotMatch(page, new RegExp(`href="/p/${draft}"`), "a draft is not in the canon");
  assert.doesNotMatch(page, /Not canon until it is published/);
  assert.doesNotMatch(page, new RegExp(`href="/p/${answer}"`), "nor is what someone else wrote");
  assert.match(page, />Articles<[\s\S]*>Commentaries<[\s\S]*>Short posts</);
  assert.ok(page.indexOf(`href="/p/${article}"`) < page.indexOf(`href="/p/${gloss}"`), "articles come before commentaries");
  assert.match(await read("/", "tomas"), /<a href="\/canon" >Canon<\/a>/);

  // a piece of the canon says so beside its date, wherever it is shown
  assert.match(await read(`/p/${article}`, "mira"), CANON_TAG);
  assert.match(await read(`/p/${gloss}`, "mira"), CANON_TAG);
  assert.match(await read("/", "mira"), CANON_TAG);
  assert.doesNotMatch(await read(`/p/${answer}`, "mira"), /tag--canon/);
  assert.doesNotMatch(await read(`/p/${draft}`, "zan"), /tag--canon/);

  // on the graph it is drawn apart, and so is the main admin
  const graph = await read("/graph", "tomas");
  const drawn = (kind, href, canon) =>
    assert.match(graph, new RegExp(`class="node node--${kind}${canon ? " node--canon" : ""}"\\s+href="${href}"`));
  drawn("article", `/p/${article}`, true);
  drawn("post", `/p/${short}`, true);
  drawn("commentary", `/p/${gloss}`, true);
  drawn("commentary", `/p/${answer}`, false);
  drawn("person", "/m/zan", true);
  drawn("person", "/m/mira", false);
  assert.match(graph, new RegExp(`aria-label="A text of the canon — an article by Zan Huang · In the canon`));
  assert.match(graph, /aria-label="Zan Huang · Main admin, whose writing is the canon/);
  assert.match(graph, /class="node__halo"/);
  assert.match(graph, /<a href="\/canon">The canon<\/a>/, "the key says what the gold is");
  assert.match(graph, /\d+ in the canon/);

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
  const graph = await read("/graph", "mira");
  assert.match(graph, new RegExp(`class="node node--article node--canon"\\s+href="/p/${hers}"`));
  assert.match(graph, new RegExp(`class="node node--article"\\s+href="/p/${his}"`));
  assert.match(graph, /class="node node--person node--canon"\s+href="\/m\/ines"/);
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
  // the journal's line about it, which is cut from the text, is set the same way
  assert.match(await read("/", "mira"), /On “slowness”[\s\S]*?He called it “the slow art” and it’s stuck\./);

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

test("the menu keeps the places to go apart from who is signed in", async () => {
  const hers = await read("/", "mira");
  const [, places] = hers.match(/<nav class="masthead__nav" aria-label="Site">([\s\S]*?)<\/nav>/);
  assert.deepEqual(
    [...places.matchAll(/<a href="([^"]+)"/g)].map((found) => found[1]),
    ["/", "/canon", "/graph", "/projects", "/chat", "/guide"]
  );
  const [, you] = hers.match(/<div class="masthead__you">([\s\S]*?)<\/div>/);
  assert.match(you, /<a href="\/account"\s*>Mira Okafor<\/a>[\s\S]*action="\/logout"[\s\S]*Sign out/);
  assert.doesNotMatch(hers, /masthead--long/);

  // an admin's menu has two more places, and is given room for them
  const his = await read("/", "zan");
  assert.match(his, /<header class="masthead masthead--long">/);
  assert.match(his, /<nav class="masthead__nav"[\s\S]*href="\/write"[\s\S]*href="\/members"[\s\S]*<\/nav>/);
});

/* ---------------------------------------------------------------- the guide */

test("the guide is for members, and tells admins what only they can do", async () => {
  assert.equal(sentTo(await get("/guide")), "/login?next=%2Fguide");
  const hers = await read("/guide", "mira");
  for (const part of ["reading", "search", "writing", "versions", "canon", "graph", "chat", "projects", "account"])
    assert.match(hers, new RegExp(`<section id="${part}">`));
  assert.match(hers, /<a href="\/guide" aria-current="page">Guide<\/a>/);
  assert.doesNotMatch(hers, /id="admins"|For admins/);
  assert.match(await read("/guide", "zan"), /<section id="admins">/);
  // every page leads to it
  assert.match(await read("/", "tomas"), /<a href="\/guide"\s*>Guide<\/a>/);
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
  assert.match(await read(`/projects/${id}`, "mira"), /Project · Private to those working on it/);

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
  const found = (await read("/guide", who)).match(/(\d+) unread messages?<\/span>/);
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
  assert.doesNotMatch(earlier, /data-chat|data-live|chat\.js/);
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

test("the pages are dark for a member until they choose the paper, and the door is always paper", async () => {
  const ada = await newcomer("ada", "Ada Morrow");
  const dark = await read("/", "ada");
  assert.match(dark, /<html lang="en" data-theme="night">/);
  assert.match(dark, /<meta name="theme-color" content="#0b0a08"/);
  assert.match(dark, /<meta name="color-scheme" content="dark"/);
  const account = await read("/account", "ada");
  const chosen = (look, pressed) => new RegExp(`class="look look--${look}"\\s+type="submit"\\s+name="theme"\\s+value="${look}"\\s+aria-pressed="${pressed}"`);
  assert.match(account, chosen("night", true));
  assert.match(account, chosen("paper", false));

  assert.equal((await post("/account/theme", "ada", { theme: "paper" }, { csrf: false })).status, 403);
  assert.equal((await post("/account/theme", "ada", { theme: "neon" })).status, 400);
  assert.equal(sentTo(await post("/account/theme", "ada", { theme: "paper" })), "/account#looks");
  const light = await read("/journal-is-at-the-root", "ada");
  assert.match(light, /<html lang="en" data-theme="paper">/, "even the page for what is not there");
  assert.match(await read("/", "ada"), /<meta name="theme-color" content="#f3ecdc"/);
  assert.match(await read("/account", "ada"), chosen("paper", true));
  assert.equal(users.byId(ada.id).theme, "paper");
  assert.match(await read("/", "mira"), /data-theme="night"/, "it is each member's own choice");

  assert.match(await read("/login"), /<html lang="en" data-theme="paper">/);
  sentTo(await post("/account/theme", "ada", { theme: "night" }));
  assert.match(await read("/", "ada"), /data-theme="night"/);
});

test("a member sees where they are signed in, and can end any of it but where they are", async () => {
  const noor = await newcomer("noor", "Noor Haddad");
  const phone = auth.createSession(noor.id, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
  const work = auth.createSession(noor.id, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0");
  const as = (token) => fetch(base + "/account", { redirect: "manual", headers: { Cookie: `session=${token}` } });
  const [here, onPhone, atWork] = [auth.findSession(noor.cookie.slice(8)), auth.findSession(phone), auth.findSession(work)];

  const account = await read("/account", "noor");
  assert.match(account, /Safari on Mac\s*<span class="tag tag--mark">This one<\/span>/);
  assert.match(account, /Safari on iPhone/);
  assert.match(account, /Firefox on Windows/);
  assert.doesNotMatch(account, new RegExp(`action="/account/sessions/${here.id}/end"`), "the one in use is ended by signing out");
  assert.match(account, new RegExp(`action="/account/sessions/${onPhone.id}/end"`));
  assert.doesNotMatch(account, new RegExp(phone), "never the token itself");

  // nobody ends a session that is not theirs, nor the one they are asking from
  assert.equal((await post(`/account/sessions/${onPhone.id}/end`, "mira")).status, 404);
  assert.equal((await post(`/account/sessions/${here.id}/end`, "noor")).status, 400);
  assert.equal((await post(`/account/sessions/${onPhone.id}/end`, "noor", {}, { csrf: false })).status, 403);
  assert.equal((await as(phone)).status, 200);

  assert.equal(sentTo(await post(`/account/sessions/${onPhone.id}/end`, "noor")), "/account?done=ended#sessions");
  assert.equal(sentTo(await as(phone)), "/login?next=%2Faccount");
  assert.equal((await post(`/account/sessions/${onPhone.id}/end`, "noor")).status, 404, "it is already gone");
  assert.equal((await as(work)).status, 200);

  assert.equal(sentTo(await post("/account/sessions/end", "noor")), "/account?done=elsewhere#sessions");
  assert.equal(sentTo(await as(work)), "/login?next=%2Faccount");
  const alone = await read("/account?done=elsewhere", "noor");
  assert.match(alone, /You have been signed out everywhere but here\./);
  assert.match(alone, /Nowhere but here\./);
  assert.doesNotMatch(alone, /Firefox on Windows|Sign out everywhere else/);
  assert.equal(atWork.user.id, noor.id);
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
  assert.match(await read("/", "tomas"), /<form class="search" action="\/search" method="get" role="search">/);

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
  assert.match(list, /Petra Vance is a sub-admin, and can now: start posts, moderate\./);
  assert.match(list, /Sub-admin\s+<span class="members__can">\s*Start posts · Moderate\s*<\/span>/);
  assert.match(list, new RegExp(`<a class="link" href="${path}">Permissions</a>`));
  assert.match(await read(path, "zan"), /name="can" value="write" checked \/>[\s\S]*name="can" value="edit"\s*\/>[\s\S]*name="can" value="moderate" checked \/>/);

  // it holds from her next page, without signing in again, and she is told what she is
  const hers = await read("/", "petra");
  assert.match(hers, /<header class="masthead masthead--long">/);
  const [, places] = hers.match(/<nav class="masthead__nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.deepEqual(
    [...places.matchAll(/<a href="([^"]+)"/g)].map((found) => found[1]),
    ["/", "/canon", "/graph", "/projects", "/chat", "/write", "/guide"]
  );
  assert.match(await read("/account", "petra"), /Sub-admin[\s\S]*As a sub-admin you have been given:\s+start posts, moderate\./);
  assert.match(await read("/m/petra", "tomas"), /<p class="hint">\s*Sub-admin ·/);
  const guide = await read("/guide", "petra");
  assert.match(guide, /<section id="admins">\s*<h2>For sub-admins<\/h2>/);
  assert.match(guide, /Starting posts\.[\s\S]*Moderating\./);
  assert.doesNotMatch(guide, /For admins|Editing the journal\.|Managing members\.|Overseeing projects\.|Make sub-admin/);

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
  assert.doesNotMatch(await read("/", "petra"), /masthead--long|href="\/write"/);
  assert.doesNotMatch(await read("/guide", "petra"), /id="admins"/);
  assert.match(await read("/account", "petra"), /· Member ·/);
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
    const started = await post("/write", "wren", { status: "draft", title: "Started by Wren", body: "Her own." });
    return {
      write: started.status === 303,
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
  assert.match(list, /You are here as a sub-admin who manages the members\./);
  assert.match(list, new RegExp(`action="/members/${cato.id}/password"`));
  assert.match(list, new RegExp(`action="/members/${cato.id}/remove"`));
  assert.doesNotMatch(list, new RegExp(`action="/members/(${basil.id}|${hale.id}|${people.zan.id})/`));
  assert.doesNotMatch(list, /\/permissions"|Make sub-admin|Make main admin/);
  assert.match(await read("/", "odile"), /<nav class="masthead__nav"[\s\S]*href="\/members"[\s\S]*<\/nav>/);
  assert.doesNotMatch(await read("/", "odile"), /href="\/write"/);

  // she adds a member, who is a member and nothing more
  const added = await post("/members", "odile", { name: "Runa Vale", username: "runa", can: "members", role: "admin" });
  assert.equal(added.status, 201);
  const runa = users.byUsername("runa");
  assert.equal(runa.role, "member");
  assert.equal(runa.permissions, "");

  // a member's password is hers to issue, and a member hers to remove and restore
  const issued = await post(`/members/${cato.id}/password`, "odile");
  assert.equal(issued.status, 200);
  assert.match(await issued.text(), /<dd><code>cato<\/code><\/dd>/);
  assert.equal((await get("/", "cato")).status, 303, "he is signed out with his old password");
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
