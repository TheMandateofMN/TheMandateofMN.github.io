import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-test-"));
process.env.DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { passage, wordsOf } = await import("../src/search.mjs");

const shown = (pieces) => pieces.map(({ text, hit }) => (hit ? `[${text}]` : text)).join("");

test("a search is a few words, each once, whatever their capitals", () => {
  assert.deepEqual(wordsOf("  The  Quince the QUINCE "), ["the", "quince"]);
  assert.deepEqual(wordsOf(""), []);
  assert.deepEqual(wordsOf(null), []);
  assert.equal(wordsOf("a b c d e f g h i j").length, 6);
  assert.ok(wordsOf("x".repeat(5000))[0].length <= 100);
});

test("a passage shows the words where they are, and marks them", () => {
  assert.equal(shown(passage("The quince is a hard fruit.", ["quince"])), "The [quince] is a hard fruit.");
  assert.equal(shown(passage("Quince and QUINCE and quinces.", ["quince"])), "[Quince] and [QUINCE] and [quince]s.");
  assert.equal(shown(passage("One  two\n\nthree.", ["two", "three"])), "One [two] [three].");
  assert.equal(shown(passage("Nothing of the kind here.", ["quince"])), "Nothing of the kind here.");
  // where one word is within another, or runs into it, each letter is marked once
  assert.equal(shown(passage("An orchard.", ["orchard", "or", "chard"])), "An [orchard].");
  assert.equal(shown(passage("abcd", ["abc", "bcd"])), "[abc]d");
});

test("a long text is cut at words, around the first of what was looked for", () => {
  const long = `${"before ".repeat(60)}the quince itself ${"after ".repeat(80)}`;
  const text = shown(passage(long, ["quince"]));
  assert.match(text, /^… (before )+the \[quince\] itself (after )+after …$/);
  assert.ok(text.length < 260, `it is ${text.length} characters`);
  const early = shown(passage(`The quince comes first. ${"after ".repeat(80)}`, ["quince"]));
  assert.match(early, /^The \[quince\] comes first\. (after )+after …$/);
  // one unbroken run of letters is still cut, since there is no word to cut it at
  assert.ok(shown(passage("x".repeat(3000), ["y"])).length < 240);
});
