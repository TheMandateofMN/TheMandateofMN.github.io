/*
 * Drawing LaTeX diagrams.
 *
 * A block of a post marked `tikz` is set as a small LaTeX document, run
 * through latex, and turned by dvisvgm into an SVG whose letters are outlines,
 * so it needs no fonts where it is shown. Each drawing is made once and kept
 * in the database under a hash of its source; so is the reason, when one
 * cannot be drawn. A diagram still being written, drawn only for the preview
 * beside the editor, is held in memory instead and soon forgotten.
 *
 * What is typed here is run by a real TeX, so it is run with its hands tied:
 * no shell commands, no reading or writing outside its own scratch folder,
 * and a limit on how long it may take. The SVGs are only ever shown as
 * images, and are served so that nothing in them can run.
 *
 * Where TeX is not installed nothing is drawn, and a post shows the source of
 * its diagrams with a line saying so.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.mjs";
import { drawings } from "./db.mjs";

const run = promisify(execFile);

/* where TeX is usually installed, should the server's PATH not include it */
const USUAL_PLACES = ["/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

function find(name, set) {
  if (set) return set;
  for (const dir of [...(process.env.PATH || "").split(delimiter), ...USUAL_PLACES]) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return null;
}

const off = config.latex === "off" || config.dvisvgm === "off";
const programs = off ? {} : { latex: find("latex", config.latex), dvisvgm: find("dvisvgm", config.dvisvgm) };

/** whether diagrams can be drawn on this machine */
export const canDraw = Boolean(programs.latex && programs.dvisvgm);

/* part of every drawing's hash: change how drawings are set and they are all drawn afresh */
const SETTING = "1";

/* TeX points to pixels on the page: its ten-point letters come out about the size of the text around them */
const SCALE = 2;

const PLOT = /\\begin\s*\{(axis|semilogxaxis|semilogyaxis|loglogaxis|polaraxis)\}/;

/**
 * The LaTeX document a diagram's source is set in. A source may be a whole
 * document of its own, in which case its preamble is kept; or just a
 * picture; or just the commands inside one.
 */
function documentFor(source) {
  let preamble = "";
  let body = source;
  const begin = source.indexOf("\\begin{document}");
  if (begin !== -1) {
    preamble = source.slice(0, begin).replace(/\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, "");
    const end = source.indexOf("\\end{document}", begin);
    body = source.slice(begin + "\\begin{document}".length, end === -1 ? undefined : end);
  }
  // bare drawing commands need a picture to be in, and so does a plot's axis
  const bare = !/\\begin\s*\{/.test(body) || (PLOT.test(body) && !/\\begin\s*\{tikzpicture\}/.test(body));
  if (bare) body = `\\begin{tikzpicture}\n${body.trim()}\n\\end{tikzpicture}`;
  return [
    "\\documentclass[dvisvgm,border=2pt]{standalone}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{tikz}",
    "\\usepackage{tikz-cd}",
    "\\usetikzlibrary{arrows.meta,calc,positioning}",
    PLOT.test(body) && !preamble.includes("pgfplots") && "\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}",
    // the page's own colours, by name
    "\\definecolor{ink}{HTML}{3F2E1F}",
    "\\definecolor{gold}{HTML}{B8922A}",
    "\\definecolor{madder}{HTML}{8B3048}",
    "\\definecolor{verdigris}{HTML}{47603F}",
    preamble.trim(),
    "\\begin{document}",
    "\\color{ink}",
    body.trim(),
    "\\end{document}",
    "",
  ]
    .filter((line) => line !== false && line !== "")
    .join("\n");
}

export const hashOf = (source) =>
  createHash("sha256").update(`${SETTING}\n${source.trim()}`).digest("hex").slice(0, 32);

/** TeX's own account of what stopped it, from what it printed */
function complaint(printed = "") {
  const lines = printed.split("\n");
  const at = lines.findIndex((line) => line.startsWith("! "));
  if (at === -1) return "LaTeX stopped without saying why.";
  const message = lines[at].slice(2).trim();
  const where = lines.slice(at + 1, at + 8).find((line) => /^l\.\d+ /.test(line));
  const near = where?.replace(/^l\.\d+ /, "").trim();
  return near ? `${message} Near: ${near}` : message;
}

async function compile(source) {
  const dir = await mkdtemp(join(tmpdir(), "gesserit-tex-"));
  const options = {
    cwd: dir,
    timeout: config.diagramSeconds * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    // paranoid: TeX may open nothing outside this folder and its own installation
    env: { ...process.env, openin_any: "p", openout_any: "p", shell_escape: "f" },
  };
  try {
    await writeFile(join(dir, "d.tex"), documentFor(source));
    try {
      await run(programs.latex, ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "d.tex"], options);
    } catch (err) {
      if (err.killed) return { error: `It took more than ${config.diagramSeconds} seconds.` };
      if (typeof err.code !== "number") throw err;
      return { error: complaint(err.stdout) };
    }
    try {
      await run(programs.dvisvgm, ["--no-fonts", "--exact-bbox", "--output=d.svg", "d.dvi"], options);
    } catch (err) {
      if (err.killed) return { error: `It took more than ${config.diagramSeconds} seconds.` };
      if (typeof err.code !== "number") throw err;
      return { error: "LaTeX set it, but it could not be made into a picture." };
    }
    const svg = (await readFile(join(dir, "d.svg"), "utf8")).replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<!--[\s\S]*?-->\s*/, "");
    const size = /<svg[^>]*\swidth='([\d.]+)pt'[^>]*\sheight='([\d.]+)pt'/.exec(svg);
    if (!size) return { error: "There was nothing in it to draw." };
    if (svg.length > 3 * 1024 * 1024) return { error: "The drawing is too large to keep." };
    return { svg, width: Math.round(Number(size[1]) * SCALE), height: Math.round(Number(size[2]) * SCALE) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* one at a time: TeX is not light, and a post rarely has many */
let last = Promise.resolve();
const inTurn = (work) => (last = last.then(work, work));
const underway = new Map();

/* what has been drawn for a preview: the latest few, until the post they are in is saved */
const MOST_HELD = 40;
const held = new Map();

function hold(hash, result) {
  held.set(hash, result);
  if (held.size > MOST_HELD) held.delete(held.keys().next().value);
}

const attempt = (hash, source) =>
  inTurn(() => compile(source))
    .then(
      (result) => hold(hash, result),
      // the machine's trouble rather than the diagram's: not remembered, so it is tried again
      (err) => console.error("A diagram could not be attempted:", err.message)
    )
    .finally(() => underway.delete(hash));

/**
 * Draws a diagram if it has not been drawn, and resolves once it has been or
 * has failed. With `keep`, the outcome goes into the database; without, it is
 * only held for a while, which is all a preview needs.
 */
export async function draw(source, { keep = true } = {}) {
  if (!canDraw || source.length > config.maxDiagramLength) return;
  const hash = hashOf(source);
  if (drawings.get(hash)) return;
  if (!held.has(hash)) {
    if (!underway.has(hash)) underway.set(hash, attempt(hash, source));
    await underway.get(hash);
  }
  if (keep && held.has(hash)) {
    drawings.put({ hash, ...held.get(hash) });
    held.delete(hash);
  }
}

const outcome = (hash) => drawings.get(hash) ?? held.get(hash) ?? null;

/** what there is to show for a diagram: see `drawing` in render.mjs */
export function drawn(source) {
  if (source.length > config.maxDiagramLength) return { error: "It is too long." };
  if (!canDraw) return { error: "LaTeX is not installed on this server." };
  const hash = hashOf(source);
  const result = outcome(hash);
  if (!result) return null;
  return result.error ? { error: result.error } : { src: `/tex/${hash}.svg`, width: result.width, height: result.height };
}

/** the SVG kept or held under a hash, if there is one */
export const svgOf = (hash) => outcome(hash)?.svg ?? null;
