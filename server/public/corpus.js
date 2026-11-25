/*
 * The corpus. Without this it is a drawing in which every title is a link.
 * With it, the drawing can be zoomed and moved about, and selecting a title
 * says what it is: its name, who made it and what kind of thing it is, and
 * what is said of it on the corpus (a work's annotation, the claims of the
 * essay at the centre), with the way to open it and, for those who may, to
 * change it. Where the drawing has lines, pointing at a title picks out what
 * it touches.
 *
 * Those who keep the corpus can also arrange it: the page then comes marked
 * data-arrange, every title can be dragged to where it belongs (or moved with
 * the arrow keys), and saving sends where each of them stands.
 */

(() => {
  "use strict";

  const graph = document.querySelector("[data-graph]");
  if (!graph) return;
  const sheet = graph.querySelector("svg");
  const frame = graph.parentElement;
  const tools = frame.querySelector("[data-graph-tools]");
  const card = frame.querySelector("[data-graph-card]");

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  // the corpus is being arranged: its titles are there to be moved, not chosen
  const arranging = graph.hasAttribute("data-arrange");

  /* ------------------------------------------- what a node touches */

  const edges = [...graph.querySelectorAll(".edge")];
  const nodes = new Map([...graph.querySelectorAll(".node")].map((node) => [node.dataset.id, node]));
  let chosen = null; // the node that has been selected, which stays picked out

  function pick(id) {
    // the rest falls back only where there are lines to say what a title touches
    graph.classList.toggle("is-focused", Boolean(id) && edges.length > 0);
    for (const lit of graph.querySelectorAll(".is-on")) lit.classList.remove("is-on");
    if (!id || !nodes.has(id)) return;
    nodes.get(id).classList.add("is-on");
    for (const edge of edges) {
      const { from, to } = edge.dataset;
      if (from !== id && to !== id) continue;
      edge.classList.add("is-on");
      nodes.get(from === id ? to : from)?.classList.add("is-on");
    }
  }

  for (const [id, node] of nodes) {
    node.addEventListener("pointerenter", () => pick(id));
    node.addEventListener("pointerleave", () => pick(chosen));
    node.addEventListener("focus", () => {
      pick(id);
      bringIntoView(node);
    });
    node.addEventListener("blur", () => pick(chosen));
  }

  /* ------------------------------------------------- zooming and moving */

  /*
   * The drawing keeps its own coordinates; what changes is the window onto
   * it, the SVG's viewBox. `view` is that window, in the drawing's units.
   */
  const [, , fullWidth, fullHeight] = sheet.getAttribute("viewBox").split(/\s+/).map(Number);
  const CLOSEST = 8;
  const FURTHEST = 0.6;
  /* text is drawn fifteen units tall: below this many pixels to the unit it cannot be read */
  const LEGIBLE = 0.7;
  let view = null;

  graph.classList.add("is-live");
  tools.hidden = false;

  /** the window that shows the whole drawing, centred, in the frame's own proportions */
  function whole() {
    const { width, height } = sheet.getBoundingClientRect();
    const units = Math.max(fullWidth / width, fullHeight / height);
    const w = width * units;
    const h = height * units;
    return { x: (fullWidth - w) / 2, y: (fullHeight - h) / 2, w, h };
  }

  function show(next) {
    const all = whole();
    const w = clamp(next.w, all.w / CLOSEST, all.w / FURTHEST);
    const h = (w * all.h) / all.w;
    // the middle of the window stays on the drawing, so it cannot be lost off the edge
    view = {
      x: clamp(next.x + (next.w - w) / 2, -w / 2, fullWidth - w / 2),
      y: clamp(next.y + (next.h - h) / 2, -h / 2, fullHeight - h / 2),
      w,
      h,
    };
    sheet.setAttribute("viewBox", [view.x, view.y, view.w, view.h].map((n) => n.toFixed(2)).join(" "));
    const zoom = all.w / view.w;
    tools.querySelector('[data-zoom="in"]').disabled = zoom >= CLOSEST - 0.01;
    tools.querySelector('[data-zoom="out"]').disabled = zoom <= FURTHEST + 0.01;
  }

  /** zooms by `factor`, keeping still the point of the drawing under (clientX, clientY) */
  function zoomAt(factor, clientX, clientY) {
    const box = sheet.getBoundingClientRect();
    const px = clientX === undefined ? 0.5 : (clientX - box.left) / box.width;
    const py = clientY === undefined ? 0.5 : (clientY - box.top) / box.height;
    const all = whole();
    const w = clamp(view.w / factor, all.w / CLOSEST, all.w / FURTHEST);
    const h = (w * view.h) / view.w;
    show({ x: view.x + px * (view.w - w), y: view.y + py * (view.h - h), w, h });
  }

  function moveBy(dx, dy) {
    const box = sheet.getBoundingClientRect();
    show({ ...view, x: view.x - (dx * view.w) / box.width, y: view.y - (dy * view.h) / box.height });
  }

  const placeOf = (node) => {
    const [x, y] = node.getAttribute("transform").match(/-?[\d.]+/g).map(Number);
    return { x, y };
  };

  /** moves the window, if it must, so that a node reached with the keyboard can be seen */
  function bringIntoView(node) {
    if (!view) return;
    const { x, y } = placeOf(node);
    const margin = view.w * 0.08;
    if (x > view.x + margin && x < view.x + view.w - margin && y > view.y + margin && y < view.y + view.h - margin) return;
    show({ ...view, x: x - view.w / 2, y: y - view.h / 2 });
  }

  /** gives the frame its size, and the window onto the drawing its first or its adjusted place */
  function settle() {
    const before = view && { cx: view.x + view.w / 2, cy: view.y + view.h / 2, zoom: whole().w / view.w };
    const width = graph.clientWidth;
    // nothing can be worked out for a frame with no width; it is settled when it is given one
    if (!width) return;
    const height = clamp((width * fullHeight) / fullWidth, 320, Math.max(320, window.innerHeight * 0.78));
    sheet.style.height = `${Math.round(height)}px`;
    const all = whole();
    if (before) {
      const w = all.w / before.zoom;
      const h = all.h / before.zoom;
      return show({ x: before.cx - w / 2, y: before.cy - h / 2, w, h });
    }
    // on a small screen the whole drawing would be too small to read: begin close enough,
    // on the node the page is about if there is one
    const pixelsPerUnit = sheet.getBoundingClientRect().width / all.w;
    if (pixelsPerUnit >= LEGIBLE) return show(all);
    const w = all.w * (pixelsPerUnit / LEGIBLE);
    const h = all.h * (pixelsPerUnit / LEGIBLE);
    const centre = graph.querySelector(".node.is-centre, .node[data-main]");
    const { x, y } = centre ? placeOf(centre) : { x: fullWidth / 2, y: fullHeight / 2 };
    show({ x: x - w / 2, y: y - h / 2, w, h });
  }

  settle();
  let width = graph.clientWidth;
  new ResizeObserver(() => {
    if (graph.clientWidth === width) return;
    width = graph.clientWidth;
    settle();
  }).observe(graph);

  for (const button of tools.querySelectorAll("[data-zoom]")) {
    button.addEventListener("click", () => {
      if (button.dataset.zoom === "fit") show(whole());
      else zoomAt(button.dataset.zoom === "in" ? 1.5 : 1 / 1.5);
    });
  }

  // scrolling with Ctrl or ⌘ held zooms, and so does a pinch on a trackpad, which
  // browsers report the same way; plain scrolling is left to move the page
  graph.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(Math.exp(-clamp(step, -60, 60) * 0.012), event.clientX, event.clientY);
    },
    { passive: false }
  );

  // Safari reports a trackpad pinch as a gesture of its own
  let gestureScale = 1;
  graph.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    gestureScale = 1;
  });
  graph.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    zoomAt(event.scale / gestureScale, event.clientX, event.clientY);
    gestureScale = event.scale;
  });

  // one pointer drags the drawing about; two pinch it
  const pointers = new Map();
  let dragged = false;
  let travelled = 0;

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  graph.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // while the corpus is arranged, a title that is pressed is carried, and the drawing stays where it is
    if (arranging && pointers.size === 0 && carry(event)) return;
    if (pointers.size === 0) {
      dragged = false;
      travelled = 0;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });

  window.addEventListener("pointermove", (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    if (pointers.size === 1) {
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      travelled += Math.hypot(dx, dy);
      // a hand is never quite still: a few pixels are a press, not a drag
      if (travelled > 5) {
        if (!dragged) graph.classList.add("is-dragging");
        dragged = true;
        moveBy(dx, dy);
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    const before = spread();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = spread();
    dragged = true;
    if (before.distance > 0) zoomAt(after.distance / before.distance, after.x, after.y);
    moveBy(after.x - before.x, after.y - before.y);
  });

  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size === 0) graph.classList.remove("is-dragging");
    });
  }

  // a link would otherwise be picked up and carried off by the drag
  graph.addEventListener("dragstart", (event) => event.preventDefault());

  frame.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (arranging && nudge(event)) return;
    const step = 60;
    if (event.key === "+" || event.key === "=") zoomAt(1.5);
    else if (event.key === "-" || event.key === "_") zoomAt(1 / 1.5);
    else if (event.key === "0") show(whole());
    else if (event.key === "ArrowLeft") moveBy(step, 0);
    else if (event.key === "ArrowRight") moveBy(-step, 0);
    else if (event.key === "ArrowUp") moveBy(0, step);
    else if (event.key === "ArrowDown") moveBy(0, -step);
    else if (event.key === "Escape") choose(null);
    else return;
    event.preventDefault();
  });

  /* ------------------------------------------------ arranging the corpus */

  /*
   * Where each title has been put, by its id. Places are kept from the essay
   * at the centre, which stays where it is, so that they hold whatever the
   * size of the sheet comes to be.
   */
  const [originX, originY] = (graph.dataset.origin || "0 0").split(" ").map(Number);
  const arrangeForm = frame.parentElement.querySelector("form[data-arrange-form]");
  let moved = false;
  let carried = null;

  const movable = (node) => node && node.dataset.id[0] === "p" && !node.hasAttribute("data-main");

  function put(node, x, y) {
    node.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    moved = true;
  }

  /** begins carrying the title under a pointer, if there is one that can be moved; says whether it did */
  function carry(event) {
    const node = event.target.closest?.(".node");
    if (!movable(node)) return false;
    const box = sheet.getBoundingClientRect();
    carried = { id: event.pointerId, node, x: event.clientX, y: event.clientY, scale: view.w / box.width };
    node.classList.add("is-carried");
    // drawn last, so that it passes over the others
    node.parentNode.append(node);
    event.preventDefault();
    return true;
  }

  window.addEventListener("pointermove", (event) => {
    if (!carried || event.pointerId !== carried.id) return;
    const { x, y } = placeOf(carried.node);
    put(carried.node, x + (event.clientX - carried.x) * carried.scale, y + (event.clientY - carried.y) * carried.scale);
    carried.x = event.clientX;
    carried.y = event.clientY;
  });
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      if (!carried || event.pointerId !== carried.id) return;
      carried.node.classList.remove("is-carried");
      carried = null;
    });
  }

  /** moves the title that has the keyboard by a step with the arrow keys, a small one with Shift held; says whether it did */
  function nudge(event) {
    const node = document.activeElement?.closest?.(".node");
    if (!movable(node)) return false;
    const step = event.shiftKey ? 2 : 16;
    const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!by) return false;
    const { x, y } = placeOf(node);
    put(node, x + by[0], y + by[1]);
    event.preventDefault();
    return true;
  }

  if (arranging && arrangeForm) {
    graph.classList.add("is-arranging");
    arrangeForm.addEventListener("submit", () => {
      // every title is kept where it is seen to stand, the ones that were not touched as well
      const places = [];
      for (const [id, node] of nodes) {
        if (!movable(node)) continue;
        const { x, y } = placeOf(node);
        places.push(`${id}:${(x - originX).toFixed(1)},${(y - originY).toFixed(1)}`);
      }
      arrangeForm.elements.places.value = places.join(" ");
      moved = false;
    });
    // leaving with titles moved and not saved is asked about first
    window.addEventListener("beforeunload", (event) => {
      if (moved) event.preventDefault();
    });
    // a title is not opened from here, nor the drawing zoomed by pressing twice on one
    graph.addEventListener("click", (event) => event.preventDefault(), true);
    return;
  }

  /* --------------------------------------------------- selecting a node */

  function element(tag, className, text) {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text) made.textContent = text;
    return made;
  }

  /** selects a node, or with null lets go of the one selected */
  function choose(id) {
    chosen = id && nodes.has(id) ? id : null;
    pick(chosen);
    card.hidden = !chosen;
    card.replaceChildren();
    if (!chosen) return;
    id = chosen;

    const node = nodes.get(id);
    const name = node.dataset.name;
    const href = node.getAttribute("href");
    const work = node.classList.contains("node--work");

    // its title, with the ways on from it on the same line
    const top = element("div", "graph__card-top");
    const title = element("p", "graph__card-what");
    title.append(element(work ? "cite" : "strong", "", name));
    const links = element("p", "graph__card-links");
    const link = (label, to) => {
      const made = element("a", "", label);
      made.href = to;
      links.append(made);
    };
    link(id[0] === "u" ? "Open their page" : "Open", href);
    // those who keep the corpus go from a piece on it back to the form it was written or added with
    if (node.dataset.edit) link("Edit", node.dataset.edit);
    const close = element("button", "link link--quiet", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      choose(null);
      node.focus();
    });
    links.append(close);
    top.append(title, links);
    card.append(top);

    // under it, for a work, who made it and what kind of thing it is; for anything else, what the node says of itself
    const said = node.getAttribute("aria-label") || "";
    const more = work ? node.dataset.by : (said.startsWith(name) ? said.slice(name.length) : said).replace(/^ [—·] /, "");
    if (more) card.append(element("p", "graph__card-more", more));

    // what is said of it on the corpus, which the page keeps folded away until its title is chosen
    const kept = [...frame.querySelectorAll("template[data-graph-note]")].find((each) => each.dataset.graphNote === id);
    if (kept) {
      const note = element("div", "graph__card-note");
      note.append(kept.content.cloneNode(true));
      card.append(note);
    }
  }

  // a page that links to a piece's place on the corpus (/corpus#p12) arrives with it chosen
  function arrive() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!/^p\d+$/.test(id) || !nodes.has(id)) return;
    choose(id);
    bringIntoView(nodes.get(id));
  }
  arrive();
  window.addEventListener("hashchange", arrive);

  graph.addEventListener(
    "click",
    (event) => {
      // the end of a drag is not a choice
      if (dragged) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const node = event.target.closest(".node");
      // with a modifier held, a link is left to open as links do, in a tab of its own
      if (node && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
      event.preventDefault();
      // selecting what is already selected opens it
      if (node && node.dataset.id === chosen) return window.location.assign(node.getAttribute("href"));
      choose(node ? node.dataset.id : null);
    },
    true
  );

  graph.addEventListener("dblclick", (event) => {
    if (event.target.closest(".node")) return;
    event.preventDefault();
    zoomAt(event.shiftKey ? 1 / 1.8 : 1.8, event.clientX, event.clientY);
  });
})();
