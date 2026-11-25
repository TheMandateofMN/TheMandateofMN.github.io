/*
 * The pages of the invitations: the admins' list of who is to be invited,
 * with their numbers, from which each is handed a link or sent one by text;
 * the page someone comes to by that link, where they take up their account;
 * and the page a text about a piece is sent from.
 */

import { config } from "./config.mjs";
import { canLink, canTell, linkStands } from "./numbers.mjs";
import { timeTag } from "./render.mjs";
import { MOST_WORDS, partsOf, WORDS } from "./texts.mjs";
import { csrfField, html, memberHref, named, notice, page, plural, raw, shell, wordmark } from "./views.mjs";

const TIMES = ["", "once", "twice"];

/** where someone on the list stands, in a few words */
function standing(contact, last) {
  if (contact.accepted_at)
    return html`<span class="tag tag--mark">Taken up</span>
      <span class="members__seen"
        ><a href="${memberHref(contact.username)}">${contact.username}</a> · ${raw(timeTag(contact.accepted_at))}${contact.wants &&
        ` · texts: ${contact.wants.split(" ").join(", ")}`}${contact.stopped_at && " · has asked for no more texts"}</span
      >`;
  const failed = last && !last.ok && html`<span class="members__seen numbers__failed">${last.detail}</span>`;
  // the link they hold, however it reached them, and until when it is good
  const link =
    linkStands(contact) && html`<span class="members__seen">Their link is good until ${raw(timeTag(contact.link_until))}</span>`;
  const lapsed = contact.lapsed_at && html` · not taken up; lapsed ${raw(timeTag(contact.lapsed_at))}`;
  if (contact.told > 0)
    return html`<span class="tag ${contact.lapsed_at || contact.stopped_at ? "tag--quiet" : "tag--new"}"
        >Texted ${TIMES[contact.told] ?? `${contact.told} times`}</span
      >
      <span class="members__seen"
        >${raw(timeTag(contact.told_at))}${contact.stopped_at && " · has asked for no more texts"}${lapsed}</span
      >${link}${failed}`;
  if (contact.linked_at)
    return html`<span class="tag ${contact.lapsed_at ? "tag--quiet" : "tag--new"}">Given a link</span>
      <span class="members__seen">${raw(timeTag(contact.linked_at))}${lapsed}</span>${link}${failed}`;
  if (contact.stopped_at) return html`<span class="tag tag--quiet">Asked for nothing more</span>`;
  return html`<span class="tag tag--quiet">Not invited yet</span>${failed}`;
}

/** a link that was just made, shown this once for the admin to pass on */
const issuedLink = (issued) =>
  issued &&
  html`<div class="notice notice--ok numbers__issued" role="status">
    <p>
      A link for <strong>${issued.name}</strong>, good for ${config.inviteDays} days. Send it to them yourself, however you
      reach them. It is shown only this once.
    </p>
    <p class="numbers__link">
      <code id="issued-link">${issued.link}</code>
      <button class="link" type="button" data-copy="issued-link" hidden>Copy</button>
    </p>
    <p>
      It is theirs alone: whoever opens it chooses a sign-in name and a password, and is in. A new link, or a text, ends
      this one.
    </p>
  </div>`;

/** how the sending that is under way stands, or how the last of it went */
const runNotice = (run) =>
  run &&
  html`<p class="notice notice--ok" role="status">
    ${run.over
      ? html`${run.what}: ${plural(run.done - run.failed, "text")} sent${run.failed > 0 && `, ${run.failed} could not be`}.`
      : html`${run.what}: ${run.done} of ${run.total} so far. <a href="/invitations">See how it stands</a>`}
  </p>`;

/**
 * The list. `list` is everyone on it, each with `shown`, their number
 * covered but for its end; `last` what last happened with each; `blocked`
 * why no number can be kept, and `unsendable` why no text can be sent.
 */
export function numbersPage({ session, list, last, words, run, blocked, unsendable, error, failed, said, issued, values = {} }) {
  // the announcement goes to those nobody has invited yet: whoever holds a link an admin made is texted one by one, if at all
  const untold = list.filter((each) => each.told === 0 && canTell(each) && !linkStands(each)).length;
  const waiting = list.filter((each) => each.told > 0 && canTell(each)).length;
  const busy = Boolean(run && !run.over);
  const texting = !blocked && !unsendable;
  const row = (contact, i) => html`<tr>
    <td class="numbers__place">${i + 1}</td>
    <td><strong>${contact.name}</strong></td>
    <td class="numbers__number">${contact.shown ?? html`<span class="visually-hidden">No number</span>`}</td>
    <td>${standing(contact, last.get(contact.id))}</td>
    <td class="members__actions">
      <a class="link" href="/invitations/${contact.id}">Edit</a>
      ${canLink(contact) &&
      !busy &&
      html`<form method="post" action="/invitations/${contact.id}/link">
        ${csrfField(session)}
        <button
          class="link"
          type="submit"
          ${linkStands(contact) && html`data-confirm="Make a new link for ${contact.name}? The one they have now stops working."`}
        >
          ${linkStands(contact) ? "New link" : "Make a link"}
        </button>
      </form>`}
      ${canTell(contact) &&
      texting &&
      !busy &&
      html`<form method="post" action="/invitations/${contact.id}/tell">
        ${csrfField(session)}
        <button
          class="link"
          type="submit"
          data-confirm="Text ${contact.name} ${contact.told === 0 ? "the announcement" : "the second message, which is the last they can be sent"}?${linkStands(
            contact
          ) && " The link they have now stops working."}"
        >
          ${contact.told === 0 ? "Text them" : "Text once more"}
        </button>
      </form>`}
    </td>
  </tr>`;
  return page({
    title: "Invitations",
    session,
    width: "wide",
    current: "members",
    main: html`
      <p class="rubric"><a href="/">Scribe</a></p>
      <h1 class="page-title">Invitations</h1>
      <p class="hint numbers__lead">
        Those who are to be invited, in the order they were put down. Each is given a link of their own, which you pass on
        yourself or which goes to their number in a text; by it they choose a password and come in. Only admins see this page.
        A number is kept sealed, and is shown here by its last four digits; open someone to see or change it.
      </p>
      ${notice(failed)} ${said && notice(said, "ok")} ${issuedLink(issued)} ${runNotice(run)}

      <h2 class="section-title">Invite someone</h2>
      <form class="form form--inline numbers__add" method="post" action="/invitations">
        ${csrfField(session)} ${notice(error)}
        <div>
          <label for="name">Their name</label>
          <input id="name" name="name" value="${values.name || ""}" maxlength="80" autocomplete="off" required />
        </div>
        ${!blocked &&
        html`<div>
          <label for="number">Their number, if any</label>
          <input id="number" name="number" value="${values.number || ""}" maxlength="24" inputmode="tel" autocomplete="off" placeholder="+1 415 555 0100" />
        </div>`}
        <div class="numbers__adds">
          <button class="button" type="submit" name="then" value="link">Make their link</button>
          <button class="button button--quiet" type="submit">Only put them down</button>
        </div>
      </form>
      <p class="hint">
        They go to the end of the list, and nothing is sent to them by either button. The name is what the forum will call
        them; they choose their own sign-in name and password when they come.
        ${blocked
          ? html`${blocked} Until it is, people are invited by a link alone.`
          : "A number is needed only to text them; without a country code it is taken to be in the United States or Canada."}
      </p>

      <h2 class="section-title">Those invited</h2>
      ${list.length > 0
        ? html`<table class="members numbers">
            <thead>
              <tr>
                <th scope="col"><span class="visually-hidden">Place</span></th>
                <th scope="col">Name</th>
                <th scope="col">Number</th>
                <th scope="col">Where they stand</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              ${list.map(row)}
            </tbody>
          </table>`
        : html`<p class="empty empty--notes">Nobody is put down yet.</p>`}

      ${!blocked && unsendable && html`<p class="hint">${unsendable} Until then, people are invited by a link you pass on.</p>`}

      ${texting &&
      (untold > 0 || waiting > 0) &&
      html`<h2 class="section-title">Text them</h2>
        <div class="numbers__sends">
          ${untold > 0 &&
          html`<form method="post" action="/invitations/tell">
            ${csrfField(session)}
            <input type="hidden" name="which" value="first" />
            <button
              class="button"
              type="submit"
              ${busy && raw("disabled")}
              data-confirm="Text the announcement to ${plural(untold, "person", "people")}, in order? This cannot be taken back."
            >
              Text the announcement to ${untold === 1 ? "the one" : `all ${untold}`} not yet invited
            </button>
          </form>`}
          ${waiting > 0 &&
          html`<form method="post" action="/invitations/tell">
            ${csrfField(session)}
            <input type="hidden" name="which" value="again" />
            <button
              class="button button--quiet"
              type="submit"
              ${busy && raw("disabled")}
              data-confirm="Text the second message to ${plural(waiting, "person", "people")} who ${waiting === 1 ? "has" : "have"} not taken up an account? It is the last they can be sent."
            >
              Text the second message to the ${waiting} who ${waiting === 1 ? "has" : "have"} not come
            </button>
          </form>`}
        </div>
        <p class="hint">
          Each is sent a link of their own, good for ${config.inviteDays} days, by which they choose a password and come in.
          Nobody is texted more than ${config.mostTellings === 2 ? "twice" : `${config.mostTellings} times`} about an account
          they have not taken up. The announcement passes over those put down without a number, and those who hold a link
          you made for them, who can be texted one by one.
        </p>`}

      <h2 class="section-title" id="words">What the texts say</h2>
      <form class="form" method="post" action="/invitations/words#words">
        ${csrfField(session)}
        ${Object.entries(WORDS).map(
          ([kind, { name, says }]) =>
            html`<label for="words-${kind}">${name}</label>
              <p class="hint">
                ${says} As it stands, with its link${kind === "piece" && " and before its title"}, it is sent in
                ${plural(partsOf(kind, words[kind]), "part")}; each part is charged as a text.
              </p>
              <textarea id="words-${kind}" name="${kind}" rows="3" maxlength="${MOST_WORDS}" required>${words[kind]}</textarea>`
        )}
        <div class="compose__actions">
          <button class="button" type="submit">Save the words</button>
        </div>
      </form>

      ${texting &&
      html`<h2 class="section-title" id="try">See how it reads</h2>
        <form class="form form--inline form--one" method="post" action="/invitations/try#try">
          ${csrfField(session)}
          <div>
            <label for="try-number">A number of your own</label>
            <input id="try-number" name="number" maxlength="24" inputmode="tel" autocomplete="off" required />
          </div>
          <button class="button button--quiet" type="submit">Send the announcement there</button>
        </form>
        <p class="hint">The number is used once and not kept. The link in it leads to the sign-in page.</p>`}
    `,
  });
}

/**
 * One of those on the list, with their number in full, to change or take
 * off. `number` is "" for someone who has none and null for one that cannot
 * be read; `keeps` is whether a number can be kept at all.
 */
export function numberPage({ session, contact, number, keeps, place, total, error, values = {} }) {
  return page({
    title: contact.name,
    session,
    current: "members",
    main: html`
      <p class="rubric"><a href="/invitations">Invitations</a></p>
      <h1 class="page-title">${contact.name}</h1>
      <form class="form form--narrow" method="post" action="/invitations/${contact.id}">
        ${csrfField(session)} ${notice(error)}
        <label for="name">Their name</label>
        <input id="name" name="name" value="${values.name ?? contact.name}" maxlength="80" autocomplete="off" required />
        ${keeps
          ? html`<label for="number">Their number</label>
              <p class="hint">
                ${number === null
                  ? "The number kept for them cannot be read: it was sealed with another key. Left empty, it stays as it is; a number typed here takes its place."
                  : "Needed only if they are to be texted. Left empty, no number is kept for them, and they are invited by a link."}
              </p>
              <input id="number" name="number" value="${values.number ?? number ?? ""}" maxlength="24" inputmode="tel" autocomplete="off" placeholder="+1 415 555 0100" />`
          : number !== "" && html`<p class="hint">Their number is kept sealed, and stays as it is: it cannot be read or changed until NUMBERS_KEY is set on the server.</p>`}
        <label for="place">Their place in the list</label>
        <p class="hint">From 1 to ${total}. When the announcement is texted to everyone, it goes in this order.</p>
        <input id="place" name="place" value="${values.place ?? place}" inputmode="numeric" maxlength="5" required />
        <div class="compose__actions">
          <button class="button" type="submit">Save</button>
          <a class="compose__cancel" href="/invitations">Cancel</a>
        </div>
      </form>
      <form class="compose__delete" method="post" action="/invitations/${contact.id}/remove">
        ${csrfField(session)}
        <button
          class="link link--danger"
          type="submit"
          data-confirm="Take ${contact.name} off the list? ${number !== "" && "Their number is deleted, and a"}${number === "" && "A"} link they were given stops working.${contact.accepted_at &&
          " Their account stays, and is sent no more texts."}"
        >
          Take them off the list
        </button>
      </form>
    `,
  });
}

/* ------------------------------------------------------- taking it up */

/** the page a link in a text leads to: `found` is whose invitation it is, or null if it has ended */
export function welcomePage({ found, token, error, values = {} }) {
  if (!found)
    return shell({
      title: "Invitation",
      bodyClass: "gate",
      body: html`
        <main class="gate__leaf">
          <p class="gate__mark"><a href="${config.landingUrl}">${wordmark}</a></p>
          <h1 class="rubric gate__title">This invitation has ended</h1>
          <p class="gate__says">
            The link has been used, or its time has run out. If you have chosen a password already,
            <a href="/login">sign in</a>. Otherwise ask to be invited again.
          </p>
          <div class="gate__rule" aria-hidden="true"></div>
        </main>
      `,
    });
  return shell({
    title: "Welcome",
    bodyClass: "gate",
    body: html`
      <main class="gate__leaf">
        <p class="gate__mark"><a href="${config.landingUrl}">${wordmark}</a></p>
        <h1 class="rubric gate__title">Welcome, ${found.name}</h1>
        <p class="gate__says">An account is waiting for you. Choose a password to take it up, and you are in.</p>
        <form class="form gate__form" method="post" action="/welcome/${token}">
          ${notice(error)}
          <label for="username">Sign-in name</label>
          <input
            id="username"
            name="username"
            value="${values.username ?? ""}"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            maxlength="32"
            required
          />
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="new-password"
            minlength="${config.minPasswordLength}"
            maxlength="200"
            required
            autofocus
          />
          <button class="button" type="submit">Enter</button>
        </form>
        <p class="gate__says gate__says--small">
          You will sign in with these from now on. At least ${config.minPasswordLength} characters; a few unrelated words make
          a good password.
        </p>
        <div class="gate__rule" aria-hidden="true"></div>
      </main>
    `,
  });
}

/* ------------------------------------------------- a text about a piece */

/** where the main admin sends a text about a piece: `all` and `some` are how many asked for each, not yet sent this one */
export function pieceTextPage({ session, post, words, all, some, already, unsendable, run, error }) {
  const name = named(post.title, post.body, 80);
  return page({
    title: "Text this piece",
    session,
    current: "post",
    main: html`
      <p class="rubric"><a href="/p/${post.id}">${name}</a></p>
      <h1 class="page-title">Text this piece</h1>
      ${unsendable && notice(unsendable)} ${notice(error)} ${runNotice(run)}
      <p class="hint">
        Members who came by an invitation can ask, in their preferences, for a text about everything that is published or about
        some of it. Which pieces are the “some” is for you to say, here, each time.
        ${already > 0 && `${plural(already, "member")} ${already === 1 ? "has" : "have"} been sent this one already, and will not be sent it again.`}
      </p>
      <p class="numbers__preview" data-typed>${words}</p>
      ${!unsendable &&
      (all + some > 0
        ? html`<form class="form" method="post" action="/p/${post.id}/text">
            ${csrfField(session)}
            <div class="options grants">
              <label class="grant"
                ><input type="checkbox" name="to" value="all" checked ${all === 0 && raw("disabled")} />
                <span class="grant__name">Those who asked for every piece</span>
                <span class="grant__says">${plural(all, "member")}.</span></label
              >
              <label class="grant"
                ><input type="checkbox" name="to" value="some" ${some === 0 && raw("disabled")} />
                <span class="grant__name">And those who asked for some</span>
                <span class="grant__says">${plural(some, "member")} more.</span></label
              >
            </div>
            <div class="compose__actions">
              <button class="button" type="submit" data-confirm="Send this text? It cannot be taken back.">Send the text</button>
              <a class="compose__cancel" href="/p/${post.id}">Cancel</a>
            </div>
          </form>`
        : html`<p class="empty empty--notes">Nobody who has not been sent it has asked for texts.</p>`)}
      <p class="hint"><a href="/invitations#words">Change what the text says</a></p>
    `,
  });
}


