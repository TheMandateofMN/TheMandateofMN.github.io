/*
 * The guide: how everything here is used, on one page. Each part has an
 * address of its own (/guide#projects and so on) that other pages point to.
 */

import { config } from "./config.mjs";
import { isSubAdmin } from "./permissions.mjs";
import { html, isAdmin, marksList, may, page } from "./views.mjs";

/**
 * `diagrams` says whether this server can draw LaTeX diagrams; where it
 * cannot, the guide says so instead of promising them.
 */
export function guidePage({ session, diagrams = true }) {
  const admin = isAdmin(session);
  // a sub-admin is told of what they have been given, and of nothing else an admin can do
  const sub = isSubAdmin(session.user);
  const writes = may(session, "write");
  const keeps = may(session, "members");
  const parts = [
    ["start", "Finding your way"],
    ["reading", "Reading, and writing in the margin"],
    ["search", "Searching"],
    ["tagging", "Tagging and linking"],
    ["commentaries", "Commentaries"],
    ["writing", "Writing"],
    ["versions", "Versions"],
    ["canon", "The canon"],
    ["graph", "The graph"],
    ["chat", "Chat"],
    ["projects", "Projects"],
    ["account", "Your account"],
    admin && ["admins", "For admins"],
    sub && ["admins", "For sub-admins"],
  ].filter(Boolean);

  return page({
    title: "Guide",
    session,
    current: "guide",
    main: html`
      <h1 class="page-title">Guide</h1>
      <p class="lede">How everything here is used. It is one page; the list below leads to each part of it.</p>
      <nav class="guide-contents" aria-label="In this guide">
        <ol>
          ${parts.map(([id, name]) => html`<li><a href="#${id}">${name}</a></li>`)}
        </ol>
      </nav>

      <div class="prose manual">
        <section id="start">
          <h2>Finding your way</h2>
          <p>The line at the top of every page leads to everything:</p>
          <dl class="manual__menu">
            <dt><a href="/">Journal</a></dt>
            <dd>
              What has been published, newest first. Short posts are shown whole; articles by their opening.
              The box beside its title <a href="#search">searches</a> everything.
            </dd>
            <dt><a href="/canon">Canon</a></dt>
            <dd>What the main admin has published, in the order it was written.</dd>
            <dt><a href="/graph">Graph</a></dt>
            <dd>A drawing of how the writing and the members hang together.</dd>
            <dt><a href="/projects">Projects</a></dt>
            <dd>Sets of pages that members write together.</dd>
            <dt><a href="/chat">Chat</a></dt>
            <dd>Conversations. A number beside the word says how much you have not read.</dd>
            ${admin &&
            html`<dt><a href="/write">Write</a> and <a href="/members">Members</a></dt>
              <dd>For admins: starting a new post, and the list of who can sign in.</dd>`}
            ${sub && writes && html`<dt><a href="/write">Write</a></dt>
              <dd>Starting a new post, which you have been given as a sub-admin.</dd>`}
            ${sub && keeps && html`<dt><a href="/members">Members</a></dt>
              <dd>The list of who can sign in, which you have been given to manage as a sub-admin.</dd>`}
            <dt><a href="/account">Your name</a></dt>
            <dd>
              Your account: where you have been tagged, how the pages look, where you are signed in, and your
              password. A number beside it counts new tags.
            </dd>
          </dl>
          <p>Everything here is for members only. Nothing can be read without signing in.</p>
          <p>
            A few members are admins, who look after the place. Some others may be sub-admins: members an admin
            has given part of that work, such as starting posts or removing notes. Each member’s own page says
            which they are.
          </p>
        </section>

        <section id="reading">
          <h2>Reading, and writing in the margin</h2>
          <p>
            Open anything in the journal to read it. Under the text is its margin: notes that members have made
            on it, each with the replies to it.
          </p>
          <ul>
            <li>
              <strong>To add a note</strong>, write in the box under “Add a margin note”. To write about one
              passage, select that passage in the text first: it is then quoted above your note, and readers
              can jump from the note to the passage.
            </li>
            <li><strong>To answer a note</strong>, open “Reply” under it. Replies to one note stay together.</li>
            <li>
              <strong>To change what you wrote</strong>, open “Edit” under your own note or reply. What it said
              before is kept and can be read by anyone under “Earlier wording”.
            </li>
            <li><strong>To take it back</strong>, use “Remove” under your own note or reply. An admin can remove anyone’s.</li>
          </ul>
          <p>
            If a note quotes a passage that has since been rewritten, the note says so and leads to the version
            of the text where the passage stood.
          </p>
        </section>

        <section id="search">
          <h2>Searching</h2>
          <p>
            Type a few words into the box beside the title of the <a href="/">Journal</a>, or on the
            <a href="/search">Search</a> page. What is found has all of them, in any order, whatever their
            capitals; part of a word finds the words it is part of.
          </p>
          <p>
            The journal is searched, the notes in its margins, and the pages of the projects you can read.
            Drafts are not, nor is anything that was removed, nor any conversation.
          </p>
        </section>

        <section id="tagging">
          <h2>Tagging and linking</h2>
          <p>
            <strong>To tag a member</strong>, type <code>@</code> and their sign-in name, as in <code>@${session.user.username}</code>.
            After the <code>@</code> a list of members is offered; choose with the arrow keys and Enter, or go
            on typing. It works in posts, notes, replies and chat. A member tagged in a post or a note is told:
            a number appears beside their name, and their account page lists where.
          </p>
          <p>
            <strong>To link to another article here</strong>, put its title in double square brackets:
            <code>[[Its title]]</code>, or <code>[[Its title|other words]]</code> to show different words. After
            <code>[[</code> the titles are offered. An article lists, under “Linked from”, the others that point
            to it. A title that does not exist yet is shown without a link, and begins to lead there once an
            article of that name is published.
          </p>
        </section>

        <section id="commentaries">
          <h2>Commentaries</h2>
          <p>
            A commentary is a longer answer to a post: a piece of writing of its own, shown in the journal and
            listed under the post it answers. Any member can write one. Open the post and choose “Write a
            commentary”. It can be kept as a draft, which only you and the admins see, until you publish it.
          </p>
          <p>
            Starting a new post that answers nothing is for admins. Everything else, notes, replies and
            commentaries, is open to every member.
          </p>
        </section>

        <section id="writing">
          <h2>Writing</h2>
          <p>
            Posts, commentaries and the pages of projects are all written in the same box. Type plainly: a blank
            line starts a new paragraph. A row of buttons above the box does the rest, and the same things can
            be typed by hand:
          </p>
          ${marksList()}
          <ul>
            <li>
              <strong>Preview.</strong> “Side by side” shows the text as it will look, beside what you type, on a
              wide screen; “Preview” shows it alone.
            </li>
            <li>
              <strong>Pictures.</strong> Use the Picture button, paste a picture, or drop one onto the box. A
              picture on a line of its own is set as a figure; words in quotation marks after its address
              become its caption. PNG, JPEG, GIF, WebP, AVIF and SVG, up to 10 MB.
            </li>
            <li>
              <strong>Formulas</strong> are written as in LaTeX, between dollar signs: one in the line as
              <code>$x^2$</code>, one set apart between lines of <code>$$</code>.
            </li>
            <li>
              <strong>Diagrams</strong> are LaTeX too: a block that opens with <code>\`\`\`tikz</code> is drawn
              (TikZ, tikz-cd and pgfplots are understood), and anything written after <code>tikz</code> on that
              line is the caption.
              ${diagrams
                ? "If a diagram cannot be drawn, its source is shown with what LaTeX said was wrong."
                : "This server does not have LaTeX installed at present, so diagrams are shown as their source."}
            </li>
            <li>
              <strong>Keys.</strong> Ctrl or ⌘ with B, I and K make bold, italic and a link. Enter in a list
              begins the next item; Tab sets an item under the one above.
            </li>
            <li>
              <strong>Nothing is lost by accident.</strong> What you are writing is kept in your browser as you
              go. If the page is closed or the connection fails, opening the page again offers it back.
            </li>
            <li>A text written elsewhere can be brought in with “Open a text file”, or simply pasted.</li>
          </ul>
          <p>
            A post with a title is shown as an article; one without is a short post. “Save as draft” keeps it
            out of the journal until it is published.
          </p>
        </section>

        <section id="versions">
          <h2>Versions</h2>
          <p>
            Every wording a post is published with is kept. When a published post is saved again, the new
            wording becomes its next version and the old one stays. The line “What changed” is for a few words
            about the change.
          </p>
          <p>
            Under a revised post’s title is its version number, which leads to its history. There each version
            can be read as it stood, and any two can be compared: what was added is marked in green and what
            was removed is struck through in red. The author or an admin can restore an earlier version, which
            saves it again as the newest, so restoring loses nothing either.
          </p>
        </section>

        <section id="canon">
          <h2>The canon</h2>
          <p>
            One of the admins is the main admin, and whatever the main admin publishes is the canon: articles,
            short posts and commentaries alike. Nothing has to be done to put a piece in it, and nobody else’s
            writing can be added to it.
          </p>
          <ul>
            <li>The <a href="/canon">Canon</a> page lists all of it, oldest first.</li>
            <li>In the journal and on its own page, a piece of the canon has “Canon” beside its date.</li>
            <li>
              On the graph it is drawn in gold with a fine ring around it, and the main admin is the gold
              diamond.
            </li>
          </ul>
          <p>
            The canon follows the person. If another admin becomes the main admin, the canon is from then on
            what that admin has published.
          </p>
        </section>

        <section id="graph">
          <h2>The graph</h2>
          <p>
            The graph draws every published piece as a dot and every member as a small diamond, with lines for
            who wrote what, which pieces answer or link to which, who has annotated what, and who has been
            talking to whom. The more is said about a piece, the larger it is drawn.
          </p>
          <ul>
            <li><strong>To move about</strong>, drag. To zoom, use the buttons, pinch, double-click, or scroll with Ctrl or ⌘ held.</li>
            <li>
              <strong>To look at one thing</strong>, select it: its connections stand out and a card names it.
              From the card, “Open” goes to it and “Show only what surrounds it” draws just its neighbourhood,
              which can be widened a step at a time.
            </li>
            <li>What is drawn in gold belongs to <a href="#canon">the canon</a>.</li>
            <li>“Writing only” leaves the members out. “On the graph”, on any post or member’s page, leads straight to its place.</li>
          </ul>
        </section>

        <section id="chat">
          <h2>Chat</h2>
          <p>There are three kinds of room, all listed under <a href="/chat">Chat</a>:</p>
          <ul>
            <li><strong>Everyone</strong> is the common room. Every member can read and write there.</li>
            <li>
              <strong>A conversation</strong> is between you and the members you choose, one or several. Tick
              them under “Start a conversation”. It is shown to no one else, admins included, and the same
              people always come back to the same conversation.
            </li>
            <li>
              <strong>Each project</strong> has a room for those working on it. The forum also notes there what
              is done to the project: who was added, which pages were begun, what was suggested.
            </li>
          </ul>
          <p>
            Messages appear as they are sent, without reloading. Enter sends; Shift and Enter starts a new line.
            Links become clickable and <code>@name</code> points to a member. You can remove a message of your
            own; an admin can remove any in a room they can read.
          </p>
        </section>

        <section id="projects">
          <h2>Projects</h2>
          <p>
            A project is a set of pages that several members write together, a paper, a reading list, a plan.
            It does what version control does for programmers, without any of the machinery: there is nothing
            to install and nothing to learn, and whatever anyone saves is kept.
          </p>
          <h3>Starting one and choosing who works on it</h3>
          <p>
            Any member can <a href="/projects/new">start a project</a>. Give it a name, tick the members who
            will work on it with you, and say who may read it: only those working on it, or every member. You
            can add and remove people later under the project’s “Settings”. Everyone working on a project can
            add pages and change any page; only its owner (or an admin) can change its settings, choose its
            people or delete it.
          </p>
          <h3>Saving</h3>
          <p>
            Open a page, choose “Edit”, write, and save. Every saving is kept as a numbered version, with who
            made it and when. The line “What changed” tells the others in a few words. A page’s “Version”
            link leads to its history, where any version can be read, any two compared, and an earlier one put
            back. “Everything that has been done” on the project’s page is the same record for the whole
            project.
          </p>
          <h3>When two people change a page at once</h3>
          <p>
            You do not need to take turns or warn each other. If someone saves a page while you are still
            writing on it, your save does not replace theirs: the two are joined. What they changed and what
            you changed are both in the result, even where you worked on the same paragraph, as long as it was
            not the same words. The page then tells you it was joined, so you can read it through.
          </p>
          <p>
            Only if you both changed the very same words is there something to decide. You are shown each such
            passage with the two wordings side by side and choose: yours, theirs, or both one after the other.
            What the page said before your save stays in its history whichever you choose.
          </p>
          <h3>Suggesting instead of changing</h3>
          <p>
            If you would rather the others looked first, choose “Suggest it instead” when you have written
            your change. The page stays as it is; the suggestion is listed on the project, and shows exactly
            what it would change. Anyone working on the project can take it in or decline it, and you can
            withdraw it. Taking a suggestion in joins it with whatever the page has become since, in the same
            way as a save. In a project that every member can read, members who are not working on it can
            suggest changes too; that is the only way they can change it.
          </p>
          <h3>Taking things out</h3>
          <p>
            A page taken out of a project is not destroyed: it is listed at the foot of the project’s page and
            can be put back with all its versions. Deleting a whole project is the one thing that cannot be
            undone, which is why only its owner or an admin can do it.
          </p>
        </section>

        <section id="account">
          <h2>Your account</h2>
          <p>
            <a href="/account">Your account page</a> lists where you have been tagged, newest first. Your own
            page, which others reach by clicking your name anywhere, shows what you have written.
          </p>
          <ul>
            <li>
              <strong>How the pages look.</strong> The pages are dark, gold on black, unless you choose
              otherwise. Under “How the pages look”, choose “Paper” for ink on paper, or “Night” to go back.
              The choice is kept with your account, so it is the same wherever you sign in.
            </li>
            <li>
              <strong>Where you are signed in.</strong> Every browser you are signed in from is listed, with
              when it was last used. “Sign it out” ends one of them; “Sign out everywhere else” ends all but
              the one you are using. If one of them is not yours, sign it out and change your password.
            </li>
            <li>
              <strong>Your password.</strong> A new one needs at least ${config.minPasswordLength} characters,
              and cannot be your own name or one of the few that everyone tries first. A few unrelated words
              make a good one. Changing it signs you out everywhere else.
            </li>
          </ul>
          <p>
            If you forget your password, ask an admin: they can issue a new one, which you can then change.
            After several wrong passwords in a row, signing in is refused for a quarter of an hour. “Sign
            out” is at the end of the line at the top.
          </p>
        </section>

        ${sub &&
        html`<section id="admins">
          <h2>For sub-admins</h2>
          <p>
            An admin has made you a sub-admin: a member who can do some of what an admin can. This is what you
            have been given; an admin can change it at any time.
          </p>
          <ul>
            ${writes &&
            html`<li>
              <strong>Starting posts.</strong> You can start a new post, from <a href="/write">Write</a>, as
              well as answer one with a commentary.
            </li>`}
            ${may(session, "edit") &&
            html`<li>
              <strong>Editing the journal.</strong> You can see everyone’s drafts, and edit, unpublish, restore
              or delete any post or commentary, the main admin’s among them. Every wording is kept under
              “Versions”.
            </li>`}
            ${may(session, "moderate") &&
            html`<li>
              <strong>Moderating.</strong> You can remove any margin note or reply, and any message in a room
              you can read. You cannot reword what someone else wrote.
            </li>`}
            ${keeps &&
            html`<li>
              <strong>Managing members.</strong> On the <a href="/members">Members</a> page, add someone by
              their name and a sign-in name; a password is made for them and shown to you once, to pass on.
              You can issue a member a new password, and remove or restore one. Admins and other sub-admins
              are out of your reach, and only an admin makes a sub-admin.
            </li>`}
            ${may(session, "projects") &&
            html`<li>
              <strong>Overseeing projects.</strong> You can see every project, including private ones, with
              its conversation, and do in each what its owner can. Private conversations between members are
              not shown to you.
            </li>`}
          </ul>
        </section>`}
        ${admin &&
        html`<section id="admins">
          <h2>For admins</h2>
          <ul>
            <li>
              <strong>Members.</strong> On the <a href="/members">Members</a> page, add someone by their name and
              a sign-in name. A password is made for them and shown to you once, to pass on. From the same page
              you can issue a new password for someone who has lost theirs, and remove or restore a member. A
              removed member can no longer sign in; what they wrote stays. Under each member is when they
              last signed in.
            </li>
            <li>
              <strong>Sub-admins.</strong> A member can be given some of what you can do. On the
              <a href="/members">Members</a> page choose “Make sub-admin” beside their name and tick what they
              are to have: starting posts; editing the journal (everyone’s drafts, and changing or deleting
              any post); moderating (removing notes, replies and messages); managing members (adding,
              new passwords, removing and restoring, but never an admin or another sub-admin); overseeing
              projects (every project, private ones too). Each sub-admin can be given something different.
              “Permissions” beside their name changes it, and unticking everything makes them a member again.
              Only admins make sub-admins, and a sub-admin who is removed comes back as a member.
            </li>
            <li><strong>Posts.</strong> Only admins start new posts, from <a href="/write">Write</a>. You can edit, unpublish or delete any post or commentary, and see everyone’s drafts.</li>
            <li><strong>Notes and messages.</strong> You can remove any margin note or reply, and any message in the common room or a project’s room. You cannot reword what someone else wrote.</li>
            <li>
              <strong>Projects.</strong> You can see every project, including private ones, and do in each
              what its owner can. Private conversations between members are not shown to you.
            </li>
            <li>
              <strong>The main admin.</strong> There is always exactly one, marked on the
              <a href="/members">Members</a> page. Only the main admin can hand the place to another admin,
              with “Make main admin” there, and no other admin can issue the main admin a new password.
              Whoever runs the server can do both from its command line.
            </li>
          </ul>
        </section>`}
      </div>
    `,
  });
}
