from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class OptimizeResult:
    """Result of the Bref optimization pipeline."""

    original_prompt: str
    compressed_prompt: str
    routed_model: str
    cache_hit: bool = False
    cached_response: str | None = None
    tokens_original: int = 0
    tokens_compressed: int = 0
    max_output_tokens: int | None = None
    stages_applied: list[str] = field(default_factory=list)

    @property
    def tokens_saved(self) -> int:
        return self.tokens_original - self.tokens_compressed

    @property
    def compression_ratio(self) -> float:
        if self.tokens_original == 0:
            return 0.0
        return self.tokens_compressed / self.tokens_original
