/*
 * Drawing diagrams with LaTeX itself. These need `latex` and `dvisvgm` on the
 * machine; where they are missing the tests are skipped, and the forum shows
 * a diagram's source instead of its drawing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// the database is opened on import, so point it at a scratch directory first
const scratch = mkdtempSync(join(tmpdir(), "gesserit-tex-test-"));
process.env.DATA_DIR = scratch;

const { canDraw, draw, drawn, hashOf, svgOf } = await import("../src/tex.mjs");
const { db, drawings } = await import("../src/db.mjs");
const { config } = await import("../src/config.mjs");

after(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const skip = canDraw ? false : "latex and dvisvgm are not installed here";

const SQUARE = '\\begin{tikzcd}\n  A \\arrow[r, "f"] & B\n\\end{tikzcd}';

test("a diagram is known by its source, whatever space surrounds it", () => {
  assert.match(hashOf(SQUARE), /^[0-9a-f]{32}$/);
  assert.equal(hashOf(`\n${SQUARE}\n\n`), hashOf(SQUARE));
  assert.notEqual(hashOf(SQUARE.replace("f", "g")), hashOf(SQUARE));
});

test("a diagram too long to draw is refused before LaTeX sees it", async () => {
  const long = `\\draw (0,0) -- (1,1); % ${"x".repeat(config.maxDiagramLength)}`;
  await draw(long);
  assert.deepEqual(drawn(long), { error: "It is too long." });
});

test("a diagram is drawn once, kept, and served as a picture", { skip }, async () => {
  assert.equal(drawn(SQUARE), null, "nothing until it has been drawn");
  await draw(SQUARE);

  const drawing = drawn(SQUARE);
  assert.equal(drawing.src, `/tex/${hashOf(SQUARE)}.svg`);
  assert.ok(drawing.width > 40 && drawing.width < 600, `a sensible width, not ${drawing.width}`);
  assert.ok(drawing.height > 10 && drawing.height < 300, `a sensible height, not ${drawing.height}`);

  const svg = svgOf(hashOf(SQUARE));
  assert.match(svg, /^<svg[\s>]/);
  // the letters are drawn as shapes, so the picture needs no fonts, and nothing in it can run or fetch
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|@font-face|href=['"]https?:/i);

  const kept = drawings.get(hashOf(SQUARE));
  assert.equal(kept.svg, svg);
  await draw(SQUARE);
  assert.equal(drawings.get(hashOf(SQUARE)).created_at, kept.created_at, "it is not drawn a second time");
});

test("bare drawing commands and plots need no wrapping by the writer", { skip }, async () => {
  const bare = "\\draw[gold, thick] (0,0) -- (2,1) node[right] {$x$};";
  await draw(bare);
  assert.ok(drawn(bare).src, JSON.stringify(drawn(bare)));
});

test("a preview's drawing is held but not kept, until the text it is in is saved", { skip }, async () => {
  const sketch = "\\draw (0,0) circle (1);";
  await draw(sketch, { keep: false });
  assert.ok(drawn(sketch).src);
  assert.match(svgOf(hashOf(sketch)), /^<svg/);
  assert.equal(drawings.get(hashOf(sketch)), undefined);

  await draw(sketch);
  assert.ok(drawings.get(hashOf(sketch)).svg);
});

test("a diagram LaTeX cannot set says what stopped it", { skip }, async () => {
  const broken = "\\draw (0,0) -- (1,1) \\nosuchcommand;";
  await draw(broken);
  const { error, src } = drawn(broken);
  assert.equal(src, undefined);
  assert.match(error, /Undefined control sequence/);
  assert.match(error, /\\nosuchcommand/);
  assert.equal(svgOf(hashOf(broken)), null);
});

test("a diagram can read nothing of the machine and run nothing on it", { skip }, async () => {
  const marker = join(scratch, "ran");
  for (const prying of [
    "\\node {\\input{/etc/passwd}};",
    `\\immediate\\write18{touch ${marker}}\\node {x};`,
    `\\node {\\input{|"touch ${marker}"}};`,
    `\\newwrite\\out\\immediate\\openout\\out=${marker}\\immediate\\write\\out{x}\\node {x};`,
  ]) {
    await draw(prying, { keep: false });
    const svg = svgOf(hashOf(prying)) || "";
    assert.doesNotMatch(svg, /root|daemon|nobody/, prying);
  }
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "nothing was run and nothing written outside LaTeX's own folder");
  assert.ok(drawn("\\node {\\input{/etc/passwd}};").error, "and a file outside it could not be opened");
});
