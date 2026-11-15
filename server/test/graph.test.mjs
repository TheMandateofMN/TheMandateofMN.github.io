import assert from "node:assert/strict";
import { test } from "node:test";
import { layout } from "../src/graph.mjs";

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

test("more that is said about a post draws it larger; long labels are cut", () => {
  const drawn = layout([post(1, { weight: 0 }), post(2, { weight: 30, label: "A title that runs on for a good deal longer than a label can" })], []).nodes;
  assert.ok(drawn[1].r > drawn[0].r);
  assert.ok(drawn[1].text.length <= 31 && drawn[1].text.endsWith("…"));
  assert.equal(drawn[0].text, "Article number 1");
});

test("an edge to nowhere is left out, and an empty graph is an empty sheet", () => {
  assert.equal(layout([post(1)], [{ kind: "link", from: "p1", to: "p9" }]).edges.length, 0);
  const empty = layout([], []);
  assert.deepEqual([empty.nodes, empty.edges], [[], []]);
  assert.ok(empty.width > 0 && empty.height > 0);
});
