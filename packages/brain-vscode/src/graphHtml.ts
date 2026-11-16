import { pageHtml } from "./pageHtml";

export interface GraphHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}

const BODY = `<div id="app">
  <header id="bar">
    <div class="seg" role="group" aria-label="Level">
      <button id="lvl-module" type="button" aria-pressed="true">Modules</button>
      <button id="lvl-file" type="button" aria-pressed="false">Files</button>
    </div>
    <span id="focus-chip" class="chip" hidden></span>
    <label id="depth-label" hidden>Depth
      <select id="depth"><option>0</option><option selected>1</option><option>2</option><option>3</option></select>
    </label>
    <input id="filter" type="search" placeholder="Filter by name" aria-label="Filter nodes by name">
    <button id="fit" type="button">Fit</button>
    <button id="refresh" type="button">Refresh</button>
    <span id="count" aria-live="polite"></span>
  </header>
  <div id="notice" class="notice" hidden></div>
  <div id="error" class="notice bad" role="alert" hidden></div>
  <main>
    <div id="canvas">
      <svg id="svg" role="group" aria-label="Dependency graph. Nodes are listed in the side panel."></svg>
      <div id="empty" hidden></div>
    </div>
    <aside id="side" aria-label="Details">
      <section id="details"></section>
      <section id="health"></section>
      <section id="legend"></section>
      <section id="list"></section>
    </aside>
  </main>
</div>`;

export function graphHtml(o: GraphHtmlOptions): string {
  return pageHtml({ ...o, title: "App Brain dependency graph", body: BODY });
}
