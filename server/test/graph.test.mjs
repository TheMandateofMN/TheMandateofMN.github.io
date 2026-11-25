import assert from "node:assert/strict";
import { test } from "node:test";
import { FURTHEST, layout, scatter } from "../src/graph.mjs";

const post = (n, extra = {}) => ({ id: `p${n}`, kind: "article", label: `Article number ${n}`, weight: n % 5, ...extra });
const person = (n) => ({ id: `u${n}`, kind: "person", label: `Member ${n}`, weight: 0 });

/** a graph of `count` posts in a chain, each written by one of three people */
function chain(count) {
  const nodes = [...Array(count).keys()].map((n) => post(n + 1));
  const edges = nodes.slice(1).map((node, i) => ({ kind: "link", from: node.id, to: nodes[i].id }));
  for (const n of [1, 2, 3]) nodes.push(person(n));
  nodes.slice(0, count).forEach((node, i) => edges.push({ kind: "wrote", from: `u${(i % 3) + 1}`, to: node.id }));
  return { nodes, edges };
}

test("every node is given a place on the sheet", () => {
  for (const count of [1, 2, 9, 60]) {
    const { nodes, edges } = chain(count);
    const drawn = layout(nodes, edges);
    assert.equal(drawn.nodes.length, nodes.length);
    assert.equal(drawn.edges.length, edges.length);
    for (const node of drawn.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} has a place`);
      assert.ok(node.x >= node.r && node.x <= drawn.width - node.r, `${node.id} is within the width`);
      assert.ok(node.y >= node.r && node.y <= drawn.height - node.r, `${node.id} is within the height`);
    }
    for (const edge of drawn.edges)
      assert.ok([edge.x1, edge.y1, edge.x2, edge.y2].every(Number.isFinite), "an edge has both its ends");
  }
});

test("no two nodes are set down on top of each other", () => {
  const { nodes, edges } = chain(24);
  const drawn = layout(nodes, edges).nodes;
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const apart = Math.hypot(drawn[i].x - drawn[j].x, drawn[i].y - drawn[j].y);
      assert.ok(apart > drawn[i].r + drawn[j].r, `${drawn[i].id} and ${drawn[j].id} are apart`);
    }
  }
});

test("the same graph is always drawn the same way", () => {
  const { nodes, edges } = chain(12);
  assert.deepEqual(layout(nodes, edges), layout(structuredClone(nodes), structuredClone(edges)));
});

test("what is connected is drawn closer than what is not", () => {
  const nodes = [post(1), post(2), post(3), post(4)];
  const drawn = layout(nodes, [{ kind: "commentary", from: "p2", to: "p1" }]).nodes;
  const at = Object.fromEntries(drawn.map((node) => [node.id, node]));
  const apart = (a, b) => Math.hypot(at[a].x - at[b].x, at[a].y - at[b].y);
  assert.ok(apart("p1", "p2") < apart("p1", "p3"));
  assert.ok(apart("p1", "p2") < apart("p2", "p4"));
});

test("a title takes the room its words need, on more lines than one if they are many; a member's name that is long is cut", () => {
  const drawn = layout(
    [post(1), post(2, { label: "A title that runs on longer than a line" }), { ...person(1), label: "A member whose name runs on for longer than a name should" }],
    []
  ).nodes;
  assert.deepEqual(drawn[0].lines, ["Article number 1"]);
  assert.ok(drawn[1].lines.length > 1 && drawn[1].lines.join(" ") === "A title that runs on longer than a line");
  assert.ok(drawn[1].up + drawn[1].down > drawn[0].up + drawn[0].down);
  assert.ok(drawn[2].text.length <= 31 && drawn[2].text.endsWith("…"));
});

test("an edge to nowhere is left out, and an empty graph is an empty sheet", () => {
  assert.equal(layout([post(1)], [{ kind: "link", from: "p1", to: "p9" }]).edges.length, 0);
  const empty = layout([], []);
  assert.deepEqual([empty.nodes, empty.edges], [[], []]);
  assert.ok(empty.width > 0 && empty.height > 0);
});

/* ------------------------------------------------- the corpus as a whole */

const work = (n, extra = {}) => ({ id: `p${100 + n}`, kind: "work", label: `A work numbered ${n}`, extent: "Book (whole)", weight: 0, order: n, ...extra });

/** a corpus of `written` pieces about a main essay and `works` works, in the order they are numbered in */
function corpus(written, works) {
  const nodes = [post(1, { main: true, label: "The essay at the centre of it all" })];
  for (let n = 2; n <= written; n++) nodes.push(post(n, { order: n, ...(n % 3 === 0 ? { kind: "commentary" } : {}) }));
  for (let n = 1; n <= works; n++) nodes.push(work(n));
  return nodes;
}

const boxOf = (node) => ({ left: node.x - node.hw, right: node.x + node.hw, top: node.y - node.up, bottom: node.y + node.down });
const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

test("the corpus is set out about its essay: the works to its left, what is written here to its right, and no lines", () => {
  for (const [written, works] of [
    [1, 0],
    [1, 1],
    [2, 0],
    [9, 12],
    [40, 42],
    [3, 60],
  ]) {
    const nodes = corpus(written, works);
    const drawn = scatter(nodes);
    const at = Object.fromEntries(drawn.nodes.map((node) => [node.id, node]));
    const say = `${written} written, ${works} works`;
    assert.equal(drawn.nodes.length, nodes.length, say);
    assert.deepEqual(drawn.edges, [], "nothing joins them");

    // the essay is in the middle of the sheet, and is where the places of the others are counted from
    assert.ok(Math.abs(at.p1.x - drawn.width / 2) < 1 && Math.abs(at.p1.y - drawn.height / 2) < 1, say);
    assert.deepEqual([drawn.origin.x, drawn.origin.y], [at.p1.x, at.p1.y], say);

    for (const node of drawn.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} has a place (${say})`);
      const box = boxOf(node);
      assert.ok(box.left >= 0 && box.right <= drawn.width, `${node.id} with its words is within the width (${say})`);
      assert.ok(box.top >= 0 && box.bottom <= drawn.height, `${node.id} is within the height (${say})`);
      if (node.main) continue;
      // a title is wholly on its own side of the essay's middle
      if (node.kind === "work") assert.ok(box.right < at.p1.x, `${node.id} stands to the left (${say})`);
      else assert.ok(box.left > at.p1.x, `${node.id} stands to the right (${say})`);
    }

    // nothing is written over anything else
    for (let i = 0; i < drawn.nodes.length; i++)
      for (let j = i + 1; j < drawn.nodes.length; j++)
        assert.ok(!overlap(boxOf(drawn.nodes[i]), boxOf(drawn.nodes[j])), `${drawn.nodes[i].id} and ${drawn.nodes[j].id} are apart (${say})`);
  }
});

test("a title that has been put somewhere stays there, and the others make way for it", () => {
  const nodes = corpus(6, 6);
  const free = scatter(structuredClone(nodes));
  const from = (drawn, id) => {
    const node = drawn.nodes.find((each) => each.id === id);
    return [Math.round((node.x - drawn.origin.x) * 10) / 10, Math.round((node.y - drawn.origin.y) * 10) / 10];
  };

  // put where another already stands, on the far side of the essay from where the works are set
  const taken = from(free, "p3");
  const placed = structuredClone(nodes);
  placed.find((node) => node.id === "p102").place = { x: taken[0], y: taken[1] };
  placed.find((node) => node.id === "p4").place = { x: -520, y: 310.5 };
  const drawn = scatter(placed);
  assert.deepEqual(from(drawn, "p102"), taken, "a work can be put among what is written here");
  assert.deepEqual(from(drawn, "p4"), [-520, 310.5]);
  assert.deepEqual(from(drawn, "p1"), [0, 0], "the essay stays in the middle");
  for (let i = 0; i < drawn.nodes.length; i++)
    for (let j = i + 1; j < drawn.nodes.length; j++)
      assert.ok(!overlap(boxOf(drawn.nodes[i]), boxOf(drawn.nodes[j])), `${drawn.nodes[i].id} and ${drawn.nodes[j].id} are apart`);
  // the others keep the places they had (to the tenth the sheet is drawn to), but for the one that made way
  const moved = (id) => Math.hypot(from(drawn, id)[0] - from(free, id)[0], from(drawn, id)[1] - from(free, id)[1]);
  for (const id of ["p2", "p5", "p6", "p101", "p103"]) assert.ok(moved(id) < 0.3, id);
  assert.ok(moved("p3") > 5, "what stood there has moved aside");

  // however far off a title was put, it is kept to where the sheet can still be read
  const far = structuredClone(nodes);
  far.find((node) => node.id === "p101").place = { x: -1e7, y: 1e7 };
  const wide = scatter(far);
  assert.deepEqual(from(wide, "p101"), [-FURTHEST, FURTHEST]);
  assert.ok(wide.width <= 2 * (FURTHEST + 600) && wide.height <= 2 * (FURTHEST + 200));
});

test("the corpus is always set out the same way, in the order it is given, and without an essay chosen it still is", () => {
  const nodes = corpus(12, 9);
  assert.deepEqual(scatter(structuredClone(nodes)), scatter(structuredClone(nodes)));
  // the order is the pieces' own, not the one they happen to be handed over in
  const byId = (drawn) => Object.fromEntries(drawn.nodes.map((node) => [node.id, [node.x, node.y]]));
  assert.deepEqual(byId(scatter(structuredClone(nodes).reverse())), byId(scatter(structuredClone(nodes))));
  // the first of a side stands highest
  const drawn = scatter(structuredClone(nodes));
  const y = (id) => drawn.nodes.find((node) => node.id === id).y;
  assert.ok(y("p101") < y("p102") && y("p2") < y("p3"));

  const none = nodes.map((node) => ({ ...node, main: false }));
  const loose = scatter(none);
  assert.equal(loose.nodes.length, nodes.length);
  for (const node of loose.nodes) assert.ok(node.x >= 0 && node.x <= loose.width && node.y >= 0 && node.y <= loose.height, node.id);

  // the members have no place on it
  assert.equal(scatter([...structuredClone(nodes), person(1)]).nodes.some((node) => node.kind === "person"), false);

  const empty = scatter([]);
  assert.deepEqual([empty.nodes, empty.edges], [[], []]);
  assert.ok(empty.width > 0 && empty.height > 0);
});

test("a title too long for a line is set on as many as three, and under a work's is what kind of thing it is", () => {
  const drawn = scatter([
    post(1, { main: true, label: "The essay at the centre of it all" }),
    post(2, { order: 1, label: "Short" }),
    post(3, { order: 2, label: "A title that runs on for a good deal longer than one line of the sheet could hold of it, and then some, and then more still" }),
    work(1, { label: "A work with a name of some length to it" }),
  ]);
  const at = Object.fromEntries(drawn.nodes.map((node) => [node.id, node]));
  assert.deepEqual(at.p2.lines, ["Short"]);
  assert.ok(at.p3.lines.length === 3 && at.p3.lines.at(-1).endsWith("…"), "what will not go on three lines is cut");
  assert.ok(at.p101.lines.length >= 2);
  assert.equal(at.p101.extent, "Book (whole)");
  // a taller title takes more room, above and below where it stands
  assert.ok(at.p3.up + at.p3.down > at.p2.up + at.p2.down);
});

test("around one piece, a line to a title ends at the title, not under it", () => {
  const drawn = layout([post(1, { main: true }), post(2)], [{ kind: "link", from: "p2", to: "p1" }]);
  const at = Object.fromEntries(drawn.nodes.map((node) => [node.id, node]));
  const [edge] = drawn.edges;
  const inside = (node, x, y) => x > node.x - node.hw && x < node.x + node.hw && y > node.y - node.up && y < node.y + node.down;
  assert.ok(!inside(at.p2, edge.x1, edge.y1) && !inside(at.p1, edge.x2, edge.y2));
});
