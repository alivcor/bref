# Bref: AI Prompt Compression and Token Cost Optimizer

Reduce LLM API costs by 40-60%. Bref compresses prompts, caches responses, and routes requests to cheaper models. Works with Kiro, Claude Code, Copilot, GPT, or any LLM-powered agent.

By [Abhinandan Dubey](https://alivcor.github.io)

## Why Bref

Every token you send to an LLM API costs money. Long system prompts, repeated context, and verbose instructions inflate your bill without improving output quality. Bref sits between your agent and the API, compressing what goes in and caching what comes back.

## Features

- **Prompt compression**: multi-pass pipeline that scores tokens by TF-IDF with positional decay, prunes low-entropy sentences, deduplicates repeated n-grams, and adapts the compression ratio to information density
- **Response caching**: exact-match by default, pluggable for semantic/embedding backends
- **Model routing**: scores prompt complexity, sends simple tasks to cheaper models
- **Output budgeting**: enforces max output token limits per request
- **Persistent stats**: tracks tokens saved, compression ratios, and history to `~/.bref/stats.json`

## Quick start with Kiro

The fastest way to use bref. No Python install needed for the hook-only setup.

### 1. Clone the repo

```bash
git clone https://github.com/alivcor/bref.git
```

### 2. Copy the hook and steering file into your workspace (optional)

The VS Code extension auto-creates these on first activation. If you prefer to set them up manually:

```bash
mkdir -p .kiro/hooks .kiro/steering
cp bref/bref-compress-prompt.kiro.hook .kiro/hooks/
cp bref/bref-steering.md .kiro/steering/bref.md
```

### 3. Restart Kiro

The hook appears in the Agent Hooks panel in the sidebar. It runs on every prompt, instructing the agent to apply entropy-based compression, semantic deduplication, priority-weighted lossy compression, chain-of-density packing, and token budget awareness.

The steering file provides the detailed compression strategy that the hook references.

## VS Code / Kiro Extension

Install the extension for a stats sidebar and manual compress-selection. No Python needed. The compression engine runs natively in TypeScript.

### Install from Marketplace

Search for "Bref" in the VS Code or Kiro extensions panel, or:

```
ext install abhinandandubey.vscode-bref
```

### Install from VSIX

[Download vscode-bref-0.2.0.vsix](https://github.com/alivcor/bref/raw/main/vscode-bref/vscode-bref-0.2.0.vsix), then in Kiro or VS Code:

1. Open the command palette (`Cmd+Shift+P`)
2. Run "Extensions: Install from VSIX..."
3. Select the downloaded `.vsix` file

Or build from source:

```bash
cd vscode-bref
npm install
npm run compile
```

### Extension settings

Open Settings and search for "Bref":

- `bref.compressionRatio`: target compression ratio, 0.1 = aggressive, 1.0 = no compression (default: `0.5`)

### Extension commands

- `Bref: Compress Selection`: compresses selected text in the active editor
- `Bref: Show Stats`: shows tokens saved

The status bar shows a running total. The sidebar panel under the Bref icon shows cumulative stats read from `~/.bref/stats.json`.

## Proxy Server

For deeper integration, run bref as a local HTTP proxy between your agent and the LLM API:

```bash
pip install -e ".[dev]"
python -m bref.proxy --upstream https://api.anthropic.com
```

Configure your agent to send requests to localhost instead of the API directly. The proxy compresses prompts, caches responses, and routes to cheaper models when possible.

## Python Library

```python
from bref import Bref, BrefConfig

config = BrefConfig(
    compression_ratio=0.5,
    model_tiers={
        "simple": "claude-haiku",
        "moderate": "claude-sonnet",
        "complex": "claude-opus",
    },
)
bref = Bref(config)
result = bref.optimize(
    prompt="Your long prompt here...",
    model="claude-sonnet-4-20250514",
)

print(f"Tokens: {result.tokens_original} -> {result.tokens_compressed}")
print(f"Saved: {result.tokens_saved}")
print(f"Routed to: {result.routed_model}")
```

## How the Compression Works

The compression pipeline runs five passes:

1. **Adaptive ratio**: estimates information density (type-token ratio, average word length, word-level Shannon entropy) and adjusts the target ratio so dense text gets compressed less aggressively
2. **Sentence entropy pruning**: computes combined character and word entropy per sentence, drops sentences below a threshold derived from the target ratio
3. **N-gram deduplication**: finds 4-grams that appear more than once and removes duplicate occurrences
4. **TF-IDF token scoring**: computes term frequency-inverse document frequency per token, applies exponential positional decay (tokens near the end of the prompt, where the user's question usually is, get boosted)
5. **Word-level pruning**: keeps the top-scoring fraction of words per line based on the effective ratio

Code blocks, inline code, structural lines (headers, bullets, numbered lists), and short lines are preserved untouched.

## Running Tests

```bash
pip install -e ".[dev]"
pytest
```

## Requirements

- Python 3.12+
- tiktoken, pydantic, httpx (installed automatically)

## License

MIT
