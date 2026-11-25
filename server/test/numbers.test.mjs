/*
 * Invitations, by a link an admin passes on and by text, end to end: a real
 * server with a scratch database and a texting service of our own on this
 * machine, which keeps what it is sent. This is where it is checked that a
 * number is seen by the admins and by nobody and nothing else.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-numbers-test-"));
process.env.DATA_DIR = scratch;
process.env.NUMBERS_KEY = "a key for these tests and for nothing else, long enough";

const auth = await import("../src/auth.mjs");
const { adminLog, db, posts, users } = await import("../src/db.mjs");
const numbers = await import("../src/numbers.mjs");
const texts = await import("../src/texts.mjs");

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
let carrier;
let output = "";
const people = {};

/* What the texting service was sent, in order; and the numbers it refuses, with the code it refuses each with. */
const carried = [];
const refusals = new Map();

before(async () => {
  for (const [username, name, role] of [
    ["lillian", "Lillian Tern", "admin"],
    ["zan", "Zan Huang", "admin"],
    ["mira", "Mira Okafor", "member"],
  ]) {
    const id = users.create({ username, name, role, passwordHash: await auth.hashPassword(`${username}-password`) });
    const token = auth.createSession(id);
    people[username] = { id, cookie: `session=${token}`, csrf: auth.findSession(token).csrf };
  }
  users.setMain(people.lillian.id);
  users.setPermissions(people.mira.id, ["write", "edit", "moderate", "members"]);

  carrier = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const to = fields.get("To");
      carried.push({ path: req.url, authorization: req.headers.authorization, to, from: fields.get("From"), body: fields.get("Body") });
      res.setHeader("Content-Type", "application/json");
      if (refusals.has(to)) {
        // what the service says of a refusal names the number, as the real one does
        res.writeHead(400).end(JSON.stringify({ code: refusals.get(to), message: `The number ${to} is unsubscribed.`, status: 400 }));
      } else res.writeHead(201).end(JSON.stringify({ sid: "SM0", status: "queued" }));
    });
  });
  await new Promise((ready) => carrier.listen(0, "127.0.0.1", ready));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: scratch,
      PUBLIC_URL: "",
      LATEX: "off",
      PACE: "off",
      // the list of those who are to be invited is put away unless it is asked for, as it is here
      INVITATIONS: "on",
      TWILIO_ACCOUNT_SID: "AC-test",
      TWILIO_AUTH_TOKEN: "a-token",
      TWILIO_FROM: "+15005550006",
      TWILIO_API: `http://127.0.0.1:${carrier.address().port}`,
      TEXT_GAP_MS: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // everything the server says, to see afterwards that no number is in it
  child.stderr.on("data", (chunk) => (output += chunk));
  await new Promise((ready, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`the server stopped early (${code})\n${output}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (String(chunk).includes("listening")) ready();
    });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.removeAllListeners("exit");
    const gone = new Promise((done) => child.once("exit", done));
    child.kill();
    await gone;
  }
  carrier?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- helpers */

const get = (path, who, cookie) =>
  fetch(base + path, { redirect: "manual", headers: who ? { Cookie: people[who].cookie } : cookie ? { Cookie: cookie } : {} });

function post(path, who, fields = {}, { cookie, csrf } = {}) {
  const body = new URLSearchParams(fields);
  if (who) body.set("_csrf", people[who].csrf);
  if (csrf) body.set("_csrf", csrf);
  return fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: base, ...(who ? { Cookie: people[who].cookie } : cookie ? { Cookie: cookie } : {}) },
    body,
  });
}

function sentTo(response) {
  assert.ok(response.status >= 300 && response.status < 400, `expected a redirect, got ${response.status}`);
  return response.headers.get("location");
}

const read = async (path, who) => (await get(path, who)).text();

/** puts someone down as an admin does, and gives back their row */
async function putDown(name, number) {
  assert.equal(sentTo(await post("/invitations", "lillian", { name, number })), "/invitations?done=added");
  return numbers.contacts.all().find((each) => each.name === name);
}

/** waits until the sending that is under way is over */
async function sendingOver() {
  for (let i = 0; i < 400; i++) {
    const page = await read("/invitations", "lillian");
    if (!/so far\./.test(page)) return page;
    await new Promise((resume) => setTimeout(resume, 15));
  }
  assert.fail("the sending did not end");
}

/** the last text carried to a number, and the link in it */
function textTo(number) {
  const text = carried.findLast((each) => each.to === number);
  assert.ok(text, `no text was carried to ${number}`);
  return { ...text, link: text.body.match(/http:\/\/\S+/)?.[0] ?? null };
}

const pathOf = (link) => new URL(link).pathname;

/** every file the forum keeps, as one string: the database, and whatever stands beside it */
function everythingKept() {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return readdirSync(scratch, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");
}

/* ------------------------------------------------------- how a number is kept */

test("a number is sealed: it comes back with the key, is not read without it, and cannot be altered unnoticed", () => {
  const sealed = numbers.seal("+14155550100");
  assert.doesNotMatch(sealed, /4155550100/);
  assert.equal(numbers.open(sealed), "+14155550100");
  // sealed twice, the same number does not look the same; its mark is what says it is the same
  assert.notEqual(numbers.seal("+14155550100"), sealed);
  assert.equal(numbers.markOf("+14155550100"), numbers.markOf("+14155550100"));
  assert.notEqual(numbers.markOf("+14155550100"), numbers.markOf("+14155550101"));
  assert.doesNotMatch(numbers.markOf("+14155550100"), /4155550100/);

  const bytes = Buffer.from(sealed, "base64");
  bytes[14] ^= 1;
  assert.throws(() => numbers.open(bytes.toString("base64")));
});

test("a number is taken as it is typed, and made the one way a number is dialled", () => {
  for (const typed of ["+1 415 555 0100", "(415) 555-0100", "415.555.0100", "1 415 555 0100", "+14155550100"])
    assert.equal(numbers.dialled(typed), "+14155550100", typed);
  assert.equal(numbers.dialled("+44 20 7946 0958"), "+442079460958");
  for (const typed of ["", "555 0100", "call me", "+1 415 555 0100 ext 2", "+0 415 555 0100", "12345678901234567", "<script>"])
    assert.equal(numbers.dialled(typed), null, typed);
  assert.equal(numbers.covered("+14155550100"), "••••••• 0100");
});

test("how many parts a text is sent in is counted as a telephone counts it", () => {
  assert.equal(texts.parts("a".repeat(160)), 1);
  assert.equal(texts.parts("a".repeat(161)), 2);
  assert.equal(texts.parts("a".repeat(307)), 3);
  // one character outside the plain alphabet and a part holds 70
  assert.equal(texts.parts("“" + "a".repeat(69)), 1);
  assert.equal(texts.parts("“" + "a".repeat(70)), 2);
  for (const kind of Object.keys(texts.WORDS)) assert.equal(texts.wordsProblem(kind, texts.WORDS[kind].first), null, kind);
  assert.match(texts.wordsProblem("invite", "No link in this one."), /\{link\}/);
  assert.match(texts.wordsProblem("invite", "{title} {link}"), /Only \{link\}/);
  assert.equal(texts.wordsProblem("piece", "{title} {link}"), null);
});

/* ------------------------------------------------------------ whose it is */

test("the list of those invited is the admins': to a sub-admin, whatever they hold, or a stranger it is not there", async () => {
  const ada = await putDown("Ada Quill", "+1 415 555 0101");

  for (const who of ["lillian", "zan"]) {
    const page = await read("/invitations", who);
    assert.match(page, /<h1 class="page-title">Invitations<\/h1>/);
    assert.match(page, /Ada Quill/);
    // on the list a number is shown by its end
    assert.match(page, /0101/);
    assert.doesNotMatch(page, /4155550101|415 555 0101/);
    // and in full where it is changed
    assert.match(await read(`/invitations/${ada.id}`, who), /value="\+14155550101"/);
    // the page the corpus is kept from leads there, and so does the list of members
    assert.match(await read("/", who), /href="\/invitations"/);
    assert.match(await read("/members", who), /href="\/invitations"/);
  }
  // the chats the main admin sends to are still hers alone
  assert.match(await read("/", "lillian"), /href="\/send"/);
  assert.doesNotMatch(await read("/", "zan"), /href="\/send"/);

  // a sub-admin given everything there is to give, the members included, is not an admin
  for (const path of ["/invitations", `/invitations/${ada.id}`]) assert.equal((await get(path, "mira")).status, 404, path);
  assert.equal((await post("/invitations", "mira", { name: "Someone Else", number: "+14155550199" })).status, 404);
  assert.equal((await post("/invitations", "mira", { name: "Someone Else", then: "link" })).status, 404);
  assert.equal((await post(`/invitations/${ada.id}`, "mira", { name: "Ada", number: "+14155550199", place: "1" })).status, 404);
  assert.equal((await post(`/invitations/${ada.id}/remove`, "mira")).status, 404);
  assert.equal((await post(`/invitations/${ada.id}/link`, "mira")).status, 404);
  assert.equal((await post(`/invitations/${ada.id}/tell`, "mira")).status, 404);
  assert.equal((await post("/invitations/tell", "mira", { which: "first" })).status, 404);
  assert.equal((await post("/invitations/words", "mira", { invite: "{link}", again: "{link}", piece: "{link}" })).status, 404);
  assert.equal((await post("/invitations/try", "mira", { number: "+14155550199" })).status, 404);
  // nothing leads there either
  assert.doesNotMatch(await read("/", "mira"), /href="\/invitations"/);
  assert.doesNotMatch(await read("/members", "mira"), /href="\/invitations"/);
  assert.equal(numbers.contacts.count(), 1);
  assert.equal(numbers.contacts.byId(ada.id).link_until, null);
  assert.equal(carried.length, 0);

  // someone not signed in is sent to sign in, as for any page
  assert.match(sentTo(await get("/invitations")), /^\/login/);

  // a form that is not the admin's own page's is refused
  assert.equal((await post("/invitations", null, { name: "Forged", number: "+14155550198" }, { cookie: people.lillian.cookie })).status, 403);

  // nobody put down stands among the members, to anyone
  for (const who of ["lillian", "zan", "mira"]) assert.doesNotMatch(await read("/members", who), /Ada Quill/);
});

test("someone is put down with a name and a number that is one, once; and is moved, changed and taken off", async () => {
  const refused = async (fields, why) => {
    const response = await post("/invitations", "lillian", fields);
    assert.equal(response.status, 422);
    assert.match(await response.text(), why);
  };
  await refused({ name: "", number: "+14155550102" }, /Give their name/);
  await refused({ name: "Bea Marsh", number: "tomorrow" }, /not a telephone number/);
  // the same number, however it is written
  await refused({ name: "Ada Again", number: "(415) 555-0101" }, /on the list already/);

  const bea = await putDown("Bea Marsh", "415 555 0102");
  const cy = await putDown("Cy Vane", "+14155550103");
  const order = () => numbers.contacts.all().map((each) => each.name);
  assert.deepEqual(order(), ["Ada Quill", "Bea Marsh", "Cy Vane"]);

  // moved to the first place, with the name and the number changed
  assert.equal(
    sentTo(await post(`/invitations/${cy.id}`, "lillian", { name: "Cy Vane-Holt", number: "+14155550113", place: "1" })),
    "/invitations?done=saved"
  );
  assert.deepEqual(order(), ["Cy Vane-Holt", "Ada Quill", "Bea Marsh"]);
  assert.equal(numbers.open(numbers.contacts.byId(cy.id).number), "+14155550113");
  // a place past the end is the end
  await post(`/invitations/${cy.id}`, "lillian", { name: "Cy Vane-Holt", number: "+14155550113", place: "40" });
  assert.deepEqual(order(), ["Ada Quill", "Bea Marsh", "Cy Vane-Holt"]);

  // not to a number someone else has, nor to a place that is not one
  const taken = await post(`/invitations/${cy.id}`, "lillian", { name: "Cy Vane-Holt", number: "+14155550102", place: "3" });
  assert.equal(taken.status, 422);
  assert.match(await taken.text(), /on the list already/);
  assert.equal((await post(`/invitations/${cy.id}`, "lillian", { name: "Cy Vane-Holt", number: "+14155550113", place: "first" })).status, 422);

  assert.equal(sentTo(await post(`/invitations/${bea.id}/remove`, "lillian")), "/invitations?done=removed");
  assert.deepEqual(order(), ["Ada Quill", "Cy Vane-Holt"]);
  assert.equal((await get(`/invitations/${bea.id}`, "lillian")).status, 404);
  // nothing has been sent by any of this
  assert.equal(carried.length, 0);
});

/* ------------------------------------------------------- the announcement */

let centre;

test("the announcement goes to everyone not yet written to, in order, each with a link of their own", async () => {
  centre = posts.create({ authorId: people.lillian.id, title: "The centre of it", body: "What everything else is about.", status: "published" });
  posts.setCentre(centre);
  await putDown("Dov Hale", "+14155550104");

  assert.equal(sentTo(await post("/invitations/tell", "lillian", { which: "first" })), "/invitations?done=begun");
  const page = await sendingOver();
  assert.match(page, /The announcement: 3 texts sent\./);

  assert.deepEqual(
    carried.map((each) => each.to),
    ["+14155550101", "+14155550113", "+14155550104"]
  );
  for (const text of carried) {
    assert.equal(text.path, "/2010-04-01/Accounts/AC-test/Messages.json");
    assert.equal(text.authorization, `Basic ${Buffer.from("AC-test:a-token").toString("base64")}`);
    assert.equal(text.from, "+15005550006");
    assert.match(text.body, /Reply STOP/);
  }
  const links = carried.map((each) => each.body.match(/http:\/\/\S+/)[0]);
  assert.equal(new Set(links).size, 3);
  for (const link of links) assert.match(link, new RegExp(`^${base}/welcome/[\\w-]{24}$`));

  // each has been written to once; there is nobody left to announce it to
  assert.deepEqual(
    numbers.contacts.all().map((each) => each.told),
    [1, 1, 1]
  );
  assert.equal((await post("/invitations/tell", "lillian", { which: "first" })).status, 409);
  assert.match(page, /Texted once/);
});

test("a link leads to a page where the account is taken up with a password, and from there to the centre of the corpus", async () => {
  const { link } = textTo("+14155550101");
  const path = pathOf(link);

  // looking spends nothing, however often: a telephone fetches a link to show a picture of it
  for (let i = 0; i < 3; i++) {
    const welcome = await get(path);
    assert.equal(welcome.status, 200);
    const page = await welcome.text();
    assert.match(page, /Welcome, Ada Quill/);
    assert.match(page, /value="ada\.quill"/);
    // the page says nothing of the number it was sent to
    assert.doesNotMatch(page, /0101/);
  }
  assert.equal(users.byUsername("ada.quill"), undefined);

  const refused = async (fields, why) => {
    const response = await post(path, null, fields);
    assert.equal(response.status, 422);
    assert.match(await response.text(), why);
  };
  await refused({ username: "ada.quill", password: "short" }, /at least|characters/i);
  await refused({ username: "lillian", password: "four unrelated words here" }, /taken/);
  await refused({ username: "ada quill", password: "four unrelated words here" }, /sign-in name is 2 to 32/);
  assert.equal(numbers.contacts.all()[0].accepted_at, null);

  const taken = await post(path, null, { username: "ada.quill", password: "four unrelated words here" });
  assert.equal(sentTo(taken), `/p/${centre}`);
  const cookie = taken.headers.get("set-cookie").split(";")[0];
  const landed = await get(`/p/${centre}`, null, cookie);
  assert.equal(landed.status, 200);
  assert.match(await landed.text(), /The centre of it/);

  // the account is a member's, and is theirs to sign in to from then on
  const ada = users.byUsername("ada.quill");
  assert.equal(ada.name, "Ada Quill");
  assert.equal(ada.role, "member");
  assert.equal(ada.permissions, "");
  const signedIn = await post("/login", null, { username: "ada.quill", password: "four unrelated words here" });
  assert.equal(sentTo(signedIn), "/");
  people.ada = { id: ada.id, cookie, csrf: auth.findSession(cookie.split("=")[1]).csrf };

  // the link is spent
  assert.equal((await get(path)).status, 404);
  assert.equal((await post(path, null, { username: "ada.second", password: "four unrelated words here" })).status, 404);
  assert.equal(users.byUsername("ada.second"), undefined);
  // and she is not written to about it again
  assert.match(await read("/invitations", "lillian"), /Taken up/);
  assert.equal((await post(`/invitations/${numbers.contacts.all()[0].id}/tell`, "lillian")).status, 409);

  // a link that was never sent leads nowhere, and says no more than one that has ended
  for (const made of ["/welcome/abcdefghijklmnopqrstuvwx", "/welcome/x", "/welcome/..%2F..%2Fnumbers"]) {
    const response = await get(made);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /This invitation has ended|could not be found/);
  }
});

test("nobody is written to more than twice about an account they have not taken up, and a newer link ends the older", async () => {
  const first = textTo("+14155550113").link;
  const before = carried.length;

  assert.equal(sentTo(await post("/invitations/tell", "lillian", { which: "again" })), "/invitations?done=begun");
  assert.match(await sendingOver(), /The second message: 2 texts sent\./);
  // to the two who have not come, and not to the one who has
  assert.deepEqual(
    carried.slice(before).map((each) => each.to),
    ["+14155550113", "+14155550104"]
  );
  const second = textTo("+14155550113");
  assert.match(second.body, /still waiting/);
  assert.notEqual(second.link, first);
  assert.equal((await get(pathOf(first))).status, 404);
  assert.equal((await get(pathOf(second.link))).status, 200);

  // a third time there is nobody to write to, all at once or one by one
  const cy = numbers.contacts.all().find((each) => each.name === "Cy Vane-Holt");
  assert.equal(cy.told, 2);
  assert.equal((await post("/invitations/tell", "lillian", { which: "again" })).status, 409);
  assert.equal((await post(`/invitations/${cy.id}/tell`, "lillian")).status, 409);
  assert.equal(carried.length, before + 2);
  const page = await read("/invitations", "lillian");
  assert.match(page, /Texted twice/);
  assert.doesNotMatch(page, /Text once more/);
});

test("an invitation not taken up in ninety days lapses: its link ends, and nothing of an account is left", async () => {
  const cy = numbers.contacts.all().find((each) => each.name === "Cy Vane-Holt");
  const { link } = textTo("+14155550113");
  const members = users.count();

  // an invitation is given ninety days: eighty-nine days on it still stands
  const DAY = 24 * 60 * 60 * 1000;
  const at = (days) => new Date(Date.now() + (90 - days) * DAY).toISOString();
  db.prepare("UPDATE invitations SET expires_at = ? WHERE contact_id = ?").run(at(89), cy.id);
  assert.equal(numbers.lapse(), 0);
  assert.equal((await get(pathOf(link))).status, 200);

  db.prepare("UPDATE invitations SET expires_at = ? WHERE contact_id = ?").run(at(90.01), cy.id);
  // the link has ended whether or not anything has swept it away yet
  assert.equal((await get(pathOf(link))).status, 404);
  assert.equal((await post(pathOf(link), null, { username: "cy.vane", password: "four unrelated words here" })).status, 404);
  assert.equal(numbers.lapse(), 1);
  assert.equal(numbers.lapse(), 0);
  assert.ok(numbers.contacts.byId(cy.id).lapsed_at);
  assert.equal(users.count(), members);
  assert.equal(users.byUsername("cy.vane"), undefined);
  // they stay on the list, and the page says how they stand
  assert.match(await read("/invitations", "lillian"), /not taken up; lapsed/);
});

test("someone who has asked the carrier for nothing more is written to no more, and what is kept of a refusal names no number", async () => {
  const eve = await putDown("Eve Lund", "+14155550105");
  refusals.set("+14155550105", 21610);
  const response = await post(`/invitations/${eve.id}/tell`, "lillian");
  assert.equal(response.status, 422);
  assert.match(await response.text(), /asked to be sent nothing more/);

  const now = numbers.contacts.byId(eve.id);
  assert.ok(now.stopped_at);
  assert.equal(now.told, 0);
  // the link that was made for the text that did not go leads nowhere
  assert.equal((await get(pathOf(textTo("+14155550105").link))).status, 404);
  assert.equal((await post(`/invitations/${eve.id}/tell`, "lillian")).status, 409);
  assert.match(await read("/invitations", "lillian"), /Asked for nothing more/);

  // another refusal: what is kept is the forum's own words for it
  const fay = await putDown("Fay Orr", "+14155550106");
  refusals.set("+14155550106", 99999);
  assert.equal((await post(`/invitations/${fay.id}/tell`, "lillian")).status, 422);
  const kept = db.prepare("SELECT detail FROM texts WHERE contact_id IN (?, ?)").all(eve.id, fay.id);
  assert.equal(kept.length, 2);
  for (const { detail } of kept) assert.doesNotMatch(detail, /\d{7}|unsubscribed/);
  assert.match(await read("/invitations", "lillian"), /refused it \(code 99999\)/);
  // refused for a reason that may pass, they can be tried again
  refusals.delete("+14155550106");
  assert.equal(sentTo(await post(`/invitations/${fay.id}/tell`, "lillian")), "/invitations?done=told");
  assert.equal(numbers.contacts.byId(fay.id).told, 1);
});

/* ------------------------------------------------ texts about what is published */

test("a member who came by an invitation is sent nothing until they ask, and then only what the main admin sends", async () => {
  // both are unticked to begin with
  const preferences = await read("/account", "ada");
  assert.match(preferences, /Receive texts for all posts/);
  assert.match(preferences, /Receive texts for some posts/);
  assert.doesNotMatch(preferences, /name="texts"[^>]*checked/);
  assert.equal(users.byId(people.ada.id).texts, "");
  // a member who did not come by one has no such choice
  assert.doesNotMatch(await read("/account", "mira"), /Receive texts/);
  assert.equal((await post("/account/texts", "mira", { texts: "all" })).status, 404);

  const piece = posts.create({ authorId: people.lillian.id, title: "A second piece", body: "More.", status: "published" });
  // only the main admin sends it, and is the only one shown the way to
  assert.match(await read(`/p/${piece}`, "lillian"), new RegExp(`href="/p/${piece}/text"`));
  for (const who of ["zan", "mira", "ada"]) {
    assert.doesNotMatch(await read(`/p/${piece}`, who), /\/text"/);
    assert.equal((await get(`/p/${piece}/text`, who)).status, 404);
    assert.equal((await post(`/p/${piece}/text`, who, { to: "all" })).status, 404);
  }
  assert.match(await read(`/p/${piece}/text`, "lillian"), /Nobody who has not been sent it has asked for texts/);

  // Dov takes up his account too, and asks for some; Ada asks for all
  const dov = await post(pathOf(textTo("+14155550104").link), null, { username: "dov", password: "another four words entirely" });
  const dovCookie = dov.headers.get("set-cookie").split(";")[0];
  const dovCsrf = auth.findSession(dovCookie.split("=")[1]).csrf;
  assert.equal(sentTo(await post("/account/texts", null, { texts: "some" }, { cookie: dovCookie, csrf: dovCsrf })), "/account?done=texts#texts");
  const asked = new URLSearchParams([["texts", "all"], ["texts", "everything"], ["_csrf", people.ada.csrf]]);
  await fetch(`${base}/account/texts`, { method: "POST", redirect: "manual", headers: { Origin: base, Cookie: people.ada.cookie }, body: asked });
  assert.equal(users.byId(people.ada.id).texts, "all");
  assert.match(await read("/account", "ada"), /value="all" checked/);

  const page = await read(`/p/${piece}/text`, "lillian");
  assert.match(page, /New at Gesserit: A second piece/);
  assert.match(page, /1 member\./);
  assert.match(page, /1 member more\./);

  // sent to those who asked for all: Ada, and not Dov
  const before = carried.length;
  assert.equal(sentTo(await post(`/p/${piece}/text`, "lillian", { to: "all" })), `/p/${piece}/text`);
  await sendingOver();
  assert.deepEqual(
    carried.slice(before).map((each) => [each.to, each.body]),
    [["+14155550101", `New at Gesserit: A second piece ${base}/p/${piece}`]]
  );
  // sent again with the others, it goes to Dov and not to Ada twice
  const again = new URLSearchParams([["to", "all"], ["to", "some"], ["_csrf", people.lillian.csrf]]);
  await fetch(`${base}/p/${piece}/text`, { method: "POST", redirect: "manual", headers: { Origin: base, Cookie: people.lillian.cookie }, body: again });
  await sendingOver();
  assert.deepEqual(
    carried.slice(before + 1).map((each) => each.to),
    ["+14155550104"]
  );
  assert.equal((await post(`/p/${piece}/text`, "lillian", { to: "all" })).status, 422);

  // unticked, nothing more comes; nor to someone taken off the list, whose account stays
  await post("/account/texts", "ada", {});
  assert.equal(users.byId(people.ada.id).texts, "");
  const dovContact = numbers.contacts.all().find((each) => each.name === "Dov Hale");
  await post(`/invitations/${dovContact.id}/remove`, "lillian");
  assert.ok(users.byUsername("dov").active);
  const third = posts.create({ authorId: people.lillian.id, title: "A third", body: "More still.", status: "published" });
  assert.match(await read(`/p/${third}/text`, "lillian"), /Nobody who has not been sent it has asked for texts/);
  assert.equal((await post(`/p/${third}/text`, "lillian", { to: "all" })).status, 422);
  assert.equal(carried.length, before + 2);

  // a piece under review is not one to send a text about
  const draft = posts.create({ authorId: people.lillian.id, title: "Not yet", body: "Under review.", status: "draft" });
  assert.equal((await get(`/p/${draft}/text`, "lillian")).status, 404);
});

test("the words of each text are the admins' to write, and must carry the link", async () => {
  const words = {
    invite: "Something is up at last. Yours: {link} Reply STOP to hear no more.",
    again: "Still here: {link}",
    piece: "{title}, new: {link}",
  };
  assert.equal(sentTo(await post("/invitations/words", "lillian", words)), "/invitations?done=words#words");
  assert.match(await read("/invitations", "lillian"), /Something is up at last\./);
  const without = await post("/invitations/words", "lillian", { ...words, again: "Still here." });
  assert.equal(without.status, 422);
  assert.equal(texts.wordsFor("again"), "Still here: {link}");

  // the new words are what is sent
  const gil = await putDown("Gil Roe", "+14155550107");
  await post(`/invitations/${gil.id}/tell`, "lillian");
  assert.match(textTo("+14155550107").body, /^Something is up at last\. Yours: http:\/\/\S+\/welcome\/[\w-]{24} Reply STOP/);

  // sent to a number of her own to see how it reads, the number is not kept and the link opens no account
  const count = numbers.contacts.count();
  assert.equal(sentTo(await post("/invitations/try", "lillian", { number: "415 555 0190" })), "/invitations?done=tried#try");
  assert.equal(textTo("+14155550190").link, `${base}/login`);
  assert.equal(numbers.contacts.count(), count);
});

/* ------------------------------------------------------- a link passed on by hand */

/** the link on a page that has just issued one */
function issuedOn(page) {
  const link = page.match(/<code id="issued-link">([^<]+)<\/code>/)?.[1];
  assert.ok(link, "the page shows no link");
  assert.match(link, new RegExp(`^${base}/welcome/[\\w-]{24}$`));
  return link;
}

let handed;

test("an admin puts someone down without a number and is given their link, once, to pass on", async () => {
  const before = carried.length;
  const made = await post("/invitations", "zan", { name: "Ivo Kern", then: "link" });
  assert.equal(made.status, 201);
  const page = await made.text();
  handed = issuedOn(page);
  assert.match(page, /A link for <strong>Ivo Kern<\/strong>/);
  assert.match(page, /data-copy="issued-link"/);

  const ivo = numbers.contacts.all().find((each) => each.name === "Ivo Kern");
  assert.equal(ivo.number, null);
  assert.equal(ivo.told, 0);
  assert.ok(ivo.linked_at);
  // the list says how they stand, and does not show the link again
  const list = await read("/invitations", "lillian");
  assert.match(list, /Given a link/);
  assert.match(list, /Their link is good until/);
  assert.ok(!list.includes(pathOf(handed)));
  assert.ok(!everythingKept().includes(handed.split("/").pop()), "a link is kept as it was issued");

  // nothing was sent, and nothing can be: with no number they are passed over by the texts
  assert.equal((await post(`/invitations/${ivo.id}/tell`, "lillian")).status, 409);
  assert.equal((await post("/invitations/tell", "lillian", { which: "first" })).status, 409);
  assert.equal(carried.length, before);

  // someone put down with nothing more is on the list and has no link
  assert.equal(sentTo(await post("/invitations", "zan", { name: "Kit Vale" })), "/invitations?done=added");
  const kit = numbers.contacts.all().find((each) => each.name === "Kit Vale");
  assert.equal(kit.link_until, null);
  assert.match(await read("/invitations", "zan"), /Not invited yet/);
  // a number given them later is kept as any is, and taken away again by leaving it empty
  await post(`/invitations/${kit.id}`, "zan", { name: "Kit Vale", number: "415 555 0110", place: "99" });
  assert.equal(numbers.open(numbers.contacts.byId(kit.id).number), "+14155550110");
  await post(`/invitations/${kit.id}`, "zan", { name: "Kit Vale", number: "", place: "99" });
  assert.equal(numbers.contacts.byId(kit.id).number, null);
  assert.equal(numbers.contacts.byId(kit.id).number_mark, null);
  assert.equal(sentTo(await post(`/invitations/${kit.id}/remove`, "zan")), "/invitations?done=removed");

  // a new link ends the one before it
  const again = await post(`/invitations/${ivo.id}/link`, "lillian");
  assert.equal(again.status, 200);
  const newer = issuedOn(await again.text());
  assert.notEqual(newer, handed);
  assert.equal((await get(pathOf(handed))).status, 404);
  assert.equal((await get(pathOf(newer))).status, 200);
  handed = newer;

  // who did what is on the record, by name and never by number
  const record = adminLog.latest(50).filter((entry) => entry.action.startsWith("invite-"));
  const did = (action, by, detail) => record.some((entry) => entry.action === action && entry.by_username === by && entry.detail === detail);
  assert.ok(did("invite-added", "zan", "Ivo Kern"));
  assert.ok(did("invite-link", "zan", "Ivo Kern"));
  assert.ok(did("invite-link", "lillian", "Ivo Kern"));
  assert.ok(did("invite-removed", "zan", "Kit Vale"));
  assert.ok(did("invite-texts", "lillian", "the announcement to 3 people"));
  for (const entry of record) assert.doesNotMatch(entry.detail ?? "", /\d{4}/);
});

test("a link passed on by hand is taken up as one in a text is, and whoever came by it is not asked about texts", async () => {
  const welcome = await get(pathOf(handed));
  assert.match(await welcome.text(), /Welcome, Ivo Kern/);
  const taken = await post(pathOf(handed), null, { username: "ivo", password: "some other four words" });
  assert.equal(sentTo(taken), `/p/${centre}`);
  const cookie = taken.headers.get("set-cookie").split(";")[0];
  const ivo = users.byUsername("ivo");
  assert.equal(ivo.name, "Ivo Kern");
  assert.equal(ivo.role, "member");
  people.ivo = { id: ivo.id, cookie, csrf: auth.findSession(cookie.split("=")[1]).csrf };

  // spent, and there is no making another for someone who is in
  assert.equal((await get(pathOf(handed))).status, 404);
  const contact = numbers.contacts.byUser(ivo.id);
  assert.ok(contact.accepted_at);
  assert.equal((await post(`/invitations/${contact.id}/link`, "zan")).status, 409);
  const list = await read("/invitations", "zan");
  assert.match(list, /Taken up/);
  assert.doesNotMatch(list, new RegExp(`action="/invitations/${contact.id}/link"`));

  // no number is kept for them, so there are no texts to ask for
  assert.doesNotMatch(await read("/account", "ivo"), /Receive texts/);
  assert.equal((await post("/account/texts", "ivo", { texts: "all" })).status, 404);
});

test("a text that does not go leaves the link someone was handed as it was, and one that goes takes its place", async () => {
  const jo = await putDown("Jo Pell", "+14155550109");
  const first = issuedOn(await (await post(`/invitations/${jo.id}/link`, "zan")).text());
  assert.equal(numbers.contacts.byId(jo.id).told, 0);
  // holding a link, they are passed over when the announcement goes to everyone, and can be texted by themselves
  assert.doesNotMatch(await read("/invitations", "zan"), /Text the announcement to/);
  assert.equal((await post("/invitations/tell", "zan", { which: "first" })).status, 409);
  assert.equal(carried.filter((each) => each.to === "+14155550109").length, 0);

  refusals.set("+14155550109", 30007);
  const refused = await post(`/invitations/${jo.id}/tell`, "zan");
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /took it for spam/);
  assert.equal((await get(pathOf(textTo("+14155550109").link))).status, 404);
  assert.equal((await get(pathOf(first))).status, 200);

  refusals.delete("+14155550109");
  assert.equal(sentTo(await post(`/invitations/${jo.id}/tell`, "zan")), "/invitations?done=told");
  assert.equal((await get(pathOf(first))).status, 404);
  assert.equal((await get(pathOf(textTo("+14155550109").link))).status, 200);
  // a link made by hand is not a text: they have been texted once, and can be once more
  assert.equal(numbers.contacts.byId(jo.id).told, 1);
  assert.match(await read("/invitations", "zan"), /Text once more/);
});

/* ------------------------------------------------------- nothing gives a number away */

test("no number is kept as it is, said by the server, or shown on any page but the admins' own", async () => {
  const all = ["0101", "0113", "0104", "0105", "0106", "0107", "0102", "0103", "0190", "0109", "0110"].map((end) => `415555${end}`);

  // not in the database, nor in anything beside it
  const kept = everythingKept();
  // (it is the forum's own database that is read here: the names are in it, as they were typed)
  assert.ok(kept.includes("Cy Vane-Holt"));
  for (const number of all) assert.ok(!kept.includes(number), `${number} is in what the forum keeps`);
  // not what a link was either: only what it comes to
  for (const { body } of carried) {
    const token = body.match(/\/welcome\/([\w-]+)/)?.[1];
    if (token) assert.ok(!kept.includes(token), "a link is kept as it was sent");
  }
  // nor in anything the server has said
  for (const number of all) assert.ok(!output.includes(number), `${number} is in what the server said`);

  // nor on any page anyone else can ask for: a sub-admin, a member who came by a text, one who came by a link
  const piece = posts.create({ authorId: people.lillian.id, title: "Ordinary", body: "A page like any other.", status: "published" });
  const pages = ["/", "/corpus", "/members", "/account", `/p/${piece}`, "/m/ada.quill", "/search?q=415", "/search?q=Quill", "/submit"];
  for (const who of ["mira", "ada", "ivo"]) {
    for (const path of [...pages, "/invitations"]) {
      const page = await read(path, who);
      for (const number of all) assert.ok(!page.includes(number), `${number} is on ${path} for ${who}`);
      assert.doesNotMatch(page, /\+1415|Cy Vane|Fay Orr|Gil Roe|Jo Pell/, `${path} for ${who}`);
    }
  }
  // nor, for an admin, anywhere but the list
  for (const path of pages) {
    const page = await read(path, "zan");
    for (const number of all) assert.ok(!page.includes(number), `${number} is on ${path} for zan`);
    assert.doesNotMatch(page, /\+1415|Cy Vane|Fay Orr|Gil Roe|Jo Pell/, `${path} for zan`);
  }
  // and the list shows an admin the ends of them, and no more
  for (const who of ["lillian", "zan"]) {
    const list = await read("/invitations", who);
    for (const number of all) assert.ok(!list.includes(number));
    assert.match(list, /•+ 0113/);
  }
});

test("without a key no number is taken, and without a texting account nothing is sent; a link can still be made and taken up", async () => {
  const port = await freePort();
  const bare = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: scratch,
      PUBLIC_URL: "",
      LATEX: "off",
      PACE: "off",
      INVITATIONS: "on",
      NUMBERS_KEY: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      TWILIO_FROM: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((ready, fail) => {
      bare.once("error", fail);
      bare.once("exit", (code) => fail(new Error(`the second server stopped early (${code})`)));
      bare.stdout.on("data", (chunk) => String(chunk).includes("listening") && ready());
    });
    const at = `http://127.0.0.1:${port}`;
    const ask = (path, fields) => {
      const headers = { Origin: at, Cookie: people.lillian.cookie };
      if (!fields) return fetch(at + path, { redirect: "manual", headers });
      return fetch(at + path, { method: "POST", redirect: "manual", headers, body: new URLSearchParams({ ...fields, _csrf: people.lillian.csrf }) });
    };
    const page = await ask("/invitations");
    assert.equal(page.status, 200);
    const said = await page.text();
    assert.match(said, /NUMBERS_KEY is not set/);
    // those on the list are named, but nothing of a number is shown, since none can be read, and there is nowhere to type one
    assert.match(said, /Cy Vane/);
    assert.match(said, /<td class="numbers__number">sealed<\/td>/);
    assert.doesNotMatch(said, /•|name="number"|\/tell"/);
    const before = numbers.contacts.count();
    assert.equal((await ask("/invitations", { name: "Hal Ives", number: "+14155550108" })).status, 422);
    assert.equal((await ask("/invitations/tell", { which: "first" })).status, 409);
    assert.equal(numbers.contacts.count(), before);
    // someone whose number is sealed can be renamed, and their number is as it was
    const cy = numbers.contacts.all().find((each) => each.name === "Cy Vane-Holt");
    const edit = await (await ask(`/invitations/${cy.id}`)).text();
    assert.doesNotMatch(edit, /name="number"|0113/);
    await ask(`/invitations/${cy.id}`, { name: "Cy Vane-Holt", place: "1" });
    assert.equal(numbers.open(numbers.contacts.byId(cy.id).number), "+14155550113");

    // a link needs neither a key nor a texting account
    const made = await ask("/invitations", { name: "Hal Ives", then: "link" });
    assert.equal(made.status, 201);
    const link = (await made.text()).match(/<code id="issued-link">([^<]+)<\/code>/)?.[1];
    assert.match(link, new RegExp(`^${at}/welcome/[\\w-]{24}$`));
    assert.match(await (await fetch(link)).text(), /Welcome, Hal Ives/);
    const taken = await fetch(link, { method: "POST", redirect: "manual", headers: { Origin: at }, body: new URLSearchParams({ username: "hal", password: "four words for hal ives" }) });
    assert.equal(taken.status, 303);
    assert.equal(users.byUsername("hal").name, "Hal Ives");
    // a member who came by an invitation is not asked about texts that cannot be sent
    const account = await fetch(`${at}/account`, { headers: { Cookie: people.ada.cookie } });
    assert.doesNotMatch(await account.text(), /Receive texts/);
  } finally {
    bare.removeAllListeners("exit");
    const gone = new Promise((done) => bare.once("exit", done));
    bare.kill();
    await gone;
  }
});
