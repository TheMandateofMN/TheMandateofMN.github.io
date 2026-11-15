/*
 * Who may pass. These stand in front of the routes: each either lets a
 * request through, answers it itself (and returns true), or refuses it by
 * throwing.
 */

import { csrfMatches } from "./auth.mjs";
import { rooms } from "./chat.mjs";
import { mentions } from "./db.mjs";
import { HttpError, readForm, redirect, wantsJson } from "./http.mjs";
import { can } from "./permissions.mjs";

export const NOT_FOUND = "That page could not be found.";

/** everything past the sign-in page needs a session */
export function member(ctx) {
  if (ctx.session) {
    // shown in the menu of every page: how many new tags await the member, and how much unread talk
    ctx.session.tagged = mentions.unseenCount(ctx.session.user.id);
    ctx.session.unread = rooms.unread(ctx.session.user.id);
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

/** what only an admin may do, whatever a sub-admin has been given: naming the main admin, making sub-admins */
export function admin(ctx) {
  if (member(ctx)) return true;
  if (!isAdmin(ctx)) throw new HttpError(403, "Only an admin can do that.");
}

/** whether the member asking may do what a permission allows: an admin, or a sub-admin who holds it */
export const may = (ctx, permission) => can(ctx.session.user, permission);

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
