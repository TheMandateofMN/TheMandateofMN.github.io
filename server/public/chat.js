/*
 * A room, live. Without this the page still works: the form posts and the
 * page comes back with the message on it. With it, what is said arrives as
 * it is said, over one connection the page keeps open, and a message is sent
 * without the page being made again.
 */

(() => {
  "use strict";

  const talk = document.querySelector("#talk[data-live]");
  const form = document.querySelector("form[data-chat]");
  if (!talk || !form) return;

  const room = talk.dataset.room;
  const box = form.elements.body;
  const status = form.querySelector("[data-chat-status]");
  const nothing = document.querySelector("[data-nothing]");
  /* messages by one member within this long of each other are set as one run, as the server sets them */
  const RUN_MS = 5 * 60 * 1000;

  /* --------------------------------------------------------------- times */

  const TIME = { hour: "2-digit", minute: "2-digit" };
  const STAMP = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };

  /** today's messages carry the time alone; older ones the day as well */
  function setTimes(within) {
    const today = new Date().toDateString();
    for (const time of within.querySelectorAll("time[datetime]")) {
      const date = new Date(time.dateTime);
      if (Number.isNaN(date.getTime())) continue;
      time.textContent =
        date.toDateString() === today ? date.toLocaleTimeString("en-GB", TIME) : date.toLocaleString("en-GB", STAMP);
      time.title = date.toLocaleString("en-GB", STAMP);
    }
  }
  setTimes(talk);

  /* ----------------------------------------------------- where the end is */

  const page = document.scrollingElement;
  /** whether the reader is at the end of the conversation, near enough */
  const atEnd = () => page.scrollHeight - page.scrollTop - window.innerHeight < 160;
  const toEnd = () => page.scrollTo({ top: page.scrollHeight });
  // a room opens at its latest message, unless the address names one
  if (!window.location.hash || window.location.hash === "#say") toEnd();

  /* ----------------------------------------------------------- arriving */

  const built = document.createElement("template");
  /** the element a message was sent as */
  function made(markup) {
    built.innerHTML = markup;
    const item = built.content.firstElementChild;
    if (item) setTimes(item);
    return item;
  }

  const isSaid = (item) => item && !/say--(event|gone)/.test(item.className);

  /** a message straight after another by the same member goes under it, without the name again */
  function setRun(item) {
    const before = item.previousElementSibling;
    const run =
      isSaid(item) &&
      isSaid(before) &&
      before.dataset.by === item.dataset.by &&
      Date.parse(item.dataset.at) - Date.parse(before.dataset.at) < RUN_MS;
    item.classList.toggle("say--run", Boolean(run));
  }

  let unseen = 0;
  const name = document.title;
  const showUnseen = () => (document.title = unseen > 0 ? `(${unseen}) ${name}` : name);

  let telling = null;
  /** tells the server that what is on the page has been read, soon and not for every message */
  function read() {
    unseen = 0;
    showUnseen();
    clearTimeout(telling);
    telling = setTimeout(() => {
      fetch(`/chat/${room}/read`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ _csrf: form.elements._csrf.value }),
      }).catch(() => {});
    }, 600);
  }

  function arrived(event) {
    const { id, html } = JSON.parse(event.data);
    if (document.getElementById(`m${id}`)) return;
    const item = made(html);
    if (!item) return;
    const follow = atEnd();
    talk.append(item);
    setRun(item);
    talk.dataset.last = id;
    if (nothing) nothing.hidden = true;
    if (follow) toEnd();
    if (document.visibilityState === "visible" && follow) read();
    else if (item.dataset.by !== talk.dataset.me) {
      unseen += 1;
      showUnseen();
    }
  }

  function removed(event) {
    const { id, html } = JSON.parse(event.data);
    const old = document.getElementById(`m${id}`);
    const item = old && made(html);
    if (!item) return;
    const after = old.nextElementSibling;
    old.replaceWith(item);
    // the one after it no longer follows a message, and gets its name back
    if (after) setRun(after);
  }

  const readIfSeen = () => {
    if (unseen > 0 && document.visibilityState === "visible" && atEnd()) read();
  };
  document.addEventListener("visibilitychange", readIfSeen);
  window.addEventListener("scroll", readIfSeen, { passive: true });

  /* ------------------------------------------------------- the connection */

  let source = null;
  let down = null;
  let refused = 0;

  function say(message, bad = false) {
    status.textContent = message;
    status.classList.toggle("is-bad", bad);
  }

  function connect() {
    // the browser reconnects by itself and says which message it had last; this is for the first time
    source = new EventSource(`/chat/${room}/stream?after=${talk.dataset.last}`);
    source.addEventListener("said", arrived);
    source.addEventListener("removed", removed);
    source.addEventListener("open", () => {
      refused = 0;
      clearTimeout(down);
      if (status.dataset.about === "line") say("");
      delete status.dataset.about;
    });
    source.addEventListener("error", () => {
      // a short break mends itself unseen; only one that lasts is worth a word
      clearTimeout(down);
      down = setTimeout(() => {
        status.dataset.about = "line";
        say("Not connected. New messages will appear when the connection is back.", true);
      }, 5000);
      // A connection the server refused is not tried again by the browser. It may be that the
      // server was being restarted, so it is tried a few times more; after that the reader has
      // been signed out or is no longer in the room, and the page has to be loaded again.
      if (source.readyState !== EventSource.CLOSED) return;
      refused += 1;
      if (refused <= 4) return setTimeout(connect, 5000 * refused);
      clearTimeout(down);
      status.dataset.about = "gone";
      say("This conversation is no longer being followed. Reload the page.", true);
    });
  }
  connect();
  window.addEventListener("pagehide", () => source?.close());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) connect();
  });

  /* -------------------------------------------------------------- sending */

  const hint = form.querySelector("[data-chat-hint]");
  if (hint && window.matchMedia("(hover: hover)").matches) hint.hidden = false;

  /** the box is as tall as what is in it, up to a point */
  function fit() {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight + 2, 220)}px`;
  }
  box.addEventListener("input", fit);
  fit();

  let sending = false;

  async function sendIt() {
    const body = box.value.trim();
    if (!body || sending) return;
    sending = true;
    delete status.dataset.about;
    say("");
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ _csrf: form.elements._csrf.value, body }),
      });
      if (response.ok) {
        // the message itself comes back over the connection, like everyone else's
        box.value = "";
        fit();
        toEnd();
      } else {
        const answer = await response.json().catch(() => null);
        say(answer?.error || "That could not be sent. Reload the page and try again.", true);
      }
    } catch {
      say("That could not be sent: there is no connection. It is still in the box.", true);
    } finally {
      sending = false;
      box.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendIt();
  });

  box.addEventListener("keydown", (event) => {
    // the list of names, when it is open, has the keys first
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    // on a telephone Enter is the only way to a new line; the button sends
    if (!window.matchMedia("(hover: hover)").matches) return;
    event.preventDefault();
    sendIt();
  });
})();
