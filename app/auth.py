"""Bearer-token gate for `/api` and `/ws`."""

from __future__ import annotations

import hmac
from urllib.parse import parse_qs

from starlette.responses import PlainTextResponse

PROTECTED_PREFIXES = ("/api", "/ws")


def presented_token(scope: dict) -> str | None:
    """Accepts the token from the ``Authorization`` header or from ``?token=``.

    The query form is not a convenience: browsers cannot set headers on a WebSocket
    handshake, nor on ``<img src>`` and download links, so those paths have no
    alternative.
    """
    for raw_key, raw_val in scope.get("headers") or []:
        if raw_key.lower() != b"authorization":
            continue
        try:
            value = raw_val.decode("latin-1")
        except UnicodeDecodeError:
            continue
        if value.startswith("Bearer "):
            return value[len("Bearer ") :].strip()

    qs = scope.get("query_string") or b""
    values = parse_qs(qs.decode("latin-1")).get("token")
    return values[0] if values else None


def matches(presented: str, expected: str) -> bool:
    """Constant-time comparison. ``compare_digest`` also returns false on a length
    mismatch, so the wire never learns how long the real token is."""
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


def is_protected(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in PROTECTED_PREFIXES)


class TokenAuthMiddleware:
    """Raw ASGI rather than Starlette's BaseHTTPMiddleware, because that one never sees
    WebSocket connections — and the terminal is a WebSocket."""

    def __init__(self, app, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not is_protected(scope["path"]):
            return await self.app(scope, receive, send)

        token = presented_token(scope)
        if token is not None and matches(token, self.token):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            # Closing before accepting makes the server answer the handshake with an
            # HTTP error instead of upgrading.
            await receive()
            return await send({"type": "websocket.close", "code": 1008})

        response = PlainTextResponse(
            "missing or invalid token",
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)
