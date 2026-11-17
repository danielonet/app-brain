/* App Brain "Cost & Models". SVG and HTML only, no libraries. Every name (model, file) comes from agents or
 * the repository, so it is only ever inserted with textContent. */
(function () {
  "use strict";
  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);

  // ---- formatting (pure; exported for tests) --------------------------------------------------------------
  const trim = (t) => t.replace(/\.0(?=[KM]$)/, ""); // 52.0K -> 52K, 9.0K -> 9K
  const compact = (n) => (n >= 1e6 ? trim((n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M") : n >= 1e3 ? trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K") : String(Math.round(n)));
  const usd = (n) => (n === null || n === undefined ? "unknown" : n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : n >= 1e4 ? "$" + compact(n) : "$" + n.toFixed(2));
  const pct = (n) => (n === null || n === undefined ? "n/a" : Math.round(n * 100) + "%");
  const METRICS = {
    cost: { label: "Cost", field: "costUsd", fmt: usd },
    tokens: { label: "Output tokens", field: "tokensOut", fmt: compact },
    calls: { label: "Calls", field: "calls", fmt: (n) => String(n) },
  };
  /** Round tick values 0..max in 1/2/5 steps, about four of them. */
  function niceTicks(max) {
    if (!(max > 0)) return [0, 1];
    const raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    const out = [];
    for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 1e9) / 1e9);
    return out;
  }
  const shortDay = (d) => d.slice(5);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") el.textContent = v; else if (k === "class") el.className = v;
      else if (k === "style") Object.assign(el.style, v); // CSSOM: a style="" attribute would be blocked by the CSP
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

  // ---- tooltip: enhances, never gates (every value is also in a table) ---------------------------------
  const tip = $("tip");
  function showTip(ev, value, label) {
    tip.textContent = "";
    tip.append(h("b", { text: value }), h("span", { text: label }));
    tip.hidden = false;
    const x = ev.clientX !== undefined && ev.clientX > 0 ? ev.clientX : ev.target.getBoundingClientRect().left;
    const y = ev.clientY !== undefined && ev.clientY > 0 ? ev.clientY : ev.target.getBoundingClientRect().top;
    tip.style.left = Math.min(x + 14, window.innerWidth - 310) + "px";
    tip.style.top = Math.max(8, y - 48) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  function hoverable(el, value, label) {
    el.addEventListener("pointermove", (ev) => showTip(ev, value, label));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", (ev) => showTip(ev, value, label));
    el.addEventListener("blur", hideTip);
  }

  // ---- charts ---------------------------------------------------------------------------------------------
  /** Single-series columns: <= 24px, 4px rounded data end, square baseline, hairline grid, one value label (the maximum). */
  function columns(rows, fmt, name) {
    const W = 640, H = 210, L = 46, R = 8, T = 22, B = 28, pw = W - L - R, ph = H - T - B;
    const max = Math.max(...rows.map((r) => r.value), 0), ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
    const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": name });
    const y = (v) => T + ph - (v / top) * ph;
    for (const t of ticks) svg.append(s("line", { class: t === 0 ? "axis" : "grid", x1: L, x2: W - R, y1: y(t), y2: y(t) }), s("text", { class: "tick", x: L - 6, y: y(t) + 4, text: fmt(t) }));
    const band = pw / Math.max(rows.length, 1), bw = Math.min(24, band * 0.7), every = Math.ceil(rows.length / 8);
    const maxAt = rows.findIndex((r) => r.value === max);
    rows.forEach((r, i) => {
      const cx = L + band * i + band / 2, hgt = (r.value / top) * ph, x0 = cx - bw / 2, y0 = y(r.value), rad = Math.min(4, hgt, bw / 2);
      const g = s("g", { class: "col", tabindex: "0", role: "img", "aria-label": `${r.label}: ${fmt(r.value)}` });
      g.append(s("rect", { class: "hit", x: cx - Math.max(band / 2, 12), y: T, width: Math.max(band, 24), height: ph }));
      if (r.value > 0) g.append(s("path", { class: "bar", d: `M${x0},${y0 + hgt} V${y0 + rad} Q${x0},${y0} ${x0 + rad},${y0} H${x0 + bw - rad} Q${x0 + bw},${y0} ${x0 + bw},${y0 + rad} V${y0 + hgt} Z` }));
      if (i === maxAt && r.value > 0) g.append(s("text", { class: "value", x: cx, y: y0 - 6, text: fmt(r.value) }));
      if (i % every === 0) g.append(s("text", { class: "xl", x: cx, y: H - 8, text: r.axis }));
      hoverable(g, fmt(r.value), r.label);
      svg.append(g);
    });
    return svg;
  }

  /** Ranked horizontal bars: a name, a bar on one baseline, the value at the tip. One hue. */
  function rankedBars(rows, fmt) {
    const max = Math.max(...rows.map((r) => r.value), 0) || 1;
    const box = h("div", { class: "rows" });
    for (const r of rows) {
      const wrap = h("div", { class: "barwrap", tabindex: "0", role: "img", "aria-label": `${r.label}: ${fmt(r.value)}` },
        r.value > 0 ? h("div", { class: "b", style: { width: ((r.value / max) * 78).toFixed(1) + "%" } }) : null, // a zero draws no bar
        h("span", { class: "val", text: fmt(r.value) }));
      hoverable(wrap, fmt(r.value), r.label);
      box.append(h("div", { class: "name", text: r.label }), wrap);
    }
    return box;
  }

  /** Tall segmented bar: shares printed inside where they fit, names in the legend. */
  function segmented(parts) {
    const total = parts.reduce((n, p) => n + p.value, 0);
    const bar = h("div", { class: "segbar", role: "img", "aria-label": parts.map((p) => `${p.label}: ${p.value} (${pct(total ? p.value / total : 0)})`).join(", ") });
    for (const p of parts) {
      if (p.value === 0) continue; // a part at zero draws nothing
      const share = p.value / total;
      const part = h("div", { class: "part", style: { flex: `${p.value} 1 0`, background: `var(${p.color})` }, tabindex: "0", text: share >= 0.12 ? pct(share) : "" });
      hoverable(part, `${p.value} call${p.value === 1 ? "" : "s"} (${pct(share)})`, p.label);
      bar.append(part);
    }
    const legend = h("div", { class: "legend" }, parts.map((p) => h("span", {}, h("i", { class: "sw", style: { background: `var(${p.color})` } }), `${p.label}: ${p.value}`)));
    return h("div", {}, bar, legend);
  }

  /** Wide tables scroll inside their own box, so the page itself never scrolls sideways. */
  function table(columns, rows, caption) {
    const t = h("table", {}, caption ? h("caption", { class: "muted", text: caption, hidden: true }) : null,
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "n" : "", text: c.head })))),
      h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c) => { const v = c.cell(r); return v instanceof Node ? v : h("td", { class: (c.num ? "n " : "") + (c.cls ? c.cls(r) : ""), text: v }); })))));
    return h("div", { class: "tablewrap", tabindex: "0", role: "region", "aria-label": caption || "Table" }, t);
  }
  const tableView = (title, columns, rows) => h("details", {}, h("summary", { text: "Table view: " + title }), table(columns, rows));

  // ---- the page --------------------------------------------------------------------------------------------
  let summary = null, metric = "cost", usage = null, usageError = null;

  function metricRows(list, key, axis) {
    const m = METRICS[metric];
    return list.map((x) => ({ label: key(x), axis: axis ? axis(x) : "", value: x[m.field] }));
  }

  function render() {
    const root = $("root"); root.textContent = "";
    const sm = summary, t = sm.totals, m = METRICS[metric];
    if (t.calls === 0) {
      root.append(h("div", { id: "empty" }, h("p", { text: "No documentation has been generated yet." }), h("p", { class: "muted", text: "Cost appears here once an agent calls save_summary. Set model prices in the settings first to see dollar amounts." }),
        h("button", { type: "button", onclick: () => api.postMessage({ type: "openSettings" }), text: "Open settings" })));
      providers(root);
      return;
    }

    // honesty first: a total that is a lower bound must say so
    if (!sm.complete) {
      const reasons = [];
      if (sm.unpricedModels.length) reasons.push(h("li", {}, "No price is set for: " + sm.unpricedModels.join(", ") + ". ", h("button", { type: "button", class: "link", text: "Set prices", onclick: () => api.postMessage({ type: "openSettings" }) })));
      if (t.callsWithoutInputTokens) reasons.push(h("li", { text: `${t.callsWithoutInputTokens} call${t.callsWithoutInputTokens === 1 ? " has" : "s have"} no input-token count (the agent did not report it), so ${t.callsWithoutInputTokens === 1 ? "its" : "their"} cost cannot be worked out.` }));
      root.append(h("div", { class: "notice", role: "status" }, h("span", { class: "icon", "aria-hidden": "true", text: "⚠" }), h("div", {}, h("strong", { text: "These totals are a lower bound." }), h("ul", {}, reasons))));
    }

    // hero + tiles
    root.append(h("div", {}, h("div", { class: "hero-label", text: sm.complete ? "Spend" : "Known spend" }), h("div", { class: "hero", id: "hero", text: usd(t.spendUsd) })));
    const tile = (label, value, id) => h("div", { class: "tile" }, h("div", { class: "v", id, text: value }), h("div", { class: "l", text: label }));
    root.append(h("div", { class: "tiles" },
      tile("Calls", String(t.calls), "k-calls"), tile("Approved docs", String(t.approved), "k-approved"),
      tile("Cost per approved doc", usd(t.costPerApprovedUsd), "k-cpd"), tile("Rejection rate", pct(t.rejectionRate), "k-rej"),
      tile("Regenerations", String(t.regenerations), "k-regen"), tile("Tokens out", compact(t.tokensOut), "k-tok")));

    // budget meter: severity carries an icon and a label, never colour alone
    const b = sm.budget;
    if (b.capUsd !== null) {
      const ratio = Math.min(1, b.capUsd > 0 ? b.spentUsd / b.capUsd : 0);
      const text = { ok: ["✓", "Within budget"], near: ["⚠", "Near the budget"], exceeded: ["✕", "Over budget"] }[b.state];
      root.append(h("section", { class: "card", id: "budget" }, h("h2", { text: "Budget" }),
        h("div", { class: "meter " + b.state, role: "meter", "aria-valuemin": "0", "aria-valuemax": String(b.capUsd), "aria-valuenow": String(b.spentUsd), "aria-label": "Spend against the budget cap" }, h("i", { style: { width: (ratio * 100).toFixed(1) + "%" } })),
        h("div", { class: "meter-label" }, h("span", { "aria-hidden": "true", text: text[0] }), h("strong", { text: text[1] }), h("span", { class: "muted", text: `${usd(b.spentUsd)} of ${usd(b.capUsd)}; ${usd(b.remainingUsd)} left. The cap stops the server's own generation before it goes over; it cannot stop an agent that writes docs by itself.` }))));
    }

    // the metric filter scopes every chart below it
    root.append(h("div", { id: "toolbar", role: "group", "aria-label": "Measure" }, h("span", { class: "muted", text: "Show" }),
      h("div", { class: "seg" }, Object.entries(METRICS).map(([k, v]) => h("button", { type: "button", "data-metric": k, "aria-pressed": String(metric === k), text: v.label, onclick: () => { metric = k; render(); } }))),
      metric === "cost" && !sm.complete ? h("span", { class: "muted", text: "Unpriced calls count as $0 here." }) : null));

    const days = metricRows(sm.byDay, (d) => d.day, (d) => shortDay(d.day));
    root.append(h("section", { class: "card", id: "by-day" }, h("h2", { text: m.label + " by day" }), h("p", { class: "sub", text: "UTC days." }), columns(days, m.fmt, m.label + " by day"),
      tableView("by day", [{ head: "Day", cell: (r) => r.label }, { head: m.label, num: true, cell: (r) => m.fmt(r.value) }], days)));

    const models = metricRows(sm.byModel, (x) => x.model).sort((a, b) => b.value - a.value);
    root.append(h("section", { class: "card", id: "by-model" }, h("h2", { text: m.label + " by model" }), h("p", { class: "sub", text: "Which model is spending, and whose docs get approved." }), rankedBars(models, m.fmt),
      table([
        { head: "Model", cell: (x) => x.model },
        { head: "Calls", num: true, cell: (x) => String(x.calls) },
        { head: "Approved", num: true, cell: (x) => String(x.approved) },
        { head: "Rejected", num: true, cell: (x) => String(x.rejected) },
        { head: "Tokens out", num: true, cell: (x) => compact(x.tokensOut) },
        { head: "Cost", num: true, cell: (x) => usd(x.costUsd) + (x.priced ? "" : "+"), cls: (x) => (x.priced ? "" : "flag") },
        { head: "Estimated tokens", num: true, cell: (x) => pct(x.estimatedShare) },
      ], sm.byModel)));

    const mods = metricRows(sm.byModule, (x) => x.module).sort((a, b) => b.value - a.value).slice(0, 10);
    root.append(h("section", { class: "card", id: "by-module" }, h("h2", { text: m.label + " by module" }), h("p", { class: "sub", text: sm.byModule.length > 10 ? "The ten largest of " + sm.byModule.length + " directories." : "Directories whose code was documented." }), rankedBars(mods, m.fmt),
      tableView("by module", [{ head: "Module", cell: (r) => r.label }, { head: m.label, num: true, cell: (r) => m.fmt(r.value) }], mods)));

    const src = sm.tokensSource;
    root.append(h("section", { class: "card", id: "exactness" }, h("h2", { text: "How exact are the token counts?" }),
      h("p", { class: "sub", text: "Exact counts come from the provider. Agents often cannot see their own usage, so most counts are reported by the agent or estimated from the text." }),
      segmented([{ label: "Provider-reported (exact)", value: src["provider-reported"], color: "--s1" }, { label: "Reported by the agent", value: src["agent-reported"], color: "--s2" }, { label: "Estimated from text", value: src.estimated, color: "--s3" }])));

    root.append(h("section", { class: "card", id: "recent" }, h("h2", { text: "Recent calls" }), h("p", { class: "sub", text: "Newest first. A tilde means the count is an estimate." }),
      table([
        { head: "When", cell: (c) => c.ts.replace("T", " ").slice(0, 16) },
        { head: "Target", cell: (c) => c.target },
        { head: "Model", cell: (c) => c.model },
        { head: "In", num: true, cell: (c) => (c.tokensIn === null ? "unknown" : compact(c.tokensIn)) },
        { head: "Out", num: true, cell: (c) => (c.tokensOut === null ? "unknown" : (c.tokensSource === "estimated" ? "~" : "") + compact(c.tokensOut)) },
        { head: "Cost", num: true, cell: (c) => usd(c.costUsd) + (c.costSource === "current-prices" ? " *" : "") },
        { head: "Outcome", cell: (c) => c.outcome, cls: (c) => (c.outcome === "approved" ? "ok" : c.outcome === "rejected" ? "bad" : "") },
      ], sm.recent),
      h("p", { class: "muted", text: "* priced now from today's price table, because no price was set when the call was made." })));
    providers(root);
  }

  // ---- what the providers report (Claude Code's logs, the Anthropic organisation) -------------------------------
  const PROVIDER_FIELD = { cost: "costUsd", tokens: "outputTokens", calls: "messages" };
  const dayCount = (n) => n + (n === 1 ? " day" : " days");

  function providerRows(list, key, axis) {
    const f = PROVIDER_FIELD[metric];
    return list.map((x) => ({ label: key(x), axis: axis ? axis(x) : "", value: x[f] === null || x[f] === undefined ? 0 : x[f] }));
  }

  function providerCard(id, title, sub, block, extra) {
    const m = METRICS[metric];
    const card = h("section", { class: "card", id }, h("h2", { text: title }), h("p", { class: "sub", text: sub }));
    if (block.state !== "ok") {
      card.append(h("div", { class: "notice " + (block.state === "error" ? "bad" : ""), role: block.state === "error" ? "alert" : "status", id: id + "-state" }, h("div", {}, h("span", { text: block.message })), extra ? extra(block) : null));
      return card;
    }
    const t = block.totals;
    if (!block.complete) {
      card.append(h("div", { class: "notice", role: "status" }, h("span", { class: "icon", "aria-hidden": "true", text: "⚠" }), h("div", {}, h("strong", { text: "The cost is a lower bound." }), " No price is set for: " + block.unpricedModels.join(", ") + ". ", h("button", { type: "button", class: "link", text: "Set prices", onclick: () => api.postMessage({ type: "openSettings" }) }))));
    }
    card.append(h("p", { class: "muted", id: id + "-note", text: block.message }));
    const tile = (label, value, tid) => h("div", { class: "tile" }, h("div", { class: "v", id: tid, text: value }), h("div", { class: "l", text: label }));
    card.append(h("div", { class: "tiles" },
      tile(block.complete ? "Cost" : "Known cost", usd(t.costUsd), id + "-cost"), tile("Messages", t.messages ? String(t.messages) : "n/a", id + "-messages"),
      tile("Tokens out", compact(t.outputTokens), id + "-out"), tile("Tokens in (uncached)", compact(t.inputTokens), id + "-in"),
      tile("Cache reads", compact(t.cacheReadTokens), id + "-read"), tile("Cache writes", compact(t.cacheWriteTokens), id + "-write")));
    const days = providerRows(block.byDay, (d) => d.day, (d) => shortDay(d.day));
    card.append(h("h3", { text: m.label + " by day" }), columns(days, m.fmt, m.label + " by day, " + title),
      tableView("by day, " + title, [{ head: "Day", cell: (r) => r.label }, { head: m.label, num: true, cell: (r) => m.fmt(r.value) }], days));
    const models = providerRows(block.byModel, (x) => x.model).sort((a, b) => b.value - a.value);
    card.append(h("h3", { text: m.label + " by model" }), rankedBars(models, m.fmt),
      table([
        { head: "Model", cell: (x) => x.model },
        { head: "Messages", num: true, cell: (x) => (x.messages ? String(x.messages) : "n/a") },
        { head: "In", num: true, cell: (x) => compact(x.inputTokens) },
        { head: "Cache read", num: true, cell: (x) => compact(x.cacheReadTokens) },
        { head: "Cache write", num: true, cell: (x) => compact(x.cacheWriteTokens) },
        { head: "Out", num: true, cell: (x) => compact(x.outputTokens) },
        { head: "Cost", num: true, cell: (x) => usd(x.costUsd), cls: (x) => (x.costUsd === null ? "flag" : "") },
      ], block.byModel, title + " by model"));
    return card;
  }

  function providers(root) {
    root.append(h("section", { id: "providers" }, h("h2", { text: "What your providers report" }),
      h("p", { class: "sub", text: "Separate from the cost above, and never added to it: this is what the tools themselves used, which is more than the brain's own calls." })));
    const box = $("providers");
    if (usageError) { box.append(h("div", { class: "notice", role: "alert", id: "usage-error", text: usageError })); return; }
    if (!usage) { box.append(h("p", { class: "muted", id: "usage-loading", text: "Reading provider usage…" })); return; }
    const cc = usage.claudeCode, org = usage.anthropicOrg;
    box.append(providerCard("claude-code", "Claude Code in this workspace",
      `Last ${dayCount(usage.lookbackDays)}, from Claude Code's own logs on this machine` + (cc.source ? ` (${cc.source})` : "") + ". Only this repository.", cc,
      (b) => (b.state === "off" ? h("button", { type: "button", class: "link", text: "Turn on in settings", onclick: () => api.postMessage({ type: "openUsageSettings" }) }) : null)));
    box.append(providerCard("anthropic-org", "Anthropic organisation",
      `Last ${dayCount(usage.lookbackDays)}, from Anthropic's Usage and Cost API. The whole organisation behind the key, not just this repository.`, org,
      (b) => (b.state === "off" ? h("button", { type: "button", class: "primary", text: "Set Admin key", onclick: () => api.postMessage({ type: "setAnthropicKey" }) }) : null)));
    box.append(h("p", { class: "muted", text: "Copilot and Cursor are not shown: Copilot reports premium requests rather than tokens, and Cursor's usage API is for team admins only." }));
  }

  /** If the cost summary could not be loaded (no server), the provider sections still stand on their own. */
  function showUsageOnly() { const root = $("root"); root.textContent = ""; providers(root); }

  $("refresh").addEventListener("click", () => api.postMessage({ type: "refresh" }));
  $("export").addEventListener("click", () => api.postMessage({ type: "export" }));
  $("settings").addEventListener("click", () => api.postMessage({ type: "openSettings" }));
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "cost") { summary = msg.summary; $("error").hidden = true; $("stamp").textContent = "Updated " + new Date(summary.generatedAt).toLocaleTimeString(); render(); }
    else if (msg.type === "usage") { usage = msg.usage; usageError = null; if (summary) render(); else showUsageOnly(); }
    else if (msg.type === "usageError") { usageError = msg.message; if (summary) render(); else showUsageOnly(); }
    else if (msg.type === "error") { $("error").hidden = false; $("error").textContent = msg.message; }
  });

  window.brainCost = { compact, usd, pct, niceTicks }; // for tests
  if (typeof module !== "undefined" && module.exports) module.exports = { compact, usd, pct, niceTicks };
  api.postMessage({ type: "ready" });
})();
