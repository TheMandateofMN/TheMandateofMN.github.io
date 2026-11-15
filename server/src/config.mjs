/*
 * Everything the server reads from its environment.
 *
 *   PORT         port to listen on                         (default 8787)
 *   HOST         address to bind                           (default 127.0.0.1)
 *   PUBLIC_URL   where members reach the forum, e.g.
 *                https://forum.gesserit.org. An https URL
 *                turns on Secure cookies and pins the
 *                origin that forms may be posted from.
 *   DATA_DIR     where the SQLite database lives           (default server/data)
 *   LANDING_URL  the public landing page                   (default https://gesserit.org/)
 *   TRUST_PROXY  set to 1 behind a reverse proxy, so the
 *                sign-in limiter sees the visitor's address
 *   LATEX        the latex program that draws diagrams     (default: looked for on the PATH
 *   DVISVGM      and the dvisvgm that makes them SVG        and where TeX is usually installed)
 *                Set either to "off" to leave diagrams undrawn.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "..");

const publicUrl = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || "127.0.0.1",
  publicUrl,
  secureCookies: publicUrl.startsWith("https://"),
  dataDir: resolve(process.env.DATA_DIR || resolve(SERVER_ROOT, "data")),
  landingUrl: process.env.LANDING_URL || "https://gesserit.org/",
  trustProxy: process.env.TRUST_PROXY === "1",
  latex: process.env.LATEX || "",
  dvisvgm: process.env.DVISVGM || "",

  sessionDays: 60,
  postsPerPage: 20,
  maxBodyBytes: 1024 * 1024,
  maxNoteLength: 5000,
  maxQuoteLength: 600,
  maxUploadBytes: 10 * 1024 * 1024,
  maxDiagramLength: 20_000,
  // how many diagrams one text may have drawn, and how long LaTeX is given for each
  maxDiagrams: 12,
  diagramSeconds: 20,
  maxMessageLength: 4000,
  // how many messages a conversation shows at first; the ones before are a link away
  messagesShown: 60,
  minPasswordLength: 10,
  // how much can be typed into a search
  maxSearchLength: 100,
};
