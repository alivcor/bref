# Bref

Reduce AI API costs. Works with Kiro, Claude Code, or any LLM-powered agent.

## What it does

- Prompt compression: drops low-information tokens before they hit the API
- Response caching: exact-match by default, pluggable for semantic/embedding backends
- Model routing: scores prompt complexity, sends simple tasks to cheaper models
- Output budgeting: enforces max output token limits per request

## Python library

Requires Python 3.12+.

```bash
git clone https://github.com/alivcor/bref.git
cd bref
pip install -e ".[dev]"
```

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
```

## Kiro hook

The simplest integration. Copy the hook file into your workspace and it runs on every prompt automatically.

```bash
mkdir -p .kiro/hooks
cp bref-compress-prompt.kiro.hook .kiro/hooks/
```

Restart Kiro. The hook will show up in the Agent Hooks panel in the sidebar. It tells the agent to prefer concise responses and summarize redundant context, reducing token usage on every interaction.

## Proxy server

For deeper integration, run bref as a local proxy between your agent and the LLM API:

```bash
pip install -e ".[dev]"
python -m bref.proxy --port 8090 --upstream https://api.anthropic.com
```

Then configure your agent to send requests to `http://localhost:8090` instead of the API directly. The proxy compresses prompts, caches responses, and routes to cheaper models when possible.

## VS Code / Kiro extension

The extension lives in `vscode-bref/`. It calls into the Python library, so you need bref installed in a Python environment first.

### Quick install

[Download bref-0.1.0.vsix](https://github.com/alivcor/bref/raw/main/vscode-bref/bref-0.1.0.vsix), then in VS Code or Kiro:

1. Open the command palette (`Cmd+Shift+P`)
2. Run "Extensions: Install from VSIX..."
3. Select the downloaded `.vsix` file

### Build from source

```bash
cd vscode-bref
npm install
npm run compile
```

3. Install in VS Code or Kiro:
   - Open the command palette (`Cmd+Shift+P`)
   - Run "Developer: Install Extension from Location..."
   - Select the `vscode-bref` folder

Alternatively, package it as a `.vsix`:

```bash
npm install -g @vscode/vsce
cd vscode-bref
vsce package
```

Then install the `.vsix` via the command palette ("Extensions: Install from VSIX...").

### Configuration

Open Settings and search for "Bref":

- `bref.pythonPath`: path to the Python interpreter with bref installed (default: `python3`)
- `bref.compressionRatio`: target compression ratio, 0.1 = aggressive, 1.0 = no compression (default: `0.5`)

### Commands

- `Bref: Compress Selection`: compresses the selected text in the active editor
- `Bref: Show Stats`: shows tokens saved this session

The status bar shows a running total of tokens saved. The sidebar panel under the Bref icon shows compression history and averages.

## Running tests

```bash
pip install -e ".[dev]"
pytest
```
