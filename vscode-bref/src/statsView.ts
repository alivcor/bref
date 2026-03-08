import * as vscode from "vscode";

export interface SessionStats {
  totalTokensSaved: number;
  totalCompressions: number;
  history: Array<{
    timestamp: number;
    tokensSaved: number;
    ratio: number;
  }>;
}

export class StatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "bref.statsView";
  private _view?: vscode.WebviewView;
  private _stats: SessionStats = {
    totalTokensSaved: 0,
    totalCompressions: 0,
    history: [],
  };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this._updateHtml();
  }

  recordCompression(tokensSaved: number, ratio: number): void {
    this._stats.totalTokensSaved += tokensSaved;
    this._stats.totalCompressions += 1;
    this._stats.history.push({
      timestamp: Date.now(),
      tokensSaved,
      ratio,
    });
    this._updateHtml();
  }

  get stats(): SessionStats {
    return this._stats;
  }

  private _updateHtml(): void {
    if (!this._view) {
      return;
    }

    const avgRatio =
      this._stats.history.length > 0
        ? (
            this._stats.history.reduce((s, h) => s + h.ratio, 0) /
            this._stats.history.length
          ).toFixed(2)
        : "N/A";

    this._view.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    .stat { margin-bottom: 12px; }
    .label { font-size: 11px; opacity: 0.7; }
    .value { font-size: 20px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  </style>
</head>
<body>
  <div class="stat">
    <div class="label">Tokens saved (session)</div>
    <div class="value">${this._stats.totalTokensSaved.toLocaleString()}</div>
  </div>
  <div class="stat">
    <div class="label">Compressions run</div>
    <div class="value">${this._stats.totalCompressions}</div>
  </div>
  <div class="stat">
    <div class="label">Avg compression ratio</div>
    <div class="value">${avgRatio}</div>
  </div>
  ${
    this._stats.history.length > 0
      ? `<table>
    <tr><th>Time</th><th>Saved</th><th>Ratio</th></tr>
    ${this._stats.history
      .slice(-10)
      .reverse()
      .map(
        (h) =>
          `<tr><td>${new Date(h.timestamp).toLocaleTimeString()}</td><td>${h.tokensSaved}</td><td>${h.ratio.toFixed(2)}</td></tr>`
      )
      .join("")}
  </table>`
      : ""
  }
</body>
</html>`;
  }
}
