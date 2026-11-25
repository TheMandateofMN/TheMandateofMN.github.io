/*
 * How far along a piece is. Until it is published it is at one of four
 * stages, which its keeper says; published, it is there for every member to
 * read. Only those who keep the corpus see what is not published, so the
 * stages are theirs alone to see and to say.
 *
 * The stage is kept in posts.stage, and whether the piece is published in
 * posts.status, as it always was: a piece taken back from being published
 * goes to whichever stage it is then said to be at.
 */

/* the stages on the way to being published, in order */
export const STAGES = [
  { key: "not-started", name: "Not Started" },
  { key: "in-progress", name: "In Progress" },
  { key: "drafted", name: "Drafted" },
  { key: "finished", name: "Finished" },
];

/* everything a piece's status can be: the stages, and then published */
export const STATUSES = [...STAGES, { key: "published", name: "Published" }];

/** the key of what a piece's status is: "published", or the stage it is at */
export const statusOf = (post) => (post.status === "published" ? "published" : post.stage);

/** and the words for it */
export const statusName = (post) => STATUSES.find((each) => each.key === statusOf(post))?.name ?? "In Progress";

/**
 * What a status that was chosen means for a piece, as { status, stage }: what
 * to keep in each of the two columns. Null if there is no such status. A
 * piece that is published keeps the stage it had, should it be taken back.
 */
export function readStatus(key) {
  if (key === "published") return { status: "published", stage: null };
  return STAGES.some((stage) => stage.key === key) ? { status: "draft", stage: key } : null;
}
