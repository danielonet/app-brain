/**
 * HTML shell for the settings webview. Pure (no `vscode` import) so it can be tested in a
 * real browser. The CSP allows only the one nonce'd script and the extension's own stylesheet.
 */
export interface SettingsHtmlOptions {
  nonce: string;
  /** `webview.cspSource` in VS Code. */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}

export function settingsHtml(o: SettingsHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource}`,
    `script-src 'nonce-${o.nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>App Brain settings</title>
<link rel="stylesheet" href="${o.styleUri}">
</head>
<body>
<div id="root"><p>Loading…</p></div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
