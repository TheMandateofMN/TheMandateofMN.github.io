/*
 * The pages of what is sent to the group chats kept elsewhere: the one it
 * is written on, with what was lately sent beneath; and the one where the
 * accounts are linked and the chats chosen.
 */

import { config } from "./config.mjs";
import { qrSvg } from "./qr.mjs";
import { PLATFORMS } from "./relay.mjs";
import { timeTag } from "./render.mjs";
import { csrfField, html, notice, page, plural, raw } from "./views.mjs";

const nameOf = (platform) => PLATFORMS[platform]?.name ?? platform;

/** a size as it is said: 340 KB, 2.1 MB */
const sized = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const STATES = { waiting: "On its way", sent: "Sent", failed: "Did not go" };

/** one thing that was sent, with how it went to each chat */
function sentOne(session, sent) {
  const settled = sent.deliveries.every((each) => each.state !== "waiting");
  return html`<li class="sent__one">
    <p class="sent__when">${raw(timeTag(sent.created_at, "stamp"))}</p>
    ${sent.body && html`<p class="sent__body" data-typed>${sent.body}</p>`}
    ${sent.files.length > 0 &&
    html`<p class="sent__files">
      ${plural(sent.files.length, "file")}: ${sent.files.map((file) => file.name).join(", ")}
    </p>`}
    <ul class="sent__to">
      ${sent.deliveries.map(
        (each) =>
          html`<li class="sent__went" data-delivery="${each.id}" data-state="${each.state}">
            <span class="sent__chat">${each.chat_name}</span>
            <span class="sent__on">${nameOf(each.platform)}</span>
            <span class="sent__state" data-says>${STATES[each.state]}</span>
            <span class="sent__why" data-why>${each.state === "failed" && each.detail}</span>
            <form method="post" action="/send/deliveries/${each.id}/again" data-again ${each.state !== "failed" && raw("hidden")}>
              ${csrfField(session)}
              <button class="link" type="submit">Send it again</button>
            </form>
          </li>`
      )}
    </ul>
    <form class="sent__forget" method="post" action="/send/${sent.id}/forget" data-forget ${!settled && raw("hidden")}>
      ${csrfField(session)}
      <button
        class="link"
        type="submit"
        data-confirm="Forget this here? It stays in the chats it was sent to."
      >
        Forget
      </button>
    </form>
  </li>`;
}

/**
 * Where something is written and sent. `chats` are the chats there are,
 * `states` how each service's account stands, `sent` what was lately sent.
 * `values` is what was being sent when something was the matter with it,
 * and `just` what has only now been sent, said again at the top.
 */
export function sendPage({ session, chats, states, sent, just = null, error, values = null }) {
  const ready = (chat) => Boolean(states[chat.platform]?.linked);
  const chosen = (chat) => (values ? values.to.includes(chat.id) : true);
  return page({
    title: "Send",
    session,
    current: "members",
    scripts: ["relay"],
    main: html`
      <p class="rubric"><a href="/">Scribe</a></p>
      <h1 class="page-title">Send</h1>
      ${just &&
      html`<div class="notice notice--ok send__just" role="status">
        <ul class="sent__to">
          ${just.deliveries.map(
            (each) =>
              html`<li class="sent__went" data-delivery="${each.id}" data-state="${each.state}">
                <span class="sent__chat">${each.chat_name}</span>
                <span class="sent__state" data-says>${STATES[each.state]}</span>
                <span class="sent__why" data-why>${each.state === "failed" && each.detail}</span>
              </li>`
          )}
        </ul>
      </div>`}
      ${chats.length === 0
        ? html`<p class="notice notice--ok" role="status">
            No chat is set up to send to yet. <a href="/send/chats">Link an account and choose its chats</a>
          </p>`
        : html`<form class="form send" method="post" action="/send" data-send data-most="${config.maxSendFiles}">
            ${csrfField(session)} ${notice(error)}
            <label class="visually-hidden" for="send-body">What to send</label>
            <textarea
              id="send-body"
              name="body"
              rows="5"
              maxlength="${config.maxSendLength}"
              placeholder="A thought, a quotation, a link"
              autofocus
            >
${values?.body ?? ""}</textarea
            >
            <div class="send__files" data-files hidden>
              <ul class="send__list" data-list>
                ${(values?.files ?? []).map(
                  (file) =>
                    html`<li class="send__file">
                      <input type="hidden" name="file" value="${file.id}" />
                      <span class="send__name">${file.name}</span> <span class="send__size">${sized(file.bytes)}</span>
                      <button class="link" type="button" data-drop>Take it off</button>
                    </li>`
                )}
              </ul>
              <p class="send__add">
                <label class="link" for="send-pick">Add pictures or files</label>
                <input class="visually-hidden" id="send-pick" type="file" multiple data-pick />
                <span class="hint">or paste a screenshot, or drop files on the page</span>
              </p>
            </div>
            <fieldset class="options grants send__to">
              <legend>Send to</legend>
              ${chats.map(
                (chat) =>
                  html`<label class="grant"
                    ><input
                      type="checkbox"
                      name="to"
                      value="${chat.id}"
                      ${ready(chat) ? chosen(chat) && raw("checked") : raw("disabled")}
                    />
                    <span class="grant__name">${chat.name}</span>
                    <span class="grant__says"
                      >${nameOf(chat.platform)}${!ready(chat) && html` · its account is not linked just now`}${ready(chat) &&
                      !states[chat.platform].connected &&
                      html` · not connected just now; it will be tried`}</span
                    ></label
                  >`
              )}
            </fieldset>
            <div class="compose__actions">
              <button class="button" type="submit">Send</button>
              <span class="send__progress" data-progress role="status"></span>
            </div>
          </form>`}
      <p class="views send__chats"><a href="/send/chats">The chats and their accounts</a></p>

      <h2 class="section-title" id="sent">Sent</h2>
      ${sent.length > 0
        ? html`<ol class="sent" data-sent>
            ${sent.map((each) => sentOne(session, each))}
          </ol>
          <p class="hint">
            The last ${config.sendsKept} are remembered here, so that what did not go can be sent again. Forgetting one takes
            nothing back from the chats.
          </p>`
        : html`<p class="empty empty--notes">Nothing has been sent yet.</p>`}
    `,
  });
}

/* --------------------------------------------------------------- linking */

const STEPS = {
  signal: "On the telephone that has the account: Signal, Settings, Linked devices, Link new device. Scan this.",
  whatsapp: "On the telephone that has the account: WhatsApp, Settings, Linked devices, Link a device. Scan this.",
};

/** one service: how its account stands, and what can be done about it */
function account(session, key, state, groups, problem, error) {
  const name = nameOf(key);
  const linking = state.linking;
  return html`<section class="account" id="${key}">
    <h2 class="section-title">${name}</h2>
    ${notice(error)} ${state.problem && !linking && notice(state.problem)}
    ${state.linked
      ? html`<p class="account__stands">
            <span class="tag tag--mark">Linked</span> to the account ending ${state.as ?? "…"}${!state.connected &&
            html`, but <strong>not connected</strong> just now`}.
          </p>
          ${problem && notice(problem)}
          ${groups &&
          (groups.length > 0
            ? html`<form class="form form--inline form--one" method="post" action="/send/chats">
                ${csrfField(session)}
                <input type="hidden" name="platform" value="${key}" />
                <div>
                  <label for="group-${key}">A group of this account’s</label>
                  <select id="group-${key}" name="address" required>
                    ${groups.map((group) => html`<option value="${group.address}">${group.name}</option>`)}
                  </select>
                </div>
                <button class="button" type="submit">Add it to the chats</button>
              </form>`
            : html`<p class="hint">Every group this account is in is on the list already, or it is in none.</p>`)}
          <p class="account__more">
            <a class="link" href="/send/chats?look=${key}#${key}">Look for its groups again</a>
          </p>
          <form class="account__unlink" method="post" action="/send/accounts/${key}/unlink">
            ${csrfField(session)}
            <button
              class="link link--danger"
              type="submit"
              data-confirm="Unlink ${name}? What this server holds of the account is deleted, and nothing more can be sent to its chats until it is linked again."
            >
              Unlink
            </button>
          </form>`
      : linking
        ? html`<div class="account__linking" data-linking>
            ${linking.code
              ? html`<p class="hint">
                    On the telephone that has the account: WhatsApp, Settings, Linked devices, Link a device, Link with phone
                    number instead. Type this in.
                  </p>
                  <p class="account__code" data-typed>${linking.code.slice(0, 4)}-${linking.code.slice(4)}</p>`
              : linking.qr
                ? html`<p class="hint">${STEPS[key]}</p>
                    <div class="account__qr">${raw(qrSvg(linking.qr, `The code that links ${name}`))}</div>`
                : html`<p class="hint">Asking ${name} for a code…</p>`}
            <p class="hint">This page looks again by itself, and says when it is linked. The code is good for a few minutes.</p>
            <form class="account__unlink" method="post" action="/send/accounts/${key}/unlink">
              ${csrfField(session)}
              <button class="link" type="submit">Stop</button>
            </form>
          </div>`
        : !state.problem || !/not installed/.test(state.problem)
          ? html`<p class="account__stands"><span class="tag tag--quiet">Not linked</span></p>
              <div class="account__ways">
                <form method="post" action="/send/accounts/${key}/link">
                  ${csrfField(session)}
                  <button class="button" type="submit">Link by scanning a code</button>
                </form>
                ${key === "whatsapp" &&
                html`<form class="form form--inline form--one" method="post" action="/send/accounts/${key}/link">
                  ${csrfField(session)}
                  <div>
                    <label for="phone-${key}">Or by a code to type: the account’s number</label>
                    <input id="phone-${key}" name="phone" inputmode="tel" autocomplete="off" maxlength="24" placeholder="+1 415 555 0100" required />
                  </div>
                  <button class="button button--quiet" type="submit">Get a code to type</button>
                </form>`}
              </div>`
          : null}
  </section>`;
}

/**
 * Where the accounts are linked and the chats chosen. `groups` holds, for
 * each service that is linked, the account's groups that are not yet chats;
 * `problems` why they could not be listed; `stamp` what the page's script
 * watches for a change in.
 */
export function chatsPage({ session, chats, states, groups, problems, stamp, said, error = {} }) {
  const busy = Object.values(states).some((state) => state.linking);
  return page({
    title: "The chats",
    session,
    current: "members",
    scripts: ["relay"],
    main: html`
      <p class="rubric"><a href="/send">Send</a></p>
      <h1 class="page-title">The chats</h1>
      ${said && notice(said, "ok")}
      <div data-accounts="${stamp}" ${busy && raw("data-watch")}>
        ${chats.length > 0
          ? html`<table class="members">
              <thead>
                <tr>
                  <th scope="col">Chat</th>
                  <th scope="col">On</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                ${chats.map(
                  (chat) =>
                    html`<tr>
                      <td><strong>${chat.name}</strong></td>
                      <td>${nameOf(chat.platform)}${!states[chat.platform]?.linked && html` <span class="tag tag--quiet">Not linked</span>`}</td>
                      <td class="members__actions">
                        <form method="post" action="/send/chats/${chat.id}/remove">
                          ${csrfField(session)}
                          <button
                            class="link link--danger"
                            type="submit"
                            data-confirm="Take ${chat.name} off the list? Nothing more is sent to it from here. The chat itself is not touched."
                          >
                            Take off the list
                          </button>
                        </form>
                      </td>
                    </tr>`
                )}
              </tbody>
            </table>`
          : html`<p class="empty empty--notes">No chat is on the list yet. Link an account below, then add its groups.</p>`}
        <p class="hint account__lead">
          Each account is linked to this server as one more of its own devices, the way a laptop is, and what is sent from here
          is sent as you. A linked device is sent everything the account is sent; none of that is read, kept or shown here.
          WhatsApp does not allow devices that are not its own, and can restrict an account that uses one.
        </p>
        ${Object.keys(PLATFORMS).map((key) => account(session, key, states[key], groups[key], problems[key], error[key]))}
      </div>
    `,
  });
}
