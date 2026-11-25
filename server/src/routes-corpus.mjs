/*
 * The corpus and what it is made of besides the writing: the drawing of it
 * all, where each title stands on it, the antecedents, and the essay it is
 * drawn around.
 */

import { posts } from "./db.mjs";
import { allowed, field, form, may, member, numericId, publisher } from "./gate.mjs";
import { FURTHEST, layout, scatter } from "./graph.mjs";
import { HttpError, redirect, send } from "./http.mjs";
import { corpusPage, workPage } from "./views-corpus.mjs";
import { graphData, neighbourhood, postSaved } from "./weave.mjs";
import { readCuration, readWork } from "./works.mjs";

// setting the corpus out takes a moment, so the latest drawings are kept while nothing has changed
const MOST_DRAWN = 24;
const drawn = new Map();

function setOut({ nodes, edges }, how) {
  const key = JSON.stringify([
    how.name,
    // whatever a node's place or the room it takes is worked out from
    nodes.map((node) => [node.id, node.kind, node.label, node.weight, node.main, node.hand, node.extent, node.showTell, Boolean(node.annotation), node.order, node.place]),
    edges,
  ]);
  let sheet = drawn.get(key);
  drawn.delete(key);
  sheet ||= how(nodes, edges);
  drawn.set(key, sheet);
  if (drawn.size > MOST_DRAWN) drawn.delete(drawn.keys().next().value);
  // the places are kept; what is said of each piece is as it now stands
  const now = new Map(nodes.map((node) => [node.id, node]));
  return { ...sheet, nodes: sheet.nodes.map((node) => ({ ...node, ...now.get(node.id) })) };
}

const REACHES = { 1: 1, 2: 2, 3: 3, all: Infinity };
/* the layers by the names they have now, and by those they were once asked for with */
const LAYERS = { all: "all", antecedents: "antecedents", succession: "succession", lineages: "antecedents", written: "succession" };

/**
 * What a form says of a work, with what those who edit say of it besides. A
 * work is published as it is added: there is no one to look it over.
 */
function readSubmission(ctx) {
  const get = (name) => ctx.form.get(name);
  const work = readWork(get);
  const curation = may(ctx, "edit") ? readCuration(get, { work: true }) : null;
  return {
    values: { ...work.values, ...curation?.values },
    work: work.values,
    curation: curation?.values,
    error: work.error || curation?.error || null,
  };
}

/** the form a work is added or changed with */
const workView = (ctx, extra = {}) => workPage({ session: ctx.session, creators: posts.creators(), ...extra });

/** saves what a form says of a work that is already there, and publishes it if it was not */
export function saveWork(ctx, post) {
  const { values, work, curation, error } = readSubmission(ctx);
  const again = (code, message) => send(ctx.res, code, workView(ctx, { post, values, error: message }));
  if (error) return again(422, error);
  // as with any post: if someone has saved since this form was opened, say so rather than write over it
  const base = field(ctx, "base");
  if (base && base !== post.updated_at)
    return again(409, "This was changed while you were writing. What you wrote is still below; look at it as it now stands in another tab, then save again to put yours in its place.");
  posts.update(post.id, { title: work.title, body: work.body, status: "published" });
  posts.describe(post.id, work);
  if (curation) posts.curate(post.id, curation);
  postSaved(post.id, { by: ctx.session.user.id });
  redirect(ctx.res, `/p/${post.id}`);
}

/** the form a work is changed with */
export const editWork = (ctx, post) => send(ctx.res, 200, workView(ctx, { post }));

/**
 * Where the titles were dragged to, as a form sends them: "p12:-340.5,88 p7:210,-40", each
 * measured from the essay in the middle. Only pieces that are published have a place, and one
 * dragged out of all reason is brought back within reach.
 */
function readPlaces(value) {
  const places = [];
  for (const word of String(value).split(/\s+/).filter(Boolean).slice(0, 5000)) {
    const found = /^p([1-9]\d{0,14}):(-?\d{1,5}(?:\.\d{1,2})?),(-?\d{1,5}(?:\.\d{1,2})?)$/.exec(word);
    if (!found) throw new HttpError(400, "Those places could not be read.");
    const post = posts.byId(Number(found[1]));
    if (!post || post.status !== "published") continue;
    const within = (n) => Math.min(FURTHEST, Math.max(-FURTHEST, Number(n)));
    places.push({ id: post.id, x: within(found[2]), y: within(found[3]) });
  }
  return places;
}

export function corpusRoutes(router) {
  /**
   * The whole corpus, of which ?layer=antecedents or ?layer=succession draws
   * one layer; or with ?around=p12 (a post or a work) or ?around=u3 (a
   * member) the part of it within ?reach= steps of that node, of which
   * ?show=people draws the members in. ?mark=show-tell marks the pieces that
   * both show and tell, and lets the rest fall back. With ?arrange=1, for
   * those who edit, the titles of the whole can be dragged to where they belong.
   */
  router.get("/corpus", member, (ctx) => {
    const query = ctx.url.searchParams;
    const around = /^[pu][1-9]\d{0,14}$/.test(query.get("around") || "") ? query.get("around") : null;
    const reach = Object.hasOwn(REACHES, query.get("reach")) ? query.get("reach") : "1";
    // the members are drawn about a piece or about one of themselves, never in the whole; and a member
    // can only be looked around with the members showing
    const people = Boolean(around) && (query.get("show") === "people" || around[0] === "u");
    const arranging = !around && query.get("arrange") === "1" && may(ctx, "edit");
    // every title is there to be dragged, whichever layer was being looked at
    const layer = (!around && !arranging && Object.hasOwn(LAYERS, query.get("layer")) && LAYERS[query.get("layer")]) || "all";
    const whole = graphData({ people, written: layer !== "antecedents", antecedents: layer !== "succession" });
    const part = around ? neighbourhood(whole, around, REACHES[reach]) : null;
    send(
      ctx.res,
      200,
      corpusPage({
        session: ctx.session,
        // a part of it is set out freely; the whole of it about its centre, each title where it was put
        graph: part ? setOut(part, layout) : setOut(whole, scatter),
        counts: whole.counts,
        people,
        layer,
        marked: !arranging && query.get("mark") === "show-tell" && whole.counts.showTell > 0,
        focus: part ? { id: around, reach, of: whole.nodes.length } : null,
        missing: Boolean(around && !part),
        arranging,
      })
    );
  });

  /** keeps where the titles of the corpus were dragged to; or with `reset`, lets them all go back to where they would stand by themselves */
  router.post("/corpus/arrange", allowed("edit"), form, (ctx) => {
    if (field(ctx, "reset")) posts.unplace();
    else posts.place(readPlaces(field(ctx, "places")));
    redirect(ctx.res, "/corpus");
  });

  // the corpus was the graph, and is still looked for there
  router.get("/graph", member, (ctx) => {
    const query = new URLSearchParams(ctx.url.searchParams);
    if (query.get("show") === "articles") query.delete("show");
    const asked = query.toString();
    redirect(ctx.res, asked ? `/corpus?${asked}` : "/corpus");
  });

  /**
   * Adding an antecedent: a work made elsewhere, which is published as it is
   * added. It is for those who publish here, as writing a new piece is.
   */
  router.get("/submit", publisher, (ctx) => send(ctx.res, 200, workView(ctx)));

  router.post("/submit", publisher, form, (ctx) => {
    const { values, work, curation, error } = readSubmission(ctx);
    if (error) return send(ctx.res, 422, workView(ctx, { values, error }));
    const id = posts.create({ authorId: ctx.session.user.id, title: work.title, body: work.body, status: "published", stage: "finished", work });
    if (curation) posts.curate(id, curation);
    postSaved(id, { by: ctx.session.user.id });
    redirect(ctx.res, `/p/${id}`);
  });

  // a work was added from here, and the way may still be remembered
  router.get("/works/new", member, (ctx) => redirect(ctx.res, "/submit"));

  /** sets an article at the centre of the corpus, which is then drawn around it */
  router.post("/p/:id/centre", allowed("edit"), form, (ctx) => {
    const post = posts.byId(numericId(ctx.params.id));
    if (!post || post.status !== "published" || post.kind !== "writing" || !post.title || post.parent_id)
      throw new HttpError(422, "Only a published article can stand at the centre of the corpus.");
    posts.setCentre(post.id);
    redirect(ctx.res, `/p/${post.id}`);
  });
}
