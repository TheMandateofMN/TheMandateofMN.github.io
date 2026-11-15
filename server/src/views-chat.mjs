/*
 * The pages of conversations: the list of the rooms a member is in, and a
 * room with what has been said in it. A message is drawn by `messageItem`
 * both when the page is made and when it is sent to pages already open.
 */

import { config } from "./config.mjs";
import { clip, renderNote, timeTag } from "./render.mjs";
import { csrfField, html, may, memberHref, notice, page, plural, raw } from "./views.mjs";

const stamp = (at) => raw(timeTag(at, "stamp"));

/** what a room is called by the member looking at it: a conversation is named for the others in it */
export function roomName(room, people, session) {
  if (room.kind === "common") return "Everyone";
  if (room.kind === "project") return room.project_title;
  const others = people.filter((each) => each.id !== session.user.id).map((each) => each.name);
  return others.length > 0 ? others.join(", ") : "Notes to yourself";
}

const KIND = { common: "The common room", direct: "Conversation", project: "Project" };

/* ---------------------------------------------------------------- rooms */

export function chatPage({ session, rooms, members, error }) {
  const item = (room) => {
    const last = room.last;
    const said = last && (last.kind === "event" ? `${last.author_name} ${last.body}` : `${last.author_name}: ${clip(last.body, 110)}`);
    return html`<li class="room${room.unread > 0 && " room--unread"}">
      <a class="room__name" href="/chat/${room.id}">${roomName(room, room.people, session)}</a>
      ${room.kind !== "direct" && html`<span class="tag tag--quiet">${room.kind === "common" ? "All members" : "Project"}</span>`}
      ${room.unread > 0 &&
      html`<span class="badge" aria-hidden="true">${room.unread > 99 ? "99+" : room.unread}</span
        ><span class="visually-hidden">${plural(room.unread, "unread message")}</span>`}
      <p class="room__last">${said ? html`${said} <span class="room__when">${stamp(last.created_at)}</span>` : "Nothing said yet."}</p>
    </li>`;
  };
  return page({
    title: "Chat",
    session,
    current: "chat",
    main: html`
      <h1 class="page-title">Chat</h1>
      <p class="lede">
        The common room is for everyone. A conversation is between you and the members you choose, and is
        shown to no one else. Each project you work on has a room of its own.
      </p>
      <ul class="rooms">
        ${rooms.map(item)}
      </ul>

      <h2 class="section-title" id="new">Start a conversation</h2>
      ${members.length > 0
        ? html`<form class="form" method="post" action="/chat">
            ${csrfField(session)} ${notice(error)}
            <fieldset class="options">
              <legend>With</legend>
              <p class="hint">One member or several. The same people always come back to the same conversation.</p>
              <ul class="choices">
                ${members.map(
                  (each) => html`<li>
                    <label
                      ><input type="checkbox" name="who" value="${each.id}" /> ${each.name}
                      <span class="choices__name">@${each.username}</span></label
                    >
                  </li>`
                )}
              </ul>
            </fieldset>
            <button class="button" type="submit">Open the conversation</button>
          </form>`
        : html`<p class="hint">There are no other members to talk to yet.</p>`}
    `,
  });
}

/* ------------------------------------------------------------- one room */

/* messages by the same member within this many minutes are set as one run */
const RUN_MINUTES = 5;

/** whether a message carries straight on from the one before it */
export const follows = (message, before) =>
  Boolean(
    before &&
      message.kind === "said" &&
      before.kind === "said" &&
      !before.removed_at &&
      before.user_id === message.user_id &&
      Date.parse(message.created_at) - Date.parse(before.created_at) < RUN_MINUTES * 60 * 1000
  );

/**
 * One message, as the member in `session` sees it: their own, and any for an
 * admin or a sub-admin who moderates, come with the means to remove them. `run` sets it under the message
 * before, without the name again.
 */
export function messageItem(message, session, { run = false } = {}) {
  const base = html`id="m${message.id}" data-id="${message.id}" data-by="${message.user_id}" data-at="${message.created_at}"`;
  if (message.removed_at)
    return html`<li class="say say--gone" ${base}><p class="say__gone">A message was removed.</p></li>`;
  if (message.kind === "event")
    return html`<li class="say say--event" ${base}>
      <p>
        ${message.author_name} ${message.link ? html`<a href="${message.link}">${message.body}</a>` : message.body}
        <span class="say__when">${stamp(message.created_at)}</span>
      </p>
    </li>`;
  const mine = message.user_id === session.user.id;
  // the means to remove comes first so that it can sit at the end of the message's first line
  return html`<li class="say${run && " say--run"}${mine && " say--mine"}" ${base}>
    ${(mine || may(session, "moderate")) &&
    html`<form class="say__remove" method="post" action="/chat/${message.room_id}/m/${message.id}/remove">
      ${csrfField(session)}
      <button class="link link--quiet" type="submit" data-confirm="Remove this message?">Remove</button>
    </form>`}
    <p class="say__who">
      <strong><a href="${memberHref(message.author_username)}">${message.author_name}</a></strong>
      <span class="say__when">${stamp(message.created_at)}</span>
    </p>
    <div class="say__body note__body">${raw(renderNote(message.body))}</div>
  </li>`;
}

/**
 * A room. `messages` are the ones to show, oldest first; `earlier` is whether
 * there are any before them; with `past`, this is a look back at older
 * messages and not the live end of the conversation.
 */
export function roomPage({ session, room, people, messages, earlier, past = false, draft = "", error }) {
  const name = roomName(room, people, session);
  const first = messages[0];
  const last = messages.at(-1);
  return page({
    title: `${name} · Chat`,
    session,
    current: "chat",
    scripts: past ? [] : ["chat"],
    main: html`
      <header class="talk__head">
        <p class="rubric"><a href="/chat">Chat</a> · ${KIND[room.kind]}</p>
        <h1 class="page-title">${name}</h1>
        ${room.kind === "direct" &&
        html`<p class="talk__people">
          ${people.map((each, i) => html`${i > 0 && ", "}<a href="${memberHref(each.username)}">${each.name}</a>`)}
        </p>`}
        ${room.kind === "project" &&
        html`<p class="talk__people">
          For those working on <a href="/projects/${room.project_id}">${room.project_title}</a>:
          ${people.map((each) => each.name).join(", ")}
        </p>`}
        ${room.kind === "common" && html`<p class="talk__people">Every member can read and write here.</p>`}
      </header>

      ${earlier && html`<p class="talk__earlier"><a href="/chat/${room.id}?before=${first.id}">Earlier messages</a></p>`}
      <ol
        class="talk"
        id="talk"
        data-room="${room.id}"
        data-last="${last ? last.id : 0}"
        data-me="${session.user.id}"
        ${!past && raw('data-live aria-live="polite"')}
      >
        ${messages.map((message, i) => messageItem(message, session, { run: follows(message, messages[i - 1]) }))}
      </ol>
      ${messages.length === 0 && html`<p class="empty empty--notes" data-nothing>Nothing has been said here yet.</p>`}

      ${past
        ? html`<p class="talk__earlier"><a href="/chat/${room.id}#say">Back to the latest</a></p>`
        : html`<form class="form talk__form" id="say" method="post" action="/chat/${room.id}" data-chat>
            ${csrfField(session)} ${notice(error)}
            <label class="visually-hidden" for="body">Your message</label>
            <textarea
              id="body"
              name="body"
              rows="2"
              maxlength="${config.maxMessageLength}"
              placeholder="Write a message"
              data-suggest="people"
              required
            >${draft}</textarea>
            <div class="talk__send">
              <button class="button" type="submit">Send</button>
              <span class="hint" data-chat-hint hidden>Enter sends; Shift and Enter starts a new line.</span>
              <span class="hint talk__status" data-chat-status role="status"></span>
            </div>
          </form>`}
    `,
  });
}
