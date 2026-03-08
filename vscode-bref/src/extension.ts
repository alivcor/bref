import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compress } from "./bridge";
import { StatsViewProvider } from "./statsView";
import { ensureBrefSetup } from "./setup";

const ACTIVITY_LOG = path.join(os.homedir(), ".bref", "activity.log");

let statusBarItem: vscode.StatusBarItem;
let statsProvider: StatsViewProvider;
let sessionTokensSaved = 0;
const processedLogEntries = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  statsProvider = new StatsViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      StatsViewProvider.viewType,
      statsProvider
    )
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "bref.showStats";
  statusBarItem.text = "$(zap) Bref: 0 saved";
  statusBarItem.tooltip = "Tokens saved this session";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bref.compressSelection",
      compressSelection
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bref.showStats", () => {
      const s = statsProvider.stats;
      vscode.window.showInformationMessage(
        `Bref: ${s.totalTokensSaved} tokens saved across ${s.totalCompressions} compressions`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bref.recordPrompt", recordPromptCompression)
  );

  // Watch for prompt activity signals
  watchPromptActivity(context);

  // Bootstrap hook, steering, and ~/.bref if missing
  const created = ensureBrefSetup();
  if (created.length > 0) {
    statsProvider.addLog(`Setup: created ${created.join(", ")}`, "info");
  }

  statsProvider.addLog("Bref extension activated", "info");
}

/**
 * Called via command when the bref hook fires on a prompt.
 * Accepts optional text to measure compression against.
 * Also touches the activity log so the poll loop picks up the event
 * without needing a separate runCommand hook.
 */
async function recordPromptCompression(text?: string): Promise<void> {
  touchActivityLog();

  if (text && text.length > 0) {
    // Write prompt text so the poll loop can measure real compression
    try {
      const contextFile = path.join(path.dirname(ACTIVITY_LOG), "last_prompt.txt");
      fs.writeFileSync(contextFile, text, "utf-8");
    } catch {
      // non-critical
    }
    try {
      const result = await compress(text);
      sessionTokensSaved += result.tokens_saved;
      statusBarItem.text = `$(zap) Bref: ${sessionTokensSaved} saved`;
      statsProvider.recordPromptActivity(
        result.tokens_original,
        result.tokens_compressed
      );
    } catch {
      statsProvider.addLog("Prompt compression measurement failed", "info");
    }
  } else {
    statsProvider.recordSteeringActive();
  }
}

/**
 * Touches ~/.bref/activity.log via Node fs so the extension poll
 * detects prompt activity. Replaces the old runCommand hook that
 * was prompting users for shell approval on every message.
 */
function touchActivityLog(): void {
  try {
    const dir = path.dirname(ACTIVITY_LOG);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const now = new Date();
    if (fs.existsSync(ACTIVITY_LOG)) {
      fs.utimesSync(ACTIVITY_LOG, now, now);
    } else {
      fs.writeFileSync(ACTIVITY_LOG, "", "utf-8");
    }
  } catch {
    // non-critical, stats just won't update this cycle
  }
}

/**
 * Polls ~/.bref/activity.log for mtime changes to trigger stats
 * updates. Also watches steering and hook files.
 */
function watchPromptActivity(context: vscode.ExtensionContext): void {
  let lastMtime = 0;
  try {
    const dir = path.dirname(ACTIVITY_LOG);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(ACTIVITY_LOG)) {
      lastMtime = fs.statSync(ACTIVITY_LOG).mtimeMs;
    }
  } catch {
    // will start from zero
  }

  const activityPoll = setInterval(() => {
    try {
      if (!fs.existsSync(ACTIVITY_LOG)) {
        return;
      }
      const mtime = fs.statSync(ACTIVITY_LOG).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        const logContent = fs.readFileSync(ACTIVITY_LOG, "utf-8").trim();
        const entries = logContent.split("\n").filter(Boolean);
        const newEntries = entries.filter(
          (e) => !processedLogEntries.has(e)
        );
        if (newEntries.length > 0) {
          for (const entry of newEntries) {
            processedLogEntries.add(entry);
          }
          // Read the most recent prompt context if available
          const contextFile = path.join(path.dirname(ACTIVITY_LOG), "last_prompt.txt");
          if (fs.existsSync(contextFile)) {
            try {
              const promptText = fs.readFileSync(contextFile, "utf-8");
              if (promptText.trim().length > 0) {
                compress(promptText).then((result) => {
                  sessionTokensSaved += result.tokens_saved;
                  statsProvider.recordPromptActivity(
                    result.tokens_original,
                    result.tokens_compressed
                  );
                  updateStatusBar();
                }).catch(() => {
                  statsProvider.recordSteeringActive();
                  updateStatusBar();
                });
                return;
              }
            } catch {
              // fall through to estimate
            }
          }
          statsProvider.recordSteeringActive();
          sessionTokensSaved = statsProvider.stats.totalTokensSaved;
          updateStatusBar();
        }
      }
    } catch {
      // file might not exist yet
    }
  }, 2000);

  context.subscriptions.push({ dispose: () => clearInterval(activityPoll) });

  // Watch workspace steering and hook files
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return;
  }

  for (const folder of workspaceFolders) {
    const steeringPattern = new vscode.RelativePattern(
      folder,
      ".kiro/steering/bref.md"
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      steeringPattern,
      false,
      false,
      false
    );

    watcher.onDidChange(() => {
      statsProvider.addLog("Steering file updated", "steering");
      updateStatusBar();
    });

    context.subscriptions.push(watcher);
  }

  for (const folder of workspaceFolders) {
    const hookPattern = new vscode.RelativePattern(
      folder,
      ".kiro/hooks/bref-*.kiro.hook"
    );

    const hookWatcher = vscode.workspace.createFileSystemWatcher(
      hookPattern,
      false,
      false,
      false
    );

    hookWatcher.onDidChange(() => {
      statsProvider.addLog("Bref hook configuration updated", "info");
    });

    context.subscriptions.push(hookWatcher);
  }
}

function updateStatusBar(): void {
  const s = statsProvider.stats;
  sessionTokensSaved = s.totalTokensSaved;
  statusBarItem.text = `$(zap) Bref: ${sessionTokensSaved} saved`;
}

async function compressSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor");
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage("Select text to compress");
    return;
  }

  const text = editor.document.getText(selection);

  try {
    const result = await compress(text);

    await editor.edit((editBuilder) => {
      editBuilder.replace(selection, result.compressed);
    });

    sessionTokensSaved += result.tokens_saved;
    statusBarItem.text = `$(zap) Bref: ${sessionTokensSaved} saved`;

    const ratio = result.tokens_original > 0
      ? result.tokens_compressed / result.tokens_original
      : 1;
    statsProvider.recordCompression(
      result.tokens_saved,
      ratio,
      result.tokens_original,
      result.tokens_compressed
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Bref compression failed: ${msg}`);
  }
}

export function deactivate(): void {
  // nothing to clean up
}
