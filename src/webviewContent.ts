import * as vscode from 'vscode';

/** Builds a random nonce for the webview's Content-Security-Policy. */
function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Renders the HTML for the Local SLMs engine webview. The webview is where
 * WebAssembly + WebGPU inference actually happens (the extension host itself
 * is plain Node.js and has no access to either). It stays alive in the
 * background (retainContextWhenHidden) so chat requests keep working even
 * when the panel tab isn't focused.
 */
export interface WebviewConfig {
  cacheBackend: 'cache' | 'indexeddb' | 'opfs';
}

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, config: WebviewConfig): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const scriptNonce = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${scriptNonce}' 'wasm-unsafe-eval'`,
    "connect-src https: http: data: blob:",
    "img-src https: data:",
    "worker-src blob: data:",
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Local SLMs Engine</title>
</head>
<body>
  <h1>Local SLMs</h1>
  <p id="gpu-status" class="status">Checking for WebGPU&hellip;</p>
  <div id="progress-container" class="hidden">
    <div id="progress-label"></div>
    <div class="progress-track"><div id="progress-bar"></div></div>
  </div>
  <pre id="log" aria-label="Local SLMs engine log"></pre>
  <script nonce="${scriptNonce}">window.__localSlmsConfig = ${JSON.stringify(config)};</script>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
