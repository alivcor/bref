"""HTTP middleware for intercepting LLM API calls.

Sits between an agent (Kiro, Claude Code, etc.) and the LLM provider.
Applies the Bref optimization pipeline to every request payload.

Usage:
    from bref.middleware import BrefMiddleware

    middleware = BrefMiddleware()
    optimized = middleware.intercept(request_body)
"""

from __future__ import annotations

from typing import Any

from bref.config import BrefConfig
from bref.core import Bref


class BrefMiddleware:
    """Intercepts and optimizes LLM API request payloads."""

    def __init__(self, config: BrefConfig | None = None) -> None:
        self._bref = Bref(config)

    def intercept(self, request_body: dict[str, Any]) -> dict[str, Any]:
        """Optimize an API request body in-place.

        Expects a dict with at least:
        - "messages" or "prompt": the input text
        - "model": the target model

        Returns the modified request body with compressed prompt and
        potentially rerouted model.
        """
        model = request_body.get("model", "claude-sonnet")
        max_tokens = request_body.get("max_tokens")

        # Extract prompt text
        prompt = self._extract_prompt(request_body)
        if not prompt:
            return request_body

        result = self._bref.optimize(
            prompt=prompt,
            model=model,
            max_output_tokens=max_tokens,
        )

        # If cache hit, we could short-circuit (caller decides)
        if result.cache_hit:
            request_body["_bref_cache_hit"] = True
            request_body["_bref_cached_response"] = result.cached_response
            return request_body

        # Apply optimizations back to request
        self._apply_prompt(request_body, result.compressed_prompt)
        request_body["model"] = result.routed_model

        if result.max_output_tokens is not None:
            request_body["max_tokens"] = result.max_output_tokens

        # Attach metadata
        request_body["_bref_meta"] = {
            "tokens_saved": result.tokens_saved,
            "compression_ratio": round(result.compression_ratio, 3),
            "stages": result.stages_applied,
        }

        return request_body

    def record_response(self, request_body: dict[str, Any], response_text: str) -> None:
        """Cache a response for future semantic matching."""
        prompt = self._extract_prompt(request_body)
        if prompt:
            self._bref.cache_response(prompt, response_text)

    def _extract_prompt(self, body: dict[str, Any]) -> str | None:
        """Pull the prompt string from various API formats."""
        # Anthropic Messages API format
        if "messages" in body:
            messages = body["messages"]
            if messages and isinstance(messages[-1], dict):
                content = messages[-1].get("content", "")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    # Content blocks
                    texts = [
                        b["text"]
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ]
                    return "\n".join(texts) if texts else None
        # Simple prompt format
        if "prompt" in body:
            return body["prompt"]
        return None

    def _apply_prompt(self, body: dict[str, Any], compressed: str) -> None:
        """Write the compressed prompt back into the request body."""
        if "messages" in body:
            messages = body["messages"]
            if messages and isinstance(messages[-1], dict):
                content = messages[-1].get("content", "")
                if isinstance(content, str):
                    messages[-1]["content"] = compressed
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            block["text"] = compressed
                            break
        elif "prompt" in body:
            body["prompt"] = compressed
