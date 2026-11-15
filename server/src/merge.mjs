/*
 * Joining two wordings that were both written from the same earlier one.
 *
 * When two people change a page at once, each started from the same version
 * (the base) and made changes of their own. Where only one of them touched a
 * passage, their change is taken; where both made the same change, it is
 * taken once. Only where both changed the same passage differently is there
 * something for a person to decide, and that is called a clash.
 *
 * The texts are compared line by line, a line being a paragraph or one item
 * of a list. A passage both changed is then looked at again word by word,
 * so that two people mending different sentences of one paragraph do not
 * clash either.
 */

import { steps } from "./diff.mjs";

/* past this many differences the two are taken to share nothing */
const MOST = 20_000;

const linesOf = (text) => String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/** where `side` differs from `base`: each { start, end, values } puts values in place of base[start, end) */
function hunks(base, side) {
  const list = steps(base, side, MOST) || [...base.map((value) => ["del", value]), ...side.map((value) => ["ins", value])];
  const out = [];
  let at = 0;
  let open = null;
  for (const [op, value] of list) {
    if (op === "same") {
      open = null;
      at++;
      continue;
    }
    if (!open) out.push((open = { start: at, end: at, values: [] }));
    if (op === "del") open.end = ++at;
    else open.values.push(value);
  }
  return out;
}

/** base[start, end) as one side left it */
function applied(base, start, end, changes) {
  const out = [];
  let at = start;
  for (const change of changes) {
    out.push(...base.slice(at, change.start), ...change.values);
    at = change.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * Whether a change belongs with those already gathered over base[start, end).
 * Changes come in order of where they start. Two that replace some of the
 * same lines belong together, and so do two that add at the very same place,
 * or one that adds in the middle of what the other replaces. One that merely
 * touches the end of another does not: the order of the two is plain.
 */
function touches(change, start, end) {
  const empty = change.start === change.end;
  if (start === end) return empty && change.start === start;
  return empty ? change.start > start && change.start < end : change.start < end;
}

/**
 * Joins lists `ours` and `theirs`, both made from `base`. Gives the parts of
 * the result in order: { values } where there is no doubt, and
 * { clash: true, base, ours, theirs } where both changed the same stretch.
 */
function join(base, ours, theirs) {
  const changes = [
    ...hunks(base, ours).map((change) => ({ ...change, side: "ours" })),
    ...hunks(base, theirs).map((change) => ({ ...change, side: "theirs" })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const parts = [];
  const settled = (values) => {
    if (values.length === 0) return;
    const last = parts.at(-1);
    if (last && !last.clash) last.values.push(...values);
    else parts.push({ values: [...values] });
  };

  let at = 0;
  for (let i = 0; i < changes.length; ) {
    const group = [changes[i]];
    const start = changes[i].start;
    let end = changes[i].end;
    for (i++; i < changes.length && touches(changes[i], start, end); i++) {
      end = Math.max(end, changes[i].end);
      group.push(changes[i]);
    }
    settled(base.slice(at, start));
    at = end;

    const as = (side) => applied(base, start, end, group.filter((change) => change.side === side));
    const mine = as("ours");
    const yours = as("theirs");
    const was = base.slice(start, end);
    if (sameList(mine, was)) settled(yours);
    else if (sameList(yours, was) || sameList(mine, yours)) settled(mine);
    else {
      // what the two agree on at either end of the stretch is not part of the clash
      let head = 0;
      while (head < mine.length && head < yours.length && mine[head] === yours[head]) head++;
      let tail = 0;
      while (
        tail < mine.length - head &&
        tail < yours.length - head &&
        mine[mine.length - 1 - tail] === yours[yours.length - 1 - tail]
      )
        tail++;
      settled(mine.slice(0, head));
      parts.push({
        clash: true,
        base: was,
        ours: mine.slice(head, mine.length - tail),
        theirs: yours.slice(head, yours.length - tail),
      });
      settled(mine.slice(mine.length - tail));
    }
  }
  settled(base.slice(at));
  return parts;
}

/* a text as its words and the spaces between them, so that joining them back gives the text */
const wordsOf = (lines) => lines.join("\n").split(/(\s+)/).filter((piece) => piece !== "");

/**
 * Joins the texts `ours` and `theirs`, both written from `base`.
 *
 *   parts     in order: { lines } where the result is settled, and
 *             { clash: true, base, ours, theirs }, each a list of lines,
 *             where both changed the same passage and someone must choose
 *   clashes   how many of those there are
 *   text      the joined text, when there are none
 */
export function merge(base, ours, theirs) {
  const parts = [];
  const settled = (lines) => {
    const last = parts.at(-1);
    if (last && !last.clash) last.lines.push(...lines);
    else parts.push({ lines: [...lines] });
  };
  for (const part of join(linesOf(base), linesOf(ours), linesOf(theirs))) {
    if (!part.clash) {
      settled(part.values);
      continue;
    }
    // the same passage, but perhaps not the same words in it
    const byWord = join(wordsOf(part.base), wordsOf(part.ours), wordsOf(part.theirs));
    if (byWord.every((piece) => !piece.clash)) {
      settled(
        byWord
          .flatMap((piece) => piece.values)
          .join("")
          .split("\n")
      );
    } else {
      parts.push(part);
    }
  }
  const clashes = parts.filter((part) => part.clash).length;
  return { parts, clashes, text: clashes === 0 ? parts.flatMap((part) => part.lines).join("\n") : null };
}

/**
 * The text of a merge once its clashes are decided. `picks` says for each
 * clash, in order, which side stands: "ours", "theirs", or "both" for one
 * after the other. A clash with no pick keeps ours.
 */
export function settle(parts, picks = []) {
  let n = 0;
  return parts
    .flatMap((part) => {
      if (!part.clash) return part.lines;
      const pick = picks[n++];
      return pick === "theirs" ? part.theirs : pick === "both" ? [...part.ours, ...part.theirs] : part.ours;
    })
    .join("\n");
}

/** one line, such as a title, changed by either or both: ours stands where both changed it */
export const mergeLine = (base, ours, theirs) => (ours === base ? theirs : ours);
