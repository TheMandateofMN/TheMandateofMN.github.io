import assert from "node:assert/strict";
import { test } from "node:test";
import { merge, mergeLine, settle } from "../src/merge.mjs";

const BASE = ["# Plan", "", "First we gather.", "", "Then we write.", "", "Last we check."].join("\n");

test("changes to different passages are both taken", () => {
  const ours = BASE.replace("First we gather.", "First we gather everything.");
  const theirs = BASE.replace("Last we check.", "Last we check it twice.");
  const { text, clashes } = merge(BASE, ours, theirs);
  assert.equal(clashes, 0);
  assert.equal(text, BASE.replace("First we gather.", "First we gather everything.").replace("Last we check.", "Last we check it twice."));
  // and it does not matter whose is whose
  assert.equal(merge(BASE, theirs, ours).text, text);
});

test("a change only one of them made is taken, and one both made is taken once", () => {
  const changed = BASE.replace("Then we write.", "Then we write it all down.");
  assert.equal(merge(BASE, changed, BASE).text, changed);
  assert.equal(merge(BASE, BASE, changed).text, changed);
  assert.equal(merge(BASE, changed, changed).text, changed);
  assert.equal(merge(BASE, BASE, BASE).text, BASE);
});

test("lines added in different places, and at either end, are all kept", () => {
  const ours = `A preface.\n\n${BASE}`;
  const theirs = `${BASE}\n\nAn afterword.`;
  assert.equal(merge(BASE, ours, theirs).text, `A preface.\n\n${BASE}\n\nAn afterword.`);

  const list = "- one\n- two\n- three";
  assert.equal(merge(list, "- nought\n- one\n- two\n- three", "- one\n- two\n- three\n- four").text, "- nought\n- one\n- two\n- three\n- four");
  // one changes an item while the other adds after it
  assert.equal(merge(list, "- one\n- TWO\n- three", "- one\n- two\n- two and a half\n- three").text, "- one\n- TWO\n- two and a half\n- three");
});

test("one takes a passage out while the other changes something else", () => {
  const ours = BASE.replace("\n\nThen we write.", "");
  const theirs = BASE.replace("# Plan", "# The plan");
  assert.equal(merge(BASE, ours, theirs).text, "# The plan\n\nFirst we gather.\n\nLast we check.");
});

test("different words changed in the same paragraph do not clash", () => {
  const base = "The quick brown fox jumps over the lazy dog, as it always has.";
  const ours = "The quick red fox jumps over the lazy dog, as it always has.";
  const theirs = "The quick brown fox jumps over the sleeping dog, as it always has.";
  const { text, clashes } = merge(base, ours, theirs);
  assert.equal(clashes, 0);
  assert.equal(text, "The quick red fox jumps over the sleeping dog, as it always has.");
});

test("the same words changed differently are a clash, with both wordings to choose from", () => {
  const ours = BASE.replace("Then we write.", "Then we draft.");
  const theirs = BASE.replace("Then we write.", "Then we argue.");
  const { parts, clashes, text } = merge(BASE, ours, theirs);
  assert.equal(clashes, 1);
  assert.equal(text, null);
  assert.deepEqual(parts, [
    { lines: ["# Plan", "", "First we gather.", ""] },
    { clash: true, base: ["Then we write."], ours: ["Then we draft."], theirs: ["Then we argue."] },
    { lines: ["", "Last we check."] },
  ]);

  assert.equal(settle(parts, ["ours"]), ours);
  assert.equal(settle(parts, ["theirs"]), theirs);
  assert.equal(settle(parts, ["both"]), BASE.replace("Then we write.", "Then we draft.\nThen we argue."));
  assert.equal(settle(parts), ours, "with nothing chosen, ours stands");
});

test("taking a passage out clashes with changing it", () => {
  const ours = BASE.replace("\n\nThen we write.", "");
  const theirs = BASE.replace("Then we write.", "Then we write, slowly.");
  const { parts, clashes } = merge(BASE, ours, theirs);
  assert.equal(clashes, 1);
  assert.equal(settle(parts, ["ours"]), ours);
  assert.equal(settle(parts, ["theirs"]), theirs);
});

test("two different additions at the same place are a clash; the same addition is not", () => {
  const { parts, clashes } = merge("- one", "- one\n- two", "- one\n- deux");
  assert.equal(clashes, 1);
  assert.deepEqual(parts.find((part) => part.clash), { clash: true, base: [], ours: ["- two"], theirs: ["- deux"] });
  assert.equal(settle(parts, ["both"]), "- one\n- two\n- deux");

  assert.equal(merge("- one", "- one\n- two", "- one\n- two").text, "- one\n- two");
});

test("several clashes are each decided for themselves, and what is not in doubt is merged around them", () => {
  const ours = BASE.replace("# Plan", "# Our plan").replace("First we gather.", "First we read.").replace("Last we check.", "Last we rest.");
  const theirs = BASE.replace("First we gather.", "First we listen.").replace("Then we write.", "Then we write at length.").replace("Last we check.", "Last we publish.");
  const { parts, clashes } = merge(BASE, ours, theirs);
  assert.equal(clashes, 2);
  assert.equal(
    settle(parts, ["theirs", "ours"]),
    ["# Our plan", "", "First we listen.", "", "Then we write at length.", "", "Last we rest."].join("\n")
  );
});

test("line endings do not matter, and nothing is lost from texts that share nothing", () => {
  assert.equal(merge("one\r\ntwo", "one\r\ntwo\r\nthree", "nought\none\ntwo").text, "nought\none\ntwo\nthree");

  const { parts, clashes } = merge("alpha", "beta", "gamma");
  assert.equal(clashes, 1);
  assert.equal(settle(parts, ["both"]), "beta\ngamma");
  assert.equal(merge("", "written first", "").text, "written first");
});

test("a merge of random edits never loses a change that did not clash", () => {
  // a small generator with a seed, so a failure can be run again
  let seed = 20261110;
  const random = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  for (let round = 0; round < 300; round++) {
    // each side changes lines of its own: ours the even ones, theirs the odd, never neighbours of each other's
    const ours = [...base];
    const theirs = [...base];
    for (let i = 0; i < 6; i++) ours[random(10) * 4] += ` (ours ${round})`;
    for (let i = 0; i < 6; i++) theirs[random(10) * 4 + 2] += ` (theirs ${round})`;
    const { text, clashes } = merge(base.join("\n"), ours.join("\n"), theirs.join("\n"));
    assert.equal(clashes, 0);
    const expected = base.map((line, i) => (i % 4 === 0 ? ours[i] : i % 4 === 2 ? theirs[i] : line)).join("\n");
    assert.equal(text, expected, `round ${round}`);
  }
});

test("a title changed by either is kept; changed by both, ours stands", () => {
  assert.equal(mergeLine("Plan", "Plan", "The plan"), "The plan");
  assert.equal(mergeLine("Plan", "Our plan", "Plan"), "Our plan");
  assert.equal(mergeLine("Plan", "Our plan", "Their plan"), "Our plan");
  assert.equal(mergeLine("Plan", "Plan", "Plan"), "Plan");
});
