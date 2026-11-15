/*
 * Passwords, sessions and the sign-in limiter.
 *
 * Passwords are hashed with scrypt. A session is a random token held in an
 * HttpOnly cookie; only its SHA-256 is stored, so a copy of the database does
 * not hand out live sessions.
 */

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.mjs";
import { db, now } from "./db.mjs";

const scryptAsync = promisify(scrypt);

const LOG_N = 15;
const KEY_LENGTH = 64;
const scryptOptions = (logN) => ({ N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 2 ** logN * 8 });

/*
 * Hashing is slow and takes memory on purpose, which makes it something to
 * ask for in bulk in order to tie the server up. Only a few are worked at a
 * time; the rest wait their turn, and past a point are turned away.
 */
const AT_ONCE = 4;
const MOST_WAITING = 64;
let working = 0;
const waiting = [];

export class Busy extends Error {}

async function inTurn(work) {
  if (working >= AT_ONCE) {
    if (waiting.length >= MOST_WAITING) throw new Busy("Too much is being asked at once. Try again in a moment.");
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    working += 1;
  }
  try {
    return await work();
  } finally {
    // the place is handed straight to whoever has waited longest, or given up
    const next = waiting.shift();
    if (next) next();
    else working -= 1;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await inTurn(() => scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, scryptOptions(LOG_N)));
  return `scrypt$${LOG_N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, logN, salt, key] = String(stored).split("$");
  // a hash asking for more work than this server would ever have set is not one of ours
  if (scheme !== "scrypt" || !key || !(Number(logN) >= 10 && Number(logN) <= 20)) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await inTurn(() =>
    scryptAsync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, scryptOptions(Number(logN)))
  );
  return timingSafeEqual(actual, expected);
}

/* the passwords tried first by anyone guessing, at the length asked for here; a longer list would not fit a file */
const TOO_COMMON = new Set(
  `1234567890 12345678910 123456789a 1q2w3e4r5t 1qaz2wsx3edc qwertyuiop qwerty12345 qwerty123456 password12
   password123 password1234 passwordpassword iloveyou12 iloveyou123 letmein123 letmein1234 welcome123 welcome1234
   administrator changeme123 0987654321 abcdefghij abcd123456 a123456789 qazwsxedcrfv zaq12wsxcde3 1111111111
   0000000000 football123 baseball123 superman123 sunshine123 princess123 dragon12345 monkey12345 trustno1234`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * What is the matter with a password someone has chosen, in a sentence, or
 * null if nothing is. With it goes what is known of whose it is: their own
 * names make poor passwords.
 */
export function passwordProblem(password, { username = "", name = "" } = {}, { min = config.minPasswordLength } = {}) {
  if (password.length < min) return `A new password needs at least ${min} characters.`;
  if (password.length > 200) return "Keep the password under 200 characters.";
  const plain = password.normalize("NFKC").toLowerCase();
  if (new Set(plain).size < 4) return "That password is the same few characters over again. Choose one harder to guess.";
  if (TOO_COMMON.has(plain)) return "That password is among the first anyone would try. Choose another.";
  // a password that is the member's own names, however often, with a few characters after them, is still their name
  const letters = (text) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const own = [username, name, ...name.split(/\s+/)]
    .map(letters)
    .filter((word) => word.length >= 3)
    .sort((a, b) => b.length - a.length);
  const rest = own.reduce((left, word) => left.split(word).join(""), letters(password));
  if (own.length > 0 && rest.length < letters(password).length && rest.length < 6)
    return "A password made of your own name is the first thing anyone would try. Choose another.";
  return null;
}

/** spent on unknown usernames, so a wrong name takes as long as a wrong password */
const DUMMY_HASH = await hashPassword(randomBytes(12).toString("hex"));
export const burnPassword = (password) => verifyPassword(password, DUMMY_HASH);

/** a password to hand to someone: three groups, no look-alike characters */
export function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return [group(), group(), group()].join("-");
}

/* -------------------------------------------------------------- sessions */

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

/**
 * What a browser says it is, in a few words ("Safari on iPhone"), so that a
 * member can tell their sessions apart. It is the browser's own word and is
 * only ever shown to the member whose session it is.
 */
export function browserName(agent = "") {
  const browser = /\bEdg(?:e|A|iOS)?\//.test(agent)
    ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(agent)
      ? "Opera"
      : /\bFirefox\/|\bFxiOS\//.test(agent)
        ? "Firefox"
        : /\bChrome\/|\bCriOS\/|\bChromium\//.test(agent)
          ? "Chrome"
          : /\bSafari\//.test(agent)
            ? "Safari"
            : "";
  const device = /\biPhone\b/.test(agent)
    ? "iPhone"
    : /\biPad\b/.test(agent)
      ? "iPad"
      : /\bAndroid\b/.test(agent)
        ? "Android"
        : /\bMac OS X\b|\bMacintosh\b/.test(agent)
          ? "Mac"
          : /\bWindows\b/.test(agent)
            ? "Windows"
            : /\bCrOS\b/.test(agent)
              ? "Chromebook"
              : /\bLinux\b/.test(agent)
                ? "Linux"
                : "";
  return browser && device ? `${browser} on ${device}` : browser || device || "A browser";
}

/** signs a member in; `agent` is the browser's User-Agent, kept only as browserName() makes of it */
export function createSession(userId, agent = "") {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(18).toString("base64url");
  const at = now();
  const expires = new Date(Date.now() + config.sessionDays * DAY).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at, seen_at, agent) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(sha256(token), userId, csrf, at, expires, at, browserName(String(agent)));
  db.prepare("UPDATE users SET signed_in_at = ? WHERE id = ?").run(at, userId);
  return token;
}

/* how stale a session's "last used" may be before it is written again: not on every request */
const SEEN_EVERY = 10 * 60 * 1000;

/** the signed-in member for a cookie token, or null */
export function findSession(token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db
    .prepare(
      `SELECT sessions.rowid AS session_id, sessions.csrf, sessions.seen_at,
              users.id, users.username, users.name, users.role, users.permissions, users.theme
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1`
    )
    .get(tokenHash, now());
  if (!row) return null;
  const { csrf, session_id: id, seen_at: seenAt, ...user } = row;
  if (!seenAt || Date.now() - Date.parse(seenAt) > SEEN_EVERY)
    db.prepare("UPDATE sessions SET seen_at = ? WHERE token_hash = ?").run(now(), tokenHash);
  return { id, tokenHash, csrf, user };
}

export const destroySession = (tokenHash) =>
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);

/** where a member is signed in, the most lately used first: never the tokens, only what tells them apart */
export const sessionsFor = (userId) =>
  db
    .prepare(
      `SELECT rowid AS id, agent, created_at, seen_at FROM sessions
       WHERE user_id = ? AND expires_at > ? ORDER BY seen_at DESC, rowid DESC`
    )
    .all(userId, now());

/** ends one of a member's own sessions; says whether there was such a one */
export const destroySessionOf = (userId, id) =>
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND rowid = ?").run(userId, id).changes > 0;

/** sign a member out everywhere, optionally sparing the session they are using */
export const destroySessionsFor = (userId, exceptTokenHash = "") =>
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, exceptTokenHash);

export const sweepSessions = () => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());

export function csrfMatches(session, submitted) {
  const a = Buffer.from(String(session?.csrf || ""));
  const b = Buffer.from(String(submitted || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------- sign-in limiter */

const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const failures = new Map();

/** whether `key` has failed `most` times within the last quarter of an hour */
export function signInBlocked(key, most = MAX_FAILURES) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW) {
    failures.delete(key);
    return false;
  }
  return entry.count >= most;
}

export function signInFailed(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else entry.count += 1;
  // an unbounded map is its own way in; forget the oldest when it grows
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
}

export const signInSucceeded = (key) => failures.delete(key);

/**
 * What a sign-in attempt is counted against, each with how many failures it
 * is allowed: the name from that address; the address, whatever names it
 * tries; and the name, wherever it is tried from. The first stops one guesser
 * at one account, the second someone trying one password on every name, and
 * the third someone guessing at one account from many addresses.
 */
export const signInCounts = (address, username) => {
  // as the name would be looked up, and no longer than a name can usefully be
  const name = String(username).trim().toLowerCase().slice(0, 64);
  return [
    [`${address}|${name}`, MAX_FAILURES],
    [`from ${address}`, 40],
    [`as ${name}`, 50],
  ];
};
