# Bref

Reduce AI API costs. Works with Kiro, Claude Code, or any LLM-powered agent.

## What it does

- Prompt compression: drops low-information tokens before they hit the API
- Response caching: exact-match by default, pluggable for semantic/embedding backends
- Model routing: scores prompt complexity, sends simple tasks to cheaper models
- Output budgeting: enforces max output token limits per request

## Install

```bash
pip install -e ".[dev]"
```

## Usage

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
