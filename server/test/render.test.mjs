import assert from "node:assert/strict";
import { test } from "node:test";
import { diagrams, excerpt, references, renderNote, renderPost, taggedIn, typeset, useLookup } from "../src/render.mjs";

test("plain text keeps its paragraphs and line breaks", () => {
  assert.equal(renderPost("one\ntwo\n\nthree"), "<p>one<br>two</p>\n<p>three</p>\n");
});

test("headings in a post start below the page's own title", () => {
  assert.match(renderPost("# Top\n\n## Next"), /<h2>Top<\/h2>\s*<h3>Next<\/h3>/);
});

test("raw HTML in a post is shown, never run", () => {
  const html = renderPost(
    '<script>alert(1)</script>\n\nInline <b onclick="alert(1)">x</b> <img src=x onerror=alert(1)>\n\n<style>body{display:none}</style>'
  );
  assert.doesNotMatch(html, /<(script|b |img|style)/i);
  assert.match(html, /&lt;script&gt;/);
});

test("links go to http, https, mailto or this site, and nowhere else", () => {
  const html = renderPost(
    [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:alert(1))",
      "[c](data:text/html,x)",
      "[d](//evil.example)",
      "[e](https://ok.example/?a=1&b=2)",
      "[f](/p/2)",
      "[g](mailto:a@b.example)",
    ].join(" ")
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://ok.example/?a=1&amp;b=2", "/p/2", "mailto:a@b.example"]);
});

test("a link's address cannot break out of its attribute", () => {
  const html = renderPost('[x](https://ok.example/"onmouseover="alert(1))');
  assert.doesNotMatch(html, /"onmouseover=/);
});

test("images load over http(s) only", () => {
  assert.match(renderPost("![a tree](https://img.example/t.png)"), /<img src="https:\/\/img\.example\/t\.png" alt="a tree"/);
  assert.doesNotMatch(renderPost("![x](javascript:alert(1)) ![y](data:image/svg+xml,boo)"), /<img/);
});

test("only an article that opens on a capital gets an illuminated initial", () => {
  assert.match(
    renderPost("Gardens are made.", { initial: true }),
    /^<p class="opens"><span class="initial" data-letter="G">G<\/span>ardens/
  );
  // the initials fonts have only some of the alphabet; the rest open on a plain versal
  assert.match(
    renderPost("Before there were feeds.", { initial: true }),
    /^<p class="opens"><span class="versal">B<\/span>efore/
  );
  assert.doesNotMatch(renderPost("gardens", { initial: true }), /initial|versal/);
  assert.doesNotMatch(renderPost("## Heading first\n\nThen text", { initial: true }), /initial/);
  assert.doesNotMatch(renderPost("Gardens are made."), /initial/);
});

test("margin notes are plain text with bare links made clickable", () => {
  const html = renderNote('<b>no</b> & "so"\nnext line\n\nSee https://ok.example/a?b=1, then.');
  assert.equal(
    html,
    "<p>&lt;b&gt;no&lt;/b&gt; &amp; &quot;so&quot;<br>next line</p>" +
      '<p>See <a href="https://ok.example/a?b=1" rel="noopener noreferrer">https://ok.example/a?b=1</a>, then.</p>'
  );
  assert.doesNotMatch(renderNote("javascript:alert(1) [x](javascript:alert(1))"), /<a/);
});

test("an excerpt is plain text cut at a word", () => {
  const text = excerpt("# Title\n\nSome *emphasised* text.\n\n" + "word ".repeat(200), 80);
  assert.ok(text.length <= 81);
  assert.ok(text.startsWith("Title Some emphasised text. word"));
  assert.ok(text.endsWith("word…"));
});

/* names resolve against whatever the server knows; here, two articles and two members */
const NOBODY = { post: () => null, member: () => null, origin: "" };
const KNOWN = {
  post: (title) => ({ "on reading": { id: 7, title: "On Reading" }, "a & b": { id: 8, title: "A & B" } })[title.toLowerCase()] ?? null,
  member: (name) =>
    ({ mira: { id: 2, username: "mira", name: "Mira Okafor" }, "j.doe": { id: 3, username: "j.doe", name: "J <Doe>" } })[
      name.toLowerCase()
    ] ?? null,
  origin: "https://forum.example",
};

test("[[Title]] links to the article of that name", (t) => {
  useLookup(KNOWN);
  t.after(() => useLookup(NOBODY));

  assert.equal(renderPost("See [[on reading]]."), '<p>See <a class="wikilink" href="/p/7">On Reading</a>.</p>\n');
  assert.match(renderPost("See [[ On  Reading |that piece]]."), /<a class="wikilink" href="\/p\/7">that piece<\/a>/);
  assert.match(renderPost("[[A & B]]"), /href="\/p\/8">A &amp; B<\/a>/);

  // a name nothing answers to is left as words, marked as leading nowhere
  const missing = renderPost("See [[Not <written> yet]].");
  assert.doesNotMatch(missing, /<a /);
  assert.match(missing, /<span class="wikilink wikilink--missing"[^>]*>Not &lt;written&gt; yet<\/span>/);

  // code is left alone, and so is the text of a link
  assert.doesNotMatch(renderPost("`[[On Reading]]`"), /wikilink/);
  assert.doesNotMatch(renderPost("    [[On Reading]]"), /wikilink/);
});

test("@name tags a member, and only a member", (t) => {
  useLookup(KNOWN);
  t.after(() => useLookup(NOBODY));
  const tag = '<a class="mention" href="/m/mira">@Mira Okafor</a>';

  assert.equal(renderPost("Ask @mira."), `<p>Ask ${tag}.</p>\n`);
  assert.equal(renderPost("@MIRA, look"), `<p>${tag}, look</p>\n`);
  assert.equal(renderNote("Ask @mira.\n(@mira)"), `<p>Ask ${tag}.<br>(${tag})</p>`);
  // a name is escaped like anything else, and a dot inside a sign-in name belongs to it
  assert.match(renderPost("@j.doe."), /<a class="mention" href="\/m\/j\.doe">@J &lt;Doe&gt;<\/a>\./);

  for (const plain of ["mail a@mira.org", "@nobody said", "`@mira`", "[@mira](https://ok.example)"]) {
    assert.doesNotMatch(renderPost(plain), /class="mention"/, plain);
  }
  for (const plain of ["mail a@mira.org", "@nobody said", "https://ok.example/@mira"]) {
    assert.doesNotMatch(renderNote(plain), /class="mention"/, plain);
  }
});

test("what a text points at is read from it: articles linked and members tagged", (t) => {
  useLookup(KNOWN);
  t.after(() => useLookup(NOBODY));

  const found = references(
    [
      "[[On Reading]] and [[on reading|again]], [[Nowhere]], @mira and @mira, @nobody.",
      "[one](/p/12#notes) [two](https://forum.example/p/13) [three](https://elsewhere.example/p/14) [four](/p/x)",
      "`[[A & B]] @j.doe`",
    ].join("\n\n")
  );
  assert.deepEqual(found, { posts: [7, 12, 13], members: [2] });
  assert.deepEqual(taggedIn("@mira and @j.doe, then @mira again; not a@mira.org"), [2, 3]);
});

test("formulas are typeset, in the line and set apart", () => {
  const inline = renderPost("Euler's $e^{i\\pi} + 1 = 0$ is short.");
  assert.match(inline, /^<p>Euler&#39;s <span class="katex">[\s\S]*<\/span> is short\.<\/p>\n$/);
  assert.doesNotMatch(inline, /katex-display/);
  // the formula as typed travels with it, for those who read by ear
  assert.match(inline, /<annotation encoding="application\/x-tex">e\^\{i\\pi\} \+ 1 = 0<\/annotation>/);

  for (const apart of ["$$\n\\int_0^1 x^2 \\, dx\n$$", "$$\\int_0^1 x^2 \\, dx$$", "```math\n\\int_0^1 x^2 \\, dx\n```"]) {
    const html = renderPost(`Before.\n\n${apart}\n\nAfter.`);
    assert.match(html, /<p>Before\.<\/p>\n<div class="math"><span class="katex-display">[\s\S]*<\/div>\n<p>After\.<\/p>/, apart);
  }
  // set large in the middle of a line, too
  assert.match(renderPost("So $$a^2 + b^2 = c^2$$ holds."), /<p>So <span class="katex-display">[\s\S]*<\/span> holds\.<\/p>/);
});

test("a formula's own marks are not Markdown's", () => {
  const html = renderPost("Both $a_1 * b_1$ and $a_2 * b_2$ and *this*.");
  assert.equal(html.match(/<em>/g)?.length, 1, "only the words between stars are emphasised");
  assert.equal(html.match(/class="katex"/g)?.length, 2);
  assert.match(renderPost("$a < b$ & so"), /a &lt; b<\/annotation>/);
});

test("money and stray dollar signs are left alone", () => {
  for (const plain of [
    "It costs $5 to state and $10 to prove.",
    "A lone $ sign.",
    "Between $ this and that $ there are spaces.",
    "`$x^2$` in code",
    "    $x^2$ indented as code",
    "$$",
  ]) {
    assert.doesNotMatch(renderPost(plain), /katex/, plain);
  }
  assert.match(renderPost("It costs $5 to state and $10 to prove."), /\$5 to state and \$10 to prove/);
});

test("a formula that cannot be set is shown as typed, and nothing in one can run", () => {
  const broken = renderPost("$\\frac{1}{$");
  assert.match(broken, /class="katex-error"/);
  assert.match(broken, /\\frac\{1\}\{/);

  const html = renderPost("$\\href{javascript:alert(1)}{x}$ $\\htmlData{onclick=alert(1)}{y}$ $\\text{<script>alert(1)</script>}$");
  // the commands are shown as words that were not understood; no link, no attribute, no tag comes of them
  assert.doesNotMatch(html, /<a[\s>]|\shref=|\sonclick=|\sdata-|<script/i);
});

test("a picture alone in a paragraph is a figure, and its title the caption", () => {
  assert.equal(
    renderPost('![A tree](/media/abc123.png "An oak, in winter")'),
    '<figure class="figure"><img src="/media/abc123.png" alt="A tree" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
      "<figcaption>An oak, in winter</figcaption></figure>\n"
  );
  assert.doesNotMatch(renderPost("![A tree](https://img.example/t.png)"), /figcaption/);
  // in a line of words it stays in the line
  assert.match(renderPost("Here ![a tree](/media/abc123.png) is one."), /^<p>Here <img src="\/media\/abc123\.png"[^>]*> is one\.<\/p>/);
  assert.match(renderPost('![x](/media/a.png "A <b>bold</b> claim")'), /<figcaption>A &lt;b&gt;bold&lt;\/b&gt; claim<\/figcaption>/);
});

test("pictures come from the web or from what was uploaded here, and nowhere else on this server", () => {
  for (const address of ["/media/../account", "/media/a/b.png", "/account", "/media/", "//evil.example/x.png", "media/abc.png"]) {
    assert.doesNotMatch(renderPost(`![x](${address})`), /<img|<figure/, address);
  }
});

const SQUARE = "\\begin{tikzcd}\n  A \\arrow[r] & B\n\\end{tikzcd}";

test("a block marked tikz is a diagram: its drawing where there is one, its source where there is not", (t) => {
  t.after(() => useLookup({ drawing: () => null }));
  const text = `Before.\n\n\`\`\`tikz A square, or half of one.\n${SQUARE}\n\`\`\`\n\nAfter.`;
  const asked = [];

  useLookup({ drawing: (source) => (asked.push(source), { src: "/tex/0123456789abcdef0123456789abcdef.svg", width: 120, height: 48 }) });
  const drawn = renderPost(text);
  assert.deepEqual(asked, [SQUARE], "the drawing is asked for by its source alone");
  assert.match(
    drawn,
    /<p>Before\.<\/p>\n<figure class="figure figure--diagram"><img src="\/tex\/0123456789abcdef0123456789abcdef\.svg" width="120" height="48" alt="A square, or half of one\." loading="lazy"><figcaption>A square, or half of one\.<\/figcaption><\/figure>\n<p>After\.<\/p>/
  );
  // without words of its own, the source is what a reader who cannot see it is told
  assert.match(renderPost(`\`\`\`tikz\n${SQUARE}\n\`\`\``), /alt="A diagram drawn from LaTeX: \\begin\{tikzcd\} A \\arrow\[r\] &amp; B \\end\{tikzcd\}"/);

  useLookup({ drawing: () => ({ error: "Undefined control sequence. Near: \\nothing" }) });
  const failed = renderPost(text);
  assert.match(failed, /<figure class="figure figure--undrawn"><pre><code>\\begin\{tikzcd\}\n {2}A \\arrow\[r\] &amp; B\n\\end\{tikzcd\}<\/code><\/pre>/);
  assert.match(failed, /<figcaption>This diagram could not be drawn\. Undefined control sequence\. Near: \\nothing<\/figcaption>/);

  useLookup({ drawing: () => null });
  assert.match(renderPost(text), /<figcaption>This diagram has not been drawn yet\.<\/figcaption>/);
  // any other block of code is shown as code
  assert.match(renderPost("```latex\n\\begin{tikzcd}\n```"), /^<pre><code class="language-latex">/);
});

test("the diagrams in a text are found, each once, and only where they would be drawn", () => {
  const other = "\\draw (0,0) -- (1,1);";
  const text = [
    `\`\`\`tikz\n${SQUARE}\n\`\`\``,
    `~~~TikZ with a caption\n${other}\n~~~`,
    `\`\`\`tikzcd\n${SQUARE}\n\`\`\``,
    `\`\`\`latex\n\\draw (2,2);\n\`\`\``,
    "Words about ```tikz in a line.",
  ].join("\n\n");
  assert.deepEqual(diagrams(text), [SQUARE, other]);
  assert.deepEqual(diagrams("No diagrams here, only `tikz` in passing."), []);
  assert.deepEqual(diagrams(`\`\`\`\`\n\`\`\`tikz\n${SQUARE}\n\`\`\`\n\`\`\`\``), [], "one quoted inside another block is not drawn");
});

test("an excerpt keeps formulas as typed and leaves pictures and diagrams out", (t) => {
  useLookup({ drawing: () => ({ src: "/tex/0123456789abcdef0123456789abcdef.svg", width: 1, height: 1 }) });
  t.after(() => useLookup({ drawing: () => null }));
  const text = excerpt(
    `Since $e^{i\\pi} = -1$ we have:\n\n$$\nx^2\n$$\n\n![A tree](/media/abc123.png "An oak")\n\n\`\`\`tikz\n${SQUARE}\n\`\`\`\n\nAnd so on.`
  );
  assert.equal(text, "Since e^{i\\pi} = -1 we have: x^2 And so on.");
});

test("without anything to resolve names against, they stay as typed", () => {
  assert.equal(renderPost("Ask @mira."), "<p>Ask @mira.</p>\n");
  assert.equal(renderNote("Ask @mira."), "<p>Ask @mira.</p>");
  assert.doesNotMatch(renderPost("[[On Reading]]"), /<a /);
  assert.deepEqual(references("[[On Reading]] @mira"), { posts: [], members: [] });
});

test("quotation marks are set as a printer sets them, opening and closing", () => {
  assert.equal(
    typeset(renderPost(`"It's 'so'," she said, "in the '90s." ("Twice.") The dogs' bowl; 'tis hers.`)),
    "<p>“It’s ‘so’,” she said, “in the ’90s.” (“Twice.”) The dogs’ bowl; ’tis hers.</p>\n"
  );
  // a quotation may open before a word that is set differently, and close after it
  assert.equal(typeset(renderPost(`"*Dune*" and *"Dune"* and "[Dune](/p/1)".`)).match(/[“”]/g).join(""), "“”“”“”");
  assert.match(typeset(renderPost("one\n\n\"two\"")), /<p>“two”<\/p>/);
  assert.match(typeset(renderPost("> \"Quoted,\" he wrote.")), /<p>“Quoted,” he wrote\.<\/p>/);
  assert.equal(typeset(renderNote(`He says "no"; I don't.`)), "<p>He says “no”; I don’t.</p>");
  assert.equal(typeset("nothing to set"), "nothing to set");
});

test("what is shown as it was typed keeps the marks it was typed with", () => {
  const html = typeset(renderPost('Run `say "hi"` or\n\n```\necho \'hi\'\n```\n\nand $f\'(x)$, which isn\'t "code".'));
  assert.match(html, /<code>say &quot;hi&quot;<\/code>/);
  assert.match(html, /echo &#39;hi&#39;/);
  assert.match(html, /application\/x-tex">f&#x27;\(x\)<\/annotation>/);
  assert.match(html, /which isn’t “code”\./);

  // addresses, a box being edited, and what is marked as typed are not text to set
  const page = typeset(
    `<a href="/x" title="the &quot;x&quot;">"x"</a><textarea>"draft"</textarea>` +
      `<input value="it&#39;s" /><div class="diff" data-typed><div><p>"old"</p></div><p>"new"</p></div><p>"after"</p>`
  );
  assert.equal(
    page,
    `<a href="/x" title="the &quot;x&quot;">“x”</a><textarea>"draft"</textarea>` +
      `<input value="it&#39;s" /><div class="diff" data-typed><div><p>"old"</p></div><p>"new"</p></div><p>“after”</p>`
  );
});
