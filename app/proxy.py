"""Reaching a service that only listens on localhost.

VS Code tunnels a remote port down to your laptop; Argus cannot, because it is a page in
a browser rather than an SSH client. It does not need to: it is already running on the
machine, so it can stand in front of the port instead. `/proxy/8000/…` reaches
`127.0.0.1:8000`, which is exactly the address a phone can never dial.

Nothing is proxied unless the server was started with --allow-proxy *and* that particular
port was opened by hand. A port bound to loopback was bound there on purpose.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse, Response, StreamingResponse

from .auth import PROXY_COOKIE
from .errors import ApiError

router = APIRouter()


def load(store: Path) -> set[int]:
    """Which ports were open, so a restart is not the same as closing every one of them.

    A port opened by hand stays open until it is closed by hand — that is the whole point
    of asking before proxying anything — and a restart is not a decision anybody made
    about any of them. `allow_proxy` still gates every request through this list; losing
    that flag on restart is exactly as it should be, and this only restores what was
    already allowed.
    """
    try:
        raw = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(raw, list):
        return set()
    return {p for p in raw if isinstance(p, int) and 1 <= p <= 65535}


def save(store: Path, ports: set[int]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Beside the target and renamed into place: a crash mid-write must not leave a
    # truncated list where a valid one used to be.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(json.dumps(sorted(ports)), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def default_store(config_path: Path) -> Path:
    return config_path.parent / "proxied.json"

# Hop-by-hop headers belong to one connection and must not be relayed onto another.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}
# httpx has already decoded the body, so the original framing headers would be lies.
STRIP_FROM_RESPONSE = HOP_BY_HOP | {"content-encoding", "content-length"}

HEAD_RE = re.compile(rb"(<head[^>]*>)", re.IGNORECASE)


def with_base(html: bytes, prefix: str) -> bytes:
    """Teach a page served under a prefix where its relative links point.

    This fixes documents that use relative URLs. A page that asks for `/static/app.js`
    still asks for the server's root and will still miss — the same limitation the
    equivalent feature has everywhere else, and why Jupyter and Streamlit ship a
    base-path option of their own.
    """
    tag = f'<base href="{prefix}">'.encode()
    if b"<base" in html[:4096].lower():
        return html
    if HEAD_RE.search(html):
        return HEAD_RE.sub(lambda m: m.group(1) + tag, html, count=1)
    # No <head> to slip into. The tag still has to follow the doctype, or the document
    # lands in quirks mode for the sake of a base href.
    lowered = html[:200].lower()
    if lowered.startswith(b"<!doctype"):
        cut = html.find(b">") + 1
        return html[:cut] + tag + html[cut:]
    return tag + html


def opened(request: Request) -> set[int]:
    return request.app.state.proxied


def hand_out_cookie(request: Request, response: Response) -> Response:
    """A page reached with ?token= will immediately ask for its own stylesheets, and
    those requests cannot carry a header. Give this browser the cookie on the way in, so
    the proxy URL works when it is opened directly rather than from the app."""
    if request.query_params.get("token"):
        response.set_cookie(
            PROXY_COOKIE, request.app.state.cfg.token,
            path="/proxy", httponly=True, samesite="lax",
        )
    return response


def check(request: Request, port: int) -> None:
    if not request.app.state.cfg.allow_proxy:
        raise ApiError(403, "proxying is off — start the server with --allow-proxy")
    if port not in opened(request):
        raise ApiError(403, f"port {port} is not open — open it from the System screen")


@router.get("/proxy/{port}", include_in_schema=False)
async def needs_a_slash(port: int) -> Response:
    """`/proxy/8000` is not `/proxy/8000/`, and the difference used to be invisible.

    The route below matches `/proxy/{port}/{path}`, so the form without the trailing slash
    matched nothing and fell through to the page handler, which answers *every* unknown path
    with the app's own `index.html` and a 200. So pasting the address one character short
    showed Argus itself, looking broken, with no hint that the address was the problem.
    """
    return RedirectResponse(f"/proxy/{port}/", status_code=308)


@router.api_route(
    "/proxy/{port}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    tags=["Ports"],
    summary="Reach a service that only listens on loopback",
)
async def through(request: Request, port: int, path: str) -> Response:
    check(request, port)

    # Our own credentials stop here. The token travels in the query when a page is opened
    # directly, and in the header when the app opens it — either way the service behind
    # the proxy has no business seeing it, and an OAuth callback is exactly the kind of
    # URL that gets written to somebody's log.
    onward = [(k, v) for k, v in parse_qsl(request.url.query, keep_blank_values=True) if k != "token"]
    url = httpx.URL(f"http://127.0.0.1:{port}/{path}", query=urlencode(onward).encode())
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    headers["host"] = f"127.0.0.1:{port}"
    headers.pop("cookie", None)      # our own cookie is not the service's business
    headers.pop("authorization", None)
    # And the referer, which was the hole the other two were plugged against.
    #
    # A page opened at `/proxy/11000/?token=…` puts that whole address — token and all — in
    # the `Referer` of every request it makes, and `Referer` is not hop-by-hop, so it went
    # straight through to the service and into its access log. Precisely the leak the query
    # is stripped to prevent, arriving by the other door, and made likely the day the ready
    # link was given the token so it would work in another browser.
    #
    # Rewritten rather than dropped: some services check it for CSRF, and from where the
    # service is standing this is the truth — the request did come from its own root, by the
    # path it knows, with nothing of ours attached.
    if "referer" in headers:
        was = urlsplit(headers["referer"]).path
        inside = was[len(f"/proxy/{port}"):] if was.startswith(f"/proxy/{port}") else "/"
        headers["referer"] = f"http://127.0.0.1:{port}{inside or '/'}"

    client: httpx.AsyncClient = request.app.state.http
    try:
        upstream = await client.request(
            request.method, url, headers=headers, content=await request.body(),
        )
    except httpx.ConnectError:
        raise ApiError(502, f"nothing answered on port {port}") from None
    except httpx.HTTPError as e:
        raise ApiError(502, f"port {port}: {e}") from e

    out = {k: v for k, v in upstream.headers.items() if k.lower() not in STRIP_FROM_RESPONSE}
    kind = upstream.headers.get("content-type", "")

    if kind.startswith("text/html"):
        return hand_out_cookie(request, Response(
            content=with_base(upstream.content, f"/proxy/{port}/"),
            status_code=upstream.status_code,
            headers=out,
            media_type=kind,
        ))

    return StreamingResponse(
        iter([upstream.content]),
        status_code=upstream.status_code,
        headers=out,
        media_type=kind or None,
    )
