"""CLI entry point for bref. Used by hooks and the VS Code extension."""

from __future__ import annotations

import json
import os
import sys

from bref.compression import compress_with_stats, count_tokens
from bref.config import BrefConfig

# Stats file location: ~/.bref/stats.json
STATS_DIR = os.path.expanduser("~/.bref")
STATS_FILE = os.path.join(STATS_DIR, "stats.json")


def _load_stats() -> dict:
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "total_tokens_saved": 0,
        "total_compressions": 0,
        "total_tokens_original": 0,
        "total_tokens_compressed": 0,
        "history": [],
    }


def _save_stats(stats: dict) -> None:
    os.makedirs(STATS_DIR, exist_ok=True)
    with open(STATS_FILE, "w") as f:
        json.dump(stats, f, indent=2)


def run_compress() -> None:
    """Read text from stdin, compress it, write JSON result to stdout.

    Also appends to the persistent stats file at ~/.bref/stats.json
    so the VS Code extension can read cumulative numbers.
    """
    text = sys.stdin.read()
    if not text.strip():
        json.dump({"error": "empty input"}, sys.stdout)
        return

    config = BrefConfig()
    compressed, comp_stats = compress_with_stats(text, ratio=config.compression_ratio)

    result = {
        "compressed": compressed,
        "tokens_original": comp_stats.tokens_original,
        "tokens_compressed": comp_stats.tokens_compressed,
        "tokens_saved": comp_stats.tokens_original - comp_stats.tokens_compressed,
        "sentences_dropped": comp_stats.sentences_dropped,
        "ngram_dedup_count": comp_stats.ngram_dedup_count,
        "effective_ratio": round(comp_stats.effective_ratio, 4),
    }
    json.dump(result, sys.stdout)

    # Update persistent stats
    try:
        stats = _load_stats()
        stats["total_tokens_saved"] += result["tokens_saved"]
        stats["total_compressions"] += 1
        stats["total_tokens_original"] += result["tokens_original"]
        stats["total_tokens_compressed"] += result["tokens_compressed"]
        stats["history"].append({
            "tokens_saved": result["tokens_saved"],
            "effective_ratio": result["effective_ratio"],
            "sentences_dropped": result["sentences_dropped"],
            "ngram_dedup_count": result["ngram_dedup_count"],
        })
        # Keep last 100 entries
        stats["history"] = stats["history"][-100:]
        _save_stats(stats)
    except OSError:
        pass  # stats are best-effort


if __name__ == "__main__":
    run_compress()
