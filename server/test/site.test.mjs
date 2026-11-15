/*
 * The landing page and the forum are two things in one repository that lean
 * on each other: both take their colours from assets/palette.css, and the
 * forum serves the typeface and the emblem out of the landing page's assets.
 * Here what each expects of the other is checked, so that a change to one
 * that would quietly break the other is caught before it is published.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (...path) => readFileSync(join(ROOT, ...path), "utf8");

/** the custom properties a stylesheet sets, and the ones it reads */
const sets = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((found) => found[1]));
const reads = (css) => new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((found) => found[1]));

/** the colours of the palette by name, as assets/palette.css gives them */
const palette = () =>
  Object.fromEntries([...text("assets", "palette.css").matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6});/g)].map((found) => [found[1], found[2]]));

test("both stylesheets read no colour that the palette or they themselves do not name", () => {
  const named = sets(text("assets", "palette.css"));
  assert.ok(named.size >= 17, "the palette is there, with all its colours");
  for (const path of [["styles.css"], ["server", "public", "forum.css"]]) {
    const css = text(...path);
    const own = sets(css);
    const missing = [...reads(css)].filter((name) => !named.has(name) && !own.has(name));
    assert.deepEqual(missing, [], `${path.join("/")} reads what nothing sets`);
  }
});

test("both pages load the palette before the stylesheet that uses it", async () => {
  const landing = text("index.html");
  assert.ok(landing.indexOf("assets/palette.css") > 0, "the landing page links the palette");
  assert.ok(landing.indexOf("assets/palette.css") < landing.indexOf("styles.css"), "and links it first");

  const views = text("server", "src", "views.mjs");
  assert.ok(views.indexOf('href="${PALETTE}"') > 0, "the forum links the palette");
  assert.ok(views.indexOf('href="${PALETTE}"') < views.indexOf('href="/static/forum.css'), "and links it first");
});

test("the ornament is drawn in the palette as it now stands", () => {
  // an SVG used as a background cannot read the palette, so the generator has the colours written out again
  const tool = text("tools", "build-ornament.mjs");
  const [, block] = tool.match(/const PALETTE = \{([\s\S]*?)\n\};/);
  const kebab = (name) => `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  const written = Object.fromEntries([...block.matchAll(/(\w+):\s*"(#[0-9a-f]{6})"/g)].map((found) => [kebab(found[1]), found[2]]));
  assert.deepEqual(written, palette(), "tools/build-ornament.mjs has the same colours as assets/palette.css");

  // and the vines were drawn again after the last change: run `node tools/build-ornament.mjs` if not
  const colours = new Set(Object.values(palette()));
  for (const file of ["vine.svg", "vine-tip.svg"]) {
    const stray = new Set((text("assets", file).match(/#[0-9a-f]{6}\b/gi) || []).map((hex) => hex.toLowerCase()).filter((hex) => !colours.has(hex)));
    assert.deepEqual([...stray], [], `assets/${file} has colours that are not in the palette`);
  }
});

test("everything either page asks for from the shared assets is there", () => {
  const there = (path, asked) => assert.ok(existsSync(join(ROOT, path)), `${asked} asks for ${path}, which is not there`);
  const bare = (address) => address.replace(/[?#].*$/, "");
  const local = (address) => !/^(?:[a-z]+:|\/\/|#)/i.test(address);

  // the landing page: what index.html links, and what its stylesheets fetch
  for (const [, address] of text("index.html").matchAll(/(?:href|src)="([^"]+)"/g))
    if (local(address)) there(bare(address), "index.html");
  for (const [, address] of text("styles.css").matchAll(/url\("?([^")]+)"?\)/g))
    if (local(address)) there(bare(address), "styles.css");
  for (const [, address] of text("assets", "fonts", "eb-garamond.css").matchAll(/url\("?([^")]+)"?\)/g))
    if (local(address)) there(join("assets", "fonts", bare(address)), "assets/fonts/eb-garamond.css");

  // the forum: it serves /assets out of the same folder, so it needs the whole repository beside it
  for (const path of [["server", "public", "forum.css"], ["server", "src", "views.mjs"]])
    for (const [address] of text(...path).matchAll(/\/assets\/[A-Za-z0-9_./-]+\.[a-z0-9]+/g)) there(address.slice(1), path.join("/"));
  for (const [, parts] of text("server", "src", "views.mjs").matchAll(/shared\(((?:"[^"]+"(?:,\s*)?)+)\)/g))
    there(join("assets", ...parts.split(/,\s*/).map((part) => part.slice(1, -1))), "server/src/views.mjs");
});

test("what must stay on the forum's own machine is kept out of git and off the website", () => {
  const ignored = text(".gitignore").split("\n").map((line) => line.trim());
  for (const path of ["server/data/", "server/.env", "node_modules/"])
    assert.ok(ignored.includes(path), `.gitignore leaves out ${path}`);
  // GitHub Pages publishes the repository as the landing page; the forum's code is not part of that page
  const left = [...text("_config.yml").matchAll(/^\s*-\s*"?([^"\n]+)"?\s*$/gm)].map((found) => found[1]);
  for (const path of ["server", "tools"]) assert.ok(left.includes(path), `_config.yml leaves ${path} off the website`);
});
