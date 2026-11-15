#!/usr/bin/env node
/*
 * Adds a member from the command line, gives an existing one a new
 * password, or names which admin is the main one. This is how the first
 * admin is made; after that, members can be added from the Members page.
 *
 *   npm run add-user -- [--admin] <sign-in name> "<Full Name>"
 *   npm run add-user -- --reset <sign-in name>
 *   npm run add-user -- --main <sign-in name>
 *
 * The main admin is the one whose writing is the canon. Until one is named
 * it is the admin who has been here longest.
 */

import { generatePassword, hashPassword, destroySessionsFor } from "../src/auth.mjs";
import { users } from "../src/db.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const [username, ...rest] = args.filter((arg) => !arg.startsWith("--"));
const name = rest.join(" ").trim();

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error('Usage: npm run add-user -- [--admin] <sign-in name> "<Full Name>"');
  console.error("       npm run add-user -- --reset <sign-in name>");
  console.error("       npm run add-user -- --main <sign-in name>");
  process.exit(1);
}

if (!username) usage();
if (!/^[A-Za-z0-9._-]{2,32}$/.test(username))
  usage("A sign-in name is 2 to 32 letters, digits, dots, dashes or underscores.");

const existing = users.byUsername(username);
const password = generatePassword();

if (flags.has("--main")) {
  if (!existing) usage(`There is no member called "${username}".`);
  if (existing.role !== "admin" || !existing.active)
    usage(`${existing.name} is not an admin, and only an admin can be the main admin.`);
  users.setMain(existing.id);
  console.log(`${existing.name} (${existing.username}) is now the main admin. The canon is what they have published.`);
} else if (flags.has("--reset")) {
  if (!existing) usage(`There is no member called "${username}".`);
  users.setPassword(existing.id, await hashPassword(password));
  destroySessionsFor(existing.id);
  console.log(`New password for ${existing.name} (${existing.username}): ${password}`);
} else {
  if (existing) usage(`"${username}" is taken. Use --reset to give them a new password.`);
  if (!name) usage("Give their full name after the sign-in name.");
  const role = flags.has("--admin") ? "admin" : "member";
  users.create({ username, name, passwordHash: await hashPassword(password), role });
  console.log(`Added ${name} as ${role === "admin" ? "an admin" : "a member"}.`);
  console.log(`  Sign-in name: ${username}`);
  console.log(`  Password:     ${password}`);
  console.log("The password is not stored in readable form; note it now. It can be changed after signing in.");
}
