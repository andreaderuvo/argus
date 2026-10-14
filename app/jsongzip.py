"""JSON answers compressed, and nothing else.

A folder of 5,000 files listed as 1.19 MB of JSON, sent as it was (measured 2026-10-14); a page
asks for listings, sessions, states and teams all day. Starlette's GZipMiddleware would compress
every response — a 4 GB FASTQ.gz being downloaded included, for nothing — so this one looks at the
answer first: `application/json`, whole (not streamed), bigger than one packet, to a client that
said it takes gzip. Everything else goes through untouched.
"""

from __future__ import annotations

import gzip

MINIMUM = 1400
LIMIT = 32 * 1024 * 1024


class JsonGzip:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        accepts = any(k == b"accept-encoding" and b"gzip" in v for k, v in scope.get("headers") or [])
        if not accepts:
            return await self.app(scope, receive, send)

        start = None          # the response's start, held until we know whether to compress
        passing = False
        held: list[bytes] = []
        size = [0]

        async def wrapped(message):
            nonlocal start, passing
            if message["type"] == "http.response.start":
                headers = dict((k.lower(), v) for k, v in message.get("headers") or [])
                json = headers.get(b"content-type", b"").startswith(b"application/json")
                if not json or b"content-encoding" in headers:
                    passing = True
                    return await send(message)
                start = message
                return None
            if message["type"] != "http.response.body" or passing:
                return await send(message)
            # JSON arrives whole, but in pieces: a function middleware (@app.middleware("http"))
            # re-sends every body as a stream. Gathered here, up to a limit.
            held.append(message.get("body", b""))
            size[0] += len(held[-1])
            if message.get("more_body"):
                if size[0] <= LIMIT:
                    return None
                await send(start)                     # too big to hold: as it was, from here on
                start = None
                passing = True
                for piece in held:
                    await send({"type": "http.response.body", "body": piece, "more_body": True})
                held.clear()
                return None
            body = b"".join(held)
            headers = [(k, v) for k, v in start.get("headers") or [] if k.lower() != b"content-length"]
            if len(body) >= MINIMUM:
                body = gzip.compress(body, compresslevel=5, mtime=0)
                headers += [(b"content-encoding", b"gzip"), (b"vary", b"accept-encoding")]
            headers.append((b"content-length", str(len(body)).encode()))
            await send({**start, "headers": headers})
            start = None
            return await send({"type": "http.response.body", "body": body, "more_body": False})

        await self.app(scope, receive, wrapped)
