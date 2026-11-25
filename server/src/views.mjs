/*
 * The pages. Everything goes through the `html` tag, which escapes whatever
 * is interpolated unless it is already markup made by `html` or `raw`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, REPO_ROOT, SERVER_ROOT } from "./config.mjs";
import { wordCount } from "./diff.mjs";
import { markAddress } from "./mark.mjs";
import { can, held, isSubAdmin, PERMISSIONS, scribes, standing } from "./permissions.mjs";
import { clip, escapeHtml, excerpt, renderNote, renderPost, timeTag, typeset } from "./render.mjs";
import { statusName, statusOf, STATUSES } from "./status.mjs";
import { byline, MOST_ANNOTATION, outwardLink, TONES } from "./works.mjs";

class Markup {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const raw = (value) => new Markup(String(value));

function interpolate(value) {
  if (value instanceof Markup) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => (out += interpolate(value) + strings[i + 1]));
  return new Markup(out);
}

/* the stylesheet and scripts are cached hard, so their address changes with them */
const VERSION = ["forum.css", "forum.js", "markdown.js", "editor.js", "corpus.js", "scribe.js", "chat.js", "notify.js", "icon-192.png"]
  .reduce((hash, file) => hash.update(readFileSync(join(SERVER_ROOT, "public", file))), createHash("sha1"))
  .digest("hex")
  .slice(0, 10);

/* what the forum shares with the landing page is served from where it lives, at an address that changes with it */
const shared = (...path) =>
  `/assets/${path.join("/")}?v=${createHash("sha1")
    .update(readFileSync(join(REPO_ROOT, "assets", ...path)))
    .digest("hex")
    .slice(0, 10)}`;

/* one typeface throughout, as on the landing page, and like it served from here: no page asks another site for anything */
const FONTS = shared("fonts", "eb-garamond.css");

/* the colours everything but the text and the paper is drawn in; forum.css says what each is used for */
const PALETTE = shared("palette.css");

/* the leaves that stand either side of the landing page stand either side of a page here: a length of vine, and the flourish it ends in */
const VINE = shared("vine.svg");
const VINE_TIP = shared("vine-tip.svg");

/* how a page can look, and the colour a phone's browser frames each in */
const THEMES = { paper: "#e4d9c4", night: "#0b0a08" };

export const csrfField = (session) => html`<input type="hidden" name="_csrf" value="${session.csrf}" />`;

export const wordmark = html`<span class="initial" data-letter="G" aria-hidden="true">G</span
  ><span aria-hidden="true">esserit</span><span class="visually-hidden">Gesserit</span>`;

export const isAdmin = (session) => session.user.role === "admin";

/** whether the member a page is for may do what a permission allows: an admin, or a sub-admin who holds it */
export const may = (session, permission) => can(session.user, permission);

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** a member's own page */
export const memberHref = (username) => `/m/${encodeURIComponent(username)}`;

/** what to call a post that may have no title: its title, or how it opens */
export const named = (title, opening, length = 60) => title || excerpt(opening, length);

/* ---------------------------------------------------------------- layout */

/**
 * `scripts` names what a page runs besides forum.js; `math` brings the
 * stylesheet and fonts that formulas are set in.
 */
export function shell({ title, body, bodyClass = "", scripts = [], math = false, theme = "paper", session = null }) {
  const look = Object.hasOwn(THEMES, theme) ? theme : "paper";
  // what the scripts of a signed-in page go by: whose it is, which sign-in, and whether that has notifications on
  const whose = session && html` data-me="${session.user.id}" data-session="${session.id}" data-pushed="${session.pushed ? 1 : 0}"`;
  return typeset(html`<!DOCTYPE html>
<html lang="en" data-theme="${look}"${whose}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="theme-color" content="${THEMES[look]}" />
    <meta name="color-scheme" content="${look === "night" ? "dark" : "light"}" />
    <title>${title ? `${title} · Gesserit` : "Gesserit"}</title>
    <link rel="preload" href="/assets/fonts/EBGaramond-Roman-latin.woff2" as="font" type="font/woff2" crossorigin />
    <link href="${FONTS}" rel="stylesheet" />
    ${math && html`<link rel="stylesheet" href="/katex/katex.min.css?v=${VERSION}" />`}
    <link rel="stylesheet" href="${PALETTE}" />
    <link rel="stylesheet" href="/static/forum.css?v=${VERSION}" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/png" sizes="192x192" href="/static/icon-192.png?v=${VERSION}" />
    <link rel="apple-touch-icon" href="/static/icon-180.png?v=${VERSION}" />
    <meta name="apple-mobile-web-app-title" content="Gesserit" />
    ${["forum", ...scripts].map((name) => html`<script src="/static/${name}.js?v=${VERSION}" defer></script>`)}
  </head>
  <body class="${bodyClass}">
    ${body}
  </body>
</html>
`.value);
}

/* the two things at the end of the menu that are done rather than gone to, each drawn small */
const glyph = (paths) =>
  html`<svg class="masthead__glyph" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${raw(paths)}</svg>`;
const GLYPHS = {
  messages: glyph('<path d="M4.5 5.5h15v10.5h-8.2L7 19.6V16H4.5z" /><path d="M8.2 9.4h7.6M8.2 12.2h5" />'),
  signOut: glyph('<path d="M13.5 4.5h-8v15h8" /><path d="M10 12h10.5M17 8.2l3.8 3.8-3.8 3.8" />'),
};

/* which of the places in the menu each page belongs to */
const PLACE = {
  scribe: "scribe",
  write: "scribe",
  search: "scribe",
  projects: "scribe",
  members: "scribe",
  corpus: "corpus",
  post: "corpus",
  canon: "corpus",
  work: "corpus",
  submit: "corpus",
  account: "preferences",
};

/* one side of a page's leaves: the vine between its two flourishes, drawn by the stylesheet */
const vine = (side) =>
  html`<div class="vines__side vines__side--${side}">
    <span class="vines__tip"></span><span class="vines__stem"></span><span class="vines__tip vines__tip--foot"></span>
  </div>`;

/**
 * A signed-in page. `current` names the page this is, which says which entry
 * of the menu it stands under; `width` is "wide" for tables, "full" for the
 * widest of those, "desk" for the page a piece is written on, and "sheet" for
 * the corpus. The formula stylesheet comes with any page that has a formula
 * on it, or with `math`. Every page stands between the leaves of the landing
 * page, where the window has room for them.
 */
export function page({ title, session, main, width = "", current = "", scripts = [], math = false }) {
  const { user } = session;
  // the entry a page stands under is marked; if the page is that entry's own, as the page it is
  const item = (place, own, href, label) =>
    html`<a href="${href}" ${PLACE[current] === place && raw(`aria-current="${current === own ? "page" : "true"}"`)}>${label}</a>`;
  // only those who keep the forum have the page it is kept from; everyone else has the corpus, and comes to it first
  const keeps = scribes(user);
  // where there are messages they are not a place of their own in the menu: they open beside whatever page this is
  const messages = config.messages && html`<a
    class="masthead__icon masthead__messages"
    href="/chat"
    data-messages
    title="Messages"
    ${current === "messages" && raw('aria-current="page"')}
    >${GLYPHS.messages}<span class="visually-hidden">Messages</span><span data-unread
      >${session.unread > 0 &&
      html` <span class="badge" aria-hidden="true">${session.unread > 99 ? "99+" : session.unread}</span
        ><span class="visually-hidden">, ${plural(session.unread, "unread message")}</span>`}</span
    ></a
  >`;
  return shell({
    title,
    scripts: config.messages ? [...scripts, "chat"] : scripts,
    session,
    theme: user.theme || "paper",
    math: math || main.value.includes('class="katex'),
    body: html`
      <a class="skip" href="#main">Skip to the page</a>
      <header class="masthead">
        <a class="masthead__mark" href="${keeps ? "/" : "/corpus"}">${wordmark}</a>
        <nav class="masthead__nav" aria-label="Site">
          ${keeps && item("scribe", "scribe", "/", "Scribe")} ${item("corpus", "corpus", "/corpus", "Corpus")}
          ${item("preferences", "account", "/account", "Preferences")}
        </nav>
        <div class="masthead__you">
          ${messages}
          <form method="post" action="/logout">
            ${csrfField(session)}
            <button class="masthead__icon" type="submit" title="Sign out (${user.name})">
              ${GLYPHS.signOut}<span class="visually-hidden">Sign out</span>
            </button>
          </form>
        </div>
      </header>
      <div class="leaf${width && ` leaf--${width}`}" style="--vine:url(${VINE});--vine-tip:url(${VINE_TIP})">
        <div class="vines" aria-hidden="true">${vine("left")}${vine("right")}</div>
        <main class="column${width && ` column--${width}`}" id="main">${main}</main>
      </div>
      <footer class="footer">
        <span class="footer__rule" aria-hidden="true"></span>
        <a href="${config.landingUrl}">gesserit.org</a>
      </footer>
      ${/* who is reading, laid over the whole page too faintly to be seen: it takes no part in the page, and a screenshot carries it */ ""}
      <div class="mark" aria-hidden="true" style="background-image:url(${markAddress(session)})"></div>
    `,
  });
}

export const notice = (message, kind = "error") =>
  message && html`<p class="notice notice--${kind}" role="${kind === "error" ? "alert" : "status"}">${message}</p>`;

/* --------------------------------------------------------------- sign in */

export function signInPage({ error, next, username = "" }) {
  return shell({
    title: "Sign in",
    bodyClass: "gate",
    body: html`
      <main class="gate__leaf">
        <p class="gate__mark"><a href="${config.landingUrl}">${wordmark}</a></p>
        <h1 class="rubric gate__title">Sign in</h1>
        <form class="form gate__form" method="post" action="/login">
          <input type="hidden" name="next" value="${next}" />
          ${notice(error)}
          <label for="username">Sign-in name</label>
          <input
            id="username"
            name="username"
            value="${username}"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            required
            autofocus
          />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <button class="button" type="submit">Enter</button>
        </form>
        <div class="gate__rule" aria-hidden="true"></div>
      </main>
      <a class="gate__back" href="${config.landingUrl}">gesserit.org</a>
    `,
  });
}

/* --------------------------------------------------------------- journal */

/** a title, with after it the letter that says whose the piece is, where it has one */
const titled = (post, length = 90) =>
  html`${named(post.title, post.body, length)}${post.hand && html`<sup class="hand">${post.hand}</sup>`}`;

/** for a commentary, the post it answers; the link is there while that post can be read */
function answers(post) {
  if (!post.parent_id) return "";
  const name = named(post.parent_title, post.parent_opening);
  return html`<p class="answers">
    A commentary on
    ${post.parent_status === "published" ? html`<a href="/p/${post.parent_id}">${name}</a>` : name}
  </p>`;
}

/** how much has been said about a post, as the words of a link to it */
export function discussion(post) {
  if (post.note_count + post.reply_count + post.commentary_count === 0) return "Add a margin note";
  return [
    post.note_count > 0 && plural(post.note_count, "margin note"),
    post.reply_count > 0 && plural(post.reply_count, "reply", "replies"),
    post.commentary_count > 0 && plural(post.commentary_count, "commentary", "commentaries"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** the box a search is typed in; `wide` on the page of what was found, where it is the thing itself */
const searchBox = ({ q = "", wide = false } = {}) =>
  html`<form class="search${wide && " search--wide"}" action="/search" method="get" role="search">
    <label class="visually-hidden" for="q">Search what is written here and its notes</label>
    <input
      id="q"
      name="q"
      type="search"
      value="${q}"
      placeholder="Search"
      maxlength="${config.maxSearchLength}"
      autocomplete="off"
      spellcheck="false"
      ${wide && raw("autofocus")}
    />
    <button class="${wide ? "button" : "link"}" type="submit">Find</button>
  </form>`;

/** a passage with the words that were searched for marked in it */
const marked = (pieces) => pieces.map(({ text, hit }) => (hit ? html`<mark class="hit">${text}</mark>` : text));

/** what a search found: `found` is what find() gave back, and is nothing before anything has been asked */
export function searchPage({ session, q, found }) {
  const total = found ? found.posts.length + found.notes.length + found.pages.length : 0;
  const cut = (rows) =>
    found && rows.length >= found.most && html`<p class="hint">The first ${found.most} are shown. More words will narrow it.</p>`;
  const post = (row) =>
    html`<li>
      <a class="index__title" href="/p/${row.id}">${named(row.title, row.passage.map((piece) => piece.text).join(""))}</a>
      <span class="index__quote">${marked(row.passage)}</span>
      <span class="index__meta">
        ${row.kind === "work"
          ? html`${row.creator && `${row.creator} · `}An antecedent`
          : row.parent_id
            ? "A commentary"
            : row.title
              ? "An article"
              : "A short post"}
      </span>
    </li>`;
  const note = (row) =>
    html`<li>
      <a class="index__title" href="/p/${row.post_id}#note-${row.id}"
        >${row.author_name} ${row.parent_id ? "in a reply on" : "in a margin note on"}
        ${named(row.post_title, row.post_opening)}</a
      >
      <span class="index__quote">${marked(row.passage)}</span>
      <span class="index__meta">${raw(timeTag(row.created_at))}</span>
    </li>`;
  const projectPage = (row) =>
    html`<li>
      <a class="index__title" href="/pages/${row.id}">${row.title}</a>
      <span class="index__quote">${marked(row.passage)}</span>
      <span class="index__meta">
        In the project <a href="/projects/${row.project_id}">${row.project_title}</a> · last changed
        ${raw(timeTag(row.updated_at))}
      </span>
    </li>`;
  const part = (title, rows, each) =>
    rows.length > 0 &&
    html`<h2 class="section-title">${title} <span class="section-title__n">${rows.length}</span></h2>
      <ul class="index index--notes index--found">
        ${rows.map(each)}
      </ul>
      ${cut(rows)}`;
  return page({
    title: q ? `Search: ${q}` : "Search",
    session,
    current: "search",
    main: html`
      <h1 class="page-title">Search</h1>
      ${searchBox({ q, wide: true })}
      ${!found &&
      html`<p class="hint">
        A few words, all of which must be there, in any order. What is written here is searched, with the
        antecedents and the notes in the margins${config.projects && ", and the pages of the projects you can read"}.
      </p>`}
      ${found?.short && html`<p class="empty empty--notes">Give at least two letters to look for.</p>`}
      ${found &&
      !found.short &&
      total === 0 &&
      html`<p class="empty empty--notes">
        Nothing here has ${found.words.length > 1 ? "all of those words" : "that word"}. Try fewer words, or part of one.
      </p>`}
      ${found && part("In what is written", found.posts, post)} ${found && part("In the margins", found.notes, note)}
      ${found && part("In projects", found.pages, projectPage)}
    `,
  });
}

/* how many of a member's projects the first page names before it says how many more there are */
const SHELF = 4;

/**
 * The projects, on the first page: the ones the member is working on, the most
 * lately changed first, and the way to the rest. `open` is how many of other
 * members' projects anyone may read.
 */
function shelf({ mine, open }) {
  const more = mine.length - SHELF;
  return html`<nav class="shelf" aria-labelledby="shelf-title">
    <h2 class="shelf__title" id="shelf-title"><a href="/projects">Projects</a></h2>
    ${mine.length > 0
      ? html`<ul class="shelf__list">
          ${mine.slice(0, SHELF).map((each) => html`<li><a href="/projects/${each.id}">${each.title}</a></li>`)}
          ${more > 0 && html`<li class="shelf__rest"><a href="/projects">and ${more} more</a></li>`}
        </ul>`
      : html`<p class="shelf__none">
          ${open > 0 ? `${plural(open, "project")} ${open === 1 ? "is" : "are"} open to everyone.` : "You are not working on one yet."}
        </p>`}
    <p class="shelf__more">
      <a href="/projects">${mine.length > 0 ? "All projects" : "See the projects"}</a>
      <a href="/projects/new">Start one</a>
    </p>
  </nav>`;
}

/* the two layers of the corpus, each of which has a table of its own in the list of every piece */
const LAYERS = [
  { kind: "writing", name: "Succession", none: "Nothing has been written yet." },
  { kind: "work", name: "Antecedent", none: "No antecedent has been added yet." },
];

/**
 * Scribe: where the corpus is kept from. Every piece there is, in two
 * tables: the succession, which is what is written here, and the
 * antecedents. Each piece has its status, which its keeper says, and the way
 * to change it; and each table is in the order its keeper has put it in,
 * which those who edit change by dragging a row.
 */
export function scribePage({ session, pieces, projects = null, sends = false }) {
  const edits = may(session, "edit");
  const writes = may(session, "write");
  const row = (post) => {
    const work = post.kind === "work";
    // those who edit change any piece; those who publish, what is theirs
    const mine = edits || (writes && post.author_id === session.user.id);
    const name = named(post.title, post.body, 80);
    const by = work && byline(post, { short: true });
    return html`<tr data-id="${post.id}">
      ${edits &&
      html`<td class="ledger__move">
        <button class="ledger__grip" type="button" data-grip aria-label="Move ${name}: drag it, or use the arrow keys" hidden>
          <span aria-hidden="true">⠿</span>
        </button>
      </td>`}
      <td>
        <strong><a href="/p/${post.id}">${work ? html`<cite>${post.title}</cite>` : titled(post, 80)}</a></strong>
        ${by && html`<span class="ledger__more">${by}</span>`}
      </td>
      <td class="ledger__status">
        ${mine
          ? html`<form method="post" action="/p/${post.id}/status" data-status>
              ${csrfField(session)}
              <label class="visually-hidden" for="status-${post.id}">Status of ${name}</label>
              <select id="status-${post.id}" name="status">
                ${STATUSES.map(({ key, name: label }) => html`<option value="${key}" ${key === statusOf(post) && raw("selected")}>${label}</option>`)}
              </select>
              <button class="link" type="submit">Set</button>
            </form>`
          : statusName(post)}
      </td>
      <td class="members__actions">${mine && html`<a class="link" href="/p/${post.id}/edit">Edit</a>`}</td>
    </tr>`;
  };
  const table = ({ kind, name, none }) => {
    const rows = pieces.filter((post) => post.kind === kind);
    return html`<table class="members ledger">
        <thead>
          <tr>
            ${edits && html`<th class="ledger__move"><span class="visually-hidden">Order</span></th>`}
            <th scope="col">${name}</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody ${edits && raw("data-order")}>
          ${rows.map(row)}
        </tbody>
      </table>
      ${rows.length === 0 && html`<p class="empty empty--notes ledger__none">${none}</p>`}`;
  };
  return page({
    title: "Editorial",
    session,
    width: "wide",
    current: "scribe",
    scripts: ["scribe"],
    main: html`
      <div class="page-head page-head--scribe">
        <h1 class="page-title">Editorial</h1>
        ${searchBox()}
      </div>
      <div class="page-acts">
        <p class="page-head__acts">${(writes || edits) && html`<a class="button" href="/write">New Piece</a>`}</p>
        ${(may(session, "members") || sends) &&
        html`<p class="views">
          ${may(session, "members") && html`<a href="/members">Members</a>`}
          ${config.invitations && isAdmin(session) && html`<a href="/invitations">Invitations</a>`}
          ${sends && html`<a href="/send">Send</a>`}
        </p>`}
      </div>
      ${projects && shelf(projects)}
      ${LAYERS.map(table)}
      ${edits &&
      html`<form method="post" action="/order" data-order-form hidden>
        ${csrfField(session)}
        <input type="hidden" name="ids" value="" />
      </form>`}
    `,
  });
}

/* ----------------------------------------------------------------- canon */

/**
 * The canon: everything the main admin (`keeper`) has published, in the
 * order it was written. `posts` are those, oldest first.
 */
export function canonPage({ session, keeper, posts }) {
  const mine = keeper?.id === session.user.id;
  const item = (post) => html`<li>
    <a class="index__title" href="/p/${post.id}">${named(post.title, post.body, 90)}</a>
    ${post.title && html`<span class="index__quote">${excerpt(post.body, 200)}</span>`}
    <span class="index__meta">
      ${post.parent_id && html`A commentary on ${named(post.parent_title, post.parent_opening)} · `}
      <a href="/p/${post.id}#notes">${discussion(post)}</a>
    </span>
  </li>`;
  const kinds = [
    ["Articles", posts.filter((post) => post.title && !post.parent_id)],
    ["Commentaries", posts.filter((post) => post.parent_id)],
    ["Short posts", posts.filter((post) => !post.title && !post.parent_id)],
  ].filter(([, list]) => list.length > 0);
  return page({
    title: "Canon",
    session,
    current: "canon",
    main: html`
      <p class="rubric"><a href="/corpus">Corpus</a></p>
      <h1 class="page-title">Canon</h1>
      ${keeper
        ? html`<p class="lede">
            The canon is everything published by the main admin,
            <a href="${memberHref(keeper.username)}">${keeper.name}</a>, listed here in the order it was written.
          </p>`
        : html`<p class="lede">The canon is what the main admin has published. There is no admin yet.</p>`}
      ${posts.length === 0 &&
      keeper &&
      html`<p class="empty">
        Nothing is in the canon yet.${mine && html` <a href="/write">Write its first text.</a>`}
      </p>`}
      ${kinds.map(
        ([name, list]) => html`<section class="related canon">
          <h2 class="section-title">${name}</h2>
          <ol class="index">
            ${list.map(item)}
          </ol>
        </section>`
      )}
      ${mine &&
      posts.length > 0 &&
      html`<p class="hint">
        You are the main admin: whatever you publish joins the canon. <a href="/write">Write something new</a>
      </p>`}
    `,
  });
}

/* -------------------------------------------- one post, notes and replies */

/** a post in a list of posts: what it is called */
const listed = (post) => html`<li>
  <a class="index__title" href="/p/${post.id}">${post.kind === "work" ? html`<cite>${post.title}</cite>` : titled(post)}</a>
</li>`;

const mayRemove = (note, session) => may(session, "moderate") || session.user.id === note.user_id;

const who = (note) =>
  html`<p class="note__who">
    <strong><a href="${memberHref(note.author_username)}">${note.author_name}</a></strong>
    ${raw(timeTag(note.created_at, "stamp"))}
    ${note.edited_at && html`<span class="note__edited">edited ${raw(timeTag(note.edited_at, "stamp"))}</span>`}
  </p>`;

const removeForm = (note, session, question) =>
  html`<form method="post" action="/notes/${note.id}/remove">
    ${csrfField(session)}
    <button class="link link--quiet" type="submit" data-confirm="${question}">Remove</button>
  </form>`;

/** what a note said before it was reworded, oldest first */
const earlierWordings = (note) =>
  note.earlier.length > 0 &&
  html`<details class="fold was">
    <summary>${note.earlier.length === 1 ? "Earlier wording" : `${note.earlier.length} earlier wordings`}</summary>
    <ol class="was__list">
      ${note.earlier.map(
        (wording) => html`<li>
          <p class="was__when">${raw(timeTag(wording.created_at, "stamp"))}</p>
          <div class="note__body">${raw(renderNote(wording.body))}</div>
        </li>`
      )}
    </ol>
  </details>`;

/** for a note's own author: closed until asked for; open again, with what was typed, if it could not be saved */
function editBox(note, { session, draftEdit, error }) {
  if (session.user.id !== note.user_id) return false;
  const draft = draftEdit?.noteId === note.id ? draftEdit : null;
  return html`<details class="fold reply-box" ${draft && raw("open")}>
    <summary>Edit</summary>
    <form class="form" method="post" action="/notes/${note.id}/edit">
      ${csrfField(session)} ${draft && notice(error)}
      <label class="visually-hidden" for="edit-${note.id}">Your ${note.parent_id ? "reply" : "note"}</label>
      <textarea
        id="edit-${note.id}"
        name="body"
        rows="4"
        maxlength="${config.maxNoteLength}"
        data-suggest="people"
        required
        ${draft && raw("autofocus")}
      >${draft ? draft.body : note.body}</textarea>
      <p class="hint">What it says now is kept, and shown under “Earlier wording”.</p>
      <button class="button" type="submit">Save</button>
    </form>
  </details>`;
}

function replyItem(reply, context) {
  const { session } = context;
  const actions = [
    editBox(reply, context),
    earlierWordings(reply),
    mayRemove(reply, session) && removeForm(reply, session, "Remove this reply?"),
  ].filter(Boolean);
  return html`<li class="reply" id="note-${reply.id}">
    ${who(reply)}
    <div class="note__body">${raw(renderNote(reply.body))}</div>
    ${actions.length > 0 && html`<div class="note__actions">${actions}</div>`}
  </li>`;
}

/** closed until asked for; open again, with what was typed, if it could not be saved */
function replyBox(note, { session, post, draftReply, error }) {
  const draft = draftReply?.parentId === note.id ? draftReply : null;
  return html`<details class="fold reply-box" ${draft && raw("open")}>
    <summary>Reply</summary>
    <form class="form" method="post" action="/p/${post.id}/notes">
      ${csrfField(session)}
      <input type="hidden" name="parent" value="${note.id}" />
      ${draft && notice(error)}
      <label class="visually-hidden" for="reply-${note.id}">Reply to ${note.author_name}</label>
      <textarea
        id="reply-${note.id}"
        name="body"
        rows="3"
        maxlength="${config.maxNoteLength}"
        data-suggest="people"
        required
        ${draft && raw("autofocus")}
      >${draft?.body || ""}</textarea>
      <button class="button" type="submit">Post reply</button>
    </form>
  </details>`;
}

/** a margin note with the replies made to it */
function thread(note, n, context) {
  const { session, post } = context;
  const replies =
    note.replies.length > 0 &&
    html`<ol class="replies">
      ${note.replies.map((reply) => replyItem(reply, context))}
    </ol>`;

  if (note.removed) {
    return html`<li class="note note--removed" id="note-${note.id}">
      <span class="note__n" aria-hidden="true">${n}</span>
      <div class="note__main">
        <p class="note__gone">This note was removed.</p>
        ${replies}
      </div>
    </li>`;
  }

  const question =
    note.replies.length > 0 ? "Remove this margin note? The replies to it stay." : "Remove this margin note?";
  // replies are made while a post is published; rewording and removing stay possible either way
  const actions = [
    post.status === "published" && replyBox(note, context),
    editBox(note, context),
    earlierWordings(note),
    mayRemove(note, session) && removeForm(note, session, question),
  ].filter(Boolean);
  return html`<li
    class="note"
    id="note-${note.id}"
    data-note="${note.id}"
    data-n="${n}"
    data-quote="${note.quote || ""}"
    data-pos="${note.quote_pos ?? ""}"
    data-version="${note.version ?? ""}"
  >
    <span class="note__n" aria-hidden="true">${n}</span>
    <div class="note__main">
      ${who(note)}
      ${note.quote && html`<blockquote class="note__quote">${note.quote}</blockquote>`}
      <div class="note__body">${raw(renderNote(note.body))}</div>
      ${actions.length > 0 && html`<div class="note__actions">${actions}</div>`}
      ${replies}
    </div>
  </li>`;
}

/**
 * What the corpus says of a piece, folded away under its title until it is
 * asked for: of a work, a few words on where it is strong and where it falls
 * short; of the essay at the centre, its claims set out.
 */
export const annotationOf = (text) => raw(renderPost(text));

const annotated = (post, centre) =>
  post.annotation &&
  html`<details class="fold annotation">
    <summary>${centre ? "Claims" : "Annotation"}</summary>
    <div class="prose annotation__text">${annotationOf(post.annotation)}</div>
  </details>`;

/**
 * An antecedent's page, which is all the corpus says of it and nothing more:
 * its title, whose it is and what type of thing, and its annotations. Beside
 * the title, for those who may, the way to change it, and the way to where
 * it stands on the corpus.
 */
function workArticle({ post, mayEdit }) {
  const by = byline(post);
  // where the work itself is to be found, if that was said: its title leads there
  const found = post.link && outwardLink(post.link);
  const acts = [
    mayEdit && html`<a href="/p/${post.id}/edit">Edit</a>`,
    post.status === "published" && html`<a href="/corpus#p${post.id}">Link to corpus</a>`,
  ].filter(Boolean);
  return html`<article class="post post--work">
    <header class="post__head post__head--work">
      <div class="work__top">
        <h1 class="post__title post__title--work">
          ${found
            ? html`<a href="${found}" rel="noopener noreferrer" title="Where it is to be found"><cite>${post.title}</cite></a>`
            : html`<cite>${post.title}</cite>`}
        </h1>
        ${acts.length > 0 && html`<p class="work__acts">${acts}</p>`}
      </div>
      ${by && html`<p class="work__by">${by}</p>`}
    </header>
    ${post.body.trim() && html`<div class="prose">${raw(renderPost(post.body))}</div>`}
  </article>`;
}

export function postPage({
  session,
  post,
  threads,
  commentaries = [],
  linkedFrom = [],
  centre = false,
  numbers = false,
  error,
  draftNote,
  draftReply,
  draftEdit,
}) {
  const draft = post.status === "draft";
  // those who edit change anything; those who publish, what is theirs
  const mayEdit = may(session, "edit") || (session.user.id === post.author_id && may(session, "write"));
  const work = post.kind === "work";
  if (work)
    return page({ title: post.title, session, current: "work", main: workArticle({ post, mayEdit }) });

  const writes = may(session, "write");
  const context = { session, post, draftReply, draftEdit, error };
  // what stands under the title: how far along it is, until it is published, and what can be done with it.
  // When it was written is not said, of this or of any piece.
  const meta = [
    draft && html`<span>${statusName(post)}</span>`,
    config.versions &&
      post.version > 1 &&
      html`<span
        ><a href="/p/${post.id}/history">Version ${post.version}</a>, revised
        ${raw(timeTag(post.revised_at))}</span
      >`,
    mayEdit && html`<a href="/p/${post.id}/edit">Edit</a>`,
    !draft && html`<a href="/corpus#p${post.id}">Link to corpus</a>`,
    !draft && numbers && html`<a href="/p/${post.id}/text">Text it</a>`,
    centre && html`<span class="tag tag--canon">At the centre of the corpus</span>`,
    Boolean(post.canon) && !centre && html`<a class="tag tag--canon" href="/canon">Canon</a>`,
    Boolean(post.missionaria) && may(session, "edit") && html`<span class="tag tag--quiet">Missionaria</span>`,
  ].filter(Boolean);
  // an article can be set at the centre of the corpus by those who edit what is written
  const mayCentre = !centre && !draft && post.title && !post.parent_id && may(session, "edit");
  return page({
    title: named(post.title, post.body),
    session,
    current: "post",
    main: html`
      <article class="post">
        <header class="post__head">
          ${answers(post)}
          ${post.title &&
          html`<h1 class="post__title">${post.title}${post.hand && html`<sup class="hand">${post.hand}</sup>`}</h1>`}
          ${meta.length > 0 && html`<p class="post__meta">${meta}</p>`}
          ${annotated(post, centre)}
          ${mayCentre &&
          html`<form class="post__centre" method="post" action="/p/${post.id}/centre">
            ${csrfField(session)}
            <button class="link link--quiet" type="submit">Set this at the centre of the corpus</button>
          </form>`}
        </header>
        <div class="prose" data-article data-post="${post.id}" data-version="${post.version ?? ""}">
          ${raw(renderPost(post.body, { initial: Boolean(post.title) }))}
        </div>
      </article>

      ${!draft && html`<div class="flourish" aria-hidden="true"></div>`}

      ${!draft &&
      (commentaries.length > 0 || writes) &&
      html`<section class="related" id="commentaries" aria-labelledby="commentaries-title">
        <h2 class="section-title" id="commentaries-title">Commentaries</h2>
        ${commentaries.length > 0
          ? html`<ul class="index">
                ${commentaries.map(listed)}
              </ul>
              ${writes && html`<p class="related__more"><a href="/write?on=${post.id}">Write a commentary</a></p>`}`
          : html`<p class="related__more">
              None yet. <a href="/write?on=${post.id}">Write a commentary</a>: a longer answer, set out as an
              article of its own.
            </p>`}
      </section>`}
      ${linkedFrom.length > 0 &&
      html`<section class="related" id="linked-from" aria-labelledby="linked-from-title">
        <h2 class="section-title" id="linked-from-title">Linked from</h2>
        <ul class="index">
          ${linkedFrom.map(listed)}
        </ul>
      </section>`}

      ${/* the margin opens once a piece is published. Before that there is nothing in it and it is not shown; what was written in the margin of a piece since taken back is still there to be seen to */ ""}
      ${(!draft || threads.length > 0) &&
      html`<section class="notes" id="notes" aria-labelledby="notes-title">
        <h2 class="section-title" id="notes-title">Margin notes</h2>
        ${threads.length > 0
          ? html`<ol class="notes__list">
              ${threads.map((note, i) => thread(note, i + 1, context))}
            </ol>`
          : html`<p class="empty empty--notes">No margin notes yet.</p>`}
        ${!draft &&
        html`<form class="form note-form" id="add-note" method="post" action="/p/${post.id}/notes">
          ${csrfField(session)}
          <input type="hidden" name="quote" value="${draftNote?.quote || ""}" />
          <input type="hidden" name="pos" value="${draftNote?.pos ?? ""}" />
          ${draftNote && notice(error)}
          <label for="note-body">Add a margin note</label>
          <p class="hint">
            <span data-quote-hint>To write about a particular passage, select it in the text above first.</span>
            Type <code>@</code> to tag another member.
          </p>
          <div class="note-form__quote" data-quote-preview hidden>
            <blockquote class="note__quote"></blockquote>
            <button class="link link--quiet" type="button" data-quote-clear>Detach passage</button>
          </div>
          <textarea
            id="note-body"
            name="body"
            rows="4"
            maxlength="${config.maxNoteLength}"
            data-suggest="people"
            required
          >${draftNote?.body || ""}</textarea>
          <button class="button" type="submit">Add note</button>
        </form>`}
      </section>`}
    `,
  });
}

/* ----------------------------------------------------------------- write */

/*
 * The editor's buttons. A button says what it does by showing it: the ways a
 * paragraph can be set are each drawn as they will look, and the lists and the
 * quotation have a small picture of themselves. The script gives each its work.
 */
const drawn = (paths, title) =>
  html`<svg class="tool__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    ${title && html`<title>${title}</title>`}${raw(paths)}
  </svg>`;

const ICONS = {
  undo: drawn('<path d="M7.5 4.5 3.5 8.5l4 4" /><path d="M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9" />'),
  redo: drawn('<path d="m12.5 4.5 4 4-4 4" /><path d="M16 8.5H8.5a4.5 4.5 0 0 0 0 9H11" />'),
  list: drawn(
    '<circle class="tool__dot" cx="3.5" cy="5" r="1.4" /><circle class="tool__dot" cx="3.5" cy="10" r="1.4" /><circle class="tool__dot" cx="3.5" cy="15" r="1.4" /><path d="M8 5h9M8 10h9M8 15h9" />'
  ),
  numbered: drawn(
    '<text class="tool__figure" x="1" y="7">1</text><text class="tool__figure" x="1" y="12.5">2</text><text class="tool__figure" x="1" y="18">3</text><path d="M8 5h9M8 10h9M8 15h9" />'
  ),
  quote: drawn('<path class="tool__bar" d="M3.5 3.5v13" /><path d="M8 6h9M8 10h9M8 14h6" />'),
};

/* how a paragraph can be set, each shown in the menu as it will look on the page */
const STYLES = [
  ["text", "Normal text", html`<span class="sample sample--text">Normal text</span>`],
  ["title", "Large heading", html`<span class="sample sample--title">Large heading</span>`],
  ["heading", "Heading", html`<span class="sample sample--heading">Heading</span>`],
  ["subheading", "Small heading", html`<span class="sample sample--subheading">Small heading</span>`],
  ["quote", "Quotation", html`<span class="sample sample--quote">A quotation, set apart from your own words</span>`],
  [
    "list",
    "List",
    html`<span class="sample sample--list"><span>A list</span><span>of things</span></span>`,
  ],
  [
    "numbered",
    "Numbered list",
    html`<span class="sample sample--list sample--numbered"><span>A numbered list</span><span>of things in order</span></span>`,
  ],
];

/* what the editor can show: the page as it will look, the marks that make it, or how it will be read */
const VIEWS = [
  ["page", "Page", "Write on the page as it will look"],
  ["write", "Plain text", "Write the same thing as plain text, with its marks"],
  ["preview", "Preview", "See it as it will be read"],
  ["both", "Side by side", "Plain text, with the preview beside it"],
];

const tool = ([name, label, title, key]) =>
  html`<button class="tool" type="button" data-do="${name}" title="${title}" aria-label="${title}" ${key && raw(`data-key="${key}"`)}>
    ${label}
  </button>`;

const pictured = (name, title) =>
  html`<button class="tool tool--pictured" type="button" data-do="${name}" title="${title}" aria-label="${title}" aria-pressed="false">
    ${ICONS[name]}
  </button>`;

/**
 * Where a long text is written. Without the script it is a plain box that
 * takes the text with its marks. With it, the box gives way to a page that
 * is written on as it will look, under a row of buttons; the box is still
 * there, kept in step with the page, and is what the form sends. The form it
 * stands in is marked data-editor="some name", under which unsaved writing is
 * kept in the browser, and has a field called "title" above it. Under the
 * page there is nothing but, when something goes wrong, the word of it.
 * `needed` says the text cannot be left empty; a piece that is so far only
 * its title can.
 */
export function editorField({ body = "", rows = 18, needed = true }) {
  return html`<div class="editor" data-view="write">
      <div class="editor__bar" role="toolbar" aria-label="Formatting" hidden>
        <span class="editor__group">
          <button class="tool tool--pictured" type="button" data-do="undo" title="Undo" aria-label="Undo" data-key="Z">${ICONS.undo}</button>
          <button class="tool tool--pictured" type="button" data-do="redo" title="Redo" aria-label="Redo">${ICONS.redo}</button>
        </span>
        <span class="editor__group menu">
          <button class="tool tool--menu" type="button" data-opens="styles" aria-haspopup="true" aria-expanded="false" title="How this paragraph is set">
            <span data-style-name>Normal text</span>
          </button>
          <span class="menu__list menu__list--styles" id="styles" role="menu" aria-label="How this paragraph is set" hidden>
            ${STYLES.map(
              ([name, label, sample]) =>
                html`<button class="menu__item" type="button" role="menuitemradio" aria-checked="false" data-do="${name}" data-style="${name}" aria-label="${label}">${sample}</button>`
            )}
          </span>
        </span>
        <span class="editor__group">
          ${tool(["bold", html`<b>B</b>`, "Bold", "B"])} ${tool(["italic", html`<i>I</i>`, "Italic", "I"])}
        </span>
        <span class="editor__group">
          ${pictured("list", "List")} ${pictured("numbered", "Numbered list")} ${pictured("quote", "Quotation")}
        </span>
        <span class="editor__group">
          ${tool(["link", "Link", "Link to a web page", "K"])}
          ${tool(["article", "Article", "Link to another article here"])}
          ${tool(["picture", "Picture", "Add pictures from this device"])}
          ${tool(["formula", "Formula", "A formula"])}
          ${tool(["diagram", "Diagram", "A diagram, drawn from LaTeX (TikZ)"])}
        </span>
        <span class="editor__group editor__views menu">
          <button class="tool tool--menu" type="button" data-opens="views" aria-haspopup="true" aria-expanded="false" title="What the editor shows">
            <span data-view-name>Page</span>
          </button>
          <span class="menu__list menu__list--views" id="views" role="menu" aria-label="What the editor shows" hidden>
            ${VIEWS.map(
              ([name, label, words]) =>
                html`<button class="menu__item${name === "both" && " editor__both"}" type="button" role="menuitemradio" aria-checked="false" data-show="${name}">
                  <span class="menu__name">${label}</span><span class="menu__words">${words}</span>
                </button>`
            )}
          </span>
        </span>
      </div>
      <div class="editor__panes">
        <div class="editor__page prose" data-page role="textbox" aria-multiline="true" aria-label="Text" data-placeholder="Write here…" spellcheck="true" hidden></div>
        <textarea id="body" name="body" rows="${rows}" data-suggest="people articles" ${needed && raw("required")}>${body}</textarea>
        <div class="editor__preview post" data-preview hidden>
          <p class="rubric editor__label">Preview</p>
          <h2 class="post__title" data-preview-title hidden></h2>
          <div class="prose" aria-label="Preview" aria-live="polite"></div>
        </div>
      </div>
      <p class="editor__foot" hidden><span data-status role="status"></span></p>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml" multiple hidden data-pictures data-most="${config.maxUploadBytes}" />
    </div>`;
}

/** the two things that are simply so or not so of a piece, each a box to tick with its name and nothing more */
export const curationChecks = (v) =>
  html`<div class="checks">
    <label class="check"><input type="checkbox" name="show_tell" value="1" ${v.showTell && raw("checked")} /> <span>Show and Tell</span></label>
    <label class="check"><input type="checkbox" name="missionaria" value="1" ${v.missionaria && raw("checked")} /> <span>Missionaria</span></label>
  </div>`;

/**
 * What those who edit say of a piece written here besides its words, as the
 * part of a form: `v` is what the form has, and `centre` says that the piece
 * is the essay the corpus is drawn around, of which what opens on the corpus
 * is its claims. The letter after its title is asked for beside the title.
 */
export function curationFields({ v, centre = false }) {
  return html`<div class="curation">
    <div class="curation__tone">
      <label for="tone">Colour of its title</label>
      <select id="tone" name="tone">
        ${TONES.map(({ key, name }) => html`<option value="${key}" ${key === v.tone && raw("selected")}>${name}</option>`)}
      </select>
    </div>
    <label for="annotation">${centre ? "Claims" : "Annotation"}</label>
    <textarea id="annotation" name="annotation" rows="${centre ? 10 : 3}" maxlength="${MOST_ANNOTATION}">${v.annotation}</textarea>
    ${curationChecks(v)}
  </div>`;
}

/** what a piece has had said of it on the corpus, as a form begins with it */
export const curationOf = (post) => ({
  annotation: post?.annotation || "",
  tone: post?.tone || "",
  hand: post?.hand || "",
  showTell: Boolean(post?.show_tell),
  missionaria: Boolean(post?.missionaria),
});

/**
 * Writing something new, or with `post` changing what was written. With `on`,
 * the new post is a commentary on that one. It is written on a page of the
 * size and proportions of a sheet of paper. `centre` says the piece is the
 * essay the corpus is drawn around.
 */
export function writePage({ session, post, on, values, error, centre = false }) {
  const editing = Boolean(post);
  const v = { title: post?.title || "", body: post?.body || "", summary: "", ...curationOf(post), ...values };
  const published = post?.status === "published";
  const edits = may(session, "edit");
  const heading = editing ? "Edit" : on ? "Write a commentary" : "New Piece";
  const back = editing ? `/p/${post.id}` : on ? `/p/${on.id}` : "/";
  return page({
    title: heading,
    session,
    width: "desk",
    current: "write",
    scripts: ["markdown", "editor"],
    math: true,
    main: html`
      <h1 class="page-title page-title--form">${heading}</h1>
      ${on &&
      html`<p class="answers answers--lead">
        On <a href="/p/${on.id}">${named(on.title, on.body)}</a>
      </p>`}
      ${editing && answers(post)}
      <form
        class="form compose compose--piece"
        method="post"
        action="${editing ? `/p/${post.id}/edit` : "/write"}"
        data-editor="${editing ? `p${post.id}` : on ? `on${on.id}` : "new"}"
      >
        ${csrfField(session)} ${on && html`<input type="hidden" name="on" value="${on.id}" />`}
        ${editing && html`<input type="hidden" name="base" value="${post.updated_at}" />`} ${notice(error)}
        <div class="compose__titles">
          <div class="compose__title">
            <label for="title">Title</label>
            <input id="title" name="title" value="${v.title}" maxlength="200" autocomplete="off" />
          </div>
          ${edits &&
          html`<div class="compose__hand">
            <label for="hand">Superscript</label>
            <input id="hand" name="hand" value="${v.hand}" maxlength="2" autocomplete="off" autocapitalize="characters" spellcheck="false" />
          </div>`}
        </div>

        <label for="body">Text</label>
        ${editorField({ body: v.body, needed: false })}

        ${edits && curationFields({ v, centre })}

        ${config.versions &&
        published &&
        html`<label for="summary">What changed</label>
          <input id="summary" name="summary" value="${v.summary}" maxlength="200" autocomplete="off" />`}

        <div class="compose__actions">
          ${published
            ? html`<button class="button" type="submit" name="status" value="published">Save</button>`
            : html`<button class="button" type="submit" name="status" value="published">Publish</button>
                <button class="button button--quiet" type="submit" name="status" value="draft">Save</button>`}
          <a class="compose__cancel" href="${back}">Cancel</a>
        </div>
      </form>
      ${editing &&
      html`<form class="compose__delete" method="post" action="/p/${post.id}/delete">
        ${csrfField(session)}
        <button class="link link--danger" type="submit" data-confirm="Delete this post for good?">Delete this post</button>
      </form>`}
    `,
  });
}

/* -------------------------------------------------------------- versions */

export const number = (n) => n.toLocaleString("en-GB");

/** how much a version changed, in words that came in and went out */
export function wordsChanged({ added, removed }) {
  if (added === null || removed === null) return "";
  if (added === 0 && removed === 0) return "no words changed";
  return [added > 0 && `${number(added)} ${added === 1 ? "word" : "words"} added`, removed > 0 && `${number(removed)} removed`]
    .filter(Boolean)
    .join(", ");
}

const editor = (version) => html`<a href="${memberHref(version.editor_username)}">${version.editor_name}</a>`;

/** choosing any two versions to set side by side */
export const compareForm = (action, versions, from, to) => {
  const options = (chosen) =>
    versions.map((each) => html`<option value="${each.n}" ${each.n === chosen && raw("selected")}>Version ${each.n}</option>`);
  return html`<form class="compare" method="get" action="${action}">
    <label for="from">Compare</label>
    <select id="from" name="from">${options(from)}</select>
    <label for="to">with</label>
    <select id="to" name="to">${options(to)}</select>
    <button class="button button--quiet" type="submit">Compare</button>
  </form>`;
};

const restoreForm = (session, post, version) =>
  html`<form method="post" action="/p/${post.id}/restore">
    ${csrfField(session)}
    <input type="hidden" name="n" value="${version.n}" />
    <button
      class="link"
      type="submit"
      data-confirm="Put version ${version.n} back as the current text? It is saved as a new version, so nothing is lost."
    >
      Restore this version
    </button>
  </form>`;

/** every version a post has been through, newest first */
export function historyPage({ session, post, versions }) {
  const mayEdit = may(session, "edit") || session.user.id === post.author_id;
  const name = named(post.title, post.body);
  const current = (version) => version.title === post.title && version.body === post.body;
  const item = (version) => {
    const first = version.n === 1;
    const facts = [
      raw(timeTag(version.created_at, "stamp")),
      editor(version),
      first ? `${number(wordCount(version.body))} words` : wordsChanged(version),
    ].filter(Boolean);
    return html`<li class="version" id="v${version.n}">
      <p class="version__head">
        <a class="version__n" href="/p/${post.id}/v/${version.n}">Version ${version.n}</a>
        ${version.n === post.version && post.status === "published" && html`<span class="tag">Current</span>`}
      </p>
      <p class="version__meta">${facts.map((fact, i) => html`${i > 0 && " · "}${fact}`)}</p>
      ${version.summary && html`<p class="version__summary">${version.summary}</p>`}
      ${version.title !== (versions.find((each) => each.n === version.n - 1) ?? version).title &&
      html`<p class="version__summary">Title changed to “${version.title || "(none)"}”</p>`}
      <div class="version__actions">
        <a href="/p/${post.id}/v/${version.n}">Read</a>
        ${!first && html`<a href="/p/${post.id}/changes?from=${version.n - 1}&amp;to=${version.n}">What changed</a>`}
        ${mayEdit && !current(version) && restoreForm(session, post, version)}
      </div>
    </li>`;
  };
  return page({
    title: `History · ${name}`,
    session,
    main: html`
      <h1 class="page-title">History</h1>
      <p class="answers answers--lead">of <a href="/p/${post.id}">${name}</a></p>
      ${post.status === "draft" &&
      versions.length > 0 &&
      notice("This is unpublished at present. These are the versions it was published with before.", "ok")}
      ${versions.length === 0
        ? html`<p class="empty empty--notes">
            This has not been published yet. Versions are kept from the moment it is.
          </p>`
        : html`
            <p class="lede">
              Every wording this has been published with. Each can be read as it stood and compared with any
              other${mayEdit && ", and an earlier one can be put back"}.
            </p>
            <ol class="versions">
              ${versions.map(item)}
            </ol>
            ${versions.length > 2 && compareForm(`/p/${post.id}/changes`, versions, versions[0].n - 1, versions[0].n)}
          `}
    `,
  });
}

/** a post as it stood at one of its versions */
export function versionPage({ session, post, version }) {
  const latest = post.version;
  const isCurrent = version.n === latest && post.status === "published";
  return page({
    title: `Version ${version.n} · ${named(version.title, version.body)}`,
    session,
    main: html`
      <div class="notice notice--ok version-bar">
        <p>
          ${isCurrent
            ? html`This is <strong>version ${version.n}</strong>, the current one,`
            : html`This is <strong>version ${version.n}</strong> of ${latest},`}
          as saved ${raw(timeTag(version.created_at, "stamp"))} by ${editor(version)}.
          ${version.summary && html`<span class="version-bar__summary">“${version.summary}”</span>`}
        </p>
        <p class="version-bar__links">
          ${!isCurrent && html`<a href="/p/${post.id}">Read the current text</a>`}
          ${version.n > 1 &&
          html`<a href="/p/${post.id}/changes?from=${version.n - 1}&amp;to=${version.n}">What this version changed</a>`}
          ${version.n < latest &&
          html`<a href="/p/${post.id}/changes?from=${version.n}&amp;to=${latest}">What has changed since</a>`}
          <a href="/p/${post.id}/history">History</a>
        </p>
      </div>
      <article class="post">
        <header class="post__head">
          ${answers(post)}
          ${version.title && html`<h1 class="post__title">${version.title}</h1>`}
        </header>
        <div class="prose">${raw(renderPost(version.body, { initial: Boolean(version.title) }))}</div>
      </article>
      <nav class="pager" aria-label="Versions">
        ${version.n > 1
          ? html`<a href="/p/${post.id}/v/${version.n - 1}" rel="prev">Version ${version.n - 1}</a>`
          : html`<span></span>`}
        <span class="pager__where">Version ${version.n} of ${latest}</span>
        ${version.n < latest
          ? html`<a href="/p/${post.id}/v/${version.n + 1}" rel="next">Version ${version.n + 1}</a>`
          : html`<span></span>`}
      </nav>
    `,
  });
}

/* how many unchanged lines are shown either side of a change, to place it */
const CONTEXT = 2;

/** what changed between two versions of a post, set out as the text with its changes marked */
export function changesPage({ session, post, before, after, versions, diff }) {
  const name = named(post.title, post.body);
  const side = (word, version) =>
    html`<li>
      ${word} <a href="/p/${post.id}/v/${version.n}">version ${version.n}</a>,
      ${raw(timeTag(version.created_at, "stamp"))}, ${version.editor_name}
    </li>`;

  return page({
    title: `What changed · ${name}`,
    session,
    main: html`
      <h1 class="page-title">What changed</h1>
      <p class="answers answers--lead">in <a href="/p/${post.id}">${name}</a></p>
      <ul class="changes__sides">
        ${side("From", before)} ${side("to", after)}
      </ul>
      ${compareForm(`/p/${post.id}/changes`, versions, before.n, after.n)}
      ${changesShown({ before, after, diff })}
      <p class="related__more"><a href="/p/${post.id}/history">History</a></p>
    `,
  });
}

/**
 * What changed from one wording to another, as the text with what came in
 * and what went out marked in it. `before` and `after` have the titles;
 * `diff` is what changes() made of the two texts.
 */
export function changesShown({ before, after, diff }) {
  const part = ({ op, text }) =>
    op === "same" ? text : op === "del" ? html`<del>${text}</del>` : html`<ins>${text}</ins>`;
  const line = (text) => html`<p class="diff__line">${text}</p>`;
  const skipped = (n) => html`<p class="diff__skip">${n === 1 ? "1 line" : `${number(n)} lines`} unchanged</p>`;

  const blocks = diff.blocks.map((block, i) => {
    if (block.kind === "changed") return html`<div class="diff__change">${block.parts.map(part)}</div>`;
    // unchanged text is there to place the changes: keep what is beside them and fold the rest
    const lines = block.lines.filter((text) => text.trim());
    const lead = i === 0 ? 0 : CONTEXT;
    const trail = i === diff.blocks.length - 1 ? 0 : CONTEXT;
    if (lines.length <= lead + trail + 1) return lines.map(line);
    return [
      lines.slice(0, lead).map(line),
      skipped(lines.length - lead - trail),
      lines.slice(lines.length - trail).map(line),
    ];
  });
  const textChanged = diff.blocks.some((block) => block.kind === "changed");
  const titleChanged = before.title !== after.title;

  return html`<p class="changes__key">
      ${textChanged || titleChanged
        ? html`<ins>Added</ins> <del>Removed</del>
            <span>${wordsChanged(diff)}</span>`
        : "These two read the same."}
    </p>
    ${titleChanged &&
    html`<p class="diff__title">
      <span class="rubric">Title</span>
      ${before.title && html`<del>${before.title}</del>`} ${after.title && html`<ins>${after.title}</ins>`}
    </p>`}
    ${textChanged && html`<div class="diff" data-typed>${blocks}</div>`}`;
}

/* ----------------------------------------------------- one member's page */

export function memberPage({ session, person, posts, notes, main = false }) {
  const self = person.id === session.user.id;
  const written = (post) => html`<li>
    <a class="index__title" href="/p/${post.id}"
      >${post.kind === "work" ? html`<cite>${post.title}</cite>` : named(post.title, post.body, 90)}</a
    >
    ${(post.kind === "work" || post.parent_id) &&
    html`<span class="index__meta">
      ${post.kind === "work" ? byline(post) || "An antecedent" : html`A commentary on ${named(post.parent_title, post.parent_opening)}`}
    </span>`}
  </li>`;
  const noted = (note) => html`<li>
    <a class="index__title" href="/p/${note.post_id}#note-${note.id}">${clip(note.body, 140)}</a>
    <span class="index__meta">
      ${note.parent_id ? "A reply on" : "A note on"} ${named(note.post_title, note.post_opening)} ·
      ${raw(timeTag(note.created_at))}
    </span>
  </li>`;
  return page({
    title: person.name,
    session,
    current: "",
    main: html`
      <h1 class="page-title">${person.name}</h1>
      <p class="hint">
        ${main
          ? html`Main admin, whose writing is <a href="/canon">the canon</a>`
          : standing(person)}${!person.active && " · no longer a member"} ·
        ${self ? "others tag you" : `tag ${person.name}`} by writing <code>@${person.username}</code>
        ${self && html` · <a href="/account">Preferences</a>`}
        ${(posts.length > 0 || notes.length > 0) && html` · <a href="/corpus?around=u${person.id}">In the corpus</a>`}
      </p>
      ${config.messages &&
      !self &&
      person.active &&
      html`<form class="member__write" method="post" action="/chat" data-start>
        ${csrfField(session)}
        <input type="hidden" name="who" value="${person.id}" />
        <button class="button button--quiet" type="submit">Send ${person.name} a message</button>
      </form>`}

      <h2 class="section-title">Writing and works</h2>
      ${posts.length > 0
        ? html`<ul class="index">
            ${posts.map(written)}
          </ul>`
        : html`<p class="empty empty--notes">Nothing published yet.</p>`}

      <h2 class="section-title">Margin notes and replies</h2>
      ${notes.length > 0
        ? html`<ul class="index index--notes">
            ${notes.map(noted)}
          </ul>`
        : html`<p class="empty empty--notes">None yet.</p>`}
    `,
  });
}

/* --------------------------------------------------------------- members */

export function membersPage({ session, members, issued, changed }) {
  const admin = isAdmin(session);
  // only the main admin can hand that place on to another admin
  const iAmMain = members.some((member) => member.main && member.id === session.user.id);
  // a sub-admin who manages the members reaches the members and no further: not an admin, not another sub-admin
  const within = (member) => admin || (member.role !== "admin" && !isSubAdmin(member));
  const row = (member) => {
    const self = member.id === session.user.id;
    const sub = isSubAdmin(member);
    return html`<tr class="${member.active ? "" : "is-removed"}">
      <td>
        <strong><a href="${memberHref(member.username)}">${member.name}</a></strong
        >${self && html` <span class="members__you">(you)</span>`}
        <span class="members__username">${member.username}</span>
      </td>
      <td>
        ${member.main
          ? html`Main admin <a class="tag tag--canon" href="/canon">Canon</a>`
          : standing(member)}${!member.active && " · removed"}
        ${sub &&
        html`<span class="members__can">
          ${held(member)
            .map((permission) => permission.name)
            .join(" · ")}
        </span>`}
        <span class="members__seen">
          ${member.signed_in_at
            ? html`Last signed in ${raw(timeTag(member.signed_in_at))}`
            : "No sign-in on record"}
        </span>
      </td>
      <td class="members__actions">
        ${iAmMain &&
        !self &&
        member.role === "admin" &&
        Boolean(member.active) &&
        html`<form method="post" action="/members/${member.id}/main">
          ${csrfField(session)}
          <button
            class="link"
            type="submit"
            data-confirm="Make ${member.name} the main admin in your place? The canon becomes what they have written, and only they can hand it on again."
          >
            Make main admin
          </button>
        </form>`}
        ${admin &&
        !self &&
        member.role !== "admin" &&
        Boolean(member.active) &&
        html`<a class="link" href="/members/${member.id}/permissions">${sub ? "Permissions" : "Make sub-admin"}</a>`}
        ${!self &&
        !member.main &&
        within(member) &&
        html`<form method="post" action="/members/${member.id}/password">
          ${csrfField(session)}
          <button
            class="link"
            type="submit"
            data-confirm="Give ${member.name} a new password? Their old one stops working."
          >
            New password
          </button>
        </form>`}
        ${!self &&
        member.role !== "admin" &&
        within(member) &&
        html`<form method="post" action="/members/${member.id}/${member.active ? "remove" : "restore"}">
          ${csrfField(session)}
          ${member.active
            ? html`<button
                class="link link--danger"
                type="submit"
                data-confirm="Remove ${member.name}? They are signed out and can no longer sign in. What they have written stays.${sub &&
                " They stop being a sub-admin, and come back as a member if they are restored."}"
              >
                Remove
              </button>`
            : html`<button class="link" type="submit">Restore</button>`}
        </form>`}
      </td>
    </tr>`;
  };

  return page({
    title: "Members",
    session,
    width: "wide",
    current: "members",
    main: html`
      <p class="rubric"><a href="/">Scribe</a></p>
      <h1 class="page-title">Members</h1>
      ${issued &&
      html`<div class="notice notice--ok" role="status">
        <p>
          <strong>${issued.name}</strong> can now sign in. Pass these on; the password is shown only this
          once.
        </p>
        <dl class="issued">
          <dt>Sign-in name</dt>
          <dd><code>${issued.username}</code></dd>
          <dt>Password</dt>
          <dd><code>${issued.password}</code></dd>
        </dl>
      </div>`}
      ${changed &&
      notice(
        isSubAdmin(changed)
          ? `${changed.name} is a sub-admin, and can now: ${held(changed)
              .map((permission) => permission.name.toLowerCase())
              .join(", ")}.`
          : `${changed.name} is a member, with nothing more than any member can do.`,
        "ok"
      )}
      <table class="members">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${members.map(row)}
        </tbody>
      </table>
      ${/* members are added from the server itself. While the list of those who are to be invited is out, it is reached from here */ ""}
      ${config.invitations && admin && html`<p class="members__more"><a href="/invitations">Invitations</a></p>`}
    `,
  });
}

/** where an admin chooses what a member may do besides what every member may: with anything ticked, a sub-admin */
export function permissionsPage({ session, member }) {
  const has = held(member).map((permission) => permission.key);
  return page({
    title: `What ${member.name} may do`,
    session,
    current: "members",
    main: html`
      <h1 class="page-title">What ${member.name} may do</h1>
      <p class="hint">
        ${isSubAdmin(member) ? html`${member.name} is a sub-admin.` : html`${member.name} is a member.`} Tick
        what they are to be able to do besides what every member can. With anything ticked they are a
        sub-admin; with nothing ticked, a member like any other.
      </p>
      <form class="form" method="post" action="/members/${member.id}/permissions">
        ${csrfField(session)}
        <fieldset class="options grants">
          <legend>Permissions</legend>
          ${PERMISSIONS.map(
            ({ key, name, says }) =>
              html`<label class="grant"
                ><input type="checkbox" name="can" value="${key}" ${has.includes(key) && raw("checked")} />
                <span class="grant__name">${name}</span> <span class="grant__says">${says}</span></label
              >`
          )}
        </fieldset>
        <div class="compose__actions">
          <button class="button" type="submit">Save</button>
          <a class="compose__cancel" href="/members">Cancel</a>
        </div>
      </form>
      <p class="hint grants__note">
        Some things stay with the admins whatever is ticked: making and unmaking sub-admins, anything done to
        an admin or to another sub-admin, and the place of the main admin. What is saved here holds from
        ${member.name}’s next page; they need not sign in again.
      </p>
    `,
  });
}

/* --------------------------------------------------------------- account */

/* the lighting the pages can be read by, each shown as a leaf of itself */
const LOOKS = [
  { theme: "paper", name: "Paper" },
  { theme: "night", name: "Night" },
];

/** a member's preferences: the lighting of the pages, and their password */
const TEXTS = [
  { key: "all", name: "Receive texts for all posts" },
  { key: "some", name: "Receive texts for some posts" },
];

/** `texts` is what a member who came by an invitation has asked to be sent, or null for a member who did not */
export function accountPage({ session, error, said, texts = null }) {
  const look = session.user.theme || "paper";
  return page({
    title: "Preferences",
    session,
    current: "account",
    main: html`
      <h1 class="page-title page-title--preferences">Preferences</h1>
      ${said && notice(said, "ok")}

      <h2 class="section-title" id="lighting">Lighting</h2>
      <form class="looks" method="post" action="/account/theme">
        ${csrfField(session)}
        ${LOOKS.map(
          ({ theme, name }) =>
            html`<button
              class="look look--${theme}"
              type="submit"
              name="theme"
              value="${theme}"
              aria-pressed="${theme === look ? "true" : "false"}"
            >
              <span class="look__leaf" aria-hidden="true"><span class="look__word">Aa</span></span>
              <span class="look__name">${name}</span>
            </button>`
        )}
      </form>

      <h2 class="section-title" id="password">Change password</h2>
      <form class="form form--narrow password" method="post" action="/account/password#password">
        ${csrfField(session)} ${notice(error)}
        <label for="current">Current password</label>
        <input id="current" name="current" type="password" autocomplete="current-password" required />
        <label for="new-password">New password</label>
        <input
          id="new-password"
          name="password"
          type="password"
          autocomplete="new-password"
          minlength="${config.minPasswordLength}"
          maxlength="200"
          required
        />
        <button class="button" type="submit">Change password</button>
      </form>

      ${texts &&
      html`<h2 class="section-title" id="texts">Texts</h2>
        <form class="form form--narrow" method="post" action="/account/texts">
          ${csrfField(session)}
          <div class="options grants">
            ${TEXTS.map(
              ({ key, name }) =>
                html`<label class="grant"
                  ><input type="checkbox" name="texts" value="${key}" ${texts.wants.includes(key) && raw("checked")} />
                  <span class="grant__name">${name}</span></label
                >`
            )}
          </div>
          <p class="hint">
            Sent to the number you were invited by, when something is published. With neither ticked you are sent nothing.
          </p>
          <button class="button" type="submit">Save</button>
        </form>`}
    `,
  });
}

/* -------------------------------------------------- a picture by itself */

/** a picture opened by itself: on a page like any other, and so under its reader's mark */
export function picturePage({ session, src }) {
  return page({
    title: "Picture",
    session,
    width: "wide",
    main: html`
      <figure class="alone">
        <img src="${src}" alt="" />
      </figure>
      <p class="alone__back"><a href="/">Back to the first page</a></p>
    `,
  });
}

/* ---------------------------------------------------------------- errors */

export function errorPage({ status, message, session }) {
  const main = html`
    <div class="lost">
      <p class="rubric">${status}</p>
      <h1 class="page-title">${message}</h1>
      <p><a href="/">Back to the first page</a></p>
    </div>
  `;
  if (session) return page({ title: String(status), session, main });
  return shell({ title: String(status), bodyClass: "bare", body: html`<main class="column">${main}</main>` });
}
