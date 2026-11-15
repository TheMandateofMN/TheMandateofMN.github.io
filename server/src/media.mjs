/*
 * Pictures members upload to put in what they write.
 *
 * A file is taken for what its first bytes say it is, never for what it was
 * called, and is kept in the data folder under a random name. Pictures are
 * for members' eyes like everything else, and are served so that a browser
 * will show them but never run anything in them, which matters for SVG.
 */

import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.mjs";
import { media } from "./db.mjs";
import { COMMON_HEADERS, HttpError, sendStream } from "./http.mjs";

const FOLDER = join(config.dataDir, "media");

const KINDS = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const starts = (buffer, bytes, at = 0) => bytes.every((byte, i) => buffer[at + i] === byte);
const ascii = (text) => [...text].map((letter) => letter.charCodeAt(0));

/** what kind of picture these bytes are, by how they begin; null if none we show */
export function kindOf(buffer) {
  if (starts(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(buffer, [0xff, 0xd8, 0xff])) return "jpg";
  if (starts(buffer, ascii("GIF87a")) || starts(buffer, ascii("GIF89a"))) return "gif";
  if (starts(buffer, ascii("RIFF")) && starts(buffer, ascii("WEBP"), 8)) return "webp";
  if (starts(buffer, ascii("ftypavif"), 4)) return "avif";
  const opening = buffer.subarray(0, 2048).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(opening)) return "svg";
  return null;
}

/** keeps an uploaded picture and gives back the address it can be shown from */
export async function keep(buffer, { userId, original = "" }) {
  if (buffer.length === 0) throw new HttpError(400, "That file is empty.");
  const kind = kindOf(buffer);
  if (!kind) throw new HttpError(415, "That is not a picture that can be shown here. Use a PNG, JPEG, GIF, WebP, AVIF or SVG.");
  const name = `${randomBytes(9).toString("base64url").replace(/[-_]/g, "x").toLowerCase()}.${kind}`;
  await mkdir(FOLDER, { recursive: true, mode: 0o700 });
  await writeFile(join(FOLDER, name), buffer, { flag: "wx", mode: 0o600 });
  media.create({ name, userId, type: KINDS[kind], bytes: buffer.length, original: original.slice(0, 200) || null });
  return `/media/${name}`;
}

/* nothing in a picture may run or fetch, even if it is opened by itself */
export const INERT = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export async function sendMedia(res, name) {
  const kept = /^[a-z0-9]+\.[a-z]+$/.test(name) ? media.byName(name) : null;
  let info;
  try {
    info = kept && (await stat(join(FOLDER, name)));
  } catch {
    info = null;
  }
  if (!info?.isFile()) throw new HttpError(404, "That picture is not here.");
  res.writeHead(200, {
    "Content-Type": kept.type,
    "Content-Length": info.size,
    // a picture never changes once it has been kept
    "Cache-Control": "private, max-age=31536000, immutable",
    ...COMMON_HEADERS,
    "Content-Security-Policy": INERT,
  });
  sendStream(res, join(FOLDER, name));
}
