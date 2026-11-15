/*
 * The pages. Everything goes through the `html` tag, which escapes whatever
 * is interpolated unless it is already markup made by `html` or `raw`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, REPO_ROOT, SERVER_ROOT } from "./config.mjs";
import { wordCount } from "./diff.mjs";
import { can, held, isSubAdmin, PERMISSIONS, standing } from "./permissions.mjs";
import { clip, escapeHtml, excerpt, renderNote, renderPost, timeTag, typeset } from "./render.mjs";

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
const VERSION = ["forum.css", "forum.js", "editor.js", "graph.js", "chat.js"]
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

/* how a page can look, and the colour a phone's browser frames each in */
const THEMES = { paper: "#f3ecdc", night: "#0b0a08" };

export const csrfField = (session) => html`<input type="hidden" name="_csrf" value="${session.csrf}" />`;

const wordmark = html`<span class="initial" data-letter="G" aria-hidden="true">G</span
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
function shell({ title, body, bodyClass = "", scripts = [], math = false, theme = "paper" }) {
  const look = Object.hasOwn(THEMES, theme) ? theme : "paper";
  return typeset(html`<!DOCTYPE html>
<html lang="en" data-theme="${look}">
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
    ${["forum", ...scripts].map((name) => html`<script src="/static/${name}.js?v=${VERSION}" defer></script>`)}
  </head>
  <body class="${bodyClass}">
    ${body}
  </body>
</html>
`.value);
}

/**
 * A signed-in page. `current` names the entry of the menu that this page is;
 * `width` is "wide" for tables and "full" for the graph. The formula
 * stylesheet comes with any page that has a formula on it, or with `math`.
 */
export function page({ title, session, main, width = "", current = "", scripts = [], math = false }) {
  const { user } = session;
  // the two entries only some have: for the admins, and for the sub-admins given what each leads to
  const writes = may(session, "write");
  const keeps = may(session, "members");
  const item = (key, href, label) =>
    html`<a href="${href}" ${current === key && raw('aria-current="page"')}>${label}</a>`;
  const name =
    session.tagged > 0
      ? html`${user.name}
          <span class="badge" aria-hidden="true">${session.tagged}</span
          ><span class="visually-hidden">, ${plural(session.tagged, "new tag")}</span>`
      : user.name;
  const chat =
    session.unread > 0
      ? html`Chat
          <span class="badge" aria-hidden="true">${session.unread > 99 ? "99+" : session.unread}</span
          ><span class="visually-hidden">, ${plural(session.unread, "unread message")}</span>`
      : "Chat";
  return shell({
    title,
    scripts,
    theme: user.theme || "night",
    math: math || main.value.includes('class="katex'),
    body: html`
      <a class="skip" href="#main">Skip to the page</a>
      <header class="masthead${(writes || keeps) && " masthead--long"}">
        <a class="masthead__mark" href="/">${wordmark}</a>
        <nav class="masthead__nav" aria-label="Site">
          ${item("journal", "/", "Journal")} ${item("canon", "/canon", "Canon")} ${item("graph", "/graph", "Graph")}
          ${item("projects", "/projects", "Projects")} ${item("chat", "/chat", chat)}
          ${writes && item("write", "/write", "Write")} ${keeps && item("members", "/members", "Members")}
          ${item("guide", "/guide", "Guide")}
        </nav>
        <div class="masthead__you">
          ${item("account", "/account", name)}
          <form method="post" action="/logout">
            ${csrfField(session)}
            <button class="link" type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main class="column${width && ` column--${width}`}" id="main">${main}</main>
      <footer class="footer">
        <span class="footer__rule" aria-hidden="true"></span>
        <a href="${config.landingUrl}">gesserit.org</a>
      </footer>
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
        <img class="gate__device" src="/assets/palm.svg" alt="" width="48" height="64" />
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
        <p class="gate__foot">Members only. Ask to be added.</p>
      </main>
      <a class="gate__back" href="${config.landingUrl}">gesserit.org</a>
    `,
  });
}

/* --------------------------------------------------------------- journal */

/* Between the parts of a dateline. Each is a space made wide, the first with a
   point drawn on it: where the line breaks there, the space goes and takes
   the point with it, so that no line of a dateline begins with one. */
const POINT = html`<span class="rubric__sep rubric__sep--point"> </span>`;
const GAP = html`<span class="rubric__sep"> </span>`;

/** when a post was published and who wrote it; what the main admin published is marked as of the canon */
const dateline = (post) =>
  html`<p class="rubric">${raw(timeTag(post.published_at || post.updated_at))}${POINT}<span class="rubric__by"
      ><a href="${memberHref(post.author_username)}">${post.author_name}</a></span
    >${post.status === "draft" && html`${GAP}<span class="tag">Draft</span>`}${Boolean(post.canon) &&
    html`${GAP}<a class="tag tag--canon" href="/canon">Canon</a>`}</p>`;

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
function discussion(post) {
  if (post.note_count + post.reply_count + post.commentary_count === 0) return "Add a margin note";
  return [
    post.note_count > 0 && plural(post.note_count, "margin note"),
    post.reply_count > 0 && plural(post.reply_count, "reply", "replies"),
    post.commentary_count > 0 && plural(post.commentary_count, "commentary", "commentaries"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** short untitled texts are shown whole on the journal page; the rest are opened */
const SHOWN_WHOLE = 1200;

function entry(post) {
  const link = `/p/${post.id}`;
  const foot =
    post.status === "draft"
      ? html`<p class="entry__foot"><a href="${link}/edit">Edit draft</a></p>`
      : html`<p class="entry__foot"><a href="${link}#notes">${discussion(post)}</a></p>`;

  if (post.title) {
    return html`<li class="entry">
      ${dateline(post)} ${answers(post)}
      <h2 class="entry__title"><a href="${link}">${post.title}</a></h2>
      <p class="entry__excerpt">${excerpt(post.body)}</p>
      ${foot}
    </li>`;
  }
  if (post.body.length <= SHOWN_WHOLE) {
    return html`<li class="entry">
      ${dateline(post)} ${answers(post)}
      <div class="prose">${raw(renderPost(post.body))}</div>
      ${foot}
    </li>`;
  }
  return html`<li class="entry">
    ${dateline(post)} ${answers(post)}
    <p class="entry__excerpt">${excerpt(post.body, 520)} <a class="more" href="${link}">Read on</a></p>
    ${foot}
  </li>`;
}

/** the box a search is typed in; `wide` on the page of what was found, where it is the thing itself */
const searchBox = ({ q = "", wide = false } = {}) =>
  html`<form class="search${wide && " search--wide"}" action="/search" method="get" role="search">
    <label class="visually-hidden" for="q">Search the journal, its notes and the projects</label>
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
        ${row.parent_id ? "A commentary by" : row.title ? "An article by" : "A short post by"} ${row.author_name} ·
        ${raw(timeTag(row.published_at))}
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
    current: "journal",
    main: html`
      <h1 class="page-title">Search</h1>
      ${searchBox({ q, wide: true })}
      ${!found &&
      html`<p class="hint">
        A few words, all of which must be there, in any order. The journal is searched, the notes in its
        margins, and the pages of the projects you can read.
      </p>`}
      ${found?.short && html`<p class="empty empty--notes">Give at least two letters to look for.</p>`}
      ${found &&
      !found.short &&
      total === 0 &&
      html`<p class="empty empty--notes">
        Nothing here has ${found.words.length > 1 ? "all of those words" : "that word"}. Try fewer words, or part of one.
      </p>`}
      ${found && part("In the journal", found.posts, post)} ${found && part("In the margins", found.notes, note)}
      ${found && part("In projects", found.pages, projectPage)}
    `,
  });
}

export function journalPage({ session, posts, drafts, pageNumber, pageCount }) {
  const empty = posts.length === 0 && drafts.length === 0;
  return page({
    title: "Journal",
    session,
    current: "journal",
    main: html`
      <div class="page-head">
        <h1 class="page-title">Journal</h1>
        ${searchBox()}
      </div>
      ${drafts.length > 0 &&
      html`<section class="drafts" aria-labelledby="drafts-title">
        <h2 class="section-title" id="drafts-title">Drafts</h2>
        <p class="hint">
          ${may(session, "edit")
            ? "Only their authors, the admins and the sub-admins who edit the journal can see these until they are published."
            : "Only you, the admins and the sub-admins who edit the journal can see these until they are published."}
        </p>
        <ol class="feed">
          ${drafts.map(entry)}
        </ol>
      </section>`}
      ${posts.length > 0 && html`<ol class="feed">${posts.map(entry)}</ol>`}
      ${empty &&
      html`<p class="empty">
        Nothing has been published yet.${may(session, "write") && html` <a href="/write">Write the first post.</a>`}
      </p>`}
      ${pageCount > 1 &&
      html`<nav class="pager" aria-label="Pages">
        ${pageNumber > 1
          ? html`<a href="/?page=${pageNumber - 1}" rel="prev">Newer</a>`
          : html`<span></span>`}
        <span class="pager__where">Page ${pageNumber} of ${pageCount}</span>
        ${pageNumber < pageCount
          ? html`<a href="/?page=${pageNumber + 1}" rel="next">Older</a>`
          : html`<span></span>`}
      </nav>`}
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
      ${raw(timeTag(post.published_at))}${post.parent_id &&
      html` · a commentary on ${named(post.parent_title, post.parent_opening)}`}
      · <a href="/p/${post.id}#notes">${discussion(post)}</a>
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
      <h1 class="page-title">Canon</h1>
      ${keeper
        ? html`<p class="lede">
            The canon is everything published by the main admin,
            <a href="${memberHref(keeper.username)}">${keeper.name}</a>. It is listed here in the order it was
            written, and is drawn in gold on <a href="/graph?around=u${keeper.id}">the graph</a>.
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

/** a post in a list of posts: what it is called, who wrote it and when */
const listed = (post) => html`<li>
  <a class="index__title" href="/p/${post.id}">${named(post.title, post.body, 90)}</a>
  <span class="index__meta">${post.author_name} · ${raw(timeTag(post.published_at))}</span>
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

export function postPage({
  session,
  post,
  threads,
  commentaries = [],
  linkedFrom = [],
  error,
  draftNote,
  draftReply,
  draftEdit,
}) {
  const mayEdit = may(session, "edit") || session.user.id === post.author_id;
  const draft = post.status === "draft";
  const context = { session, post, draftReply, draftEdit, error };
  // what stands under the title: the version this is, and what can be done with it
  const meta = [
    post.version > 1 &&
      html`<span
        ><a href="/p/${post.id}/history">Version ${post.version}</a>, revised
        ${raw(timeTag(post.revised_at))}</span
      >`,
    mayEdit && html`<a href="/p/${post.id}/edit">Edit</a>`,
    !draft && html`<a href="/graph?around=p${post.id}">On the graph</a>`,
  ].filter(Boolean);
  return page({
    title: named(post.title, post.body),
    session,
    main: html`
      <article class="post">
        <header class="post__head">
          ${dateline(post)} ${answers(post)}
          ${post.title && html`<h1 class="post__title">${post.title}</h1>`}
          ${meta.length > 0 && html`<p class="post__meta">${meta}</p>`}
        </header>
        <div class="prose" data-article data-post="${post.id}" data-version="${post.version ?? ""}">
          ${raw(renderPost(post.body, { initial: Boolean(post.title) }))}
        </div>
      </article>

      <div class="flourish" aria-hidden="true"></div>

      ${!draft &&
      html`<section class="related" id="commentaries" aria-labelledby="commentaries-title">
        <h2 class="section-title" id="commentaries-title">Commentaries</h2>
        ${commentaries.length > 0
          ? html`<ul class="index">
                ${commentaries.map(listed)}
              </ul>
              <p class="related__more"><a href="/write?on=${post.id}">Write a commentary</a></p>`
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

      <section class="notes" id="notes" aria-labelledby="notes-title">
        <h2 class="section-title" id="notes-title">Margin notes</h2>
        ${threads.length > 0
          ? html`<ol class="notes__list">
              ${threads.map((note, i) => thread(note, i + 1, context))}
            </ol>`
          : html`<p class="empty empty--notes">No margin notes yet.</p>`}
        ${draft
          ? html`<p class="hint">Notes and commentaries open once this is published.</p>`
          : html`<form class="form note-form" id="add-note" method="post" action="/p/${post.id}/notes">
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
      </section>
    `,
  });
}

/* ----------------------------------------------------------------- write */

/* the editor's buttons, in the groups they are set out in; the script gives each its work */
const TOOLS = [
  [
    ["bold", html`<b>B</b>`, "Bold", "B"],
    ["italic", html`<i>I</i>`, "Italic", "I"],
  ],
  [
    ["heading", "Heading", "Heading: press again for a smaller one"],
    ["quote", "Quote", "Quotation"],
    ["list", "List", "List"],
    ["numbered", "Numbered", "Numbered list"],
  ],
  [
    ["link", "Link", "Link to a web page", "K"],
    ["article", "Article", "Link to another article here"],
    ["picture", "Picture", "Add pictures from this computer"],
    ["formula", "Formula", "A formula, in LaTeX"],
    ["diagram", "Diagram", "A diagram, drawn from LaTeX (TikZ)"],
  ],
];

const tool = ([name, label, title, key]) =>
  html`<button class="tool" type="button" data-do="${name}" title="${title}" aria-label="${title}" ${key && raw(`data-key="${key}"`)}>
    ${label}
  </button>`;

/* everything the text understands, for whoever would rather type it than press a button */
export const MARKS = [
  ["A new paragraph", "a blank line"],
  ["Heading", "## Heading"],
  ["Italic, bold", "*italic*  **bold**"],
  ["Quotation", "> what was said"],
  ["List", "- an item\n1. a numbered item"],
  ["Link", "[the words](https://…)"],
  ["Another article here", "[[Its title]]\n[[Its title|other words]]"],
  ["Tag a member", "@name"],
  ["Picture", '![what it shows](address "Caption")'],
  ["Formula in the line", "$e^{i\\pi} = -1$"],
  ["Formula set apart", "$$\n\\int_0^1 x^2 \\, dx\n$$"],
  ["Diagram", "```tikz A caption, if wanted\n\\draw (0,0) circle (1);\n```"],
  ["Code", "`in the line`, or a block between ``` lines"],
  ["A rule between sections", "---"],
];

/**
 * The box a long text is written in, with its buttons, its preview and the
 * list of everything it understands. The form it stands in is marked
 * data-editor="some name", under which unsaved writing is kept in the
 * browser, and has a field called "title" above it.
 */
export function editorField({ body = "", rows = 18 }) {
  return html`<div class="editor" data-view="write">
      <div class="editor__bar" role="toolbar" aria-label="Formatting" aria-controls="body" hidden>
        ${TOOLS.map((group) => html`<span class="editor__group">${group.map(tool)}</span>`)}
        <span class="editor__group editor__views" role="group" aria-label="What to show">
          <button class="tool" type="button" data-show="write" aria-pressed="true">Write</button>
          <button class="tool" type="button" data-show="preview" aria-pressed="false">Preview</button>
          <button class="tool editor__both" type="button" data-show="both" aria-pressed="false">Side by side</button>
        </span>
      </div>
      <div class="editor__panes">
        <textarea id="body" name="body" rows="${rows}" data-suggest="people articles" required>${body}</textarea>
        <div class="editor__preview post" data-preview hidden>
          <p class="rubric editor__label">Preview</p>
          <h2 class="post__title" data-preview-title hidden></h2>
          <div class="prose" aria-label="Preview" aria-live="polite"></div>
        </div>
      </div>
      <p class="editor__foot" hidden><span data-count></span><span data-status role="status"></span></p>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml" multiple hidden data-pictures data-most="${config.maxUploadBytes}" />
    </div>

    <details class="fold guide">
      <summary>Everything that can be written here</summary>
      ${marksList()}
    </details>

    <p class="compose__file">
      <label class="button button--quiet" for="file">Open a text file…</label>
      <input class="visually-hidden" id="file" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" data-load-into="body" data-title-into="title" />
      <span class="hint">A .md or .txt file is read here in the browser and placed in the box above.</span>
    </p>`;
}

/** everything the text understands, set out as what is wanted and what to type for it */
export const marksList = () =>
  html`<dl class="guide__marks">
    ${MARKS.map(([what, how]) => html`<dt>${what}</dt><dd><code>${how}</code></dd>`)}
  </dl>`;

/**
 * Writing something new, or with `post` changing what was written. With `on`,
 * the new post is a commentary on that one.
 */
export function writePage({ session, post, on, values, error }) {
  const editing = Boolean(post);
  const v = { title: post?.title || "", body: post?.body || "", summary: "", ...values };
  const published = post?.status === "published";
  const next = published ? (post.version || 0) + 1 : null;
  const commentary = Boolean(on || post?.parent_id);
  const heading = editing ? "Edit" : on ? "Write a commentary" : "Write";
  const back = editing ? `/p/${post.id}` : on ? `/p/${on.id}` : "/";
  return page({
    title: heading,
    session,
    current: editing || on ? "" : "write",
    scripts: ["editor"],
    math: true,
    main: html`
      <h1 class="page-title">${heading}</h1>
      ${on &&
      html`<p class="answers answers--lead">
        On <a href="/p/${on.id}">${named(on.title, on.body)}</a> by ${on.author_name}
      </p>`}
      ${editing && answers(post)}
      <form
        class="form compose"
        method="post"
        action="${editing ? `/p/${post.id}/edit` : "/write"}"
        data-editor="${editing ? `p${post.id}` : on ? `on${on.id}` : "new"}"
      >
        ${csrfField(session)} ${on && html`<input type="hidden" name="on" value="${on.id}" />`}
        ${editing && html`<input type="hidden" name="base" value="${post.updated_at}" />`} ${notice(error)}
        <label for="title">Title</label>
        <p class="hint">
          ${commentary
            ? "Optional, but with a title a commentary can be found and linked to by name."
            : "Optional. With a title this is shown as an article; without one, as a short post."}
        </p>
        <input id="title" name="title" value="${v.title}" maxlength="200" autocomplete="off" />

        <label for="body">Text</label>
        <p class="hint">
          Write or paste plainly: a blank line starts a new paragraph. Pictures can be dropped or pasted
          straight into the text.
        </p>
        ${editorField({ body: v.body })}

        ${published &&
        html`<label for="summary">What changed</label>
          <p class="hint">
            Optional: a line for the history. Saving keeps this as version ${next}; the wording it replaces
            stays there to be read, compared and restored.
          </p>
          <input id="summary" name="summary" value="${v.summary}" maxlength="200" autocomplete="off" />`}

        <div class="compose__actions">
          <button class="button" type="submit" name="status" value="published">
            ${published ? `Save as version ${next}` : "Publish"}
          </button>
          <button class="button button--quiet" type="submit" name="status" value="draft">
            ${published ? "Unpublish to draft" : "Save as draft"}
          </button>
          <a class="compose__cancel" href="${back}">Cancel</a>
        </div>
      </form>
      ${editing &&
      html`<form class="compose__delete" method="post" action="/p/${post.id}/delete">
        ${csrfField(session)}
        <button
          class="link link--danger"
          type="submit"
          data-confirm="Delete this post, with its margin notes, replies and earlier versions, for good?${post.commentary_count > 0 &&
          " The commentaries on it are kept."}"
        >
          Delete this post
        </button>
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
          ${dateline(post)} ${answers(post)}
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

/* ------------------------------------------------------------- the graph */

/* drawn from the back forward, so the lines that say most lie on top */
const EDGE_ORDER = ["address", "note", "wrote", "link", "commentary"];
const ARROW = { commentary: "ink", link: "gold" };

/* how far out from a node of the canon its ring is drawn */
const HALO = 3.5;

/* each mark the graph uses, drawn small for the key beneath it */
const KEY_NODES = {
  canon: html`<circle class="node__halo" cx="14" cy="8" r="7.5" /><circle cx="14" cy="8" r="4.5" />`,
  article: html`<circle cx="14" cy="8" r="6.5" />`,
  commentary: html`<circle cx="14" cy="8" r="5.5" />`,
  post: html`<circle cx="14" cy="8" r="4" />`,
  person: html`<rect x="9.5" y="3.5" width="9" height="9" transform="rotate(45 14 8)" />`,
};
const keyNode = (kind, label) =>
  html`<li>
    <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true"><g class="node node--${kind === "canon" ? "article node--canon" : kind}">${KEY_NODES[kind]}</g></svg>
    ${label}
  </li>`;
const keyEdge = (kind, label) =>
  html`<li>
    <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
      <line class="edge edge--${kind}" x1="1" y1="8" x2="${ARROW[kind] ? 21 : 27}" y2="8" ${ARROW[kind] && raw(`marker-end="url(#arrow-${ARROW[kind]})"`)} />
    </svg>
    ${label}
  </li>`;

/** the address of a view of the graph: around a node or not, with or without the people */
function graphHref({ around = null, reach = "1", people = true }) {
  const query = new URLSearchParams();
  if (around) query.set("around", around);
  if (around && reach !== "1") query.set("reach", reach);
  if (!people) query.set("show", "articles");
  const asked = query.toString();
  return asked ? `/graph?${asked}` : "/graph";
}

const REACH_WORDS = [
  ["1", "what it touches"],
  ["2", "two steps out"],
  ["3", "three steps"],
  ["all", "everything connected"],
];

/**
 * The graph, or with `focus` ({ id, reach, of }) the part of it around one
 * node. `missing` says a node was asked for that the graph does not have.
 */
export function graphPage({ session, graph, counts, people, focus = null, missing = false }) {
  const edges = [...graph.edges].sort((a, b) => EDGE_ORDER.indexOf(a.kind) - EDGE_ORDER.indexOf(b.kind));
  const line = (edge) =>
    html`<line
      class="edge edge--${edge.kind}"
      data-from="${edge.from}"
      data-to="${edge.to}"
      x1="${edge.x1}"
      y1="${edge.y1}"
      x2="${edge.x2}"
      y2="${edge.y2}"
      ${ARROW[edge.kind] && raw(`marker-end="url(#arrow-${ARROW[edge.kind]})"`)}
    />`;
  const node = (each) => {
    const person = each.kind === "person";
    // the canon is gilt, and wears a fine ring a little way out from it
    const halo = each.canon && !person;
    return html`<a
      class="node node--${each.kind}${each.canon && " node--canon"}${focus?.id === each.id && " is-centre"}"
      href="${each.href}"
      data-id="${each.id}"
      transform="translate(${each.x} ${each.y})"
      aria-label="${each.detail}"
    >
      <title>${each.detail}</title>
      ${halo && html`<circle class="node__halo" r="${each.r + HALO}" />`}
      ${person
        ? html`<rect x="-5" y="-5" width="10" height="10" transform="rotate(45)" />`
        : html`<circle r="${each.r}" />`}
      <text y="${Math.round(each.r + (person ? 19 : halo ? 17 + HALO : 17))}" text-anchor="middle">${each.text}</text>
    </a>`;
  };
  const view = (shown, href, label) =>
    shown ? html`<strong>${label}</strong>` : html`<a href="${href}">${label}</a>`;
  const empty = graph.nodes.length === 0;
  const tally = [
    plural(counts.posts, "post"),
    plural(counts.commentaries, "commentary", "commentaries"),
    counts.canon > 0 && `${counts.canon} in the canon`,
    plural(counts.people, "member"),
    plural(counts.notes, "note or reply", "notes and replies"),
    plural(counts.links, "link between articles", "links between articles"),
  ]
    .filter(Boolean)
    .join(" · ");
  const centre = focus && graph.nodes.find((each) => each.id === focus.id);
  const around = focus?.id ?? null;

  return page({
    title: centre ? `Graph · ${centre.label}` : "Graph",
    session,
    width: "full",
    current: "graph",
    scripts: ["graph"],
    main: html`
      <h1 class="page-title">Graph</h1>
      <p class="lede">
        Everything published here and how it hangs together: who wrote and annotated what, which pieces
        answer or link to one another, and who has been talking to whom. Select anything to open it, or to
        look only at what surrounds it.
        ${counts.canon > 0 && html`What belongs to <a href="/canon">the canon</a> is drawn in gold.`}
      </p>
      ${missing && notice("That is not on the graph: it has nothing published to its name yet. Here is all of it.", "ok")}
      ${empty
        ? html`<p class="empty">Nothing has been published yet, so there is nothing to draw.</p>`
        : html`
            ${centre &&
            html`<p class="graph__views graph__focus">
              Around <a href="${centre.href}"><strong>${centre.label}</strong></a
              >:
              ${REACH_WORDS.map(
                ([reach, words], i) =>
                  html`${i > 0 && " · "}${view(focus.reach === reach, graphHref({ around, reach, people }), words)}`
              )}
              <span class="graph__all">
                ${graph.nodes.length} of ${focus.of} shown · <a href="${graphHref({ people })}">The whole graph</a>
              </span>
            </p>`}
            <p class="graph__views">
              Show: ${view(people, graphHref({ around, reach: focus?.reach, people: true }), "Writing and people")}
              ${around?.[0] !== "u" &&
              html` · ${view(!people, graphHref({ around, reach: focus?.reach, people: false }), "Writing only")}`}
            </p>
            <div class="graph-frame">
              <div class="graph" data-graph data-people="${people ? "1" : ""}">
                <svg
                  class="graph__sheet"
                  viewBox="0 0 ${graph.width} ${graph.height}"
                  role="group"
                  aria-label="A graph of ${centre ? `what surrounds ${centre.label}` : tally}"
                >
                  <defs>
                    <marker id="arrow-ink" class="arrow arrow--ink" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0 1 L9 5 L0 9 z" />
                    </marker>
                    <marker id="arrow-gold" class="arrow arrow--gold" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0 1 L9 5 L0 9 z" />
                    </marker>
                  </defs>
                  <g>
                    ${edges.map(line)}
                  </g>
                  <g>
                    ${graph.nodes.map(node)}
                  </g>
                </svg>
              </div>
              <div class="graph__tools" role="group" aria-label="Zoom" data-graph-tools hidden>
                <button class="tool" type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
                <button class="tool" type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
                <button class="tool" type="button" data-zoom="fit" title="Show all of it">Fit</button>
              </div>
              <div class="graph__card" data-graph-card aria-live="polite" hidden></div>
            </div>
            <p class="hint graph__how" data-graph-how hidden>
              Drag to move about. Zoom with the buttons, a pinch, a double click, or by scrolling with
              <kbd data-modifier>Ctrl</kbd> held.
            </p>
            <ul class="key" aria-label="Key">
              ${counts.canon > 0 && keyNode("canon", html`<a href="/canon">The canon</a>`)}
              ${keyNode("article", "Article")} ${keyNode("commentary", "Commentary")}
              ${keyNode("post", "Short post")} ${people && keyNode("person", "Member")}
              ${keyEdge("commentary", "answers")} ${keyEdge("link", "links to")}
              ${people && keyEdge("wrote", "wrote")} ${people && keyEdge("note", "annotated")}
              ${people && keyEdge("address", "replied to or tagged")}
            </ul>
            <p class="hint graph__tally">${tally}. The more is said about a piece, the larger it is drawn.</p>
          `}
    `,
  });
}

/* ----------------------------------------------------- one member's page */

export function memberPage({ session, person, posts, notes, main = false }) {
  const self = person.id === session.user.id;
  const written = (post) => html`<li>
    <a class="index__title" href="/p/${post.id}">${named(post.title, post.body, 90)}</a>
    <span class="index__meta">
      ${raw(timeTag(post.published_at))}${post.parent_id &&
      html` · a commentary on ${named(post.parent_title, post.parent_opening)}`}
    </span>
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
        ${self && html` · <a href="/account">Your account</a>`}
        ${(posts.length > 0 || notes.length > 0) && html` · <a href="/graph?around=u${person.id}">On the graph</a>`}
      </p>

      <h2 class="section-title">Writing</h2>
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

export function membersPage({ session, members, error, issued, changed, values = {} }) {
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

      <h2 class="section-title">Add a member</h2>
      <form class="form form--inline" method="post" action="/members">
        ${csrfField(session)} ${notice(error)}
        <div>
          <label for="name">Full name</label>
          <input id="name" name="name" value="${values.name || ""}" maxlength="80" autocomplete="off" required />
        </div>
        <div>
          <label for="new-username">Sign-in name</label>
          <input
            id="new-username"
            name="username"
            value="${values.username || ""}"
            maxlength="32"
            pattern="[A-Za-z0-9._\\-]{2,32}"
            autocapitalize="none"
            autocomplete="off"
            spellcheck="false"
            required
          />
        </div>
        <button class="button" type="submit">Add</button>
      </form>
      <p class="hint">
        A password is made for them and shown to you once, to pass on. They can change it after signing in.
        Members can read, add margin notes, reply, tag each other by sign-in name and write commentaries,
        with pictures, formulas and diagrams; only admins can start new posts. What the main admin publishes
        is <a href="/canon">the canon</a>.
      </p>
      ${admin
        ? html`<p class="hint">
            A sub-admin is a member you have given some of what an admin can do: choose
            <em>Make sub-admin</em> beside their name and tick what they are to have. Each can be given
            something different, and it can be changed or taken back at any time.
          </p>`
        : html`<p class="hint">
            You are here as a sub-admin who manages the members. Admins and other sub-admins are for an admin
            to see to.
          </p>`}
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

/** one place the member was tagged, in words, as a link to it */
function tagged(tag) {
  const where = named(tag.post_title, tag.post_opening);
  const link = tag.note_id ? `/p/${tag.post_id}#note-${tag.note_id}` : `/p/${tag.post_id}`;
  const what = !tag.note_id ? "in" : tag.note_parent_id ? "in a reply on" : "in a margin note on";
  return html`<li>
    <a class="index__title" href="${link}">${tag.by_name} tagged you ${what} ${where}</a>
    ${tag.note_body && html`<span class="index__quote">${clip(tag.note_body, 160)}</span>`}
    <span class="index__meta">
      ${raw(timeTag(tag.created_at, "stamp"))}${tag.fresh && html` <span class="tag tag--new">New</span>`}
    </span>
  </li>`;
}

/* the ways the pages can look, each shown on the account page as a leaf of itself */
const LOOKS = [
  { theme: "night", name: "Night", says: "Gold on black, for reading late." },
  { theme: "paper", name: "Paper", says: "Ink on paper, as the front page is." },
];

export function accountPage({ session, tags = [], sessions = [], error, said }) {
  const { user } = session;
  const look = user.theme || "night";
  const elsewhere = sessions.filter((each) => each.id !== session.id);
  const signedIn = (each) => {
    const here = each.id === session.id;
    return html`<li>
      <span class="index__title">${each.agent || "A browser"}${here && html` <span class="tag tag--mark">This one</span>`}</span>
      <span class="index__meta">
        Signed in ${raw(timeTag(each.created_at))}${!here &&
        each.seen_at &&
        html` · last used ${raw(timeTag(each.seen_at, "stamp"))}`}
      </span>
      ${!here &&
      html`<form class="index__act" method="post" action="/account/sessions/${each.id}/end">
        ${csrfField(session)}
        <button class="link" type="submit">Sign it out</button>
      </form>`}
    </li>`;
  };
  return page({
    title: "Account",
    session,
    current: "account",
    main: html`
      <h1 class="page-title">${user.name}</h1>
      ${said?.of === "account" && notice(said.text, "ok")}
      <p class="hint">
        Signed in as <code>${user.username}</code> · ${standing(user)} ·
        <a href="${memberHref(user.username)}">Your page</a>
      </p>
      ${isSubAdmin(user) &&
      html`<p class="hint">
        As a sub-admin you have been given:
        ${held(user)
          .map((permission) => permission.name.toLowerCase())
          .join(", ")}.
        The <a href="/guide#admins">guide</a> says what each lets you do.
      </p>`}

      <h2 class="section-title" id="tags">Where you were tagged</h2>
      ${tags.length > 0
        ? html`<ul class="index index--notes">
            ${tags.map(tagged)}
          </ul>`
        : html`<p class="empty empty--notes">
            Nowhere yet. Others tag you by writing <code>@${user.username}</code> in a note or a post.
          </p>`}

      <h2 class="section-title" id="looks">How the pages look</h2>
      <form class="looks" method="post" action="/account/theme">
        ${csrfField(session)}
        ${LOOKS.map(
          ({ theme, name, says }) =>
            html`<button
              class="look look--${theme}"
              type="submit"
              name="theme"
              value="${theme}"
              aria-pressed="${theme === look ? "true" : "false"}"
            >
              <span class="look__leaf" aria-hidden="true"><span class="look__word">Aa</span></span>
              <span class="look__name">${name}${theme === look && html` <span class="tag tag--mark">Chosen</span>`}</span>
              <span class="look__says">${says}</span>
            </button>`
        )}
      </form>
      <p class="hint">Kept with your account, so it is the same wherever you sign in.</p>

      <h2 class="section-title" id="sessions">Where you are signed in</h2>
      ${said?.of === "sessions" && notice(said.text, "ok")}
      <ul class="index index--notes index--sessions">
        ${sessions.map(signedIn)}
      </ul>
      ${elsewhere.length > 0
        ? html`<form method="post" action="/account/sessions/end">
            ${csrfField(session)}
            <button class="button button--quiet" type="submit">Sign out everywhere else</button>
          </form>`
        : html`<p class="hint">Nowhere but here.</p>`}
      <p class="hint">
        A session ends when you sign out of it, and by itself after ${config.sessionDays} days. If one of
        these is not yours, sign it out and change your password.
      </p>

      <h2 class="section-title" id="password">Change password</h2>
      <form class="form form--narrow" method="post" action="/account/password#password">
        ${csrfField(session)} ${notice(error)}
        <label for="current">Current password</label>
        <input id="current" name="current" type="password" autocomplete="current-password" required />
        <label for="new-password">New password</label>
        <p class="hint">
          At least ${config.minPasswordLength} characters, and not your name. A few unrelated words make a
          good one. Changing it signs you out everywhere else.
        </p>
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
    `,
  });
}

/* ---------------------------------------------------------------- errors */

export function errorPage({ status, message, session }) {
  const main = html`
    <div class="lost">
      <p class="rubric">${status}</p>
      <h1 class="page-title">${message}</h1>
      <p><a href="/">Back to the journal</a></p>
    </div>
  `;
  if (session) return page({ title: String(status), session, main });
  return shell({ title: String(status), bodyClass: "bare", body: html`<main class="column">${main}</main>` });
}
