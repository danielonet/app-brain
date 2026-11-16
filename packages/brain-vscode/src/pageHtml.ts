/**
 * Shared shell for the extension's webviews. Pure (no `vscode` import) so each page can be
 * tested in a real browser. The CSP allows only the one nonce'd script and our own stylesheet,
 * so nothing from the repository can inject script.
 */
export interface PageOptions {
  title: string;
  nonce: string;
  /** `webview.cspSource` in VS Code. */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  /** Static markup only. Never interpolate repository data into it. */
  body: string;
}

export function pageHtml(o: PageOptions): string {
  const csp = ["default-src 'none'", `style-src ${o.cspSource}`, `script-src 'nonce-${o.nonce}'`].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${o.title}</title>
<link rel="stylesheet" href="${o.styleUri}">
</head>
<body>
${o.body}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
