/*
 * The portal's pages. Each is plain HTML made here from what the portal
 * found out; the little script in public/portal.js only follows a job's
 * output as it comes, asks before anything that cannot be undone, and
 * copies a password.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SERVER_ROOT } from "../src/config.mjs";
import { FORUMS } from "./forums.mjs";

/* ------------------------------------------------------------------ html */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Markup {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

function interpolate(value) {
  if (value instanceof Markup) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

/** HTML in which everything put in is escaped, unless it is itself HTML made this way */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => (out += interpolate(value) + strings[i + 1]));
  return new Markup(out);
}

/* files are cached hard by the browser, so their address changes with them */
const stamp = (path) => createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 10);
const shared = (...path) => `/assets/${path.join("/")}?v=${stamp(join(REPO_ROOT, "assets", ...path))}`;
const own = (file) => `/static/${file}?v=${stamp(join(SERVER_ROOT, "portal", "public", file))}`;

/* the token every form carries back, set once when the portal starts */
let csrf = "";
export const setCsrf = (token) => {
  csrf = token;
};
const csrfField = () => html`<input type="hidden" name="_csrf" value="${csrf}" />`;

/* ----------------------------------------------------------------- words */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** when something happened, as one says it: "5 minutes ago", "yesterday", "3 Nov 2026" */
export function ago(iso, at = Date.now()) {
  const then = Date.parse(iso);
  if (!iso || Number.isNaN(then)) return "never";
  const minutes = Math.round((at - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const date = new Date(then);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const when = (iso) =>
  iso ? html`<time datetime="${iso}" title="${iso.replace("T", " ").replace(/\.\d+Z$/, " UTC")}">${ago(iso)}</time>` : "never";

const size = (bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------------------------------------------------------------- pieces */

const NAV = [
  ["overview", "/", "Overview"],
  ["fly", "/fly", "Fly.io"],
  ["domain", "/domain", "Domain"],
  ["members", "/members", "Members"],
  ["activity", "/activity", "Activity"],
];

/** the frame every page is set in; `at` is which part of the portal it belongs to */
export function page({ title, at = "", body, wide = false }) {
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>${title} · Gesserit admin</title>
    <link rel="stylesheet" href="${shared("fonts", "eb-garamond.css")}" />
    <link rel="stylesheet" href="${shared("palette.css")}" />
    <link rel="stylesheet" href="${own("portal.css")}" />
    <script src="${own("portal.js")}" defer></script>
  </head>
  <body>
    <header class="top">
      <a class="top__mark" href="/">Gesserit <span>admin portal</span></a>
      <nav class="top__nav" aria-label="Portal">
        ${NAV.map(([key, href, name]) => html`<a href="${href}"${key === at ? html` aria-current="page"` : ""}>${name}</a>`)}
      </nav>
    </header>
    <main class="main${wide ? " main--wide" : ""}">${body}</main>
    <footer class="foot">
      This portal runs on your machine and answers only to it. Close it with Ctrl+C in the terminal it was started from.
    </footer>
  </body>
</html>`.toString();
}

/** something said once at the head of a page: that a thing was done, or why it was not */
export const notice = (said) =>
  said?.text && html`<p class="notice notice--${said.kind === "error" ? "error" : "well"}" role="${said.kind === "error" ? "alert" : "status"}">${said.text}</p>`;

/** a password that was just issued, shown this once */
const issuedBox = (issued, where) =>
  issued &&
  html`<section class="issued" role="status">
    <h2>${issued.fresh ? "Added" : "New password for"} ${issued.name}</h2>
    <dl>
      <dt>Sign-in name</dt>
      <dd><code>${issued.username}</code></dd>
      <dt>Password</dt>
      <dd><code id="issued-password">${issued.password}</code> <button class="button button--quiet" type="button" data-copy="issued-password">Copy</button></dd>
    </dl>
    <p>
      This is shown once and kept nowhere readable: pass it on now. They sign in to ${FORUMS[where].long} with it, and can
      change it on their account page.${issued.fresh ? "" : " They have been signed out wherever they were signed in."}
    </p>
  </section>`;

/** a button that posts: one small form */
const act = (action, label, { fields = {}, kind = "", confirm = "" } = {}) =>
  html`<form class="act" method="post" action="${action}">
    ${csrfField()}${Object.entries(fields).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`)}
    <button class="button${kind && ` button--${kind}`}" type="submit"${confirm && html` data-confirm="${confirm}"`}>${label}</button>
  </form>`;

/** what a command printed, as it printed it */
const output = (text, empty = "It said nothing.") =>
  html`<pre class="output" tabindex="0">${String(text ?? "").trim() || empty}</pre>`;

const external = (href, label) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** which forum a page is about, and the way to the same page for the other */
const forumTabs = (base, where, query = "") =>
  html`<nav class="tabs" aria-label="Which forum">
    ${Object.values(FORUMS).map(
      (forum) => html`<a href="${base}/${forum.key}${query}"${forum.key === where ? html` aria-current="page"` : ""}>${forum.name}</a>`
    )}
  </nav>`;

/** why a forum could not be asked, and what would change that */
const unreachable = (reply, where) =>
  html`<section class="panel panel--quiet">
    <p class="notice notice--error" role="alert">${reply.error}</p>
    ${where === "fly"
      ? html`<p>The <a href="/">overview</a> shows what is left to do before the forum on Fly.io can be managed from here.</p>`
      : html`<p>The forum on this machine keeps its database in <code>server/data</code>. It need not be running to be managed.</p>`}
    ${reply.said && html`<details><summary>What it said</summary>${output(reply.said)}</details>`}
  </section>`;

/* -------------------------------------------------------------- overview */

/** a forum at a glance, from its own account of itself */
function glance(forum, { where, url }) {
  const { members, writing, storage } = forum;
  return html`<dl class="figures">
      <div><dt>Members</dt><dd>${members.active}</dd></div>
      <div><dt>Admins</dt><dd>${members.admins}</dd></div>
      <div><dt>Sub-admins</dt><dd>${members.subAdmins}</dd></div>
      <div><dt>Here now</dt><dd>${members.here}</dd></div>
      <div><dt>Posts</dt><dd>${writing.posts}</dd></div>
      <div><dt>Notes</dt><dd>${writing.notes}</dd></div>
      <div><dt>Messages</dt><dd>${writing.messages}</dd></div>
      <div><dt>Projects</dt><dd>${writing.projects}</dd></div>
    </dl>
    <p class="small">
      ${forum.mainAdmin ? html`Main admin: ${forum.mainAdmin.name}. ` : html`<strong>No admin yet.</strong> `}Last activity
      ${when(forum.latest)}. Database ${size(storage.database)}${storage.pictures > 0 ? `, pictures ${size(storage.pictures)}` : ""}.
      Diagrams are ${forum.diagrams ? "drawn" : "shown as source (no LaTeX there)"}.
    </p>
    <p class="links">
      <a href="/members/${where}">Members</a> <a href="/activity/${where}">Activity</a> ${url && external(url, "Open the forum")}
    </p>`;
}

const STEP_TITLES = {
  tool: "Install the fly program",
  account: "Sign in to Fly.io",
  app: "Create the app",
  deploy: "Deploy the forum",
  live: "The forum answers",
  admin: "Make its first admin",
  domain: "Connect the domain",
};

const STATE_WORDS = { done: "Done", next: "Next", wait: "Waiting", unsure: "Could not tell", later: "" };

/** what each step says for itself, and the button that does it when it is the one to do */
function stepBody(key, state, found, { brew }) {
  const todo = state === "next" || state === "unsure" || state === "wait";
  switch (key) {
    case "tool":
      if (state === "done") return html`<p><code>${found.tool}</code></p>`;
      return html`<p>
          <code>fly</code> is the program Fly.io gives its customers; the portal works through it.
          ${brew ? "" : html`Install it with <code>curl -L https://fly.io/install.sh | sh</code>, then reload this page.`}
        </p>
        ${brew && act("/fly/install", "Install it with Homebrew", { kind: "main" })}`;
    case "account":
      if (state === "done") return html`<p>Signed in as ${found.account}.</p>`;
      if (!todo) return html`<p>An account at Fly.io, which asks for a card. This is where the forum is paid for.</p>`;
      return html`<p>
          Your browser opens on Fly.io's own page, where you sign in, or make an account and give it a card. The portal never
          sees your password.
        </p>
        ${found.accountSaid && output(found.accountSaid)} ${act("/fly/login", "Sign in to Fly.io", { kind: "main" })}`;
    case "app":
      if (state === "done") return html`<p><code>${found.app}</code>, in <code>${found.region}</code>.</p>`;
      if (!todo) return html`<p>The forum's place on Fly.io, called <code>${found.app}</code>.</p>`;
      return html`<p>
          The forum's place on Fly.io. It will be called <code>${found.app}</code> and live in <code>${found.region}</code>;
          both can be changed on the <a href="/fly">Fly.io page</a> first.
        </p>
        ${state === "unsure" && output(found.existsSaid)}
        <form class="act act--fields" method="post" action="/fly/create">
          ${csrfField()}
          <label>Organisation <input name="org" value="personal" size="14" autocapitalize="none" spellcheck="false" /></label>
          <button class="button button--main" type="submit">Create ${found.app}</button>
        </form>`;
    case "deploy":
      if (state === "done") return html`<p>${plural(found.machines ?? 1, "machine")}, with the forum's data on a volume of its own.</p>`;
      if (!todo) return html`<p>Builds the forum from this folder and starts it on one small machine.</p>`;
      return html`<p>
          Builds the forum from this folder and starts it on one small machine, with a 1 GB volume for what members write.
          The first time takes a few minutes.
        </p>
        ${act("/fly/deploy", "Deploy the forum", { kind: "main" })}`;
    case "live":
      if (state === "done") return html`<p>${external(found.flyDev, found.flyDev.replace("https://", ""))}</p>`;
      if (!todo) return html`<p>At its first address, <code>${found.app}.fly.dev</code>.</p>`;
      return html`<p>
        It has been deployed but does not answer yet at ${external(found.flyDev, found.flyDev.replace("https://", ""))}. Give
        it a minute and reload; if it stays so, the <a href="/fly">Fly.io page</a> has its status and what it logged.
      </p>`;
    case "admin":
      if (state === "done")
        return html`<p>${plural(found.forum.members.admins, "admin")}${found.forum.mainAdmin ? html`; ${found.forum.mainAdmin.name} is the main one` : ""}.</p>`;
      if (!todo) return html`<p>Yourself, to begin with. Everyone else can be added from the forum, or from here.</p>`;
      return html`<p>
          The forum starts with nobody in it. Add yourself as an admin; the password is shown once.
          ${found.forumSaid && html`<br /><em>${found.forumSaid}</em>`}
        </p>
        <p><a class="button button--main" href="/members/fly">Add the first admin</a></p>`;
    case "domain":
      if (state === "done") return html`<p>${external(`https://${found.host}`, found.host)}</p>`;
      if (!todo) return html`<p>So that members reach it at <code>${found.host || "a name of your own"}</code>.</p>`;
      return html`<p>
          ${state === "wait"
            ? html`Fly.io knows of <code>${found.host}</code>, but the forum does not answer there yet: the DNS record is still to be added, or has not spread.`
            : html`So that members reach it at <code>${found.host}</code> and not only at its fly.dev address.`}
        </p>
        <p><a class="button button--main" href="/domain">${state === "wait" ? "See what is needed" : "Connect the domain"}</a></p>`;
    default:
      return "";
  }
}

export function overviewPage({ found, steps, here, hereRunning, hereUrl, jobs, brew, said }) {
  const allDone = steps.every((step) => step.state === "done");
  return page({
    title: "Overview",
    at: "overview",
    body: html`
      ${notice(said)}
      <section class="panel">
        <header class="panel__head">
          <h1>${allDone ? "The forum is on Fly.io" : "Putting the forum on Fly.io"}</h1>
          <a class="button button--quiet" href="/?fresh=1">Check again</a>
        </header>
        ${found.tomlMissing && html`<p class="notice notice--error">There is no fly.toml beside the forum, so the portal does not know what the app is called.</p>`}
        <ol class="steps">
          ${steps.map(
            ({ key, state }, i) => html`<li class="step step--${state}">
              <span class="step__n" aria-hidden="true">${state === "done" ? "✓" : i + 1}</span>
              <div class="step__body">
                <h2>${STEP_TITLES[key]} ${STATE_WORDS[state] && html`<span class="tag tag--${state}">${STATE_WORDS[state]}</span>`}</h2>
                ${stepBody(key, state, found, { brew })}
              </div>
            </li>`
          )}
        </ol>
      </section>

      <div class="pair">
        <section class="panel">
          <h2>The forum on Fly.io</h2>
          ${found.forum
            ? glance(found.forum, { where: "fly", url: found.custom?.ok ? `https://${found.host}` : found.flyDev })
            : html`<p class="muted">${found.live?.ok ? found.forumSaid || "It answers, but could not be asked about itself." : "Not there yet. The steps above lead to it."}</p>`}
        </section>
        <section class="panel">
          <h2>The forum on this machine</h2>
          ${here.ok
            ? html`${glance(here, { where: "here", url: hereRunning ? hereUrl : "" })}
                <p class="small">
                  ${hereRunning
                    ? html`Running at ${external(hereUrl, hereUrl.replace("http://", ""))}.`
                    : html`Not running. Start it with <code>npm start</code> in <code>server/</code>; it can be managed here either way.`}
                </p>`
            : html`<p class="muted">${here.error}</p>`}
        </section>
      </div>

      ${jobs.length > 0 &&
      html`<section class="panel">
        <h2>What the portal has run</h2>
        <ul class="jobs">
          ${jobs.map(
            (job) => html`<li>
              <a href="/jobs/${job.id}">${job.title}</a>
              <span class="tag tag--${job.status === "done" ? "done" : job.status === "failed" ? "failed" : "wait"}">${job.status === "done" ? "Done" : job.status === "failed" ? "Failed" : "Running"}</span>
              <span class="muted">${when(job.startedAt)}</span>
            </li>`
          )}
        </ul>
      </section>`}
    `,
  });
}

/* ---------------------------------------------------------------- fly.io */

export function flyPage({ found, panels, volumes, said }) {
  const ready = found.account && found.exists;
  return page({
    title: "Fly.io",
    at: "fly",
    body: html`
      ${notice(said)}
      <section class="panel">
        <header class="panel__head">
          <h1>Fly.io</h1>
          <span class="links">
            ${external("https://fly.io/dashboard", "Fly.io dashboard")} ${external("https://fly.io/dashboard/personal/billing", "Billing")}
          </span>
        </header>
        <p>
          ${!found.tool
            ? html`The <code>fly</code> program is not installed yet. The <a href="/">overview</a> has the button for it.`
            : found.account
              ? html`Signed in as <strong>${found.account}</strong>.`
              : html`Not signed in. The <a href="/">overview</a> has the button for it.`}
        </p>
        ${found.account && html`<div class="row">${act("/fly/logout", "Sign out of Fly.io", { kind: "quiet", confirm: "Sign this machine out of Fly.io? The forum there keeps running." })}</div>`}
      </section>

      <section class="panel">
        <h2>The app</h2>
        <form class="form form--inline" method="post" action="/fly/settings">
          ${csrfField()}
          <label for="app">Name</label>
          <input id="app" name="app" value="${found.app}" required pattern="[a-z0-9][a-z0-9\\-]*[a-z0-9]" maxlength="63" autocapitalize="none" spellcheck="false" />
          <label for="region">Region</label>
          <input id="region" name="region" value="${found.region}" required pattern="[a-z]{3}" maxlength="3" size="4" autocapitalize="none" spellcheck="false" />
          <button class="button" type="submit">Save to fly.toml</button>
        </form>
        <p class="small">
          The name is also the forum's first address, <code>${found.app}.fly.dev</code>, and names are shared by everyone on
          Fly.io. Region is where the machine is: <code>ewr</code> New Jersey, <code>lhr</code> London, <code>fra</code>
          Frankfurt, <code>sin</code> Singapore; ${external("https://fly.io/docs/reference/regions/", "the rest")}.
          ${found.exists ? html`<strong>The app has been created</strong>: changing either now points the portal at a different app, and the data stays with this one.` : "Choose both before creating the app."}
        </p>
      </section>

      ${ready
        ? html`<section class="panel">
              <header class="panel__head">
                <h2>How it stands</h2>
                <a class="button button--quiet" href="/fly?fresh=1">Check again</a>
              </header>
              ${output(panels.status)}
              <div class="row">
                ${act("/fly/deploy", "Deploy", { kind: "main" })} ${act("/fly/logs", "What it logged")}
                ${act("/fly/restart", "Restart", { confirm: "Restart the forum? It is away for a few seconds." })}
                ${act("/fly/validate", "Check fly.toml")}
              </div>
              <p class="small">
                Deploy publishes what is in this folder now, whether or not it has been pushed to git. The forum is away for a
                few seconds while it restarts; what members have written is on the volume and is not touched.
              </p>
            </section>

            <section class="panel">
              <h2>Addresses</h2>
              ${output(panels.ips, "None yet.")}
              <div class="row">
                ${act("/fly/ips", "Give it a shared IPv4", { fields: { kind: "v4" } })} ${act("/fly/ips", "Give it an IPv6", { fields: { kind: "v6" } })}
              </div>
              <p class="small">The first deploy gives it both. These are only for when the list above is empty.</p>
            </section>

            <section class="panel">
              <h2>Storage and snapshots</h2>
              ${output(panels.volumes, "No volume yet: the first deploy makes one.")}
              ${volumes.map(
                (volume) => html`<div class="row">
                  <code>${volume}</code> ${act("/fly/snapshots", "Its snapshots", { fields: { volume } })}
                  ${act("/fly/snapshot", "Take a snapshot now", { fields: { volume } })}
                </div>`
              )}
              <p class="small">
                The volume holds the database and members' pictures. Fly.io photographs it daily and keeps each snapshot 14
                days; take one by hand before anything you are unsure of.
              </p>
            </section>`
        : html`<section class="panel panel--quiet">
            <p class="muted">
              ${found.account ? "The app has not been created yet." : ""} Its status, addresses and storage show here once it
              is there. The <a href="/">overview</a> has the next step.
            </p>
            ${found.existsSaid && found.exists === null && output(found.existsSaid)}
          </section>`}
    `,
  });
}

/* ---------------------------------------------------------------- domain */

export function domainPage({ found, panels, dns, undeployed = false, said }) {
  const ready = found.account && found.exists;
  // the forum says what address it was deployed with; said only when it names one of its own, since a
  // forum asked over ssh may know no more than its fly.dev address, and that tells nothing
  const deployedWith = found.forum?.publicUrl ?? "";
  const stale = Boolean(found.publicUrl && deployedWith && !deployedWith.endsWith(".fly.dev") && deployedWith !== found.publicUrl);
  return page({
    title: "Domain",
    at: "domain",
    body: html`
      ${notice(said)}
      <section class="panel">
        <h1>Domain</h1>
        <p>
          The forum always answers at <code>${found.app}.fly.dev</code>. To have it at a name of your own as well, Fly.io must
          be told the name, and the name must be pointed at Fly.io where its DNS is kept.
        </p>
        <form class="form form--inline" method="post" action="/domain/connect">
          ${csrfField()}
          <label for="host">The forum's address</label>
          <input id="host" name="host" value="${found.host}" required placeholder="forum.example.org" autocapitalize="none" spellcheck="false" />
          <button class="button button--main" type="submit"${ready ? "" : html` disabled`}>${found.cert ? "Tell Fly.io again" : "Connect"}</button>
        </form>
        ${!ready && html`<p class="small">This works once the app has been created and deployed. The <a href="/">overview</a> has the next step.</p>`}
        ${(stale || undeployed) &&
        html`<p class="notice notice--error">
            fly.toml now says the forum is at <code>${found.publicUrl}</code>, but the forum that is running
            ${stale ? html`was deployed with <code>${deployedWith}</code>` : "has not been deployed since"}. It takes forms, signing
            in among them, only from the address it was deployed with and its fly.dev one: deploy for the new address to work.
          </p>
          ${act("/fly/deploy", "Deploy", { kind: "main" })}`}
      </section>

      ${ready &&
      found.host &&
      html`<section class="panel">
          <header class="panel__head">
            <h2>${found.host}</h2>
            <a class="button button--quiet" href="/domain?fresh=1">Check again</a>
          </header>
          <ul class="checks">
            <li class="check check--${found.cert ? "done" : "next"}">${found.cert ? "Fly.io has been told of it." : "Fly.io has not been told of it yet. Press Connect above."}</li>
            <li class="check check--${dns.points ? "done" : "next"}">
              ${dns.records.length > 0
                ? html`Its DNS now says: ${dns.records.map((record, i) => html`${i > 0 ? ", " : ""}<code>${record}</code>`)}.`
                : "It has no DNS record yet."}
              ${dns.points ? "" : found.cert ? " Add the record below where the domain's DNS is kept." : ""}
            </li>
            <li class="check check--${found.custom?.ok ? "done" : "next"}">
              ${found.custom?.ok
                ? html`The forum answers at ${external(`https://${found.host}`, found.host)}.`
                : "The forum does not answer there yet. After the record is added it can take from a minute to an hour."}
            </li>
          </ul>
        </section>

        ${found.cert &&
        html`<section class="panel">
            <h2>What to add where the domain's DNS is kept</h2>
            ${output(panels.setup)}
            <p class="small">
              This is Fly.io's own word on it. For a name like <code>forum.example.org</code> the usual record is a
              <code>CNAME</code> from <code>forum</code> to <code>${found.app}.fly.dev</code>. Whoever looks after
              <code>${found.host.split(".").slice(-2).join(".")}</code> adds it; nothing else of theirs changes.
            </p>
          </section>
          <section class="panel">
            <h2>The certificate</h2>
            ${output(panels.check)}
            <div class="row">
              ${act("/domain/remove", "Disconnect this domain", { kind: "danger", fields: { host: found.host }, confirm: `Tell Fly.io to stop answering at ${found.host}? The forum keeps its fly.dev address.` })}
            </div>
          </section>`}`}
    `,
  });
}

/* --------------------------------------------------------------- members */

const standingOf = (member) =>
  !member.active ? "Removed" : member.role === "admin" ? (member.main ? "Main admin" : "Admin") : member.permissions.length > 0 ? "Sub-admin" : "Member";

export function membersPage({ where, reply, said, issued, values = {} }) {
  const base = `/members/${where}`;
  const names = reply.ok ? Object.fromEntries(reply.permissions.map((permission) => [permission.key, permission.name])) : {};
  // there is always an admin, so the only one is not offered to be made a member
  const admins = reply.ok ? reply.members.filter((member) => member.active && member.role === "admin").length : 0;
  return page({
    title: "Members",
    at: "members",
    wide: true,
    body: html`
      <header class="head">
        <h1>Members</h1>
        ${forumTabs("/members", where)}
      </header>
      ${notice(said)} ${issuedBox(issued, where)}
      ${!reply.ok
        ? unreachable(reply, where)
        : html`
            ${reply.members.length === 0 &&
            html`<p class="notice notice--well">Nobody is in this forum yet. Add yourself below, as an admin.</p>`}
            <section class="panel">
              <h2>Add someone</h2>
              <form class="form form--inline" method="post" action="${base}/add">
                ${csrfField()}
                <label for="name">Name</label>
                <input id="name" name="name" value="${values.name ?? ""}" required maxlength="80" placeholder="Mira Okafor" />
                <label for="username">Sign-in name</label>
                <input id="username" name="username" value="${values.username ?? ""}" required pattern="[A-Za-z0-9._\\-]{2,32}" placeholder="mira" autocapitalize="none" spellcheck="false" />
                <label for="role">As</label>
                <select id="role" name="role">
                  <option value="member"${reply.members.length === 0 ? "" : html` selected`}>a member</option>
                  <option value="admin"${reply.members.length === 0 ? html` selected` : ""}>an admin</option>
                </select>
                <button class="button button--main" type="submit">Add</button>
              </form>
              <p class="small">A password is made for them and shown once. An admin can do everything in the forum; a member can be given some of that afterwards, as a sub-admin.</p>
            </section>

            ${reply.members.length > 0 &&
            html`<section class="panel panel--flush">
              <table class="table">
                <thead>
                  <tr><th>Name</th><th>Standing</th><th>Signed in</th><th>Wrote</th><th><span class="visually-hidden">What can be done</span></th></tr>
                </thead>
                <tbody>
                  ${reply.members.map((member) => {
                    const to = `${base}/${member.id}`;
                    const admin = member.role === "admin";
                    return html`<tr class="${member.active ? "" : "is-removed"}">
                      <td>
                        <strong>${member.name}</strong><br /><code>${member.username}</code>
                      </td>
                      <td>
                        <span class="tag tag--${!member.active ? "removed" : admin ? "admin" : member.permissions.length > 0 ? "sub" : "member"}">${standingOf(member)}</span>
                        ${member.active && member.permissions.length > 0 && html`<br /><span class="small">${member.permissions.map((key) => names[key] ?? key).join(", ")}</span>`}
                      </td>
                      <td>
                        ${member.signed_in_at ? html`${when(member.signed_in_at)}` : html`<span class="muted">never</span>`}
                        ${member.sessions > 0 && html`<br /><span class="small">${plural(member.sessions, "session")}, last used ${when(member.seen_at)}</span>`}
                      </td>
                      <td class="small">
                        ${member.posts + member.notes + member.messages === 0
                          ? html`<span class="muted">nothing yet</span>`
                          : [member.posts && plural(member.posts, "post"), member.notes && plural(member.notes, "note"), member.messages && plural(member.messages, "message")].filter(Boolean).join(", ")}
                        <br /><a href="/activity/${where}?member=${member.id}">Activity</a>
                      </td>
                      <td class="table__acts">
                        ${act(`${to}/password`, "New password", { confirm: `Give ${member.name} a new password? The one they have stops working, and they are signed out everywhere.` })}
                        ${member.active && !admin && html`<a class="button" href="${to}/permissions">${member.permissions.length > 0 ? "Permissions" : "Make sub-admin"}</a>`}
                        ${member.active && !admin && act(`${to}/role`, "Make admin", { fields: { role: "admin" }, confirm: `Make ${member.name} an admin? An admin can do everything in the forum.` })}
                        ${admin && (admins > 1 || !member.active) && act(`${to}/role`, "Make member", { fields: { role: "member" }, confirm: `Make ${member.name} a member again? They lose everything an admin can do.` })}
                        ${admin && member.active && !member.main && act(`${to}/main`, "Make main admin", { confirm: `Name ${member.name} the main admin? What the main admin publishes is the canon.` })}
                        ${member.sessions > 0 && act(`${to}/sign-out`, "Sign out", { confirm: `Sign ${member.name} out everywhere? They can sign in again with their password.` })}
                        ${member.active
                          ? !admin && act(`${to}/remove`, "Remove", { kind: "danger", confirm: `Remove ${member.name}? They can no longer sign in. What they wrote stays, and they can be restored.` })
                          : act(`${to}/restore`, "Restore")}
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </section>`}
          `}
    `,
  });
}

export function permissionsPage({ where, member, permissions }) {
  return page({
    title: `What ${member.name} may do`,
    at: "members",
    body: html`
      <section class="panel">
        <p class="small"><a href="/members/${where}">Members of ${FORUMS[where].long}</a></p>
        <h1>What ${member.name} may do</h1>
        <p>
          A sub-admin is a member who has been given some of what an admin may do. Tick what ${member.name} is to have; with
          nothing ticked they are a member and nothing more.
        </p>
        <form class="form" method="post" action="/members/${where}/${member.id}/permissions">
          ${csrfField()}
          <fieldset class="grants">
            <legend class="visually-hidden">Permissions</legend>
            ${permissions.map(
              (permission) => html`<label class="grant">
                <input type="checkbox" name="can" value="${permission.key}"${member.permissions.includes(permission.key) ? html` checked` : ""} />
                <span><strong>${permission.name}</strong><br /><span class="small">${permission.says}</span></span>
              </label>`
            )}
          </fieldset>
          <div class="row">
            <button class="button button--main" type="submit">Save</button> <a class="button button--quiet" href="/members/${where}">Cancel</a>
          </div>
        </form>
      </section>
    `,
  });
}

/* -------------------------------------------------------------- activity */

const quoted = (title) => (title ? html`“${title}”` : "a short text");

/** what a member did, in words; `link` makes a title lead to the thing in the forum where there is a way there */
function deed(event, link) {
  const post = event.post_id && link ? html`<a href="${link}/p/${event.post_id}" target="_blank" rel="noopener noreferrer">${quoted(event.title)}</a>` : quoted(event.title);
  switch (event.kind) {
    case "published":
      return html`published ${post}`;
    case "revised":
      return html`revised ${post}`;
    case "noted":
      return html`left a margin note on ${post}`;
    case "replied":
      return html`replied to a note on ${post}`;
    case "said":
      return event.detail === "project"
        ? html`wrote in the room of the project “${event.place}”`
        : event.detail === "direct"
          ? "wrote in a private conversation"
          : "wrote in the common room";
    case "page":
      return html`saved the page “${event.title}” in the project “${event.place}”`;
    case "suggested":
      return html`suggested a change to the page “${event.title}” in the project “${event.place}”`;
    case "project":
      return html`started the project “${event.title}”`;
    case "picture":
      return "uploaded a picture";
    case "signed-in":
      return html`signed in${event.detail ? ` (${event.detail})` : ""}`;
    case "joined":
      return "was added to the forum";
    default:
      return event.kind;
  }
}

/** what was done to a member, in words */
function doing(entry, names) {
  const who = entry.member_name ?? "someone";
  switch (entry.action) {
    case "added":
      return html`added ${who}${entry.detail ? ` ${entry.detail}` : ""}`;
    case "password":
      return html`gave ${who} a new password`;
    case "removed":
      return html`removed ${who}`;
    case "restored":
      return html`restored ${who}`;
    case "permissions":
      return entry.detail
        ? html`made ${who} a sub-admin: ${entry.detail.split(" ").map((key) => names[key] ?? key).join(", ")}`
        : html`took away what ${who} could do as a sub-admin`;
    case "role":
      return entry.detail === "admin" ? html`made ${who} an admin` : html`made ${who} a member again`;
    case "main":
      return html`named ${who} the main admin`;
    case "renamed":
      return html`gave ${who} that name${entry.detail ? `, who was ${entry.detail}` : ""}`;
    case "signed-out":
      return html`signed ${who} out${entry.detail ? ` of ${entry.detail}` : " everywhere"}`;
    case "paced":
      return html`refused ${who} for a while, who was asking for ${entry.detail ?? "pages"} faster than anyone reads`;
    // what was done with those who are invited, who are not members yet: the detail is their name
    case "invite-added":
      return html`put ${entry.detail ?? "someone"} down to be invited`;
    case "invite-link":
      return html`made a link for ${entry.detail ?? "someone"} to come in by`;
    case "invite-text":
      return html`texted ${entry.detail ?? "someone"} an invitation`;
    case "invite-texts":
      return html`texted ${entry.detail ?? "the announcement to those invited"}`;
    case "invite-removed":
      return html`took ${entry.detail ?? "someone"} off the list of those invited`;
    default:
      return html`${entry.action} ${who}`;
  }
}

export function activityPage({ where, reply, names = {}, link, said }) {
  const of = reply.ok && reply.member;
  const here = `/activity/${where}`;
  const back = of ? `?member=${of.id}` : "";
  return page({
    title: "Activity",
    at: "activity",
    wide: true,
    body: html`
      <header class="head">
        <h1>Activity${of ? html` of ${of.name}` : ""}</h1>
        ${forumTabs("/activity", where)}
      </header>
      ${notice(said)}
      ${!reply.ok
        ? unreachable(reply, where)
        : html`
            ${of && html`<p class="small"><a href="${here}">Everyone’s activity</a> · <a href="/members/${where}">Members</a></p>`}
            <section class="panel panel--flush">
              <h2 class="panel__title">Signed in now</h2>
              ${reply.sessions.length === 0
                ? html`<p class="muted pad">Nobody is signed in.</p>`
                : html`<table class="table">
                    <thead><tr><th>Member</th><th>Browser</th><th>Signed in</th><th>Last used</th><th><span class="visually-hidden">End it</span></th></tr></thead>
                    <tbody>
                      ${reply.sessions.map(
                        (session) => html`<tr>
                          <td><a href="${here}?member=${session.user_id}">${session.name}</a></td>
                          <td>${session.agent || "A browser"}</td>
                          <td>${when(session.created_at)}</td>
                          <td>${when(session.seen_at)}</td>
                          <td class="table__acts">
                            ${act(`/members/${where}/${session.user_id}/sign-out`, "End", { fields: { session: session.id, back: `${here}${back}` }, confirm: `End this session of ${session.name}? They can sign in again with their password.` })}
                          </td>
                        </tr>`
                      )}
                    </tbody>
                  </table>`}
            </section>

            <div class="pair pair--uneven">
              <section class="panel">
                <h2>What ${of ? of.name : "members"} did</h2>
                ${reply.events.length === 0
                  ? html`<p class="muted">Nothing yet.</p>`
                  : html`<ol class="feed">
                      ${reply.events.map(
                        (event) => html`<li>
                          <span class="feed__when">${when(event.at)}</span>
                          <span>${of ? "" : html`<a href="${here}?member=${event.user_id}">${event.name}</a> `}${deed(event, link)}</span>
                        </li>`
                      )}
                    </ol>`}
                <p class="small">Titles are shown, never what was written; what is said in a conversation is only counted. Drafts are nobody’s business until they are published.</p>
              </section>
              <section class="panel">
                <h2>What was done to ${of ? of.name : "members"}</h2>
                ${reply.log.length === 0
                  ? html`<p class="muted">Nothing yet.</p>`
                  : html`<ol class="feed">
                      ${reply.log.map(
                        (entry) => html`<li>
                          <span class="feed__when">${when(entry.at)}</span>
                          <span>${entry.by_name ? html`<strong>${entry.by_name}</strong>` : html`<em>From the server</em>`} ${doing(entry, names)}</span>
                        </li>`
                      )}
                    </ol>`}
                <p class="small">Every member added, removed, restored, given a password or made an admin or sub-admin, everyone invited by a link or a text, and by whom. “From the server” is this portal or the command line.</p>
              </section>
            </div>
          `}
    `,
  });
}

/* ------------------------------------------------------------------ jobs */

export function jobPage({ job }) {
  const state = job.status === "done" ? "done" : job.status === "failed" ? "failed" : "wait";
  return page({
    title: job.title,
    at: "",
    wide: true,
    body: html`
      <section class="panel" id="job" data-job="${job.id}" data-status="${job.status}" data-at="${job.dropped + job.output.length}">
        <header class="panel__head">
          <h1>${job.title}</h1>
          <span class="tag tag--${state}" id="job-state">${job.status === "done" ? "Done" : job.status === "failed" ? "Failed" : "Running"}</span>
        </header>
        <p class="small">
          What the portal runs here, as you would at a terminal:
          ${job.commands.map((command) => html`<br /><code>${command}</code>`)}
        </p>
        <pre class="output output--live" id="job-output" tabindex="0">${job.output}</pre>
        <p class="notice notice--well" id="job-done"${job.status === "done" ? "" : html` hidden`}>Done.</p>
        <p class="notice notice--error" id="job-failed"${job.status === "failed" ? "" : html` hidden`}>
          That did not go through. What it said is above; nothing else was changed.
        </p>
        <div class="row">
          <a class="button button--main" id="job-back" href="${job.back}"${job.status === "running" ? html` hidden` : ""}>${job.backLabel}</a>
          <span id="job-stop"${job.status === "running" ? "" : html` hidden`}>${act(`/jobs/${job.id}/stop`, "Stop", { kind: "quiet", confirm: "Stop this now?" })}</span>
        </div>
      </section>
    `,
  });
}

/* ---------------------------------------------------------------- errors */

export const errorPage = ({ status, message }) =>
  page({
    title: "Something went wrong",
    body: html`<section class="panel">
      <h1>${status === 404 ? "There is no such page" : "That did not work"}</h1>
      <p>${message}</p>
      <p><a class="button" href="/">Overview</a></p>
    </section>`,
  });

/** what is sent to a browser that came without the portal's key: nothing of the portal */
export const lockedPage = () => `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Gesserit admin portal</title></head>
  <body>
    <h1>Gesserit admin portal</h1>
    <p>Open the portal from the link it printed in the terminal when it started. That link carries the key to it.</p>
  </body>
</html>`;
