"""Response cache with pluggable similarity backends.

The default backend uses exact-match hashing (fast, zero false positives).
A semantic backend using embeddings can be plugged in by implementing
the CacheBackend protocol.

Semantic similarity via bag-of-words cosine is intentionally NOT included
here because it gives poor results on short prompts and creates a false
sense of "semantic" matching. Real semantic caching requires an embedding
model (e.g. via sentence-transformers or an API call to /v1/embeddings).
"""

from __future__ import annotations

import hashlib
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class CacheEntry:
    prompt: str
    response: str
    created_at: float = field(default_factory=time.time)


class CacheBackend(ABC):
    """Interface for cache lookup strategies."""

    @abstractmethod
    def find(self, prompt: str) -> str | None:
        """Return cached response if a match exists, else None."""

    @abstractmethod
    def store(self, prompt: str, response: str) -> None:
        """Store a prompt-response pair."""

    @abstractmethod
    def clear(self) -> None:
        """Remove all entries."""

    @abstractmethod
    def __len__(self) -> int:
        """Number of entries in the cache."""


class ExactMatchBackend(CacheBackend):
    """Hash-based exact match. Fast and correct."""

    def __init__(self, max_entries: int = 10_000, ttl_seconds: int = 3600) -> None:
        self._max_entries = max_entries
        self._ttl = ttl_seconds
        self._entries: dict = {}

    def _key(self, prompt: str) -> str:
        return hashlib.sha256(prompt.strip().encode()).hexdigest()

    def _evict_expired(self) -> None:
        if self._ttl <= 0:
            return
        now = time.time()
        expired = [
            k for k, v in self._entries.items()
            if (now - v.created_at) > self._ttl
        ]
        for k in expired:
            del self._entries[k]

    def find(self, prompt: str) -> str | None:
        self._evict_expired()
        entry = self._entries.get(self._key(prompt))
        if entry is not None:
            return entry.response
        return None

    def store(self, prompt: str, response: str) -> None:
        if len(self._entries) >= self._max_entries:
            oldest = min(self._entries, key=lambda k: self._entries[k].created_at)
            del self._entries[oldest]
        self._entries[self._key(prompt)] = CacheEntry(prompt=prompt, response=response)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


class ResponseCache:
    """Top-level cache that delegates to a CacheBackend."""

    def __init__(self, backend: CacheBackend | None = None) -> None:
        self._backend = backend or ExactMatchBackend()

    def get(self, prompt: str) -> str | None:
        return self._backend.find(prompt)

    def put(self, prompt: str, response: str) -> None:
        self._backend.store(prompt, response)

    def clear(self) -> None:
        self._backend.clear()

    @property
    def size(self) -> int:
        return len(self._backend)
