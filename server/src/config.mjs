/*
 * Everything the server reads from its environment.
 *
 *   PORT         port to listen on                         (default 8787)
 *   HOST         address to bind                           (default 127.0.0.1)
 *   PUBLIC_URL   where members reach the forum, e.g.
 *                https://forum.gesserit.org. An https URL
 *                turns on Secure cookies and pins the
 *                origin that forms may be posted from.
 *                (On Fly.io the app's fly.dev address is
 *                the default, and is always allowed too.)
 *   DATA_DIR     where the SQLite database lives           (default server/data)
 *   LANDING_URL  the public landing page                   (default https://gesserit.org/)
 *   TRUST_PROXY  set behind a reverse proxy, so the sign-in
 *                limiter sees the visitor's address and not
 *                the proxy's. Either 1, for a proxy that adds
 *                the address to X-Forwarded-For (Caddy, nginx),
 *                or the name of the header the proxy puts it
 *                in, e.g. Fly-Client-IP on Fly.io.
 *   PUSH_CONTACT who a push service can write to about the
 *                notifications the forum sends: an https
 *                address or a mailto: one             (default LANDING_URL)
 *   PUSH_HOSTS   push services to send notifications through
 *                besides those of Chrome, Firefox, Edge and
 *                Safari, as host names with commas between
 *   PUSH_DELAY_MS how long to wait before notifying of a
 *                message, so that whoever is reading the
 *                conversation is not told of it          (default 5000)
 *   PACE         "off" to stop counting how fast members
 *                read (see src/pace.mjs); for tests
 *   MESSAGES     "on" to bring back the conversations
 *                between members, which are put away      (default off)
 *   PROJECTS     "on" to bring back the projects, which
 *                are put away with them                    (default off)
 *   NOTIFICATIONS "on" to bring back the notifications a
 *                member's devices were sent, which are
 *                put away too: nothing is sent, and no
 *                device is taken on                        (default off)
 *   VERSIONS     "on" to bring back the pages of a piece's
 *                earlier wordings. Each is still kept; with
 *                this off none is shown or put back        (default off)
 *   INVITATIONS  "on" to bring back the admins' list of
 *                those to be invited. A link already handed
 *                out works either way                      (default off)
 *   NUMBERS_KEY  the secret that the telephone numbers of
 *                those who are invited are sealed with in
 *                the database: any 32 characters or more,
 *                kept apart from the database. Without it
 *                no number can be kept. Lose it and the
 *                numbers cannot be read again; change it
 *                and the same.
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *                the account that texts are sent through
 *   TWILIO_FROM  what they are sent from: a number of that
 *                account's, as +14155550100, or one of its
 *                messaging services, as MG…
 *   TWILIO_API   where that account is reached           (default https://api.twilio.com)
 *   TEXT_GAP_MS  how long to leave between one text and
 *                the next when many are sent             (default 1100)
 *   SIGNAL_CLI   the signal-cli program, by which the main
 *                admin's Signal account is linked and sent
 *                through                                   (default signal-cli, on the PATH)
 *   WHATSAPP_CLIENT the package that does the same for
 *                WhatsApp                                  (default baileys)
 *   LATEX        the latex program that draws diagrams     (default: looked for on the PATH
 *   DVISVGM      and the dvisvgm that makes them SVG        and where TeX is usually installed)
 *                Set either to "off" to leave diagrams undrawn.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "..");

/* On Fly.io an app also answers at <its name>.fly.dev, before it is given a name of its own and after.
   Fly sets FLY_APP_NAME on every machine, so there the forum knows that address without being told. */
const flyUrl = process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : "";

const publicUrl = (process.env.PUBLIC_URL || flyUrl).replace(/\/+$/, "");

/** the hosts of these addresses, leaving out any that are empty: "https://forum.gesserit.org" is "forum.gesserit.org" */
export const hostsOf = (...urls) => [...new Set(urls.filter(Boolean).map((url) => new URL(url).host))];

/**
 * The request header a proxy in front is trusted to give the visitor's
 * address in, from what TRUST_PROXY is set to; "" where there is no proxy.
 * A setting that cannot be understood stops the server rather than leaving
 * it to count every visitor as the proxy.
 */
export function proxyHeader(setting = "") {
  const said = setting.trim().toLowerCase();
  if (["", "0", "off", "false", "no"].includes(said)) return "";
  if (["1", "on", "true", "yes"].includes(said)) return "x-forwarded-for";
  if (/^[a-z][a-z0-9-]*$/.test(said)) return said;
  throw new Error(`TRUST_PROXY is ${JSON.stringify(setting)}: set it to 1, or to the name of a header such as Fly-Client-IP.`);
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || "127.0.0.1",
  publicUrl,
  // the hosts forms may be posted from; none are named on your own machine, where it is whichever the request came to
  ownHosts: hostsOf(publicUrl, flyUrl),
  secureCookies: publicUrl.startsWith("https://"),
  dataDir: resolve(process.env.DATA_DIR || resolve(SERVER_ROOT, "data")),
  landingUrl: process.env.LANDING_URL || "https://gesserit.org/",
  trustProxy: proxyHeader(process.env.TRUST_PROXY),
  pushContact: process.env.PUSH_CONTACT || process.env.LANDING_URL || "https://gesserit.org/",
  pushHosts: (process.env.PUSH_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
  // how long after something is said before devices are told of it: whoever was looking has read it by then
  pushDelayMs: /^\d+$/.test(process.env.PUSH_DELAY_MS || "") ? Number(process.env.PUSH_DELAY_MS) : 5000,
  // whether reading faster than anyone reads is refused
  pace: (process.env.PACE || "").toLowerCase() !== "off",
  // Two parts of the forum that are put away for now. Each is all still here, and what was said and
  // written in it is kept; switched on, it is back as it was.
  messages: (process.env.MESSAGES || "").toLowerCase() === "on",
  projects: (process.env.PROJECTS || "").toLowerCase() === "on",
  // The notifications sent to a member's devices are put away as well: Preferences has no place to turn them
  // on or off, so until it has, no device is taken on and none is told anything.
  notifications: (process.env.NOTIFICATIONS || "").toLowerCase() === "on",
  // The earlier wordings of a piece are still kept, each as a version, but the pages they were read,
  // compared and put back from are put away: for now a piece is what it says, and nothing is said of what it said.
  versions: (process.env.VERSIONS || "").toLowerCase() === "on",
  // And so is the list of those who are to be invited, until it is settled how members come to be here.
  // An invitation that has already been handed out is still taken up.
  invitations: (process.env.INVITATIONS || "").toLowerCase() === "on",
  // what the numbers of those who are invited are sealed with; and the account that texts them
  numbersKey: process.env.NUMBERS_KEY || "",
  sms: {
    sid: process.env.TWILIO_ACCOUNT_SID || "",
    token: process.env.TWILIO_AUTH_TOKEN || "",
    from: process.env.TWILIO_FROM || "",
    api: (process.env.TWILIO_API || "https://api.twilio.com").replace(/\/+$/, ""),
  },
  // how long to leave between one text and the next when many are sent: a carrier takes about one a second
  textGapMs: /^\d+$/.test(process.env.TEXT_GAP_MS || "") ? Number(process.env.TEXT_GAP_MS) : 1100,
  // how long an account that was made for someone waits for them to take it up
  inviteDays: 90,
  // and how many times, at most, someone who has not taken theirs up is written to about it
  mostTellings: 2,
  // The group chats elsewhere that the main admin sends to from here. signal-cli is the program that
  // speaks to Signal; the WhatsApp client is a package, named here so that a test can put its own in its place.
  signalCli: process.env.SIGNAL_CLI || "signal-cli",
  whatsappClient: process.env.WHATSAPP_CLIENT || "baileys",
  // how large a file sent to those chats can be
  maxSendBytes: 50 * 1024 * 1024,
  // how many files go with one thing sent, and how many things sent are remembered
  maxSendFiles: 10,
  sendsKept: 50,
  maxSendLength: 4000,
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
