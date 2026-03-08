from bref import Bref, BrefConfig


def test_compress_reduces_tokens():
    bref = Bref(BrefConfig(compression_ratio=0.5, routing_enabled=False))
    prompt = (
        "Please analyze the following code and explain in detail what each "
        "function does, how the data flows through the system, and identify "
        "any potential performance bottlenecks that could be optimized for "
        "better throughput and lower latency in a production environment."
    )
    result = bref.optimize(prompt=prompt, model="claude-sonnet")
    assert result.tokens_saved >= 0
    assert len(result.compressed_prompt) <= len(prompt)
    assert "compression" in result.stages_applied


def test_cache_exact_match():
    bref = Bref(BrefConfig())
    prompt = "What is the capital of France?"
    bref.cache_response(prompt, "Paris")

    result = bref.optimize(prompt=prompt, model="claude-sonnet")
    assert result.cache_hit is True
    assert result.cached_response == "Paris"


def test_cache_miss_on_different_prompt():
    bref = Bref(BrefConfig())
    bref.cache_response("What is the capital of France?", "Paris")

    result = bref.optimize(prompt="What is the capital of Germany?", model="claude-sonnet")
    assert result.cache_hit is False


def test_route_simple_prompt_to_cheap_model():
    config = BrefConfig(
        compression_enabled=False,
        cache_enabled=False,
        model_tiers={"simple": "claude-haiku", "moderate": "claude-sonnet", "complex": "claude-opus"},
    )
    result = Bref(config).optimize(prompt="Hi", model="claude-opus")
    assert result.routed_model == "claude-haiku"


def test_route_complex_prompt_to_capable_model():
    config = BrefConfig(
        compression_enabled=False,
        cache_enabled=False,
        model_tiers={"simple": "claude-haiku", "moderate": "claude-sonnet", "complex": "claude-opus"},
    )
    # Build a prompt that is genuinely long, multi-step, and code-heavy
    instructions = "\n".join(
        f"{i}. Implement step {i} of the migration pipeline with error handling."
        for i in range(1, 30)
    )
    code_blocks = "```python\nclass Pipeline:\n    pass\n```\n" * 10
    complex_prompt = instructions + "\n" + code_blocks
    result = Bref(config).optimize(prompt=complex_prompt, model="claude-haiku")
    assert result.routed_model == "claude-opus"


def test_middleware_passthrough():
    from bref.middleware import BrefMiddleware

    mw = BrefMiddleware(BrefConfig(
        compression_enabled=False,
        cache_enabled=False,
        routing_enabled=False,
    ))
    body = {
        "model": "claude-sonnet",
        "messages": [{"role": "user", "content": "Hello world"}],
    }
    result = mw.intercept(body)
    assert result["model"] == "claude-sonnet"
