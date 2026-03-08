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

export interface LogEntry {
  timestamp: number;
  message: string;
  type: "compression" | "prompt" | "info" | "steering";
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
  private _activityLog: LogEntry[] = [];
  private _pollTimer?: NodeJS.Timeout;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._pollTimer = setInterval(() => this._refreshFromDisk(), 5000);
    this._refreshFromDisk();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this._refreshFromDisk();
    this._updateHtml();
  }

  addLog(message: string, type: LogEntry["type"] = "info"): void {
    this._activityLog.push({ timestamp: Date.now(), message, type });
    if (this._activityLog.length > 50) {
      this._activityLog = this._activityLog.slice(-50);
    }
    this._updateHtml();
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
    this.addLog(
      `Compressed ${tokensOriginal} -> ${tokensCompressed} tokens (${tokensSaved} saved)`,
      "compression"
    );
  }

  recordPromptActivity(promptTokens: number, compressedTokens: number): void {
    const saved = promptTokens - compressedTokens;
    const ratio = promptTokens > 0 ? compressedTokens / promptTokens : 1;
    this._sessionStats.totalTokensSaved += saved;
    this._sessionStats.totalCompressions += 1;
    this._sessionStats.totalTokensOriginal += promptTokens;
    this._sessionStats.totalTokensCompressed += compressedTokens;
    this._sessionStats.history.push({
      timestamp: Date.now(),
      tokensSaved: saved,
      ratio,
    });
    this._persistToDisk();
    this.addLog(
      `Prompt compressed: ${promptTokens} -> ${compressedTokens} tokens (${saved} saved, ${(ratio * 100).toFixed(0)}%)`,
      "prompt"
    );
  }

  recordSteeringActive(): void {
    this.addLog("Bref steering active on prompt", "steering");
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
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
  }

  private _refreshFromDisk(): void {
    try {
      if (!fs.existsSync(STATS_FILE)) {
        this._updateHtml();
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

  private _formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  private _typeIcon(type: LogEntry["type"]): string {
    switch (type) {
      case "compression": return "&#9889;";
      case "prompt": return "&#9998;";
      case "steering": return "&#9881;";
      default: return "&#8226;";
    }
  }

  private _typeColor(type: LogEntry["type"]): string {
    switch (type) {
      case "compression": return "var(--vscode-charts-green)";
      case "prompt": return "var(--vscode-charts-blue)";
      case "steering": return "var(--vscode-charts-yellow)";
      default: return "var(--vscode-foreground)";
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

    const recentLogs = this._activityLog.slice(-20).reverse();
    const logRows = recentLogs.length > 0
      ? recentLogs
          .map(
            (l) =>
              `<div class="log-entry">
                <span class="log-icon" style="color:${this._typeColor(l.type)}">${this._typeIcon(l.type)}</span>
                <span class="log-time">${this._formatTime(l.timestamp)}</span>
                <span class="log-msg">${this._escapeHtml(l.message)}</span>
              </div>`
          )
          .join("")
      : `<div class="log-empty">No activity yet. Start vibe coding and stats will appear here.</div>`;

    this._view.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 12px;
      color: var(--vscode-foreground);
      margin: 0;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat {
      padding: 8px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
    }
    .stat.wide { grid-column: span 2; }
    .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      margin-bottom: 2px;
    }
    .value {
      font-size: 20px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .sub {
      font-size: 10px;
      opacity: 0.4;
      margin-top: 1px;
    }
    .section-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      opacity: 0.5;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .log-entry {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 3px 0;
      font-size: 11px;
      line-height: 1.4;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 30%, transparent);
    }
    .log-entry:last-child { border-bottom: none; }
    .log-icon { flex-shrink: 0; font-size: 10px; }
    .log-time {
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.4;
      font-variant-numeric: tabular-nums;
    }
    .log-msg { opacity: 0.8; word-break: break-word; }
    .log-empty {
      font-size: 11px;
      opacity: 0.4;
      padding: 12px 0;
      text-align: center;
    }
    .log-container {
      max-height: 300px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div class="stats-grid">
    <div class="stat">
      <div class="label">Tokens saved</div>
      <div class="value">${s.totalTokensSaved.toLocaleString()}</div>
      <div class="sub">${savedPct}% reduction</div>
    </div>
    <div class="stat">
      <div class="label">Compressions</div>
      <div class="value">${s.totalCompressions}</div>
    </div>
    <div class="stat">
      <div class="label">Avg ratio</div>
      <div class="value">${avgRatio}</div>
    </div>
    <div class="stat">
      <div class="label">Tokens processed</div>
      <div class="value">${s.totalTokensOriginal.toLocaleString()}</div>
    </div>
  </div>
  <div class="section-title">Activity log</div>
  <div class="log-container">${logRows}</div>
</body>
</html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
