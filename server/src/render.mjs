/*
 * Turning what was typed into what is shown.
 *
 * Posts are Markdown, with single line breaks kept, so a plain text pasted in
 * reads the way it was written. Raw HTML in a post is shown as text rather
 * than passed through, and links may only go to http, https or mailto, so
 * whatever is pasted, nothing in a post can run.
 *
 * Posts also take mathematics and drawings. `$x^2$` is a formula in the line
 * and `$$ … $$` one set out by itself, both typeset by KaTeX. A fenced block
 * marked `tikz` holds LaTeX that is drawn as a diagram; a picture standing
 * alone in a paragraph becomes a figure, with its title as the caption.
 *
 * Margin notes are plain text: paragraphs, line breaks and bare links.
 *
 * Two things are understood in both. `@name`, with a member's sign-in name,
 * tags that member and becomes a link to their page. In posts, `[[Title]]`
 * (or `[[Title|other words]]`) becomes a link to the published article of
 * that name. Which members and articles exist, and what a diagram looks like
 * once drawn, is asked of a lookup that the server supplies; without one,
 * names are left as they were typed and diagrams as their source.
 */

import katex from "katex";
import { Marked } from "marked";

let lookup = { post: () => null, member: () => null, drawing: () => null, origin: "" };

/**
 * Says how names are resolved from here on:
 *   post(title)     -> { id, title } of the published article of that name, or null
 *   member(name)    -> { id, username, name } of the member who signs in as that, or null
 *   drawing(source) -> { src, width, height } of a diagram that has been drawn, { error }
 *                      for one that could not be, or null for one not attempted yet
 *   origin          -> the forum's own address, so links written out in full are known as its own
 */
export function useLookup(next) {
  lookup = { ...lookup, ...next };
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
/* a picture is one from elsewhere on the web, or one uploaded here */
const SAFE_IMAGE = /^(https?:\/\/|\/media\/[A-Za-z0-9._-]+$)/i;
const isExternal = (href) => /^https?:\/\//i.test(href);

/* a sign-in name as it may be typed after an @; what follows it may be the sentence's own full stop */
const HANDLE = /^[A-Za-z0-9._-]{2,}/;
const NAME_CHARACTER = /[A-Za-z0-9._@-]$/;

/** the member named at the start of `typed`, with how much of it is the name */
function memberAt(typed) {
  const run = HANDLE.exec(typed)?.[0];
  if (!run) return null;
  for (const name of new Set([run, run.replace(/[._-]+$/, "")])) {
    if (name.length < 2 || name.length > 32) continue;
    const member = lookup.member(name);
    if (member) return { member, length: name.length };
  }
  return null;
}

const mentionLink = (member) =>
  `<a class="mention" href="/m/${encodeURIComponent(member.username)}">@${escapeHtml(member.name)}</a>`;

/* ------------------------------------------- formulas, diagrams, figures */

/* while an excerpt is being made, formulas stay as typed and pictures and diagrams are left out */
let plain = false;

/* a formula in the line: "$" hard against what it encloses, so that "$5 and $10" is left alone */
const FORMULA = /^\$\$([^\n$]+?)\$\$|^\$(?![\s$])((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
const FORMULA_BLOCK = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/;

/** `tex` typeset by KaTeX; `display` sets it large and centred, `block` on lines of its own */
function formula(tex, { display = false, block = false } = {}) {
  if (plain) return escapeHtml(tex);
  const set = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    errorColor: "#8b3048",
    strict: "ignore",
    trust: false,
    maxSize: 40,
    maxExpand: 1000,
  });
  return block ? `<div class="math">${set}</div>\n` : set;
}

/* the fenced blocks that are drawn rather than shown */
const DIAGRAM = new Set(["tikz", "tikzcd", "diagram"]);

/** what a fenced block is marked as, and anything written after that on its opening line */
function fence(lang = "") {
  const [kind = "", ...rest] = lang.trim().split(/\s+/);
  return { kind: kind.toLowerCase(), caption: rest.join(" ") };
}

const caption = (text) => (text ? `<figcaption>${escapeHtml(text)}</figcaption>` : "");

/** a LaTeX diagram: the drawing if there is one, and otherwise its source with what is the matter */
function diagram(source, words) {
  if (plain) return "";
  const drawing = lookup.drawing(source);
  if (drawing?.src) {
    const attrs = [
      `src="${escapeHtml(drawing.src)}"`,
      `width="${drawing.width}"`,
      `height="${drawing.height}"`,
      `alt="${escapeHtml(words || `A diagram drawn from LaTeX: ${clip(source, 240)}`)}"`,
    ];
    return `<figure class="figure figure--diagram"><img ${attrs.join(" ")} loading="lazy">${caption(words)}</figure>\n`;
  }
  const matter = drawing?.error ? `This diagram could not be drawn. ${drawing.error}` : "This diagram has not been drawn yet.";
  return `<figure class="figure figure--undrawn"><pre><code>${escapeHtml(source)}</code></pre>${caption(matter)}</figure>\n`;
}

function picture({ href, text }) {
  const attrs = [`src="${escapeHtml(href)}"`, `alt="${escapeHtml(text)}"`];
  return `<img ${attrs.join(" ")} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
  extensions: [
    {
      name: "formulaBlock",
      level: "block",
      start: (src) => src.match(/(?:^|\n) {0,3}\$\$/)?.index,
      tokenizer(src) {
        const match = FORMULA_BLOCK.exec(src);
        if (!match?.[1].trim()) return;
        return { type: "formulaBlock", raw: match[0], tex: match[1].trim() };
      },
      renderer: ({ tex }) => formula(tex, { display: true, block: true }),
    },
    {
      name: "formula",
      level: "inline",
      start: (src) => src.indexOf("$"),
      tokenizer(src) {
        const match = FORMULA.exec(src);
        if (!match) return;
        return { type: "formula", raw: match[0], tex: match[1] ?? match[2], display: match[1] !== undefined };
      },
      renderer: ({ tex, display }) => formula(tex, { display }),
    },
  ],
  hooks: {
    // a formula's own stars and underscores are not emphasis
    emStrongMask: (src) =>
      src.replace(/\$\$[^\n$]+?\$\$|\$(?![\s$])(?:\\[^\n]|[^\\$\n])+?(?<!\s)\$(?!\d)/g, (found) => "a".repeat(found.length)),
  },
});

marked.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src) => src.indexOf("[["),
      tokenizer(src) {
        if (this.lexer.state.inLink) return;
        const match = /^\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/.exec(src);
        const ref = match?.[1].replace(/\s+/g, " ").trim();
        if (!ref) return;
        return { type: "wikilink", raw: match[0], ref, label: match[2]?.trim() || "" };
      },
      renderer({ ref, label }) {
        const target = lookup.post(ref);
        if (!target)
          return `<span class="wikilink wikilink--missing" title="There is no article by this name yet">${escapeHtml(label || ref)}</span>`;
        return `<a class="wikilink" href="/p/${target.id}">${escapeHtml(label || target.title)}</a>`;
      },
    },
    {
      name: "mention",
      level: "inline",
      start: (src) => src.indexOf("@"),
      tokenizer(src, tokens) {
        if (src[0] !== "@" || this.lexer.state.inLink) return;
        // an @ in the middle of a word is an address, not a tag
        const before = tokens.at(-1);
        if (before?.type === "text" && NAME_CHARACTER.test(before.raw)) return;
        const found = memberAt(src.slice(1));
        if (!found) return;
        return { type: "mention", raw: src.slice(0, found.length + 1), member: found.member };
      },
      renderer: ({ member }) => mentionLink(member),
    },
  ],
});

marked.use({
  renderer: {
    html({ text, block }) {
      return block ? `<p>${escapeHtml(text.trim())}</p>\n` : escapeHtml(text);
    },
    // the page's h1 is the post's title, so headings in the text start at h2
    heading({ tokens, depth }) {
      const level = Math.min(depth + 1, 4);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href || "")) return text;
      const attrs = [`href="${escapeHtml(href)}"`];
      if (title) attrs.push(`title="${escapeHtml(title)}"`);
      if (isExternal(href)) attrs.push(`rel="noopener noreferrer"`);
      return `<a ${attrs.join(" ")}>${text}</a>`;
    },
    image(token) {
      if (!SAFE_IMAGE.test(token.href || "")) return escapeHtml(token.text);
      return plain ? "" : picture(token);
    },
    // a picture in a paragraph of its own is a figure, and its title the caption
    paragraph({ tokens }) {
      const only = tokens.length === 1 && tokens[0].type === "image" ? tokens[0] : null;
      if (!only || !SAFE_IMAGE.test(only.href || "")) return false;
      return plain ? "" : `<figure class="figure">${picture(only)}${caption(only.title)}</figure>\n`;
    },
    code({ text, lang }) {
      const { kind, caption: words } = fence(lang);
      if (kind === "math") return formula(text, { display: true, block: true });
      if (DIAGRAM.has(kind)) return diagram(text, words);
      return false;
    },
  },
});

const normalise = (body) => String(body).replace(/\r\n?/g, "\n");

/** the post a link leads to, if it leads to one here: "/p/12" or the same written out in full */
function linkedPost(href = "") {
  const path = lookup.origin && href.startsWith(lookup.origin) ? href.slice(lookup.origin.length) : href;
  const match = /^\/p\/([1-9]\d{0,14})(?=$|[/?#])/.exec(path);
  return match ? Number(match[1]) : null;
}

/** what a post's text points at: the ids of the posts it links to and of the members it tags */
export function references(body) {
  const posts = new Set();
  const members = new Set();
  marked.walkTokens(marked.lexer(normalise(body)), (token) => {
    if (token.type === "mention") members.add(token.member.id);
    const id =
      token.type === "wikilink" ? lookup.post(token.ref)?.id : token.type === "link" ? linkedPost(token.href) : null;
    if (id) posts.add(id);
  });
  return { posts: [...posts], members: [...members] };
}

/** the LaTeX of every diagram in a post, so that they can be drawn before it is shown */
export function diagrams(body) {
  const sources = new Set();
  if (!/^ {0,3}(`{3,}|~{3,}) *(tikz|tikzcd|diagram)\b/im.test(String(body))) return [];
  marked.walkTokens(marked.lexer(normalise(body)), (token) => {
    if (token.type === "code" && DIAGRAM.has(fence(token.lang).kind)) sources.add(token.text);
  });
  return [...sources];
}

/* the letters the EB Garamond Initials fonts carry; the face was never finished */
const ILLUMINATED = "AFGLNOQTX";

/**
 * A post's body as HTML. With `initial`, an opening capital is marked up as a
 * drop capital: an illuminated letter where the initials fonts have one, and a
 * plain versal, to be drawn in red, where they do not.
 */
export function renderPost(body, { initial = false } = {}) {
  const html = marked.parse(normalise(body));
  if (!initial) return html;
  return html.replace(/^<p>([A-Z])/, (_, letter) =>
    ILLUMINATED.includes(letter)
      ? `<p class="opens"><span class="initial" data-letter="${letter}">${letter}</span>`
      : `<p class="opens"><span class="versal">${letter}</span>`
  );
}

const UNESCAPES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** plain text on one line, cut at a word if it runs past `length` */
export function clip(value, length) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), length * 0.6)).replace(/[\s,;:.!?–—-]+$/, "") + "…";
}

/** the opening of a post as plain text, cut at a word, for the journal page */
export function excerpt(body, length = 280) {
  plain = true;
  let html;
  try {
    html = renderPost(body);
  } finally {
    plain = false;
  }
  // what is set within a line closes up, so that a full stop after an emphasis stays against it;
  // everything else that was markup leaves a space where it was
  const text = html
    .replace(/<(pre|table)[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/?(?:em|strong|del|a|span|code)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity]);
  return clip(text, length);
}

/* ------------------------------------------------------------ typography */

/* what is shown exactly as it was typed: code, the text in a box being edited, a formula's source */
const AS_TYPED = new Set(["code", "pre", "kbd", "samp", "textarea", "script", "style", "math"]);
/* what sits within a line of text, so that a quotation may begin before it and end after it */
const WITHIN_A_LINE = new Set(
  "a abbr b cite del em i ins label mark q s small span strong sub sup time u".split(" ")
);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b([^>]*)>|<![^>]*>/g;
const TYPED_QUOTE = /&quot;|&#39;|["']/g;
/* after any of these, or at the start, a quotation mark opens */
const OPENS_AFTER = /[\s([{\u2014\u2013\u2018\u201c]/;
/* words that begin with an apostrophe, which is not an opening quotation mark */
const ELIDED = /^(?:\d\ds?\b|(?:tis|twas|twere|em|til)\b)/i;

/** the quotation marks in one stretch of text, where `before` is the character it follows */
function curl(text, before) {
  let out = "";
  let from = 0;
  for (const found of text.matchAll(TYPED_QUOTE)) {
    out += text.slice(from, found.index);
    from = found.index + found[0].length;
    // what the mark follows, as it has been set: a mark just opened is itself something to open after
    const previous = out ? out[out.length - 1] : before;
    const opens = previous === "" || OPENS_AFTER.test(previous);
    if (found[0] === '"' || found[0] === "&quot;") out += opens ? "\u201c" : "\u201d";
    else if (!opens || ELIDED.test(text.slice(from))) out += "\u2019";
    else out += "\u2018";
  }
  return out + text.slice(from);
}

/**
 * Sets the typewriter's quotation marks in finished HTML as a printer would:
 * "so" becomes “so” and it's becomes it’s. Only what is read as text is
 * touched: nothing inside a tag, and nothing that is shown as it was typed,
 * which is code, a formula, the text in a box being edited, and anything
 * within an element marked `data-typed`. What is stored is not changed; this
 * is how it is shown.
 */
export function typeset(html) {
  if (!/["']|&quot;|&#39;/.test(html)) return html;
  let out = "";
  let at = 0;
  let before = "";
  let typed = null;
  let depth = 0;
  TAG.lastIndex = 0;
  for (let found = TAG.exec(html); found; found = TAG.exec(html)) {
    const text = html.slice(at, found.index);
    at = TAG.lastIndex;
    const [tag, closing, called = "", attributes = ""] = found;
    const name = called.toLowerCase();
    if (typed) {
      out += text + tag;
      if (name !== typed) continue;
      if (closing) depth -= 1;
      else if (!attributes.endsWith("/")) depth += 1;
      if (depth === 0) {
        typed = null;
        before = "a";
      }
      continue;
    }
    if (text) {
      const set = curl(text, before);
      out += set;
      before = set[set.length - 1];
    }
    out += tag;
    const asTyped =
      AS_TYPED.has(name) || /\sdata-typed\b/.test(attributes) || (name === "span" && /\sclass="katex/.test(attributes));
    if (!closing && asTyped && !attributes.endsWith("/")) {
      typed = name;
      depth = 1;
    } else if (name === "br") before = " ";
    else if (!WITHIN_A_LINE.has(name)) before = "";
  }
  const rest = html.slice(at);
  return out + (typed ? rest : curl(rest, before));
}

/* in a note, the two things that are more than text: a bare link and a tag */
const NOTE_PARTS = /https?:\/\/[^\s<>"']+|(?<![A-Za-z0-9._@-])@(?=[A-Za-z0-9._-]{2})/g;

/** walks a note's text, handing each stretch of plain text, link and tag to `on` */
function readNote(raw, on) {
  let last = 0;
  for (const match of raw.matchAll(NOTE_PARTS)) {
    if (match.index < last) continue;
    let length;
    if (match[0] === "@") {
      const found = memberAt(raw.slice(match.index + 1));
      if (!found) continue;
      length = found.length + 1;
      on.text?.(raw.slice(last, match.index));
      on.member?.(found.member);
    } else {
      const url = match[0].replace(/[.,;:!?)\]]+$/, "");
      length = url.length;
      on.text?.(raw.slice(last, match.index));
      on.url?.(url);
    }
    last = match.index + length;
  }
  on.text?.(raw.slice(last));
}

export function renderNote(body) {
  const paragraph = (raw) => {
    let out = "";
    readNote(raw, {
      text: (plain) => (out += escapeHtml(plain)),
      url: (url) => (out += `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>`),
      member: (member) => (out += mentionLink(member)),
    });
    return `<p>${out.replace(/\n/g, "<br>")}</p>`;
  };
  return normalise(body).trim().split(/\n{2,}/).map(paragraph).join("");
}

/** the ids of the members a note tags */
export function taggedIn(body) {
  const members = new Set();
  readNote(normalise(body), { member: (member) => members.add(member.id) });
  return [...members];
}

/* ----------------------------------------------------------------- dates */

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/**
 * A <time> element. The server writes the date in UTC; the page's script
 * rewrites it in the reader's own time zone.
 */
export function timeTag(iso, style = "day") {
  const date = new Date(iso);
  const text = style === "day" ? DAY.format(date) : `${STAMP.format(date)} UTC`;
  return `<time datetime="${escapeHtml(iso)}" data-style="${style}">${escapeHtml(text)}</time>`;
}
