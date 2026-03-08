"""Prompt compression via multi-pass token-level importance scoring.

Compresses natural language portions of a prompt while preserving
code blocks, structure, and high-information tokens.

Compression pipeline:
  1. Protect code blocks and structural elements
  2. Sentence-level entropy scoring and pruning
  3. N-gram redundancy detection and deduplication
  4. Token-level TF-IDF with positional decay
  5. Budget-aware ratio adjustment

Uses tiktoken for accurate token counting.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import NamedTuple

import tiktoken

_CODE_FENCE_RE = re.compile(r"```[\s\S]*?```")
_INLINE_CODE_RE = re.compile(r"`[^`]+`")
_STRUCTURAL_LINE_RE = re.compile(r"^\s*(#|[-*]|\d+[\.\)])\s")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


class CompressionStats(NamedTuple):
    """Stats from a single compression run."""
    tokens_original: int
    tokens_compressed: int
    sentences_dropped: int
    ngram_dedup_count: int
    effective_ratio: float


def count_tokens(text: str, encoding: str = "cl100k_base") -> int:
    enc = tiktoken.get_encoding(encoding)
    return len(enc.encode(text))


def _extract_protected_regions(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace code blocks with placeholders so they survive compression."""
    protected: list[tuple[str, str]] = []
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


# ---------------------------------------------------------------------------
# Sentence-level entropy scoring
# ---------------------------------------------------------------------------

def _sentence_entropy(sentence: str) -> float:
    """Compute Shannon entropy of a sentence based on character distribution.

    Higher entropy means more information content (more varied characters).
    Lower entropy means more repetitive/predictable content.
    """
    if not sentence.strip():
        return 0.0
    chars = list(sentence.lower())
    n = len(chars)
    freq = Counter(chars)
    entropy = 0.0
    for count in freq.values():
        p = count / n
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy


def _word_entropy(sentence: str) -> float:
    """Compute Shannon entropy at the word level.

    Captures semantic diversity better than character entropy for
    natural language. A sentence repeating the same words has low
    word entropy.
    """
    words = sentence.lower().split()
    if not words:
        return 0.0
    n = len(words)
    freq = Counter(words)
    entropy = 0.0
    for count in freq.values():
        p = count / n
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy


def _combined_entropy(sentence: str) -> float:
    """Weighted combination of character and word entropy.

    Word entropy is weighted higher because it better captures
    semantic information density.
    """
    ce = _sentence_entropy(sentence)
    we = _word_entropy(sentence)
    return 0.3 * ce + 0.7 * we


# ---------------------------------------------------------------------------
# N-gram redundancy detection
# ---------------------------------------------------------------------------

def _find_redundant_ngrams(text: str, n: int = 4) -> set[str]:
    """Find n-grams that appear more than once in the text.

    Returns the set of repeated n-gram strings. These represent
    redundant phrases that can be collapsed.
    """
    words = text.lower().split()
    if len(words) < n:
        return set()

    ngrams: list[str] = []
    for i in range(len(words) - n + 1):
        ngrams.append(" ".join(words[i:i + n]))

    counts = Counter(ngrams)
    return {ng for ng, c in counts.items() if c > 1}


def _deduplicate_ngrams(text: str, n: int = 4) -> tuple[str, int]:
    """Remove duplicate n-gram occurrences, keeping the first.

    Returns the deduplicated text and the count of removed duplicates.
    """
    redundant = _find_redundant_ngrams(text, n)
    if not redundant:
        return text, 0

    dedup_count = 0
    words = text.split()
    result_words: list[str] = []
    seen_ngrams: set[str] = set()
    i = 0

    while i < len(words):
        if i + n <= len(words):
            ngram = " ".join(w.lower() for w in words[i:i + n])
            if ngram in redundant:
                if ngram in seen_ngrams:
                    # Skip this duplicate occurrence
                    i += n
                    dedup_count += 1
                    continue
                seen_ngrams.add(ngram)
        result_words.append(words[i])
        i += 1

    return " ".join(result_words), dedup_count


# ---------------------------------------------------------------------------
# TF-IDF with positional decay
# ---------------------------------------------------------------------------

def _compute_tfidf(tokens: list[str]) -> dict[str, float]:
    """Compute TF-IDF scores treating each line as a document.

    Unlike plain IDF, this weights by how frequently a term appears
    in its local context (TF) multiplied by how rare it is across
    the full prompt (IDF).
    """
    lines: list[list[str]] = []
    current: list[str] = []
    for t in tokens:
        if t == "\n":
            if current:
                lines.append(current)
                current = []
        else:
            current.append(t.lower().strip())
    if current:
        lines.append(current)

    num_lines = max(len(lines), 1)

    # Document frequency: how many lines contain each token
    df: Counter = Counter()
    for line_tokens in lines:
        for t in set(line_tokens):
            df[t] += 1

    # IDF
    idf: dict[str, float] = {}
    for t, count in df.items():
        idf[t] = math.log(num_lines / count) + 1.0

    # TF-IDF per token (using global TF normalized by total tokens)
    total_tokens = sum(len(line) for line in lines)
    tf: Counter = Counter()
    for line in lines:
        for t in line:
            tf[t] += 1

    tfidf: dict[str, float] = {}
    for t in tf:
        tfidf[t] = (tf[t] / max(total_tokens, 1)) * idf.get(t, 1.0)

    return tfidf


def _positional_decay(position: int, total: int, decay_rate: float = 2.0) -> float:
    """Exponential decay based on relative position.

    Tokens near the end of the prompt (closer to the user's actual
    question) get higher weight. The decay_rate controls how
    aggressively early tokens are penalized.

    Returns a multiplier in (0, 1].
    """
    if total <= 1:
        return 1.0
    # Normalized position: 0.0 = start, 1.0 = end
    normalized = position / (total - 1)
    return math.exp(-decay_rate * (1.0 - normalized))


def _score_word(
    word: str,
    position: int,
    total: int,
    tfidf: dict[str, float],
    global_position: int,
    global_total: int,
) -> float:
    """Score a word for retention priority.

    Combines TF-IDF importance with positional decay (both local
    within the line and global within the prompt).
    """
    key = word.lower().strip(".,;:!?\"'()[]{}").strip()
    score = tfidf.get(key, 0.5)

    # Local positional bias: first and last words in a line matter more
    if position == 0 or position == total - 1:
        score *= 1.4

    # Longer tokens tend to carry more meaning
    if len(key) > 8:
        score *= 1.2
    elif len(key) <= 2:
        score *= 0.7

    # Global positional decay: tokens near the end of the prompt
    # (where the user's question usually is) get boosted
    decay = _positional_decay(global_position, global_total)
    score *= (0.5 + 0.5 * decay)  # floor at 50% to avoid zeroing out

    return score


# ---------------------------------------------------------------------------
# Information density estimation
# ---------------------------------------------------------------------------

def _estimate_information_density(text: str) -> float:
    """Estimate the information density of text on a 0-1 scale.

    High density (close to 1.0) means the text is already compact
    and should not be compressed aggressively. Low density means
    there is a lot of redundancy to remove.

    Uses a combination of:
    - Unique word ratio (type-token ratio)
    - Average word length
    - Entropy
    """
    words = text.lower().split()
    if not words:
        return 1.0

    # Type-token ratio: unique words / total words
    ttr = len(set(words)) / len(words)

    # Average word length (longer words = more specific = denser)
    avg_len = sum(len(w) for w in words) / len(words)
    len_score = min(1.0, avg_len / 8.0)

    # Word entropy normalized by log2(vocab_size)
    vocab_size = len(set(words))
    we = _word_entropy(text)
    max_entropy = math.log2(vocab_size) if vocab_size > 1 else 1.0
    entropy_score = we / max_entropy if max_entropy > 0 else 0.0

    return 0.4 * ttr + 0.3 * len_score + 0.3 * entropy_score


def _adaptive_ratio(text: str, target_ratio: float) -> float:
    """Adjust the compression ratio based on information density.

    Dense text gets a gentler ratio (closer to 1.0).
    Sparse/redundant text gets a more aggressive ratio.
    """
    density = _estimate_information_density(text)
    # Interpolate: high density pushes ratio toward 1.0
    adjusted = target_ratio + (1.0 - target_ratio) * (density ** 2)
    return max(target_ratio, min(1.0, adjusted))


# ---------------------------------------------------------------------------
# Sentence-level pruning
# ---------------------------------------------------------------------------

def _prune_low_entropy_sentences(
    text: str,
    ratio: float,
) -> tuple[str, int]:
    """Drop entire sentences that fall below an entropy threshold.

    Only operates on prose lines (not structural or short lines).
    The threshold is derived from the target ratio: more aggressive
    compression means a higher entropy threshold for keeping sentences.

    Returns the pruned text and count of dropped sentences.
    """
    lines = text.split("\n")
    result_lines: list[str] = []
    dropped = 0

    for line in lines:
        stripped = line.strip()

        # Pass through non-prose lines
        if (
            not stripped
            or _STRUCTURAL_LINE_RE.match(stripped)
            or "<<BREF_" in stripped
            or len(stripped.split()) <= 5
        ):
            result_lines.append(line)
            continue

        # Split line into sentences and score each
        sentences = _SENTENCE_SPLIT_RE.split(stripped)
        if len(sentences) <= 1:
            result_lines.append(line)
            continue

        # Compute entropy for all sentences
        entropies = [_combined_entropy(s) for s in sentences]
        if not entropies:
            result_lines.append(line)
            continue

        # Threshold: keep sentences above the (1-ratio) percentile
        # e.g., ratio=0.5 means drop the bottom 50% by entropy
        sorted_e = sorted(entropies)
        cutoff_idx = int(len(sorted_e) * (1.0 - ratio))
        cutoff_idx = max(0, min(cutoff_idx, len(sorted_e) - 1))
        threshold = sorted_e[cutoff_idx]

        kept = []
        for s, e in zip(sentences, entropies):
            if e >= threshold:
                kept.append(s)
            else:
                dropped += 1

        if kept:
            result_lines.append(" ".join(kept))
        else:
            # Never drop all sentences from a line
            result_lines.append(line)
            dropped -= len(sentences)

    return "\n".join(result_lines), dropped


# ---------------------------------------------------------------------------
# Main compression function
# ---------------------------------------------------------------------------

def compress(text: str, ratio: float = 0.5) -> str:
    """Compress a prompt using the full multi-pass pipeline.

    Pipeline:
      1. Protect code blocks and inline code
      2. Adaptive ratio adjustment based on information density
      3. Sentence-level entropy pruning
      4. N-gram redundancy deduplication
      5. Token-level TF-IDF scoring with positional decay

    Preserves code blocks, structural lines (headers, bullets, numbered
    lists), and short lines. Returns the compressed text.
    """
    if ratio >= 1.0:
        return text

    text, protected = _extract_protected_regions(text)

    # Pass 1: Adapt ratio to content density
    effective_ratio = _adaptive_ratio(text, ratio)

    # Pass 2: Sentence-level entropy pruning
    text, _ = _prune_low_entropy_sentences(text, effective_ratio)

    # Pass 3: N-gram deduplication
    text, _ = _deduplicate_ngrams(text, n=4)

    # Pass 4: Token-level compression on remaining prose
    all_words = text.split()
    tfidf = _compute_tfidf(all_words)
    global_total = len(all_words)

    lines = text.split("\n")
    result_lines: list[str] = []
    global_pos = 0

    for line in lines:
        stripped = line.strip()

        if (
            not stripped
            or _STRUCTURAL_LINE_RE.match(stripped)
            or "<<BREF_" in stripped
        ):
            result_lines.append(line)
            global_pos += len(stripped.split())
            continue

        words = stripped.split()
        if len(words) <= 5:
            result_lines.append(line)
            global_pos += len(words)
            continue

        scored = [
            (
                i,
                w,
                _score_word(w, i, len(words), tfidf, global_pos + i, global_total),
            )
            for i, w in enumerate(words)
        ]
        keep_count = max(2, int(len(words) * effective_ratio))
        scored.sort(key=lambda x: x[2], reverse=True)
        keep_indices = sorted(s[0] for s in scored[:keep_count])
        result_lines.append(" ".join(words[i] for i in keep_indices))
        global_pos += len(words)

    result = "\n".join(result_lines)
    return _restore_protected_regions(result, protected)


def compress_with_stats(text: str, ratio: float = 0.5) -> tuple[str, CompressionStats]:
    """Like compress(), but also returns detailed stats."""
    if ratio >= 1.0:
        stats = CompressionStats(
            tokens_original=count_tokens(text),
            tokens_compressed=count_tokens(text),
            sentences_dropped=0,
            ngram_dedup_count=0,
            effective_ratio=1.0,
        )
        return text, stats

    tokens_original = count_tokens(text)
    text_work, protected = _extract_protected_regions(text)

    effective_ratio = _adaptive_ratio(text_work, ratio)
    text_work, sentences_dropped = _prune_low_entropy_sentences(text_work, effective_ratio)
    text_work, ngram_dedup_count = _deduplicate_ngrams(text_work, n=4)

    # Token-level pass (same as compress)
    all_words = text_work.split()
    tfidf = _compute_tfidf(all_words)
    global_total = len(all_words)

    lines = text_work.split("\n")
    result_lines: list[str] = []
    global_pos = 0

    for line in lines:
        stripped = line.strip()
        if (
            not stripped
            or _STRUCTURAL_LINE_RE.match(stripped)
            or "<<BREF_" in stripped
        ):
            result_lines.append(line)
            global_pos += len(stripped.split())
            continue

        words = stripped.split()
        if len(words) <= 5:
            result_lines.append(line)
            global_pos += len(words)
            continue

        scored = [
            (
                i,
                w,
                _score_word(w, i, len(words), tfidf, global_pos + i, global_total),
            )
            for i, w in enumerate(words)
        ]
        keep_count = max(2, int(len(words) * effective_ratio))
        scored.sort(key=lambda x: x[2], reverse=True)
        keep_indices = sorted(s[0] for s in scored[:keep_count])
        result_lines.append(" ".join(words[i] for i in keep_indices))
        global_pos += len(words)

    result = "\n".join(result_lines)
    result = _restore_protected_regions(result, protected)
    tokens_compressed = count_tokens(result)

    stats = CompressionStats(
        tokens_original=tokens_original,
        tokens_compressed=tokens_compressed,
        sentences_dropped=sentences_dropped,
        ngram_dedup_count=ngram_dedup_count,
        effective_ratio=tokens_compressed / max(tokens_original, 1),
    )
    return result, stats
