import { pageHtml } from "./pageHtml";

export interface CostHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}

const BODY = `<main>
  <h1>Cost &amp; models</h1>
  <p class="sub">What generating documentation has cost, by model, day and module. <span id="stamp"></span></p>
  <div id="actions">
    <button id="refresh" type="button">Refresh</button>
    <button id="export" type="button" class="primary">Export report (CSV and Markdown)</button>
    <button id="settings" type="button">Model prices and budget…</button>
  </div>
  <div id="error" class="notice" role="alert" hidden></div>
  <div id="root"><p>Loading…</p></div>
</main>
<div id="tip" role="tooltip" hidden></div>`;

export function costHtml(o: CostHtmlOptions): string {
  return pageHtml({ ...o, title: "App Brain cost and models", body: BODY });
}
