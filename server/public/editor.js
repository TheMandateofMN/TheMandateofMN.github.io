/*
 * The editor on the writing page. Without this it is a plain box that takes
 * the text with its marks. With it, the box gives way to a page that is
 * written on as it will look: a heading is a heading while it is typed, a
 * list is a list, a picture is the picture. There are buttons and keys for
 * all of it, pictures are taken from a file, a paste or a drop, and a copy of
 * unsaved writing is kept in the browser in case the page is lost.
 *
 * What is kept is still the plain text. The server sets it out for the page,
 * piece by piece (see `editable` in render.mjs), and markdown.js reads the
 * page back into text. A piece that was not touched goes back exactly as it
 * was written, so that opening something and saving it changes nothing, and
 * changing one paragraph changes only that paragraph.
 *
 * The plain text is there for whoever would rather write it: under View, with
 * a preview that can be had beside it. Whichever is shown, the box is what
 * the form sends.
 */

(() => {
  "use strict";

  const form = document.querySelector("form[data-editor]");
  if (!form) return;

  const M = globalThis.GesseritMarkdown;
  const box = form.elements.body;
  const title = form.elements.title;
  const summary = form.elements.summary;
  const csrf = form.elements._csrf.value;
  const frame = form.querySelector(".editor");
  const bar = frame.querySelector(".editor__bar");
  const page = frame.querySelector("[data-page]");
  const pane = frame.querySelector("[data-preview]");
  const shown = pane.querySelector(".prose");
  const shownTitle = pane.querySelector("[data-preview-title]");
  const foot = frame.querySelector(".editor__foot");
  const status = foot.querySelector("[data-status]");
  // whether the text may be left empty is the form's to say: a piece can be saved as its title alone
  const needed = box.required;
  const picker = frame.querySelector("[data-pictures]");
  const styleName = bar.querySelector("[data-style-name]");
  const viewName = bar.querySelector("[data-view-name]");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  bar.hidden = false;
  foot.hidden = false;
  frame.classList.add("is-live");
  for (const button of bar.querySelectorAll("[data-key]")) {
    button.title += ` (${mac ? "⌘" : "Ctrl+"}${button.dataset.key})`;
  }

  // "page" while the page is written on; "write" for the plain text; "preview"; "both" for text and preview
  let view = "write";

  /** says something under the page: what went wrong, or what was just done. Nothing is said there otherwise */
  function say(message, bad = false) {
    status.textContent = message;
    status.classList.toggle("is-bad", bad);
  }

  /** asks the server for something, as the form would */
  async function send(path, fields, failed) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error || failed);
    return answer;
  }

  /* ================================================== the plain text === */

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
  const ANY_MARK = /^(\s*)(?:#{1,6} +|> ?|[-*+] +|\d+[.)] +)/;

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

  /** makes the line a heading of the size asked for, or with none, plain again */
  function headingLine(level) {
    const { start, rows } = lines();
    const row = rows[0];
    const marks = ANY_MARK.exec(row);
    const next = level ? `${"#".repeat(level)} ` : "";
    const rest = row.slice(marks ? marks[0].length : 0);
    // a line with words keeps them and the caret goes to its end; a new heading is ready to be typed
    const at = start + next.length + rest.length;
    put(next + rest, start, start + row.length, at, at);
  }

  /** takes whatever marks begin the selected lines off them */
  function plainLines() {
    const { start, end, rows } = lines();
    const next = rows.map((row) => row.replace(ANY_MARK, "$1")).join("\n");
    put(next, start, end, start + next.length, start + next.length);
  }

  function linkInText() {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const chosen = value.slice(start, end);
    if (/^https?:\/\/\S+$/.test(chosen)) return put(`[words](${chosen})`, start, end, start + 1, start + 6);
    const words = chosen || "words";
    put(`[${words}](https://)`, start, end, start + words.length + 3, start + words.length + 11);
  }

  /** puts `text` on lines of its own, with a blank line either side, and selects part of it */
  function apart(text, from = text.length, to = from) {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const trail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    put(lead + text + trail, start, end, start + lead.length + from, start + lead.length + to);
  }

  const FORMULA = "\\int_0^1 x^2 \\, dx";

  function formulaInText() {
    const { rows } = lines();
    // on an empty line a formula is set apart; in a line of text it stays in the line
    if (box.selectionStart === box.selectionEnd && !rows.join("").trim()) return apart(`$$\n${FORMULA}\n$$`, 3, 3 + FORMULA.length);
    wrap("$", "$", "x^2");
  }

  const DIAGRAM = [
    "\\begin{tikzcd}",
    '  A \\arrow[r, "f"] \\arrow[d, "g"\'] & B \\arrow[d, "h"] \\\\',
    '  C \\arrow[r, "k"\'] & D',
    "\\end{tikzcd}",
  ].join("\n");
  const fencedDiagram = (source, words = "") => `\`\`\`tikz${words ? ` ${words}` : ""}\n${source}\n\`\`\``;

  const ON_TEXT = {
    undo: () => {
      box.focus();
      document.execCommand("undo");
    },
    redo: () => {
      box.focus();
      document.execCommand("redo");
    },
    bold: () => wrap("**", "**", "bold"),
    italic: () => wrap("*", "*", "italic"),
    text: plainLines,
    title: () => headingLine(1),
    heading: () => headingLine(2),
    subheading: () => headingLine(3),
    quote: () => markLines(() => "> ", /^(\s*)> ?/),
    list: () => markLines(() => "- ", /^(\s*)[-*+] +/, LIST_MARK),
    numbered: () => markLines((i) => `${i + 1}. `, /^(\s*)\d+[.)] +/, LIST_MARK),
    link: linkInText,
    // the list of articles opens by itself once "[[" is typed
    article: () => (box.selectionStart === box.selectionEnd ? put("[[") : wrap("[[", "]]", "")),
    picture: () => picker.click(),
    formula: formulaInText,
    diagram: () => apart(fencedDiagram(DIAGRAM), 8, 8 + DIAGRAM.length),
  };

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
  function indentLines(event) {
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
      ON_TEXT[tool]();
    } else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      carryOn(event);
    } else if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      indentLines(event);
    }
  });

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

  /* ======================================================== the page === */

  /*
   * What the server set out and nobody has touched since: for each such
   * piece of the page, the words that made it (`src`), the blank lines that
   * followed (`gap`), and the piece that followed it (`next`). A piece is
   * forgotten here the moment anything in it changes.
   */
  const kept = new WeakMap();
  let defs = [];
  // the text the page was last set out from, or last written back as; null until there is a page
  let settled = null;
  let touched = false;

  const UNIT = "p, h1, h2, h3, h4, h5, h6, li, pre";
  const SOLID = "[data-md], hr, pre, table";
  const STANDS_ALONE = /^(P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|DIV|TABLE|HR|FIGURE|SECTION|ARTICLE)$/;

  const make = (html) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  };

  function emptyParagraph() {
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    return p;
  }

  const isBlank = (el) => !el.textContent.replace(/[\s\u200b]/g, "") && !el.querySelector("[data-md], img, hr, input");

  /* --------------------------------------------------- where the caret is */

  const selection = () => window.getSelection();

  /** the selection, if it lies in the page */
  function caret() {
    const chosen = selection();
    if (!chosen || chosen.rangeCount === 0) return null;
    const range = chosen.getRangeAt(0);
    return page.contains(range.commonAncestorContainer) ? range : null;
  }

  function select(range) {
    const chosen = selection();
    chosen.removeAllRanges();
    chosen.addRange(range);
  }

  /** the nearest thing around `node` that matches, if it is on the page and not held whole */
  function around(node, selector) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const found = el?.closest(selector);
    return found && found !== page && page.contains(found) ? found : null;
  }

  const unitAt = (node) => (around(node, "[data-md]") ? null : around(node, UNIT));

  /** which of the page's own pieces `node` is in */
  function pieceOf(node) {
    while (node && node.parentNode !== page) node = node.parentNode;
    return node || null;
  }

  /** puts the caret in `el`, at its end or its start; in something that cannot be typed in, in the paragraph after it */
  function placeIn(el, atEnd = true) {
    if (el.matches(SOLID) && !el.matches("pre")) {
      let next = el.nextElementSibling;
      if (!next || next.matches(SOLID)) {
        next = emptyParagraph();
        el.after(next);
      }
      return placeIn(next, false);
    }
    const units = el.matches(UNIT) ? [el] : [...el.querySelectorAll(UNIT)];
    const target = (atEnd ? units.at(-1) : units[0]) || el;
    const range = document.createRange();
    range.selectNodeContents(target);
    // a break that only holds an empty line open is not something to stand after
    if (atEnd && target.lastChild?.nodeName === "BR") range.setEndBefore(target.lastChild);
    range.collapse(!atEnd);
    page.focus({ preventScroll: true });
    select(range);
  }

  // a button takes the selection out of the page; this is where it was
  let lastRange = null;

  /** the selection in the page, put back if a button or a question took it away */
  function regain() {
    const here = caret();
    if (here) return here;
    page.focus({ preventScroll: true });
    if (lastRange && page.contains(lastRange.commonAncestorContainer)) {
      select(lastRange);
      return caret();
    }
    if (!page.lastElementChild) page.append(emptyParagraph());
    placeIn(page.lastElementChild);
    return caret();
  }

  /*
   * Moving things about on the page loses the selection, which a browser
   * keeps by the nodes it lies in. `keeping` remembers where it was and puts
   * it back; where a node was replaced by another, `moved` says by which.
   */
  const moved = new Map();

  function keeping(work) {
    const range = caret();
    const was = range && [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
    moved.clear();
    work();
    if (!was) return;
    const spot = (node, offset) => {
      const now = moved.get(node) || node;
      if (!page.contains(now) || now === page) return null;
      return [now, Math.min(offset, now.nodeType === 3 ? now.length : now.childNodes.length)];
    };
    const from = spot(was[0], was[1]);
    const to = spot(was[2], was[3]);
    if (from && to) selection().setBaseAndExtent(from[0], from[1], to[0], to[1]);
  }

  function retag(el, name) {
    const made = document.createElement(name);
    made.append(...el.childNodes);
    el.replaceWith(made);
    moved.set(el, made);
    return made;
  }

  /* ---------------------------------------------- noticing what changes */

  let syncer;

  function noticed(records) {
    let any = false;
    for (const record of records) {
      // the page's own attributes are how it is shown, not what it says
      if (record.target === page && record.type === "attributes") continue;
      any = true;
      const piece = record.target === page ? null : pieceOf(record.target);
      if (piece) kept.delete(piece);
    }
    if (!any) return;
    touched = true;
    clearTimeout(syncer);
    syncer = setTimeout(sync, 200);
  }

  const observer = new MutationObserver(noticed);
  // only the attributes that say something are watched: what a browser's own helpers add to a page is not writing
  const TELLING = ["href", "title", "src", "alt", "start", "checked", "data-md"];
  const watch = () =>
    observer.observe(page, { childList: true, characterData: true, attributes: true, attributeFilter: TELLING, subtree: true });
  /** changes are told of a moment after they are made; this hears of them now */
  const settle = () => noticed(observer.takeRecords());

  /** does something to the page that is not a change to what it says */
  function quietly(work) {
    settle();
    work();
    observer.takeRecords();
  }

  /* ----------------------------------------------- setting out, and back */

  /** makes the pieces the server set out, remembering for each what was written */
  function pieces({ blocks }, exact) {
    const made = [];
    const known = [];
    for (const part of blocks) {
      const found = [...make(part.html).children];
      if (found.length === 1) {
        kept.set(found[0], { src: part.src, gap: exact ? part.gap : null, next: null });
        known.push(found[0]);
      } else known.push(null);
      made.push(...found);
    }
    // the last line of a block of code ends as every line does; on the page that would look like one line more
    for (const el of made) {
      const code = el.nodeName === "PRE" ? el.querySelector("code") || el : null;
      const last = code?.lastChild;
      if (last?.nodeType === 3 && last.data.endsWith("\n")) last.data = last.data.slice(0, -1);
    }
    if (exact) {
      known.forEach((el, i) => {
        if (el && known[i + 1]) kept.get(el).next = known[i + 1];
      });
    }
    return made;
  }

  function setOut(answer) {
    quietly(() => {
      page.replaceChildren(...pieces(answer, true));
      defs = answer.defs || [];
      tidy();
    });
    settled = box.value;
    touched = false;
    past = [];
    at = -1;
    record();
    reflect();
  }

  let fetchingPage = 0;

  /** sets the page out from what is in the box; false if the server could not be asked */
  async function setOutFromBox() {
    const text = box.value;
    const turn = ++fetchingPage;
    if (!text.trim()) {
      setOut({ blocks: [], defs: [] });
      return true;
    }
    frame.classList.add("is-loading");
    try {
      const answer = await send("/blocks", { body: text }, "The page could not be set out.");
      // the box may have been filled again while the server was asked
      if (turn === fetchingPage && box.value === text) setOut(answer);
      return true;
    } catch (err) {
      say(`${err.message || "The page could not be set out."} The plain text is shown instead.`, true);
      return false;
    } finally {
      if (turn === fetchingPage) frame.classList.remove("is-loading");
    }
  }

  /** reads the page back into the box, each untouched piece exactly as it was written */
  function write() {
    if (settled === null) return;
    settle();
    if (!touched) return;
    const els = [...page.children];
    let out = "";
    let before = null; // what the list just written begins with, so that the next stays a list of its own
    els.forEach((el, i) => {
      let known = kept.get(el);
      if (known && before && M.marker(known.src.trimStart()) === before) known = null;
      if (known) {
        const next = els[i + 1];
        const whole = known.src + (known.gap || "");
        if (known.gap !== null && next && known.next === next && kept.has(next) && whole.endsWith("\n")) {
          out += whole;
          before = M.marker(known.src.trimStart());
          return;
        }
      }
      const md = (known ? known.src : STANDS_ALONE.test(el.nodeName) ? M.block(el, { avoid: before }) : M.blocks([el]).join("\n\n")).replace(
        /^\n+|\s+$/g,
        ""
      );
      if (!md) return;
      out += `${md}\n\n`;
      before = M.marker(md.trimStart());
    });
    out = out.replace(/\s+$/, "");
    if (defs.length > 0) out += `${out ? "\n\n" : ""}${defs.join("\n")}`;
    box.value = out;
    settled = out;
    touched = false;
  }

  function sync() {
    clearTimeout(syncer);
    if (view !== "page") return;
    write();
    changed();
  }

  /* ----------------------------------------------------- keeping it tidy */

  /** words with nothing around them become paragraphs, as do the divisions a browser makes */
  function paragraphs(within) {
    let run = null;
    for (const node of [...within.childNodes]) {
      if (node.nodeType === 3 && !node.data.trim() && !run) {
        node.remove();
      } else if (node.nodeType !== 1 || !STANDS_ALONE.test(node.nodeName)) {
        if (!run) {
          run = document.createElement("p");
          node.before(run);
        }
        run.append(node);
      } else {
        run = null;
        if (node.nodeName === "DIV" && !node.hasAttribute("data-md")) {
          if ([...node.children].some((child) => STANDS_ALONE.test(child.nodeName))) node.replaceWith(...node.childNodes);
          else retag(node, "p");
        } else if (node.nodeName === "LI") {
          const before = node.previousElementSibling;
          if (before?.nodeName === "UL" && !before.hasAttribute("data-md")) before.append(node);
          else {
            const list = document.createElement("ul");
            node.before(list);
            list.append(node);
          }
        }
      }
    }
  }

  function tidy() {
    keeping(() => {
      paragraphs(page);
      for (const quote of page.querySelectorAll("blockquote")) if (!quote.closest("[data-md]")) paragraphs(quote);
      // what a browser leaves behind when it joins two paragraphs, or brings in from elsewhere
      for (const el of page.querySelectorAll("[style], font, span")) {
        if (el.closest("[data-md]")) continue;
        if (el.nodeName === "SPAN" || el.nodeName === "FONT") el.replaceWith(...el.childNodes);
        else el.removeAttribute("style");
      }
      // there is always somewhere to write after whatever cannot be written in
      const last = page.lastElementChild;
      if (!last || last.matches(SOLID)) page.append(emptyParagraph());
    });
    // a place held open by nothing, once there is something beside it, is let go
    const range = caret();
    const node = range?.collapsed && range.startContainer.nodeType === 3 ? range.startContainer : null;
    if (node && node.data.length > 1 && node.data.includes("\u200b")) {
      const offset = range.startOffset - (node.data.slice(0, range.startOffset).split("\u200b").length - 1);
      node.data = node.data.replace(/\u200b/g, "");
      selection().collapse(node, Math.min(offset, node.length));
    }
    const only = page.children.length === 1 ? page.firstElementChild : null;
    page.classList.toggle("is-empty", Boolean(only && only.nodeName === "P" && isBlank(only)));
  }

  /* -------------------------------------------------- undoing and redoing */

  let past = [];
  let at = -1;
  let recorder;

  function pathOf(node) {
    const path = [];
    for (; node && node !== page; node = node.parentNode) path.unshift([...node.parentNode.childNodes].indexOf(node));
    return node ? path : null;
  }

  const nodeAt = (path) => path.reduce((node, index) => node?.childNodes[index], page);

  /** the page as it stands, with where the caret is */
  function shot() {
    settle();
    const range = caret();
    const before = at >= 0 ? past[at].parts : [];
    return {
      parts: [...page.children].map((el, i) => {
        const html = el.outerHTML;
        const known = kept.get(el) || null;
        // most of the page is as it was the last time: the same words are not kept twice
        return {
          html: before[i]?.html === html ? before[i].html : html,
          known,
          linked: Boolean(known?.next && known.next === el.nextElementSibling),
        };
      }),
      defs,
      at: range ? [pathOf(range.startContainer), range.startOffset, pathOf(range.endContainer), range.endOffset] : null,
    };
  }

  const sameParts = (a, b) => a.parts.length === b.parts.length && a.parts.every((part, i) => part.html === b.parts[i].html);

  /** remembers the page as it stands, if it is not as it was last remembered */
  function record() {
    clearTimeout(recorder);
    if (settled === null) return;
    const now = shot();
    if (at >= 0 && sameParts(past[at], now)) {
      past[at].at = now.at;
      return;
    }
    past = past.slice(Math.max(0, at - 150), at + 1);
    past.push(now);
    at = past.length - 1;
    reflect();
  }

  const recordSoon = () => {
    clearTimeout(recorder);
    recorder = setTimeout(record, 500);
  };

  function restore(state) {
    settle();
    const made = state.parts.map((part) => make(part.html).firstElementChild);
    made.forEach((el, i) => {
      const { known, linked } = state.parts[i];
      if (known) kept.set(el, { ...known, next: linked ? made[i + 1] : null });
    });
    page.replaceChildren(...made.filter((el) => !el.matches(".held--waiting")));
    defs = state.defs;
    page.focus({ preventScroll: true });
    if (state.at) {
      try {
        selection().setBaseAndExtent(nodeAt(state.at[0]), state.at[1], nodeAt(state.at[2]), state.at[3]);
      } catch {
        placeIn(page.lastElementChild);
      }
    }
    tidy();
    // what was remembered for each piece still holds; the page as a whole is not what the box has
    observer.takeRecords();
    touched = true;
    sync();
    reflect();
  }

  function undo() {
    record();
    if (at <= 0) return;
    at -= 1;
    restore(past[at]);
  }

  function redo() {
    record();
    if (at >= past.length - 1) return;
    at += 1;
    restore(past[at]);
  }

  /** something done to the page by a button or a key that is more than typing: one step to undo */
  function act(work) {
    record();
    work();
    tidy();
    record();
    sync();
    reflect();
  }

  /* ----------------------------------------- how a paragraph is set */

  /** the paragraphs, headings and items the selection touches */
  function units() {
    const range = caret();
    if (!range) return [];
    const edge = document.createRange();
    const found = [...page.querySelectorAll(UNIT)].filter((el) => {
      if (el.closest("[data-md]") || !range.intersectsNode(el)) return false;
      if (range.collapsed) return true;
      // a selection that only reaches the edge of something has not taken it in
      edge.selectNodeContents(el);
      return range.compareBoundaryPoints(Range.START_TO_END, edge) > 0 && range.compareBoundaryPoints(Range.END_TO_START, edge) < 0;
    });
    return found.filter((el) => {
      // an item speaks for the paragraphs in it, and the innermost item for those around it
      if (el.nodeName !== "LI") return !around(el, "li");
      return !found.some((other) => other !== el && other.nodeName === "LI" && el.contains(other));
    });
  }

  function kindOf(unit) {
    if (!unit) return "text";
    if (unit.nodeName === "LI") return unit.parentNode.nodeName === "OL" ? "numbered" : "list";
    if (around(unit, "li")) return around(unit, "li").parentNode.nodeName === "OL" ? "numbered" : "list";
    if (around(unit, "blockquote")) return "quote";
    if (unit.nodeName === "PRE") return "code";
    const level = /^H([1-6])$/.exec(unit.nodeName)?.[1];
    return !level ? "text" : level <= 2 ? "title" : level === "3" ? "heading" : "subheading";
  }

  const isList = (node) => node?.nodeType === 1 && (node.nodeName === "UL" || node.nodeName === "OL");
  const nested = (li) => li.parentNode.parentNode?.nodeName === "LI";

  /** one step out: an item under another comes to stand after it, and what followed it goes under it */
  function raise(li) {
    const list = li.parentNode;
    const above = list.parentNode;
    const after = [...list.children].slice([...list.children].indexOf(li) + 1);
    if (after.length > 0) {
      let own = [...li.children].find(isList);
      if (!own) {
        own = document.createElement(list.nodeName);
        li.append(own);
      }
      own.append(...after);
    }
    above.after(li);
    if (list.children.length === 0) list.remove();
  }

  /** one step in: an item goes under the one before it */
  function lower(li) {
    const before = li.previousElementSibling;
    if (!before || before.nodeName !== "LI") return;
    let under = before.lastElementChild;
    if (!isList(under)) {
      under = document.createElement(li.parentNode.nodeName);
      before.append(under);
    }
    under.append(li);
  }

  /** takes an item out of its list: it becomes a paragraph where it stood, and the list parts around it */
  function unlist(li) {
    while (nested(li)) raise(li);
    const list = li.parentNode;
    const index = [...list.children].indexOf(li);
    const after = [...list.children].slice(index + 1);
    if (after.length > 0) {
      const rest = document.createElement(list.nodeName);
      // a numbered list goes on counting from where it was parted
      if (list.nodeName === "OL") rest.start = (list.start || 1) + index + 1;
      rest.append(...after);
      list.after(rest);
    }
    const out = [];
    let p = null;
    for (const child of [...li.childNodes]) {
      if (child.nodeType === 1 && STANDS_ALONE.test(child.nodeName)) {
        p = null;
        out.push(child);
      } else {
        if (!p) {
          p = document.createElement("p");
          out.push(p);
        }
        p.append(child);
      }
    }
    if (out.length === 0) out.push(emptyParagraph());
    list.after(...out);
    moved.set(li, out[0]);
    li.remove();
    if (list.children.length === 0) list.remove();
    return out[0];
  }

  /** takes a paragraph out of the quotation it stands in, which parts around it */
  function unquote(el) {
    const quote = around(el, "blockquote");
    if (!quote) return el;
    let child = el;
    while (child.parentNode !== quote) child = child.parentNode;
    const after = [];
    for (let node = child.nextSibling; node; node = node.nextSibling) after.push(node);
    if (after.some((node) => node.nodeType === 1 || node.data.trim())) {
      const rest = document.createElement("blockquote");
      rest.append(...after);
      quote.after(rest);
    }
    quote.after(child);
    if (isBlank(quote)) quote.remove();
    return child;
  }

  const TAGS = { text: "P", title: "H2", heading: "H3", subheading: "H4" };

  /** sets the paragraphs the selection touches as `kind`; a list or a quotation chosen again is taken off */
  function setKind(kind) {
    const chosen = units();
    if (chosen.length === 0) return;
    if (kind === "quote") {
      if (chosen.every((el) => around(el, "blockquote"))) return chosen.forEach(unquote);
      const tops = [...new Set(chosen.map(pieceOf))];
      const all = [...page.children];
      const span = all.slice(all.indexOf(tops[0]), all.indexOf(tops.at(-1)) + 1);
      const quote = document.createElement("blockquote");
      span[0].before(quote);
      for (const el of span) {
        if (el.nodeName === "BLOCKQUOTE" && !el.hasAttribute("data-md")) {
          quote.append(...el.childNodes);
          el.remove();
        } else quote.append(el);
      }
      return;
    }
    if (kind === "list" || kind === "numbered") {
      const tag = kind === "list" ? "UL" : "OL";
      if (chosen.every((el) => el.nodeName === "LI" && el.parentNode.nodeName === tag)) return chosen.forEach(unlist);
      for (const el of chosen) {
        if (el.nodeName === "LI") {
          if (el.parentNode.nodeName !== tag) retag(el.parentNode, tag);
          continue;
        }
        const li = document.createElement("li");
        // a block of code brought into a list brings its words, not its box
        li.append(...(el.nodeName === "PRE" && el.firstElementChild?.nodeName === "CODE" ? el.firstElementChild : el).childNodes);
        const before = el.previousElementSibling;
        let list = before?.nodeName === tag && !before.hasAttribute("data-md") ? before : null;
        if (list) {
          list.append(li);
          el.remove();
        } else {
          list = document.createElement(tag);
          list.append(li);
          el.replaceWith(list);
        }
        moved.set(el, li);
        const next = list.nextElementSibling;
        if (next?.nodeName === tag && !next.hasAttribute("data-md")) {
          list.append(...next.childNodes);
          next.remove();
        }
      }
      return;
    }
    for (let el of chosen) {
      if (el.nodeName === "LI") el = unlist(el);
      el = unquote(el);
      if (!el.matches("p, h1, h2, h3, h4, h5, h6, pre") || el.nodeName === TAGS[kind]) continue;
      if (el.nodeName === "PRE" && el.firstElementChild?.nodeName === "CODE") el.firstElementChild.replaceWith(...el.firstElementChild.childNodes);
      retag(el, TAGS[kind]);
    }
  }

  const setOnPage = (kind) => () => {
    regain();
    act(() => keeping(() => setKind(kind)));
  };

  /** bold and italic are the browser's own, so that they can be set before the words are typed */
  const mark = (name) => () => {
    regain();
    record();
    document.execCommand(name);
    recordSoon();
  };

  /* -------------------------------------------------------- questions */

  const REMOVE = Symbol("remove");

  /**
   * Asks for a few things in a small window over the page. `fields` are what
   * to ask for: a line, an `area` of several, a `check` to tick, or a `pick`
   * from what `find(typed)` offers. `preview(values)` gives markup to show
   * beneath them as they change. Resolves to the values, to REMOVE, or to
   * null if it was put away.
   */
  function ask({ heading, note, fields = [], done = "Done", remove, preview }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "ask";
      const inner = document.createElement("form");
      inner.method = "dialog";
      inner.className = "ask__form";
      const head = document.createElement("h2");
      head.className = "ask__title";
      head.textContent = heading;
      inner.append(head);
      if (note) {
        const words = document.createElement("p");
        words.className = "hint";
        words.textContent = note;
        inner.append(words);
      }

      const controls = {};
      let result = null;
      const values = () =>
        Object.fromEntries(
          Object.entries(controls).map(([name, control]) => [name, control.type === "checkbox" ? control.checked : control.value])
        );

      fields.forEach((field, i) => {
        const id = `ask-${i}`;
        const label = document.createElement("label");
        label.htmlFor = id;
        const control = document.createElement(field.kind === "area" ? "textarea" : "input");
        control.id = id;
        controls[field.name] = control;
        if (field.kind === "check") {
          control.type = "checkbox";
          control.checked = Boolean(field.value);
          label.className = "ask__check";
          label.append(control, ` ${field.label}`);
          inner.append(label);
          return;
        }
        label.textContent = field.label;
        control.value = field.value || "";
        control.autocomplete = "off";
        if (field.placeholder) control.placeholder = field.placeholder;
        if (field.kind === "area") {
          control.rows = field.rows || 4;
          control.spellcheck = !field.typed;
          // Enter begins a new line here, so the keys that send the form are Ctrl or ⌘ with Enter
          control.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) inner.requestSubmit();
          });
        }
        if (field.typed) control.classList.add("ask__typed");
        inner.append(label, control);
        if (field.hint) {
          const hint = document.createElement("p");
          hint.className = "hint";
          hint.textContent = field.hint;
          inner.append(hint);
        }
        if (field.kind === "pick") {
          const found = document.createElement("ul");
          found.className = "ask__found";
          inner.append(found);
          const choose = (value) => {
            result = { ...values(), [field.name]: value };
            dialog.close();
          };
          const offer = async () => {
            const items = await field.find(control.value);
            found.replaceChildren(
              ...items.map((item) => {
                const row = document.createElement("li");
                const button = document.createElement("button");
                button.type = "button";
                button.className = "ask__choice";
                button.textContent = item;
                button.addEventListener("click", () => choose(item));
                row.append(button);
                return row;
              })
            );
            if (items.length === 0) {
              const none = document.createElement("li");
              none.className = "ask__none";
              none.textContent = field.none || "Nothing by that name.";
              found.append(none);
            }
          };
          control.addEventListener("input", offer);
          // Enter takes the first that is offered
          control.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            found.querySelector("button")?.click();
          });
          offer();
        }
      });

      if (preview) {
        const out = document.createElement("div");
        out.className = "ask__preview prose";
        out.setAttribute("aria-live", "polite");
        inner.append(out);
        let timer;
        let turn = 0;
        const show = async () => {
          const mine = ++turn;
          const html = await preview(values()).catch(() => "");
          // made by the server, which lets nothing through that could run
          if (mine === turn) out.innerHTML = html;
        };
        inner.addEventListener("input", () => {
          clearTimeout(timer);
          timer = setTimeout(show, 250);
        });
        show();
      }

      const actions = document.createElement("div");
      actions.className = "ask__actions";
      if (!fields.some((field) => field.kind === "pick")) {
        const ok = document.createElement("button");
        ok.className = "button";
        ok.textContent = done;
        actions.append(ok);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button button--quiet";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => dialog.close());
      actions.append(cancel);
      if (remove) {
        const gone = document.createElement("button");
        gone.type = "button";
        gone.className = "link link--danger ask__remove";
        gone.textContent = remove;
        gone.addEventListener("click", () => {
          result = REMOVE;
          dialog.close();
        });
        actions.append(gone);
      }
      inner.append(actions);
      inner.addEventListener("submit", () => {
        result = values();
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(result);
      });
      dialog.append(inner);
      document.body.append(dialog);
      dialog.showModal();
      const first = Object.values(controls)[0];
      if (first) {
        first.focus();
        if (first.select && first.type !== "checkbox") first.select();
      }
    });
  }

  /* ----------------------------------------- putting things on the page */

  /** puts something in the line where the caret is, and the caret after it */
  function putInLine(node) {
    const range = regain();
    if (!range.collapsed) range.deleteContents();
    // never inside something that is held whole
    const within = around(range.startContainer, "[data-md]");
    if (within) range.setStartAfter(within);
    range.collapse(true);
    range.insertNode(node);
    // a browser cannot stand after something that is not typed in unless there is a place to stand
    let after = node.nextSibling;
    if (!after || after.nodeType !== 3 || !after.data) {
      after = document.createTextNode("\u200b");
      node.after(after);
      selection().collapse(after, 1);
    } else selection().collapse(after, 0);
  }

  /** puts things that stand alone after where the caret is, or in place of the empty paragraph it is in */
  function putApart(els) {
    const range = regain();
    const piece = pieceOf(range.startContainer);
    if (piece && piece.nodeName === "P" && isBlank(piece)) piece.replaceWith(...els);
    else if (piece) piece.after(...els);
    else page.append(...els);
    placeIn(els.at(-1));
  }

  /** brings in what the server set out from a text: into the line if it is a few words, parting the paragraph if it is more */
  function bringIn(answer) {
    const els = pieces(answer, false);
    if (els.length === 0) return;
    if (answer.defs?.length > 0) defs = [...new Set([...defs, ...answer.defs])];
    const range = regain();
    const unit = unitAt(range.startContainer);
    const words = els.length === 1 && els[0].nodeName === "P" && !els[0].hasAttribute("data-md");
    if (words && unit && unit.nodeName !== "PRE") {
      const last = els[0].lastChild;
      if (!last) return;
      const line = document.createDocumentFragment();
      line.append(...els[0].childNodes);
      range.collapse(true);
      range.insertNode(line);
      if (last.nodeType === 1 && last.hasAttribute("data-md")) {
        // somewhere to stand after something that is not typed in
        const after = document.createTextNode("\u200b");
        last.after(after);
        selection().collapse(after, 1);
      } else {
        const end = document.createRange();
        end.setStartAfter(last);
        end.collapse(true);
        select(end);
      }
      return;
    }
    if (unit && unit.parentNode === page && /^(P|H[1-6])$/.test(unit.nodeName)) {
      const tail = document.createRange();
      tail.selectNodeContents(unit);
      tail.setStart(range.startContainer, range.startOffset);
      const after = document.createElement(unit.nodeName);
      after.append(tail.extractContents());
      unit.after(...els, after);
      if (isBlank(unit)) unit.remove();
      if (isBlank(after)) after.remove();
    } else {
      const piece = pieceOf(range.startContainer);
      if (piece) piece.after(...els);
      else page.append(...els);
    }
    placeIn(els.at(-1));
  }

  /** a text typed or pasted as marks, set out by the server and brought in where the caret is */
  async function bringText(text) {
    try {
      const answer = await send("/blocks", { body: text }, "That could not be brought in.");
      if (!caret()?.collapsed && caret()) document.execCommand("delete");
      act(() => bringIn(answer));
    } catch (err) {
      say(err.message || "That could not be brought in.", true);
    }
  }

  /** one thing held whole, made by the server from what is written for it; null if it did not come out as one */
  async function heldFrom(md, inLine) {
    const answer = await send("/blocks", { body: md }, "That could not be set out.");
    const made = pieces(answer, false);
    if (made.length !== 1) return null;
    if (!inLine) return made[0].hasAttribute("data-md") ? made[0] : null;
    const only = made[0].nodeName === "P" && made[0].childNodes.length === 1 ? made[0].firstChild : null;
    return only?.nodeType === 1 && only.hasAttribute("data-md") ? only : null;
  }

  /** swaps something held for what it has become, in the line or standing alone as each is */
  function swapHeld(old, made) {
    const wasLine = old.nodeName === "SPAN";
    const isLine = made.nodeName === "SPAN";
    if (wasLine === isLine) return old.replaceWith(made);
    if (isLine) {
      const p = document.createElement("p");
      p.append(made);
      return old.replaceWith(p);
    }
    // out of the line: it stands after the paragraph it was in
    (pieceOf(old) || old).after(made);
    old.remove();
  }

  /* links */

  const leadsSomewhere = (href) => /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href);

  async function linkOnPage() {
    const range = regain().cloneRange();
    const existing = around(range.startContainer, "a[href]");
    const chosen = existing ? existing.textContent : range.toString();
    const answer = await ask({
      heading: existing ? "Change this link" : "Link to a web page",
      fields: [
        { name: "words", label: "Words to show", value: chosen.replace(/\s+/g, " ").trim() },
        { name: "href", label: "Web address", value: existing?.getAttribute("href") || "", placeholder: "https://" },
      ],
      remove: existing && "Remove the link",
    });
    page.focus({ preventScroll: true });
    select(range);
    if (!answer) return;
    if (answer === REMOVE) return act(() => keeping(() => existing.replaceWith(...existing.childNodes)));
    let href = answer.href.trim();
    if (!href) return;
    if (!leadsSomewhere(href)) href = (/^[^\s/@]+@[^\s/@]+$/.test(href) ? "mailto:" : "https://") + href.replace(/^\/+/, "");
    const words = answer.words.trim() || href;
    if (existing) {
      return act(() => {
        existing.setAttribute("href", href);
        if (words !== existing.textContent.replace(/\s+/g, " ").trim()) existing.textContent = words;
      });
    }
    if (!range.collapsed && words === chosen.replace(/\s+/g, " ").trim()) {
      // the words keep whatever marks they had
      record();
      document.execCommand("createLink", false, href);
      return recordSoon();
    }
    if (!range.collapsed) document.execCommand("delete");
    act(() => {
      const a = document.createElement("a");
      a.setAttribute("href", href);
      a.textContent = words;
      putInLine(a);
    });
  }

  /* members and articles */

  const nothingKnown = { people: [], articles: [] };
  let known;
  const names = () =>
    (known ||= fetch("/suggest.json", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : nothingKnown))
      .catch(() => nothingKnown));

  function held(kind, md, inner) {
    const span = document.createElement("span");
    span.className = `held held--${kind}`;
    span.contentEditable = "false";
    span.dataset.md = md;
    span.append(inner);
    return span;
  }

  function articleHeld(name, words = "") {
    const a = document.createElement("a");
    a.className = "wikilink";
    a.textContent = words || name;
    return held("article", words && words !== name ? `[[${name}|${words}]]` : `[[${name}]]`, a);
  }

  function memberHeld({ username, name }) {
    const a = document.createElement("a");
    a.className = "mention";
    a.textContent = `@${name}`;
    return held("member", `@${username}`, a);
  }

  const nameable = (name) => !/[[\]|]/.test(name);

  async function articleOnPage() {
    const range = regain().cloneRange();
    const words = range.toString().replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim();
    const answer = await ask({
      heading: "Link to another article here",
      note: words ? `“${words}” will lead to the article you choose.` : "",
      fields: [
        {
          name: "article",
          kind: "pick",
          label: "Find it by its title",
          none: "No article has those words in its title.",
          find: async (typed) => {
            const q = typed.trim().toLowerCase();
            return (await names()).articles.filter((name) => nameable(name) && name.toLowerCase().includes(q)).slice(0, 8);
          },
        },
      ],
    });
    page.focus({ preventScroll: true });
    select(range);
    if (!answer?.article) return;
    act(() => putInLine(articleHeld(answer.article, words)));
  }

  /* formulas, diagrams, pictures and whatever else is held whole */

  const setApart = (tex) => `$$\n${tex.trim()}\n$$`;
  const inTheLine = (tex) => `$${tex.trim().replace(/\s*\n\s*/g, " ")}$`;

  async function formulaOnPage(existing) {
    const range = regain().cloneRange();
    let tex = "";
    let alone;
    if (existing) {
      const md = existing.dataset.md.trim();
      const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(md);
      tex = fence ? fence[2] : md.replace(/^\${1,2}|\${1,2}$/g, "").trim();
      alone = existing.nodeName !== "SPAN";
    } else {
      tex = range.toString().trim();
      const piece = pieceOf(range.startContainer);
      alone = !tex && Boolean(piece) && piece.nodeName === "P" && isBlank(piece);
    }
    const answer = await ask({
      heading: "Formula",
      note: "Formulas are written in LaTeX. It is shown below as it will look.",
      fields: [
        { name: "tex", kind: "area", label: "The formula", value: tex, typed: true, rows: 3, placeholder: FORMULA },
        { name: "alone", kind: "check", label: "Set it apart, on a line of its own", value: alone },
      ],
      preview: async (v) => {
        if (!v.tex.trim()) return "";
        const { blocks } = await send("/blocks", { body: v.alone ? setApart(v.tex) : inTheLine(v.tex) });
        return blocks.map((part) => part.html).join("");
      },
      remove: existing && "Remove the formula",
    });
    page.focus({ preventScroll: true });
    select(range);
    if (!answer) return;
    if (answer === REMOVE) return act(() => existing.remove());
    if (!answer.tex.trim()) return;
    try {
      let made = await heldFrom(answer.alone ? setApart(answer.tex) : inTheLine(answer.tex), !answer.alone);
      // what cannot stand in a line of words can still stand by itself
      if (!made && !answer.alone) made = await heldFrom(setApart(answer.tex), false);
      if (!made) return say("That could not be read as a formula.", true);
      act(() => {
        if (existing?.isConnected) swapHeld(existing, made);
        else if (made.nodeName === "SPAN") putInLine(made);
        else putApart([made]);
      });
    } catch (err) {
      say(err.message || "The formula could not be set.", true);
    }
  }

  async function diagramOnPage(existing) {
    const range = regain().cloneRange();
    const found = existing && /^(`{3,}|~{3,}) *(\S*)([^\n]*)\n([\s\S]*?)\n?\1$/.exec(existing.dataset.md.trim());
    if (existing && !found) return sourceOnPage(existing);
    const answer = await ask({
      heading: "Diagram",
      note: "A diagram is drawn from LaTeX, with TikZ. This one is an example to change.",
      fields: [
        { name: "source", kind: "area", label: "What to draw", value: found ? found[4] : DIAGRAM, typed: true, rows: 9 },
        { name: "words", label: "Caption, if wanted", value: found ? found[3].trim() : "" },
      ],
      done: "Draw it",
      remove: existing && "Remove the diagram",
    });
    page.focus({ preventScroll: true });
    select(range);
    if (!answer) return;
    if (answer === REMOVE) return act(() => existing.remove());
    if (!answer.source.trim()) return;
    say("Drawing the diagram…");
    try {
      const fence = found ? found[1] : "```";
      const kind = found?.[2] || "tikz";
      const words = answer.words.replace(/\s+/g, " ").trim();
      const made = await heldFrom(`${fence}${kind}${words ? ` ${words}` : ""}\n${answer.source.replace(/\s+$/, "")}\n${fence}`, false);
      if (!made) return say("That could not be read as a diagram.", true);
      say("");
      act(() => (existing?.isConnected ? swapHeld(existing, made) : putApart([made])));
    } catch (err) {
      say(err.message || "The diagram could not be drawn.", true);
    }
  }

  const escaped = (text) => text.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&");
  const PICTURE = /^!\[((?:\\.|[^\]\\])*)\]\((<[^>\n]*>|[^\s)]+)(?:\s+"((?:\\.|[^"\\])*)")?\)$/;

  function pictureHeld(src, alt, words) {
    const figure = document.createElement("figure");
    figure.className = "figure";
    const img = document.createElement("img");
    img.src = src.replace(/^<|>$/g, "");
    img.alt = alt;
    figure.append(img);
    if (words) {
      const under = document.createElement("figcaption");
      under.textContent = words;
      figure.append(under);
    }
    const div = document.createElement("div");
    div.className = "held held--picture";
    div.contentEditable = "false";
    div.dataset.md = `![${escaped(alt)}](${src}${words ? ` "${words.replace(/\s+/g, " ").trim().replace(/"/g, '\\"')}"` : ""})`;
    div.append(figure);
    return div;
  }

  async function pictureOnPage(existing) {
    const found = PICTURE.exec(existing.dataset.md.trim());
    if (!found || existing.nodeName === "SPAN") return sourceOnPage(existing);
    const plain = (text = "") => text.replace(/\\(.)/g, "$1");
    const answer = await ask({
      heading: "Picture",
      fields: [
        {
          name: "alt",
          label: "What it shows",
          value: plain(found[1]),
          hint: "Read out to whoever cannot see the picture, and shown if it does not load.",
        },
        { name: "words", label: "Caption, if wanted", value: plain(found[3]) },
      ],
      remove: "Remove the picture",
    });
    page.focus({ preventScroll: true });
    if (!answer || !existing.isConnected) return;
    if (answer === REMOVE) return act(() => existing.remove());
    act(() => existing.replaceWith(pictureHeld(found[2], answer.alt, answer.words.trim())));
  }

  /** anything else that is held whole is changed where it was written */
  async function sourceOnPage(existing) {
    const table = existing.classList.contains("held--table");
    const answer = await ask({
      heading: table ? "Table" : "As it is written",
      note: table
        ? "A table is written as plain text: a line for each row, a | between the columns, and a line of dashes under the headings."
        : "This part of the text is kept just as it was written.",
      fields: [{ name: "md", kind: "area", label: "As plain text", value: existing.dataset.md, typed: true, rows: 8 }],
      remove: "Remove it",
    });
    page.focus({ preventScroll: true });
    if (!answer || !existing.isConnected) return;
    if (answer === REMOVE) return act(() => existing.remove());
    if (!answer.md.trim() || answer.md === existing.dataset.md) return;
    try {
      const made = pieces(await send("/blocks", { body: answer.md }, "That could not be set out."), false);
      if (made.length === 0) return;
      act(() => {
        if (existing.nodeName === "SPAN" && made.length === 1 && made[0].nodeName === "P") existing.replaceWith(...made[0].childNodes);
        else if (existing.nodeName === "SPAN") {
          (pieceOf(existing) || existing).after(...made);
          existing.remove();
        } else existing.replaceWith(...made);
      });
    } catch (err) {
      say(err.message || "That could not be set out.", true);
    }
  }

  const OPENS = { formula: formulaOnPage, diagram: diagramOnPage, picture: pictureOnPage, table: sourceOnPage, source: sourceOnPage };

  page.addEventListener("click", (event) => {
    // a link on the page is there to be written, not followed
    if (event.target.closest("a")) event.preventDefault();
    const found = around(event.target, "[data-md]");
    if (!found) return;
    const kind = /held--(\w+)/.exec(found.className)?.[1];
    if (!OPENS[kind]) return;
    event.preventDefault();
    lastRange = null;
    placeIn(pieceOf(found) || found);
    OPENS[kind](found);
  });

  // pressing between two things that cannot be written in makes a paragraph there to write in
  page.addEventListener("mousedown", (event) => {
    if (event.target !== page || settled === null) return;
    const els = [...page.children];
    const after = els.find((el) => el.getBoundingClientRect().top >= event.clientY) || null;
    const before = after ? after.previousElementSibling : els.at(-1) || null;
    if ((before && !before.matches(SOLID)) || (after && !after.matches(SOLID))) return;
    event.preventDefault();
    act(() => {
      const p = emptyParagraph();
      if (after) after.before(p);
      else page.append(p);
      placeIn(p, false);
    });
  });

  const ON_PAGE = {
    undo,
    redo,
    bold: mark("bold"),
    italic: mark("italic"),
    text: setOnPage("text"),
    title: setOnPage("title"),
    heading: setOnPage("heading"),
    subheading: setOnPage("subheading"),
    quote: setOnPage("quote"),
    list: setOnPage("list"),
    numbered: setOnPage("numbered"),
    link: linkOnPage,
    article: articleOnPage,
    picture: () => picker.click(),
    formula: () => formulaOnPage(),
    diagram: () => diagramOnPage(),
  };

  /* --------------------------------------------------- names, as typed */

  /*
   * Typing "@" offers the members and "[[" the articles, as in the plain
   * text; choosing one puts the tag or the link on the page.
   */
  const offered = document.createElement("ul");
  offered.className = "suggest";
  offered.id = "suggest-page";
  offered.setAttribute("role", "listbox");
  offered.hidden = true;
  document.body.append(offered);
  offered.addEventListener("pointerdown", (event) => event.preventDefault());
  let offer = null; // { node, start, end, kind, items, index } while the list is showing

  function pending() {
    const range = caret();
    if (!range?.collapsed || range.startContainer.nodeType !== 3) return null;
    const node = range.startContainer;
    if (around(node, "pre, code, [data-md]")) return null;
    const before = node.data.slice(0, range.startOffset);
    const end = range.startOffset;
    const name = /(?:^|[^A-Za-z0-9._@-])@([A-Za-z0-9._-]{0,32})$/.exec(before);
    if (name) return { kind: "people", query: name[1], node, start: end - name[1].length - 1, end };
    const article = /\[\[([^[\]|\n]{0,80})$/.exec(before);
    if (article) return { kind: "articles", query: article[1], node, start: end - article[1].length - 2, end };
    return null;
  }

  function matching(data, { kind, query }) {
    const q = query.trim().toLowerCase();
    if (kind === "people") {
      return data.people
        .filter(({ username, name }) => [username, name, ...name.split(/\s+/)].some((word) => word.toLowerCase().startsWith(q)))
        .slice(0, 6)
        .map((person) => ({ label: person.name, aside: `@${person.username}`, make: () => memberHeld(person) }));
    }
    return data.articles
      .filter((name) => nameable(name) && name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((name) => ({ label: name, aside: "", make: () => articleHeld(name) }));
  }

  function closeOffer() {
    if (!offer) return;
    offered.hidden = true;
    page.removeAttribute("aria-activedescendant");
    offer = null;
  }

  function pick(index) {
    offer.index = index;
    [...offered.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
    page.setAttribute("aria-activedescendant", `suggest-page-${index}`);
  }

  function choose(index) {
    const { node, start, items, kind } = offer;
    const here = caret();
    const end = here && here.startContainer === node ? here.startOffset : offer.end;
    closeOffer();
    if (!node.isConnected) return;
    act(() => {
      const typed = document.createRange();
      typed.setStart(node, Math.min(start, node.length));
      // a title chosen before closing brackets already typed takes their place
      typed.setEnd(node, Math.min(end + (kind === "articles" && node.data.startsWith("]]", end) ? 2 : 0), node.length));
      typed.deleteContents();
      select(typed);
      putInLine(items[index].make());
      if (kind === "people") document.execCommand("insertText", false, " ");
    });
  }

  async function offerNames() {
    if (!pending()) return closeOffer();
    const data = await names();
    const typing = document.activeElement === page && pending();
    const items = typing ? matching(data, typing) : [];
    if (items.length === 0) return closeOffer();
    offered.replaceChildren(
      ...items.map((item, i) => {
        const row = document.createElement("li");
        row.id = `suggest-page-${i}`;
        row.setAttribute("role", "option");
        row.textContent = item.label;
        if (item.aside) {
          const aside = document.createElement("small");
          aside.textContent = item.aside;
          row.append(aside);
        }
        row.addEventListener("click", () => choose(i));
        return row;
      })
    );
    offer = { ...typing, items, index: 0 };
    offered.hidden = false;
    pick(0);
    const mark = document.createRange();
    mark.setStart(typing.node, typing.start);
    mark.setEnd(typing.node, typing.end);
    const rect = mark.getBoundingClientRect();
    const most = window.scrollX + document.documentElement.clientWidth - offered.offsetWidth - 8;
    offered.style.left = `${Math.max(window.scrollX + 8, Math.min(window.scrollX + rect.left, most))}px`;
    offered.style.top = `${window.scrollY + rect.bottom + 6}px`;
  }

  page.addEventListener("blur", closeOffer);

  /* ----------------------------------------- marks typed out of habit */

  const SHORTHAND = { "#": "title", "##": "heading", "###": "subheading", "-": "list", "*": "list", "+": "list", ">": "quote" };
  const TYPED = [
    [/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "b"],
    [/(?<![*\w\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "i"],
    [/(?<![_\w\\])_([^_\s](?:[^_]*[^_\s])?)_$/, "i"],
    [/(?<!\\)`([^`]+)`$/, "code"],
  ];

  /**
   * Whoever is used to typing the marks can go on typing them. At the start
   * of a paragraph, "# ", "- ", "1. " and "> " make it a heading, a list or a
   * quotation; in the line, **bold**, *italic*, `code`, $a formula$ and
   * [[An Article]] become what they say as their last mark is typed. Undoing
   * gives back the marks as they were typed.
   */
  function shorthand() {
    const range = caret();
    if (!range?.collapsed || range.startContainer.nodeType !== 3) return;
    const node = range.startContainer;
    if (around(node, "pre, code, [data-md]")) return;
    const unit = unitAt(node);
    if (!unit) return;
    const end = range.startOffset;
    const before = node.data.slice(0, end);

    if (unit.nodeName === "P" && /[ \u00a0]$/.test(before)) {
      const lead = document.createRange();
      lead.selectNodeContents(unit);
      lead.setEnd(node, end);
      const typed = lead.toString().replace(/\u00a0/g, " ");
      const found = /^(#{1,3}|[-*+>]|\d{1,9}[.)]) $/.exec(typed);
      const kind = found && (SHORTHAND[found[1]] || "numbered");
      const there = kind && (kind === "quote" ? around(unit, "blockquote") : around(unit, "li"));
      if (kind && !there) {
        act(() => {
          lead.deleteContents();
          if (isBlank(unit) && !unit.querySelector("br")) unit.append(document.createElement("br"));
          selection().collapse(unit, 0);
          keeping(() => setKind(kind));
          const started = kind === "numbered" && Number.parseInt(found[1], 10);
          const list = started > 1 && around(caret().startContainer, "ol");
          if (list && list.children.length === 1) list.start = started;
        });
        return;
      }
    }

    const within = (from, make) => {
      act(() => {
        const typed = document.createRange();
        typed.setStart(node, from);
        typed.setEnd(node, end);
        typed.deleteContents();
        select(typed);
        putInLine(make());
      });
    };
    for (const [pattern, tag] of TYPED) {
      const found = pattern.exec(before);
      if (!found) continue;
      return within(found.index, () => {
        const el = document.createElement(tag);
        el.textContent = found[1];
        return el;
      });
    }
    const article = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]$/.exec(before);
    if (article) return within(article.index, () => articleHeld(article[1].replace(/\s+/g, " ").trim(), article[2]?.trim()));
    const formula = /(?<![\\$\w])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/.exec(before);
    if (formula && !/^[\d.,\s]+$/.test(formula[1])) {
      const md = formula[0];
      const waiting = held("formula", md, md);
      within(formula.index, () => waiting);
      heldFrom(md, true)
        .then((made) => {
          if (made && waiting.isConnected) waiting.replaceWith(made);
        })
        .catch(() => {});
    }
  }

  /* ------------------------------------------------------------ the keys */

  /** whether there is nothing between the start of `unit` and the caret, or between the caret and its end */
  function atEdge(unit, range, start) {
    const probe = document.createRange();
    probe.selectNodeContents(unit);
    if (start) probe.setEnd(range.startContainer, range.startOffset);
    else probe.setStart(range.endContainer, range.endOffset);
    const part = probe.cloneContents();
    return !part.textContent.replace(/\u200b/g, "") && !part.querySelector(start ? "[data-md], img, input, br" : "[data-md], img, input");
  }

  function enter(event, range) {
    const unit = unitAt(range.startContainer);
    if (!unit) return;
    const stop = (work) => {
      event.preventDefault();
      act(work);
    };
    if (unit.nodeName === "PRE") {
      event.preventDefault();
      const code = unit.querySelector("code") || unit;
      const probe = document.createRange();
      probe.selectNodeContents(unit);
      probe.setEnd(range.startContainer, range.startOffset);
      const above = probe.toString();
      probe.selectNodeContents(unit);
      probe.setStart(range.endContainer, range.endOffset);
      const below = probe.toString();
      // Enter on an empty line at the end of the code leaves it
      if (range.collapsed && /^\n?$/.test(below) && above.endsWith("\n") && above.trim()) {
        return act(() => {
          for (let last = code.lastChild; last; last = code.lastChild) {
            if (last.nodeType === 3) last.data = last.data.replace(/\s+$/, "");
            if (last.nodeType === 3 && last.data) break;
            if (last.nodeType === 1 && last.nodeName !== "BR") break;
            last.remove();
          }
          // the paragraph that is kept after a block of code, if it is still empty, is where to go
          const after = unit.nextElementSibling;
          const p = after?.nodeName === "P" && isBlank(after) ? after : emptyParagraph();
          if (p !== after) unit.after(p);
          placeIn(p, false);
        });
      }
      return act(() => {
        range.deleteContents();
        // the last line needs its ending to be shown as a line at all
        const line = document.createTextNode(below ? "\n" : "\n\n");
        range.insertNode(line);
        selection().collapse(line, 1);
      });
    }
    if (!range.collapsed) return;
    if (unit.nodeName === "LI") {
      // Enter on an empty item ends the list there, or steps out of the list it is under
      if (!isBlank(unit) || unit.querySelector("li")) return;
      return stop(() => keeping(() => (nested(unit) ? raise(unit) : unlist(unit))));
    }
    if (/^H[1-6]$/.test(unit.nodeName)) {
      // after a heading comes a paragraph, not another heading
      if (!atEdge(unit, range, false)) return;
      return stop(() => {
        const p = emptyParagraph();
        unit.after(p);
        placeIn(p, false);
      });
    }
    if (unit.nodeName !== "P") return;
    const words = unit.textContent.replace(/\u200b/g, "").trim();
    if (unit.parentNode === page && /^(-{3,}|\*{3,}|_{3,})$/.test(words)) {
      return stop(() => {
        const p = emptyParagraph();
        unit.replaceWith(document.createElement("hr"), p);
        placeIn(p, false);
      });
    }
    const fence = /^(?:```|~~~)([\w+-]*)$/.exec(words);
    if (fence) {
      return stop(() => {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (fence[1]) code.className = `language-${fence[1]}`;
        code.append("\n");
        pre.append(code);
        unit.replaceWith(pre);
        selection().collapse(code.firstChild, 0);
      });
    }
    const quote = unit.parentNode.nodeName === "BLOCKQUOTE" ? unit.parentNode : null;
    if (quote && isBlank(unit) && !unit.nextElementSibling) {
      // Enter on an empty line at the end of a quotation leaves it
      return stop(() => {
        quote.after(unit);
        if (isBlank(quote)) quote.remove();
        placeIn(unit, false);
      });
    }
  }

  function backspace(event, range) {
    const unit = unitAt(range.startContainer);
    if (!range.collapsed || !unit || !atEdge(unit, range, true)) return;
    const stop = (work) => {
      event.preventDefault();
      act(() => keeping(work));
    };
    // at the start of something, Backspace first takes off what it is set as
    if (unit.nodeName === "LI") return stop(() => (nested(unit) ? raise(unit) : unlist(unit)));
    if (/^H[1-6]$/.test(unit.nodeName)) return stop(() => retag(unit, "p"));
    if (unit.parentNode.nodeName === "BLOCKQUOTE" && !unit.previousElementSibling) return stop(() => unquote(unit));
    const before = unit.parentNode === page ? unit.previousElementSibling : null;
    if (before?.matches("[data-md], hr")) return stop(() => before.remove());
  }

  function forwardDelete(event, range) {
    const unit = unitAt(range.startContainer);
    if (!range.collapsed || !unit || unit.parentNode !== page || !atEdge(unit, range, false)) return;
    const after = unit.nextElementSibling;
    if (!after?.matches("[data-md], hr")) return;
    event.preventDefault();
    act(() => after.remove());
  }

  page.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (offer) {
      const last = offer.items.length - 1;
      if (event.key === "ArrowDown") pick(offer.index === last ? 0 : offer.index + 1);
      else if (event.key === "ArrowUp") pick(offer.index === 0 ? last : offer.index - 1);
      else if (event.key === "Enter" || event.key === "Tab") choose(offer.index);
      else if (event.key === "Escape") closeOffer();
      if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return event.preventDefault();
    }
    const range = caret();
    if (!range) return;
    const command = (mac ? event.metaKey : event.ctrlKey) && !event.altKey;
    const letter = event.key.toLowerCase();
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (command && letter === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (command && !event.shiftKey && letter === "y") {
      event.preventDefault();
      redo();
    } else if (command && !event.shiftKey && { b: "bold", i: "italic", k: "link" }[letter]) {
      event.preventDefault();
      ON_PAGE[{ b: "bold", i: "italic", k: "link" }[letter]]();
    } else if (event.key === "Enter" && bare && !event.shiftKey) {
      enter(event, range);
    } else if (event.key === "Tab" && bare) {
      // Tab in a list sets an item under the one above; with Shift, back out again
      const items = units().filter((el) => el.nodeName === "LI");
      if (items.length === 0) return;
      event.preventDefault();
      act(() => keeping(() => items.forEach((li) => (event.shiftKey ? nested(li) && raise(li) : lower(li)))));
    } else if (event.key === "Backspace" && bare && !event.shiftKey) {
      backspace(event, range);
    } else if (event.key === "Delete" && bare && !event.shiftKey) {
      forwardDelete(event, range);
    }
  });

  page.addEventListener("beforeinput", (event) => {
    // undoing from a menu, or by shaking a phone, is this page's to do
    if (event.inputType === "historyUndo") {
      event.preventDefault();
      undo();
    } else if (event.inputType === "historyRedo") {
      event.preventDefault();
      redo();
    }
  });

  page.addEventListener("input", (event) => {
    // while a letter is still being composed the page is the keyboard's
    if (event.isComposing) return;
    tidy();
    if (event.inputType === "insertText") shorthand();
    offerNames();
    recordSoon();
  });
  page.addEventListener("compositionend", () => {
    tidy();
    recordSoon();
  });
  page.addEventListener("click", offerNames);
  // the box is kept in step a moment after each change; leaving the page, it is brought up to date at once
  page.addEventListener("blur", () => sync());

  /** whether a text is only a few plain words, with nothing in it that the text reads as a mark */
  const fewWords = (text) => !/\n/.test(text.trim()) && !/[*_`[\]$#>|~\\<&]|^\s*(?:[-+]|\d+[.)])\s|https?:\/\/|www\./.test(text);

  page.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    if (data.files.length > 0 && take(data.files)) return event.preventDefault();
    const range = caret();
    if (!range) return;
    event.preventDefault();
    const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
    if (around(range.startContainer, "pre")) {
      record();
      document.execCommand("insertText", false, text);
      return recordSoon();
    }
    // a web address pasted over selected words makes a link of them
    const address = text.trim();
    if (/^https?:\/\/\S+$/.test(address) && !range.collapsed && range.toString().trim() && !around(range.startContainer, "a")) {
      record();
      document.execCommand("createLink", false, address);
      return recordSoon();
    }
    // what was copied with its headings and its bold is read as the marks that say the same
    const rich = data.getData("text/html");
    const md = rich
      ? M.blocks(new DOMParser().parseFromString(rich, "text/html").body.childNodes, { pasted: true }).join("\n\n")
      : text;
    if (!md.trim()) return;
    if (fewWords(md)) {
      record();
      document.execCommand("insertText", false, md.replace(/\s+/g, " "));
      return recordSoon();
    }
    bringText(md);
  });

  /* ============================================================ pictures */

  let uploads = 0;
  const most = Number(picker.dataset.most) || Infinity;

  const called = (file) =>
    file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[[\]()_-]+/g, " ")
      .trim() || "Picture";

  /** sends a picture to be kept, and answers with where it can be had from */
  async function sent(file) {
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
    return answer.url;
  }

  async function uploadToText(file) {
    const name = called(file);
    // a line stands in for the picture while it is on its way
    const token = `![Uploading ${name}… ${++uploads}]()`;
    apart(token);
    try {
      swap(token, `![${name}](${await sent(file)})`);
      say("Picture added. The words in the square brackets say what it shows; change them to suit.");
    } catch (err) {
      // the line goes, and with it the blank line that was put after it
      swap(box.value.includes(`${token}\n\n`) ? `${token}\n\n` : token, "");
      say(err.message || "The picture could not be uploaded.", true);
    }
  }

  async function uploadToPage(file) {
    const name = called(file);
    // a line stands in for the picture while it is on its way; it is not part of what is written
    const waiting = document.createElement("div");
    waiting.className = "held held--waiting";
    waiting.contentEditable = "false";
    waiting.dataset.md = "";
    waiting.textContent = `Uploading ${name}…`;
    regain();
    quietly(() => putApart([waiting]));
    try {
      const made = pictureHeld(await sent(file), name, "");
      act(() => {
        if (waiting.isConnected) waiting.replaceWith(made);
        else putApart([made]);
        placeIn(made);
      });
      say("Picture added. Press it to say what it shows, or to give it a caption.");
    } catch (err) {
      quietly(() => waiting.remove());
      say(err.message || "The picture could not be uploaded.", true);
    }
  }

  function take(files) {
    const pictures = [...files].filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0 && files.length > 0) say("Only pictures can be put in the text this way.", true);
    for (const picture of pictures) {
      // said here, before any of it is sent: the server would refuse it only after a long wait
      if (picture.size > most) say(`A picture can be up to ${Math.round(most / 1024 / 1024)} MB; “${picture.name}” is larger.`, true);
      else if (view === "page") uploadToPage(picture);
      else uploadToText(picture);
    }
    return pictures.length > 0;
  }

  picker.addEventListener("change", () => {
    take(picker.files);
    picker.value = "";
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

  /* ======================================================== the buttons */

  const KINDS = {
    text: "Normal text",
    title: "Large heading",
    heading: "Heading",
    subheading: "Small heading",
    quote: "Quotation",
    list: "List",
    numbered: "Numbered list",
    code: "Code",
  };
  const VIEWS = { page: "Page", write: "Plain text", preview: "Preview", both: "Side by side" };

  /** shows on the buttons how things stand where the caret is */
  function reflect() {
    const onPage = view === "page";
    const range = onPage ? caret() : null;
    const unit = range && unitAt(range.startContainer);
    const kind = onPage ? kindOf(unit) : null;
    styleName.textContent = onPage ? KINDS[kind] : "Text style";
    for (const item of bar.querySelectorAll("[data-style]")) item.setAttribute("aria-checked", String(item.dataset.style === kind));
    const pressed = {
      list: kind === "list",
      numbered: kind === "numbered",
      quote: Boolean(unit && around(unit, "blockquote")),
    };
    for (const button of bar.querySelectorAll(".tool--pictured[aria-pressed]")) {
      button.setAttribute("aria-pressed", String(Boolean(pressed[button.dataset.do])));
    }
    for (const name of ["bold", "italic"]) {
      let on = false;
      try {
        on = Boolean(range) && document.queryCommandState(name);
      } catch {
        on = false;
      }
      bar.querySelector(`[data-do="${name}"]`).setAttribute("aria-pressed", String(on));
    }
    const still = view === "preview";
    bar.querySelector('[data-do="undo"]').disabled = still || (onPage && at <= 0);
    bar.querySelector('[data-do="redo"]').disabled = still || (onPage && at >= past.length - 1);
  }

  document.addEventListener("selectionchange", () => {
    const range = caret();
    if (!range) return;
    lastRange = range.cloneRange();
    reflect();
  });

  const menus = [...bar.querySelectorAll("[data-opens]")].map((button) => ({ button, list: document.getElementById(button.dataset.opens) }));

  function closeMenus(but) {
    for (const { button, list } of menus) {
      if (button === but) continue;
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  }

  bar.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.opens) {
      const menu = menus.find((found) => found.button === button);
      closeMenus(button);
      menu.list.hidden = !menu.list.hidden;
      button.setAttribute("aria-expanded", String(!menu.list.hidden));
      return;
    }
    closeMenus();
    if (button.dataset.do) (view === "page" ? ON_PAGE : ON_TEXT)[button.dataset.do]();
    if (button.dataset.show) setView(button.dataset.show);
  });
  // pressing a button must not take the selection out of the text
  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".menu")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });

  /* ============================================================= preview */

  const roomForBoth = window.matchMedia("(min-width: 68rem)");
  const WAY_KEY = "gesserit.editor.way";
  let fetching = false;
  let stale = false;
  let timer;

  async function refresh() {
    if (view !== "preview" && view !== "both") return;
    if (fetching) {
      stale = true;
      return;
    }
    fetching = true;
    stale = false;
    try {
      const answer = await send("/preview", { title: title.value, body: box.value }, "The preview could not be fetched.");
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

  // where to go back to when the preview is put away
  let writing = "page";

  async function setView(next, remember = true) {
    if (next === "both" && !roomForBoth.matches) next = "preview";
    if (view === "page" && next !== "page") {
      closeOffer();
      sync();
    }
    // the page is set out afresh if the text has been changed anywhere but on it
    if (next === "page" && settled !== box.value) {
      // it takes the box's place at once, so that the box is not seen to come and go
      frame.dataset.view = "page";
      page.hidden = false;
      pane.hidden = true;
      if (!(await setOutFromBox())) next = "write";
    }
    view = next;
    if (next === "page" || next === "write") writing = next;
    frame.dataset.view = next;
    page.hidden = next !== "page";
    page.contentEditable = String(next === "page");
    pane.hidden = next === "write" || next === "page";
    // the box is still what is sent, but while the page stands for it, it is the page that must not be empty
    box.required = needed && next !== "page";
    viewName.textContent = VIEWS[next];
    for (const button of bar.querySelectorAll("[data-show]")) button.setAttribute("aria-checked", String(button.dataset.show === next));
    for (const button of bar.querySelectorAll("[data-do], [data-opens='styles']")) button.disabled = next === "preview";
    if (remember && next !== "preview") {
      try {
        localStorage.setItem(WAY_KEY, next === "page" ? "page" : "text");
      } catch {
        // a browser that keeps nothing still shows what was asked for
      }
    }
    if (next === "preview" || next === "both") {
      showTitle();
      refresh();
    }
    if (next === "write" || next === "both") fit();
    reflect();
  }

  // too narrow for two columns: fall back to the text alone
  roomForBoth.addEventListener("change", () => {
    if (view === "both" && !roomForBoth.matches) setView("write", false);
  });

  // a box that cannot be seen cannot be shown to be empty: bring it back first
  box.addEventListener("invalid", () => {
    if (view === "preview") setView(writing, false);
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

  /** what is in the box is what the page says, as of now */
  const current = () => {
    if (view === "page") write();
  };

  const DRAFT_KEY = `gesserit.draft.${form.dataset.editor}`;
  const snapshot = () => ({ title: title.value, body: box.value, summary: summary ? summary.value : "" });
  const same = (a, b) => a.title === b.title && a.body === b.body && (a.summary || "") === (b.summary || "");
  const saved = snapshot(); // what the server has
  let leaving = false;
  let keeper;

  function keep(extra = {}) {
    current();
    try {
      if (same(snapshot(), saved)) return localStorage.removeItem(DRAFT_KEY);
      const when = Date.now();
      // kept without a word: it is offered back if the page is left before it is saved
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...snapshot(), at: when, ...extra }));
    } catch {
      // nowhere to keep it: the page still warns before it is left
    }
  }

  function offerKept() {
    let found = null;
    try {
      found = JSON.parse(localStorage.getItem(DRAFT_KEY));
    } catch {
      found = null;
    }
    if (!found || typeof found.body !== "string") return;
    if (same(found, saved) || !found.body.trim()) return localStorage.removeItem(DRAFT_KEY);

    const notice = document.createElement("div");
    notice.className = "notice notice--ok kept";
    const words = document.createElement("p");
    const when = new Date(found.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    words.textContent = `Writing from ${when} that was never saved is still kept in this browser.`;
    const bringBack = document.createElement("button");
    bringBack.type = "button";
    bringBack.className = "link";
    bringBack.textContent = "Bring it back";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "link link--quiet";
    discard.textContent = "Discard it";
    const buttons = document.createElement("p");
    buttons.className = "kept__choice";
    buttons.append(bringBack, discard);
    notice.append(words, buttons);
    frame.before(notice);

    bringBack.addEventListener("click", () => {
      title.value = found.title || "";
      box.value = found.body;
      if (summary) summary.value = found.summary || "";
      notice.remove();
      box.dispatchEvent(new Event("input", { bubbles: true }));
      if (view === "page") page.focus();
      else box.focus();
    });
    discard.addEventListener("click", () => {
      notice.remove();
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // nothing was kept, then
      }
    });
  }

  function changed() {
    fit();
    clearTimeout(keeper);
    keeper = setTimeout(keep, 700);
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  }

  box.addEventListener("input", () => {
    // the box filled from elsewhere while the page is shown (a file opened, a copy brought back): set it out again
    if (view === "page") setOutFromBox();
    changed();
  });
  title.addEventListener("input", () => {
    showTitle();
    changed();
  });
  summary?.addEventListener("input", changed);

  form.addEventListener("submit", (event) => {
    current();
    if (needed && view === "page" && !box.value.trim()) {
      // the box would have said so itself, were it the one being written in
      event.preventDefault();
      say("There is nothing written yet.", true);
      return page.focus();
    }
    // marked as sent: once the saved post is shown, the copy is no longer wanted
    leaving = true;
    clearTimeout(keeper);
    keep({ sent: true });
  });

  // the form that deletes the post leaves on purpose too, unless the question it asks is answered no
  document.addEventListener("submit", (event) => {
    if (!event.defaultPrevented && !event.target.closest("dialog")) leaving = true;
  });

  window.addEventListener("beforeunload", (event) => {
    current();
    if (leaving || same(snapshot(), saved)) return;
    keep();
    event.preventDefault();
    event.returnValue = "";
  });

  /* ----------------------------------------------------------- beginning */

  try {
    // paragraphs are paragraphs in every browser, and bold is <b>, not a style
    document.execCommand("defaultParagraphSeparator", false, "p");
    document.execCommand("styleWithCSS", false, false);
  } catch {
    // a browser without these still writes; the page is tidied as it goes
  }
  watch();
  offerKept();
  let way = null;
  try {
    way = localStorage.getItem(WAY_KEY);
  } catch {
    way = null;
  }
  // the page is what is shown, unless the plain text was chosen the last time
  setView(way === "text" || !M ? "write" : "page", false);
})();
