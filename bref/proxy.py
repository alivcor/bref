"""Local HTTP proxy that intercepts LLM API calls and applies bref optimizations.

Start with:
    python -m bref.proxy --port 8090

Then point your agent's base URL at http://localhost:8090.
The proxy forwards requests to the real API after compressing prompts.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import httpx

from bref.config import BrefConfig
from bref.middleware import BrefMiddleware


class ProxyHandler(BaseHTTPRequestHandler):
    middleware: BrefMiddleware
    upstream: str

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length)

        try:
            body = json.loads(raw_body)
        except json.JSONDecodeError:
            self._forward_raw(raw_body)
            return

        optimized = self.middleware.intercept(body)

        # If cache hit, return cached response directly
        if optimized.get("_bref_cache_hit"):
            cached = optimized.pop("_bref_cached_response", "")
            optimized.pop("_bref_cache_hit", None)
            response_body = json.dumps({
                "content": [{"type": "text", "text": cached}],
                "_bref": "cache_hit",
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
            return

        # Strip bref metadata before forwarding
        meta = optimized.pop("_bref_meta", None)

        # Forward to upstream
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in ("host", "content-length")
        }
        headers["Content-Type"] = "application/json"

        upstream_url = self.upstream.rstrip("/") + self.path
        try:
            resp = httpx.post(
                upstream_url,
                content=json.dumps(optimized).encode(),
                headers=headers,
                timeout=120.0,
            )
        except httpx.RequestError as e:
            self.send_error(502, str(e))
            return

        # Cache the response for future use
        if resp.status_code == 200:
            try:
                resp_json = resp.json()
                # Extract text from Anthropic response format
                content = resp_json.get("content", [])
                if content and isinstance(content[0], dict):
                    text = content[0].get("text", "")
                    if text:
                        self.middleware.record_response(optimized, text)
            except (json.JSONDecodeError, KeyError, IndexError):
                pass

        self.send_response(resp.status_code)
        for key, value in resp.headers.items():
            if key.lower() not in ("transfer-encoding", "content-encoding", "content-length"):
                self.send_header(key, value)
        body = resp.content
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

        if meta:
            print(
                f"[bref] saved {meta['tokens_saved']} tokens "
                f"(ratio: {meta['compression_ratio']}, stages: {meta['stages']})",
                file=sys.stderr,
            )

    def _forward_raw(self, raw_body: bytes) -> None:
        """Forward non-JSON requests unchanged."""
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in ("host", "content-length")
        }
        upstream_url = self.upstream.rstrip("/") + self.path
        resp = httpx.post(
            upstream_url,
            content=raw_body,
            headers=headers,
            timeout=120.0,
        )
        self.send_response(resp.status_code)
        for key, value in resp.headers.items():
            if key.lower() not in ("transfer-encoding", "content-encoding", "content-length"):
                self.send_header(key, value)
        body = resp.content
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        print(f"[bref-proxy] {args[0]}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bref LLM proxy")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--upstream", default="https://api.anthropic.com")
    parser.add_argument("--ratio", type=float, default=0.5)
    args = parser.parse_args()

    config = BrefConfig(compression_ratio=args.ratio)
    ProxyHandler.middleware = BrefMiddleware(config)
    ProxyHandler.upstream = args.upstream

    server = HTTPServer(("127.0.0.1", args.port), ProxyHandler)
    print(f"bref proxy listening on http://127.0.0.1:{args.port}", file=sys.stderr)
    print(f"forwarding to {args.upstream}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
