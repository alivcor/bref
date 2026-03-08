"""Model router. Selects the cheapest model that can handle a given prompt.

Complexity estimation is based on measurable prompt features rather than
keyword matching. The features are:

  - token count (via tiktoken)
  - presence and volume of code
  - number of distinct instructions/questions

The router maps a complexity score to a model tier defined in BrefConfig.
To plug in a trained classifier, subclass ComplexityEstimator and pass it
to route_model().
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod

from bref.compression import count_tokens
from bref.config import BrefConfig


class ComplexityEstimator(ABC):
    @abstractmethod
    def score(self, prompt: str) -> float:
        """Return a value in [0, 1]. 0 = trivial, 1 = very complex."""


class HeuristicEstimator(ComplexityEstimator):
    """Rule-based estimator using measurable prompt features."""

    def score(self, prompt: str) -> float:
        token_count = count_tokens(prompt)
        code_block_count = len(re.findall(r"```", prompt)) // 2
        # Count sentences that look like instructions or questions
        instruction_count = len(re.findall(
            r"[.!?]\s+[A-Z]|^\s*\d+[\.\)]\s",
            prompt,
            re.MULTILINE,
        ))

        s = 0.0
        # Token count contribution (log-scaled, caps at ~2k tokens)
        if token_count > 0:
            s += min(0.4, 0.4 * (token_count / 2000))
        # Code presence
        s += min(0.3, code_block_count * 0.15)
        # Instruction density
        s += min(0.3, instruction_count * 0.05)

        return min(1.0, s)


_DEFAULT_ESTIMATOR = HeuristicEstimator()


def route_model(
    prompt: str,
    requested_model: str,
    config: BrefConfig,
    estimator: ComplexityEstimator = _DEFAULT_ESTIMATOR,
) -> str:
    """Select a model tier based on prompt complexity.

    Returns the requested model unchanged if routing is disabled.
    """
    if not config.routing_enabled:
        return requested_model

    complexity = estimator.score(prompt)

    if complexity <= config.complexity_threshold_simple:
        tier = "simple"
    elif complexity <= config.complexity_threshold_moderate:
        tier = "moderate"
    else:
        tier = "complex"

    return config.model_tiers.get(tier, requested_model)
