/* App Brain settings form. Renders any object JSON Schema the server returns, so a new server
 * option shows up without an extension release. No innerHTML anywhere: all text goes through
 * textContent / value, so config content can never become markup. */
(function () {
  "use strict";

  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };

  const LABELS = {
    outputDir: "Output folder", include: "Include globs", exclude: "Exclude globs", languages: "Languages",
    docs: "Documentation", granularity: "Granularity", autoGenerate: "Generate automatically",
    maxCostUsd: "Budget cap (USD)", commitKnowledge: "Commit the knowledge bundle", pricing: "Model prices",
    inputPerMtok: "Input", outputPerMtok: "Output", cachedPerMtok: "Cached input",
  };
  const humanize = (key) => LABELS[key] || String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const same = (a, b) => a.length === b.length && a.every((x, i) => String(x) === String(b[i]));

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid) node.append(kid);
    return node;
  }

  const isNullable = (s) => Array.isArray(s.anyOf) && s.anyOf.some((x) => x.type === "null");
  const numberBranch = (s) => (Array.isArray(s.anyOf) ? s.anyOf.find((x) => x.type === "number" || x.type === "integer") : null);

  /** Wraps a control with a label, help text and an error slot. `bare` returns just input + error. */
  function wrap(label, schema, input, bare) {
    const err = h("div", { class: "err" });
    const box = h("div", { class: bare ? "cell" : "field" });
    if (!bare) box.append(h("label", { text: label }));
    box.append(input);
    if (!bare && schema.description) box.append(h("div", { class: "help", text: schema.description }));
    box.append(err);
    return {
      box,
      show(messages) {
        err.textContent = messages.join(" ");
        box.classList.toggle("has-error", messages.length > 0);
        return messages.length;
      },
    };
  }

  function leaf(schema, label, opts, makeInput, read, write) {
    const input = makeInput();
    input.addEventListener("input", opts.changed);
    input.addEventListener("change", opts.changed);
    const w = wrap(label, schema, input, opts.bare);
    return {
      el: w.box,
      get: () => read(input),
      set(v) {
        if (opts.readonly && v === undefined) return; // "reset to defaults" must not touch read-only fields
        write(input, v === undefined ? schema.default : v);
      },
      mark(errs, prefix) {
        return w.show(errs.filter((e) => same(e.pathParts, prefix)).map((e) => e.message));
      },
    };
  }

  function build(schema, key, opts) {
    const label = humanize(key);
    const nb = numberBranch(schema);

    if (schema.type === "object" && schema.properties) return buildObject(schema, label, opts);
    if (schema.type === "object" && schema.additionalProperties) return buildRecord(schema, label, opts);

    if (schema.type === "array") {
      return leaf(
        { ...schema, description: (schema.description || "") + " One per line." }, label, opts,
        () => h("textarea", { rows: 3, spellcheck: "false" }),
        (i) => i.value.split("\n").map((l) => l.trim()).filter(Boolean),
        (i, v) => { i.value = (v || []).join("\n"); },
      );
    }
    if (schema.enum) {
      return leaf(schema, label, opts,
        () => h("select", {}, schema.enum.map((o) => h("option", { value: o, text: o }))),
        (i) => i.value, (i, v) => { i.value = v; });
    }
    if (schema.type === "boolean") {
      const c = leaf(schema, label, { ...opts, bare: true }, () => h("input", { type: "checkbox" }), (i) => i.checked, (i, v) => { i.checked = Boolean(v); });
      const input = c.el.querySelector("input");
      const field = h("div", { class: "field" },
        h("label", { class: "check" }, input, document.createTextNode(label)),
        schema.description ? h("div", { class: "help", text: schema.description }) : null,
        c.el.querySelector(".err"));
      return { ...c, el: field, mark: (errs, prefix) => { const m = errs.filter((e) => same(e.pathParts, prefix)); field.classList.toggle("has-error", m.length > 0); field.querySelector(".err").textContent = m.map((e) => e.message).join(" "); return m.length; } };
    }
    if (schema.type === "number" || schema.type === "integer" || nb) {
      const nullable = isNullable(schema);
      const spec = nb || schema;
      return leaf(
        schema, label, opts,
        () => h("input", { type: "number", step: schema.type === "integer" ? "1" : "any", min: spec.minimum !== undefined ? String(spec.minimum) : null, placeholder: nullable ? "No limit" : null }),
        (i) => (i.value.trim() === "" ? (nullable ? null : undefined) : Number(i.value)),
        (i, v) => { i.value = v === null || v === undefined ? "" : String(v); },
      );
    }
    // string
    const readonly = Boolean(opts.readonly);
    return leaf(schema, label, opts,
      () => h("input", { type: "text", spellcheck: "false", disabled: readonly, placeholder: schema.default ? String(schema.default) : null }),
      (i) => i.value, (i, v) => { i.value = v === undefined ? "" : v; });
  }

  function buildObject(schema, label, opts) {
    const kids = Object.entries(schema.properties).map(([k, sub]) => [k, build(sub, k, { ...opts, top: false, bare: false, readonlyKeys: undefined, readonly: Boolean(opts.readonlyKeys && opts.readonlyKeys.includes(k)) })]);
    const box = h("fieldset", { class: opts.top ? "top" : null }, opts.top ? null : h("legend", { text: label }), schema.description && !opts.top ? h("div", { class: "help", text: schema.description }) : null, kids.map(([, c]) => c.el));
    return {
      el: box,
      get() {
        const out = {};
        for (const [k, c] of kids) { const v = c.get(); if (v !== undefined) out[k] = v; }
        return out;
      },
      set(v) { for (const [k, c] of kids) c.set(v ? v[k] : undefined); },
      mark(errs, prefix) { return kids.reduce((n, [k, c]) => n + c.mark(errs, [...prefix, k]), 0); },
    };
  }

  /** `{ [modelId]: { ...fields } }` as an editable table. */
  function buildRecord(schema, label, opts) {
    const valueSchema = schema.additionalProperties;
    const cols = Object.entries(valueSchema.properties || {});
    const body = h("tbody");
    const rows = [];
    const addBtn = h("button", { type: "button", class: "secondary", text: "Add model", onclick: () => { addRow("", {}); opts.changed(); } });

    function addRow(key, value) {
      const keyInput = h("input", { type: "text", placeholder: "model id, e.g. my-model", spellcheck: "false" });
      keyInput.value = key;
      keyInput.addEventListener("input", opts.changed);
      const cells = cols.map(([k, sub]) => { const c = build(sub, k, { ...opts, top: false, bare: true, readonlyKeys: undefined, readonly: false }); c.set(value[k]); return [k, c]; });
      const keyErr = h("div", { class: "err" });
      const tr = h("tr", {}, h("td", {}, keyInput, keyErr), cells.map(([, c]) => h("td", {}, c.el)),
        h("td", { class: "x" }, h("button", { type: "button", class: "secondary", title: "Remove", "aria-label": "Remove " + (key || "row"), text: "✕", onclick: () => { tr.remove(); rows.splice(rows.indexOf(row), 1); opts.changed(); } })));
      const row = { keyInput, cells, tr, keyErr };
      rows.push(row);
      body.append(tr);
    }

    const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Model" }), cols.map(([k]) => h("th", { text: humanize(k) + " $/M" })), h("th"))), body);
    const box = h("fieldset", {}, h("legend", { text: label }), schema.description ? h("div", { class: "help", text: schema.description }) : null, table, h("div", { class: "field" }, addBtn));

    return {
      el: box,
      get() {
        const out = {};
        for (const r of rows) {
          const k = r.keyInput.value.trim();
          if (!k) continue;
          const v = {};
          for (const [ck, c] of r.cells) { const x = c.get(); if (x !== undefined) v[ck] = x; }
          out[k] = v;
        }
        return out;
      },
      set(v) {
        body.textContent = "";
        rows.length = 0;
        for (const [k, val] of Object.entries(v || {})) addRow(k, val || {});
      },
      mark(errs, prefix) {
        let n = 0;
        const seen = new Set();
        for (const r of rows) {
          const k = r.keyInput.value.trim();
          const dup = k && seen.has(k);
          seen.add(k);
          const msgs = dup ? ["Duplicate model id: the last row wins."] : [];
          r.keyErr.textContent = msgs.join(" ");
          r.keyInput.parentElement.classList.toggle("has-error", msgs.length > 0);
          n += msgs.length;
          for (const [ck, c] of r.cells) n += c.mark(errs, [...prefix, k, ck]);
        }
        return n;
      },
    };
  }

  // ---- application ---------------------------------------------------------------------------

  const root = document.getElementById("root");
  let form = null;
  let baseline = "";
  let initialised = true;
  let saving = false;
  const ui = {};

  function banner(kind, text, list) {
    ui.banner.textContent = "";
    ui.banner.className = text ? "banner " + kind : "";
    if (!text) return;
    ui.banner.append(h("div", { text }));
    if (list && list.length) ui.banner.append(h("ul", {}, list.map((m) => h("li", { text: m }))));
  }

  function dirty() { return form && JSON.stringify(form.get()) !== baseline; }

  function refreshButtons() {
    const d = dirty();
    ui.save.disabled = saving || !d || !initialised;
    ui.revert.disabled = saving || !d;
    ui.dirty.textContent = d ? "Unsaved changes" : "";
  }

  function load(msg) {
    initialised = msg.initialised;
    root.textContent = "";
    ui.banner = h("div");
    ui.notice = h("div"); // persistent: edits must not clear it, unlike the banner
    form = build(msg.schema, "", { top: true, changed, readonlyKeys: ["outputDir"], bare: false });
    ui.save = h("button", { type: "button", text: "Save", onclick: save });
    ui.revert = h("button", { type: "button", class: "secondary", text: "Revert", onclick: () => { form.set(JSON.parse(baseline)); form.mark([], []); banner(); refreshButtons(); } });
    ui.reset = h("button", { type: "button", class: "secondary", text: "Reset to defaults", onclick: () => { form.set(undefined); changed(); } });
    ui.dirty = h("span", { class: "dirty" });
    root.append(
      h("h1", { text: "App Brain settings" }),
      h("p", { class: "sub" }, document.createTextNode("Team settings, saved to "), h("code", { text: msg.configFile }), document.createTextNode(" and shared through git. Personal settings (server path, Node path) live in "), h("button", { type: "button", class: "link", text: "VS Code settings", onclick: () => api.postMessage({ type: "openPersonalSettings" }) }), document.createTextNode(".")),
      ui.notice, ui.banner, form.el,
      h("div", { class: "bar" }, ui.save, ui.revert, ui.reset, ui.dirty),
    );
    form.set(msg.config);
    baseline = JSON.stringify(form.get());
    if (!initialised) {
      ui.notice.className = "banner info";
      ui.notice.append(h("div", { text: "This workspace is not initialised, so settings cannot be saved yet. " }), h("button", { type: "button", text: "Initialise", onclick: () => api.postMessage({ type: "initialise" }) }));
    }
    refreshButtons();
  }

  function changed() { banner(); form.mark([], []); refreshButtons(); }

  function save() {
    saving = true;
    banner("info", "Saving…");
    refreshButtons();
    api.postMessage({ type: "save", config: form.get() });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") load(msg);
    else if (msg.type === "saved") {
      saving = false;
      form.set(msg.config);
      baseline = JSON.stringify(form.get());
      form.mark([], []);
      banner("ok", "Saved.");
      refreshButtons();
    } else if (msg.type === "errors") {
      saving = false;
      const errs = msg.errors || [];
      const matched = form.mark(errs, []);
      const loose = errs.filter((e) => !e.pathParts || e.pathParts.length === 0 || matched === 0).map((e) => (e.path ? e.path + ": " : "") + e.message);
      banner("error", errs.length ? `Not saved: ${errs.length} problem${errs.length === 1 ? "" : "s"} to fix.` : msg.message || "Not saved.", matched < errs.length ? loose : []);
      refreshButtons();
    }
  });

  if (typeof module !== "undefined" && module.exports) module.exports = { humanize, same };
  api.postMessage({ type: "ready" });
})();
