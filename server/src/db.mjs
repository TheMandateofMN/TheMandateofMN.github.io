/*
 * The database: one SQLite file, opened with Node's built-in driver.
 *
 * Schema changes are appended to MIGRATIONS and never edited in place; the
 * file records how many it has applied in PRAGMA user_version.
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- a post without a title is a short text; with one, an article
  CREATE TABLE posts (
    id           INTEGER PRIMARY KEY,
    author_id    INTEGER NOT NULL REFERENCES users (id),
    title        TEXT,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
    created_at   TEXT NOT NULL,
    published_at TEXT,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX posts_feed ON posts (status, published_at);

  -- quote is the passage a note refers to; quote_pos is how many non-space
  -- characters into the post it began, to tell repeated phrases apart
  CREATE TABLE notes (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    body       TEXT NOT NULL,
    quote      TEXT,
    quote_pos  INTEGER,
    created_at TEXT NOT NULL,
    removed_at TEXT,
    removed_by INTEGER REFERENCES users (id)
  );
  CREATE INDEX notes_post ON notes (post_id, created_at);
  `,
  `
  -- a reply hangs from the note that opened its thread; threads are one level deep
  ALTER TABLE notes ADD COLUMN parent_id INTEGER REFERENCES notes (id) ON DELETE CASCADE;
  CREATE INDEX notes_parent ON notes (parent_id);
  `,
  `
  -- a commentary is a post written in answer to another. If that one is
  -- deleted, the commentary is kept and stands by itself.
  ALTER TABLE posts ADD COLUMN parent_id INTEGER REFERENCES posts (id) ON DELETE SET NULL;
  CREATE INDEX posts_parent ON posts (parent_id);

  -- which post links to which in its text; rebuilt from the posts themselves
  CREATE TABLE links (
    from_post INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    to_post   INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    PRIMARY KEY (from_post, to_post)
  ) WITHOUT ROWID;
  CREATE INDEX links_to ON links (to_post);

  -- who was tagged, by whom, and where: in a post's own text (note_id is
  -- null) or in a margin note or reply on it
  CREATE TABLE mentions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    by_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    note_id    INTEGER REFERENCES notes (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mentions_user ON mentions (user_id, created_at);
  CREATE INDEX mentions_post ON mentions (post_id);

  -- when a member last looked at where they were tagged
  ALTER TABLE users ADD COLUMN mentions_seen_at TEXT;
  `,
  `
  -- every wording a post has been published with, numbered from 1; posts
  -- holds the current one. added and removed count the words that changed
  -- since the version before.
  CREATE TABLE revisions (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    n          INTEGER NOT NULL,
    title      TEXT,
    body       TEXT NOT NULL,
    summary    TEXT,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    added      INTEGER,
    removed    INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (post_id, n)
  );
  -- what was published before versions were kept begins at version 1, as it stands
  INSERT INTO revisions (post_id, n, title, body, user_id, created_at)
    SELECT id, 1, title, body, author_id, updated_at FROM posts WHERE status = 'published';

  -- the version of the post a note was made on, so a passage that has since
  -- been rewritten can still be found where it stood
  ALTER TABLE notes ADD COLUMN version INTEGER;
  UPDATE notes SET version = 1 WHERE post_id IN (SELECT post_id FROM revisions);

  -- a note can be reworded by its author; what it said before is kept, with
  -- when each wording was written
  ALTER TABLE notes ADD COLUMN edited_at TEXT;
  CREATE TABLE note_revisions (
    id         INTEGER PRIMARY KEY,
    note_id    INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX note_revisions_note ON note_revisions (note_id);

  -- pictures members have uploaded; the files themselves are in the media folder
  CREATE TABLE media (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    type       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    original   TEXT,
    created_at TEXT NOT NULL
  );

  -- LaTeX diagrams, drawn once and kept under a hash of their source: either
  -- the drawing, or what went wrong when it was attempted
  CREATE TABLE drawings (
    hash       TEXT PRIMARY KEY,
    svg        TEXT,
    width      REAL,
    height     REAL,
    error      TEXT,
    created_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  -- a project is a set of pages written together by its owner and the
  -- members the owner has chosen. With open = 1 every member may read it and
  -- suggest changes; otherwise only those working on it see it.
  CREATE TABLE projects (
    id         INTEGER PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users (id),
    title      TEXT NOT NULL,
    about      TEXT,
    open       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_members (
    project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    added_by   INTEGER REFERENCES users (id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX project_members_user ON project_members (user_id);

  -- a project's pages hold their current wording; a page taken out of the
  -- project is kept, with removed_at set, so that it can be put back
  CREATE TABLE pages (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users (id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    removed_by INTEGER REFERENCES users (id)
  );
  CREATE INDEX pages_project ON pages (project_id);

  -- a suggestion is a wording of a page offered by someone for those working
  -- on the project to take or leave; base is the version it was written from
  CREATE TABLE proposals (
    id         INTEGER PRIMARY KEY,
    page_id    INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    base       INTEGER NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    summary    TEXT,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'withdrawn')),
    decided_by INTEGER REFERENCES users (id),
    decided_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX proposals_page ON proposals (page_id);

  -- every saving of a page, numbered from 1. user_id is whose words they
  -- are; via is who took them in, for a suggestion that was accepted; merged
  -- is set when the save was joined with one somebody else made meanwhile.
  CREATE TABLE page_versions (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    n           INTEGER NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    summary     TEXT,
    user_id     INTEGER NOT NULL REFERENCES users (id),
    via         INTEGER REFERENCES users (id),
    proposal_id INTEGER REFERENCES proposals (id) ON DELETE SET NULL,
    merged      INTEGER NOT NULL DEFAULT 0,
    added       INTEGER,
    removed     INTEGER,
    created_at  TEXT NOT NULL,
    UNIQUE (page_id, n)
  );

  -- places to talk: the one room everybody is in, conversations between the
  -- members who were chosen for them (key is their ids in order, so the same
  -- people always find the same conversation), and one room for each project
  CREATE TABLE rooms (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('common', 'direct', 'project')),
    key        TEXT UNIQUE,
    project_id INTEGER UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users (id),
    created_at TEXT NOT NULL
  );
  INSERT INTO rooms (kind, key, created_at) VALUES ('common', 'common', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  CREATE TABLE room_members (
    room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id),
    PRIMARY KEY (room_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX room_members_user ON room_members (user_id);

  -- what was said. kind 'event' is the forum's own word of something done in
  -- a project (someone added, a change suggested), with where it leads.
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id),
    kind       TEXT NOT NULL DEFAULT 'said' CHECK (kind IN ('said', 'event')),
    body       TEXT NOT NULL,
    link       TEXT,
    removed_at TEXT,
    removed_by INTEGER REFERENCES users (id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_room ON messages (room_id, id);

  -- how far each member has read in each room
  CREATE TABLE room_reads (
    room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id),
    last_id INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  ) WITHOUT ROWID;
  `,

  // 6: things about the forum as a whole that can be set, such as who its main admin is
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,

  // 7: how each member has the pages look, and what lets them and the admins see where they are signed in
  `
  -- 'night' is the dark page, 'paper' the light one
  ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'night' CHECK (theme IN ('night', 'paper'));
  ALTER TABLE users ADD COLUMN signed_in_at TEXT;

  -- when a session was last used, and what kind of browser it is in
  ALTER TABLE sessions ADD COLUMN seen_at TEXT;
  ALTER TABLE sessions ADD COLUMN agent TEXT;

  -- what is known of the sessions there already: when each began, which is the latest its member signed in
  UPDATE sessions SET seen_at = created_at;
  UPDATE users SET signed_in_at = (SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id);
  `,

  // 8: sub-admins, who are members an admin has given some of what an admin may do
  `
  -- the permissions a member holds, as their keys with spaces between (see
  -- src/permissions.mjs); a member with any is a sub-admin. An admin needs
  -- none, and what is here is not looked at for one.
  ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '';
  `,

  // 9: a record of what was done to members, and by whom
  `
  -- each thing an admin or a sub-admin did to a member: added, given a new
  -- password, removed, restored, made or unmade an admin or sub-admin. by_id
  -- is who did it, and is null for what was done from the server itself, by
  -- the admin portal or the command line. No password is ever written here.
  CREATE TABLE admin_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    by_id     INTEGER REFERENCES users (id),
    action    TEXT NOT NULL,
    member_id INTEGER REFERENCES users (id),
    detail    TEXT
  );
  `,

  // 10: notifications on a member's own devices
  `
  -- what a member has chosen to be told of, as keys with spaces between (see src/push.mjs)
  ALTER TABLE users ADD COLUMN notify TEXT NOT NULL DEFAULT 'direct project tags words';

  -- What a browser subscribed with: its address at a push service, and the keys what is sent
  -- there is encrypted to. It belongs to the session it was made in, and goes when that ends.
  CREATE TABLE push_subscriptions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL REFERENCES sessions (token_hash) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    failures     INTEGER NOT NULL DEFAULT 0,
    told_at      TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
  CREATE INDEX push_subscriptions_session ON push_subscriptions (session_hash);
  `,

  // 11: the corpus has two layers, and paper is the page everyone begins on
  `
  -- A post is a piece of 'writing', or a 'work': a book, a film, anything made elsewhere that
  -- the writing here descends from. A work is a post like any other, with notes in its margin
  -- and commentaries on it. Its title is the work's and its text is what is said for it; these
  -- say whose it is, what kind of thing, when it was made, where it is to be found, and the
  -- lineage it is set in.
  ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'writing' CHECK (kind IN ('writing', 'work'));
  ALTER TABLE posts ADD COLUMN creator TEXT;
  ALTER TABLE posts ADD COLUMN medium TEXT;
  ALTER TABLE posts ADD COLUMN year TEXT;
  ALTER TABLE posts ADD COLUMN link TEXT;
  ALTER TABLE posts ADD COLUMN lineage TEXT COLLATE NOCASE;
  CREATE INDEX posts_lineage ON posts (kind, lineage);

  -- Paper is what a member reads on unless they choose night. Night was what everyone was given
  -- before, so its being on an account says nothing of that member having chosen it.
  UPDATE users SET theme = 'paper';
  `,

  // 12: what the corpus says of a piece besides its words
  `
  -- A few words on a piece, kept folded away on the corpus until its title is chosen: for a work,
  -- where it is strong and where it falls short; for the essay at the centre, its claims as a list.
  ALTER TABLE posts ADD COLUMN annotation TEXT;
  -- a work that both shows and tells: marked on the corpus only when that is asked for
  ALTER TABLE posts ADD COLUMN show_tell INTEGER NOT NULL DEFAULT 0;
  -- a piece meant for the wider public as well as for those who sign in
  ALTER TABLE posts ADD COLUMN missionaria INTEGER NOT NULL DEFAULT 0;
  -- How a piece written here is coloured on the corpus, where it is not the green they all are:
  -- 'light' is the lighter green, 'graft' the brown and green of one grafted onto an earlier work.
  ALTER TABLE posts ADD COLUMN tone TEXT NOT NULL DEFAULT '' CHECK (tone IN ('', 'light', 'graft'));
  -- a letter set above the end of a title to say whose a piece is, where no author is named
  ALTER TABLE posts ADD COLUMN hand TEXT;
  `,

  // 13: those who are invited by a text to their telephone, and what they are sent
  `
  -- Someone the main admin means to invite, in the order they were put down. The number is kept
  -- sealed (see numbers.mjs), and beside it a keyed mark of it, by which the same number is known
  -- again without being read. user_id is their account, once they have taken it up.
  CREATE TABLE contacts (
    id          INTEGER PRIMARY KEY,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    number      TEXT NOT NULL,
    number_mark TEXT NOT NULL UNIQUE,
    user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    -- how many times they have been written to about the account that waits for them, and when last
    told        INTEGER NOT NULL DEFAULT 0,
    told_at     TEXT,
    -- when they took the account up by choosing a password
    accepted_at TEXT,
    -- when the time they were given to take it up ran out
    lapsed_at   TEXT,
    -- when the carrier said they have asked to be sent nothing more
    stopped_at  TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX contacts_by_position ON contacts (position, id);
  CREATE INDEX contacts_by_user ON contacts (user_id);

  -- The link someone is sent, by which they take up the account that waits for them. Only a hash
  -- of it is kept. The account itself is made when they take it up: until then there is nothing
  -- of theirs among the members, and when the link runs out there is nothing to delete but this.
  CREATE TABLE invitations (
    token_hash TEXT PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX invitations_by_contact ON invitations (contact_id);

  -- Every text that was sent or could not be: to whom, about what, and how it went. Neither the
  -- number nor the words are kept here.
  CREATE TABLE texts (
    id         INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('invite', 'piece')),
    post_id    INTEGER REFERENCES posts (id) ON DELETE SET NULL,
    ok         INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX texts_by_contact ON texts (contact_id, id);
  CREATE INDEX texts_by_post ON texts (post_id, contact_id);

  -- which texts a member has asked for about what is published: 'all', 'some', both or neither
  ALTER TABLE users ADD COLUMN texts TEXT NOT NULL DEFAULT '';
  `,

  // 14: what the main admin sends from here to group chats kept elsewhere, on Signal and WhatsApp
  `
  -- A group chat on another service that what is sent from here can go to. The account it is
  -- reached through is linked to this server as one more of its owner's devices, and what that
  -- takes is kept beside the database, not in it. 'address' is what the service calls the group.
  CREATE TABLE outside_chats (
    id         INTEGER PRIMARY KEY,
    platform   TEXT NOT NULL,
    address    TEXT NOT NULL,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (platform, address)
  );

  -- Something sent: its words, and below, its files and where it was to go.
  CREATE TABLE dispatches (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- A file to be sent. It is taken before what it goes with is sent, so until then it belongs
  -- to nothing. 'folder' is where it stands under the outbox; once everything it was for has
  -- gone it is deleted from there, and 'removed_at' says when.
  CREATE TABLE dispatch_files (
    id          INTEGER PRIMARY KEY,
    dispatch_id INTEGER REFERENCES dispatches(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    folder      TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    removed_at  TEXT
  );
  CREATE INDEX dispatch_files_by_dispatch ON dispatch_files (dispatch_id, id);

  -- One thing sent to one chat, and how that went. The chat's name is kept as it was, for
  -- when the chat itself has been taken off the list.
  CREATE TABLE deliveries (
    id          INTEGER PRIMARY KEY,
    dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    chat_id     INTEGER REFERENCES outside_chats(id) ON DELETE SET NULL,
    chat_name   TEXT NOT NULL,
    platform    TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'sent', 'failed')),
    detail      TEXT,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX deliveries_by_dispatch ON deliveries (dispatch_id, id);
  `,

  // 15: someone can be invited by a link handed to them, with no number kept of them
  `
  -- The list of those invited is made again so that a number is no longer required: SQLite
  -- cannot loosen a column where it stands. Dropping the old list would take with it the
  -- links and the record of texts that hang from it, so those are set aside and put back.
  CREATE TABLE contacts_remade (
    id          INTEGER PRIMARY KEY,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    -- sealed, with the keyed mark by which the same number is known again; both absent for
    -- someone who is to be handed a link and never texted
    number      TEXT,
    number_mark TEXT UNIQUE,
    user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    told        INTEGER NOT NULL DEFAULT 0,
    told_at     TEXT,
    accepted_at TEXT,
    lapsed_at   TEXT,
    stopped_at  TEXT,
    created_at  TEXT NOT NULL,
    -- when an admin last made a link for them to pass on by hand
    linked_at   TEXT
  );
  INSERT INTO contacts_remade (id, position, name, number, number_mark, user_id, told, told_at, accepted_at, lapsed_at, stopped_at, created_at)
    SELECT id, position, name, number, number_mark, user_id, told, told_at, accepted_at, lapsed_at, stopped_at, created_at FROM contacts;
  CREATE TEMP TABLE invitations_aside AS SELECT * FROM invitations;
  CREATE TEMP TABLE texts_aside AS SELECT * FROM texts;
  DROP TABLE contacts;
  ALTER TABLE contacts_remade RENAME TO contacts;
  CREATE INDEX contacts_by_position ON contacts (position, id);
  CREATE INDEX contacts_by_user ON contacts (user_id);
  INSERT INTO invitations (token_hash, contact_id, expires_at) SELECT token_hash, contact_id, expires_at FROM invitations_aside;
  INSERT INTO texts (id, contact_id, kind, post_id, ok, detail, created_at)
    SELECT id, contact_id, kind, post_id, ok, detail, created_at FROM texts_aside;
  DROP TABLE invitations_aside;
  DROP TABLE texts_aside;
  `,

  // 16: how far along a piece is, the order its keeper lists it in, and where it stands on the corpus
  `
  -- A piece that is not published is somewhere on the way to it, and its keeper says where. What
  -- was under review had been written; what is published was finished, should it ever be taken back.
  ALTER TABLE posts ADD COLUMN stage TEXT NOT NULL DEFAULT 'in-progress'
    CHECK (stage IN ('not-started', 'in-progress', 'drafted', 'finished'));
  UPDATE posts SET stage = CASE status WHEN 'draft' THEN 'drafted' ELSE 'finished' END;

  -- The pieces are listed in the order their keeper puts them in, the lowest first. A new one
  -- goes to the head of the list, which is where the latest were until now.
  ALTER TABLE posts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  UPDATE posts SET position = -id;

  -- Where a piece's title stands on the corpus, once its keeper has dragged it there: so far
  -- right of the essay in the middle, and so far below it. Until then it is found a place.
  ALTER TABLE posts ADD COLUMN corpus_x REAL;
  ALTER TABLE posts ADD COLUMN corpus_y REAL;

  -- What a work can be said to be was chosen again: a book is the whole of one or a part of it,
  -- and whatever is watched is a video.
  UPDATE posts SET medium = 'Book (whole)' WHERE kind = 'work' AND medium = 'Book';
  UPDATE posts SET medium = 'Video' WHERE kind = 'work' AND medium IN ('Film', 'Series');

  -- A work has one thing said of it now, its annotations, which are its text. What was kept
  -- apart, to open under its title on the corpus, joins what was said for it.
  UPDATE posts
    SET body = CASE WHEN trim(body) = '' THEN annotation ELSE body || char(10) || char(10) || annotation END,
        annotation = NULL
    WHERE kind = 'work' AND annotation IS NOT NULL AND trim(annotation) <> '';
  `,
];

// the folder holds every member's writing and password hash: it is for this server's user alone
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const DB_FILE = join(config.dataDir, "gesserit.db");

export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
// SQLite gives its side files the permissions of the database itself
for (const path of [config.dataDir, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    chmodSync(path, path === config.dataDir ? 0o700 : 0o600);
  } catch {
    // a file that is not there yet, or a system that keeps no such permissions
  }
}

const applied = db.prepare("PRAGMA user_version").get().user_version;
for (let v = applied; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const now = () => new Date().toISOString();

/** runs `work` so that either all of what it writes is kept or none of it */
export function transaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* -------------------------------------------------------------- settings */

export const settings = {
  get: (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null,
  set: (key, value) =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, String(value)),
};

/*
 * The id of the main admin, as SQL: the admin who has been named as such, or
 * until one is (or if that one is an admin no longer) the admin who has been
 * here longest. What the main admin publishes is the canon.
 */
const MAIN_ADMIN = `COALESCE(
  (SELECT named.id FROM settings JOIN users AS named ON named.id = CAST(settings.value AS INTEGER)
    WHERE settings.key = 'main_admin' AND named.role = 'admin' AND named.active = 1),
  (SELECT first.id FROM users AS first WHERE first.role = 'admin' AND first.active = 1 ORDER BY first.id LIMIT 1)
)`;

/* --------------------------------------------------------------- members */

export const users = {
  byId: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),
  byUsername: (username) => db.prepare("SELECT * FROM users WHERE username = ?").get(username),
  /** everyone, each marked `main` if they are the main admin */
  all: () =>
    db
      .prepare(`SELECT users.*, users.id = ${MAIN_ADMIN} AS main FROM users ORDER BY active DESC, name COLLATE NOCASE`)
      .all(),
  /** the main admin, whose writing is the canon; nobody, while there is no admin at all */
  main: () => db.prepare(`SELECT * FROM users WHERE id = ${MAIN_ADMIN}`).get() ?? null,
  setMain: (id) => settings.set("main_admin", id),
  /** those who can sign in, as others may know them: no hashes */
  active: () =>
    db.prepare("SELECT id, username, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE").all(),
  count: () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
  create({ username, name, passwordHash, role = "member" }) {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO users (username, name, password_hash, role, theme, created_at) VALUES (?, ?, ?, ?, 'paper', ?)"
      )
      .run(username, name, passwordHash, role, now());
    return Number(lastInsertRowid);
  },
  setPassword: (id, passwordHash) =>
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id),
  setName: (id, name) => db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id),
  /** how the pages look to this member: "night" or "paper" */
  setTheme: (id, theme) => db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, id),
  /** what a member is told of on their devices, as the keys of src/push.mjs */
  setNotify: (id, keys) => db.prepare("UPDATE users SET notify = ? WHERE id = ?").run(keys.join(" "), id),
  setActive: (id, active) =>
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id),
  /** "admin" or "member"; only the server's own tools change it, never a page of the forum */
  setRole: (id, role) => db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id),
  /** what a member may do besides what any member may: the keys of their permissions, or none of them */
  setPermissions: (id, keys) =>
    db.prepare("UPDATE users SET permissions = ? WHERE id = ?").run(keys.join(" "), id),
};

/*
 * What has been done to members, kept so that the admins can see it
 * afterwards. `action` is one of: added, password, removed, restored,
 * permissions, role, main, renamed, signed-out; and, for those who are invited and
 * are not members yet, invite-added, invite-link, invite-text, invite-texts
 * and invite-removed, with their name as the detail and no member. `by` is
 * the member who did it, or nothing for what was done from the server
 * itself.
 */
export const adminLog = {
  record: ({ by = null, action, member = null, detail = null }) =>
    db
      .prepare("INSERT INTO admin_log (at, by_id, action, member_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now(), by, action, member, detail),
  /** the latest first, each with the names of who did it and to whom */
  latest: (limit = 100) =>
    db
      .prepare(
        `SELECT admin_log.id, admin_log.at, admin_log.action, admin_log.detail,
                admin_log.by_id, by_user.name AS by_name, by_user.username AS by_username,
                admin_log.member_id, member.name AS member_name, member.username AS member_username
         FROM admin_log
         LEFT JOIN users AS by_user ON by_user.id = admin_log.by_id
         LEFT JOIN users AS member ON member.id = admin_log.member_id
         ORDER BY admin_log.id DESC LIMIT ?`
      )
      .all(limit),
};

/* ----------------------------------------------------------------- posts */

/* a post with its author, how much has been said about it, and, for a
   commentary, enough of the post it answers to name it */
const POST = `
  SELECT
    posts.*,
    users.name AS author_name,
    users.username AS author_username,
    parent.title AS parent_title,
    parent.status AS parent_status,
    substr(parent.body, 1, 240) AS parent_opening,
    (SELECT COUNT(*) FROM notes
      WHERE notes.post_id = posts.id AND notes.removed_at IS NULL AND notes.parent_id IS NULL)
      AS note_count,
    (SELECT COUNT(*) FROM notes
      WHERE notes.post_id = posts.id AND notes.removed_at IS NULL AND notes.parent_id IS NOT NULL)
      AS reply_count,
    (SELECT COUNT(*) FROM posts AS answer
      WHERE answer.parent_id = posts.id AND answer.status = 'published')
      AS commentary_count,
    (SELECT MAX(n) FROM revisions WHERE revisions.post_id = posts.id) AS version,
    (SELECT created_at FROM revisions WHERE revisions.post_id = posts.id ORDER BY n DESC LIMIT 1)
      AS revised_at,
    (posts.status = 'published' AND posts.kind = 'writing' AND posts.hand IS NULL AND posts.author_id = ${MAIN_ADMIN}) AS canon
  FROM posts
  JOIN users ON users.id = posts.author_id
  LEFT JOIN posts AS parent ON parent.id = posts.parent_id
`;

const NEWEST_FIRST = "ORDER BY posts.published_at DESC, posts.id DESC";

export const posts = {
  byId: (id) => db.prepare(`${POST} WHERE posts.id = ?`).get(id),
  /** the published article of this name, the earliest if several share it */
  byTitle: (title) =>
    db
      .prepare(
        `SELECT id, title FROM posts WHERE status = 'published' AND title = ? COLLATE NOCASE
         ORDER BY published_at, id LIMIT 1`
      )
      .get(title),
  /**
   * Every piece there is, written here or made elsewhere, for the list they are kept track of in,
   * in the order their keeper has put them in. With `own`, what is not published is left out
   * unless it is that member's: the rest of it is for those who edit.
   */
  ledger: ({ own = null } = {}) =>
    db
      .prepare(
        `${POST} WHERE (posts.status = 'published' OR ? IS NULL OR posts.author_id = ?)
         ORDER BY posts.position, posts.id DESC`
      )
      .all(own, own),
  /** what has been published in answer to a post, oldest first */
  commentaries: (id) =>
    db
      .prepare(
        `${POST} WHERE posts.parent_id = ? AND posts.status = 'published'
         ORDER BY posts.published_at, posts.id`
      )
      .all(id),
  /** the published posts whose text links to this one */
  linkedFrom: (id) =>
    db
      .prepare(
        `${POST} JOIN links ON links.from_post = posts.id
         WHERE links.to_post = ? AND posts.status = 'published' ${NEWEST_FIRST}`
      )
      .all(id),
  byAuthor: (authorId) =>
    db.prepare(`${POST} WHERE posts.author_id = ? AND posts.status = 'published' ${NEWEST_FIRST}`).all(authorId),
  /**
   * The canon: what the main admin has published as their own, in the order it was. A piece with
   * a letter after its title is someone else's, which the main admin has only put here for them.
   */
  canon: () =>
    db
      .prepare(
        `${POST} WHERE posts.status = 'published' AND posts.kind = 'writing' AND posts.hand IS NULL
           AND posts.author_id = ${MAIN_ADMIN}
         ORDER BY posts.published_at, posts.id`
      )
      .all(),
  /** whose the works are, each name once as it was first written, to be offered when another of theirs is added */
  creators: () =>
    db
      .prepare(
        `SELECT MIN(creator) AS name FROM posts WHERE kind = 'work' AND creator IS NOT NULL
         GROUP BY creator COLLATE NOCASE ORDER BY creator COLLATE NOCASE`
      )
      .all()
      .map((row) => row.name),
  /**
   * The essay the corpus is drawn around: the one that was chosen, while it
   * is still published; failing that the earliest article of the canon, and
   * failing that the earliest article there is.
   */
  centre: () =>
    db
      .prepare(
        `SELECT posts.id, posts.title FROM posts
         WHERE posts.status = 'published' AND posts.kind = 'writing' AND posts.title IS NOT NULL
         ORDER BY posts.id = COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'corpus_centre'), 0) DESC,
                  posts.parent_id IS NOT NULL, posts.author_id = ${MAIN_ADMIN} DESC, posts.published_at, posts.id
         LIMIT 1`
      )
      .get() ?? null,
  setCentre: (id) => settings.set("corpus_centre", id),
  /** the titles that can be linked to by name, newest first */
  titles: (limit = 500) =>
    db
      .prepare(
        `SELECT title FROM posts WHERE status = 'published' AND title IS NOT NULL
         GROUP BY title COLLATE NOCASE ORDER BY MAX(published_at) DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => row.title),
  /**
   * With `parentId`, a commentary on that post; with `work`, a work, of which that says the rest.
   * `stage` is how far along it is, which is what is said of it until it is published. It goes
   * to the head of the list of every piece.
   */
  create({ authorId, title, body, status, stage = "in-progress", parentId = null, work = null }) {
    const at = now();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO posts (author_id, parent_id, title, body, status, stage, position, created_at, published_at, updated_at,
                            kind, creator, medium, year, link)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM posts), ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        authorId,
        parentId,
        title,
        body,
        status,
        stage,
        at,
        status === "published" ? at : null,
        at,
        work ? "work" : "writing",
        work?.creator || null,
        work?.medium || null,
        work?.year || null,
        work?.link || null
      );
    return Number(lastInsertRowid);
  },
  /** what is said of a work besides its title and its annotations */
  describe: (id, { creator, medium, year, link }) =>
    db
      .prepare("UPDATE posts SET creator = ?, medium = ?, year = ?, link = ? WHERE id = ? AND kind = 'work'")
      .run(creator || null, medium || null, year || null, link || null, id),
  /**
   * What those who keep the corpus say of a piece, which is theirs alone to say: the few words
   * that open under the title of one written here, whether it shows and tells, whether it is for
   * the wider public, and for a piece written here how its title is coloured and the letter set after it.
   */
  curate: (id, { annotation = "", showTell = false, missionaria = false, tone = "", hand = "" }) =>
    db
      .prepare("UPDATE posts SET annotation = ?, show_tell = ?, missionaria = ?, tone = ?, hand = ? WHERE id = ?")
      .run(annotation || null, showTell ? 1 : 0, missionaria ? 1 : 0, tone || "", hand || null, id),
  /**
   * The first publication date is kept if a post is unpublished and published again. With no
   * `stage`, how far along it was said to be is left as it was.
   */
  update(id, { title, body, status, stage = null }) {
    const at = now();
    db.prepare(
      `UPDATE posts SET title = ?, body = ?, status = ?, stage = COALESCE(?, stage), updated_at = ?,
         published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
       WHERE id = ?`
    ).run(title, body, status, stage, at, status, at, id);
  },
  /** says how far along a piece is, or that it is published, and changes nothing else of it */
  setStatus(id, { status, stage = null }) {
    const at = now();
    db.prepare(
      `UPDATE posts SET status = ?, stage = COALESCE(?, stage), updated_at = ?,
         published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
       WHERE id = ?`
    ).run(status, stage, at, status, at, id);
  },
  /** puts pieces in the order given, in the list of every piece: `ids` are those of one of its tables, the first first */
  arrange(ids) {
    const set = db.prepare("UPDATE posts SET position = ? WHERE id = ?");
    transaction(() => ids.forEach((id, i) => set.run(i + 1, id)));
  },
  /** where each piece's title stands on the corpus: `places` are { id, x, y }, measured from the essay in the middle */
  place(places) {
    const set = db.prepare("UPDATE posts SET corpus_x = ?, corpus_y = ? WHERE id = ?");
    transaction(() => places.forEach(({ id, x, y }) => set.run(x, y, id)));
  },
  /** lets every title go back to where the corpus would set it by itself */
  unplace: () => db.exec("UPDATE posts SET corpus_x = NULL, corpus_y = NULL"),
  remove: (id) => db.prepare("DELETE FROM posts WHERE id = ?").run(id),
};

/* -------------------------------------------------------------- versions */

const REVISION = `
  SELECT revisions.*, users.name AS editor_name, users.username AS editor_username
  FROM revisions JOIN users ON users.id = revisions.user_id
`;

export const revisions = {
  latest: (postId) => db.prepare(`${REVISION} WHERE post_id = ? ORDER BY n DESC LIMIT 1`).get(postId),
  get: (postId, n) => db.prepare(`${REVISION} WHERE post_id = ? AND n = ?`).get(postId, n),
  /** every version of a post, newest first */
  list: (postId) => db.prepare(`${REVISION} WHERE post_id = ? ORDER BY n DESC`).all(postId),
  /** keeps a wording as the post's next version, and says which number it was given */
  add({ postId, title, body, summary = null, userId, added = null, removed = null }) {
    const n = db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM revisions WHERE post_id = ?").get(postId).n;
    db.prepare(
      `INSERT INTO revisions (post_id, n, title, body, summary, user_id, added, removed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(postId, n, title, body, summary, userId, added, removed, now());
    return n;
  },
};

/* ---------------------------------------------- margin notes and replies */

export const notes = {
  byId: (id) => db.prepare("SELECT * FROM notes WHERE id = ?").get(id),
  /**
   * A post's notes as threads, oldest first: each note with the replies made
   * to it, and each of them with its earlier wordings if it has been edited.
   * Removed notes and replies are left out, except that a removed note which
   * still has replies keeps its place, emptied, so they have something to
   * hang from.
   */
  threads(postId) {
    const rows = db
      .prepare(
        `SELECT notes.*, users.name AS author_name, users.username AS author_username FROM notes
         JOIN users ON users.id = notes.user_id
         WHERE post_id = ? ORDER BY notes.created_at, notes.id`
      )
      .all(postId);
    const earlier = new Map();
    const wordings = db
      .prepare(
        `SELECT note_revisions.note_id, note_revisions.body, note_revisions.created_at
         FROM note_revisions JOIN notes ON notes.id = note_revisions.note_id
         WHERE notes.post_id = ? ORDER BY note_revisions.id`
      )
      .all(postId);
    for (const { note_id, ...wording } of wordings) {
      if (!earlier.has(note_id)) earlier.set(note_id, []);
      earlier.get(note_id).push(wording);
    }
    const threads = new Map();
    for (const row of rows) {
      if (row.parent_id !== null) continue;
      const removed = Boolean(row.removed_at);
      threads.set(
        row.id,
        removed
          ? { ...row, body: "", quote: null, removed, earlier: [], replies: [] }
          : { ...row, removed, earlier: earlier.get(row.id) || [], replies: [] }
      );
    }
    for (const row of rows) {
      if (row.parent_id !== null && !row.removed_at)
        threads.get(row.parent_id)?.replies.push({ ...row, earlier: earlier.get(row.id) || [] });
    }
    return [...threads.values()].filter((note) => !note.removed || note.replies.length > 0);
  },
  /**
   * With `parentId`, a reply to that note; without, a note on the post itself.
   * `version` is the version of the post it was made on.
   */
  create({ postId, userId, body, quote = null, quotePos = null, parentId = null, version = null }) {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO notes (post_id, user_id, parent_id, body, quote, quote_pos, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(postId, userId, parentId, body, quote, quotePos, version, now());
    return Number(lastInsertRowid);
  },
  /** rewords a note, keeping what it said before */
  reword(note, body) {
    db.prepare("INSERT INTO note_revisions (note_id, body, created_at) VALUES (?, ?, ?)").run(
      note.id,
      note.body,
      note.edited_at || note.created_at
    );
    db.prepare("UPDATE notes SET body = ?, edited_at = ? WHERE id = ?").run(body, now(), note.id);
  },
  /** removed notes are kept, hidden, with who removed them and when */
  remove: (id, removedBy) =>
    db.prepare("UPDATE notes SET removed_at = ?, removed_by = ? WHERE id = ?").run(now(), removedBy, id),
  /** a member's latest notes and replies on what is published, with where each was made */
  byUser: (userId, limit = 30) =>
    db
      .prepare(
        `SELECT notes.*, posts.title AS post_title, substr(posts.body, 1, 240) AS post_opening
         FROM notes JOIN posts ON posts.id = notes.post_id
         WHERE notes.user_id = ? AND notes.removed_at IS NULL AND posts.status = 'published'
         ORDER BY notes.created_at DESC, notes.id DESC LIMIT ?`
      )
      .all(userId, limit),
};

/* ----------------------------------------------------------------- links */

export const links = {
  /** every post's text, or only those that may need indexing again when post `id` changes */
  sources: (id = null) =>
    db
      .prepare("SELECT id, body FROM posts WHERE ? IS NULL OR id = ? OR body LIKE '%[[%'")
      .all(id, id),
  /** records what one post links to, in place of what was recorded before */
  replace(fromPost, toPosts) {
    db.prepare("DELETE FROM links WHERE from_post = ?").run(fromPost);
    const add = db.prepare(
      "INSERT OR IGNORE INTO links (from_post, to_post) SELECT ?, id FROM posts WHERE id = ? AND id <> ?"
    );
    for (const toPost of toPosts) add.run(fromPost, toPost, fromPost);
  },
};

/* ------------------------------------------------------------------ tags */

/* a tag counts while the post it is in is published and its note still stands */
const STANDING = `
  FROM mentions
  JOIN posts ON posts.id = mentions.post_id
  LEFT JOIN notes ON notes.id = mentions.note_id
  WHERE posts.status = 'published' AND (mentions.note_id IS NULL OR notes.removed_at IS NULL)
`;

export const mentions = {
  /**
   * Makes the tags in one place exactly `userIds`, keeping the date of those
   * already there. The place is a note or reply, or with no `noteId` the
   * post's own text. Gives back who was not tagged there before.
   */
  set({ postId, noteId = null, byUserId, userIds }) {
    const wanted = new Set(userIds);
    const rows = db.prepare("SELECT id, user_id FROM mentions WHERE post_id = ? AND note_id IS ?").all(postId, noteId);
    for (const row of rows) {
      if (wanted.has(row.user_id)) wanted.delete(row.user_id);
      else db.prepare("DELETE FROM mentions WHERE id = ?").run(row.id);
    }
    const add = db.prepare(
      "INSERT INTO mentions (user_id, by_user_id, post_id, note_id, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const userId of wanted) add.run(userId, byUserId, postId, noteId, now());
    // those tagged here for the first time
    return [...wanted];
  },
  /** where a member has been tagged, newest first */
  forUser: (userId, limit = 30) =>
    db
      .prepare(
        `SELECT mentions.*, by.name AS by_name, by.username AS by_username,
                posts.title AS post_title, substr(posts.body, 1, 240) AS post_opening,
                notes.parent_id AS note_parent_id, notes.body AS note_body
         ${STANDING.replace("WHERE", "JOIN users AS by ON by.id = mentions.by_user_id WHERE")}
           AND mentions.user_id = ?
         ORDER BY mentions.created_at DESC, mentions.id DESC LIMIT ?`
      )
      .all(userId, limit),
  /** how many of those the member has not yet looked at */
  unseenCount: (userId) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n ${STANDING} AND mentions.user_id = ?
           AND mentions.created_at > COALESCE((SELECT mentions_seen_at FROM users WHERE id = ?), '')`
      )
      .get(userId, userId).n,
  markSeen: (userId) => db.prepare("UPDATE users SET mentions_seen_at = ? WHERE id = ?").run(now(), userId),
};

/* ---------------------------------------------------- pictures, drawings */

export const media = {
  byName: (name) => db.prepare("SELECT * FROM media WHERE name = ?").get(name),
  count: () => db.prepare("SELECT COUNT(*) AS n FROM media").get().n,
  create({ name, userId, type, bytes, original = null }) {
    db.prepare(
      "INSERT INTO media (name, user_id, type, bytes, original, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(name, userId, type, bytes, original, now());
  },
};

export const drawings = {
  get: (hash) => db.prepare("SELECT * FROM drawings WHERE hash = ?").get(hash),
  put({ hash, svg = null, width = null, height = null, error = null }) {
    db.prepare(
      "INSERT OR REPLACE INTO drawings (hash, svg, width, height, error, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(hash, svg, width, height, error, now());
  },
};

/* ----------------------------------------------- the graph's raw material */

export const activity = {
  posts: () =>
    db
      .prepare(
        `SELECT posts.id, posts.title, substr(posts.body, 1, 240) AS opening, posts.author_id,
                posts.published_at,
                (posts.kind = 'writing' AND posts.hand IS NULL AND posts.author_id = ${MAIN_ADMIN}) AS canon,
                posts.kind, posts.creator, posts.medium, posts.position, posts.corpus_x, posts.corpus_y,
                -- what opens under a title on the corpus: of a work, its annotations, which are its text
                CASE WHEN posts.kind = 'work' THEN posts.body ELSE posts.annotation END AS annotation,
                posts.show_tell, posts.tone, posts.hand,
                CASE WHEN parent.status = 'published' THEN posts.parent_id END AS parent_id,
                (SELECT COUNT(*) FROM notes WHERE notes.post_id = posts.id AND notes.removed_at IS NULL)
                  AS said
         FROM posts LEFT JOIN posts AS parent ON parent.id = posts.parent_id
         WHERE posts.status = 'published' ORDER BY posts.published_at, posts.id`
      )
      .all(),
  links: () =>
    db
      .prepare(
        `SELECT from_post, to_post FROM links
         JOIN posts AS a ON a.id = from_post JOIN posts AS b ON b.id = to_post
         WHERE a.status = 'published' AND b.status = 'published' ORDER BY from_post, to_post`
      )
      .all(),
  /** how many notes and replies each member has made on each published post */
  notes: () =>
    db
      .prepare(
        `SELECT notes.user_id, notes.post_id, COUNT(*) AS n
         FROM notes JOIN posts ON posts.id = notes.post_id
         WHERE notes.removed_at IS NULL AND posts.status = 'published'
         GROUP BY notes.user_id, notes.post_id ORDER BY notes.user_id, notes.post_id`
      )
      .all(),
  /** who has replied to whose notes, and how often */
  replies: () =>
    db
      .prepare(
        `SELECT reply.user_id AS from_user, note.user_id AS to_user, COUNT(*) AS n
         FROM notes AS reply
         JOIN notes AS note ON note.id = reply.parent_id
         JOIN posts ON posts.id = reply.post_id
         WHERE reply.removed_at IS NULL AND note.removed_at IS NULL AND posts.status = 'published'
           AND reply.user_id <> note.user_id
         GROUP BY reply.user_id, note.user_id ORDER BY reply.user_id, note.user_id`
      )
      .all(),
  /** who has tagged whom, and how often */
  tags: () =>
    db
      .prepare(
        `SELECT mentions.by_user_id AS from_user, mentions.user_id AS to_user, COUNT(*) AS n
         ${STANDING} AND mentions.by_user_id <> mentions.user_id
         GROUP BY mentions.by_user_id, mentions.user_id ORDER BY mentions.by_user_id, mentions.user_id`
      )
      .all(),
  people: () => db.prepare(`SELECT id, username, name, id = ${MAIN_ADMIN} AS main FROM users ORDER BY id`).all(),
};
