/*
 * What ties the forum's writing together: links from one article to another,
 * members tagging each other, the versions a post has been through, and the
 * graph drawn from all of it.
 *
 * The text of posts and notes is the source of truth. What is kept in the
 * database beside it (the links and mentions tables, the drawings) is an
 * index of it, brought up to date here whenever something is saved.
 */

import { config } from "./config.mjs";
import { activity, links, mentions, posts, revisions, transaction, users } from "./db.mjs";
import { changes } from "./diff.mjs";
import { tellOfTag } from "./push.mjs";
import { diagrams, excerpt, references, taggedIn, useLookup } from "./render.mjs";
import { draw, drawn } from "./tex.mjs";
import { byline, typeOf } from "./works.mjs";

// from here on, [[Title]] and @name in posts and notes resolve against the
// database, and diagrams are shown as they have been drawn
useLookup({
  post: (title) => posts.byTitle(title) ?? null,
  member(name) {
    const user = users.byUsername(name);
    return user ? { id: user.id, username: user.username, name: user.name } : null;
  },
  drawing: drawn,
  origin: config.publicUrl,
});

/**
 * Sees that the diagrams in a text are drawn, to be awaited before the text
 * is shown. With `keep` false they are drawn for a preview and not kept.
 * Only so many are drawn in one text, so that no page can keep LaTeX busy for
 * long; any past that are shown as their source.
 */
export async function prepare(body, { keep = true } = {}) {
  await Promise.all(
    diagrams(body)
      .slice(0, config.maxDiagrams)
      .map((source) => draw(source, { keep }))
  );
}

/**
 * Brings the index of links up to date. After post `id` was saved or deleted,
 * that post is read again, and so is every post that links by title, since a
 * title may now lead somewhere else. Without an id, every post is read.
 */
export function indexLinks(id = null) {
  transaction(() => {
    for (const post of links.sources(id)) links.replace(post.id, references(post.body).posts);
  });
}

/**
 * To be called when a post has been written or changed: `by` is the member
 * who saved it, and `summary` their line on what changed. Gives back the
 * number of the version this made, or null if it made none.
 */
export function postSaved(id, { by, summary = "" } = {}) {
  indexLinks(id);
  const post = posts.byId(id);
  // a draft tags no one yet, and nobody tags themselves
  const tagged =
    post.status === "published" ? references(post.body).members.filter((userId) => userId !== post.author_id) : [];
  let fresh = [];
  const version = transaction(() => {
    fresh = mentions.set({ postId: post.id, byUserId: post.author_id, userIds: tagged });
    return post.status === "published" ? keepVersion(post, { by: by ?? post.author_id, summary }) : null;
  });
  // those tagged for the first time are told on their devices, where they have asked to be
  tellOfTag(fresh, { by: post.author_name, where: `in ${post.title || excerpt(post.body, 60)}`, url: `/p/${post.id}` });
  return version;
}

/**
 * Every wording a post is published with is kept as a version: the first
 * when it is published, and another each time it is saved with its title or
 * text changed. A draft is nobody's business yet and leaves no versions.
 */
function keepVersion(post, { by, summary }) {
  const latest = revisions.latest(post.id);
  if (latest && latest.title === post.title && latest.body === post.body) return null;
  const { added = null, removed = null } = latest ? changes(latest.body, post.body) : {};
  return revisions.add({
    postId: post.id,
    title: post.title,
    body: post.body,
    summary: summary || null,
    userId: by,
    added,
    removed,
  });
}

/** to be called when a margin note or reply has been added or reworded */
export function noteSaved({ id, postId, userId, body }) {
  const tagged = taggedIn(body).filter((taggedId) => taggedId !== userId);
  const fresh = mentions.set({ noteId: id, postId, byUserId: userId, userIds: tagged });
  if (fresh.length === 0) return;
  const post = posts.byId(postId);
  // a note on a draft is seen by no one yet
  if (post?.status !== "published") return;
  tellOfTag(fresh, {
    by: users.byId(userId)?.name || "Someone",
    where: `in a note on ${post.title || excerpt(post.body, 60)}`,
    url: `/p/${postId}#note-${id}`,
    words: body,
  });
}

/* ------------------------------------------------------------ the corpus */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* how many browns the titles of the works are lettered in */
const BARKS = 5;

/**
 * The corpus as nodes and the edges between them. It has two layers. The
 * succession: what has been written here, with the essay it is all drawn
 * around marked `main`. And the antecedents: the works that writing descends
 * from. A work is a post like any other, so the same edges run to and from
 * it:
 *
 *   wrote        member -> post (for a work: who added it)
 *   commentary   post -> the post it answers
 *   link         post -> a post its text links to
 *   note         member -> a post of someone else's they have annotated
 *   address      member - member: one has replied to the other, or tagged them
 *   descent      work -> the main essay
 *
 * The whole corpus is drawn without its edges, each title where its keeper
 * has set it; they are what a part of it is found by, and drawn with.
 *
 * `written` and `antecedents` say which layers are wanted; the main essay is
 * there either way. With `people`, the members too. A node with `canon` is
 * of the canon: a piece the main admin wrote, or that admin.
 *
 * A piece's node says besides how it is to be drawn: `tone`, the colour of
 * one written here where it is not the green they all are, and `hand`, the
 * letter set after its title; for a work `extent`, the type of thing it is,
 * and `by`, whose it is and that type together; and for either `showTell`,
 * `annotation`, what opens where its title is chosen, `order`, where its
 * keeper lists it, and `place`, where its keeper has set it on the corpus,
 * if anywhere. Who wrote a piece here, and who added a work, the corpus does
 * not say.
 */
export function graphData({ people = false, written = true, antecedents = true } = {}) {
  const published = activity.posts();
  const linked = activity.links();
  const byId = new Map(published.map((post) => [post.id, post]));
  const names = new Map(activity.people().map((user) => [user.id, user]));
  const centre = posts.centre();
  const isWork = (post) => post.kind === "work";

  const answers = new Map();
  const linksIn = new Map();
  const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
  for (const post of published) if (post.parent_id) bump(answers, post.parent_id);
  for (const { to_post } of linked) bump(linksIn, to_post);

  // the works in the order their keeper lists them
  const works = published.filter(isWork).sort((a, b) => a.position - b.position || b.id - a.id);

  const said = activity.notes();
  const counts = {
    posts: published.filter((post) => !isWork(post) && !post.parent_id).length,
    commentaries: published.filter((post) => !isWork(post) && post.parent_id).length,
    canon: published.filter((post) => post.canon).length,
    works: works.length,
    showTell: published.filter((post) => post.show_tell).length,
    notes: said.reduce((sum, row) => sum + row.n, 0),
    links: linked.length,
    people: 0,
  };

  const shown = (post) => (isWork(post) ? antecedents : written || post.id === centre?.id);
  const nodes = [];
  const edges = [];
  const about = (post) =>
    [
      post.said > 0 && plural(post.said, "note or reply", "notes and replies"),
      answers.get(post.id) && plural(answers.get(post.id), "commentary", "commentaries"),
      linksIn.get(post.id) && `linked from ${plural(linksIn.get(post.id), "article")}`,
    ].filter(Boolean);
  const weight = (post) => post.said + 2 * (answers.get(post.id) || 0) + 2 * (linksIn.get(post.id) || 0);
  const placeOf = (post) => (post.corpus_x === null || post.corpus_y === null ? null : { x: post.corpus_x, y: post.corpus_y });

  for (const post of published) {
    if (isWork(post) || !shown(post)) continue;
    const kind = post.parent_id ? "commentary" : post.title ? "article" : "post";
    const full = post.title || excerpt(post.opening, 70);
    const main = post.id === centre?.id;
    nodes.push({
      id: `p${post.id}`,
      kind,
      // what the main admin wrote is the canon, and is drawn in gilt
      canon: Boolean(post.canon),
      main,
      href: `/p/${post.id}`,
      label: post.title || excerpt(post.opening, 26),
      name: full,
      tone: post.tone || "",
      hand: post.hand || "",
      showTell: Boolean(post.show_tell),
      annotation: post.annotation || "",
      order: post.position,
      place: placeOf(post),
      detail: [
        `${full} — ${kind === "commentary" ? "a commentary" : kind === "article" ? "an article" : "a short post"}`,
        main && "At the centre of the corpus",
        ...about(post),
      ]
        .filter(Boolean)
        .join(" · "),
      weight: weight(post),
    });
    if (post.parent_id) edges.push({ kind: "commentary", from: `p${post.id}`, to: `p${post.parent_id}`, n: 1 });
  }

  if (antecedents) {
    for (const work of works) {
      const by = byline(work);
      nodes.push({
        id: `p${work.id}`,
        kind: "work",
        canon: false,
        main: false,
        href: `/p/${work.id}`,
        label: work.title,
        name: work.title,
        by,
        extent: typeOf(work.medium),
        showTell: Boolean(work.show_tell),
        annotation: work.annotation || "",
        order: work.position,
        place: placeOf(work),
        // one of the browns of bark, which is always the same one for the same work
        bark: work.id % BARKS,
        detail: [work.title, by].filter(Boolean).join(" — "),
        weight: weight(work),
      });
      if (centre) edges.push({ kind: "descent", from: `p${work.id}`, to: `p${centre.id}`, n: 1 });
    }
  }

  for (const { from_post, to_post } of linked)
    if (shown(byId.get(from_post)) && shown(byId.get(to_post)))
      edges.push({ kind: "link", from: `p${from_post}`, to: `p${to_post}`, n: 1 });

  // the people are worked out either way, to be counted
  const personEdges = [];
  const wrote = new Map();
  const noted = new Map();
  const taking = new Set();
  for (const post of published) {
    taking.add(post.author_id);
    bump(wrote, post.author_id);
    if (shown(post)) personEdges.push({ kind: "wrote", from: `u${post.author_id}`, to: `p${post.id}`, n: 1 });
  }
  for (const row of said) {
    taking.add(row.user_id);
    bump(noted, row.user_id, row.n);
    const post = byId.get(row.post_id);
    if (post.author_id !== row.user_id && shown(post))
      personEdges.push({ kind: "note", from: `u${row.user_id}`, to: `p${row.post_id}`, n: row.n });
  }
  // replies and tags in either direction make one line between two people
  const spoken = new Map();
  for (const row of [...activity.replies(), ...activity.tags()]) {
    const [a, b] = [row.from_user, row.to_user].sort((x, y) => x - y);
    bump(spoken, `${a}-${b}`, row.n);
  }
  for (const [pair, n] of spoken) {
    const [a, b] = pair.split("-");
    taking.add(Number(a)).add(Number(b));
    personEdges.push({ kind: "address", from: `u${a}`, to: `u${b}`, n });
  }
  counts.people = taking.size;

  if (people) {
    for (const id of [...taking].sort((a, b) => a - b)) {
      const user = names.get(id);
      const of = [
        user.main && "Main admin, whose writing is the canon",
        wrote.get(id) && plural(wrote.get(id), "post"),
        noted.get(id) && plural(noted.get(id), "note or reply", "notes and replies"),
      ].filter(Boolean);
      nodes.push({
        id: `u${id}`,
        kind: "person",
        canon: Boolean(user.main),
        main: false,
        href: `/m/${encodeURIComponent(user.username)}`,
        label: user.name,
        name: user.name,
        detail: [user.name, ...of].join(" · "),
        weight: 0,
      });
    }
    edges.push(...personEdges);
  }

  return { nodes, edges, counts, centre: centre ? `p${centre.id}` : null };
}

/**
 * The part of a graph within `reach` steps of the node `around`: that node,
 * what it touches, what those touch, and so on; with `reach` Infinity,
 * everything connected to it at all. Null if the graph has no such node.
 */
export function neighbourhood({ nodes, edges }, around, reach = 1) {
  if (!nodes.some((node) => node.id === around)) return null;
  const beside = new Map();
  const join = (a, b) => (beside.get(a) || beside.set(a, []).get(a)).push(b);
  for (const edge of edges) {
    join(edge.from, edge.to);
    join(edge.to, edge.from);
  }
  const within = new Set([around]);
  let rim = [around];
  for (let step = 0; step < reach && rim.length > 0; step++) {
    const next = [];
    for (const id of rim) {
      for (const other of beside.get(id) || []) {
        if (within.has(other)) continue;
        within.add(other);
        next.push(other);
      }
    }
    rim = next;
  }
  return {
    nodes: nodes.filter((node) => within.has(node.id)),
    edges: edges.filter((edge) => within.has(edge.from) && within.has(edge.to)),
  };
}
