"""Core Bref pipeline. Orchestrates compression, caching, routing, and output budgeting."""

from __future__ import annotations

from bref.cache import CacheBackend, ExactMatchBackend, ResponseCache
from bref.compression import compress, count_tokens
from bref.config import BrefConfig
from bref.router import route_model
from bref.types import OptimizeResult


class Bref:
    """Main entry point for the Bref optimization pipeline.

    Accepts an optional CacheBackend to swap in semantic/redis caching.
    """

    def __init__(
        self,
        config: BrefConfig | None = None,
        cache_backend: CacheBackend | None = None,
    ) -> None:
        self.config = config or BrefConfig()
        backend = cache_backend or ExactMatchBackend(
            max_entries=self.config.cache_max_entries,
            ttl_seconds=self.config.cache_ttl_seconds,
        )
        self._cache = ResponseCache(backend)

    def optimize(
        self,
        prompt: str,
        model: str = "claude-sonnet",
        max_output_tokens: int | None = None,
    ) -> OptimizeResult:
        """Run the full optimization pipeline on a prompt.

        Returns an OptimizeResult with the compressed prompt, routed model,
        cache status, and token savings.
        """
        stages: list[str] = []
        tokens_original = count_tokens(prompt)

        # 1. Check cache
        cached_response = None
        if self.config.cache_enabled:
            cached_response = self._cache.get(prompt)
            if cached_response is not None:
                stages.append("cache_hit")
                return OptimizeResult(
                    original_prompt=prompt,
                    compressed_prompt=prompt,
                    routed_model=model,
                    cache_hit=True,
                    cached_response=cached_response,
                    tokens_original=tokens_original,
                    tokens_compressed=tokens_original,
                    stages_applied=stages,
                )

        # 2. Compress prompt
        compressed = prompt
        if self.config.compression_enabled:
            compressed = compress(prompt, ratio=self.config.compression_ratio)
            stages.append("compression")

        tokens_compressed = count_tokens(compressed)

        # 3. Route to cheapest capable model
        routed = model
        if self.config.routing_enabled:
            routed = route_model(compressed, model, self.config)
            if routed != model:
                stages.append("model_routed")

        # 4. Output budget
        output_limit = max_output_tokens
        if self.config.output_budget_enabled and output_limit is None:
            output_limit = self.config.default_max_output_tokens
            stages.append("output_budget")

        return OptimizeResult(
            original_prompt=prompt,
            compressed_prompt=compressed,
            routed_model=routed,
            cache_hit=False,
            tokens_original=tokens_original,
            tokens_compressed=tokens_compressed,
            max_output_tokens=output_limit,
            stages_applied=stages,
        )

    def cache_response(self, prompt: str, response: str) -> None:
        """Store a response in the cache for future reuse."""
        if self.config.cache_enabled:
            self._cache.put(prompt, response)

    @property
    def cache_size(self) -> int:
        return self._cache.size
