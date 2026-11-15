/*
 * Conversations.
 *
 * There are three kinds of room. The common room has every member in it. A
 * conversation is between the members who were chosen for it, two or more,
 * and the same people always find themselves in the same one. And every
 * project has a room for those working on it, where the forum also says
 * what has been done to the project.
 *
 * What is said reaches the pages that are open on a room as it is said: each
 * such page holds a connection open (see `listeners`), and is written to
 * when there is something new.
 */

import { db, now, transaction } from "./db.mjs";

const ROOM = `
  SELECT rooms.*, projects.title AS project_title, projects.owner_id AS project_owner_id
  FROM rooms LEFT JOIN projects ON projects.id = rooms.project_id
`;

/* the rooms a member is in */
const IS_IN = `(
  rooms.kind = 'common'
  OR (rooms.kind = 'direct' AND EXISTS (
    SELECT 1 FROM room_members WHERE room_members.room_id = rooms.id AND room_members.user_id = $user))
  OR (rooms.kind = 'project' AND (projects.owner_id = $user OR EXISTS (
    SELECT 1 FROM project_members
    WHERE project_members.project_id = rooms.project_id AND project_members.user_id = $user)))
)`;

/* What a member has not read in a room: what others have said since they last
   looked. The common room counts from a member's first visit, so that nobody
   arrives to find everything ever said there waiting. */
const UNREAD = `(
  SELECT COUNT(*) FROM messages
  WHERE messages.room_id = rooms.id AND messages.user_id <> $user AND messages.removed_at IS NULL
    AND messages.id > COALESCE(
      (SELECT last_id FROM room_reads WHERE room_reads.room_id = rooms.id AND room_reads.user_id = $user),
      CASE rooms.kind WHEN 'common' THEN 9223372036854775807 ELSE 0 END)
)`;

export const rooms = {
  byId: (id) => db.prepare(`${ROOM} WHERE rooms.id = ?`).get(id),
  common: () => db.prepare(`${ROOM} WHERE rooms.kind = 'common'`).get(),

  /** a project's room, made the first time it is asked for */
  forProject(projectId) {
    const find = () => db.prepare(`${ROOM} WHERE rooms.project_id = ?`).get(projectId);
    const room = find();
    if (room) return room;
    db.prepare("INSERT INTO rooms (kind, project_id, created_at) VALUES ('project', ?, ?)").run(projectId, now());
    return find();
  },

  /** the conversation between exactly these members, begun if they have none yet */
  between(userIds, createdBy) {
    const ids = [...new Set(userIds)].sort((a, b) => a - b);
    const key = ids.join("-");
    const find = () => db.prepare(`${ROOM} WHERE rooms.kind = 'direct' AND rooms.key = ?`).get(key);
    return (
      find() ||
      transaction(() => {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO rooms (kind, key, created_by, created_at) VALUES ('direct', ?, ?, ?)")
          .run(key, createdBy, now());
        const add = db.prepare("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)");
        for (const id of ids) add.run(Number(lastInsertRowid), id);
        return find();
      })
    );
  },

  /** who is in a room, by name; for the common room that is everyone, and not listed */
  people(room) {
    if (room.kind === "direct")
      return db
        .prepare(
          `SELECT users.id, users.username, users.name, users.active FROM room_members
           JOIN users ON users.id = room_members.user_id
           WHERE room_members.room_id = ? ORDER BY users.name COLLATE NOCASE`
        )
        .all(room.id);
    if (room.kind === "project")
      return db
        .prepare(
          `SELECT users.id, users.username, users.name, users.active FROM users
           WHERE users.id = (SELECT owner_id FROM projects WHERE id = ?)
              OR users.id IN (SELECT user_id FROM project_members WHERE project_id = ?)
           ORDER BY users.name COLLATE NOCASE`
        )
        .all(room.project_id, room.project_id);
    return [];
  },

  /** whether a member is in a room */
  has: (room, userId) =>
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM rooms LEFT JOIN projects ON projects.id = rooms.project_id
           WHERE rooms.id = $room AND ${IS_IN}`
        )
        .get({ room: room.id, user: userId })
    ),

  /**
   * The rooms a member is in, the one most lately spoken in first, each with
   * how much of it they have not read and the last thing said there.
   */
  of(userId) {
    const list = db
      .prepare(
        `SELECT rooms.*, projects.title AS project_title, projects.owner_id AS project_owner_id,
           ${UNREAD} AS unread,
           (SELECT MAX(id) FROM messages WHERE messages.room_id = rooms.id AND messages.removed_at IS NULL) AS last_id
         FROM rooms LEFT JOIN projects ON projects.id = rooms.project_id
         WHERE ${IS_IN} ORDER BY last_id IS NULL, last_id DESC, rooms.id`
      )
      .all({ user: userId });
    const last = db.prepare(
      `SELECT messages.body, messages.kind, messages.created_at, users.name AS author_name
       FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?`
    );
    return list.map((room) => ({
      ...room,
      people: rooms.people(room),
      last: room.last_id ? last.get(room.last_id) : null,
    }));
  },

  /** how much, in all their rooms together, a member has not read */
  unread: (userId) =>
    db
      .prepare(`SELECT COALESCE(SUM(${UNREAD}), 0) AS n FROM rooms LEFT JOIN projects ON projects.id = rooms.project_id WHERE ${IS_IN}`)
      .get({ user: userId }).n,

  /** notes that a member has read a room as far as its latest message */
  markRead(roomId, userId) {
    db.prepare(
      `INSERT INTO room_reads (room_id, user_id, last_id)
       VALUES ($room, $user, COALESCE((SELECT MAX(id) FROM messages WHERE room_id = $room), 0))
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_id = excluded.last_id`
    ).run({ room: roomId, user: userId });
  },
};

const MESSAGE = `
  SELECT messages.*, users.name AS author_name, users.username AS author_username
  FROM messages JOIN users ON users.id = messages.user_id
`;

export const messages = {
  byId: (id) => db.prepare(`${MESSAGE} WHERE messages.id = ?`).get(id),
  /** the latest messages of a room, oldest first; with `before`, the ones that came before that one */
  latest: (roomId, limit, before = null) =>
    db
      .prepare(
        `${MESSAGE} WHERE messages.room_id = ? AND (? IS NULL OR messages.id < ?)
         ORDER BY messages.id DESC LIMIT ?`
      )
      .all(roomId, before, before, limit)
      .reverse(),
  /** what has been said in a room since a message, oldest first */
  since: (roomId, id, limit = 200) =>
    db.prepare(`${MESSAGE} WHERE messages.room_id = ? AND messages.id > ? ORDER BY messages.id LIMIT ?`).all(roomId, id, limit),
  /** whether a room has anything earlier than a message */
  anyBefore: (roomId, id) =>
    Boolean(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND id < ? LIMIT 1").get(roomId, id)),
  /** `kind` "event" is the forum's own word of something `userId` did, and `link` where it leads */
  create({ roomId, userId, body, kind = "said", link = null }) {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO messages (room_id, user_id, kind, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(roomId, userId, kind, body, link, now());
    return Number(lastInsertRowid);
  },
  /** a removed message keeps its place, emptied */
  remove: (id, userId) =>
    db.prepare("UPDATE messages SET removed_at = ?, removed_by = ? WHERE id = ?").run(now(), userId, id),
};

/* ----------------------------------------------------- pages listening in */

/* for each room, the pages that are open on it: { user, write(event, data, id) } */
const listeners = new Map();

/** adds a page to those told what happens in a room; gives back how to take it away again */
export function listen(roomId, listener) {
  if (!listeners.has(roomId)) listeners.set(roomId, new Set());
  listeners.get(roomId).add(listener);
  return () => {
    listeners.get(roomId)?.delete(listener);
    if (listeners.get(roomId)?.size === 0) listeners.delete(roomId);
  };
}

/** the pages open on a room at this moment */
export const listening = (roomId) => [...(listeners.get(roomId) || [])];

/** how many pages one member has listening, over all rooms */
export function listeningAs(userId) {
  let count = 0;
  for (const set of listeners.values()) for (const listener of set) if (listener.userId === userId) count += 1;
  return count;
}

/** lets go of every page that is listening, so that the server can stop */
export function hangUp() {
  for (const set of listeners.values()) for (const listener of set) listener.end();
  listeners.clear();
}
