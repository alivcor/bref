import { execFile } from "child_process";
import * as vscode from "vscode";

export interface CompressResult {
  original: string;
  compressed: string;
  tokens_original: number;
  tokens_compressed: number;
  tokens_saved: number;
}

function getPythonPath(): string {
  return vscode.workspace
    .getConfiguration("bref")
    .get<string>("pythonPath", "python3");
}

function getRatio(): number {
  return vscode.workspace
    .getConfiguration("bref")
    .get<number>("compressionRatio", 0.5);
}

export function compress(text: string): Promise<CompressResult> {
  const pythonPath = getPythonPath();
  const ratio = getRatio();

  const script = `
import json, sys
from bref.compression import compress, count_tokens

text = sys.stdin.read()
ratio = ${ratio}
compressed = compress(text, ratio=ratio)
orig_tokens = count_tokens(text)
comp_tokens = count_tokens(compressed)
json.dump({
    "original": text,
    "compressed": compressed,
    "tokens_original": orig_tokens,
    "tokens_compressed": comp_tokens,
    "tokens_saved": orig_tokens - comp_tokens,
}, sys.stdout)
`;

  return new Promise((resolve, reject) => {
    const proc = execFile(
      pythonPath,
      ["-c", script],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse bref output: ${stdout}`));
        }
      }
    );
    if (proc.stdin) {
      proc.stdin.write(text);
      proc.stdin.end();
    }
  });
}
