/*
 * The pages of projects: the list of them, a project and its settings, a
 * page of one with its editor, its history and what changed, the choosing
 * between two wordings that clash, and suggestions.
 */

import { changes, wordCount } from "./diff.mjs";
import { mayEdit, mayManage } from "./projects.mjs";
import { clip, renderNote, renderPost, timeTag } from "./render.mjs";
import {
  changesShown,
  compareForm,
  csrfField,
  editorField,
  html,
  isAdmin,
  memberHref,
  notice,
  number,
  page,
  plural,
  raw,
  wordsChanged,
} from "./views.mjs";

const person = (username, name) => html`<a href="${memberHref(username)}">${name}</a>`;
const stamp = (at) => raw(timeTag(at, "stamp"));

/** who can see a project, in a word or two */
const openness = (project) => (project.open ? "Open to every member" : "Private to those working on it");

/** the way back to the project a page belongs to */
const within = (project, extra = "") =>
  html`<p class="answers answers--lead">in <a href="/projects/${project.id}">${project.title}</a>${extra}</p>`;

/* ------------------------------------------------------------ the list */

function projectItem(project) {
  const facts = [
    plural(project.page_count, "page"),
    project.member_count > 0 ? `${project.owner_name} and ${plural(project.member_count, "other")}` : project.owner_name,
    project.proposal_count > 0 && plural(project.proposal_count, "suggestion"),
  ].filter(Boolean);
  return html`<li class="project">
    <h3 class="project__title">
      <a href="/projects/${project.id}">${project.title}</a>
      ${project.open ? html`<span class="tag">Open</span>` : html`<span class="tag tag--quiet">Private</span>`}
    </h3>
    ${project.about && html`<p class="project__about">${clip(project.about, 200)}</p>`}
    <p class="project__facts">${facts.join(" · ")} · changed ${stamp(project.updated_at)}</p>
  </li>`;
}

export function projectsPage({ session, mine, open, closed = [] }) {
  const list = (projects) => html`<ul class="projects">${projects.map(projectItem)}</ul>`;
  return page({
    title: "Projects",
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">Projects</h1>
      <p class="lede">
        A project is a set of pages written together. Whoever starts one chooses who works on it; everyone
        working on it can change any page, every saving is kept, and changes made at the same time are joined
        rather than lost. <a href="/guide#projects">How projects work</a>
      </p>
      <p class="actions"><a class="button" href="/projects/new">Start a project</a></p>

      <h2 class="section-title">Yours</h2>
      ${mine.length > 0
        ? list(mine)
        : html`<p class="empty empty--notes">You are not working on any project yet. Start one, or ask to be added to one.</p>`}

      ${open.length > 0 &&
      html`<h2 class="section-title">Open to everyone</h2>
        <p class="hint">Projects of other members that anyone may read and suggest changes to.</p>
        ${list(open)}`}
      ${closed.length > 0 &&
      html`<h2 class="section-title">Private projects of others</h2>
        <p class="hint">
          Shown to you as ${isAdmin(session) ? "an admin" : "a sub-admin who oversees the projects"}. The
          members working on them do not expect other readers.
        </p>
        ${list(closed)}`}
    `,
  });
}

/* ----------------------------------------------- starting, and settings */

/** the members who can be chosen, as boxes to tick */
const choices = (members, chosen = []) =>
  html`<ul class="choices">
    ${members.map(
      (each) => html`<li>
        <label
          ><input type="checkbox" name="who" value="${each.id}" ${chosen.includes(each.id) && raw("checked")} />
          ${each.name} <span class="choices__name">@${each.username}</span></label
        >
      </li>`
    )}
  </ul>`;

const describing = (v) => html`
  <label for="title">Name</label>
  <input id="title" name="title" value="${v.title}" maxlength="120" autocomplete="off" required />

  <label for="about">What it is for</label>
  <p class="hint">Optional: a few lines for those who come to it.</p>
  <textarea id="about" name="about" rows="3" maxlength="1000">${v.about}</textarea>

  <fieldset class="options">
    <legend>Who can read it</legend>
    <label
      ><input type="radio" name="open" value="0" ${!v.open && raw("checked")} /> Only those working on it</label
    >
    <label
      ><input type="radio" name="open" value="1" ${v.open && raw("checked")} /> Every member, who can also
      suggest changes</label
    >
  </fieldset>
`;

export function projectNewPage({ session, members, values = {}, error }) {
  const v = { title: "", about: "", open: false, who: [], ...values };
  return page({
    title: "Start a project",
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">Start a project</h1>
      <form class="form" method="post" action="/projects">
        ${csrfField(session)} ${notice(error)} ${describing(v)}
        <fieldset class="options">
          <legend>Who works on it with you</legend>
          <p class="hint">They can change every page. You can add and remove people later.</p>
          ${members.length > 0 ? choices(members, v.who) : html`<p class="hint">There are no other members yet.</p>`}
        </fieldset>
        <div class="compose__actions">
          <button class="button" type="submit">Start the project</button>
          <a class="compose__cancel" href="/projects">Cancel</a>
        </div>
      </form>
    `,
  });
}

export function projectSettingsPage({ session, project, people, others, values, error }) {
  const v = { title: project.title, about: project.about || "", open: Boolean(project.open), ...values };
  return page({
    title: `Settings · ${project.title}`,
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">Settings</h1>
      ${within(project)}
      <form class="form" method="post" action="/projects/${project.id}/settings">
        ${csrfField(session)} ${notice(error)} ${describing(v)}
        <div class="compose__actions">
          <button class="button" type="submit">Save</button>
          <a class="compose__cancel" href="/projects/${project.id}">Back to the project</a>
        </div>
      </form>

      <h2 class="section-title" id="people">Who works on it</h2>
      <ul class="people">
        <li>${person(project.owner_username, project.owner_name)} <span class="tag">Owner</span></li>
        ${people.map(
          (each) => html`<li>
            ${person(each.username, each.name)}
            ${!each.active && html`<span class="tag tag--quiet">No longer a member</span>`}
            <form method="post" action="/projects/${project.id}/people/${each.id}/remove">
              ${csrfField(session)}
              <button
                class="link link--quiet"
                type="submit"
                data-confirm="Take ${each.name} off this project? What they wrote stays."
              >
                Remove
              </button>
            </form>
          </li>`
        )}
      </ul>
      ${others.length > 0 &&
      html`<form class="form" method="post" action="/projects/${project.id}/people">
        ${csrfField(session)}
        <fieldset class="options">
          <legend>Add</legend>
          ${choices(others)}
        </fieldset>
        <button class="button button--quiet" type="submit">Add to the project</button>
      </form>`}

      <form class="compose__delete" method="post" action="/projects/${project.id}/delete">
        ${csrfField(session)}
        <button
          class="link link--danger"
          type="submit"
          data-confirm="Delete “${project.title}” for good, with all its pages, every version of them, its suggestions and its conversation?"
        >
          Delete this project
        </button>
      </form>
    `,
  });
}

/* ------------------------------------------------------------ a project */

/** one saving, as a line of the record of what has been done */
function logItem(entry) {
  const who = person(entry.editor_username, entry.editor_name);
  const pageLink = entry.page_removed_at
    ? entry.title
    : html`<a href="/pages/${entry.page_id}/v/${entry.n}">${entry.title}</a>`;
  const did =
    entry.n === 1
      ? html`${who} began ${pageLink}`
      : entry.via
        ? html`${entry.via_name} took in ${who}’s suggestion for ${pageLink}`
        : html`${who} saved ${pageLink}`;
  const facts = [
    entry.n > 1 && `version ${entry.n}`,
    entry.n === 1 ? `${number(wordCount(entry.body))} words` : wordsChanged(entry),
    entry.merged ? "joined with what others had changed" : false,
  ].filter(Boolean);
  return html`<li class="log__item">
    <p class="log__what">${did}${entry.summary && html`: <em>${entry.summary}</em>`}</p>
    <p class="log__facts">
      ${stamp(entry.created_at)} · ${facts.join(" · ")}
      ${entry.n > 1 &&
      !entry.page_removed_at &&
      html` · <a href="/pages/${entry.page_id}/changes?from=${entry.n - 1}&amp;to=${entry.n}">What changed</a>`}
    </p>
  </li>`;
}

const proposalItem = (proposal) => html`<li>
  <a href="/suggestions/${proposal.id}">${proposal.summary || `A change to ${proposal.page_title}`}</a>
  <span class="related__by"
    >${proposal.summary && html`on ${proposal.page_title}, `}by ${proposal.author_name}, ${stamp(proposal.created_at)}</span
  >
</li>`;

export function projectPage({ session, project, role, pages, removed, people, proposals, log, flash }) {
  const edits = mayEdit(role);
  return page({
    title: project.title,
    session,
    current: "projects",
    main: html`
      ${notice(flash, "ok")}
      <header class="post__head">
        <p class="rubric">Project · ${openness(project)}</p>
        <h1 class="post__title">${project.title}</h1>
        <p class="project__people">
          ${person(project.owner_username, project.owner_name)}${people.map(
            (each) => html`, ${person(each.username, each.name)}`
          )}
        </p>
        ${project.about && html`<div class="project__about note__body">${raw(renderNote(project.about))}</div>`}
        <p class="post__meta">
          ${edits && html`<a href="/projects/${project.id}/new">New page</a>`}
          ${edits && html`<a href="/projects/${project.id}/talk">Conversation</a>`}
          <a href="/projects/${project.id}/log">Everything that has been done</a>
          ${mayManage(role) && html`<a href="/projects/${project.id}/settings">Settings</a>`}
        </p>
      </header>
      ${role === "reader" &&
      html`<p class="hint">
        You are reading this as a member. You can suggest a change to any page; those working on the project
        decide whether to take it.
      </p>`}
      ${role === "admin" &&
      html`<p class="hint">
        ${isAdmin(session)
          ? "You are not working on this project, but as an admin you can do what its owner can."
          : "You are not working on this project, but as a sub-admin who oversees the projects you can do what its owner can."}
      </p>`}

      <h2 class="section-title">Pages</h2>
      ${pages.length > 0
        ? html`<ol class="pages">
            ${pages.map(
              (each) => html`<li>
                <a class="pages__title" href="/pages/${each.id}">${each.title}</a>
                <span class="pages__facts"
                  >version ${each.version} · ${each.editor_name}, ${stamp(each.updated_at)}${each.proposal_count > 0 &&
                  html` · ${plural(each.proposal_count, "suggestion")}`}</span
                >
              </li>`
            )}
          </ol>`
        : html`<p class="empty empty--notes">
            There are no pages yet.${edits && html` <a href="/projects/${project.id}/new">Begin the first</a>.`}
          </p>`}

      ${proposals.length > 0 &&
      html`<h2 class="section-title" id="suggestions">Suggestions awaiting an answer</h2>
        <ul class="related">
          ${proposals.map(proposalItem)}
        </ul>`}

      ${log.length > 0 &&
      html`<h2 class="section-title">Lately</h2>
        <ol class="log">
          ${log.map(logItem)}
        </ol>`}

      ${edits &&
      removed.length > 0 &&
      html`<details class="fold removed">
        <summary>${plural(removed.length, "page")} taken out</summary>
        <ul class="people">
          ${removed.map(
            (each) => html`<li>
              ${each.title} <span class="pages__facts">taken out ${stamp(each.removed_at)}</span>
              <form method="post" action="/pages/${each.id}/putback">
                ${csrfField(session)}
                <button class="link" type="submit">Put back</button>
              </form>
            </li>`
          )}
        </ul>
      </details>`}

      ${role === "member" &&
      html`<form class="compose__delete" method="post" action="/projects/${project.id}/people/${session.user.id}/remove">
        ${csrfField(session)}
        <button
          class="link link--quiet"
          type="submit"
          data-confirm="Leave this project? What you wrote stays, and its owner can add you again."
        >
          Leave this project
        </button>
      </form>`}
    `,
  });
}

export function projectLogPage({ session, project, log }) {
  return page({
    title: `Everything done · ${project.title}`,
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">Everything that has been done</h1>
      ${within(project)}
      ${log.length > 0
        ? html`<ol class="log">
            ${log.map(logItem)}
          </ol>`
        : html`<p class="empty empty--notes">Nothing has been written yet.</p>`}
    `,
  });
}

/* ---------------------------------------------------------------- a page */

export function pagePage({ session, project, role, current, pages, proposals, flash }) {
  const at = pages.findIndex((each) => each.id === current.id);
  const [before, after] = [pages[at - 1], pages[at + 1]];
  const edits = mayEdit(role);
  const meta = [
    html`<span
      ><a href="/pages/${current.id}/history">Version ${current.version}</a>, saved ${stamp(current.updated_at)} by
      ${current.editor_name}</span
    >`,
    html`<a href="/pages/${current.id}/edit">${edits ? "Edit" : "Suggest a change"}</a>`,
  ];
  return page({
    title: `${current.title} · ${project.title}`,
    session,
    current: "projects",
    main: html`
      ${notice(flash, "ok")}
      <article class="post">
        <header class="post__head">
          <p class="rubric"><a href="/projects/${project.id}">${project.title}</a></p>
          <h1 class="post__title">${current.title}</h1>
          <p class="post__meta">${meta}</p>
        </header>
        ${proposals.length > 0 &&
        html`<div class="notice notice--ok">
          <p>${plural(proposals.length, "suggestion")} for this page ${proposals.length === 1 ? "awaits" : "await"} an answer:</p>
          <ul class="related related--close">
            ${proposals.map(proposalItem)}
          </ul>
        </div>`}
        <div class="prose">${raw(renderPost(current.body, { initial: true }))}</div>
      </article>
      ${pages.length > 1 &&
      html`<nav class="pager" aria-label="Pages of this project">
        ${before ? html`<a href="/pages/${before.id}" rel="prev">${before.title}</a>` : html`<span></span>`}
        <span class="pager__where"><a href="/projects/${project.id}">All ${pages.length} pages</a></span>
        ${after ? html`<a href="/pages/${after.id}" rel="next">${after.title}</a>` : html`<span></span>`}
      </nav>`}
    `,
  });
}

/**
 * Writing a new page for a project, or with `current` changing one. Those
 * working on the project can save outright or offer what they wrote as a
 * suggestion; a member who is only reading can offer it.
 */
export function pageWritePage({ session, project, role, current, values, error }) {
  const edits = mayEdit(role);
  const v = { title: current?.title || "", body: current?.body || "", summary: "", base: current?.version, ...values };
  const heading = !current ? "New page" : edits ? "Edit" : "Suggest a change";
  return page({
    title: `${heading} · ${project.title}`,
    session,
    current: "projects",
    scripts: ["editor"],
    math: true,
    main: html`
      <h1 class="page-title">${heading}</h1>
      ${within(project)}
      <form
        class="form compose"
        method="post"
        action="${current ? `/pages/${current.id}/edit` : `/projects/${project.id}/pages`}"
        data-editor="${current ? `page${current.id}` : `project${project.id}`}"
      >
        ${csrfField(session)} ${current && html`<input type="hidden" name="base" value="${v.base}" />`}
        ${notice(error)}
        ${current &&
        v.base !== current.version &&
        html`<p class="notice notice--ok">
          This page has been saved by someone else since you began (it is now at version ${current.version}).
          Carry on: when you save, what they changed and what you changed are joined.
        </p>`}
        <label for="title">Title</label>
        <input id="title" name="title" value="${v.title}" maxlength="200" autocomplete="off" required />

        <label for="body">Text</label>
        <p class="hint">
          Write or paste plainly: a blank line starts a new paragraph. Pictures can be dropped or pasted
          straight into the text.
        </p>
        ${editorField({ body: v.body })}
        ${current &&
        html`<label for="summary">What changed</label>
          <p class="hint">Optional: a line for the others, shown in the record of what has been done.</p>
          <input id="summary" name="summary" value="${v.summary}" maxlength="200" autocomplete="off" />`}

        <div class="compose__actions">
          ${edits && html`<button class="button" type="submit" name="do" value="save">${current ? "Save" : "Add the page"}</button>`}
          ${current &&
          html`<button class="button${edits && " button--quiet"}" type="submit" name="do" value="suggest">
            ${edits ? "Suggest it instead" : "Send the suggestion"}
          </button>`}
          <a class="compose__cancel" href="${current ? `/pages/${current.id}` : `/projects/${project.id}`}">Cancel</a>
        </div>
        ${current &&
        html`<p class="hint compose__how">
          ${edits
            ? "Saving keeps what the page said before as an earlier version. If someone else saves while you are writing, the two are joined. Suggesting leaves the page as it is and shows the others what you would change."
            : "The page stays as it is. Those working on the project see what you would change and decide whether to take it."}
        </p>`}
      </form>
      ${current &&
      edits &&
      html`<form class="compose__delete" method="post" action="/pages/${current.id}/remove">
        ${csrfField(session)}
        <button
          class="link link--danger"
          type="submit"
          data-confirm="Take this page out of the project? It is kept, with all its versions, and can be put back from the project’s page."
        >
          Take this page out of the project
        </button>
      </form>`}
    `,
  });
}

/* --------------------------------------------- two wordings that clash */

/**
 * One wording of a passage. With `was`, the passage as it stood before, what
 * this wording made of it is marked, so that the difference between two long
 * wordings does not have to be hunted for.
 */
function passage(lines, was = []) {
  const text = lines.join("\n");
  if (!text.trim()) return html`<div class="clash__text clash__text--none">Nothing: the passage is taken out.</div>`;
  const before = was.join("\n");
  if (!before.trim()) return html`<div class="clash__text">${text}</div>`;
  const shown = [];
  for (const block of changes(before, text).blocks) {
    const parts =
      block.kind === "same"
        ? [block.lines.join("\n")]
        : block.parts.filter((part) => part.op !== "del").map((part) => (part.op === "ins" ? html`<ins>${part.text}</ins>` : part.text));
    if (parts.length === 0) continue;
    if (shown.length > 0) shown.push("\n");
    shown.push(...parts);
  }
  return html`<div class="clash__text">${shown}</div>`;
}

/**
 * Where a save could not be joined with what somebody else saved meanwhile:
 * each passage both changed, with the two wordings to choose between.
 * `action` is where the choice is sent, `fields` what goes with it, and
 * `ours` and `theirs` say in a few words whose each wording is.
 */
export function clashPage({ session, project, current, merge, action, fields, ours, theirs, lead, leave }) {
  const marked = merge.parts.some((part) => part.clash && part.base.join("\n").trim());
  let n = 0;
  const context = (lines, first, last) => {
    const shown = lines.filter((line) => line.trim());
    const head = first ? [] : shown.slice(0, 2);
    const tail = last ? [] : shown.slice(Math.max(head.length, shown.length - 2));
    const between = shown.length - head.length - tail.length;
    const line = (text) => html`<p class="diff__line">${text}</p>`;
    return html`${head.map(line)}
      ${between > 0 && html`<p class="diff__skip">${between === 1 ? "1 line" : `${number(between)} lines`} settled</p>`}
      ${tail.map(line)}`;
  };
  const parts = merge.parts.map((part, i) => {
    if (!part.clash) return context(part.lines, i === 0, i === merge.parts.length - 1);
    const name = `pick-${n++}`;
    const choice = (value, label) =>
      html`<label><input type="radio" name="${name}" value="${value}" required /> ${label}</label>`;
    return html`<fieldset class="clash">
      <legend>Passage ${n} of ${merge.clashes}</legend>
      <div class="clash__sides">
        <div class="clash__side">
          <p class="rubric">${ours}</p>
          ${passage(part.ours, part.base)}
        </div>
        <div class="clash__side">
          <p class="rubric">${theirs}</p>
          ${passage(part.theirs, part.base)}
        </div>
      </div>
      ${part.base.join("\n").trim() &&
      html`<details class="fold clash__was">
        <summary>As it was before either</summary>
        ${passage(part.base)}
      </details>`}
      <div class="clash__choice">
        ${choice("ours", `Keep ${ours.toLowerCase()}`)} ${choice("theirs", `Keep ${theirs.toLowerCase()}`)}
        ${choice("both", "Keep both, one after the other")}
      </div>
    </fieldset>`;
  });
  return page({
    title: `Two wordings · ${current.title}`,
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">Two wordings of the same passage</h1>
      ${within(project, html`, on <a href="/pages/${current.id}">${current.title}</a>`)}
      <p class="lede">${lead}</p>
      <form class="form clashes" method="post" action="${action}">
        ${csrfField(session)}
        ${Object.entries(fields).map(([name, value]) =>
          name === "body"
            ? html`<textarea name="body" hidden>${value}</textarea>`
            : html`<input type="hidden" name="${name}" value="${value}" />`
        )}
        ${marked && html`<p class="changes__key"><ins>Marked like this</ins> <span>is what each wording changed.</span></p>`}
        <div class="diff" data-typed>${parts}</div>
        <div class="compose__actions">
          <button class="button" type="submit">Save with these choices</button>
          ${"body" in fields &&
          html`<button class="button button--quiet" type="submit" name="do" value="back" formnovalidate>
            Go back to writing
          </button>`}
          <a class="compose__cancel" href="${leave.href}">${leave.label}</a>
        </div>
        <p class="hint compose__how">
          ${"body" in fields
            ? "What the page says now stays in its history whichever you choose. Your own wording of a passage is kept only if you choose it."
            : "Both can still be read whichever you choose: the page as it is now in its history, and the suggestion on its own page."}
        </p>
      </form>
    `,
  });
}

/* ----------------------------------------------------- versions of a page */

const versionWho = (version) =>
  version.via
    ? html`${person(version.editor_username, version.editor_name)}, taken in by ${version.via_name}`
    : person(version.editor_username, version.editor_name);

export function pageHistoryPage({ session, project, role, current, versions }) {
  const edits = mayEdit(role);
  const item = (version) => {
    const first = version.n === 1;
    const facts = [
      stamp(version.created_at),
      versionWho(version),
      first ? `${number(wordCount(version.body))} words` : wordsChanged(version),
      version.merged ? "joined with what others had changed" : false,
    ].filter(Boolean);
    const before = versions.find((each) => each.n === version.n - 1);
    const same = version.title === current.title && version.body === current.body;
    return html`<li class="version" id="v${version.n}">
      <p class="version__head">
        <a class="version__n" href="/pages/${current.id}/v/${version.n}">Version ${version.n}</a>
        ${version.n === current.version && html`<span class="tag">Current</span>`}
      </p>
      <p class="version__meta">${facts.map((fact, i) => html`${i > 0 && " · "}${fact}`)}</p>
      ${version.summary && html`<p class="version__summary">${version.summary}</p>`}
      ${before && before.title !== version.title && html`<p class="version__summary">Title changed to “${version.title}”</p>`}
      <div class="version__actions">
        <a href="/pages/${current.id}/v/${version.n}">Read</a>
        ${!first && html`<a href="/pages/${current.id}/changes?from=${version.n - 1}&amp;to=${version.n}">What changed</a>`}
        ${edits &&
        !same &&
        html`<form method="post" action="/pages/${current.id}/restore">
          ${csrfField(session)}
          <input type="hidden" name="n" value="${version.n}" />
          <button
            class="link"
            type="submit"
            data-confirm="Put version ${version.n} back as the page’s text? It is saved as a new version, so nothing is lost."
          >
            Restore this version
          </button>
        </form>`}
      </div>
    </li>`;
  };
  return page({
    title: `History · ${current.title}`,
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">History</h1>
      ${within(project, html`, of <a href="/pages/${current.id}">${current.title}</a>`)}
      <p class="lede">
        Every saving of this page. Each can be read as it stood and compared with any
        other${edits && ", and an earlier one can be put back"}.
      </p>
      <ol class="versions">
        ${versions.map(item)}
      </ol>
      ${versions.length > 2 && compareForm(`/pages/${current.id}/changes`, versions, versions[0].n - 1, versions[0].n)}
    `,
  });
}

export function pageVersionPage({ session, project, current, version }) {
  const latest = current.version;
  const isCurrent = version.n === latest;
  return page({
    title: `Version ${version.n} · ${version.title}`,
    session,
    current: "projects",
    main: html`
      <div class="notice notice--ok version-bar">
        <p>
          ${isCurrent
            ? html`This is <strong>version ${version.n}</strong>, the current one,`
            : html`This is <strong>version ${version.n}</strong> of ${latest},`}
          as saved ${stamp(version.created_at)} by ${versionWho(version)}.
          ${version.summary && html`<span class="version-bar__summary">“${version.summary}”</span>`}
        </p>
        <p class="version-bar__links">
          ${!isCurrent && html`<a href="/pages/${current.id}">Read the current text</a>`}
          ${version.n > 1 &&
          html`<a href="/pages/${current.id}/changes?from=${version.n - 1}&amp;to=${version.n}">What this version changed</a>`}
          ${version.n < latest &&
          html`<a href="/pages/${current.id}/changes?from=${version.n}&amp;to=${latest}">What has changed since</a>`}
          <a href="/pages/${current.id}/history">History</a>
        </p>
      </div>
      <article class="post">
        <header class="post__head">
          <p class="rubric"><a href="/projects/${project.id}">${project.title}</a></p>
          <h1 class="post__title">${version.title}</h1>
        </header>
        <div class="prose">${raw(renderPost(version.body, { initial: true }))}</div>
      </article>
      <nav class="pager" aria-label="Versions">
        ${version.n > 1
          ? html`<a href="/pages/${current.id}/v/${version.n - 1}" rel="prev">Version ${version.n - 1}</a>`
          : html`<span></span>`}
        <span class="pager__where">Version ${version.n} of ${latest}</span>
        ${version.n < latest
          ? html`<a href="/pages/${current.id}/v/${version.n + 1}" rel="next">Version ${version.n + 1}</a>`
          : html`<span></span>`}
      </nav>
    `,
  });
}

export function pageChangesPage({ session, project, current, before, after, versions, diff }) {
  const side = (word, version) =>
    html`<li>
      ${word} <a href="/pages/${current.id}/v/${version.n}">version ${version.n}</a>, ${stamp(version.created_at)},
      ${version.editor_name}
    </li>`;
  return page({
    title: `What changed · ${current.title}`,
    session,
    current: "projects",
    main: html`
      <h1 class="page-title">What changed</h1>
      ${within(project, html`, on <a href="/pages/${current.id}">${current.title}</a>`)}
      <ul class="changes__sides">
        ${side("From", before)} ${side("to", after)}
      </ul>
      ${compareForm(`/pages/${current.id}/changes`, versions, before.n, after.n)}
      ${changesShown({ before, after, diff })}
      <p class="related__more"><a href="/pages/${current.id}/history">History</a></p>
    `,
  });
}

/* ----------------------------------------------------------- suggestions */

const OUTCOME = { accepted: "Taken in", declined: "Declined", withdrawn: "Withdrawn" };

/** a suggested change: what it would change in the page, and for those who may, the taking or leaving of it */
export function proposalPage({ session, project, role, current, proposal, base, diff, flash, error }) {
  const open = proposal.status === "open";
  const own = proposal.user_id === session.user.id;
  const behind = current.version - proposal.base;
  const act = (path, label, look, confirm) =>
    html`<form method="post" action="/suggestions/${proposal.id}/${path}">
      ${csrfField(session)}
      <button class="${look}" type="submit" ${confirm && raw(`data-confirm="${confirm}"`)}>${label}</button>
    </form>`;
  return page({
    title: `Suggestion · ${current.title}`,
    session,
    current: "projects",
    main: html`
      ${notice(flash, "ok")} ${notice(error)}
      <h1 class="page-title">A suggested change</h1>
      ${within(project, html`, to <a href="/pages/${current.id}">${current.title}</a>`)}
      <p class="lede">
        By ${person(proposal.author_username, proposal.author_name)}, ${stamp(proposal.created_at)}, written from
        version ${proposal.base} of the page.
        ${proposal.summary && html`<span class="version-bar__summary">“${proposal.summary}”</span>`}
      </p>
      ${!open &&
      html`<p class="notice notice--ok">
        ${OUTCOME[proposal.status]}${proposal.decider_name && proposal.status !== "withdrawn" && ` by ${proposal.decider_name}`},
        ${stamp(proposal.decided_at)}.
      </p>`}
      ${open &&
      behind > 0 &&
      html`<p class="hint">
        The page has been saved ${behind === 1 ? "once" : `${behind} times`} since this was written. Taking the
        suggestion in joins it with what has changed since.
      </p>`}
      ${open &&
      (mayEdit(role) || own) &&
      html`<div class="suggestion__actions">
        ${mayEdit(role) && act("accept", "Take it in", "button")}
        ${mayEdit(role) && !own && act("decline", "Decline", "button button--quiet", "Decline this suggestion? Its author is told in the project’s conversation.")}
        ${own && act("withdraw", "Withdraw it", "button button--quiet", "Withdraw your suggestion?")}
      </div>`}
      <h2 class="section-title">What it would change</h2>
      ${changesShown({ before: base, after: proposal, diff })}
    `,
  });
}