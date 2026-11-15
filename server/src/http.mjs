/*
 * The little that is needed on top of node:http: a router, form and cookie
 * parsing, responses and static files.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { config } from "./config.mjs";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------------------------------------------------------------- router */

export class Router {
  #routes = [];

  /** path segments beginning with a colon are captured, e.g. "/p/:id/notes" */
  #add(method, path, handlers) {
    const names = [];
    const pattern = path.replace(/:([a-z]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    this.#routes.push({ method, regex: new RegExp(`^${pattern}$`), names, handlers });
  }

  get(path, ...handlers) {
    this.#add("GET", path, handlers);
  }

  post(path, ...handlers) {
    this.#add("POST", path, handlers);
  }

  match(method, pathname) {
    let pathKnown = false;
    for (const route of this.#routes) {
      const hit = route.regex.exec(pathname);
      if (!hit) continue;
      pathKnown = true;
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
      const params = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(hit[i + 1])));
      return { handlers: route.handlers, params };
    }
    return pathKnown ? { methodNotAllowed: true } : null;
  }
}

/* -------------------------------------------------------------- requests */

export function parseCookies(header = "") {
  const jar = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in jar)) jar[name] = part.slice(eq + 1).trim();
  }
  return jar;
}

/** everything a request sends, up to `most` bytes; past that it is refused with `tooLong` */
export async function readBody(req, most, tooLong) {
  if (Number(req.headers["content-length"]) > most) throw new HttpError(413, tooLong);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > most) throw new HttpError(413, tooLong);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** the body of an urlencoded form, as URLSearchParams */
export async function readForm(req) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new HttpError(415, "Unsupported form type.");
  const body = await readBody(req, config.maxBodyBytes, "That is too long to save in one piece.");
  return new URLSearchParams(body.toString("utf8"));
}

/** whether the request was made by the page's script, which wants its answers as JSON */
export const wantsJson = (req) => String(req.headers.accept || "").includes("application/json");

/**
 * Browsers send Origin with every form post, so a post from another site is
 * recognisable. Requests without the header (scripts, old browsers) still need
 * the session's CSRF token.
 */
export function sameOrigin(req) {
  // browsers also say outright where a request was made from; a page on another site, or on
  // another part of this one's domain, has no business posting here
  const from = req.headers["sec-fetch-site"];
  if (from && from !== "same-origin" && from !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = config.publicUrl ? new URL(config.publicUrl).host : req.headers.host;
  try {
    return new URL(origin).host === expected;
  } catch {
    return false;
  }
}

export function clientAddress(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "";
}

/** a path on this site, safe to redirect to after signing in */
export function localPath(value, fallback = "/") {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : fallback;
}

/* ------------------------------------------------------------- responses */

/* what goes with everything this server sends, whatever it is */
export const COMMON_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
  // nothing here is for another site to load, frame or hold a window on
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  // and no page here has any use for the devices of whoever reads it
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()",
  ...(config.secureCookies ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
};

const SECURITY_HEADERS = {
  // everything a page is made of comes from this server: no other site's scripts, styles or fonts
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // formulas are set by KaTeX, which places every piece with a style of its own
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https: http:",
    "connect-src 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  ...COMMON_HEADERS,
};

export function send(res, status, body, headers = {}) {
  const buffer = Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : buffer);
}

/** sends a file's bytes; if it cannot be read after all, the connection is dropped rather than the server */
export function sendStream(res, path) {
  if (res.req.method === "HEAD") return res.end();
  const stream = createReadStream(path);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" });
}

/** 303, so a form post is always followed by a plain GET */
export function redirect(res, location, headers = {}) {
  send(res, 303, "", { Location: location, ...headers });
}

/*
 * Over https the cookie is named with the __Host- prefix, which a browser
 * only accepts from this very host, over https, for the whole site: another
 * part of the domain cannot plant a session here.
 */
export const SESSION_COOKIE = config.secureCookies ? "__Host-session" : "session";

/** the session token a request came with, if any */
export const sessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE] || "";

export function sessionCookie(token, { clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${clear ? 0 : config.sessionDays * 24 * 60 * 60}`,
  ];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

/* ---------------------------------------------------------- static files */

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export async function sendFile(res, root, relative, cache = "public, max-age=86400") {
  const path = resolve(root, `.${sep}${relative}`);
  const type = TYPES[extname(path).toLowerCase()];
  if (!type || !path.startsWith(root + sep)) throw new HttpError(404, "Not found.");
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new HttpError(404, "Not found.");
  }
  if (!info.isFile()) throw new HttpError(404, "Not found.");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": cache,
    ...COMMON_HEADERS,
  });
  sendStream(res, path);
}
