/*
 * The graph page. Without this the graph is a drawing whose every node is a
 * link. With it, the drawing can be zoomed and moved about, pointing at a
 * node picks out what it touches, and selecting one says what it is and
 * offers to open it or to show only what surrounds it.
 */

(() => {
  "use strict";

  const graph = document.querySelector("[data-graph]");
  if (!graph) return;
  const sheet = graph.querySelector("svg");
  const frame = graph.parentElement;
  const tools = frame.querySelector("[data-graph-tools]");
  const card = frame.querySelector("[data-graph-card]");
  const how = document.querySelector("[data-graph-how]");

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  /* ------------------------------------------- what a node touches */

  const edges = [...graph.querySelectorAll(".edge")];
  const nodes = new Map([...graph.querySelectorAll(".node")].map((node) => [node.dataset.id, node]));
  let chosen = null; // the node that has been selected, which stays picked out

  function pick(id) {
    graph.classList.toggle("is-focused", Boolean(id));
    for (const lit of graph.querySelectorAll(".is-on")) lit.classList.remove("is-on");
    if (!id) return;
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
  const LEGIBLE = 0.62;
  let view = null;

  graph.classList.add("is-live");
  tools.hidden = false;
  if (how) {
    how.hidden = false;
    if (/Mac|iPhone|iPad/.test(navigator.platform)) how.querySelector("[data-modifier]").textContent = "⌘";
  }

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
    const centre = graph.querySelector(".node.is-centre");
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

  /* --------------------------------------------------- selecting a node */

  function element(tag, className, text) {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text) made.textContent = text;
    return made;
  }

  /** selects a node, or with null lets go of the one selected */
  function choose(id) {
    chosen = id;
    pick(id);
    card.hidden = !id;
    card.replaceChildren();
    if (!id) return;

    const node = nodes.get(id);
    // "Title — an article by Someone · 3 notes and replies · 1 commentary"
    const [what, ...more] = node.getAttribute("aria-label").split(" · ");
    const [name, kind] = what.split(" — ");
    const title = element("p", "graph__card-what");
    title.append(element("strong", "", name));
    if (kind) title.append(` — ${kind}`);
    card.append(title);
    if (more.length > 0) card.append(element("p", "graph__card-more", more.join(" · ")));

    const links = element("p", "graph__card-links");
    const open = element("a", "", id[0] === "u" ? "Open their page" : "Open");
    open.href = node.getAttribute("href");
    links.append(open);
    if (!node.classList.contains("is-centre")) {
      const around = element("a", "", "Show only what surrounds it");
      const people = graph.dataset.people || id[0] === "u";
      around.href = `/graph?around=${id}${people ? "" : "&show=articles"}`;
      links.append(around);
    }
    const close = element("button", "link link--quiet", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      choose(null);
      node.focus();
    });
    links.append(close);
    card.append(links);
  }

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
