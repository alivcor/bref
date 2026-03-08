import * as vscode from "vscode";
import { compress } from "./bridge";
import { StatsViewProvider } from "./statsView";

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
    statsProvider.recordCompression(result.tokens_saved, ratio);

    vscode.window.showInformationMessage(
      `Compressed: ${result.tokens_original} -> ${result.tokens_compressed} tokens (${result.tokens_saved} saved)`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Bref compression failed: ${msg}`);
  }
}

export function deactivate(): void {
  // nothing to clean up
}
