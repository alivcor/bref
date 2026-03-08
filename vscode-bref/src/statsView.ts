import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const STATS_FILE = path.join(os.homedir(), ".bref", "stats.json");

export interface SessionStats {
  totalTokensSaved: number;
  totalCompressions: number;
  totalTokensOriginal: number;
  totalTokensCompressed: number;
  history: Array<{
    timestamp: number;
    tokensSaved: number;
    ratio: number;
  }>;
}

interface PersistentStats {
  total_tokens_saved: number;
  total_compressions: number;
  total_tokens_original: number;
  total_tokens_compressed: number;
  history: Array<{
    tokens_saved: number;
    effective_ratio: number;
    sentences_dropped: number;
    ngram_dedup_count: number;
  }>;
}

export class StatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "bref.statsView";
  private _view?: vscode.WebviewView;
  private _sessionStats: SessionStats = {
    totalTokensSaved: 0,
    totalCompressions: 0,
    totalTokensOriginal: 0,
    totalTokensCompressed: 0,
    history: [],
  };
  private _watcher?: vscode.FileSystemWatcher;
  private _pollTimer?: NodeJS.Timeout;

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Poll the stats file every 5 seconds for updates from the Python side
    this._pollTimer = setInterval(() => this._refreshFromDisk(), 5000);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this._refreshFromDisk();
  }

  recordCompression(
    tokensSaved: number,
    ratio: number,
    tokensOriginal: number = 0,
    tokensCompressed: number = 0
  ): void {
    this._sessionStats.totalTokensSaved += tokensSaved;
    this._sessionStats.totalCompressions += 1;
    this._sessionStats.totalTokensOriginal += tokensOriginal;
    this._sessionStats.totalTokensCompressed += tokensCompressed;
    this._sessionStats.history.push({
      timestamp: Date.now(),
      tokensSaved,
      ratio,
    });
    this._persistToDisk();
    this._updateHtml();
  }

  private _persistToDisk(): void {
    try {
      const dir = path.dirname(STATS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const s = this._sessionStats;
      const persistent: PersistentStats = {
        total_tokens_saved: s.totalTokensSaved,
        total_compressions: s.totalCompressions,
        total_tokens_original: s.totalTokensOriginal,
        total_tokens_compressed: s.totalTokensCompressed,
        history: s.history.slice(-100).map((h) => ({
          tokens_saved: h.tokensSaved,
          effective_ratio: h.ratio,
          sentences_dropped: 0,
          ngram_dedup_count: 0,
        })),
      };
      fs.writeFileSync(STATS_FILE, JSON.stringify(persistent, null, 2));
    } catch {
      // best-effort
    }
  }

  get stats(): SessionStats {
    return this._sessionStats;
  }

  dispose(): void {
    if (this._watcher) {
      this._watcher.dispose();
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
  }

  private _refreshFromDisk(): void {
    try {
      if (!fs.existsSync(STATS_FILE)) {
        return;
      }
      const raw = fs.readFileSync(STATS_FILE, "utf-8");
      const persistent: PersistentStats = JSON.parse(raw);

      this._sessionStats.totalTokensSaved = persistent.total_tokens_saved;
      this._sessionStats.totalCompressions = persistent.total_compressions;
      this._sessionStats.totalTokensOriginal = persistent.total_tokens_original;
      this._sessionStats.totalTokensCompressed = persistent.total_tokens_compressed;

      this._updateHtml();
    } catch {
      // stats file might be mid-write, ignore
    }
  }

  private _updateHtml(): void {
    if (!this._view) {
      return;
    }

    const s = this._sessionStats;
    const avgRatio =
      s.totalTokensOriginal > 0
        ? (s.totalTokensCompressed / s.totalTokensOriginal).toFixed(2)
        : "N/A";

    const savedPct =
      s.totalTokensOriginal > 0
        ? ((s.totalTokensSaved / s.totalTokensOriginal) * 100).toFixed(1)
        : "0";

    this._view.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    .stat { margin-bottom: 12px; }
    .label { font-size: 11px; opacity: 0.7; }
    .value { font-size: 20px; font-weight: 600; }
    .sub { font-size: 11px; opacity: 0.5; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  </style>
</head>
<body>
  <div class="stat">
    <div class="label">Tokens saved (all time)</div>
    <div class="value">${s.totalTokensSaved.toLocaleString()}</div>
    <div class="sub">${savedPct}% reduction</div>
  </div>
  <div class="stat">
    <div class="label">Compressions run</div>
    <div class="value">${s.totalCompressions}</div>
  </div>
  <div class="stat">
    <div class="label">Avg compression ratio</div>
    <div class="value">${avgRatio}</div>
  </div>
  <div class="stat">
    <div class="label">Tokens processed</div>
    <div class="value">${s.totalTokensOriginal.toLocaleString()}</div>
  </div>
</body>
</html>`;
  }
}
