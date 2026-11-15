/*
 * The editor on the writing page. Without this it is a plain box that takes
 * the same text. With it there are buttons and keys for the marks, lists that
 * carry on by themselves, pictures taken from a file, a paste or a drop, a
 * preview kept beside the text, and a copy of unsaved writing kept in the
 * browser in case the page is lost.
 */

(() => {
  "use strict";

  const form = document.querySelector("form[data-editor]");
  if (!form) return;

  const box = form.elements.body;
  const title = form.elements.title;
  const summary = form.elements.summary;
  const csrf = form.elements._csrf.value;
  const frame = form.querySelector(".editor");
  const bar = frame.querySelector(".editor__bar");
  const pane = frame.querySelector("[data-preview]");
  const shown = pane.querySelector(".prose");
  const shownTitle = pane.querySelector("[data-preview-title]");
  const foot = frame.querySelector(".editor__foot");
  const count = foot.querySelector("[data-count]");
  const status = foot.querySelector("[data-status]");
  const picker = frame.querySelector("[data-pictures]");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  bar.hidden = false;
  foot.hidden = false;
  frame.classList.add("is-live");
  for (const button of bar.querySelectorAll("[data-key]")) {
    button.title += ` (${mac ? "⌘" : "Ctrl+"}${button.dataset.key})`;
  }

  // something that went wrong stays up long enough to be read before routine word of saving replaces it
  let badUntil = 0;

  function say(message, bad = false) {
    status.textContent = message;
    status.classList.toggle("is-bad", bad);
    badUntil = bad ? Date.now() + 9000 : 0;
  }

  /* ------------------------------------------------- changing the text */

  /**
   * Puts `text` in place of what lies between `start` and `end`, the way
   * typing would, so that it can be undone; then selects from `from` to `to`,
   * or leaves the caret after what was put.
   */
  function put(text, start = box.selectionStart, end = box.selectionEnd, from, to) {
    box.focus();
    box.setSelectionRange(start, end);
    let typed = false;
    try {
      typed = text === "" ? start === end || document.execCommand("delete") : document.execCommand("insertText", false, text);
    } catch {
      typed = false;
    }
    if (!typed) {
      box.setRangeText(text, start, end, "end");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const caret = from ?? start + text.length;
    box.setSelectionRange(caret, to ?? caret);
  }

  /** puts marks either side of the selection, or takes them away if they are there already */
  function wrap(before, after, placeholder) {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const chosen = value.slice(start, end);
    const marked =
      value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after;
    if (marked) return put(chosen, start - before.length, end + after.length, start - before.length, end - before.length);
    const inner = chosen || placeholder;
    put(before + inner + after, start, end, start + before.length, start + before.length + inner.length);
  }

  /** the whole lines the selection touches */
  function lines() {
    const { value } = box;
    const start = value.lastIndexOf("\n", box.selectionStart - 1) + 1;
    const found = value.indexOf("\n", Math.max(box.selectionEnd, start));
    const end = found === -1 ? value.length : found;
    return { start, end, rows: value.slice(start, end).split("\n") };
  }

  const LIST_MARK = /^(\s*)(?:[-*+]|\d+[.)]) +/;

  /**
   * Begins each selected line with a mark, or if they all have it already,
   * takes it off. `mark(i)` is what the i-th line begins with; `has` tells a
   * line that has it; `clear` is what to take off a line before marking it.
   */
  function markLines(mark, has, clear = has) {
    const { start, end, rows } = lines();
    if (rows.every((row) => !row.trim())) return put(mark(0), box.selectionStart, box.selectionEnd);
    const caret = box.selectionStart === box.selectionEnd ? box.selectionStart : null;
    const all = rows.every((row) => !row.trim() || has.test(row));
    let n = 0;
    const next = rows
      .map((row) => (!row.trim() ? row : all ? row.replace(has, "$1") : row.replace(clear, "$1").replace(/^(\s*)/, `$1${mark(n++)}`)))
      .join("\n");
    // a selection stays a selection, so that the mark can be taken off again; a caret stays where it was in the words
    if (caret === null) return put(next, start, end, start, start + next.length);
    const place = Math.max(start, caret + next.length - (end - start));
    put(next, start, end, place, place);
  }

  /** a line with no heading becomes one; a heading becomes a smaller one; the smallest goes back to none */
  function heading() {
    const { start, rows } = lines();
    const row = rows[0];
    const marks = /^(#{1,6}) +/.exec(row);
    const level = marks ? marks[1].length : 0;
    const next = level === 0 ? "## " : level < 3 ? "#".repeat(level + 1) + " " : "";
    const rest = row.slice(marks ? marks[0].length : 0);
    // a line with words keeps them and the caret goes to its end; a new heading is ready to be typed
    const at = start + next.length + rest.length;
    put(next + rest, start, start + row.length, at, at);
  }

  function link() {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const chosen = value.slice(start, end);
    if (/^https?:\/\/\S+$/.test(chosen)) return put(`[words](${chosen})`, start, end, start + 1, start + 6);
    const words = chosen || "words";
    put(`[${words}](https://)`, start, end, start + words.length + 3, start + words.length + 11);
  }

  /** puts `text` on lines of its own, with a blank line either side, and selects part of it */
  function block(text, from = text.length, to = from) {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const trail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    put(lead + text + trail, start, end, start + lead.length + from, start + lead.length + to);
  }

  function formula() {
    const { rows } = lines();
    const sample = "\\int_0^1 x^2 \\, dx";
    // on an empty line a formula is set apart; in a line of text it stays in the line
    if (box.selectionStart === box.selectionEnd && !rows.join("").trim()) return block(`$$\n${sample}\n$$`, 3, 3 + sample.length);
    wrap("$", "$", "x^2");
  }

  const DIAGRAM = [
    "```tikz",
    "\\begin{tikzcd}",
    '  A \\arrow[r, "f"] \\arrow[d, "g"\'] & B \\arrow[d, "h"] \\\\',
    '  C \\arrow[r, "k"\'] & D',
    "\\end{tikzcd}",
    "```",
  ].join("\n");

  const TOOLS = {
    bold: () => wrap("**", "**", "bold"),
    italic: () => wrap("*", "*", "italic"),
    heading,
    quote: () => markLines(() => "> ", /^(\s*)> ?/),
    list: () => markLines(() => "- ", /^(\s*)[-*+] +/, LIST_MARK),
    numbered: () => markLines((i) => `${i + 1}. `, /^(\s*)\d+[.)] +/, LIST_MARK),
    link,
    // the list of articles opens by itself once "[[" is typed
    article: () => (box.selectionStart === box.selectionEnd ? put("[[") : wrap("[[", "]]", "")),
    picture: () => picker.click(),
    formula,
    diagram: () => block(DIAGRAM, 8, DIAGRAM.length - 4),
  };

  bar.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.do) TOOLS[button.dataset.do]();
    if (button.dataset.show) setView(button.dataset.show);
  });
  // pressing a button must not take the selection out of the text
  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-do]")) event.preventDefault();
  });

  /* ---------------------------------------------------------- the keys */

  /** Enter in a list or a quotation begins the next item; on an empty item it ends the list */
  function carryOn(event) {
    const { value, selectionStart: at } = box;
    if (at !== box.selectionEnd) return;
    const lineStart = value.lastIndexOf("\n", at - 1) + 1;
    const found = /^(\s*)([-*+]|\d+[.)]|>)( +)(.*)$/.exec(value.slice(lineStart, at));
    if (!found) return;
    const [, indent, mark, gap, words] = found;
    event.preventDefault();
    if (!words.trim()) return put("", lineStart, at);
    const number = /^(\d+)([.)])$/.exec(mark);
    put(`\n${indent}${number ? `${Number(number[1]) + 1}${number[2]}` : mark}${gap}`);
  }

  /** Tab in a list sets an item under the one above; with Shift, back out again */
  function indent(event) {
    const { start, end, rows } = lines();
    if (!rows.some((row) => LIST_MARK.test(row))) return;
    event.preventDefault();
    const step = /^\s*\d/.test(rows[0]) ? "   " : "  ";
    const next = rows
      .map((row) => (event.shiftKey ? row.replace(new RegExp(`^ {1,${step.length}}`), "") : row.trim() ? step + row : row))
      .join("\n");
    const moved = next.length - (end - start);
    const { selectionStart, selectionEnd } = box;
    put(next, start, end, Math.max(start, selectionStart + (rows.length === 1 ? moved : 0)), selectionEnd + moved);
  }

  box.addEventListener("keydown", (event) => {
    // the list of names and titles, when it is open, has the keys first
    if (event.defaultPrevented || event.isComposing) return;
    const command = (mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;
    const tool = command && { b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      TOOLS[tool]();
    } else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      carryOn(event);
    } else if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      indent(event);
    }
  });

  /* ------------------------------------------------------------ pictures */

  let uploads = 0;

  /** swaps one piece of the text for another without disturbing where the writer is */
  function swap(token, text) {
    const at = box.value.indexOf(token);
    if (at === -1) return;
    const { selectionStart, selectionEnd } = box;
    const end = at + token.length;
    // a caret at or after the piece moves along with what follows it; one inside goes to its end
    const moved = (place) => (place >= end ? place + text.length - token.length : place > at ? at + text.length : place);
    box.setRangeText(text, at, end, "preserve");
    box.setSelectionRange(moved(selectionStart), moved(selectionEnd));
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const most = Number(picker.dataset.most) || Infinity;

  async function upload(file) {
    // said here, before any of it is sent: the server would refuse it only after a long wait
    if (file.size > most) return say(`A picture can be up to ${Math.round(most / 1024 / 1024)} MB; “${file.name}” is larger.`, true);
    const name =
      file.name
        .replace(/\.[^.]+$/, "")
        .replace(/[[\]()_-]+/g, " ")
        .trim() || "Picture";
    // a line stands in for the picture while it is on its way
    const token = `![Uploading ${name}… ${++uploads}]()`;
    block(token);
    try {
      const response = await fetch("/media", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": file.type || "application/octet-stream",
          "X-CSRF-Token": csrf,
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok || !answer.url) throw new Error(answer.error || "The picture could not be uploaded.");
      swap(token, `![${name}](${answer.url})`);
      say("Picture added. The words in the square brackets say what it shows; change them to suit.");
    } catch (err) {
      // the line goes, and with it the blank line that was put after it
      swap(box.value.includes(`${token}\n\n`) ? `${token}\n\n` : token, "");
      say(err.message || "The picture could not be uploaded.", true);
    }
  }

  function take(files) {
    const pictures = [...files].filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0 && files.length > 0) say("Only pictures can be put in the text this way.", true);
    for (const picture of pictures) upload(picture);
    return pictures.length > 0;
  }

  picker.addEventListener("change", () => {
    take(picker.files);
    picker.value = "";
  });

  box.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    if (data.files.length > 0 && take(data.files)) return event.preventDefault();
    // a web address pasted over selected words makes a link of them
    const pasted = data.getData("text/plain").trim();
    const { selectionStart: start, selectionEnd: end, value } = box;
    const chosen = value.slice(start, end);
    if (/^https?:\/\/\S+$/.test(pasted) && chosen.trim() && !/^https?:\/\//.test(chosen) && !chosen.includes("\n")) {
      event.preventDefault();
      put(`[${chosen}](${pasted})`, start, end);
    }
  });

  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  for (const type of ["dragenter", "dragover"]) {
    frame.addEventListener(type, (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      frame.classList.add("is-dropping");
    });
  }
  frame.addEventListener("dragleave", (event) => {
    if (!frame.contains(event.relatedTarget)) frame.classList.remove("is-dropping");
  });
  frame.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    frame.classList.remove("is-dropping");
    take(event.dataTransfer.files);
  });

  /* ------------------------------------------------------------- preview */

  const roomForBoth = window.matchMedia("(min-width: 68rem)");
  const VIEW_KEY = "gesserit.editor.view";
  let view = "write";
  let fetching = false;
  let stale = false;
  let timer;

  async function refresh() {
    if (view === "write") return;
    if (fetching) {
      stale = true;
      return;
    }
    fetching = true;
    stale = false;
    try {
      const response = await fetch("/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ _csrf: csrf, title: title.value, body: box.value }),
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer.error || "The preview could not be fetched.");
      // made by the server, which lets nothing through that could run
      shown.innerHTML = answer.html;
      pane.classList.toggle("is-empty", !answer.html.trim());
      if (status.dataset.preview) say("");
      delete status.dataset.preview;
    } catch (err) {
      say(err.message || "The preview could not be fetched.", true);
      status.dataset.preview = "failed";
    }
    fetching = false;
    if (stale) refresh();
  }

  function showTitle() {
    shownTitle.textContent = title.value.trim();
    shownTitle.hidden = !title.value.trim();
  }

  function setView(next, remember = true) {
    if (next === "both" && !roomForBoth.matches) next = "preview";
    view = next;
    frame.dataset.view = next;
    pane.hidden = next === "write";
    for (const button of bar.querySelectorAll("[data-show]")) button.setAttribute("aria-pressed", String(button.dataset.show === next));
    for (const button of bar.querySelectorAll("[data-do]")) button.disabled = next === "preview";
    if (remember && next !== "preview") {
      try {
        localStorage.setItem(VIEW_KEY, next);
      } catch {
        // a browser that keeps nothing still shows the preview
      }
    }
    if (next !== "write") {
      showTitle();
      refresh();
    }
    if (next !== "preview") fit();
  }

  // too narrow for two columns: fall back to one or the other
  roomForBoth.addEventListener("change", () => {
    if (view === "both" && !roomForBoth.matches) setView("write", false);
  });

  // a box that cannot be seen cannot be shown to be empty: bring it back first
  box.addEventListener("invalid", () => {
    if (view === "preview") setView("write", false);
  });

  /* ------------------------------------------- the box grows with the text */

  // it is the least height that is set, so that beside a longer preview the box still reaches the foot of it
  function fit() {
    if (box.offsetParent === null) return;
    const top = window.scrollY;
    box.style.minHeight = "";
    box.style.minHeight = `${box.scrollHeight + 2}px`;
    if (window.scrollY !== top) window.scrollTo({ top, behavior: "instant" });
  }
  window.addEventListener("resize", fit);

  /* -------------------------------------- a copy kept while it is unsaved */

  const DRAFT_KEY = `gesserit.draft.${form.dataset.editor}`;
  const snapshot = () => ({ title: title.value, body: box.value, summary: summary ? summary.value : "" });
  const same = (a, b) => a.title === b.title && a.body === b.body && (a.summary || "") === (b.summary || "");
  const clock = (at) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const saved = snapshot(); // what the server has
  let leaving = false;
  let keeper;

  function keep(extra = {}) {
    try {
      if (same(snapshot(), saved)) return localStorage.removeItem(DRAFT_KEY);
      const at = Date.now();
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...snapshot(), at, ...extra }));
      if (!extra.sent && !status.dataset.preview && Date.now() > badUntil) say(`Not saved yet. A copy is kept in this browser (${clock(at)}).`);
    } catch {
      // nowhere to keep it: the page still warns before it is left
    }
  }

  function offerKept() {
    let kept = null;
    try {
      kept = JSON.parse(localStorage.getItem(DRAFT_KEY));
    } catch {
      kept = null;
    }
    if (!kept || typeof kept.body !== "string") return;
    if (same(kept, saved) || !kept.body.trim()) return localStorage.removeItem(DRAFT_KEY);

    const offer = document.createElement("div");
    offer.className = "notice notice--ok kept";
    const words = document.createElement("p");
    const when = new Date(kept.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    words.textContent = `Writing from ${when} that was never saved is still kept in this browser.`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "link";
    restore.textContent = "Bring it back";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "link link--quiet";
    discard.textContent = "Discard it";
    const buttons = document.createElement("p");
    buttons.className = "kept__choice";
    buttons.append(restore, discard);
    offer.append(words, buttons);
    frame.before(offer);

    restore.addEventListener("click", () => {
      title.value = kept.title || "";
      box.value = kept.body;
      if (summary) summary.value = kept.summary || "";
      offer.remove();
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus();
    });
    discard.addEventListener("click", () => {
      offer.remove();
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // nothing was kept, then
      }
    });
  }

  function tally() {
    const words = box.value.trim() ? box.value.trim().split(/\s+/).length : 0;
    count.textContent = `${words.toLocaleString("en-GB")} ${words === 1 ? "word" : "words"}`;
  }

  function changed() {
    tally();
    fit();
    clearTimeout(keeper);
    keeper = setTimeout(keep, 700);
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  }

  box.addEventListener("input", changed);
  title.addEventListener("input", () => {
    showTitle();
    changed();
  });
  summary?.addEventListener("input", changed);

  form.addEventListener("submit", () => {
    // marked as sent: once the saved post is shown, the copy is no longer wanted
    leaving = true;
    clearTimeout(keeper);
    keep({ sent: true });
  });

  // the form that deletes the post leaves on purpose too, unless the question it asks is answered no
  document.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) leaving = true;
  });

  window.addEventListener("beforeunload", (event) => {
    if (leaving || same(snapshot(), saved)) return;
    keep();
    event.preventDefault();
    event.returnValue = "";
  });

  /* ----------------------------------------------------------- beginning */

  offerKept();
  let preferred = null;
  try {
    preferred = localStorage.getItem(VIEW_KEY);
  } catch {
    preferred = null;
  }
  // where there is room the preview begins beside the text, unless it was last put away
  setView(preferred === "write" || !roomForBoth.matches ? "write" : "both", false);
  tally();
  fit();
})();
