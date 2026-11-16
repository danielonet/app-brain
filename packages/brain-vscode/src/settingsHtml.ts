import { pageHtml } from "./pageHtml";

export interface SettingsHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}

export function settingsHtml(o: SettingsHtmlOptions): string {
  return pageHtml({ ...o, title: "App Brain settings", body: '<div id="root"><p>Loading…</p></div>' });
}
