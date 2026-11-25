/*
 * Invitations: the admins' list of who is to be invited, with their numbers;
 * the making of a link to hand someone, and the sending of the announcement
 * by text; the page an invitation is taken up on; the texts a member can
 * ask for about what is published, and the sending of those.
 *
 * The list is for the admins. To a member, or a sub-admin, its pages are
 * not there. Texts about what is published are the main admin's to send.
 *
 * The list is put away for now, and to an admin too its pages are not there
 * until INVITATIONS is on (see config.mjs). A link that was handed out
 * before is still good, and the admin portal invites as it did.
 */

import { createSession, hashPassword, passwordProblem } from "./auth.mjs";
import { config } from "./config.mjs";
import { adminLog, posts, users } from "./db.mjs";
import { admins as anAdmin, field, form, mainAdmin, member, NOT_FOUND, numericId, text } from "./gate.mjs";
import { HttpError, readForm, redirect, send, sessionCookie } from "./http.mjs";
import {
  accept,
  canKeep,
  canLink,
  canTell,
  contacts,
  covered,
  dialled,
  invitation,
  invite,
  linked,
  linkStands,
  open,
  sent,
  settle,
  setWants,
  signInNameFor,
  TEXT_KEYS,
} from "./numbers.mjs";
import * as texts from "./texts.mjs";
import { numberPage, numbersPage, pieceTextPage, welcomePage } from "./views-numbers.mjs";

const NO_KEY = "No number can be kept yet: NUMBERS_KEY is not set on the server, or is shorter than 32 characters.";

/** a gate: the admins, while the list of those who are to be invited is out; put away, it is there to nobody */
function admins(ctx) {
  if (anAdmin(ctx)) return true;
  if (!config.invitations) throw new HttpError(404, NOT_FOUND);
}

/** a gate: there is a key to seal numbers with */
function sealable() {
  if (!canKeep()) throw new HttpError(409, NO_KEY);
}

const SAID = {
  added: "They are put down.",
  saved: "Saved.",
  removed: "They are off the list, and their number is deleted.",
  words: "The words are saved.",
  told: "The text is sent.",
  begun: "Sending has begun.",
  tried: "It is sent.",
};

/**
 * Someone's number as it was put down: "" if they have none, and null if it
 * is there but cannot be read, for want of the key or because it was sealed
 * with another.
 */
function numberOf(contact) {
  if (!contact.number) return "";
  if (!canKeep()) return null;
  try {
    return open(contact.number);
  } catch {
    return null;
  }
}

/** the end of someone's number, for the list: no more of it than that is put on the page */
function endOf(contact) {
  const number = numberOf(contact);
  return number === "" ? null : number === null ? "sealed" : covered(number);
}

function listView(ctx, extra = {}) {
  return numbersPage({
    session: ctx.session,
    list: contacts.all().map((each) => ({ ...each, shown: endOf(each) })),
    last: sent.latest(),
    words: Object.fromEntries(Object.keys(texts.WORDS).map((kind) => [kind, texts.wordsFor(kind)])),
    run: texts.running(),
    blocked: canKeep() ? null : NO_KEY,
    unsendable: texts.cannotSend(),
    said: SAID[ctx.url.searchParams.get("done")] ?? null,
    ...extra,
  });
}

/**
 * What was typed for someone, and what is the matter with it if anything.
 * A number is not required: `number` is null where none was given.
 */
function readContact(ctx, except = 0) {
  const values = { name: field(ctx, "name").replace(/\s+/g, " "), number: field(ctx, "number") };
  const number = values.number ? dialled(values.number) : null;
  const error =
    !values.name || values.name.length > 80
      ? "Give their name, up to 80 characters."
      : values.number && !canKeep()
        ? NO_KEY
        : values.number && !number
          ? "That is not a telephone number. Write it with its country code: +1 415 555 0100."
          : number && contacts.taken(number, except)
            ? "That number is on the list already."
            : null;
  return { values, number, error };
}

/** a new link for someone to be handed, in place of any they had; it is shown once and kept nowhere */
function linkFor(ctx, contact) {
  const token = invite(contact);
  settle(contact.id, token);
  linked(contact.id);
  adminLog.record({ by: ctx.session.user.id, action: "invite-link", detail: contact.name });
  return { name: contact.name, link: `${texts.origin()}/welcome/${token}` };
}

const BUSY = "Texts are being sent just now. Wait until they are done.";

/** whether texts are going out to many at this moment */
const sending = () => {
  const run = texts.running();
  return Boolean(run && !run.over);
};

function contactFor(ctx) {
  const contact = contacts.byId(numericId(ctx.params.id));
  if (!contact) throw new HttpError(404, "They are not on the list.");
  return contact;
}

const placeOf = (contact) => contacts.all().findIndex((each) => each.id === contact.id) + 1;

const editView = (ctx, contact, extra = {}) =>
  numberPage({
    session: ctx.session,
    contact,
    number: numberOf(contact),
    keeps: canKeep(),
    place: placeOf(contact),
    total: contacts.count(),
    ...extra,
  });

/** where someone lands once they are in: the essay the corpus is drawn about, if there is one */
const firstPage = () => {
  const centre = posts.centre();
  return centre ? `/p/${centre.id}` : "/corpus";
};

export function numberRoutes(router) {
  /* ------------------------------------------------------------- the list */

  router.get("/invitations", admins, (ctx) => send(ctx.res, 200, listView(ctx)));

  /** puts someone down, with a number or without; and, if asked, makes the link they are to be handed there and then */
  router.post("/invitations", admins, form, (ctx) => {
    const { values, number, error } = readContact(ctx);
    if (error) return send(ctx.res, 422, listView(ctx, { error, values }));
    const id = contacts.add({ name: values.name, number });
    adminLog.record({ by: ctx.session.user.id, action: "invite-added", detail: values.name });
    if (field(ctx, "then") !== "link") return redirect(ctx.res, "/invitations?done=added");
    send(ctx.res, 201, listView(ctx, { issued: linkFor(ctx, contacts.byId(id)) }));
  });

  router.post("/invitations/words", admins, form, (ctx) => {
    const words = Object.fromEntries(Object.keys(texts.WORDS).map((kind) => [kind, text(ctx, kind).replace(/\s+/g, " ").trim()]));
    for (const [kind, said] of Object.entries(words)) {
      const problem = texts.wordsProblem(kind, said);
      if (problem) throw new HttpError(422, `${texts.WORDS[kind].name}: ${problem}`);
    }
    for (const [kind, said] of Object.entries(words)) texts.setWords(kind, said);
    redirect(ctx.res, "/invitations?done=words#words");
  });

  /** sends the announcement to a number of the main admin's own, to see how it reads; the number is not kept */
  router.post("/invitations/try", admins, form, async (ctx) => {
    if (texts.cannotSend()) throw new HttpError(409, texts.cannotSend());
    const number = dialled(field(ctx, "number"));
    if (!number) throw new HttpError(422, "That is not a telephone number. Write it with its country code: +1 415 555 0100.");
    const result = await texts.send(number, texts.wordsFor("invite").replaceAll("{link}", `${texts.origin()}/login`));
    if (!result.ok) return send(ctx.res, 422, listView(ctx, { failed: `It was not sent. ${result.detail}` }));
    redirect(ctx.res, "/invitations?done=tried#try");
  });

  /** texts everyone who has not been invited, in order; or once more everyone who was texted and has not come */
  router.post("/invitations/tell", admins, form, sealable, (ctx) => {
    if (texts.cannotSend()) throw new HttpError(409, texts.cannotSend());
    const again = field(ctx, "which") === "again";
    // the announcement is for those nobody has invited: someone holding a link made for them by hand is not sent another unasked
    const due = contacts.all().filter((each) => canTell(each) && (again ? each.told > 0 : each.told === 0 && !linkStands(each)));
    if (due.length === 0) throw new HttpError(409, "There is nobody to write to.");
    const what = again ? "The second message" : "The announcement";
    if (!texts.sendToMany(what, due, texts.tell)) throw new HttpError(409, BUSY);
    adminLog.record({
      by: ctx.session.user.id,
      action: "invite-texts",
      detail: `${what.toLowerCase()} to ${due.length === 1 ? "one person" : `${due.length} people`}`,
    });
    redirect(ctx.res, "/invitations?done=begun");
  });

  /* ------------------------------------------------------------ one of them */

  router.get("/invitations/:id", admins, (ctx) => send(ctx.res, 200, editView(ctx, contactFor(ctx))));

  router.post("/invitations/:id", admins, form, (ctx) => {
    const contact = contactFor(ctx);
    const { values, number, error } = readContact(ctx, contact.id);
    const place = field(ctx, "place");
    const problem = error ?? (/^[1-9]\d{0,4}$/.test(place) ? null : "Their place is a number, counting from 1.");
    if (problem) return send(ctx.res, 422, editView(ctx, contact, { error: problem, values: { ...values, place } }));
    // a number that cannot be read is not shown to be changed: left empty, it stays as it is
    const untouched = !values.number && numberOf(contact) === null;
    contacts.change(contact.id, untouched ? { name: values.name } : { name: values.name, number });
    contacts.move(contact.id, Number(place));
    redirect(ctx.res, "/invitations?done=saved");
  });

  router.post("/invitations/:id/remove", admins, form, (ctx) => {
    const contact = contactFor(ctx);
    contacts.remove(contact.id);
    adminLog.record({ by: ctx.session.user.id, action: "invite-removed", detail: contact.name });
    redirect(ctx.res, "/invitations?done=removed");
  });

  /**
   * Makes a link for someone to be handed, by whatever means the admin has
   * of reaching them. It takes the place of any link they had, and is shown
   * on the page that answers and nowhere after: only what it comes to is kept.
   */
  router.post("/invitations/:id/link", admins, form, (ctx) => {
    const contact = contactFor(ctx);
    if (!canLink(contact)) throw new HttpError(409, "They have taken up their account already.");
    // a text on its way carries a link, which a new one would end before it arrived
    if (sending()) throw new HttpError(409, BUSY);
    send(ctx.res, 200, listView(ctx, { issued: linkFor(ctx, contact) }));
  });

  router.post("/invitations/:id/tell", admins, form, sealable, async (ctx) => {
    if (texts.cannotSend()) throw new HttpError(409, texts.cannotSend());
    const contact = contactFor(ctx);
    if (sending()) throw new HttpError(409, BUSY);
    if (!canTell(contact)) throw new HttpError(409, "They are not to be written to again.");
    const result = await texts.tell(contact);
    if (!result.ok) return send(ctx.res, 422, listView(ctx, { failed: `${contact.name} was not written to. ${result.detail}` }));
    adminLog.record({ by: ctx.session.user.id, action: "invite-text", detail: contact.name });
    redirect(ctx.res, "/invitations?done=told");
  });

  /* ------------------------------------------------------- taking it up */

  // A link in a text is opened by whoever holds the telephone, who is not signed in. Looking at
  // the page uses nothing up, so a telephone that fetches the link to show a picture of it spends nothing.
  router.get("/welcome/:token", (ctx) => {
    const found = invitation(ctx.params.token);
    send(
      ctx.res,
      found ? 200 : 404,
      welcomePage({ found, token: ctx.params.token, values: found ? { username: signInNameFor(found.name) } : {} })
    );
  });

  router.post("/welcome/:token", async (ctx) => {
    const body = await readForm(ctx.req);
    const found = invitation(ctx.params.token);
    if (!found) return send(ctx.res, 404, welcomePage({ found: null }));
    const username = (body.get("username") || "").trim();
    const password = body.get("password") || "";
    const error = !/^[A-Za-z0-9._-]{2,32}$/.test(username)
      ? "A sign-in name is 2 to 32 letters, digits, dots, dashes or underscores."
      : users.byUsername(username)
        ? "That sign-in name is taken. Choose another."
        : passwordProblem(password, { username, name: found.name });
    if (error) return send(ctx.res, 422, welcomePage({ found, token: ctx.params.token, error, values: { username } }));
    const passwordHash = await hashPassword(password);
    // while the password was being worked the link may have been spent or the name taken, by the same form sent twice
    const still = invitation(ctx.params.token);
    if (!still) return send(ctx.res, 404, welcomePage({ found: null }));
    if (users.byUsername(username))
      return send(ctx.res, 422, welcomePage({ found, token: ctx.params.token, error: "That sign-in name is taken. Choose another.", values: { username } }));
    const userId = accept(still, { username, passwordHash });
    redirect(ctx.res, firstPage(), { "Set-Cookie": sessionCookie(createSession(userId, ctx.req.headers["user-agent"])) });
  });

  /* ------------------------------------------- what a member asks to be sent */

  router.post("/account/texts", member, form, (ctx) => {
    if (!contacts.byUser(ctx.session.user.id)?.number) throw new HttpError(404, NOT_FOUND);
    const wanted = ctx.form.getAll("texts");
    setWants(ctx.session.user.id, TEXT_KEYS.filter((key) => wanted.includes(key)));
    redirect(ctx.res, "/account?done=texts#texts");
  });

  /* ---------------------------------------------------- a text about a piece */

  function pieceFor(ctx) {
    const post = posts.byId(numericId(ctx.params.id));
    if (!post || post.status !== "published") throw new HttpError(404, NOT_FOUND);
    return post;
  }

  /** those who asked for texts and have not been sent this piece: for all of it, and for some of it only */
  function askers(post) {
    const had = sent.aboutPost(post.id);
    const every = contacts.wanting().filter((each) => !had.has(each.id));
    const everyId = new Set(every.map((each) => each.id));
    const some = contacts.wanting({ some: true }).filter((each) => !had.has(each.id) && !everyId.has(each.id));
    return { every, some, already: had.size };
  }

  const pieceView = (ctx, post, extra = {}) => {
    const { every, some, already } = canKeep() ? askers(post) : { every: [], some: [], already: 0 };
    return pieceTextPage({
      session: ctx.session,
      post,
      words: texts.wordsFor("piece").replaceAll("{title}", post.title || "").replaceAll("{link}", `${texts.origin()}/p/${post.id}`),
      all: every.length,
      some: some.length,
      already,
      unsendable: canKeep() ? texts.cannotSend() : NO_KEY,
      run: texts.running(),
      ...extra,
    });
  };

  router.get("/p/:id/text", mainAdmin, (ctx) => send(ctx.res, 200, pieceView(ctx, pieceFor(ctx))));

  router.post("/p/:id/text", mainAdmin, form, sealable, (ctx) => {
    if (texts.cannotSend()) throw new HttpError(409, texts.cannotSend());
    const post = pieceFor(ctx);
    const to = ctx.form.getAll("to");
    const { every, some } = askers(post);
    const due = [...(to.includes("all") ? every : []), ...(to.includes("some") ? some : [])];
    if (due.length === 0) return send(ctx.res, 422, pieceView(ctx, post, { error: "Choose who it is to go to." }));
    if (!texts.sendToMany("The text about this piece", due, (contact) => texts.tellOfPiece(contact, post)))
      throw new HttpError(409, BUSY);
    redirect(ctx.res, `/p/${post.id}/text`);
  });
}

/** whether a member came by an invitation and has a number here, and so can ask for texts; and what they have asked for */
export const textsOf = (user) => (canKeep() && contacts.byUser(user.id)?.number ? { wants: String(user.texts ?? "").split(" ") } : null);
