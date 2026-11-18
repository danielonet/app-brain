import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

describe("extension manifest", () => {
  it("draws the activity bar icon from a single-colour 24px SVG, which is all VS Code can recolour", () => {
    const icon: string = manifest.contributes.viewsContainers.activitybar[0].icon;
    assert.match(icon, /\.svg$/);
    const svg = readFileSync(path.join(root, icon), "utf8");
    assert.match(svg, /viewBox="0 0 24 24"/);
    // Fills and strokes may be "none" or one colour. VS Code recolours the whole icon, so a second colour would be lost.
    const colours = new Set([...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1].toLowerCase()).filter((c) => c !== "none"));
    assert.equal(colours.size, 1, `one colour, not ${[...colours].join(", ")}`);
    assert.doesNotMatch(svg, /<image|data:|<script|<style|gradient/i);
  });
  it("has a square PNG icon of at least 128px, with a transparent corner", () => {
    const file = path.join(root, manifest.icon);
    const png = readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert.equal(width, height, "icon must be square");
    assert.ok(width >= 128, `icon is ${width}px; the Marketplace needs at least 128`);
    assert.equal(png[25], 6, "RGBA colour type, so the rounded corners are transparent");
  });

  it("lets the review queue select many drafts, and offers bulk approval from its title bar and the palette", () => {
    const source = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    assert.match(source, /createTreeView\("brain\.review", \{[^}]*canSelectMany: true/);
    const title: { command: string }[] = manifest.contributes.menus["view/title"];
    assert.ok(title.some((m) => m.command === "brain.review.approveMany"));
    assert.ok(!manifest.contributes.menus.commandPalette.some((m: { command: string }) => m.command === "brain.review.approveMany"), "reachable from the palette");
    // right-clicking a selection (not only the inline icons) offers approve and reject
    const context: { command: string; group: string }[] = manifest.contributes.menus["view/item/context"];
    for (const c of ["brain.review.approve", "brain.review.reject"]) assert.ok(context.some((m) => m.command === c && !m.group.startsWith("inline")), c + " in the right-click menu");
  });

  it("registers exactly the commands it contributes", () => {
    const source = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    const registered = new Set([...source.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]));
    const contributed = new Set<string>(manifest.contributes.commands.map((c: { command: string }) => c.command));
    assert.deepEqual([...contributed].filter((c) => !registered.has(c)).sort(), [], "contributed but never registered");
    // `brain.initialise` etc. are registered and contributed; internal-only ids would show up here
    assert.deepEqual([...registered].filter((c) => !contributed.has(c)).sort(), [], "registered but not contributed (invisible to users)");
  });

  it("every view in a menu is declared, and every referenced command exists", () => {
    const views = new Set(Object.values(manifest.contributes.views).flat().map((v: any) => v.id));
    const commands = new Set<string>(manifest.contributes.commands.map((c: { command: string }) => c.command));
    for (const items of Object.values(manifest.contributes.menus) as any[][]) {
      for (const m of items) {
        assert.ok(commands.has(m.command), `menu references unknown command ${m.command}`);
        for (const v of String(m.when ?? "").matchAll(/view == ([\w.]+)/g)) assert.ok(views.has(v[1]), `menu references unknown view ${v[1]}`);
      }
    }
  });
});

describe("webviews respect the Content Security Policy", () => {
  it("never create inline style attributes (the CSP blocks them, so bars and layouts would silently break)", () => {
    const media = path.join(root, "media");
    for (const f of readdirSync(media).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(path.join(media, f), "utf8");
      assert.ok(!/setAttribute\(\s*["']style["']/.test(src), `${f} sets a style attribute`);
      assert.ok(!/\bstyle:\s*[`"']/.test(src), `${f} passes a style string to a helper (use an object, applied through the CSSOM)`);
      assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), `${f} writes markup`);
    }
    for (const f of readdirSync(path.join(root, "src")).filter((n) => /Html\.ts$/.test(n))) {
      const src = readFileSync(path.join(root, "src", f), "utf8");
      assert.ok(!/\sstyle\s*=/.test(src), `${f} has an inline style attribute in its markup`);
      assert.ok(!/<script(?![^>]*nonce)/.test(src.replace(/\$\{[^}]*\}/g, "")), `${f} has a script without a nonce`);
    }
  });
});
