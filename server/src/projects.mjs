/*
 * Projects: sets of pages written together.
 *
 * A project belongs to the member who started it, who chooses which other
 * members work on it. Everyone working on it can change any of its pages.
 * Nothing is ever written over: each saving of a page is kept as a numbered
 * version, and a save made from a version that somebody else has since
 * moved on from is joined with theirs (see merge.mjs) instead of replacing
 * it. Someone who would rather not change a page outright can offer their
 * wording as a suggestion, for the others to take or leave.
 */

import { db, now, transaction } from "./db.mjs";
import { changes } from "./diff.mjs";
import { merge, mergeLine, settle } from "./merge.mjs";
import { can } from "./permissions.mjs";

/* the ways a clash between two wordings can be decided */
const PICKS = new Set(["ours", "theirs", "both"]);

const PROJECT = `
  SELECT
    projects.*,
    users.name AS owner_name,
    users.username AS owner_username,
    (SELECT COUNT(*) FROM pages WHERE pages.project_id = projects.id AND pages.removed_at IS NULL)
      AS page_count,
    (SELECT COUNT(*) FROM project_members WHERE project_members.project_id = projects.id)
      AS member_count,
    (SELECT COUNT(*) FROM proposals JOIN pages ON pages.id = proposals.page_id
      WHERE pages.project_id = projects.id AND pages.removed_at IS NULL AND proposals.status = 'open')
      AS proposal_count
  FROM projects JOIN users ON users.id = projects.owner_id
`;

/* the member is the project's owner or one of those chosen to work on it */
const WORKS_ON = `(
  projects.owner_id = $user OR EXISTS (
    SELECT 1 FROM project_members
    WHERE project_members.project_id = projects.id AND project_members.user_id = $user
  )
)`;

const LATEST_FIRST = "ORDER BY projects.updated_at DESC, projects.id DESC";

export const projects = {
  byId: (id) => db.prepare(`${PROJECT} WHERE projects.id = ?`).get(id),
  /** the projects a member works on */
  of: (userId) => db.prepare(`${PROJECT} WHERE ${WORKS_ON} ${LATEST_FIRST}`).all({ user: userId }),
  /** the projects of others that every member may read */
  openTo: (userId) =>
    db.prepare(`${PROJECT} WHERE projects.open = 1 AND NOT ${WORKS_ON} ${LATEST_FIRST}`).all({ user: userId }),
  /** the projects of others that only those working on them see: for admins */
  closedTo: (userId) =>
    db.prepare(`${PROJECT} WHERE projects.open = 0 AND NOT ${WORKS_ON} ${LATEST_FIRST}`).all({ user: userId }),
  create({ ownerId, title, about = null, open = false }) {
    const at = now();
    const { lastInsertRowid } = db
      .prepare("INSERT INTO projects (owner_id, title, about, open, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ownerId, title, about, open ? 1 : 0, at, at);
    return Number(lastInsertRowid);
  },
  update: (id, { title, about = null, open }) =>
    db
      .prepare("UPDATE projects SET title = ?, about = ?, open = ?, updated_at = ? WHERE id = ?")
      .run(title, about, open ? 1 : 0, now(), id),
  /** takes the project away, with its pages, their versions, its suggestions and its conversation */
  remove: (id) => db.prepare("DELETE FROM projects WHERE id = ?").run(id),

  /** the members chosen to work on a project, besides its owner */
  people: (id) =>
    db
      .prepare(
        `SELECT users.id, users.username, users.name, users.active, project_members.created_at
         FROM project_members JOIN users ON users.id = project_members.user_id
         WHERE project_members.project_id = ? ORDER BY users.name COLLATE NOCASE`
      )
      .all(id),
  has: (id, userId) =>
    Boolean(db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(id, userId)),
  add: (id, userId, addedBy) =>
    db
      .prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)")
      .run(id, userId, addedBy, now()),
  drop: (id, userId) =>
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId),
};

/**
 * What a member is to a project: "owner", "member" (chosen to work on it),
 * "admin" (of the forum, or a sub-admin given its projects to oversee: either
 * may do what an owner may), "reader" (it is open for every member to read),
 * or null if it is not theirs to see.
 */
export function roleIn(project, user) {
  if (project.owner_id === user.id) return "owner";
  if (projects.has(project.id, user.id)) return "member";
  if (can(user, "projects")) return "admin";
  return project.open ? "reader" : null;
}

export const mayEdit = (role) => role === "owner" || role === "member" || role === "admin";
export const mayManage = (role) => role === "owner" || role === "admin";

/* ----------------------------------------------------------------- pages */

const PAGE = `
  SELECT pages.*, editor.name AS editor_name, editor.username AS editor_username,
    (SELECT COUNT(*) FROM proposals WHERE proposals.page_id = pages.id AND proposals.status = 'open')
      AS proposal_count
  FROM pages
  JOIN page_versions ON page_versions.page_id = pages.id AND page_versions.n = pages.version
  JOIN users AS editor ON editor.id = page_versions.user_id
`;

export const pages = {
  byId: (id) => db.prepare(`${PAGE} WHERE pages.id = ?`).get(id),
  /** a project's pages in the order they were begun */
  inProject: (projectId) =>
    db.prepare(`${PAGE} WHERE pages.project_id = ? AND pages.removed_at IS NULL ORDER BY pages.id`).all(projectId),
  /** the pages that were taken out of a project, latest first */
  removedFrom: (projectId) =>
    db
      .prepare(`${PAGE} WHERE pages.project_id = ? AND pages.removed_at IS NOT NULL ORDER BY pages.removed_at DESC`)
      .all(projectId),
  /** begins a page: what it says first is its version 1 */
  create({ projectId, title, body, userId }) {
    return transaction(() => {
      const at = now();
      const { lastInsertRowid } = db
        .prepare("INSERT INTO pages (project_id, title, body, version, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
        .run(projectId, title, body, userId, at, at);
      const id = Number(lastInsertRowid);
      db.prepare("INSERT INTO page_versions (page_id, n, title, body, user_id, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(
        id,
        title,
        body,
        userId,
        at
      );
      db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(at, projectId);
      return id;
    });
  },
  /** takes a page out of its project; it is kept, and can be put back */
  remove: (id, userId) =>
    db.prepare("UPDATE pages SET removed_at = ?, removed_by = ? WHERE id = ?").run(now(), userId, id),
  putBack: (id) => db.prepare("UPDATE pages SET removed_at = NULL, removed_by = NULL WHERE id = ?").run(id),
};

const VERSION = `
  SELECT page_versions.*, users.name AS editor_name, users.username AS editor_username,
    via.name AS via_name, via.username AS via_username
  FROM page_versions
  JOIN users ON users.id = page_versions.user_id
  LEFT JOIN users AS via ON via.id = page_versions.via
`;

export const pageVersions = {
  get: (pageId, n) => db.prepare(`${VERSION} WHERE page_versions.page_id = ? AND page_versions.n = ?`).get(pageId, n),
  /** every saving of a page, newest first */
  list: (pageId) => db.prepare(`${VERSION} WHERE page_versions.page_id = ? ORDER BY page_versions.n DESC`).all(pageId),
  /** what has been saved across a whole project, newest first, with the page each save was to */
  log: (projectId, limit = 300) =>
    db
      .prepare(
        `${VERSION.replace("FROM page_versions", ", pages.title AS page_title, pages.removed_at AS page_removed_at FROM page_versions JOIN pages ON pages.id = page_versions.page_id")}
         WHERE pages.project_id = ? ORDER BY page_versions.created_at DESC, page_versions.id DESC LIMIT ?`
      )
      .all(projectId, limit),
};

/**
 * Saves a wording of a page that was written from its version `base`.
 *
 * If the page is still at that version, the wording becomes its next one. If
 * others have saved since, the two are joined: what they changed and what
 * this changes are both kept. Only where both changed the same words is
 * nothing saved, and the clash is given back for someone to decide.
 *
 * `picks` decides those clashes, one of "ours", "theirs" or "both" for each
 * in order, where "ours" is this wording and "theirs" the page as it stands;
 * with a pick for every clash the save goes through.
 *
 * `userId` is whose words these are and `via` who took them in, when that is
 * someone else (a suggestion accepted). Gives back one of:
 *
 *   { version, merged }   saved as that version; merged if it was joined with others' work
 *   { version: null }     it says what the page already says, so nothing was saved
 *   { clash, against }    the merge that needs deciding, and the version of the
 *                         page it was attempted against
 */
export function land(pageId, { base, title, body, picks = null, summary = "", userId, via = null, proposalId = null }) {
  const page = pages.byId(pageId);
  const behind = base !== page.version;
  if (behind) {
    const from = pageVersions.get(pageId, base);
    if (!from) throw new RangeError("There is no such version to have written from.");
    const joined = merge(from.body, body, page.body);
    if (joined.clashes === 0) body = joined.text;
    else if (picks?.length === joined.clashes && picks.every((pick) => PICKS.has(pick))) body = settle(joined.parts, picks);
    else return { clash: joined, against: page.version };
    title = mergeLine(from.title, title, page.title);
  }
  if (body === page.body && title === page.title) return { version: null };

  const n = page.version + 1;
  const { added, removed } = changes(page.body, body);
  transaction(() => {
    const at = now();
    db.prepare(
      `INSERT INTO page_versions (page_id, n, title, body, summary, user_id, via, proposal_id, merged, added, removed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(pageId, n, title, body, summary || null, userId, via, proposalId, behind ? 1 : 0, added, removed, at);
    db.prepare("UPDATE pages SET title = ?, body = ?, version = ?, updated_at = ? WHERE id = ?").run(title, body, n, at, pageId);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(at, page.project_id);
  });
  return { version: n, merged: behind };
}

/* ----------------------------------------------------------- suggestions */

const PROPOSAL = `
  SELECT proposals.*, users.name AS author_name, users.username AS author_username,
    decider.name AS decider_name,
    pages.title AS page_title, pages.project_id, pages.version AS page_version, pages.removed_at AS page_removed_at
  FROM proposals
  JOIN users ON users.id = proposals.user_id
  JOIN pages ON pages.id = proposals.page_id
  LEFT JOIN users AS decider ON decider.id = proposals.decided_by
`;

export const proposals = {
  byId: (id) => db.prepare(`${PROPOSAL} WHERE proposals.id = ?`).get(id),
  /** the suggestions awaiting an answer on a project's pages, oldest first */
  open: (projectId) =>
    db
      .prepare(
        `${PROPOSAL} WHERE pages.project_id = ? AND pages.removed_at IS NULL AND proposals.status = 'open'
         ORDER BY proposals.id`
      )
      .all(projectId),
  /** every suggestion made on a page, newest first */
  forPage: (pageId) => db.prepare(`${PROPOSAL} WHERE proposals.page_id = ? ORDER BY proposals.id DESC`).all(pageId),
  create({ pageId, userId, base, title, body, summary = "" }) {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO proposals (page_id, user_id, base, title, body, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(pageId, userId, base, title, body, summary || null, now());
    return Number(lastInsertRowid);
  },
  /** records what became of a suggestion: 'accepted', 'declined' or 'withdrawn' */
  decide: (id, status, userId) =>
    db
      .prepare("UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'")
      .run(status, userId, now(), id),
};
