/*
 * Finding things: what is published in the journal, the notes in its
 * margins, and the pages of the projects a member may read.
 *
 * A search is a few words, all of which must be there, in any order and
 * whatever their capitals. Only what the member asking could open anyway is
 * ever found: no drafts, nothing removed, no project that is not theirs to
 * see.
 */

import { config } from "./config.mjs";
import { db } from "./db.mjs";
import { can } from "./permissions.mjs";
import { excerpt } from "./render.mjs";

const MOST_WORDS = 6;
const MOST_FOUND = 30;

/** the words of a search: what was typed, without its space, a word at most once, and only so many */
export function wordsOf(query) {
  const words = String(query || "")
    .slice(0, config.maxSearchLength)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(words)].slice(0, MOST_WORDS);
}

/* a word as LIKE takes it, with what LIKE would read as a wildcard made plain */
const like = (word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`;

/** SQL that holds when every word is in one of `columns`, and what to fill it in with */
function every(words, columns) {
  const one = `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
  return {
    sql: words.map(() => one).join(" AND "),
    values: words.flatMap((word) => columns.map(() => like(word))),
  };
}

const lower = (text) => String(text || "").toLowerCase();
const hasAll = (text, words) => words.every((word) => lower(text).includes(word));

/**
 * The stretch of a text where the words are, as pieces: { text, hit } where
 * `hit` marks a word that was searched for. The text is cut at words, a
 * little before the first of them and some way after.
 */
export function passage(text, words, { before = 70, length = 230 } = {}) {
  const plain = String(text || "").replace(/\s+/g, " ").trim();
  const low = plain.toLowerCase();
  const first = Math.min(...words.map((word) => low.indexOf(word)).filter((at) => at !== -1), Infinity);
  let start = 0;
  if (Number.isFinite(first) && first > before) {
    start = first - before;
    const space = plain.indexOf(" ", start);
    start = space !== -1 && space < first ? space + 1 : start;
  }
  let end = Math.min(plain.length, start + length);
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > start + length * 0.6) end = space;
  }
  const shown = plain.slice(start, end);
  const lowShown = shown.toLowerCase();

  // where the words fall in what is shown; where two overlap, the earlier and longer stands
  const hits = [];
  for (const word of words) {
    for (let at = lowShown.indexOf(word); at !== -1; at = lowShown.indexOf(word, at + word.length))
      hits.push([at, at + word.length]);
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const pieces = [];
  let at = 0;
  for (const [from, to] of hits) {
    if (from < at) continue;
    if (from > at) pieces.push({ text: shown.slice(at, from), hit: false });
    pieces.push({ text: shown.slice(from, to), hit: true });
    at = to;
  }
  if (at < shown.length) pieces.push({ text: shown.slice(at), hit: false });
  if (start > 0) pieces.unshift({ text: "… ", hit: false });
  if (end < plain.length) pieces.push({ text: " …", hit: false });
  return pieces;
}

/**
 * Everything a search finds for a member: `posts` (in the journal), `notes`
 * (margin notes and replies) and `pages` (of projects), each newest first
 * with those whose title has the words before the rest. Each has `passage`,
 * the part of its text to show.
 */
export function find(query, user) {
  const words = wordsOf(query);
  if (words.join("").length < 2) return { words, posts: [], notes: [], pages: [], short: words.length > 0 };

  const titled = (rows) => {
    // the text is searched as it reads, so that words of its markup are not what is shown
    for (const row of rows) {
      row.passage = passage(excerpt(row.body, 200_000), words);
      row.inTitle = Boolean(row.title) && hasAll(row.title, words);
      delete row.body;
    }
    return rows.sort((a, b) => Number(b.inTitle) - Number(a.inTitle));
  };

  const inPosts = every(words, ["COALESCE(posts.title, '')", "posts.body"]);
  const posts = titled(
    db
      .prepare(
        `SELECT posts.id, posts.title, posts.body, posts.published_at, posts.parent_id,
                users.name AS author_name, users.username AS author_username
         FROM posts JOIN users ON users.id = posts.author_id
         WHERE posts.status = 'published' AND ${inPosts.sql}
         ORDER BY posts.published_at DESC, posts.id DESC LIMIT ?`
      )
      .all(...inPosts.values, MOST_FOUND)
  );

  const inNotes = every(words, ["notes.body"]);
  const notes = db
    .prepare(
      `SELECT notes.id, notes.post_id, notes.parent_id, notes.body, notes.created_at,
              users.name AS author_name, posts.title AS post_title, substr(posts.body, 1, 240) AS post_opening
       FROM notes
       JOIN posts ON posts.id = notes.post_id
       JOIN users ON users.id = notes.user_id
       WHERE notes.removed_at IS NULL AND posts.status = 'published' AND ${inNotes.sql}
       ORDER BY notes.created_at DESC, notes.id DESC LIMIT ?`
    )
    .all(...inNotes.values, MOST_FOUND);
  for (const note of notes) {
    note.passage = passage(note.body, words);
    delete note.body;
  }

  // a project's pages are for those working on it, for every member if it is open, and for whoever oversees the projects
  const inPages = every(words, ["pages.title", "pages.body"]);
  const pages = titled(
    db
      .prepare(
        `SELECT pages.id, pages.title, pages.body, pages.updated_at,
                projects.id AS project_id, projects.title AS project_title
         FROM pages JOIN projects ON projects.id = pages.project_id
         WHERE pages.removed_at IS NULL
           AND (projects.open = 1 OR ? = 1 OR projects.owner_id = ? OR EXISTS (
             SELECT 1 FROM project_members
             WHERE project_members.project_id = projects.id AND project_members.user_id = ?))
           AND ${inPages.sql}
         ORDER BY pages.updated_at DESC, pages.id DESC LIMIT ?`
      )
      .all(can(user, "projects") ? 1 : 0, user.id, user.id, ...inPages.values, MOST_FOUND)
  );

  return { words, posts, notes, pages, short: false, most: MOST_FOUND };
}
