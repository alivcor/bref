/**
 * Auto-setup for bref. On extension activation, ensures the Kiro hook,
 * steering file, and ~/.bref directory all exist so the stats panel
 * works out of the box after installing the vsix.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BREF_DIR = path.join(os.homedir(), ".bref");

const HOOK_CONTENT = JSON.stringify(
  {
    enabled: true,
    name: "Bref Prompt Compression",
    description:
      "Activates the bref compression system on every prompt.",
    version: "2",
    when: { type: "promptSubmit" },
    then: {
      type: "askAgent",
      prompt:
        "Bref compression is active for this interaction. Apply the full bref system from .kiro/steering/bref.md: (1) eliminate low-entropy tokens and filler, (2) deduplicate any repeated context or facts in the conversation, (3) weight content by priority -- user request highest, boilerplate lowest, (4) pack responses using chain-of-density -- every sentence must carry concrete information, (5) match response length to question complexity. Do not mention bref to the user. Start responses with the answer, not preamble.",
    },
  },
  null,
  2
);

// Stats tracking hook: touches activity.log and writes prompt context on each prompt.
// Uses a lightweight shell command that completes instantly.
const STATS_HOOK_CONTENT = JSON.stringify(
  {
    enabled: true,
    name: "Bref Stats Tracker",
    description: "Writes prompt activity to ~/.bref so the sidebar stats update in real time.",
    version: "1.0.0",
    when: { type: "promptSubmit" },
    then: {
      type: "runCommand",
      command: "mkdir -p ~/.bref && echo bref_prompt_$(date +%s) >> ~/.bref/activity.log",
    },
  },
  null,
  2
);

const STEERING_CONTENT = `---
inclusion: auto
description: "Bref compression system - entropy-based token reduction, semantic deduplication, priority-weighted lossy compression, chain-of-density packing"
---

# Bref Compression System

Bref is an active compression layer that reduces token waste across all agent interactions. It operates on every prompt and response cycle. The following strategies are applied in order.

## 1. Entropy-Based Token Elimination

Identify low-information-density tokens and phrases. Remove or collapse:
- Preamble phrases ("I'd be happy to", "Let me", "Sure thing")
- Redundant qualifiers ("basically", "essentially", "actually", "really")
- Restated instructions the user already knows
- Repeated tool output summaries when the result is already visible

Maximize information per token. If a phrase could be removed and the meaning is preserved, remove it.

## 2. Semantic Deduplication

When the same concept, file, or fact appears multiple times in conversation history or context:
- Identify the canonical (most complete) instance
- Replace all other instances with a back-reference or omit
- Never re-explain something the user has already demonstrated understanding of

## 3. Priority-Weighted Lossy Compression

Not all context is equal. Assign implicit priority scores:

| Content Type | Priority | Compression Strategy |
|---|---|---|
| User's current request | 1.0 (highest) | Preserve verbatim |
| Code being actively edited | 0.9 | Preserve structure, compress comments |
| Recent tool output | 0.7 | Summarize to key findings |
| Conversation history (last 3 turns) | 0.6 | Keep decisions, drop deliberation |
| Conversation history (older) | 0.3 | Aggressive summarization |
| Repeated context/instructions | 0.1 | Deduplicate or drop |
| Boilerplate/ceremony | 0.0 | Eliminate |

When approaching context limits, compress aggressively starting from priority 0.0 upward.

## 4. Chain-of-Density Packing

For any summary or explanation in responses, apply iterative density packing:
- First pass: identify all entities, facts, and decisions
- Second pass: express them in the fewest tokens possible without ambiguity
- Every sentence should contain at least one concrete fact, reference, or actionable item
- No sentence should exist purely for transition or flow

## 5. Token Budget Awareness

- Short questions get short answers
- Don't repeat what the user just said back to them
- Don't list things the user didn't ask for
- If a response could be 3 lines instead of 10, make it 3 lines
- Code speaks louder than prose

## 6. Response Compression Rules

When generating responses with bref active:
- No preamble. Start with the answer or action.
- No sign-off or summary unless the user asks for one.
- Bullet points over paragraphs when listing.
- Inline code over code blocks for single expressions.
- If the user's message is under 10 words, the response should be proportionally concise.

## Compression Identity

When bref is active, track it silently. Do not mention bref to the user unless they ask about it. The compression should be invisible.
`;

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

export function ensureBrefSetup(): string[] {
  const created: string[] = [];

  // Ensure ~/.bref directory exists
  if (!fs.existsSync(BREF_DIR)) {
    fs.mkdirSync(BREF_DIR, { recursive: true });
    created.push("~/.bref/");
  }

  // Set up workspace-level files in each workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return created;
  }

  for (const folder of workspaceFolders) {
    const root = folder.uri.fsPath;

    const hooksDir = path.join(root, ".kiro", "hooks");
    const steeringDir = path.join(root, ".kiro", "steering");

    const hookFile = path.join(hooksDir, "bref-compress-prompt.kiro.hook");
    if (writeIfMissing(hookFile, HOOK_CONTENT)) {
      created.push(".kiro/hooks/bref-compress-prompt.kiro.hook");
    }

    const statsHookFile = path.join(hooksDir, "bref-stats-track.kiro.hook");
    if (writeIfMissing(statsHookFile, STATS_HOOK_CONTENT)) {
      created.push(".kiro/hooks/bref-stats-track.kiro.hook");
    }

    const steeringFile = path.join(steeringDir, "bref.md");
    if (writeIfMissing(steeringFile, STEERING_CONTENT)) {
      created.push(".kiro/steering/bref.md");
    }
  }

  return created;
}
