/*
 * Telling what changed between two wordings of a text.
 *
 * The texts are first compared line by line, a line here being a paragraph
 * or one line of a list. Where a stretch of lines differs, the two stretches
 * are compared again word by word, so a paragraph with one word changed
 * shows that word and not the whole paragraph.
 */

/* past this many differences a comparison is given up, and the two sides shown whole */
const MOST_DIFFERENCES = 1200;

/**
 * The shortest way from the list `a` to the list `b` (Myers' algorithm), as
 * steps [op, value] with op "same", "del" (in a only) or "ins" (in b only).
 * Gives null if the two differ in more than `most` places.
 */
export function steps(a, b, most = MOST_DIFFERENCES) {
  // what the two share at either end needs no working out
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);
  const middle = between(left, right, most);
  if (!middle) return null;
  return [
    ...a.slice(0, head).map((value) => ["same", value]),
    ...middle,
    ...a.slice(a.length - tail).map((value) => ["same", value]),
  ];
}

function between(a, b, most) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((value) => ["ins", value]);
  if (m === 0) return a.map((value) => ["del", value]);

  // furthest[k] is how far along `a` a path of d differences reaches on diagonal k
  const reach = Math.min(n + m, most);
  const offset = reach + 1;
  let furthest = new Int32Array(2 * reach + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= reach && found < 0; d++) {
    trace.push(furthest.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1])
          ? furthest[offset + k + 1]
          : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  // walk back from the end along the path that got there
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && before[offset + k - 1] < before[offset + k + 1]);
    const fromK = down ? k + 1 : k - 1;
    const fromX = before[offset + fromK];
    const fromY = fromX - fromK;
    // back along what the two share, then over the one difference that led onto it
    while (x > fromX && y > fromY) {
      out.push(["same", a[--x]]);
      y--;
    }
    if (down) out.push(["ins", b[--y]]);
    else out.push(["del", a[--x]]);
  }
  while (x > 0 && y > 0) {
    out.push(["same", a[--x]]);
    y--;
  }
  return out.reverse();
}

/* a text as words, the spaces between them, and each mark of punctuation by itself */
const pieces = (text) => text.match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu) || [];
const isWord = (piece) => /[\p{L}\p{N}]/u.test(piece);

/** how many words a text has */
export const wordCount = (text) => pieces(String(text)).filter(isWord).length;

/**
 * Joins steps into runs of text that read well: what went out of a stretch,
 * then what came in. Changes parted only by a space are taken together, so
 * that three words replaced by three others are shown as one phrase for
 * another rather than word by word.
 */
function runs(list) {
  const joined = [];
  for (const [op, value] of list) {
    const last = joined.at(-1);
    if (last?.op === op) last.text += value;
    else joined.push({ op, text: value });
  }

  const out = [];
  let gone = "";
  let come = "";
  const close = () => {
    // a side that is nothing but the spaces between words changed nothing
    if (gone.trim() && come.trim()) out.push({ op: "del", text: gone }, { op: "ins", text: come });
    else if (gone.trim()) out.push({ op: "del", text: gone }, ...(come ? [{ op: "same", text: come }] : []));
    else if (come.trim()) out.push({ op: "ins", text: come });
    else if (gone || come) out.push({ op: gone ? "del" : "ins", text: gone || come });
    gone = come = "";
  };
  joined.forEach((run, i) => {
    if (run.op === "del") gone += run.text;
    else if (run.op === "ins") come += run.text;
    else if ((gone || come) && /^[ \t]+$/.test(run.text) && joined[i + 1] && joined[i + 1].op !== "same") {
      gone += run.text;
      come += run.text;
    } else {
      close();
      out.push(run);
    }
  });
  close();
  return out;
}

/**
 * What changed from the text `before` to the text `after`:
 *
 *   blocks    in order, either { kind: "same", lines } for lines left alone, or
 *             { kind: "changed", parts } with parts { op: "same" | "del" | "ins", text }
 *   added     how many words came in
 *   removed   how many went out
 */
export function changes(before, after) {
  const linesOf = (text) => String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const a = linesOf(before);
  const b = linesOf(after);
  const byLine = steps(a, b) || [...a.map((line) => ["del", line]), ...b.map((line) => ["ins", line])];

  const blocks = [];
  let added = 0;
  let removed = 0;
  let same = [];
  let gone = [];
  let come = [];
  const closeSame = () => {
    if (same.length > 0) blocks.push({ kind: "same", lines: same });
    same = [];
  };
  const closeChanged = () => {
    if (gone.length + come.length === 0) return;
    const was = gone.join("\n");
    const is = come.join("\n");
    const byWord = (gone.length > 0 && come.length > 0 && steps(pieces(was), pieces(is))) || [
      ...(gone.length > 0 ? [["del", was]] : []),
      ...(come.length > 0 ? [["ins", is]] : []),
    ];
    for (const [op, text] of byWord) {
      if (op === "ins") added += wordCount(text);
      if (op === "del") removed += wordCount(text);
    }
    blocks.push({ kind: "changed", parts: runs(byWord) });
    gone = [];
    come = [];
  };
  for (const [op, line] of byLine) {
    if (op === "same") {
      closeChanged();
      same.push(line);
    } else {
      closeSame();
      (op === "del" ? gone : come).push(line);
    }
  }
  closeChanged();
  closeSame();
  return { blocks, added, removed };
}
