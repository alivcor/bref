from __future__ import annotations

from pydantic import BaseModel, Field


class BrefConfig(BaseModel):
    """Configuration for the Bref optimization pipeline."""

    # Prompt compression
    compression_enabled: bool = True
    compression_ratio: float = Field(default=0.5, ge=0.1, le=1.0)

    # Caching
    cache_enabled: bool = True
    cache_max_entries: int = Field(default=10_000, ge=1)
    cache_ttl_seconds: int = Field(default=3600, ge=0)

    # Model routing
    routing_enabled: bool = True
    model_tiers: dict[str, str] = Field(default_factory=lambda: {
        "simple": "claude-haiku",
        "moderate": "claude-sonnet",
        "complex": "claude-opus",
    })
    complexity_threshold_simple: float = Field(default=0.3, ge=0.0, le=1.0)
    complexity_threshold_moderate: float = Field(default=0.7, ge=0.0, le=1.0)

    # Output budgeting
    output_budget_enabled: bool = True
    default_max_output_tokens: int = Field(default=1024, ge=1)
