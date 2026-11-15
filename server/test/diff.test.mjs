import assert from "node:assert/strict";
import { test } from "node:test";
import { changes, steps, wordCount } from "../src/diff.mjs";

/** the two sides a list of steps leads between */
const sides = (list) => ({
  before: list.filter(([op]) => op !== "ins").map(([, value]) => value),
  after: list.filter(([op]) => op !== "del").map(([, value]) => value),
});

const differences = (list) => list.filter(([op]) => op !== "same").length;

test("steps lead from one list to the other", () => {
  for (const [a, b] of [
    ["", ""],
    ["abc", "abc"],
    ["", "abc"],
    ["abc", ""],
    ["abcabba", "cbabac"],
    ["kitten", "sitting"],
    ["the quick brown fox", "the quiet brown ox"],
  ]) {
    const list = steps([...a], [...b]);
    assert.deepEqual(sides(list), { before: [...a], after: [...b] }, `${a} -> ${b}`);
  }
});

test("steps take the shortest way", () => {
  assert.equal(differences(steps([..."abc"], [..."abc"])), 0);
  assert.equal(differences(steps([..."abcabba"], [..."cbabac"])), 5);
  assert.equal(differences(steps([..."kitten"], [..."sitting"])), 5);
  assert.deepEqual(steps(["a", "b", "c"], ["a", "x", "c"]), [
    ["same", "a"],
    ["del", "b"],
    ["ins", "x"],
    ["same", "c"],
  ]);
});

test("steps give up on lists that differ in too many places", () => {
  const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
  assert.equal(steps(a, b, 20), null);
  assert.equal(differences(steps(a, b, 80)), 80);
  // what the two share at either end does not count against the limit
  assert.equal(differences(steps(["same", ...a.slice(0, 3), "end"], ["same", ...b.slice(0, 3), "end"], 6)), 6);
});

test("words are counted, and punctuation is not", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("One, two — three!"), 3);
  assert.equal(wordCount("It's the reader's, isn’t it?"), 5);
  assert.equal(wordCount("naïve café\n\n2026"), 3);
});

test("a changed word is shown by itself, in the paragraph it is in", () => {
  const { blocks, added, removed } = changes(
    "The first paragraph.\n\nA slow reading of the text.\n\nThe last.",
    "The first paragraph.\n\nA careful reading of the text.\n\nThe last."
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["same", "changed", "same"]
  );
  assert.deepEqual(blocks[1].parts, [
    { op: "same", text: "A " },
    { op: "del", text: "slow" },
    { op: "ins", text: "careful" },
    { op: "same", text: " reading of the text." },
  ]);
  assert.deepEqual([added, removed], [1, 1]);
});

test("words changed side by side are shown as one phrase for another", () => {
  const { blocks, added, removed } = changes("We met on a cold grey morning.", "We met on one warm bright morning.");
  assert.deepEqual(blocks[0].parts, [
    { op: "same", text: "We met on " },
    { op: "del", text: "a cold grey" },
    { op: "ins", text: "one warm bright" },
    { op: "same", text: " morning." },
  ]);
  assert.deepEqual([added, removed], [3, 3]);
});

test("paragraphs added and taken away are counted whole", () => {
  const grown = changes("One.\n\nTwo.", "One.\n\nTwo.\n\nThree more words.");
  assert.deepEqual([grown.added, grown.removed], [3, 0]);
  assert.ok(grown.blocks.at(-1).parts.some((part) => part.op === "ins" && part.text.includes("Three more words.")));
  assert.ok(!grown.blocks.at(-1).parts.some((part) => part.op === "del"));

  const shrunk = changes("One.\n\nTwo words.\n\nThree.", "One.\n\nThree.");
  assert.deepEqual([shrunk.added, shrunk.removed], [0, 2]);
});

test("texts that read the same have nothing changed, whatever their line endings", () => {
  const { blocks, added, removed } = changes("One.\r\n\r\nTwo.", "One.\n\nTwo.");
  assert.deepEqual(blocks, [{ kind: "same", lines: ["One.", "", "Two."] }]);
  assert.deepEqual([added, removed], [0, 0]);
});

test("every change can be read back as the text before and the text after", () => {
  const before = "# A title\n\nFirst thoughts on the matter, set down in haste.\n\n- one\n- two\n\nAn ending.";
  const after = "# A better title\n\nSecond thoughts on the matter, set down at leisure.\n\n- one\n- two\n- three\n\nAn ending.";
  const { blocks } = changes(before, after);
  // blank lines aside: a line that only one side has leaves an empty place on the other
  const lines = (text) => text.split("\n").filter(Boolean);
  const side = (drop) =>
    lines(
      blocks
        .map((block) =>
          block.kind === "same"
            ? block.lines.join("\n")
            : block.parts
                .filter((part) => part.op !== drop)
                .map((part) => part.text)
                .join("")
        )
        .join("\n")
    );
  assert.deepEqual(side("ins"), lines(before));
  assert.deepEqual(side("del"), lines(after));
});
