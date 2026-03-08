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
 */
async function recordPromptCompression(text?: string): Promise<void> {
  if (text && text.length > 0) {
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
 * Watches the activity log file that the bref-stats-track hook touches
 * on every prompt submission. Detects mtime changes to trigger stats
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
        statsProvider.recordSteeringActive();
        sessionTokensSaved = statsProvider.stats.totalTokensSaved;
        updateStatusBar();
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
