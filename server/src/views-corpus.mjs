/*
 * The corpus: everything published here drawn about the essay at its
 * centre, the works it descends from to one side and what has been written
 * here to the other; and the form an antecedent is added or changed with.
 */

import { annotationOf, csrfField, curationChecks, curationOf, html, may, notice, page, raw } from "./views.mjs";
import { MEDIA } from "./works.mjs";

/* drawn from the back forward, so the lines that say most lie on top */
const EDGE_ORDER = ["descent", "address", "note", "wrote", "link", "commentary"];

/** the address of a view of the corpus: which layers, around a node or not, with the members or without, marked or not */
function corpusHref({ around = null, reach = "1", people = false, layer = "all", marked = false }) {
  const query = new URLSearchParams();
  if (around) query.set("around", around);
  if (around && reach !== "1") query.set("reach", reach);
  if (!around && layer !== "all") query.set("layer", layer);
  if (around && people) query.set("show", "people");
  if (marked) query.set("mark", "show-tell");
  const asked = query.toString();
  return asked ? `/corpus?${asked}` : "/corpus";
}

const REACH_WORDS = [
  ["1", "what it touches"],
  ["2", "two steps out"],
  ["3", "three steps"],
  ["all", "everything connected"],
];

/* the two layers of the corpus: the works it descends from, and what is written here */
const LAYERS = [
  ["all", "All"],
  ["antecedents", "Antecedents"],
  ["succession", "Succession"],
];

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The words a piece is drawn as: its title, on as many lines as it was
 * broken into, and about it whatever else is said there. Before the title of
 * a piece that shows and tells, when that is being marked, a small raised ✧;
 * after the title of a piece that is another's, the raised letter that says
 * whose; under a work's, on a line of its own, the type of thing it is; and
 * last, where something opens under the title, the sign of that. All are
 * parts of the one text, each line of it centred on the piece's place.
 */
function words(each, marked) {
  const raise = round1(each.size * 0.34);
  const small = round1(each.size * 0.7);
  const parts = [
    marked && each.showTell && { text: "✧", name: "star", raised: true, size: small },
    ...each.lines.map((text, i) => ({ text, name: "title", under: i > 0 })),
    each.hand && { text: each.hand, name: "hand", raised: true, size: small },
    each.extent && { text: each.extent, name: "extent", size: round1(each.size * 0.9), under: true },
    each.annotation && { text: "▾", name: "fold", size: round1(each.size * 0.8), gap: 3 },
  ].filter(Boolean);
  let lifted = false;
  return parts.map((part) => {
    // a part is raised or let down by as much as the one before it was not; one that is under begins a line
    const up = Boolean(part.raised);
    const dy = round1((up === lifted ? 0 : up ? -raise : raise) + (part.under ? each.lead : 0));
    lifted = up;
    return html`<tspan class="node__${part.name}" ${part.under && raw('x="0"')} ${dy !== 0 && raw(`dy="${dy}"`)} ${part.gap && raw(`dx="${part.gap}"`)} ${part.size &&
      raw(`font-size="${part.size}"`)}>${part.text}</tspan>`;
  });
}

/* how a piece is coloured: a work in one of the browns of bark, what is written here in green */
const coloured = (each) =>
  each.kind === "work"
    ? ` node--bark node--bark-${each.bark}`
    : each.kind === "person"
      ? ""
      : ` node--leaf${each.tone && ` node--${each.tone}`}`;

/*
 * What a title is lit or filled with that a stylesheet cannot give it by name: the glow behind a
 * work's, and the run from brown into green of a piece grafted onto an earlier author's work.
 * Both are drawn once in the sheet and pointed at from here.
 */
const lit = (each) =>
  each.kind === "work" ? raw('filter="url(#glow)"') : each.tone === "graft" ? raw('fill="url(#graft)"') : "";

/**
 * The corpus, or with `focus` ({ id, reach, of }) the part of it around one
 * node. `layer` says which of its layers are drawn; `marked` that the pieces
 * which both show and tell are marked out, and the rest let fall back;
 * `missing` that a node was asked for which the corpus does not have; and
 * `arranging` that its keeper is dragging the titles to where they belong.
 */
export function corpusPage({ session, graph, counts, people, layer = "all", marked = false, focus = null, missing = false, arranging = false }) {
  const edges = [...graph.edges].sort((a, b) => EDGE_ORDER.indexOf(a.kind) - EDGE_ORDER.indexOf(b.kind));
  const edits = may(session, "edit");
  // those who publish add to the corpus from here; nobody else adds to it at all
  const publishes = edits || may(session, "write");
  const line = (edge) =>
    html`<line
      class="edge edge--${edge.kind}"
      data-from="${edge.from}"
      data-to="${edge.to}"
      x1="${edge.x1}"
      y1="${edge.y1}"
      x2="${edge.x2}"
      y2="${edge.y2}"
    />`;
  const node = (each) => {
    const person = each.kind === "person";
    const open = html`<a
      class="node node--${each.kind}${coloured(each)}${focus?.id === each.id && " is-centre"}${marked && each.showTell && " is-marked"}"
      href="${each.href}"
      data-id="${each.id}"
      data-name="${each.name}"
      ${each.kind === "work" && html`data-by="${each.by}"`}
      ${each.main && raw("data-main")}
      ${!person && edits && raw(`data-edit="${each.href}/edit"`)}
      transform="translate(${each.x} ${each.y})"
      aria-label="${each.detail}"
    >
      <title>${each.detail}</title>`;
    if (person)
      return html`${open}
        <rect class="node__mark" x="-5" y="-5" width="10" height="10" transform="rotate(45)" />
        <text y="19" text-anchor="middle">${each.text}</text>
      </a>`;
    // a piece is its title. Behind it is a plate, which is what is pointed at and pressed: in a part of the
    // corpus it is of the page's own paper, and the lines end at it; in the whole of it, it is not seen
    return html`${open}
      <rect class="node__plate" x="${-each.hw}" y="${-each.up}" width="${2 * each.hw}" height="${each.up + each.down}" rx="3" />
      <text y="${round1(each.first + each.size * 0.32)}" text-anchor="middle" font-size="${each.size}" ${lit(each)}>${words(each, marked)}</text>
    </a>`;
  };
  // what opens when a title is chosen, kept out of sight with the drawing until then
  const opens = (each) =>
    each.annotation &&
    html`<template data-graph-note="${each.id}">
      <div class="prose annotation__text">${annotationOf(each.annotation)}</div>
    </template>`;
  const view = (shown, href, label) =>
    shown ? html`<strong>${label}</strong>` : html`<a href="${href}">${label}</a>`;
  const empty = graph.nodes.length === 0;
  const centre = focus && graph.nodes.find((each) => each.id === focus.id);
  const around = focus?.id ?? null;
  // the pieces that both show and tell can be marked out; it is offered where there is one to mark
  const marking =
    counts.showTell > 0 &&
    (marked
      ? html`<strong>✧ Show and Tell</strong> ·
          <a href="${corpusHref({ around, reach: focus?.reach, layer, people })}">Show all alike</a>`
      : html`<a href="${corpusHref({ around, reach: focus?.reach, layer, people, marked: true })}">✧ Show and Tell</a>`);

  return page({
    title: centre ? `Corpus · ${centre.label}` : "Corpus",
    session,
    width: "sheet",
    current: "corpus",
    scripts: ["corpus"],
    main: html`
      <div class="page-head page-head--corpus">
        <h1 class="page-title">Corpus</h1>
        ${publishes &&
        html`<p class="page-head__acts">
          <a class="button" href="/write">New Piece</a>
          <a class="button button--quiet" href="/submit">Antecedent</a>
        </p>`}
      </div>
      ${missing && notice("That is not in the corpus: it has nothing published to its name yet. Here is all of it.", "ok")}
      ${empty
        ? html`<p class="empty">Nothing has been published yet, so there is nothing to draw.</p>`
        : html`
            ${centre &&
            html`<p class="graph__views graph__focus">
              Around <a href="${centre.href}"><strong>${centre.label}</strong></a
              >:
              ${REACH_WORDS.map(
                ([reach, name], i) =>
                  html`${i > 0 && " · "}${view(focus.reach === reach, corpusHref({ around, reach, people, marked }), name)}`
              )}
              <span class="graph__all">
                ${graph.nodes.length} of ${focus.of} shown · <a href="${corpusHref({ marked })}">The whole corpus</a>
              </span>
            </p>`}
            ${arranging
              ? html`<div class="graph__arrange">
                  <p class="hint">Drag each title to where it belongs. Nothing is kept until it is saved.</p>
                  <form method="post" action="/corpus/arrange" data-arrange-form>
                    ${csrfField(session)}
                    <input type="hidden" name="places" value="" />
                    <button class="button" type="submit">Save</button>
                  </form>
                  <a class="compose__cancel" href="/corpus">Cancel</a>
                  <form method="post" action="/corpus/arrange">
                    ${csrfField(session)}
                    <input type="hidden" name="reset" value="1" />
                    <button
                      class="link link--quiet"
                      type="submit"
                      data-confirm="Let every title go back to where it would stand by itself? Where you have set them is forgotten."
                    >
                      Start again
                    </button>
                  </form>
                </div>`
              : (!around || marking) &&
                html`<p class="graph__views graph__views--split">
                  ${!around &&
                  html`<span
                    >Show:
                    ${LAYERS.map(([key, name], i) => html`${i > 0 && " · "}${view(layer === key, corpusHref({ layer: key, marked }), name)}`)}</span
                  >`}
                  <span>
                    ${marking}${marking && !around && edits && " · "}${!around && edits && html`<a href="/corpus?arrange=1">Arrange</a>`}
                  </span>
                </p>`}
            <div class="graph-frame">
              <div
                class="graph${marked && " graph--marked"}${!around && " graph--whole"}"
                data-graph
                ${arranging && raw("data-arrange")}
                ${graph.origin && raw(`data-origin="${graph.origin.x} ${graph.origin.y}"`)}
              >
                <svg
                  class="graph__sheet"
                  viewBox="0 0 ${graph.width} ${graph.height}"
                  role="group"
                  aria-label="A drawing of ${centre ? `what surrounds ${centre.label}` : "the corpus"}"
                >
                  <defs>
                    ${/* a piece grafted onto an earlier author's work is lettered from the brown of the one into the green of the other */ ""}
                    <linearGradient id="graft" x1="0" y1="0" x2="1" y2="0">
                      <stop class="graft__from" offset="0.08" />
                      <stop class="graft__to" offset="0.92" />
                    </linearGradient>
                    ${/* the glow behind the title of a work: its own letters, blurred and lit, laid under it */ ""}
                    <filter id="glow" x="-12%" y="-50%" width="124%" height="200%">
                      <feGaussianBlur in="SourceAlpha" stdDeviation="2.4" result="blur" />
                      <feFlood class="glow__light" result="light" />
                      <feComposite in="light" in2="blur" operator="in" result="halo" />
                      <feMerge>
                        <feMergeNode in="halo" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>
                  <g>
                    ${edges.map(line)}
                  </g>
                  <g>
                    ${graph.nodes.map(node)}
                  </g>
                </svg>
              </div>
              <div class="graph__tools" role="group" aria-label="Zoom" data-graph-tools hidden>
                <button class="tool" type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
                <button class="tool" type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
                <button class="tool" type="button" data-zoom="fit" title="Show all of it">Fit</button>
              </div>
              <div class="graph__card" data-graph-card aria-live="polite" hidden></div>
              ${graph.nodes.map(opens)}
            </div>
          `}
    `,
  });
}

/* ---------------------------------------------------------- an antecedent */

/**
 * The form an antecedent is added with, or with `post` changed with.
 * `creators` are the authors there are already, to be chosen from or added
 * to. What is added here is published as it is added: only those who keep
 * the corpus add to it, and there is no one to look it over.
 */
export function workPage({ session, post = null, creators = [], values, error }) {
  const editing = Boolean(post);
  const v = {
    title: post?.title || "",
    creator: post?.creator || "",
    medium: post?.medium || MEDIA[0],
    year: post?.year || "",
    link: post?.link || "",
    body: post?.body || "",
    ...curationOf(post),
    ...values,
  };
  // a work that was called something there is no longer a word for keeps the word until it is given another
  const types = MEDIA.includes(v.medium) || !v.medium ? MEDIA : [...MEDIA, v.medium];
  const heading = editing ? "Edit" : "Submit";
  return page({
    title: editing ? `Edit · ${post.title}` : "Antecedent",
    session,
    current: "submit",
    main: html`
      <h1 class="page-title page-title--form">${heading}</h1>
      <form class="form compose compose--work" method="post" action="${editing ? `/p/${post.id}/edit` : "/submit"}">
        ${csrfField(session)} ${editing && html`<input type="hidden" name="base" value="${post.updated_at}" />`}
        ${notice(error)}
        <label for="title">Title</label>
        <input id="title" name="title" value="${v.title}" maxlength="200" autocomplete="off" required />

        <div class="form__pair">
          <div>
            <label for="creator">Author</label>
            <input id="creator" name="creator" value="${v.creator}" maxlength="160" autocomplete="off" list="creators" />
            <datalist id="creators">
              ${creators.map((name) => html`<option value="${name}"></option>`)}
            </datalist>
          </div>
          <div>
            <label for="year">Date</label>
            <input id="year" name="year" value="${v.year}" maxlength="24" autocomplete="off" />
          </div>
        </div>

        <div class="form__pair">
          <div>
            <label for="medium">Type</label>
            <select id="medium" name="medium">
              ${types.map((medium) => html`<option value="${medium}" ${medium === v.medium && raw("selected")}>${medium}</option>`)}
            </select>
          </div>
          <div>
            <label for="link">Link</label>
            <input id="link" name="link" type="url" value="${v.link}" maxlength="600" autocomplete="off" placeholder="https://" />
          </div>
        </div>

        <label for="body">Annotations</label>
        <textarea id="body" name="body" rows="7" maxlength="20000" data-suggest="people articles">${v.body}</textarea>

        ${curationChecks(v)}

        <div class="compose__actions">
          <button class="button" type="submit">${post?.status === "published" ? "Save" : "Publish"}</button>
          <a class="compose__cancel" href="${editing ? `/p/${post.id}` : "/corpus"}">Cancel</a>
        </div>
      </form>
      ${editing &&
      html`<form class="compose__delete" method="post" action="/p/${post.id}/delete">
        ${csrfField(session)}
        <button class="link link--danger" type="submit" data-confirm="Delete this post for good?">Delete this post</button>
      </form>`}
    `,
  });
}
