/**
 * Bridge between the VS Code extension and the compression engine.
 *
 * Previously shelled out to Python. Now uses the native TypeScript
 * compression engine directly -- no external dependencies needed.
 */

import { compress as nativeCompress, type CompressResult } from "./compression";
import * as vscode from "vscode";

export type { CompressResult };

function getRatio(): number {
  return vscode.workspace
    .getConfiguration("bref")
    .get<number>("compressionRatio", 0.5);
}

export function compress(text: string): Promise<CompressResult> {
  const ratio = getRatio();
  return Promise.resolve(nativeCompress(text, ratio));
}
