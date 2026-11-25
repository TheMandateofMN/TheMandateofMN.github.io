/*
 * Works: the books, films and whatever else was made elsewhere that the
 * writing here descends from, the antecedents. A work is a post like any
 * other (see the posts table); this is what is said of one besides. Its
 * title is the work's, and its text is its annotations: what the corpus
 * says of it, which opens under its title there.
 */

/* what type of thing a work can be said to be */
export const MEDIA = ["Book (whole)", "Book (part)", "Essay", "Paper", "Passage", "Image", "Video", "Painting"];

/* what one could be said to be before those were chosen: a work that was called one of these keeps the word until it is given another */
const OLDER = ["Poem", "Play", "Music", "Talk", "Game", "Other"];

const MOST = { title: 200, creator: 160, year: 24, link: 600, body: 20_000 };

/* the most that can be said of a piece written here where it opens on the corpus, and the most letters set after a title */
export const MOST_ANNOTATION = 3000;
const MOST_HAND = 2;

/* how a piece written here can be coloured on the corpus: the green they all are, a lighter one, or brown into green */
export const TONES = [
  { key: "", name: "Dark green" },
  { key: "light", name: "Lighter green" },
  { key: "graft", name: "Brown into green" },
];

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** an address that leads out of the forum: http or https, and nothing else */
export function outwardLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * What a form says of a work, set straight: { values, error }. `get` reads a
 * field of the form by name. A work needs a title; the rest may be left out.
 */
export function readWork(get) {
  const values = {
    title: oneLine(get("title")),
    creator: oneLine(get("creator")),
    medium: [...MEDIA, ...OLDER].includes(get("medium")) ? get("medium") : "",
    year: oneLine(get("year")),
    link: oneLine(get("link")),
    body: String(get("body") ?? "").replace(/\r\n?/g, "\n").trim(),
  };
  const long = Object.keys(MOST).find((key) => values[key].length > MOST[key]);
  const error = !values.title
    ? "A work needs its title."
    : long
      ? `Keep ${{ body: "the annotations", year: "the date", creator: "the author" }[long] ?? `the ${long}`} under ${MOST[long]} characters.`
      : values.link && !outwardLink(values.link)
        ? "The link should be a web address, beginning with https://"
        : null;
  if (values.link && !error) values.link = outwardLink(values.link);
  return { values, error };
}

/**
 * What a form says of a piece that is for those who keep the corpus to say, set straight:
 * { values, error }. `work` says the piece is one made elsewhere, whose annotations are its text
 * and are read with it; one written here has its own, and alone has a colour and a letter after its title.
 */
export function readCuration(get, { work }) {
  const values = {
    annotation: work ? "" : String(get("annotation") ?? "").replace(/\r\n?/g, "\n").trim(),
    showTell: get("show_tell") === "1",
    missionaria: get("missionaria") === "1",
    tone: !work && TONES.some((tone) => tone.key === get("tone")) ? get("tone") : "",
    hand: work ? "" : oneLine(get("hand")),
  };
  const error =
    values.annotation.length > MOST_ANNOTATION
      ? `Keep what opens on the corpus under ${MOST_ANNOTATION} characters.`
      : !/^[\p{L}\p{N}]*$/u.test(values.hand) || [...values.hand].length > MOST_HAND
        ? "The superscript is one letter, or two: B, C."
        : null;
  return { values, error };
}

/** the type of a work as it is written under its title: nothing, for one whose type was never said */
export const typeOf = (medium) => (medium && medium !== "Other" ? medium : "");

/**
 * Whose a work is, in a word: the family name, which is the last word of the
 * name as it is usually written, or what stands before a comma.
 */
export function surname(creator) {
  const name = oneLine(creator);
  if (name.includes(",")) return name.split(",")[0].trim();
  return name.split(" ").pop();
}

/** whose a work is and what type of thing, as they are written together under its title */
export const byline = (post, { short = false } = {}) =>
  [short ? surname(post.creator) : oneLine(post.creator), typeOf(post.medium)].filter(Boolean).join(" · ");
