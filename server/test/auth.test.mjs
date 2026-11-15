import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-test-"));
process.env.DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const auth = await import("../src/auth.mjs");
const { users } = await import("../src/db.mjs");
const { localPath, Router } = await import("../src/http.mjs");

test("a password verifies against its own hash and no other", async () => {
  const hash = await auth.hashPassword("correct horse");
  assert.match(hash, /^scrypt\$15\$/);
  assert.equal(await auth.verifyPassword("correct horse", hash), true);
  assert.equal(await auth.verifyPassword("correct horsf", hash), false);
  assert.equal(await auth.verifyPassword("anything", "not-a-hash"), false);
  assert.notEqual(hash, await auth.hashPassword("correct horse"), "salted");
});

test("generated passwords are three groups of four", () => {
  assert.match(auth.generatePassword(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

test("a session lasts until it is destroyed or its member is removed", async () => {
  const id = users.create({ username: "Mira", name: "Mira", passwordHash: await auth.hashPassword("x") });
  assert.equal(users.byUsername("mira").id, id, "sign-in names ignore case");

  const token = auth.createSession(id);
  const session = auth.findSession(token);
  assert.equal(session.user.id, id);
  assert.equal(session.user.password_hash, undefined, "the hash never travels with the session");
  assert.equal(auth.findSession(token + "x"), null);
  assert.equal(auth.findSession(""), null);

  assert.equal(auth.csrfMatches(session, session.csrf), true);
  assert.equal(auth.csrfMatches(session, ""), false);
  assert.equal(auth.csrfMatches(session, session.csrf + "x"), false);
  assert.equal(auth.csrfMatches(null, ""), false);

  users.setActive(id, false);
  assert.equal(auth.findSession(token), null, "a removed member's session stops working");
  users.setActive(id, true);

  const other = auth.createSession(id);
  auth.destroySessionsFor(id, auth.findSession(other).tokenHash);
  assert.equal(auth.findSession(token), null);
  assert.notEqual(auth.findSession(other), null);
});

test("sign-in attempts are cut off after repeated failures", () => {
  const key = "203.0.113.9|mira";
  for (let i = 0; i < 8; i++) {
    assert.equal(auth.signInBlocked(key), false);
    auth.signInFailed(key);
  }
  assert.equal(auth.signInBlocked(key), true);
  assert.equal(auth.signInBlocked("203.0.113.9|zan"), false);
  auth.signInSucceeded(key);
  assert.equal(auth.signInBlocked(key), false);
});

test("the page to return to after signing in must be on this site", () => {
  assert.equal(localPath("/p/3#note-2"), "/p/3#note-2");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "p/3", "", null, undefined])
    assert.equal(localPath(bad), "/");
});

test("the router matches paths, captures segments and knows a wrong method", () => {
  const router = new Router();
  const handler = () => {};
  router.get("/p/:id", handler);
  router.post("/p/:id/notes", handler);
  assert.deepEqual(router.match("GET", "/p/12").params, { id: "12" });
  assert.deepEqual(router.match("HEAD", "/p/12").params, { id: "12" });
  assert.equal(router.match("GET", "/p/12/extra"), null);
  assert.equal(router.match("GET", "/p/12/notes").methodNotAllowed, true);
  assert.equal(router.match("GET", "/nowhere"), null);
});

test("a hash that asks for more work than any made here is not worked on", async () => {
  const hash = await auth.hashPassword("correct horse");
  const [, , salt, key] = hash.split("$").slice(0, 4);
  assert.equal(await auth.verifyPassword("correct horse", hash.replace("scrypt$15$", "scrypt$40$")), false);
  assert.equal(await auth.verifyPassword("correct horse", hash.replace("scrypt$15$", "scrypt$2$")), false);
  assert.ok(salt && key);
});

test("many passwords at once are all checked, a few at a time", async () => {
  const hash = await auth.hashPassword("correct horse");
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => auth.verifyPassword(i % 2 ? "correct horse" : "wrong", hash)));
  assert.deepEqual(all, Array.from({ length: 12 }, (_, i) => Boolean(i % 2)));
});

test("a password is refused for being short, common, a few characters over, or the member's own name", () => {
  const whose = { username: "mira", name: "Mira Okafor" };
  assert.match(auth.passwordProblem("short", whose), /at least 10 characters/);
  assert.match(auth.passwordProblem("x".repeat(201), whose), /under 200/);
  assert.match(auth.passwordProblem("abababababab", whose), /same few characters/);
  assert.match(auth.passwordProblem("PASSWORD1234", whose), /first anyone would try/);
  assert.match(auth.passwordProblem("１２３４５６７８９０", whose), /first anyone would try/, "however its digits are written");
  assert.match(auth.passwordProblem("Mira.Okafor.1", whose), /your own name/);
  assert.match(auth.passwordProblem("miraokafor2024", whose), /your own name/);
  assert.match(auth.passwordProblem("mira-mira-123", { username: "mira", name: "M" }), /your own name/);
  assert.equal(auth.passwordProblem("mira likes long walks by the sea", whose), null, "a name in a sentence is no weakness");
  assert.equal(auth.passwordProblem("htx8-bqsz-j838", whose), null);
  assert.equal(auth.passwordProblem(auth.generatePassword(), whose), null);
  assert.equal(auth.passwordProblem("correct horse battery", { username: "al", name: "Al" }), null, "two letters are not a name to look for");
  assert.equal(auth.passwordProblem("a long enough one"), null);
});

test("failed sign-ins are counted against the pair, the address and the name", () => {
  const counts = auth.signInCounts("198.51.100.7", "  Mira ");
  assert.deepEqual(counts.map(([key]) => key), ["198.51.100.7|mira", "from 198.51.100.7", "as mira"]);
  assert.deepEqual(counts.map(([, most]) => most), [8, 40, 50]);

  // one address trying many names is stopped, though no one name was tried often
  const address = "198.51.100.8";
  const shut = (name) => auth.signInCounts(address, name).some(([key, most]) => auth.signInBlocked(key, most));
  for (let i = 0; i < 40; i++) {
    assert.equal(shut(`name${i}`), false);
    for (const [key] of auth.signInCounts(address, `name${i}`)) auth.signInFailed(key);
  }
  assert.equal(shut("someone-new"), true);
  assert.equal(auth.signInCounts("198.51.100.9", "someone-new").some(([key, most]) => auth.signInBlocked(key, most)), false);

  // and one name tried from many addresses is stopped too
  for (let i = 0; i < 50; i++) for (const [key] of auth.signInCounts(`203.0.113.${i}`, "Zan")) auth.signInFailed(key);
  assert.equal(auth.signInCounts("192.0.2.1", "zan").some(([key, most]) => auth.signInBlocked(key, most)), true);
});

test("a browser is named in a few words, and nothing else of what it says is kept", async () => {
  const names = {
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1": "Safari on iPhone",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36": "Chrome on Mac",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0": "Edge on Windows",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0": "Firefox on Linux",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36": "Chrome on Android",
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1": "Chrome on iPad",
    "curl/8.4.0": "A browser",
    "": "A browser",
    '<script>alert(1)</script> "Firefox/1"': "Firefox",
  };
  for (const [agent, name] of Object.entries(names)) assert.equal(auth.browserName(agent), name);

  const id = users.create({ username: "noor", name: "Noor", passwordHash: await auth.hashPassword("x") });
  assert.equal(users.byId(id).signed_in_at, null);
  assert.equal(users.byId(id).theme, "night");
  const first = auth.createSession(id, Object.keys(names)[0]);
  const second = auth.createSession(id, "x".repeat(5000));
  assert.match(users.byId(id).signed_in_at, /^\d{4}-\d\d-\d\dT/);
  const listed = auth.sessionsFor(id);
  assert.deepEqual(listed.map((session) => session.agent).sort(), ["A browser", "Safari on iPhone"]);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["agent", "created_at", "id", "seen_at"], "no token, nor anything made from one");

  const mine = auth.findSession(first);
  assert.equal(mine.user.theme, "night");
  assert.equal(auth.destroySessionOf(id + 1000, mine.id), false, "only the member whose session it is can end it");
  assert.notEqual(auth.findSession(first), null);
  assert.equal(auth.destroySessionOf(id, mine.id), true);
  assert.equal(auth.findSession(first), null);
  assert.equal(auth.destroySessionOf(id, mine.id), false);
  assert.notEqual(auth.findSession(second), null);
});
