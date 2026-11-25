/*
 * Who may pass. These stand in front of the routes: each either lets a
 * request through, answers it itself (and returns true), or refuses it by
 * throwing.
 */

import { csrfMatches } from "./auth.mjs";
import { rooms } from "./chat.mjs";
import { config } from "./config.mjs";
import { users } from "./db.mjs";
import { HttpError, readForm, redirect, wantsJson } from "./http.mjs";
import { paced } from "./pace.mjs";
import { can } from "./permissions.mjs";
import { subscriptions } from "./push.mjs";

export const NOT_FOUND = "That page could not be found.";

/**
 * Whether a request is for something to read: a page, or a part of one. What
 * a page's own script asks for as it works (suggestions, previews, the open
 * line of a conversation, the reader's mark) is not, and pictures are counted
 * apart, where they are sent.
 */
function isReading({ req, url }) {
  if (req.method !== "GET") return false;
  const accept = String(req.headers.accept || "");
  if (accept.includes("application/json") || accept.includes("text/event-stream")) return false;
  if (/^\/(media|mark|tex)\//.test(url.pathname) || url.pathname.endsWith(".json")) return false;
  const dest = req.headers["sec-fetch-dest"];
  return !dest || dest === "document" || dest === "empty";
}

/** refuses, for as long as `wait` says, a member who is asking faster than anyone reads */
export function slowDown(wait) {
  if (wait === null || !config.pace) return;
  throw new HttpError(429, "Pages are being asked for faster than anyone reads. Wait a little and carry on.", {
    "Retry-After": String(wait),
  });
}

/** everything past the sign-in page needs a session */
export function member(ctx) {
  if (ctx.session) {
    if (isReading(ctx)) slowDown(paced(ctx.session.user.id));
    // where there are conversations, the menu of every page says how much of the talk is unread
    ctx.session.unread = config.messages ? rooms.unread(ctx.session.user.id) : 0;
    // and whether this sign-in has notifications turned on, which the script that asks for them goes by
    ctx.session.pushed = config.notifications && subscriptions.on(ctx.session.tokenHash);
    return;
  }
  // the page's own script is told plainly, so it can say so and keep what was being written
  if (wantsJson(ctx.req)) throw new HttpError(401, "You have been signed out. Sign in again in another tab, then carry on here.");
  if (ctx.req.method === "GET" || ctx.req.method === "HEAD") {
    const next = ctx.url.pathname + ctx.url.search;
    redirect(ctx.res, next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  } else {
    redirect(ctx.res, "/login");
  }
  return true;
}

export const isAdmin = (ctx) => ctx.session.user.role === "admin";

/** whether the member asking is the main admin */
export const isMainAdmin = (ctx) => users.main()?.id === ctx.session.user.id;

/**
 * A gate: the main admin, and nobody else. What stands behind it is the main
 * admin's own (the chats sent to from here, the texts about what is
 * published), and to anyone else, an admin included, it is not there.
 */
export function mainAdmin(ctx) {
  if (member(ctx)) return true;
  if (!isMainAdmin(ctx)) throw new HttpError(404, NOT_FOUND);
}

/**
 * A gate: the admins, and nobody else. What stands behind it (who is to be
 * invited, and how they are reached) is not there to a member, nor to a
 * sub-admin whatever they have been given.
 */
export function admins(ctx) {
  if (member(ctx)) return true;
  if (!isAdmin(ctx)) throw new HttpError(404, NOT_FOUND);
}

/** what only an admin may do, whatever a sub-admin has been given: naming the main admin, making sub-admins */
export function admin(ctx) {
  if (member(ctx)) return true;
  if (!isAdmin(ctx)) throw new HttpError(403, "Only an admin can do that.");
}

/** whether the member asking may do what a permission allows: an admin, or a sub-admin who holds it */
export const may = (ctx, permission) => can(ctx.session.user, permission);

/** whether the member asking adds to the corpus: the admins, and the sub-admins who publish or edit. Nobody else does */
export const publishes = (ctx) => may(ctx, "write") || may(ctx, "edit");

/** a gate: those who add to the corpus, a piece of their own or a work made elsewhere */
export function publisher(ctx) {
  if (member(ctx)) return true;
  if (!publishes(ctx)) throw new HttpError(403, "Only those who keep the corpus can add to it.");
}

/** stands before what is for the admins and for the sub-admins given that permission */
export const allowed = (permission) =>
  function holder(ctx) {
    if (member(ctx)) return true;
    if (!may(ctx, permission)) throw new HttpError(403, "Only an admin can do that.");
  };

/** reads the form of a signed-in member's post and checks its CSRF token */
export async function form(ctx) {
  ctx.form = await readForm(ctx.req);
  if (!csrfMatches(ctx.session, ctx.form.get("_csrf")))
    throw new HttpError(403, "This page is out of date. Go back, reload it and try again.");
}

/** one field of the form, without the space around it */
export const field = (ctx, name) => (ctx.form.get(name) || "").trim();

/** a long text from the form, with the line endings browsers send made plain */
export const text = (ctx, name) => (ctx.form.get(name) || "").replace(/\r\n?/g, "\n");

/** the number in an address, or the page is not there */
export function numericId(value) {
  if (!/^[1-9]\d{0,14}$/.test(value)) throw new HttpError(404, NOT_FOUND);
  return Number(value);
}
