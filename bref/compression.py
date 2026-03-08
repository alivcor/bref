"""Prompt compression via token-level importance scoring.

Compresses natural language portions of a prompt while preserving
code blocks, structure, and high-information tokens. Uses token
entropy as a proxy for importance: tokens that are highly predictable
given their context carry less information and can be dropped.

For now, we approximate importance using inverse document frequency
across the prompt itself (self-IDF). A future version can plug in
a small trained model (a la LLMLingua-2) for better scoring.
"""

from __future__ import annotations

import math
import re
from collections import Counter

import tiktoken

_CODE_FENCE_RE = re.compile(r"```[\s\S]*?```")
_INLINE_CODE_RE = re.compile(r"`[^`]+`")
_STRUCTURAL_LINE_RE = re.compile(r"^\s*(#|[-*]|\d+[\.\)])\s")


def count_tokens(text: str, encoding: str = "cl100k_base") -> int:
    enc = tiktoken.get_encoding(encoding)
    return len(enc.encode(text))


def _extract_protected_regions(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace code blocks with placeholders so they survive compression."""
    protected = []
    counter = 0

    def _replace(match: re.Match) -> str:
        nonlocal counter
        tag = f"<<BREF_{counter}>>"
        protected.append((tag, match.group(0)))
        counter += 1
        return tag

    text = _CODE_FENCE_RE.sub(_replace, text)
    text = _INLINE_CODE_RE.sub(_replace, text)
    return text, protected


def _restore_protected_regions(text: str, protected: list[tuple[str, str]]) -> str:
    for tag, original in protected:
        text = text.replace(tag, original)
    return text


def _compute_token_idf(tokens: list[str]) -> dict:
    """Compute inverse frequency scores for tokens within the document.

    Tokens that appear rarely in the prompt carry more information.
    This is a self-IDF: we treat each line as a "document" and compute
    IDF across lines.
    """
    lines_containing = Counter()
    lines = []
    current_line = []

    for t in tokens:
        if t == "\n":
            if current_line:
                lines.append(set(current_line))
                current_line = []
        else:
            current_line.append(t.lower().strip())

    if current_line:
        lines.append(set(current_line))

    num_lines = max(len(lines), 1)
    for line_tokens in lines:
        for t in line_tokens:
            lines_containing[t] += 1

    idf = {}
    for t, count in lines_containing.items():
        idf[t] = math.log(num_lines / count) + 1.0
    return idf


def _score_word(word: str, position: int, total: int, idf: dict) -> float:
    """Score a single word for retention priority.

    Higher score = more important = keep.
    """
    key = word.lower().strip(".,;:!?\"'()[]{}").strip()
    score = idf.get(key, 1.0)

    # Positional bias: first and last tokens in a segment matter more
    if position == 0 or position == total - 1:
        score *= 1.5

    # Longer tokens tend to carry more meaning
    if len(key) > 8:
        score *= 1.2

    return score


def compress(text: str, ratio: float = 0.5) -> str:
    """Compress a prompt to approximately `ratio` of its original size.

    Preserves code blocks, structural lines (headers, bullets, numbered lists),
    and short lines. Only compresses prose-like lines by dropping low-importance
    words based on self-IDF scoring.
    """
    if ratio >= 1.0:
        return text

    text, protected = _extract_protected_regions(text)

    all_words = text.split()
    idf = _compute_token_idf(all_words)

    lines = text.split("\n")
    result_lines = []

    for line in lines:
        stripped = line.strip()

        # Pass through: empty, structural, protected, or short lines
        if (
            not stripped
            or _STRUCTURAL_LINE_RE.match(stripped)
            or "<<BREF_" in stripped
        ):
            result_lines.append(line)
            continue

        words = stripped.split()
        if len(words) <= 5:
            result_lines.append(line)
            continue

        # Score each word and keep the top `ratio` fraction
        scored = [
            (i, w, _score_word(w, i, len(words), idf))
            for i, w in enumerate(words)
        ]
        keep_count = max(2, int(len(words) * ratio))
        scored.sort(key=lambda x: x[2], reverse=True)
        keep_indices = sorted(s[0] for s in scored[:keep_count])
        result_lines.append(" ".join(words[i] for i in keep_indices))

    result = "\n".join(result_lines)
    return _restore_protected_regions(result, protected)
