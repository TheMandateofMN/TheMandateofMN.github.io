/*
 * Setting the corpus out on the page.
 *
 * There are two ways of it. The whole of it is set out about its centre: the
 * essay everything here answers stands in the middle, the works that the
 * writing descends from to the left of it and what has been written here to
 * the right, each title where its keeper has dragged it. A title that has
 * not been given a place yet is found one, on its own side, clear of the
 * others. A part of the corpus, what surrounds one piece or one member, is
 * set out freely: nodes push each other apart and edges pull their ends
 * together until things settle.
 *
 * A piece of writing or a work is drawn as its title, on as many lines as it
 * needs. About a title there may be more, which is measured with it: the
 * letter that says whose a piece is, the type of thing a work is, the mark
 * of one that shows and tells, and the sign that something opens under it.
 * Nothing here is random, so the same corpus is always drawn the same way,
 * and the result is plain coordinates: the page is an SVG that needs no
 * script to be read.
 */

import { clip } from "./render.mjs";

/*
 * How hard each kind of edge pulls. Two nodes joined by an edge that pulls
 * with 1 come to rest one spacing apart, and further apart the weaker it is:
 * a commentary sits by what it answers, a reader some way from what they noted.
 */
const PULL = { commentary: 1, wrote: 0.6, link: 0.5, descent: 0.3, note: 0.16, address: 0.07 };
/* beyond this many spacings, nodes no longer push on each other */
const FAR = 2.2;
const GRAVITY = 0.07;
/* a handful of nodes is not spread over the whole sheet: this is as far apart as neighbours are set */
const WIDEST_SPACING = 180;
/* and what has settled is stretched by no more than this to fill the sheet */
const MOST_STRETCH = 1.5;

const WIDTH = 1000;
const LABEL_SIZE = 15;
const CHARACTER = 6.9; // the mean width of a letter of Garamond set fifteen units tall
/* the room, in letters, of the mark before a title that shows and tells, and of the sign after one that opens */
const STAR = 1.1;
const FOLD = 1.5;
const MARGIN = { top: 24, side: 28, bottom: 14 };

/* the essay at the centre is set this tall */
const MAIN_SIZE = 23;
/* a title is broken into lines about this many letters long, and into no more lines than this */
const LINE = 18;
const MAIN_LINE = 24;
const MOST_LINES = 3;

/*
 * Where the whole corpus finds a place for a title that has not been given one: on arcs about the
 * middle, on its own side. The first arc is this far out and each next one this much further; the
 * arcs are wider than they are tall, as a page is, reach this far round from level, and hold titles
 * this far apart.
 */
const FIRST_ARC = 250;
const NEXT_ARC = 170;
const ARC_WIDE = 1.2;
const ARC_TALL = 0.82;
const ARC_REACH = (68 * Math.PI) / 180;
const APART = 64;
/* no title of one side comes nearer the middle line than this */
const ASIDE = 26;
/* a title that was dragged is kept within this of the middle, whatever was sent */
export const FURTHEST = 4000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round1 = (value) => Math.round(value * 10) / 10;

/** a title broken into lines of about `width` letters, at its spaces, and into no more than MOST_LINES of them */
function broken(label, width) {
  const lines = [];
  let line = "";
  for (const word of String(label).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length === 0) return [""];
  // what will not go on the last line allowed is cut short there
  const kept = lines.slice(0, MOST_LINES);
  if (lines.length > MOST_LINES) kept[MOST_LINES - 1] = clip(lines.slice(MOST_LINES - 1).join(" "), width);
  // and so is a single word longer than any line
  return kept.map((each) => clip(each, width + 8));
}

/**
 * What a node is drawn as, and the room that takes: for a member `text`, and
 * for a piece `lines`, the lines of its title; the `size` they are set in;
 * and a box about its place reaching `hw` to either side, `up` above and
 * `down` below. A piece's lines are `lead` apart, the middle of the first of
 * them `first` below its place, so that all it is drawn as is centred there.
 * `r` grows with how much has been said about a piece.
 */
function measured(node) {
  if (node.kind === "person") {
    // a small diamond with the name beneath it
    const text = clip(node.label, 30);
    const r = 5;
    return { ...node, text, r, size: LABEL_SIZE, hw: Math.max(r, (text.length * CHARACTER) / 2) + 5, up: r + 4, down: r + LABEL_SIZE + 9 };
  }
  const r = clamp(6 + 2.3 * Math.sqrt(node.weight || 0), 6, 20);
  const size = node.main ? MAIN_SIZE : round1(14.5 + (r - 6) * 0.4);
  const lines = broken(node.label, node.main ? MAIN_LINE : LINE);
  const lead = round1(size * 1.14);
  // what is set about the title, in letters of the title's own size: the mark before its first line and the
  // letter after its last, and under that the type of a work, which is a line of its own. The sign that
  // something opens comes last, on whichever line that is.
  const fold = node.annotation ? FOLD : 0;
  const last = lines.length - 1;
  const widths = lines.map(
    (line, i) =>
      line.length +
      (i === 0 && node.showTell ? STAR : 0) +
      (i === last && node.hand ? 0.3 + 0.62 * node.hand.length : 0) +
      (i === last && !node.extent ? fold : 0)
  );
  if (node.extent) widths.push(0.86 * node.extent.length + fold);
  const rows = widths.length;
  const high = (rows * lead) / 2 + 3;
  return {
    ...node,
    lines,
    r,
    size,
    lead,
    first: round1((-(rows - 1) * lead) / 2),
    hw: (Math.max(...widths) * CHARACTER * size) / LABEL_SIZE / 2 + 9,
    up: high,
    down: high,
  };
}

/** how far from a node's place its edge is, going the way (ux, uy) */
function rim(node, ux, uy) {
  if (node.kind === "person") return node.r + 2;
  const across = Math.abs(ux) < 1e-6 ? Infinity : node.hw / Math.abs(ux);
  const along = Math.abs(uy) < 1e-6 ? Infinity : (uy < 0 ? node.up : node.down) / Math.abs(uy);
  return Math.min(across, along) + 1;
}

/**
 * Lets nodes settle in a square of `side`: they push each other apart and
 * edges pull their ends together. With `pin`, the node of that id is held at
 * the middle, and the rest settle about it. Gives back each node's place.
 */
function settle(nodes, edges, { side, spacing, pin = null }) {
  const count = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const held = pin === null ? -1 : (index.get(pin) ?? -1);
  const placed = nodes.map((node, i) => {
    if (i === held) return { x: side / 2, y: side / 2, dx: 0, dy: 0 };
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
      const pull = ((PULL[kind] ?? 0.3) * Math.hypot(dx, dy)) / spacing;
      placed[a].dx += dx * pull;
      placed[a].dy += dy * pull;
      placed[b].dx -= dx * pull;
      placed[b].dy -= dy * pull;
    }

    placed.forEach((point, i) => {
      if (i === held) return;
      // a little gravity keeps what is unconnected from drifting off
      point.dx += (side / 2 - point.x) * GRAVITY;
      point.dy += (side / 2 - point.y) * GRAVITY;
      const step = Math.hypot(point.dx, point.dy) || 1;
      const move = Math.min(step, heat) / step;
      point.x += point.dx * move;
      point.y += point.dy * move;
    });
  }
  return placed;
}

/**
 * Eases apart whatever would be drawn over something else: each node with
 * its words is a box, and two boxes that overlap are parted along whichever
 * way is shorter. `keepIn` puts a node back where it may be after each round.
 * A node that `held` says is held is never moved, and the others make way
 * for it.
 */
function part(set, keepIn, held = () => false) {
  const box = (node) => ({ left: node.x - node.hw, right: node.x + node.hw, top: node.y - node.up, bottom: node.y + node.down });
  const still = set.map(held);
  for (let round = 0; round < 160; round++) {
    let moved = false;
    for (let i = 0; i < set.length; i++) {
      for (let j = i + 1; j < set.length; j++) {
        if (still[i] && still[j]) continue;
        const a = box(set[i]);
        const b = box(set[j]);
        const overX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overX <= 0 || overY <= 0) continue;
        moved = true;
        // each gives way by half, unless one of them is held, when the other gives way by all of it
        const [mine, theirs] = still[i] ? [0, 1] : still[j] ? [1, 0] : [0.5, 0.5];
        if (overY <= overX) {
          const shift = (overY + 1) * (set[i].y <= set[j].y ? -1 : 1);
          set[i].y += shift * mine;
          set[j].y -= shift * theirs;
        } else {
          const shift = (overX + 1) * (set[i].x <= set[j].x ? -1 : 1);
          set[i].x += shift * mine;
          set[j].x -= shift * theirs;
        }
      }
    }
    set.forEach((node, i) => still[i] || keepIn(node));
    if (!moved) break;
  }
}

/** the lines between nodes that have been given places, each running from rim to rim */
function lines(edges, set) {
  const at = new Map(set.map((node) => [node.id, node]));
  const drawn = [];
  for (const edge of edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b || a === b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const start = Math.min(rim(a, ux, uy), distance / 2);
    const end = Math.min(rim(b, -ux, -uy), distance / 2);
    drawn.push({
      ...edge,
      x1: round1(a.x + ux * start),
      y1: round1(a.y + uy * start),
      x2: round1(b.x - ux * end),
      y2: round1(b.y - uy * end),
    });
  }
  return drawn;
}

const finished = (set) =>
  set.map((node) => ({
    ...node,
    x: round1(node.x),
    y: round1(node.y),
    r: round1(node.r),
    hw: round1(node.hw),
    up: round1(node.up),
    down: round1(node.down),
  }));

/**
 * Gives every node a place, freely. Takes `nodes` ({ id, kind, label, weight,
 * ... }) and `edges` ({ from, to, kind, ... }) and returns them with
 * coordinates: nodes gain x, y, r, text and the box they are drawn in; edges
 * gain x1, y1, x2, y2; and the whole fits in `width` by `height`.
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
  const placed = settle(nodes, edges, { side, spacing });
  const set = nodes.map((node, i) => ({ ...measured(node), x: placed[i].x, y: placed[i].y }));

  // stretch what has settled towards the edges of the sheet, each node's words kept inside it
  const span = (values) => ({ low: Math.min(...values), size: Math.max(...values) - Math.min(...values) });
  const across = span(set.map((node) => node.x));
  const down = span(set.map((node) => node.y));
  const widest = Math.max(...set.map((node) => node.hw));
  const inner = {
    left: MARGIN.side + Math.min(widest, width / 4),
    right: width - MARGIN.side - Math.min(widest, width / 4),
    top: MARGIN.top + 20,
    bottom: height - MARGIN.bottom - 46,
  };
  const stretch = (size, room) => (size ? Math.min(room / size, MOST_STRETCH) : 0);
  const sx = stretch(across.size, inner.right - inner.left);
  const sy = stretch(down.size, inner.bottom - inner.top);
  for (const node of set) {
    // about the middle of the sheet, so that a small graph sits at its centre
    node.x = (inner.left + inner.right) / 2 + (node.x - across.low - across.size / 2) * sx;
    node.y = (inner.top + inner.bottom) / 2 + (node.y - down.low - down.size / 2) * sy;
  }

  part(set, (node) => {
    node.x = clamp(node.x, MARGIN.side + node.hw, width - MARGIN.side - node.hw);
    node.y = clamp(node.y, MARGIN.top + node.up, height - MARGIN.bottom - node.down);
  });

  return { width, height, nodes: finished(set), edges: lines(edges, set) };
}

/**
 * Gives every piece a place about the centre. The node marked `main` stands
 * in the middle. A node with a `place` ({ x, y }, measured from the middle)
 * stands there: it is where its keeper dragged it. Of the rest, the nodes of
 * kind "work" are found places to the left of the middle and whatever else
 * was written to the right, in the order of their `order`, on arcs about the
 * middle, and eased clear of each other and of what has been placed.
 * Members are not drawn in the whole corpus, and neither are the edges.
 *
 * Returns what layout() does, with no edges, and `origin`: where on the
 * sheet the middle is, which is what a place is measured from.
 */
export function scatter(nodes) {
  const all = nodes.filter((node) => node.kind !== "person").map(measured);
  const main = all.find((node) => node.main) ?? null;
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
  const sides = [
    [-1, all.filter((node) => node.kind === "work").sort(byOrder)],
    [1, all.filter((node) => node.kind !== "work" && node !== main).sort(byOrder)],
  ];
  const within = (place) => ({ x: clamp(place.x, -FURTHEST, FURTHEST), y: clamp(place.y, -FURTHEST, FURTHEST) });
  if (main) Object.assign(main, { x: 0, y: 0, held: true });

  for (const [sign, side] of sides) {
    // every title of the side has a slot on the arcs, whether or not it has been placed, so that
    // placing one does not send the others looking for somewhere new
    let arc = 0;
    let taken = 0;
    const room = (k) => {
      const tall = (FIRST_ARC + NEXT_ARC * k) * ARC_TALL;
      return Math.max(1, Math.floor((2 * ARC_REACH * tall) / APART));
    };
    const slots = side.map(() => {
      if (taken === room(arc)) {
        arc += 1;
        taken = 0;
      }
      return { arc, at: taken++ };
    });
    side.forEach((node, i) => {
      if (node.place) return Object.assign(node, within(node.place), { held: true });
      const { arc: k, at } = slots[i];
      // how many share this arc: they are spread evenly about level, the first of them highest
      const sharing = slots.filter((slot) => slot.arc === k).length;
      const step = sharing > 1 ? Math.min((2 * ARC_REACH) / (sharing - 1), 0.5) : 0;
      const angle = (at - (sharing - 1) / 2) * step;
      // each alternate title stands a little in or out, so that an arc does not read as a rule
      const out = FIRST_ARC + NEXT_ARC * k + (at % 2 === 0 ? -16 : 16);
      Object.assign(node, { x: sign * Math.max(out * ARC_WIDE * Math.cos(angle), node.hw + ASIDE), y: out * ARC_TALL * Math.sin(angle) });
    });
  }

  // what was found a place makes way for what was given one, and stays on its own side
  const set = [...(main ? [main] : []), ...sides.flatMap(([, side]) => side)];
  part(
    set,
    (node) => {
      const sign = node.kind === "work" ? -1 : 1;
      node.x = sign * Math.max(sign * node.x, node.hw + ASIDE);
    },
    (node) => Boolean(node.held)
  );

  /* the sheet: as much as all of that needs, with the middle in its middle */
  const halfWidth = Math.max(WIDTH / 2, ...set.map((node) => Math.abs(node.x) + node.hw + MARGIN.side));
  const halfHeight = Math.max(250, ...set.map((node) => Math.abs(node.y) + Math.max(node.up, node.down) + 30));
  for (const node of set) {
    node.x += halfWidth;
    node.y += halfHeight;
    delete node.held;
  }
  return {
    width: Math.round(2 * halfWidth),
    height: Math.round(2 * halfHeight),
    nodes: finished(set),
    edges: [],
    origin: { x: round1(halfWidth), y: round1(halfHeight) },
  };
}
