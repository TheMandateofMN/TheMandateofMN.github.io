/*
 * Projects, their pages and suggestions: who may do what, and what happens
 * when they do. The joining of changes is in projects.mjs and merge.mjs.
 */

import { rooms } from "./chat.mjs";
import { users } from "./db.mjs";
import { changes } from "./diff.mjs";
import { field, form, may, member, NOT_FOUND, numericId, text } from "./gate.mjs";
import { HttpError, redirect, send } from "./http.mjs";
import { land, mayEdit, mayManage, pages, pageVersions, projects, proposals, roleIn } from "./projects.mjs";
import { say } from "./routes-chat.mjs";
import {
  clashPage,
  pageChangesPage,
  pageHistoryPage,
  pagePage,
  pageVersionPage,
  pageWritePage,
  projectLogPage,
  projectNewPage,
  projectPage,
  projectSettingsPage,
  projectsPage,
  proposalPage,
} from "./views-projects.mjs";
import { prepare } from "./weave.mjs";

/* how many of the latest savings a project's own page lists */
const LATELY = 8;

/** the project in the address, and what the member is to it; not there at all for those who may not see it */
function projectFor(ctx, id = numericId(ctx.params.id)) {
  const project = projects.byId(id);
  const role = project && roleIn(project, ctx.session.user);
  if (!role) throw new HttpError(404, NOT_FOUND);
  return { project, role };
}

/** the page in the address, with its project; one taken out of its project is not there */
function pageFor(ctx, { removed = false } = {}) {
  const current = pages.byId(numericId(ctx.params.id));
  if (!current || Boolean(current.removed_at) !== removed) throw new HttpError(404, NOT_FOUND);
  return { ...projectFor(ctx, current.project_id), current };
}

function working(role) {
  if (!mayEdit(role)) throw new HttpError(403, "Only those working on this project can do that.");
}

function managing(role) {
  if (!mayManage(role)) throw new HttpError(403, "Only the project’s owner or an admin can do that.");
}

/** the forum's own word, in the project's conversation, of something a member did to it */
const tell = (ctx, project, body, link = `/projects/${project.id}`) =>
  say(rooms.forProject(project.id).id, ctx.session.user.id, { kind: "event", body, link });

/**
 * Puts a member to work on a project. What was said in its conversation
 * before they came is theirs to read but is not counted as unread; the word
 * that they were added is.
 */
function join(ctx, project, user) {
  projects.add(project.id, user.id, ctx.session.user.id);
  rooms.markRead(rooms.forProject(project.id).id, user.id);
  tell(ctx, project, `added ${user.name} to the project`);
}

/** the members named by the boxes ticked in a form: those who can sign in, and not the one asking */
function chosen(ctx, except = []) {
  const wanted = new Set(ctx.form.getAll("who").map(Number));
  return users.active().filter((user) => wanted.has(user.id) && user.id !== ctx.session.user.id && !except.includes(user.id));
}

/* ----------------------------------------------------- projects themselves */

function describing(ctx) {
  const values = {
    title: field(ctx, "title").replace(/\s+/g, " "),
    about: text(ctx, "about").trim(),
    open: field(ctx, "open") === "1",
  };
  const error = !values.title
    ? "A project needs a name."
    : values.title.length > 120
      ? "Keep the name under 120 characters."
      : values.about.length > 1000
        ? "Keep the description under 1000 characters."
        : null;
  return { values, error };
}

const otherMembers = (ctx, except = []) =>
  users.active().filter((user) => user.id !== ctx.session.user.id && !except.includes(user.id));

export function projectRoutes(router) {
  router.get("/projects", member, (ctx) => {
    const { user } = ctx.session;
    send(
      ctx.res,
      200,
      projectsPage({
        session: ctx.session,
        mine: projects.of(user.id),
        open: projects.openTo(user.id),
        closed: may(ctx, "projects") ? projects.closedTo(user.id) : [],
      })
    );
  });

  router.get("/projects/new", member, (ctx) =>
    send(ctx.res, 200, projectNewPage({ session: ctx.session, members: otherMembers(ctx) }))
  );

  router.post("/projects", member, form, (ctx) => {
    const { values, error } = describing(ctx);
    const who = chosen(ctx);
    if (error)
      return send(
        ctx.res,
        422,
        projectNewPage({ session: ctx.session, members: otherMembers(ctx), values: { ...values, who: who.map((user) => user.id) }, error })
      );
    const id = projects.create({ ownerId: ctx.session.user.id, ...values, about: values.about || null });
    const project = projects.byId(id);
    tell(ctx, project, "started the project");
    for (const user of who) join(ctx, project, user);
    redirect(ctx.res, `/projects/${id}`);
  });

  router.get("/projects/:id", member, (ctx) => {
    const { project, role } = projectFor(ctx);
    const query = ctx.url.searchParams;
    const flash = query.has("out")
      ? "The page was taken out of the project. It is kept, and can be put back from the foot of this page."
      : query.has("back")
        ? "The page is back in the project."
        : null;
    send(
      ctx.res,
      200,
      projectPage({
        session: ctx.session,
        project,
        role,
        pages: pages.inProject(project.id),
        removed: mayEdit(role) ? pages.removedFrom(project.id) : [],
        people: projects.people(project.id),
        proposals: proposals.open(project.id),
        log: pageVersions.log(project.id, LATELY),
        flash,
      })
    );
  });

  router.get("/projects/:id/log", member, (ctx) => {
    const { project } = projectFor(ctx);
    send(ctx.res, 200, projectLogPage({ session: ctx.session, project, log: pageVersions.log(project.id) }));
  });

  /** the project's conversation, for those working on it */
  router.get("/projects/:id/talk", member, (ctx) => {
    const { project, role } = projectFor(ctx);
    working(role);
    redirect(ctx.res, `/chat/${rooms.forProject(project.id).id}`);
  });

  const settings = (ctx, project, extra = {}, status = 200) => {
    const people = projects.people(project.id);
    const taken = [project.owner_id, ...people.map((user) => user.id)];
    send(
      ctx.res,
      status,
      projectSettingsPage({
        session: ctx.session,
        project,
        people,
        others: users.active().filter((user) => !taken.includes(user.id)),
        ...extra,
      })
    );
  };

  router.get("/projects/:id/settings", member, (ctx) => {
    const { project, role } = projectFor(ctx);
    managing(role);
    settings(ctx, project);
  });

  router.post("/projects/:id/settings", member, form, (ctx) => {
    const { project, role } = projectFor(ctx);
    managing(role);
    const { values, error } = describing(ctx);
    if (error) return settings(ctx, project, { values, error }, 422);
    projects.update(project.id, { ...values, about: values.about || null });
    if (values.open !== Boolean(project.open))
      tell(ctx, project, values.open ? "opened the project for every member to read" : "made the project private to those working on it");
    redirect(ctx.res, `/projects/${project.id}`);
  });

  router.post("/projects/:id/people", member, form, (ctx) => {
    const { project, role } = projectFor(ctx);
    managing(role);
    const taken = [project.owner_id, ...projects.people(project.id).map((user) => user.id)];
    const wanted = new Set(ctx.form.getAll("who").map(Number));
    for (const user of users.active().filter((each) => wanted.has(each.id) && !taken.includes(each.id))) join(ctx, project, user);
    redirect(ctx.res, `/projects/${project.id}/settings#people`);
  });

  /** the owner or an admin takes someone off a project; anyone working on it can take themselves off */
  router.post("/projects/:id/people/:user/remove", member, form, (ctx) => {
    const { project, role } = projectFor(ctx);
    const userId = numericId(ctx.params.user);
    const self = userId === ctx.session.user.id;
    if (!self) managing(role);
    if (!projects.has(project.id, userId)) throw new HttpError(404, "They are not working on this project.");
    // said before they go, so that someone leaving is still there to say it
    tell(ctx, project, self ? "left the project" : `took ${users.byId(userId).name} off the project`);
    projects.drop(project.id, userId);
    redirect(ctx.res, self ? "/projects" : `/projects/${project.id}/settings#people`);
  });

  router.post("/projects/:id/delete", member, form, (ctx) => {
    const { project, role } = projectFor(ctx);
    managing(role);
    projects.remove(project.id);
    redirect(ctx.res, "/projects");
  });

  /* ---------------------------------------------------------------- pages */

  /** what the form for a page holds, and what is the matter with it, if anything */
  function written(ctx) {
    const values = {
      title: field(ctx, "title").replace(/\s+/g, " "),
      body: text(ctx, "body"),
      summary: field(ctx, "summary").replace(/\s+/g, " ").slice(0, 200),
    };
    const error = !values.title
      ? "A page needs a title."
      : values.title.length > 200
        ? "Keep the title under 200 characters."
        : !values.body.trim()
          ? "There is nothing to save yet."
          : null;
    return { values, error };
  }

  router.get("/projects/:id/new", member, (ctx) => {
    const { project, role } = projectFor(ctx);
    working(role);
    send(ctx.res, 200, pageWritePage({ session: ctx.session, project, role }));
  });

  router.post("/projects/:id/pages", member, form, (ctx) => {
    const { project, role } = projectFor(ctx);
    working(role);
    const { values, error } = written(ctx);
    if (error) return send(ctx.res, 422, pageWritePage({ session: ctx.session, project, role, values, error }));
    const id = pages.create({ projectId: project.id, title: values.title, body: values.body, userId: ctx.session.user.id });
    tell(ctx, project, `began the page “${values.title}”`, `/pages/${id}`);
    redirect(ctx.res, `/pages/${id}`);
  });

  router.get("/pages/:id", member, async (ctx) => {
    const { project, role, current } = pageFor(ctx);
    const query = ctx.url.searchParams;
    const flash = query.has("merged")
      ? `Saved as version ${current.version}. Someone else had saved while you were writing; what they changed and what you changed are both here. Read it through.`
      : query.has("same")
        ? "The page already said that, so nothing new was saved."
        : null;
    await prepare(current.body);
    send(
      ctx.res,
      200,
      pagePage({
        session: ctx.session,
        project,
        role,
        current,
        pages: pages.inProject(project.id),
        proposals: proposals.forPage(current.id).filter((each) => each.status === "open"),
        flash,
      })
    );
  });

  router.get("/pages/:id/edit", member, (ctx) => {
    const { project, role, current } = pageFor(ctx);
    send(ctx.res, 200, pageWritePage({ session: ctx.session, project, role, current }));
  });

  /** who has saved a page since one of its versions, by name */
  const sinceThen = (current, base) =>
    [...new Set(pageVersions.list(current.id).filter((version) => version.n > base).map((version) => version.editor_name))];

  const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]);

  /** the choices a clash page sent back, if they were made against the page as it still stands */
  const picked = (ctx, current) =>
    Number(field(ctx, "against")) === current.version
      ? [...ctx.form.keys()].filter((name) => /^pick-\d+$/.test(name)).sort((a, b) => a.slice(5) - b.slice(5)).map((name) => field(ctx, name))
      : null;

  /**
   * Saves a page, or offers what was written as a suggestion. A save made
   * from a version the page has moved on from is joined with what was saved
   * since; where that cannot be done without choosing, the choice is asked for.
   */
  router.post("/pages/:id/edit", member, form, (ctx) => {
    const { project, role, current } = pageFor(ctx);
    const { values, error } = written(ctx);
    const base = Number(field(ctx, "base"));
    const from = Number.isInteger(base) && pageVersions.get(current.id, base);
    if (!from) throw new HttpError(400, "That page has been reloaded since. Open it again and try once more.");
    const again = (message, status = 422) =>
      send(ctx.res, status, pageWritePage({ session: ctx.session, project, role, current, values: { ...values, base }, error: message }));
    if (error) return again(error);
    // from the choosing between two wordings, back to the writing with nothing saved
    if (field(ctx, "do") === "back") return again(null, 200);
    const { user } = ctx.session;

    if (field(ctx, "do") === "suggest" || !mayEdit(role)) {
      if (values.title === from.title && values.body === from.body) return again("That changes nothing yet.");
      const id = proposals.create({ pageId: current.id, userId: user.id, base, ...values });
      tell(ctx, project, `suggested a change to “${current.title}”`, `/suggestions/${id}`);
      return redirect(ctx.res, `/suggestions/${id}?sent`);
    }

    const result = land(current.id, { base, ...values, picks: picked(ctx, current), userId: user.id });
    if (result.clash) {
      const names = sinceThen(current, base).filter((name) => name !== user.name);
      return send(
        ctx.res,
        409,
        clashPage({
          session: ctx.session,
          project,
          current,
          merge: result.clash,
          action: `/pages/${current.id}/edit`,
          fields: { do: "save", base, against: result.against, title: values.title, summary: values.summary, body: values.body },
          ours: "What you wrote",
          theirs: "What the page now says",
          leave: { href: `/pages/${current.id}`, label: "Give up what you wrote" },
          lead: `While you were writing, ${listed(names) || "someone"} saved this page, which is now at version ${result.against}. Everything else that you both changed has been joined. In ${result.clash.clashes === 1 ? "the passage" : "each of the passages"} below you changed the same words, so say which wording should stand.`,
        })
      );
    }
    redirect(ctx.res, `/pages/${current.id}${result.version === null ? "?same" : result.merged ? "?merged" : ""}`);
  });

  router.post("/pages/:id/restore", member, form, (ctx) => {
    const { role, current } = pageFor(ctx);
    working(role);
    const version = /^[1-9]\d{0,8}$/.test(field(ctx, "n")) ? pageVersions.get(current.id, Number(field(ctx, "n"))) : null;
    if (!version) throw new HttpError(404, "This has no such version.");
    land(current.id, {
      base: current.version,
      title: version.title,
      body: version.body,
      summary: `Restored version ${version.n}`,
      userId: ctx.session.user.id,
    });
    redirect(ctx.res, `/pages/${current.id}`);
  });

  router.post("/pages/:id/remove", member, form, (ctx) => {
    const { project, role, current } = pageFor(ctx);
    working(role);
    pages.remove(current.id, ctx.session.user.id);
    tell(ctx, project, `took the page “${current.title}” out of the project`);
    redirect(ctx.res, `/projects/${project.id}?out`);
  });

  router.post("/pages/:id/putback", member, form, (ctx) => {
    const { project, role, current } = pageFor(ctx, { removed: true });
    working(role);
    pages.putBack(current.id);
    tell(ctx, project, `put the page “${current.title}” back`, `/pages/${current.id}`);
    redirect(ctx.res, `/projects/${project.id}?back`);
  });

  router.get("/pages/:id/history", member, (ctx) => {
    const { project, role, current } = pageFor(ctx);
    send(ctx.res, 200, pageHistoryPage({ session: ctx.session, project, role, current, versions: pageVersions.list(current.id) }));
  });

  router.get("/pages/:id/v/:n", member, async (ctx) => {
    const { project, current } = pageFor(ctx);
    const version = pageVersions.get(current.id, numericId(ctx.params.n));
    if (!version) throw new HttpError(404, "This has no such version.");
    await prepare(version.body);
    send(ctx.res, 200, pageVersionPage({ session: ctx.session, project, current, version }));
  });

  router.get("/pages/:id/changes", member, (ctx) => {
    const { project, current } = pageFor(ctx);
    const asked = (name) => Number.parseInt(ctx.url.searchParams.get(name), 10);
    const to = asked("to") || current.version;
    const from = asked("from") || to - 1;
    const [before, after] = [pageVersions.get(current.id, from), pageVersions.get(current.id, to)];
    if (!before || !after) throw new HttpError(404, "There are no two such versions to compare.");
    send(
      ctx.res,
      200,
      pageChangesPage({
        session: ctx.session,
        project,
        current,
        before,
        after,
        versions: pageVersions.list(current.id),
        diff: changes(before.body, after.body),
      })
    );
  });

  /* ----------------------------------------------------------- suggestions */

  /** the suggestion in the address, with the page it is for and that page's project */
  function proposalFor(ctx) {
    const proposal = proposals.byId(numericId(ctx.params.id));
    if (!proposal || proposal.page_removed_at) throw new HttpError(404, NOT_FOUND);
    return { ...projectFor(ctx, proposal.project_id), proposal, current: pages.byId(proposal.page_id) };
  }

  const shown = (ctx, { project, role, current, proposal }, extra = {}, status = 200) => {
    const base = pageVersions.get(current.id, proposal.base);
    send(
      ctx.res,
      status,
      proposalPage({
        session: ctx.session,
        project,
        role,
        current,
        proposal,
        base,
        diff: changes(base.body, proposal.body),
        ...extra,
      })
    );
  };

  router.get("/suggestions/:id", member, (ctx) => {
    const found = proposalFor(ctx);
    const flash = ctx.url.searchParams.has("sent")
      ? "Your suggestion has been sent. Those working on the project are told in its conversation."
      : null;
    shown(ctx, found, { flash });
  });

  function stillOpen(proposal) {
    if (proposal.status !== "open") throw new HttpError(409, "That suggestion has already been answered.");
  }

  /** takes a suggestion into its page: joined with whatever the page has become since it was written */
  router.post("/suggestions/:id/accept", member, form, (ctx) => {
    const found = proposalFor(ctx);
    const { project, role, current, proposal } = found;
    working(role);
    stillOpen(proposal);
    const { user } = ctx.session;
    const result = land(current.id, {
      base: proposal.base,
      title: proposal.title,
      body: proposal.body,
      picks: picked(ctx, current),
      summary: proposal.summary || "",
      userId: proposal.user_id,
      via: proposal.user_id === user.id ? null : user.id,
      proposalId: proposal.id,
    });
    if (result.clash)
      return send(
        ctx.res,
        409,
        clashPage({
          session: ctx.session,
          project,
          current,
          merge: result.clash,
          action: `/suggestions/${proposal.id}/accept`,
          fields: { against: result.against },
          ours: "The suggestion",
          theirs: "What the page now says",
          leave: { href: `/suggestions/${proposal.id}`, label: "Back to the suggestion" },
          lead: `The page has changed since ${proposal.author_name} wrote this suggestion. Everything else has been joined. In ${result.clash.clashes === 1 ? "the passage" : "each of the passages"} below the suggestion and the page have changed the same words, so say which wording should stand.`,
        })
      );
    proposals.decide(proposal.id, "accepted", user.id);
    if (proposal.user_id !== user.id)
      tell(ctx, project, `took in ${proposal.author_name}’s suggestion for “${current.title}”`, `/pages/${current.id}`);
    redirect(ctx.res, `/pages/${current.id}${result.version === null ? "?same" : ""}`);
  });

  router.post("/suggestions/:id/decline", member, form, (ctx) => {
    const { project, role, current, proposal } = proposalFor(ctx);
    working(role);
    stillOpen(proposal);
    proposals.decide(proposal.id, "declined", ctx.session.user.id);
    tell(ctx, project, `declined ${proposal.author_name}’s suggestion for “${current.title}”`, `/suggestions/${proposal.id}`);
    redirect(ctx.res, `/suggestions/${proposal.id}`);
  });

  router.post("/suggestions/:id/withdraw", member, form, (ctx) => {
    const { proposal } = proposalFor(ctx);
    if (proposal.user_id !== ctx.session.user.id) throw new HttpError(403, "Only whoever made a suggestion can withdraw it.");
    stillOpen(proposal);
    proposals.decide(proposal.id, "withdrawn", ctx.session.user.id);
    redirect(ctx.res, `/suggestions/${proposal.id}`);
  });
}
