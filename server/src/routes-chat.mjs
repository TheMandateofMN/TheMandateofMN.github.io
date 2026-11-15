/*
 * Conversations: the rooms a member is in, what is said in them, and the
 * connection each open page keeps so that it hears of new messages at once.
 */

import { findSession } from "./auth.mjs";
import { listen, listening, listeningAs, messages, rooms } from "./chat.mjs";
import { config } from "./config.mjs";
import { users } from "./db.mjs";
import { form, may, member, NOT_FOUND, numericId, text } from "./gate.mjs";
import { can } from "./permissions.mjs";
import { COMMON_HEADERS, HttpError, redirect, send, sendJson, sessionToken, wantsJson } from "./http.mjs";
import { typeset } from "./render.mjs";
import { chatPage, messageItem, roomPage } from "./views-chat.mjs";

/* how often an open connection is written to when nothing is said, so that nothing between here and the page closes it */
const BEAT_MS = 25_000;
/* the most members one conversation can be begun with */
const MOST_PEOPLE = 30;
/* the most pages one member can have listening to conversations at once */
const MOST_LISTENING = 12;

/** whether a room is a member's to read: one they are in, or any project's for whoever oversees the projects */
const mayRead = (room, user) => rooms.has(room, user.id) || (room.kind === "project" && can(user, "projects"));

/** the room in the address; not there at all for someone who is not in it */
function roomFor(ctx) {
  const room = rooms.byId(numericId(ctx.params.id));
  if (!room || !mayRead(room, ctx.session.user)) throw new HttpError(404, NOT_FOUND);
  return room;
}

/** a message as it is sent to a page: drawn as that page's reader should see it */
const drawn = (message, session) => ({ id: message.id, html: typeset(String(messageItem(message, session))) });

/** tells the pages open on a room of a message that was said (or, with `event` "removed", taken away) */
function tellPages(roomId, event, message) {
  const room = rooms.byId(roomId);
  for (const listener of listening(roomId)) {
    // someone who has signed out, been taken off a project or is no longer a member stops hearing of it
    const session = findSession(listener.token);
    if (!room || !session || !mayRead(room, session.user)) listener.end();
    else listener.write(event, drawn(message, session), event === "said" ? message.id : null);
  }
}

/**
 * Says something in a room and tells the pages that are open on it. With
 * kind "event" it is the forum's own word of something the member did, and
 * `link` where that leads.
 */
export function say(roomId, userId, { body, kind = "said", link = null }) {
  const id = messages.create({ roomId, userId, body, kind, link });
  tellPages(roomId, "said", messages.byId(id));
  return id;
}

export function chatRoutes(router) {
  const others = (ctx) => users.active().filter((user) => user.id !== ctx.session.user.id);

  const list = (ctx, extra = {}, status = 200) =>
    send(
      ctx.res,
      status,
      chatPage({ session: ctx.session, rooms: rooms.of(ctx.session.user.id), members: others(ctx), ...extra })
    );

  router.get("/chat", member, (ctx) => list(ctx));

  /** opens the conversation between the member and those they ticked, beginning it if need be */
  router.post("/chat", member, form, (ctx) => {
    const wanted = new Set(ctx.form.getAll("who").map(Number));
    const who = others(ctx).filter((user) => wanted.has(user.id));
    if (who.length === 0) return list(ctx, { error: "Choose at least one member to talk to." }, 422);
    if (who.length > MOST_PEOPLE) return list(ctx, { error: `A conversation can be begun with up to ${MOST_PEOPLE} members.` }, 422);
    const { user } = ctx.session;
    const room = rooms.between([user.id, ...who.map((each) => each.id)], user.id);
    redirect(ctx.res, `/chat/${room.id}`);
  });

  function show(ctx, room, extra = {}, status = 200) {
    const { user } = ctx.session;
    const before = /^[1-9]\d{0,14}$/.test(ctx.url.searchParams.get("before") || "") ? Number(ctx.url.searchParams.get("before")) : null;
    const shown = messages.latest(room.id, config.messagesShown, before);
    if (!before) {
      // looking at the room is what marks it as read; the count in the menu was made before that
      rooms.markRead(room.id, user.id);
      ctx.session.unread = rooms.unread(user.id);
    }
    send(
      ctx.res,
      status,
      roomPage({
        session: ctx.session,
        room,
        people: rooms.people(room),
        messages: shown,
        earlier: shown.length > 0 && messages.anyBefore(room.id, shown[0].id),
        past: Boolean(before),
        ...extra,
      })
    );
  }

  router.get("/chat/:id", member, (ctx) => show(ctx, roomFor(ctx)));

  router.post("/chat/:id", member, form, (ctx) => {
    const room = roomFor(ctx);
    const body = text(ctx, "body").trim();
    const error = !body
      ? "A message needs some words."
      : body.length > config.maxMessageLength
        ? `Keep a message under ${config.maxMessageLength} characters.`
        : null;
    if (error) {
      if (wantsJson(ctx.req)) throw new HttpError(422, error);
      return show(ctx, room, { error, draft: body }, 422);
    }
    const { user } = ctx.session;
    const id = say(room.id, user.id, { body });
    rooms.markRead(room.id, user.id);
    if (wantsJson(ctx.req)) return sendJson(ctx.res, 201, { id });
    redirect(ctx.res, `/chat/${room.id}#m${id}`);
  });

  /** the page says its reader has seen what it was sent */
  router.post("/chat/:id/read", member, form, (ctx) => {
    const room = roomFor(ctx);
    rooms.markRead(room.id, ctx.session.user.id);
    sendJson(ctx.res, 200, { unread: rooms.unread(ctx.session.user.id) });
  });

  /** a message is removed by whoever wrote it, by an admin, or by a sub-admin who moderates */
  router.post("/chat/:id/m/:message/remove", member, form, (ctx) => {
    const room = roomFor(ctx);
    const message = messages.byId(numericId(ctx.params.message));
    if (!message || message.room_id !== room.id || message.removed_at || message.kind !== "said")
      throw new HttpError(404, "That message is no longer here.");
    if (message.user_id !== ctx.session.user.id && !may(ctx, "moderate"))
      throw new HttpError(403, "Only whoever wrote a message, or an admin, can remove it.");
    messages.remove(message.id, ctx.session.user.id);
    tellPages(room.id, "removed", messages.byId(message.id));
    if (wantsJson(ctx.req)) return sendJson(ctx.res, 200, { id: message.id });
    redirect(ctx.res, `/chat/${room.id}#m${message.id}`);
  });

  /**
   * What is said in a room, as it is said: the page keeps this open and is
   * written to in the form browsers call server-sent events. It first gets
   * whatever was said after the message it names (the last it has), so that
   * nothing is missed between the page being made and its listening, or
   * while a connection was down.
   */
  router.get("/chat/:id/stream", member, (ctx) => {
    const room = roomFor(ctx);
    const { req, res, session } = ctx;
    // each of these holds a connection open, so one member is given only so many
    if (listeningAs(session.user.id) >= MOST_LISTENING)
      throw new HttpError(429, "Too many pages are open on conversations. Close some of them.");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      ...COMMON_HEADERS,
    });
    const write = (event, data, id) =>
      res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    res.write("retry: 4000\n\n");
    const named = req.headers["last-event-id"] ?? ctx.url.searchParams.get("after");
    const after = /^\d{1,15}$/.test(named || "") ? Number(named) : 0;
    for (const message of messages.since(room.id, after)) write("said", drawn(message, session), message.id);

    const leave = listen(room.id, { token: sessionToken(req), userId: session.user.id, write, end: () => res.end() });
    const beat = setInterval(() => res.write(": still here\n\n"), BEAT_MS);
    res.on("close", () => {
      clearInterval(beat);
      leave();
    });
  });
}
