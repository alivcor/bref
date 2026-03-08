"""CLI entry point for bref. Used by hooks and the proxy."""

from __future__ import annotations

import json
import sys

from bref.compression import compress, count_tokens
from bref.config import BrefConfig


def run_compress() -> None:
    """Read text from stdin, compress it, write JSON result to stdout."""
    text = sys.stdin.read()
    if not text.strip():
        json.dump({"error": "empty input"}, sys.stdout)
        return

    config = BrefConfig()
    compressed = compress(text, ratio=config.compression_ratio)
    orig_tokens = count_tokens(text)
    comp_tokens = count_tokens(compressed)

    json.dump({
        "compressed": compressed,
        "tokens_original": orig_tokens,
        "tokens_compressed": comp_tokens,
        "tokens_saved": orig_tokens - comp_tokens,
    }, sys.stdout)


if __name__ == "__main__":
    run_compress()
