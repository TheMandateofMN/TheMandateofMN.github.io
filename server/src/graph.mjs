/*
 * Setting a graph out on the page.
 *
 * Nodes push each other apart and edges pull their ends together until things
 * settle, and then anything whose label would sit on another's is nudged
 * clear. Nothing here is random, so the same graph is always drawn the same
 * way, and the result is plain coordinates: the page is an SVG that needs no
 * script to be read.
 */

import { clip } from "./render.mjs";

/*
 * How hard each kind of edge pulls. Two nodes joined by an edge that pulls
 * with 1 come to rest one spacing apart, and further apart the weaker it is:
 * a commentary sits by what it answers, a reader some way from what they noted.
 */
const PULL = { commentary: 1, wrote: 0.6, link: 0.5, note: 0.16, address: 0.07 };
/* beyond this many spacings, nodes no longer push on each other */
const FAR = 2.2;
const GRAVITY = 0.07;
/* a handful of nodes is not spread over the whole sheet: this is as far apart as neighbours are set */
const WIDEST_SPACING = 180;
/* and what has settled is stretched by no more than this to fill the sheet */
const MOST_STRETCH = 1.5;

const WIDTH = 1000;
const LABEL_SIZE = 15;
const CHARACTER = 6.9; // the mean width of a letter of Garamond at that size
const MARGIN = { top: 24, side: 28, bottom: 40 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const radius = (node) => (node.kind === "person" ? 5 : clamp(6 + 2.3 * Math.sqrt(node.weight), 6, 20));

/**
 * Gives every node a place. Takes `nodes` ({ id, kind, label, weight, ... })
 * and `edges` ({ from, to, kind, ... }) and returns them with coordinates:
 * nodes gain x, y, r and text; edges gain x1, y1, x2, y2, running from rim to
 * rim; and the whole fits in `width` by `height`.
 */
export function layout(nodes, edges) {
  const count = nodes.length;
  // more nodes get a larger sheet: taller at first, and past forty wider too
  const scale = Math.max(1, Math.sqrt(count / 40));
  const width = Math.round(WIDTH * scale);
  const height = Math.round(clamp(400 + 15 * count, 460, 1000) * scale);
  if (count === 0) return { width, height, nodes: [], edges: [] };

  // settle in a square, where no direction is favoured, and stretch to the sheet afterwards
  const side = Math.sqrt(width * height);
  const spacing = Math.min(side / Math.sqrt(count + 1), WIDEST_SPACING);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const placed = nodes.map((node, i) => {
    // begin on a sunflower spiral, which spreads any number of points evenly
    const turn = i * 2.399963229728653;
    const out = Math.min(side / 2.4, spacing * Math.sqrt(count)) * Math.sqrt((i + 0.5) / count);
    return { x: side / 2 + out * Math.cos(turn), y: side / 2 + out * Math.sin(turn), dx: 0, dy: 0 };
  });
  const springs = edges
    .map((edge) => ({ a: index.get(edge.from), b: index.get(edge.to), kind: edge.kind }))
    .filter((spring) => spring.a !== undefined && spring.b !== undefined && spring.a !== spring.b);

  const rounds = count > 150 ? 160 : 320;
  for (let round = 0; round < rounds; round++) {
    const heat = (side / 10) * (1 - round / rounds) ** 1.5 + 0.5;
    for (const point of placed) point.dx = point.dy = 0;

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = placed[i].x - placed[j].x;
        let dy = placed[i].y - placed[j].y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          // two on the same spot part along a direction of their own
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          distance = 1;
        }
        // nodes only push on their neighbours; far apart, they leave each other be,
        // or whatever is unconnected would be driven off to the corners
        if (distance > FAR * spacing) continue;
        const push = (spacing * spacing) / distance / distance;
        placed[i].dx += dx * push;
        placed[i].dy += dy * push;
        placed[j].dx -= dx * push;
        placed[j].dy -= dy * push;
      }
    }

    for (const { a, b, kind } of springs) {
      const dx = placed[b].x - placed[a].x;
      const dy = placed[b].y - placed[a].y;
      // the pull grows with the square of the distance, the push falls off with it
      const pull = (PULL[kind] * Math.hypot(dx, dy)) / spacing;
      placed[a].dx += dx * pull;
      placed[a].dy += dy * pull;
      placed[b].dx -= dx * pull;
      placed[b].dy -= dy * pull;
    }

    for (const point of placed) {
      // a little gravity keeps what is unconnected from drifting off
      point.dx += (side / 2 - point.x) * GRAVITY;
      point.dy += (side / 2 - point.y) * GRAVITY;
      const step = Math.hypot(point.dx, point.dy) || 1;
      const move = Math.min(step, heat) / step;
      point.x += point.dx * move;
      point.y += point.dy * move;
    }
  }

  const set = nodes.map((node, i) => {
    // what is written under the node: its label, cut short if it is long
    const text = clip(node.label, 30);
    const r = radius(node);
    return { ...node, text, r, half: Math.max(r, (text.length * CHARACTER) / 2) + 5, x: placed[i].x, y: placed[i].y };
  });

  // stretch what has settled towards the edges of the sheet, each node's label kept inside it
  const span = (values) => ({ low: Math.min(...values), size: Math.max(...values) - Math.min(...values) });
  const across = span(set.map((node) => node.x));
  const down = span(set.map((node) => node.y));
  const widest = Math.max(...set.map((node) => node.half));
  const inner = {
    left: MARGIN.side + Math.min(widest, width / 4),
    right: width - MARGIN.side - Math.min(widest, width / 4),
    top: MARGIN.top + 20,
    bottom: height - MARGIN.bottom - 20,
  };
  const stretch = (size, room) => (size ? Math.min(room / size, MOST_STRETCH) : 0);
  const sx = stretch(across.size, inner.right - inner.left);
  const sy = stretch(down.size, inner.bottom - inner.top);
  for (const node of set) {
    // about the middle of the sheet, so that a small graph sits at its centre
    node.x = (inner.left + inner.right) / 2 + (node.x - across.low - across.size / 2) * sx;
    node.y = (inner.top + inner.bottom) / 2 + (node.y - down.low - down.size / 2) * sy;
  }

  // each node with the label beneath it is a box; boxes that overlap are eased apart
  const box = (node) => ({
    left: node.x - node.half,
    right: node.x + node.half,
    top: node.y - node.r - 4,
    bottom: node.y + node.r + LABEL_SIZE + 9,
  });
  const keepIn = (node) => {
    node.x = clamp(node.x, MARGIN.side + node.half, width - MARGIN.side - node.half);
    node.y = clamp(node.y, MARGIN.top + node.r, height - MARGIN.bottom - node.r);
  };
  for (let round = 0; round < 120; round++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = box(set[i]);
        const b = box(set[j]);
        const overX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overX <= 0 || overY <= 0) continue;
        moved = true;
        // part them along whichever way is shorter
        if (overY <= overX) {
          const shift = (overY / 2 + 0.5) * (set[i].y <= set[j].y ? -1 : 1);
          set[i].y += shift;
          set[j].y -= shift;
        } else {
          const shift = (overX / 2 + 0.5) * (set[i].x <= set[j].x ? -1 : 1);
          set[i].x += shift;
          set[j].x -= shift;
        }
      }
    }
    set.forEach(keepIn);
    if (!moved) break;
  }

  const at = new Map(set.map((node) => [node.id, node]));
  const round1 = (value) => Math.round(value * 10) / 10;
  const drawn = [];
  for (const edge of edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b || a === b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    // from rim to rim, with room at the far end for an arrowhead
    const start = Math.min(a.r + 2, distance / 2);
    const end = Math.min(b.r + 4, distance / 2);
    drawn.push({
      ...edge,
      x1: round1(a.x + (dx / distance) * start),
      y1: round1(a.y + (dy / distance) * start),
      x2: round1(b.x - (dx / distance) * end),
      y2: round1(b.y - (dy / distance) * end),
    });
  }

  return {
    width,
    height,
    nodes: set.map(({ half, ...node }) => ({ ...node, x: round1(node.x), y: round1(node.y), r: round1(node.r) })),
    edges: drawn,
  };
}
