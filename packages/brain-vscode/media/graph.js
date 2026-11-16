/* App Brain dependency graph. SVG, own force layout, no libraries. All text goes through
 * textContent: names from the repository can never become markup. */
(function () {
  "use strict";
  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const SVGNS = "http://www.w3.org/2000/svg";

  // ---- layout (pure: exported for tests) ---------------------------------------------------------------
  /** Fruchterman-Reingold inside a `side` x `side` box. Deterministic: circle start, fixed iterations. */
  function forceLayout(ids, links, side) {
    const n = ids.length, pos = new Map();
    ids.forEach((id, i) => {
      const a = (2 * Math.PI * i) / n;
      pos.set(id, { x: side / 2 + Math.cos(a) * side * 0.4, y: side / 2 + Math.sin(a) * side * 0.4, dx: 0, dy: 0 });
    });
    const list = ids.map((id) => pos.get(id));
    const k = (side / Math.sqrt(n)) * 0.75;
    const iterations = n > 250 ? 90 : n > 120 ? 160 : 260;
    const edges = links.map(([a, b, w]) => [pos.get(a), pos.get(b), w]);
    let t = side / 6;
    for (let it = 0; it < iterations; it++) {
      for (const p of list) { p.dx = 0; p.dy = 0; }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = list[i].x - list[j].x, dy = list[i].y - list[j].y, d = Math.hypot(dx, dy);
          if (d < 0.01) { dx = ((i % 7) - 3) * 0.1 + 0.05; dy = ((j % 5) - 2) * 0.1 + 0.05; d = Math.hypot(dx, dy); }
          const f = (k * k) / d;
          list[i].dx += (dx / d) * f; list[i].dy += (dy / d) * f;
          list[j].dx -= (dx / d) * f; list[j].dy -= (dy / d) * f;
        }
      }
      for (const [a, b, w] of edges) {
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01, f = ((d * d) / k) * (1 + Math.log(w));
        a.dx -= (dx / d) * f; a.dy -= (dy / d) * f; b.dx += (dx / d) * f; b.dy += (dy / d) * f;
      }
      for (const p of list) {
        p.dx -= (p.x - side / 2) * 0.08; p.dy -= (p.y - side / 2) * 0.08; // gravity
        const d = Math.hypot(p.dx, p.dy) || 0.01, step = Math.min(d, t);
        p.x += (p.dx / d) * step; p.y += (p.dy / d) * step;
      }
      t *= 0.97;
    }
    return pos;
  }

  /**
   * Lays out each connected component on its own, then packs the components in rows, so
   * unrelated parts of the graph sit next to each other instead of drifting apart. Nodes with
   * no edges go into one compact grid. Units are abstract; the view fits them to the screen.
   */
  function layout(nodes, edges, opts) {
    const spacing = (opts && opts.spacing) || 100;
    const ids = nodes.map((nd) => nd.id), known = new Set(ids), parent = new Map(ids.map((i) => [i, i]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const links = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
    for (const e of links) parent.set(find(e.from), find(e.to));
    const groups = new Map();
    for (const id of ids) { const r = find(id); (groups.get(r) || groups.set(r, []).get(r)).push(id); }

    const blocks = []; // { w, h, place(dx, dy, out) }
    const loose = [];
    for (const members of groups.values()) {
      if (members.length === 1) { loose.push(members[0]); continue; }
      const side = Math.sqrt(members.length) * spacing * 1.1 + spacing;
      const inGroup = new Set(members);
      const local = forceLayout(members, links.filter((e) => inGroup.has(e.from)).map((e) => [e.from, e.to, e.weight || 1]), side);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of local.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      blocks.push({ w: x1 - x0 + spacing, h: y1 - y0 + spacing, size: members.length,
        place(dx, dy, out) { for (const [id, p] of local) out.set(id, { x: dx + p.x - x0 + spacing / 2, y: dy + p.y - y0 + spacing / 2 }); } });
    }
    blocks.sort((a, b) => b.size - a.size);
    if (loose.length) {
      const cols = Math.ceil(Math.sqrt(loose.length));
      blocks.push({ w: cols * spacing, h: Math.ceil(loose.length / cols) * spacing, size: 0,
        place(dx, dy, out) { loose.forEach((id, i) => out.set(id, { x: dx + (i % cols) * spacing + spacing / 2, y: dy + Math.floor(i / cols) * spacing + spacing / 2 })); } });
    }
    const out = new Map();
    const total = blocks.reduce((a, b) => a + b.w * b.h, 0);
    const rowWidth = Math.max(Math.sqrt(total) * 1.5, ...blocks.map((b) => b.w));
    let x = 0, y = 0, rowH = 0;
    for (const b of blocks) {
      if (x > 0 && x + b.w > rowWidth) { x = 0; y += rowH; rowH = 0; }
      b.place(x, y, out);
      x += b.w; rowH = Math.max(rowH, b.h);
    }
    return out;
  }

  const same = (a, b) => a === b;
  const radius = (n, level) => (level === "module" ? Math.min(30, 9 + Math.sqrt(n.files) * 3.5) : Math.min(22, 6 + Math.sqrt(n.importedBy) * 2.5));
  const shortName = (id) => (id === "." ? "(root)" : id.split("/").slice(-2).join("/"));
  const DOC_TEXT = { none: "No documentation yet", draft: "Draft awaiting review", reviewed: "Reviewed documentation", stale: "Documentation is out of date" };
  const GLYPH = { reviewed: "✓", stale: "!", draft: "…", none: "" };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") el.textContent = v; else if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") el.textContent = v; else if (k === "class") el.setAttribute("class", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }

  // ---- state -------------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  let graph = null, pos = new Map(), sel = null, showDependents = false, filterText = "", highlightSet = null;
  let view = { x: 0, y: 0, k: 1 };
  let nodeEls = new Map(), edgeEls = [];
  let depth = 1;

  const svg = $("svg");
  const viewport = s("g", { id: "viewport" });
  const edgeLayer = s("g"), nodeLayer = s("g");
  svg.append(s("defs", {}, marker("arrow", ""), marker("arrow-cycle", "cycle")), viewport);
  viewport.append(edgeLayer, nodeLayer);

  function marker(id, cls) {
    return s("marker", { id, class: cls, viewBox: "0 0 10 10", refX: "9", refY: "5", markerUnits: "userSpaceOnUse", markerWidth: "11", markerHeight: "11", orient: "auto-start-reverse" }, s("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
  }

  // ---- derived data --------------------------------------------------------------------------------------
  const outOf = (id) => graph.edges.filter((e) => e.from === id).map((e) => e.to);
  const inTo = (id) => graph.edges.filter((e) => e.to === id).map((e) => e.from);
  function dependentsOf(id) {
    const seen = new Set([id]);
    let frontier = [id];
    while (frontier.length) {
      const next = [];
      for (const x of frontier) for (const d of inTo(x)) if (!seen.has(d)) { seen.add(d); next.push(d); }
      frontier = next;
    }
    seen.delete(id);
    return seen;
  }
  const inCycle = (id) => graph.cycles.some((c) => c.includes(id));

  // ---- rendering -----------------------------------------------------------------------------------------
  function render() {
    edgeLayer.textContent = ""; nodeLayer.textContent = ""; nodeEls = new Map(); edgeEls = [];
    $("empty").hidden = graph.nodes.length > 0;
    if (graph.nodes.length === 0) {
      $("empty").textContent = graph.root ? `Nothing to show around ${graph.root}.` : "Nothing is indexed yet. Open a folder with source code and wait for the index to finish.";
    }
    pos = layout(graph.nodes, graph.edges, { spacing: 2 * Math.max(...graph.nodes.map((n) => radius(n, graph.level)), 10) + 60 });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    for (const e of graph.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const path = s("path", { class: "edge" + (e.cycle ? " cycle" : "") + (e.confidence === "guess" ? " guess" : ""), "marker-end": e.cycle ? "url(#arrow-cycle)" : "url(#arrow)", "stroke-width": String(Math.min(4, 1 + Math.log2(e.weight))) },
        s("title", { text: `${e.from} → ${e.to}${e.weight > 1 ? ` (${e.weight} imports)` : ""}${e.confidence === "guess" ? " (uncertain match)" : ""}${e.cycle ? " (circular)" : ""}` }));
      edgeLayer.append(path);
      edgeEls.push({ e, path });
    }
    for (const n of graph.nodes) {
      const r = radius(n, graph.level);
      const cls = ["node", n.doc, n.trust || "", inCycle(n.id) ? "cyc" : ""].filter(Boolean).join(" ");
      const label = `${n.id}: ${n.kind}, ${DOC_TEXT[n.doc]}${n.trust ? ", " + n.trust : ""}, imported by ${n.importedBy}${inCycle(n.id) ? ", in a circular dependency" : ""}`;
      const g = s("g", { class: cls, tabindex: "0", role: "button", "aria-label": label, onclick: (ev) => { ev.stopPropagation(); select(n.id); },
        onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(n.id); } } },
        s("title", { text: label }),
        s("circle", { class: "ring", r: String(r + 4) }), s("circle", { class: "body", r: String(r) }),
        r >= 11 && GLYPH[n.doc] ? s("text", { class: "glyph", "font-size": String(Math.round(r * 0.9)), text: GLYPH[n.doc] }) : null,
        s("text", { class: "label", y: String(r + 2), dy: "1.1em", text: shortName(n.id) }));
      nodeLayer.append(g);
      nodeEls.set(n.id, { n, g, r });
    }
    place();
    fit();
    applyHighlight();
    updateChrome();
    void byId;
  }

  /** Positions nodes and edges from `pos` (edges are curved so A→B and B→A do not overlap). */
  function place() {
    for (const { n, g } of nodeEls.values()) { const p = pos.get(n.id); g.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`); }
    for (const { e, path } of edgeEls) {
      const a = pos.get(e.from), b = pos.get(e.to);
      const ra = nodeEls.get(e.from).r + 3, rb = nodeEls.get(e.to).r + 6;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
      const x1 = a.x + ux * ra, y1 = a.y + uy * ra, x2 = b.x - ux * rb, y2 = b.y - uy * rb;
      const bend = Math.min(40, d * 0.15);
      path.setAttribute("d", `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${((x1 + x2) / 2 - uy * bend).toFixed(1)} ${((y1 + y2) / 2 + ux * bend).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    }
  }

  function applyView() {
    viewport.setAttribute("transform", `translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.k.toFixed(3)})`);
    svg.style.setProperty("--inv", String(1 / view.k)); // labels keep a constant size on screen
    svg.classList.toggle("quiet", graph !== null && graph.nodes.length > 60 && view.k < 0.8); // too dense to label everything
  }
  function fit() {
    const box = svg.getBoundingClientRect();
    if (pos.size === 0) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pos.values()) { x0 = Math.min(x0, p.x - 50); y0 = Math.min(y0, p.y - 50); x1 = Math.max(x1, p.x + 50); y1 = Math.max(y1, p.y + 50); }
    const k = Math.min(box.width / (x1 - x0), box.height / (y1 - y0), 1.4) || 1;
    view = { k, x: (box.width - (x1 - x0) * k) / 2 - x0 * k, y: (box.height - (y1 - y0) * k) / 2 - y0 * k };
    applyView();
  }

  function applyHighlight() {
    const q = filterText.trim().toLowerCase();
    let matches = 0;
    const lit = new Set();
    for (const { n } of nodeEls.values()) {
      const hit = !q || n.id.toLowerCase().includes(q);
      if (hit) matches++;
      if (hit && (!highlightSet || highlightSet.has(n.id))) lit.add(n.id);
    }
    for (const { n, g } of nodeEls.values()) {
      g.classList.toggle("dim", !lit.has(n.id) && !(sel === n.id));
      g.classList.toggle("sel", sel === n.id);
      g.setAttribute("aria-pressed", String(sel === n.id));
    }
    for (const { e, path } of edgeEls) path.classList.toggle("dim", (q || highlightSet) ? !(lit.has(e.from) && lit.has(e.to)) : false);
    $("count").textContent = q ? `${matches} of ${graph.nodes.length} match` : countText();
  }

  function countText() {
    const t = graph.totals, kind = graph.level === "module" ? "modules" : "files";
    return graph.truncated ? `Showing ${graph.nodes.length} of ${t.nodes} ${kind}` : `${graph.nodes.length} ${kind}, ${graph.edges.length} dependencies`;
  }

  function select(id) {
    sel = sel === id ? null : id;
    if (!sel) { showDependents = false; highlightSet = null; }
    else if (showDependents) { highlightSet = dependentsOf(sel); highlightSet.add(sel); }
    applyHighlight(); renderDetails();
  }

  function renderDetails() {
    const box = $("details"); box.textContent = "";
    box.append(h("h2", { text: "Selected" }));
    if (!sel || !nodeEls.has(sel)) { box.append(h("p", { class: "muted", text: "Click a node to see what it depends on and what depends on it." })); return; }
    const n = nodeEls.get(sel).n;
    const nav = (id) => h("button", { type: "button", class: "link", text: id, onclick: () => { if (nodeEls.has(id)) { sel = null; select(id); } } });
    const list = (ids) => ids.length ? h("ul", { class: "plain" }, ids.map((id) => h("li", {}, nav(id)))) : h("span", { text: "none shown" });
    const cyc = graph.cycles.filter((c) => c.includes(n.id));
    box.append(...[
      h("p", {}, h("strong", { text: n.id })),
      h("dl", {},
        h("dt", { text: "Kind" }), h("dd", { text: n.kind === "module" ? `module (${n.files} file${n.files === 1 ? "" : "s"})` : "file" }),
        h("dt", { text: "Symbols" }), h("dd", { text: String(n.symbols) }),
        h("dt", { text: "Used by" }), h("dd", { text: `${n.importedBy} ${n.kind === "module" ? "import links from other modules" : "files"}` }),
        h("dt", { text: "Imports" }), h("dd", { text: `${n.imports} ${n.kind === "module" ? "import links into other modules" : "files"}` }),
        h("dt", { text: "Docs" }), h("dd", { class: n.doc === "stale" ? "warn" : "", text: DOC_TEXT[n.doc] + (n.trust ? ` (${n.trust})` : "") })),
      cyc.length ? h("p", { class: "bad", text: "Circular dependency with: " + cyc[0].filter((x) => x !== n.id).join(", ") }) : null,
      h("p", {}, h("strong", { text: "Depends on" })), list(outOf(n.id)),
      h("p", {}, h("strong", { text: "Used by" })), list(inTo(n.id)),
      h("p", {},
        h("button", { type: "button", class: "primary", id: "focus", text: "Focus here", onclick: () => api.postMessage({ type: "load", level: graph.level, root: n.id, depth }) }), " ",
        n.kind === "file" ? h("button", { type: "button", id: "open", text: "Open file", onclick: () => api.postMessage({ type: "open", path: n.id }) }) : null, " ",
        h("button", { type: "button", id: "deps", "aria-pressed": String(showDependents), text: "Show dependents", title: "Highlight everything in this view that depends on it, directly or through others",
          onclick: () => { showDependents = !showDependents; highlightSet = showDependents ? dependentsOf(n.id) : null; if (highlightSet) highlightSet.add(n.id); applyHighlight(); renderDetails(); } })),
      showDependents ? h("p", { class: "muted", text: `${highlightSet.size - 1} dependent${highlightSet.size === 2 ? "" : "s"} in this view` }) : null,
    ].filter(Boolean));
  }

  function renderSide() {
    const health = $("health"); health.textContent = "";
    health.append(h("h2", { text: "Graph health" }));
    if (graph.cycles.length === 0) health.append(h("p", { text: "No circular dependencies between modules." }));
    else {
      health.append(h("p", { class: "bad", text: `${graph.cycles.length} circular dependenc${graph.cycles.length === 1 ? "y" : "ies"} between modules:` }));
      health.append(h("ul", { class: "plain" }, graph.cycles.map((c) => h("li", {}, h("button", { type: "button", class: "link", text: c.join(" ↔ "), onclick: () => { sel = null; showDependents = false; highlightSet = new Set(c); applyHighlight(); renderDetails(); } })))));
    }
    const list = $("list"); list.textContent = "";
    list.append(h("h2", { text: graph.level === "module" ? "Modules" : "Files" }));
    const sorted = [...graph.nodes].sort((a, b) => b.importedBy - a.importedBy || a.id.localeCompare(b.id));
    list.append(h("ul", { class: "plain" }, sorted.slice(0, 200).map((n) => h("li", {}, h("button", { type: "button", class: "link", text: `${n.id} (${n.importedBy})`, onclick: () => { sel = null; select(n.id); } })))));
    if (graph.truncated) list.append(h("p", { class: "muted", text: "Focus on a node to see more of its surroundings." }));
  }

  function renderLegend() {
    const l = $("legend"); l.textContent = "";
    l.append(h("h2", { text: "Legend" }),
      h("ul", { class: "plain" },
        [["none", "No documentation"], ["draft", "Draft, not reviewed"], ["reviewed", "Reviewed"], ["stale", "Reviewed, code changed since"]].map(([c, t]) => h("li", {}, h("span", { class: "swatch " + c }), t)),
        h("li", {}, h("span", { class: "swatch human" }), "Ring: reviewed by a person"),
        h("li", {}, h("span", { class: "swatch machine" }), "Dashed ring: confirmed by a tool"),
        h("li", {}, "Red dashed line: circular dependency"),
        h("li", {}, "Dotted line: uncertain match"),
        h("li", {}, "Size: files in a module, or how many import it")));
  }

  function updateChrome() {
    $("lvl-module").setAttribute("aria-pressed", String(graph.level === "module"));
    $("lvl-file").setAttribute("aria-pressed", String(graph.level === "file"));
    const chip = $("focus-chip"); chip.textContent = ""; chip.hidden = !graph.root;
    if (graph.root) chip.append(document.createTextNode("Focused on " + graph.root), h("button", { type: "button", id: "unfocus", "aria-label": "Clear focus", text: "✕", onclick: () => api.postMessage({ type: "load", level: graph.level, root: null, depth }) }));
    $("depth-label").hidden = !graph.root;
    $("notice").hidden = !graph.truncated; $("notice").textContent = graph.truncated ? `Showing the ${graph.nodes.length} most connected of ${graph.totals.nodes}. Focus on a node to explore the rest.` : "";
    renderSide(); renderLegend(); renderDetails();
  }

  // ---- interaction ---------------------------------------------------------------------------------------------
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const box = svg.getBoundingClientRect(), px = ev.clientX - box.left, py = ev.clientY - box.top;
    const k = Math.max(0.15, Math.min(4, view.k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    view = { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k };
    applyView();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (ev) => { if (ev.target === svg || ev.target === viewport) { drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y }; svg.classList.add("panning"); svg.setPointerCapture(ev.pointerId); } });
  svg.addEventListener("pointermove", (ev) => { if (drag) { view.x = drag.vx + ev.clientX - drag.x; view.y = drag.vy + ev.clientY - drag.y; applyView(); } });
  svg.addEventListener("pointerup", () => { drag = null; svg.classList.remove("panning"); });
  svg.addEventListener("click", (ev) => { if ((ev.target === svg || ev.target === viewport) && sel) { sel = null; showDependents = false; highlightSet = null; applyHighlight(); renderDetails(); } });

  $("lvl-module").addEventListener("click", () => api.postMessage({ type: "load", level: "module", root: null, depth }));
  $("lvl-file").addEventListener("click", () => api.postMessage({ type: "load", level: "file", root: null, depth }));
  $("fit").addEventListener("click", fit);
  $("refresh").addEventListener("click", () => api.postMessage({ type: "refresh" }));
  $("filter").addEventListener("input", (ev) => { filterText = ev.target.value; applyHighlight(); });
  $("depth").addEventListener("change", (ev) => { depth = Number(ev.target.value); if (graph && graph.root) api.postMessage({ type: "load", level: graph.level, root: graph.root, depth }); });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "graph") {
      graph = msg.graph; sel = null; showDependents = false; highlightSet = null;
      if (typeof msg.depth === "number") { depth = msg.depth; $("depth").value = String(depth); }
      $("error").hidden = true;
      render();
    } else if (msg.type === "error") { $("error").hidden = false; $("error").textContent = msg.message; }
  });

  window.brainGraphLayout = layout; // for tests
  if (typeof module !== "undefined" && module.exports) module.exports = { layout, shortName, same };
  api.postMessage({ type: "ready" });
})();
