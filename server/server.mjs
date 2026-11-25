/*
 * The Gesserit forum: a corpus, and the members who read it.
 *
 * What a member comes to is the corpus (src/routes-corpus.mjs): everything
 * published here drawn about the essay at its centre. It has two layers. The
 * succession is what is written here; the antecedents are the works it
 * descends from, books and passages and films, each of them a post of
 * another kind. Every member can read what is published, add margin notes
 * to what is written here, reply to each other's notes and tag one another
 * with @name. Articles link to one another with [[Title]].
 *
 * The corpus is added to by those who keep it and by nobody else: the
 * admins, and the sub-admins given that. They have a page of their own for
 * it, Scribe, which lists every piece in two tables, the succession and the
 * antecedents, each in the order its keeper puts it in and each piece with
 * how far along it is, and which leads to the members.
 *
 * One of the admins is the main admin. What that admin publishes is the
 * canon, which has a page of its own.
 *
 * Posts take pictures, formulas and LaTeX diagrams. A note can be reworded
 * by its author, and keeps what it said.
 *
 * Some parts are put away for now, and each comes back with a switch (see
 * src/config.mjs): conversations (src/routes-chat.mjs), which are a room for
 * everyone, conversations between chosen members and a room for each
 * project, with the notifications of them on a member's devices; projects
 * (src/routes-projects.mjs), sets of pages that the members chosen for them
 * write together; the earlier wordings of a piece, each of which is still
 * kept as a numbered version but is not shown; and the list of those who are
 * to be invited (src/routes-numbers.mjs).
 *
 * gesserit.org itself is a static page on GitHub Pages. This server is meant
 * to sit beside it on a subdomain (forum.gesserit.org) and holds everything
 * that needs a login. Settings are read from the environment; see
 * src/config.mjs.
 *
 *   npm run add-user -- --admin <sign-in name> "<Full Name>"
 *   npm run add-user -- --main <sign-in name>
 *   npm start
 */

import { createServer } from "node:http";
import { join } from "node:path";
import { config, REPO_ROOT, SERVER_ROOT } from "./src/config.mjs";
import { adminLog, notes, posts, revisions, users } from "./src/db.mjs";
import { changes } from "./src/diff.mjs";
import {
  burnPassword,
  Busy,
  createSession,
  csrfMatches,
  destroySession,
  destroySessionsFor,
  findSession,
  generatePassword,
  hashPassword,
  passwordProblem,
  signInBlocked,
  signInCounts,
  signInFailed,
  signInSucceeded,
  sweepSessions,
  verifyPassword,
} from "./src/auth.mjs";
import {
  clientAddress,
  HttpError,
  localPath,
  readBody,
  readForm,
  redirect,
  Router,
  sameOrigin,
  send,
  sendFile,
  sendJson,
  sessionCookie,
  sessionToken,
  wantsJson,
} from "./src/http.mjs";
import { hangUp } from "./src/chat.mjs";
import { admin, allowed, field, form, isAdmin, isMainAdmin, may, member, NOT_FOUND, numericId, publisher, publishes, slowDown } from "./src/gate.mjs";
import { isSubAdmin, permissionKeys, scribes } from "./src/permissions.mjs";
import { projects } from "./src/projects.mjs";
import { chatRoutes } from "./src/routes-chat.mjs";
import { corpusRoutes, editWork, saveWork } from "./src/routes-corpus.mjs";
import { projectRoutes } from "./src/routes-projects.mjs";
import { numberRoutes, textsOf } from "./src/routes-numbers.mjs";
import { pushRoutes } from "./src/routes-push.mjs";
import { relayRoutes } from "./src/routes-relay.mjs";
import * as relay from "./src/relay.mjs";
import { markNamed, markNote, markSvg, markWords } from "./src/mark.mjs";
import { INERT, keep, pictureKept, sendMedia } from "./src/media.mjs";
import { lapse } from "./src/numbers.mjs";
import { paced, sweepPace } from "./src/pace.mjs";
import { editable, renderPost, typeset } from "./src/render.mjs";
import { find } from "./src/search.mjs";
import { readStatus } from "./src/status.mjs";
import { svgOf } from "./src/tex.mjs";
import {
  accountPage,
  canonPage,
  changesPage,
  errorPage,
  historyPage,
  memberPage,
  membersPage,
  permissionsPage,
  picturePage,
  postPage,
  scribePage,
  searchPage,
  signInPage,
  versionPage,
  writePage,
} from "./src/views.mjs";
import { indexLinks, noteSaved, postSaved, prepare } from "./src/weave.mjs";
import { readCuration } from "./src/works.mjs";

const router = new Router();

const wrote = (ctx, post) => post.author_id === ctx.session.user.id;

/** a post the current member may see: one that is not published is for whoever is writing it, the admins and the sub-admins who edit */
function visiblePost(ctx, id = numericId(ctx.params.id)) {
  const post = posts.byId(id);
  if (!post || (post.status === "draft" && !may(ctx, "edit") && !wrote(ctx, post))) throw new HttpError(404, NOT_FOUND);
  return post;
}

/**
 * A post the current member may change or delete: any, for an admin or a
 * sub-admin who edits; and their own, for those who publish. The corpus is
 * kept by those who keep it, and nobody else changes anything in it.
 */
function ownPost(ctx) {
  const post = visiblePost(ctx);
  if (may(ctx, "edit")) return post;
  if (!publishes(ctx) || !wrote(ctx, post)) throw new HttpError(403, "Only those who keep the corpus can change this.");
  return post;
}

/** everything a post's page shows besides the post */
const aroundPost = (post) => ({
  threads: notes.threads(post.id),
  commentaries: posts.commentaries(post.id),
  linkedFrom: posts.linkedFrom(post.id),
  centre: posts.centre()?.id === post.id,
});

/** an invitation not taken up in its time is let go of, and its link stops working */
function lapseInvitations() {
  try {
    const lapsed = lapse();
    if (lapsed > 0) console.log(`${new Date().toISOString()} ${lapsed} invitation(s) lapsed without being taken up`);
  } catch (error) {
    console.error("could not let the old invitations go:", error.message);
  }
}

/* ---------------------------------------------------------------- sign in */

router.get("/login", (ctx) => {
  const next = localPath(ctx.url.searchParams.get("next"));
  if (ctx.session) return redirect(ctx.res, next);
  send(ctx.res, 200, signInPage({ next }));
});

router.post("/login", async (ctx) => {
  const body = await readForm(ctx.req);
  const username = (body.get("username") || "").trim();
  const password = body.get("password") || "";
  const next = localPath(body.get("next"));
  const counts = signInCounts(clientAddress(ctx.req), username);
  const fail = (status, error) => send(ctx.res, status, signInPage({ error, next, username }));

  if (counts.some(([key, most]) => signInBlocked(key, most))) {
    console.warn(`${new Date().toISOString()} sign-in refused after too many attempts: ${JSON.stringify(username.slice(0, 40))} from ${clientAddress(ctx.req)}`);
    return fail(429, "Too many attempts. Wait a quarter of an hour and try again.");
  }

  // a password longer than any here can be is not worth the work of checking
  const user = username && password.length <= 1000 ? users.byUsername(username) : null;
  const ok = user ? await verifyPassword(password, user.password_hash) : await burnPassword(password.slice(0, 1000));
  if (!user || !ok || !user.active) {
    for (const [key] of counts) signInFailed(key);
    return fail(401, "That name and password do not match.");
  }

  // only this name from this address is forgiven: getting one account right excuses no guessing at others
  signInSucceeded(counts[0][0]);
  redirect(ctx.res, next, { "Set-Cookie": sessionCookie(createSession(user.id, ctx.req.headers["user-agent"])) });
});

router.post("/logout", member, form, (ctx) => {
  destroySession(ctx.session.tokenHash);
  redirect(ctx.res, "/login", { "Set-Cookie": sessionCookie("", { clear: true }) });
});

/* ----------------------------------------------------------------- scribe */

/**
 * Where the corpus is kept from: every piece there is, written here or made
 * elsewhere, with how far along each is and the way to change it. It is for
 * those who keep the forum. Everyone else is taken to the corpus itself,
 * which is what they come for.
 */
router.get("/", member, (ctx) => {
  const { user } = ctx.session;
  if (!scribes(user)) return redirect(ctx.res, "/corpus");
  send(
    ctx.res,
    200,
    scribePage({
      session: ctx.session,
      // what is not published is for those who edit; anyone else here sees their own of it
      pieces: posts.ledger({ own: may(ctx, "edit") ? null : user.id }),
      sends: isMainAdmin(ctx),
      projects: config.projects ? { mine: projects.of(user.id), open: projects.openTo(user.id).length } : null,
    })
  );
});

/** says how far along a piece is, or publishes it, from the list of every piece */
router.post("/p/:id/status", member, form, (ctx) => {
  const post = ownPost(ctx);
  const chosen = readStatus(field(ctx, "status"));
  if (!chosen) throw new HttpError(400, "There is no such status.");
  if (chosen.status !== post.status || (chosen.stage && chosen.stage !== post.stage)) {
    posts.setStatus(post.id, chosen);
    // publishing it, or taking it back, changes what links to it and whom it tags
    if (chosen.status !== post.status) postSaved(post.id, { by: ctx.session.user.id });
  }
  if (wantsJson(ctx.req)) return sendJson(ctx.res, 200, { ok: true });
  redirect(ctx.res, "/");
});

/** puts the pieces of one of the two tables in the order given: `ids`, the first first */
router.post("/order", allowed("edit"), form, (ctx) => {
  const ids = field(ctx, "ids").split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0 || ids.length > 5000 || new Set(ids).size !== ids.length || ids.some((id) => !/^[1-9]\d{0,14}$/.test(id)))
    throw new HttpError(400, "That order could not be read.");
  posts.arrange(ids.map(Number));
  if (wantsJson(ctx.req)) return sendJson(ctx.res, 200, { ok: true });
  redirect(ctx.res, "/");
});

/** what a few words find in what is written here, its margins and, where there are projects, those the member may read */
router.get("/search", member, (ctx) => {
  const q = (ctx.url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, config.maxSearchLength);
  send(ctx.res, 200, searchPage({ session: ctx.session, q, found: q ? find(q, ctx.session.user) : null }));
});

/** a post's page, once its diagrams are drawn */
async function showPost(ctx, post, extra = {}, status = 200) {
  await prepare(post.body);
  send(ctx.res, status, postPage({ session: ctx.session, post, ...aroundPost(post), numbers: isMainAdmin(ctx), ...extra }));
}

router.get("/p/:id", member, (ctx) => showPost(ctx, visiblePost(ctx)));

/* ------------------------------------------------ margin notes and replies */

/**
 * The note a reply is being made to. Threads are one level deep, so a reply
 * to a reply joins the thread of the note above it.
 */
function threadFor(post, value) {
  const gone = new HttpError(404, "That note is no longer here to reply to.");
  if (!/^[1-9]\d{0,14}$/.test(value)) throw gone;
  let note = notes.byId(Number(value));
  if (note?.parent_id) note = notes.byId(note.parent_id);
  if (!note || note.post_id !== post.id || note.removed_at) throw gone;
  return note;
}

/** what is the matter with the words of a note or reply, if anything */
const noteError = (body, what) =>
  !body
    ? `A ${what} needs some words.`
    : body.length > config.maxNoteLength
      ? `Keep a ${what} under ${config.maxNoteLength} characters.`
      : null;

router.post("/p/:id/notes", member, form, (ctx) => {
  const post = visiblePost(ctx);
  if (post.status !== "published") throw new HttpError(403, "Notes open once this is published.");
  // an antecedent's page is what the corpus says of it, and has no margin
  if (post.kind === "work") throw new HttpError(403, "An antecedent has no margin to write in.");

  const parent = ctx.form.has("parent") ? threadFor(post, field(ctx, "parent")) : null;
  const body = field(ctx, "body");
  // only a note on the post itself can point at a passage in it
  const quote = parent ? "" : field(ctx, "quote").replace(/\s+/g, " ").slice(0, config.maxQuoteLength);
  const pos = /^\d{1,9}$/.test(field(ctx, "pos")) ? Number(field(ctx, "pos")) : null;

  const error = noteError(body, parent ? "reply" : "note");
  if (error) {
    const draft = parent ? { draftReply: { parentId: parent.id, body } } : { draftNote: { body, quote, pos } };
    return showPost(ctx, post, { error, ...draft }, 422);
  }

  const userId = ctx.session.user.id;
  const id = notes.create({
    postId: post.id,
    userId,
    parentId: parent ? parent.id : null,
    body,
    quote: quote || null,
    quotePos: quote ? pos : null,
    version: post.version,
  });
  noteSaved({ id, postId: post.id, userId, body });
  redirect(ctx.res, `/p/${post.id}#note-${id}`);
});

/** a note is reworded by whoever wrote it, and by no one else; what it said before is kept */
router.post("/notes/:id/edit", member, form, (ctx) => {
  const note = notes.byId(numericId(ctx.params.id));
  if (!note || note.removed_at) throw new HttpError(404, NOT_FOUND);
  const post = visiblePost(ctx, note.post_id);
  if (note.user_id !== ctx.session.user.id) throw new HttpError(403, "Only its author can reword this.");

  const body = field(ctx, "body");
  const error = noteError(body, note.parent_id ? "reply" : "note");
  if (error) return showPost(ctx, post, { error, draftEdit: { noteId: note.id, body } }, 422);
  if (body !== note.body) {
    notes.reword(note, body);
    noteSaved({ id: note.id, postId: post.id, userId: note.user_id, body });
  }
  redirect(ctx.res, `/p/${post.id}#note-${note.id}`);
});

router.post("/notes/:id/remove", member, form, (ctx) => {
  const note = notes.byId(numericId(ctx.params.id));
  if (!note || note.removed_at) throw new HttpError(404, NOT_FOUND);
  const { user } = ctx.session;
  if (!may(ctx, "moderate") && user.id !== note.user_id)
    throw new HttpError(403, "Only its author or an admin can remove this.");
  notes.remove(note.id, user.id);
  redirect(ctx.res, `/p/${note.post_id}#notes`);
});

/* ---------------------------------------------------------------- writing */

/**
 * What the form says of a piece written here, to be saved over `post` or as
 * a new one. What the corpus says of a piece is read only from those who
 * edit, whose it is to say. A piece needs a title or some words: one that is
 * only a title is one that has not been started.
 */
function readPost(ctx, post = null) {
  const curation = may(ctx, "edit") ? readCuration((name) => ctx.form.get(name), { work: false }) : null;
  const values = {
    title: field(ctx, "title").replace(/\s+/g, " "),
    // browsers send a form's line breaks as CR LF; kept plain, so one wording compares with the next
    body: (ctx.form.get("body") || "").replace(/\r\n?/g, "\n"),
    summary: field(ctx, "summary").replace(/\s+/g, " ").slice(0, 200),
    ...curation?.values,
  };
  const written = Boolean(values.body.trim());
  const status = ctx.form.get("status") === "draft" ? "draft" : "published";
  // How far along it is, is for its keeper to say in the list of every piece. Here it is only begun:
  // a new piece that is published was finished, and one that was not started is in progress once it has words.
  const stage = !post ? (status === "published" ? "finished" : written ? "in-progress" : "not-started") : post.stage === "not-started" && written ? "in-progress" : null;
  const error =
    !written && !values.title
      ? "There is nothing to save yet."
      : values.title.length > 200
        ? "Keep the title under 200 characters."
        : curation?.error || null;
  return { values, status, stage, curation: curation?.values, error };
}

/**
 * What a new post answers, if it is a commentary. Those who publish may
 * write one on what is published; anything else a member would add goes to
 * selection as a piece of its own.
 */
function answered(ctx, value) {
  if (!value) return null;
  if (!may(ctx, "write")) throw new HttpError(403, "Only those who publish here can answer a piece with a commentary.");
  const post = /^[1-9]\d{0,14}$/.test(value) ? posts.byId(Number(value)) : null;
  if (!post || post.status !== "published")
    throw new HttpError(404, "That post is no longer here to write a commentary on.");
  return post;
}

/** whether a piece stands at the centre of the corpus, where what is said of it is its claims */
const atCentre = (post) => Boolean(post) && posts.centre()?.id === post.id;

router.get("/write", publisher, (ctx) => {
  const on = answered(ctx, ctx.url.searchParams.get("on") || "");
  send(ctx.res, 200, writePage({ session: ctx.session, on }));
});

router.post("/write", publisher, form, (ctx) => {
  const on = answered(ctx, field(ctx, "on"));
  const { values, status, stage, curation, error } = readPost(ctx);
  if (error) return send(ctx.res, 422, writePage({ session: ctx.session, on, values, error }));
  const id = posts.create({
    authorId: ctx.session.user.id,
    parentId: on ? on.id : null,
    title: values.title || null,
    body: values.body,
    status,
    stage,
  });
  if (curation) posts.curate(id, curation);
  postSaved(id, { by: ctx.session.user.id });
  redirect(ctx.res, `/p/${id}`);
});

router.get("/p/:id/edit", member, (ctx) => {
  const post = ownPost(ctx);
  // a work is changed with the form it was added with
  if (post.kind === "work") return editWork(ctx, post);
  send(ctx.res, 200, writePage({ session: ctx.session, post, centre: atCentre(post) }));
});

router.post("/p/:id/edit", member, form, (ctx) => {
  const post = ownPost(ctx);
  if (post.kind === "work") return saveWork(ctx, post);
  const { values, status, stage, curation, error } = readPost(ctx, post);
  const again = (code, message) =>
    send(ctx.res, code, writePage({ session: ctx.session, post, centre: atCentre(post), values, error: message }));
  if (error) return again(422, error);
  // the form says which saving of the post it began from; if someone has saved since, say so
  // rather than write over what they did. Sent again from this page, it goes through.
  const base = field(ctx, "base");
  if (base && base !== post.updated_at)
    return again(
      409,
      "This was changed while you were writing. What you wrote is still below. Look at the current text in another tab, bring across anything you want to keep, then save again to put yours in its place."
    );
  posts.update(post.id, { title: values.title || null, body: values.body, status, stage });
  if (curation) posts.curate(post.id, curation);
  postSaved(post.id, { by: ctx.session.user.id, summary: values.summary });
  redirect(ctx.res, `/p/${post.id}`);
});

/** how a text will look, for the preview beside the editor */
router.post("/preview", member, form, async (ctx) => {
  const body = (ctx.form.get("body") || "").replace(/\r\n?/g, "\n");
  await prepare(body, { keep: false });
  sendJson(ctx.res, 200, { html: typeset(renderPost(body, { initial: Boolean(field(ctx, "title")) })) });
});

/* the same text set out for the editor's page: each paragraph, heading, list and figure with the words that made it */
router.post("/blocks", member, form, async (ctx) => {
  const body = (ctx.form.get("body") || "").replace(/\r\n?/g, "\n");
  await prepare(body, { keep: false });
  sendJson(ctx.res, 200, editable(body));
});

/* --------------------------------------------------------------- versions */

/*
 * Every wording a piece is published with is kept as a version (see weave.mjs), whether or not
 * anything is made of it. The pages they are read, compared and put back from are put away, and
 * are here again when they are asked for.
 */
if (config.versions) {
  router.get("/p/:id/history", member, (ctx) => {
    const post = visiblePost(ctx);
    send(ctx.res, 200, historyPage({ session: ctx.session, post, versions: revisions.list(post.id) }));
  });

  router.get("/p/:id/v/:n", member, async (ctx) => {
    const post = visiblePost(ctx);
    const version = revisions.get(post.id, numericId(ctx.params.n));
    if (!version) throw new HttpError(404, "This has no such version.");
    await prepare(version.body);
    send(ctx.res, 200, versionPage({ session: ctx.session, post, version }));
  });

  /** what changed between two versions: by default, what the latest changed */
  router.get("/p/:id/changes", member, (ctx) => {
    const post = visiblePost(ctx);
    const asked = (name) => Number.parseInt(ctx.url.searchParams.get(name), 10);
    const to = asked("to") || post.version;
    const from = asked("from") || to - 1;
    const [before, after] = [revisions.get(post.id, from), revisions.get(post.id, to)];
    if (!before || !after) throw new HttpError(404, "There are no two such versions to compare.");
    send(
      ctx.res,
      200,
      changesPage({
        session: ctx.session,
        post,
        before,
        after,
        versions: revisions.list(post.id),
        diff: changes(before.body, after.body),
      })
    );
  });

  /** puts an earlier version's wording back, as a new version; nothing is lost by it */
  router.post("/p/:id/restore", member, form, (ctx) => {
    const post = ownPost(ctx);
    const version = /^[1-9]\d{0,8}$/.test(field(ctx, "n")) ? revisions.get(post.id, Number(field(ctx, "n"))) : null;
    if (!version) throw new HttpError(404, "This has no such version.");
    posts.update(post.id, { title: version.title, body: version.body, status: post.status });
    postSaved(post.id, { by: ctx.session.user.id, summary: `Restored version ${version.n}` });
    redirect(ctx.res, `/p/${post.id}`);
  });
}

/* -------------------------------------------------- pictures and diagrams */

/** a picture for a post: the file itself is the body of the request */
router.post("/media", member, async (ctx) => {
  if (!csrfMatches(ctx.session, ctx.req.headers["x-csrf-token"]))
    throw new HttpError(403, "This page is out of date. Reload it and try again.");
  const megabytes = Math.round(config.maxUploadBytes / 1024 / 1024);
  const file = await readBody(ctx.req, config.maxUploadBytes, `A picture can be up to ${megabytes} MB.`);
  let original = "";
  try {
    original = decodeURIComponent(String(ctx.req.headers["x-file-name"] || ""));
  } catch {
    // an unreadable name is no reason to refuse the picture
  }
  sendJson(ctx.res, 201, { url: await keep(file, { userId: ctx.session.user.id, original }) });
});

/**
 * A picture. Set in a page, it is the picture and nothing else. Opened by
 * itself it is shown on a page of the forum, which carries its reader's mark
 * as every page does. Either way the file says who fetched it.
 */
router.get("/media/:name", member, async (ctx) => {
  const { name } = ctx.params;
  const { session } = ctx;
  // a browser says when an address is being gone to and not fetched for a page: in a tab, a frame or an app's own window
  const { "sec-fetch-dest": dest, "sec-fetch-mode": mode } = ctx.req.headers;
  if (dest === "document" || mode === "navigate") {
    if (!pictureKept(name)) throw new HttpError(404, "That picture is not here.");
    return send(ctx.res, 200, picturePage({ session, src: `/media/${name}` }));
  }
  slowDown(paced(session.user.id, "pictures"));
  await sendMedia(ctx.res, name, markNote(session));
});

/** the mark laid over this session's pages: who is reading, and when */
router.get("/mark/:name", member, (ctx) => {
  const named = markNamed(ctx.params.name, ctx.session);
  if (!named) throw new HttpError(404, NOT_FOUND);
  send(ctx.res, 200, markSvg(markWords(ctx.session, named.day), named.theme), {
    "Content-Type": "image/svg+xml",
    // it is one member's, and the same all day
    "Cache-Control": "private, max-age=86400",
    "Content-Security-Policy": INERT,
  });
});

router.get("/tex/:file", member, (ctx) => {
  const svg = /^[0-9a-f]{32}\.svg$/.test(ctx.params.file) ? svgOf(ctx.params.file.slice(0, 32)) : null;
  if (!svg) throw new HttpError(404, "That drawing is not here.");
  send(ctx.res, 200, svg, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    // a drawing's address is a hash of its source, so it never changes
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Security-Policy": INERT,
  });
});

router.post("/p/:id/delete", member, form, (ctx) => {
  const post = ownPost(ctx);
  posts.remove(post.id);
  indexLinks(post.id);
  // back to where it was listed: under what it answered, or in the list of every piece
  redirect(ctx.res, post.parent_id && post.parent_status === "published" ? `/p/${post.parent_id}#commentaries` : "/");
});

/* --------------------------------------------------------- people and names */

router.get("/m/:username", member, (ctx) => {
  const person = users.byUsername(ctx.params.username);
  if (!person) throw new HttpError(404, "There is no member by that name.");
  send(
    ctx.res,
    200,
    memberPage({
      session: ctx.session,
      person,
      // a piece put here for someone else, with a letter after its title to say so, is not this member's writing
      posts: posts.byAuthor(person.id).filter((post) => !post.hand),
      notes: notes.byUser(person.id),
      main: users.main()?.id === person.id,
    })
  );
});

/** the canon: what the main admin has published */
router.get("/canon", member, (ctx) =>
  send(ctx.res, 200, canonPage({ session: ctx.session, keeper: users.main(), posts: posts.canon() }))
);

/** what the writing boxes offer after an @ or a [[: the other members, and the articles that have titles */
router.get("/suggest.json", member, (ctx) => {
  const body = JSON.stringify({
    people: users
      .active()
      .filter((user) => user.id !== ctx.session.user.id)
      .map(({ username, name }) => ({ username, name })),
    articles: posts.titles(),
  });
  send(ctx.res, 200, body, { "Content-Type": "application/json; charset=utf-8" });
});

/* ---------------------------------------------------------------- members */

const membersView = (ctx, extra = {}) =>
  membersPage({ session: ctx.session, members: users.all(), ...extra });

/* the members' list is for the admins, and for the sub-admins given the members to manage */
const keeper = allowed("members");

/**
 * Someone the one asking may act on: never themselves. A sub-admin reaches
 * the members and no further, or one could give an admin a new password and
 * sign in as them, or put another sub-admin out.
 */
function otherMember(ctx) {
  const target = users.byId(numericId(ctx.params.id));
  if (!target) throw new HttpError(404, "No such member.");
  if (target.id === ctx.session.user.id) throw new HttpError(400, "Use your account page for that.");
  if (!isAdmin(ctx) && (target.role === "admin" || isSubAdmin(target)))
    throw new HttpError(403, "Only an admin can do that to an admin or a sub-admin.");
  return target;
}

router.get("/members", keeper, (ctx) => {
  // said once, on coming back from choosing what someone may do
  const changed = isAdmin(ctx) && /^[1-9]\d{0,14}$/.test(ctx.url.searchParams.get("changed") || "")
    ? users.byId(Number(ctx.url.searchParams.get("changed")))
    : null;
  send(ctx.res, 200, membersView(ctx, { changed: changed && changed.role !== "admin" ? changed : null }));
});

/** the main admin hands that place on to another admin; nobody else can */
router.post("/members/:id/main", admin, form, (ctx) => {
  if (users.main()?.id !== ctx.session.user.id) throw new HttpError(403, "Only the main admin can hand that place on.");
  const target = users.byId(numericId(ctx.params.id));
  if (!target) throw new HttpError(404, "No such member.");
  if (target.role !== "admin" || !target.active) throw new HttpError(400, "Only an admin can be made the main admin.");
  users.setMain(target.id);
  adminLog.record({ by: ctx.session.user.id, action: "main", member: target.id });
  redirect(ctx.res, "/members");
});

/**
 * Someone who can be made a sub-admin, or be one no longer: a member who can
 * still sign in. An admin has no need of permissions, and nobody chooses
 * their own.
 */
function grantee(ctx) {
  const target = otherMember(ctx);
  if (target.role === "admin") throw new HttpError(400, "An admin can already do everything.");
  if (!target.active) throw new HttpError(400, "Restore them first: someone who has been removed can do nothing here.");
  return target;
}

/** what a member may do besides what every member may; only an admin chooses it */
router.get("/members/:id/permissions", admin, (ctx) =>
  send(ctx.res, 200, permissionsPage({ session: ctx.session, member: grantee(ctx) }))
);

router.post("/members/:id/permissions", admin, form, (ctx) => {
  const target = grantee(ctx);
  // whatever is not a permission is passed over, and with nothing ticked they are a member again
  const keys = permissionKeys(ctx.form.getAll("can"));
  users.setPermissions(target.id, keys);
  adminLog.record({ by: ctx.session.user.id, action: "permissions", member: target.id, detail: keys.join(" ") });
  redirect(ctx.res, `/members?changed=${target.id}`);
});

router.post("/members/:id/password", keeper, form, async (ctx) => {
  const target = otherMember(ctx);
  // or any admin could sign in as the main one, and the canon would be anybody's
  if (users.main()?.id === target.id)
    throw new HttpError(400, "The main admin’s password is theirs to change. If it is lost, it can be reset from the server.");
  const password = generatePassword();
  users.setPassword(target.id, await hashPassword(password));
  destroySessionsFor(target.id);
  adminLog.record({ by: ctx.session.user.id, action: "password", member: target.id });
  send(ctx.res, 200, membersView(ctx, { issued: { name: target.name, username: target.username, password } }));
});

router.post("/members/:id/remove", keeper, form, (ctx) => {
  const target = otherMember(ctx);
  if (target.role === "admin") throw new HttpError(400, "An admin cannot be removed here.");
  users.setActive(target.id, false);
  // whoever comes back comes back as a member: what a sub-admin could do is an admin's to give again
  users.setPermissions(target.id, []);
  destroySessionsFor(target.id);
  adminLog.record({ by: ctx.session.user.id, action: "removed", member: target.id });
  redirect(ctx.res, "/members");
});

router.post("/members/:id/restore", keeper, form, (ctx) => {
  const target = otherMember(ctx);
  users.setActive(target.id, true);
  adminLog.record({ by: ctx.session.user.id, action: "restored", member: target.id });
  redirect(ctx.res, "/members");
});

/* ---------------------------------------------------------------- account */

/* a member's preferences: the lighting of the pages, and their password */

const THEMES = ["night", "paper"];

router.get("/account", member, (ctx) =>
  send(
    ctx.res,
    200,
    accountPage({
      session: ctx.session,
      texts: textsOf(users.byId(ctx.session.user.id)),
      said:
        {
          password: "Your password has been changed, and you have been signed out everywhere else.",
          texts: "Saved.",
        }[ctx.url.searchParams.get("done")] ?? null,
    })
  )
);

router.post("/account/password", member, form, async (ctx) => {
  const current = ctx.form.get("current") || "";
  const password = ctx.form.get("password") || "";
  const user = users.byId(ctx.session.user.id);
  // guessing at the current password from a session left open is counted like guessing at the door
  const key = `changing ${user.id}`;
  const error = signInBlocked(key)
    ? "Too many attempts. Wait a quarter of an hour and try again."
    : current.length > 1000 || !(await verifyPassword(current, user.password_hash))
      ? (signInFailed(key), "That is not your current password.")
      : password === current
        ? "That is the password you have now. Choose a new one."
        : passwordProblem(password, user);
  if (error) return send(ctx.res, 422, accountPage({ session: ctx.session, error, texts: textsOf(user) }));
  signInSucceeded(key);
  users.setPassword(user.id, await hashPassword(password));
  destroySessionsFor(user.id, ctx.session.tokenHash);
  redirect(ctx.res, "/account?done=password");
});

/** how the pages look: the dark page or the light one */
router.post("/account/theme", member, form, (ctx) => {
  const theme = field(ctx, "theme");
  if (!THEMES.includes(theme)) throw new HttpError(400, "There is no such way for the pages to look.");
  users.setTheme(ctx.session.user.id, theme);
  redirect(ctx.res, "/account#lighting");
});

/* --------------------------- the corpus, and what is put away or brought back */

corpusRoutes(router);
pushRoutes(router);
numberRoutes(router);
relayRoutes(router);
// the projects have a conversation each, which is there when the conversations are
if (config.messages) chatRoutes(router);
if (config.projects) projectRoutes(router);

/* ----------------------------------------------------------- static files */

const PUBLIC = join(SERVER_ROOT, "public");
const ASSETS = join(REPO_ROOT, "assets");

const KATEX = join(SERVER_ROOT, "node_modules", "katex", "dist");

router.get("/static/:file", (ctx) => sendFile(ctx.res, PUBLIC, ctx.params.file));
// the stylesheet and the fonts formulas are set in, from where npm put them
router.get("/katex/katex.min.css", (ctx) => sendFile(ctx.res, KATEX, "katex.min.css"));
router.get("/katex/fonts/:file", (ctx) => sendFile(ctx.res, join(KATEX, "fonts"), ctx.params.file));
// the ornament and the initials are the landing page's own, served from where they live
router.get("/assets/:file", (ctx) => sendFile(ctx.res, ASSETS, ctx.params.file));
// the typeface is here too, so that no page sends a reader's browser to a font service
router.get("/assets/fonts/:file", (ctx) =>
  sendFile(ctx.res, join(ASSETS, "fonts"), ctx.params.file, "public, max-age=2592000")
);
router.get("/robots.txt", (ctx) =>
  send(ctx.res, 200, "User-agent: *\nDisallow: /\n", { "Content-Type": "text/plain; charset=utf-8" })
);

/* ------------------------------------------------------------- the server */

async function handle(req, res) {
  const ctx = { req, res, url: null, params: {}, session: null, form: null };
  try {
    // an address that cannot be read is answered like any other that leads nowhere
    try {
      ctx.url = new URL(req.url.replace(/^\/{2,}/, "/"), "http://localhost");
    } catch {
      throw new HttpError(400, "That address cannot be read.");
    }
    const { url } = ctx;
    ctx.session = findSession(sessionToken(req));

    const route = router.match(req.method, url.pathname);
    if (!route) throw new HttpError(404, NOT_FOUND);
    if (route.methodNotAllowed) throw new HttpError(405, "That action is not allowed here.");
    if (req.method === "POST" && !sameOrigin(req))
      throw new HttpError(403, "That request came from somewhere else.");

    ctx.params = route.params;
    for (const handler of route.handlers) {
      // a gatekeeper that has already answered returns true
      if ((await handler(ctx)) === true || res.writableEnded) break;
    }
  } catch (err) {
    const known = err instanceof HttpError;
    const busy = err instanceof Busy;
    const status = known ? err.status : busy ? 503 : err instanceof URIError ? 404 : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    const message = known || busy ? err.message : status === 404 ? NOT_FOUND : "Something went wrong.";
    const headers = busy ? { "Retry-After": "5" } : known ? err.headers : {};
    if (wantsJson(req)) return send(res, status, JSON.stringify({ error: message }), { "Content-Type": "application/json; charset=utf-8", ...headers });
    send(res, status, errorPage({ status, message, session: ctx.session }), headers);
  }
}

/** nothing a request can do may take the server down with it: what is not caught above is caught here */
function serve(req, res) {
  handle(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) return res.destroy();
    try {
      send(res, 500, "Something went wrong.", { "Content-Type": "text/plain; charset=utf-8" });
    } catch {
      res.destroy();
    }
  });
}

// links made before this server kept an index of them, or while it was not running
indexLinks();

sweepSessions();
setInterval(sweepSessions, 24 * 60 * 60 * 1000).unref();
lapseInvitations();
relay.start();
setInterval(lapseInvitations, 6 * 60 * 60 * 1000).unref();
setInterval(sweepPace, 60 * 60 * 1000).unref();

const server = createServer(serve);
// a visitor who opens a connection and then says nothing, or says it a byte at a time, is not waited on for long
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 10_000;
server.maxHeadersCount = 100;
// a connection that breaks the rules of HTTP is closed with a plain refusal, and nothing more is made of it
server.on("clientError", (err, socket) => {
  if (socket.writable && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  else socket.destroy();
});

server.listen(config.port, config.host, () => {
  console.log(`Gesserit forum listening on http://${config.host}:${config.port}`);
  if (!config.secureCookies && !["127.0.0.1", "::1", "localhost"].includes(config.host))
    console.warn(
      "PUBLIC_URL is not an https address, so sessions are not marked Secure. Set it before members sign in over a network."
    );
  if (users.count() === 0)
    console.log(
      'No members yet. Make the first admin with:\n  npm run add-user -- --admin <sign-in name> "<Full Name>"'
    );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // the pages listening to conversations hold their connections open; let go of them
    hangUp();
    server.closeIdleConnections();
  });
}
