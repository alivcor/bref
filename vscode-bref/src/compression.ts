/**
 * Prompt compression engine (pure TypeScript, no Python dependency).
 *
 * Multi-pass pipeline:
 *   1. Protect code blocks and inline code
 *   2. Adaptive ratio adjustment based on information density
 *   3. Sentence-level entropy pruning
 *   4. N-gram redundancy deduplication
 *   5. Token-level TF-IDF scoring with positional decay
 */

import { encodingForModel } from "js-tiktoken";

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const STRUCTURAL_LINE_RE = /^\s*(#|[-*]|\d+[.)]\s)/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

let _enc: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!_enc) {
    _enc = encodingForModel("gpt-4o");
  }
  return _enc;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

export interface CompressResult {
  original: string;
  compressed: string;
  tokens_original: number;
  tokens_compressed: number;
  tokens_saved: number;
  sentences_dropped: number;
  ngram_dedup_count: number;
  effective_ratio: number;
}

// ---------------------------------------------------------------------------
// Protected regions (code blocks survive compression)
// ---------------------------------------------------------------------------

interface ProtectedRegion {
  tag: string;
  original: string;
}

function extractProtectedRegions(
  text: string
): [string, ProtectedRegion[]] {
  const regions: ProtectedRegion[] = [];
  let counter = 0;

  const replacer = (match: string): string => {
    const tag = `<<BREF_${counter}>>`;
    regions.push({ tag, original: match });
    counter++;
    return tag;
  };

  text = text.replace(CODE_FENCE_RE, replacer);
  text = text.replace(INLINE_CODE_RE, replacer);
  return [text, regions];
}

function restoreProtectedRegions(
  text: string,
  regions: ProtectedRegion[]
): string {
  for (const { tag, original } of regions) {
    text = text.replace(tag, original);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Entropy calculations
// ---------------------------------------------------------------------------

function charEntropy(text: string): number {
  if (!text.trim()) return 0;
  const chars = text.toLowerCase().split("");
  const n = chars.length;
  const freq = new Map<string, number>();
  for (const c of chars) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

function wordEntropy(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const n = words.length;
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

function combinedEntropy(text: string): number {
  return 0.3 * charEntropy(text) + 0.7 * wordEntropy(text);
}

// ---------------------------------------------------------------------------
// N-gram redundancy detection
// ---------------------------------------------------------------------------

function findRedundantNgrams(text: string, n: number = 4): Set<string> {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < n) return new Set();

  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const ng = words.slice(i, i + n).join(" ");
    counts.set(ng, (counts.get(ng) || 0) + 1);
  }

  const redundant = new Set<string>();
  for (const [ng, c] of counts) {
    if (c > 1) redundant.add(ng);
  }
  return redundant;
}

function deduplicateNgrams(
  text: string,
  n: number = 4
): [string, number] {
  const redundant = findRedundantNgrams(text, n);
  if (redundant.size === 0) return [text, 0];

  const words = text.split(/\s+/);
  const result: string[] = [];
  const seen = new Set<string>();
  let dedupCount = 0;
  let i = 0;

  while (i < words.length) {
    if (i + n <= words.length) {
      const ng = words
        .slice(i, i + n)
        .map((w) => w.toLowerCase())
        .join(" ");
      if (redundant.has(ng)) {
        if (seen.has(ng)) {
          i += n;
          dedupCount++;
          continue;
        }
        seen.add(ng);
      }
    }
    result.push(words[i]);
    i++;
  }

  return [result.join(" "), dedupCount];
}

// ---------------------------------------------------------------------------
// TF-IDF with positional decay
// ---------------------------------------------------------------------------

function computeTfidf(tokens: string[]): Map<string, number> {
  const lines: string[][] = [];
  let current: string[] = [];

  for (const t of tokens) {
    if (t === "\n") {
      if (current.length > 0) {
        lines.push(current);
        current = [];
      }
    } else {
      current.push(t.toLowerCase().trim());
    }
  }
  if (current.length > 0) lines.push(current);

  const numLines = Math.max(lines.length, 1);

  // Document frequency
  const df = new Map<string, number>();
  for (const lineTokens of lines) {
    const unique = new Set(lineTokens);
    for (const t of unique) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  // IDF
  const idf = new Map<string, number>();
  for (const [t, count] of df) {
    idf.set(t, Math.log(numLines / count) + 1.0);
  }

  // TF
  const totalTokens = lines.reduce((s, l) => s + l.length, 0);
  const tf = new Map<string, number>();
  for (const line of lines) {
    for (const t of line) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
  }

  // TF-IDF
  const tfidf = new Map<string, number>();
  for (const [t, freq] of tf) {
    tfidf.set(t, (freq / Math.max(totalTokens, 1)) * (idf.get(t) || 1.0));
  }

  return tfidf;
}

function positionalDecay(
  position: number,
  total: number,
  decayRate: number = 2.0
): number {
  if (total <= 1) return 1.0;
  const normalized = position / (total - 1);
  return Math.exp(-decayRate * (1.0 - normalized));
}

function scoreWord(
  word: string,
  position: number,
  total: number,
  tfidf: Map<string, number>,
  globalPosition: number,
  globalTotal: number
): number {
  const key = word
    .toLowerCase()
    .replace(/^[.,;:!?"'()\[\]{}]+|[.,;:!?"'()\[\]{}]+$/g, "")
    .trim();

  let score = tfidf.get(key) ?? 0.5;

  if (position === 0 || position === total - 1) score *= 1.4;
  if (key.length > 8) score *= 1.2;
  else if (key.length <= 2) score *= 0.7;

  const decay = positionalDecay(globalPosition, globalTotal);
  score *= 0.5 + 0.5 * decay;

  return score;
}

// ---------------------------------------------------------------------------
// Information density estimation
// ---------------------------------------------------------------------------

function estimateInformationDensity(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1.0;

  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / words.length;

  const avgLen =
    words.reduce((s, w) => s + w.length, 0) / words.length;
  const lenScore = Math.min(1.0, avgLen / 8.0);

  const vocabSize = uniqueWords.size;
  const we = wordEntropy(text);
  const maxEntropy = vocabSize > 1 ? Math.log2(vocabSize) : 1.0;
  const entropyScore = maxEntropy > 0 ? we / maxEntropy : 0.0;

  return 0.4 * ttr + 0.3 * lenScore + 0.3 * entropyScore;
}

function adaptiveRatio(text: string, targetRatio: number): number {
  const density = estimateInformationDensity(text);
  const adjusted = targetRatio + (1.0 - targetRatio) * density ** 2;
  return Math.max(targetRatio, Math.min(1.0, adjusted));
}

// ---------------------------------------------------------------------------
// Sentence-level pruning
// ---------------------------------------------------------------------------

function pruneLowEntropySentences(
  text: string,
  ratio: number
): [string, number] {
  const lines = text.split("\n");
  const resultLines: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    const stripped = line.trim();

    if (
      !stripped ||
      STRUCTURAL_LINE_RE.test(stripped) ||
      stripped.includes("<<BREF_") ||
      stripped.split(/\s+/).length <= 5
    ) {
      resultLines.push(line);
      continue;
    }

    const sentences = stripped.split(SENTENCE_SPLIT_RE);
    if (sentences.length <= 1) {
      resultLines.push(line);
      continue;
    }

    const entropies = sentences.map(combinedEntropy);
    const sorted = [...entropies].sort((a, b) => a - b);
    const cutoffIdx = Math.max(
      0,
      Math.min(
        Math.floor(sorted.length * (1.0 - ratio)),
        sorted.length - 1
      )
    );
    const threshold = sorted[cutoffIdx];

    const kept: string[] = [];
    for (let i = 0; i < sentences.length; i++) {
      if (entropies[i] >= threshold) {
        kept.push(sentences[i]);
      } else {
        dropped++;
      }
    }

    if (kept.length > 0) {
      resultLines.push(kept.join(" "));
    } else {
      resultLines.push(line);
      dropped -= sentences.length;
    }
  }

  return [resultLines.join("\n"), dropped];
}

// ---------------------------------------------------------------------------
// Main compression
// ---------------------------------------------------------------------------

export function compress(text: string, ratio: number = 0.5): CompressResult {
  const tokensOriginal = countTokens(text);

  if (ratio >= 1.0) {
    return {
      original: text,
      compressed: text,
      tokens_original: tokensOriginal,
      tokens_compressed: tokensOriginal,
      tokens_saved: 0,
      sentences_dropped: 0,
      ngram_dedup_count: 0,
      effective_ratio: 1.0,
    };
  }

  let [work, protected_] = extractProtectedRegions(text);

  // Pass 1: adaptive ratio
  const effectiveRatio = adaptiveRatio(work, ratio);

  // Pass 2: sentence entropy pruning
  let sentencesDropped: number;
  [work, sentencesDropped] = pruneLowEntropySentences(work, effectiveRatio);

  // Pass 3: n-gram dedup
  let ngramDedupCount: number;
  [work, ngramDedupCount] = deduplicateNgrams(work, 4);

  // Pass 4: token-level TF-IDF compression
  const allWords = work.split(/\s+/);
  const tfidf = computeTfidf(allWords);
  const globalTotal = allWords.length;

  const lines = work.split("\n");
  const resultLines: string[] = [];
  let globalPos = 0;

  for (const line of lines) {
    const stripped = line.trim();

    if (
      !stripped ||
      STRUCTURAL_LINE_RE.test(stripped) ||
      stripped.includes("<<BREF_")
    ) {
      resultLines.push(line);
      globalPos += stripped.split(/\s+/).length;
      continue;
    }

    const words = stripped.split(/\s+/);
    if (words.length <= 5) {
      resultLines.push(line);
      globalPos += words.length;
      continue;
    }

    const scored = words.map((w, i) => ({
      index: i,
      word: w,
      score: scoreWord(w, i, words.length, tfidf, globalPos + i, globalTotal),
    }));

    const keepCount = Math.max(2, Math.floor(words.length * effectiveRatio));
    scored.sort((a, b) => b.score - a.score);
    const keepIndices = scored
      .slice(0, keepCount)
      .map((s) => s.index)
      .sort((a, b) => a - b);

    resultLines.push(keepIndices.map((i) => words[i]).join(" "));
    globalPos += words.length;
  }

  let result = resultLines.join("\n");
  result = restoreProtectedRegions(result, protected_);

  const tokensCompressed = countTokens(result);

  return {
    original: text,
    compressed: result,
    tokens_original: tokensOriginal,
    tokens_compressed: tokensCompressed,
    tokens_saved: tokensOriginal - tokensCompressed,
    sentences_dropped: sentencesDropped,
    ngram_dedup_count: ngramDedupCount,
    effective_ratio:
      tokensOriginal > 0 ? tokensCompressed / tokensOriginal : 1.0,
  };
}
