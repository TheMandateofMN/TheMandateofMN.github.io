/*
 * Everything here is an enhancement: without it, pages still read, forms still
 * post and margin notes are still listed with the passages they quote. With
 * it, quoted passages are found and marked in the text, a selection can be
 * turned into a note, members and articles are offered by name while writing,
 * and dates are shown in the reader's own time. The editor and the graph have
 * scripts of their own, editor.js and graph.js.
 */

(() => {
  "use strict";

  /* ------------------------------------------------------------- dates */

  const DAY = { day: "numeric", month: "long", year: "numeric" };
  const STAMP = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  for (const time of document.querySelectorAll("time[datetime]")) {
    const date = new Date(time.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    time.textContent =
      time.dataset.style === "stamp"
        ? date.toLocaleString("en-GB", STAMP)
        : date.toLocaleDateString("en-GB", DAY);
  }

  /* ----------------------------------------------------- confirmations */

  document.addEventListener("submit", (event) => {
    const message = event.submitter?.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  /* ----------------------------------------------------------- replies */

  // a box for a reply, or for rewording a note, opens ready to be typed in
  for (const box of document.querySelectorAll("details.reply-box")) {
    box.addEventListener("toggle", () => {
      if (box.open) box.querySelector("textarea").focus();
    });
  }

  /* ------------------------------------------- copies of unsaved writing */

  // the editor keeps a copy of what is being written, and marks it as sent when the
  // form is. Arriving at a post, a project's page or a suggestion means the save went
  // through, so those are done with.
  if (/^\/(p|pages|suggestions)\/\d+$/.test(window.location.pathname)) {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("gesserit.draft.") && JSON.parse(localStorage.getItem(key))?.sent) localStorage.removeItem(key);
      }
    } catch {
      // a browser that keeps nothing has nothing to clear
    }
  }

  /* ----------------------------------------------- opening a text file */

  const picker = document.querySelector("input[type=file][data-load-into]");
  if (picker) {
    const body = document.getElementById(picker.dataset.loadInto);
    const title = document.getElementById(picker.dataset.titleInto);
    picker.addEventListener("change", async () => {
      const file = picker.files[0];
      picker.value = "";
      if (!file) return;
      if (file.size > 900 * 1024) return window.alert("That file is too large to open here.");
      if (body.value.trim() && !window.confirm("Replace what is in the box with this file?")) return;
      let text = (await file.text()).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
      // a file that opens on a top-level heading brings its own title
      const heading = /^\s*# +(.+?)\s*#*\n+/.exec(text);
      if (heading && title && !title.value.trim()) {
        title.value = heading[1];
        text = text.slice(heading[0].length);
      }
      body.value = text;
      // the editor counts, previews and keeps a copy on hearing of a change
      body.dispatchEvent(new Event("input", { bubbles: true }));
      body.focus();
    });
  }

  /* ------------------------------- tagging members and naming articles */

  /*
   * In a box marked data-suggest, typing "@" offers the members and typing
   * "[[" offers the articles; choosing one writes "@name" or "[[Title]]".
   * Either can also simply be typed out.
   */
  const boxes = document.querySelectorAll("textarea[data-suggest]");
  if (boxes.length > 0) {
    const nothing = { people: [], articles: [] };
    let known;
    const load = () =>
      (known ||= fetch("/suggest.json", { credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : nothing))
        .catch(() => nothing));

    const list = document.createElement("ul");
    list.className = "suggest";
    list.id = "suggest";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    document.body.append(list);

    let open = null; // { box, start, items, index } while the list is showing

    /** what is being typed just before the caret: a name after "@", or a title after "[[" */
    function pending(box) {
      if (box.selectionStart !== box.selectionEnd) return null;
      const before = box.value.slice(0, box.selectionStart);
      const kinds = box.dataset.suggest.split(" ");
      const name = kinds.includes("people") && /(?:^|[^A-Za-z0-9._@-])@([A-Za-z0-9._-]{0,32})$/.exec(before);
      if (name) return { kind: "people", query: name[1], start: before.length - name[1].length - 1 };
      const title = kinds.includes("articles") && /\[\[([^[\]|\n]{0,80})$/.exec(before);
      if (title) return { kind: "articles", query: title[1], start: before.length - title[1].length - 2 };
      return null;
    }

    function matching(data, { kind, query }) {
      const q = query.trim().toLowerCase();
      if (kind === "people") {
        return data.people
          .filter(({ username, name }) =>
            [username, name, ...name.split(/\s+/)].some((word) => word.toLowerCase().startsWith(q))
          )
          .slice(0, 6)
          .map(({ username, name }) => ({ label: name, aside: "@" + username, insert: "@" + username + " " }));
      }
      return data.articles
        .filter((title) => !/[[\]|]/.test(title) && title.toLowerCase().includes(q))
        .slice(0, 6)
        .map((title) => ({ label: title, aside: "", insert: "[[" + title + "]]" }));
    }

    /** where on the page the character at `position` sits, found by setting the same text in a copy of the box */
    function pointOf(box, position) {
      const style = getComputedStyle(box);
      const copy = document.createElement("div");
      for (const property of [
        "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
        "lineHeight", "textIndent", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
        "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      ])
        copy.style[property] = style[property];
      Object.assign(copy.style, {
        position: "absolute",
        top: "0",
        left: "-9999px",
        visibility: "hidden",
        borderStyle: "solid",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
      });
      copy.textContent = box.value.slice(0, position);
      const mark = document.createElement("span");
      mark.textContent = "\u200b";
      copy.append(mark);
      document.body.append(copy);
      const rect = box.getBoundingClientRect();
      const point = {
        left: window.scrollX + rect.left + parseFloat(style.borderLeftWidth) + mark.offsetLeft - box.scrollLeft,
        top: window.scrollY + rect.top + parseFloat(style.borderTopWidth) + mark.offsetTop + mark.offsetHeight - box.scrollTop,
      };
      copy.remove();
      return point;
    }

    function close() {
      if (!open) return;
      open.box.removeAttribute("aria-activedescendant");
      open.box.removeAttribute("aria-controls");
      list.hidden = true;
      open = null;
    }

    function mark(index) {
      open.index = index;
      [...list.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
      open.box.setAttribute("aria-activedescendant", "suggest-" + index);
    }

    function choose(index) {
      const { box, start, items } = open;
      // a title chosen before closing brackets already typed takes their place
      const end = box.selectionStart + (items[index].insert.endsWith("]]") && box.value.startsWith("]]", box.selectionStart) ? 2 : 0);
      box.setRangeText(items[index].insert, start, end, "end");
      close();
    }

    async function offer(box) {
      if (!pending(box)) return close();
      const data = await load();
      // the caret may have moved on while the names were fetched
      const typing = document.activeElement === box && pending(box);
      const items = typing ? matching(data, typing) : [];
      if (items.length === 0) return close();

      list.replaceChildren(
        ...items.map((item, i) => {
          const row = document.createElement("li");
          row.id = "suggest-" + i;
          row.setAttribute("role", "option");
          row.textContent = item.label;
          if (item.aside) {
            const aside = document.createElement("small");
            aside.textContent = item.aside;
            row.append(aside);
          }
          row.addEventListener("click", () => {
            choose(i);
            box.focus();
          });
          return row;
        })
      );
      open = { box, start: typing.start, items, index: 0 };
      box.setAttribute("aria-controls", "suggest");
      list.hidden = false;
      mark(0);

      const point = pointOf(box, typing.start);
      const most = window.scrollX + document.documentElement.clientWidth - list.offsetWidth - 8;
      list.style.left = Math.max(window.scrollX + 8, Math.min(point.left, most)) + "px";
      list.style.top = point.top + 6 + "px";
    }

    // keep the caret in the box when the list is pressed
    list.addEventListener("pointerdown", (event) => event.preventDefault());

    for (const box of boxes) {
      box.addEventListener("input", () => offer(box));
      box.addEventListener("click", () => offer(box));
      box.addEventListener("blur", close);
      box.addEventListener("keydown", (event) => {
        if (!open || open.box !== box) return;
        const last = open.items.length - 1;
        if (event.key === "ArrowDown") mark(open.index === last ? 0 : open.index + 1);
        else if (event.key === "ArrowUp") mark(open.index === 0 ? last : open.index - 1);
        else if (event.key === "Enter" || event.key === "Tab") choose(open.index);
        else if (event.key === "Escape") close();
        else return;
        event.preventDefault();
      });
    }
  }

  /* ------------------------------------------------------ margin notes */

  const article = document.querySelector("[data-article]");
  if (!article) return;

  /*
   * Passages are matched on their characters alone, with all white space
   * taken out, so a quotation is found however the browser broke the lines
   * or joined the paragraphs when it was selected. Quotation marks are read
   * as the plain ones they were typed as, since the page sets them curled
   * and a note may have been made before it did.
   */
  const plain = (text) => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
  const squeeze = (text) => plain(text.replace(/\s+/g, ""));

  /** the article's text without white space, and where each character sits */
  function readArticle() {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    const nodes = [];
    const offsets = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const data = node.data;
      for (let i = 0; i < data.length; i++) {
        if (/\s/.test(data[i])) continue;
        text += plain(data[i]);
        nodes.push(node);
        offsets.push(i);
      }
    }
    return { text, nodes, offsets };
  }

  /** wraps the passage a note quotes in <mark>s; false if the text no longer holds it */
  function markPassage(id, n, quote, pos) {
    const needle = squeeze(quote);
    if (!needle) return false;
    const { text, nodes, offsets } = readArticle();

    // a phrase may occur more than once; take the occurrence nearest where it was chosen
    let at = -1;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      if (at === -1 || Math.abs(i - pos) < Math.abs(at - pos)) at = i;
    }
    if (at === -1) return false;

    const last = at + needle.length - 1;
    const spans = [];
    for (let i = at; i <= last; i++) {
      const span = spans[spans.length - 1];
      if (span && span.node === nodes[i]) span.end = offsets[i] + 1;
      else spans.push({ node: nodes[i], start: offsets[i], end: offsets[i] + 1 });
    }

    let mark;
    spans.forEach(({ node, start, end }, i) => {
      const piece = start > 0 ? node.splitText(start) : node;
      if (end - start < piece.data.length) piece.splitText(end - start);
      mark = document.createElement("mark");
      mark.className = "cite";
      mark.dataset.note = id;
      if (i === 0) mark.id = `cite-${id}`;
      piece.replaceWith(mark);
      mark.append(piece);
    });

    // the number is drawn by CSS, so it never becomes part of the article's text
    const ref = document.createElement("a");
    ref.className = "note-ref";
    ref.href = `#note-${id}`;
    ref.dataset.n = n;
    ref.setAttribute("aria-label", `Margin note ${n}`);
    mark.after(ref);
    return true;
  }

  function light(id) {
    const marks = article.querySelectorAll(`mark[data-note="${id}"]`);
    for (const mark of marks) mark.classList.add("is-lit");
    setTimeout(() => marks.forEach((mark) => mark.classList.remove("is-lit")), 2200);
  }

  for (const note of document.querySelectorAll(".note[data-quote]")) {
    const { note: id, n, quote, pos } = note.dataset;
    const block = note.querySelector(".note__quote");
    if (!quote || !block) continue;
    if (!markPassage(id, n, quote, Number(pos) || 0)) {
      // the text has moved on; the version the note was made on still has the passage,
      // and the browser can be asked to find it there
      block.title = "This passage has since been revised.";
      const version = Number(note.dataset.version);
      if (version && version < Number(article.dataset.version)) {
        const words = quote.split(" ");
        const passage =
          words.length > 8
            ? `${encodeURIComponent(words.slice(0, 4).join(" "))},${encodeURIComponent(words.slice(-4).join(" "))}`
            : encodeURIComponent(quote);
        const was = document.createElement("a");
        was.className = "note__was";
        was.href = `/p/${article.dataset.post}/v/${version}#:~:text=${passage.replace(/-/g, "%2D")}`;
        was.textContent = `Since revised: see it in version ${version}`;
        block.after(was);
      }
      continue;
    }
    const jump = document.createElement("a");
    jump.href = `#cite-${id}`;
    jump.title = "Show this passage in the text";
    jump.append(...block.childNodes);
    block.append(jump);
    jump.addEventListener("click", () => light(id));
  }

  /* ----------------------------------------- from a selection to a note */

  const form = document.getElementById("add-note");
  if (!form) return;

  const quoteField = form.elements.quote;
  const posField = form.elements.pos;
  const preview = form.querySelector("[data-quote-preview]");
  const hint = form.querySelector("[data-quote-hint]");
  const MAX_QUOTE = 600;

  function attach(quote, pos) {
    quoteField.value = quote;
    posField.value = quote ? pos : "";
    preview.querySelector("blockquote").textContent = quote;
    preview.hidden = !quote;
    hint.hidden = Boolean(quote);
  }

  // a passage carried back by the server after a failed save
  if (quoteField.value) attach(quoteField.value, posField.value);
  form.querySelector("[data-quote-clear]").addEventListener("click", () => attach("", ""));

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cite-button";
  button.textContent = "Add margin note";
  button.hidden = true;
  document.body.append(button);

  let chosen = null;

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
    const quote = selection.toString().replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE).trim();
    if (squeeze(quote).length < 2) return null;

    const before = document.createRange();
    before.selectNodeContents(article);
    before.setEnd(range.startContainer, range.startOffset);
    const rects = range.getClientRects();
    return {
      quote,
      pos: squeeze(before.toString()).length,
      rect: rects[rects.length - 1] || range.getBoundingClientRect(),
    };
  }

  let timer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      chosen = readSelection();
      button.hidden = !chosen;
      if (!chosen) return;
      const width = button.offsetWidth;
      const left = window.scrollX + chosen.rect.right - width / 2;
      const max = window.scrollX + document.documentElement.clientWidth - width - 8;
      button.style.left = `${Math.max(window.scrollX + 8, Math.min(left, max))}px`;
      button.style.top = `${window.scrollY + chosen.rect.bottom + 10}px`;
    }, 120);
  });

  // keep the selection when the button is pressed
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (!chosen) return;
    attach(chosen.quote, chosen.pos);
    window.getSelection().removeAllRanges();
    button.hidden = true;
    form.scrollIntoView({ block: "center" });
    form.elements.body.focus({ preventScroll: true });
  });
})();
