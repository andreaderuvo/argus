"""CLI entry point: load the config, build the app, serve it."""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import favourites, files, fsops, mounts, system, term, tmux
from .auth import TokenAuthMiddleware
from .config import Config, ConfigError, default_path
from .errors import ApiError
from .safepath import Jail

VERSION = "0.1.0"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Not every system's mime database knows these two, and getting them wrong is fatal:
# a module served as octet-stream is refused by the browser, and so is the manifest.
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")

PLACEHOLDER = """<!doctype html>
<meta charset="utf-8">
<title>argus</title>
<style>body{font-family:ui-monospace,monospace;background:#0b0e14;color:#c5cad3;
display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem}</style>
<div><h1>Frontend missing</h1><p>The API and the WebSocket are running, but
<code>static/index.html</code> is not there.</p></div>
"""


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="argus", version=VERSION, docs_url=None, redoc_url=None)
    app.state.cfg = cfg
    app.state.jail = Jail(cfg.roots)
    app.state.socket = tmux.Socket.new(cfg.tmux_socket)
    app.state.favourites = getattr(cfg, "favourites_store", None) or Path("/nonexistent")

    app.include_router(files.router)
    app.include_router(fsops.router)
    app.include_router(term.router)

    @app.get("/api/tmux/sessions")
    async def sessions(request: Request) -> list[dict]:
        try:
            return await asyncio.to_thread(tmux.list_sessions, request.app.state.socket)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e

    @app.get("/api/favourites")
    async def list_favourites(request: Request) -> list[dict]:
        return favourites.describe(favourites.load(request.app.state.favourites))

    @app.post("/api/favourites")
    async def toggle_favourite(request: Request, body: dict) -> dict:
        raw = str(body.get("path", ""))
        # Pinning is jailed like everything else: you cannot bookmark your way out.
        target = str(favourites_target(request, raw))
        store = request.app.state.favourites
        paths, pinned = favourites.toggle(favourites.load(store), target)
        favourites.save(store, paths)
        return {"pinned": pinned, "favourites": favourites.describe(paths)}

    @app.get("/api/stat")
    async def stat_path(request: Request, path: str) -> dict:
        """Just enough to notice a file has changed: a window watching a report being
        regenerated polls this rather than re-downloading the whole thing."""
        from .safepath import Denied, NotFound

        try:
            target = request.app.state.jail.resolve(path)
        except NotFound:
            raise ApiError(404, "not found") from None
        except Denied:
            raise ApiError(403, "outside the configured roots") from None
        st = target.stat()
        return {"path": str(target), "mtime": int(st.st_mtime), "size": st.st_size}

    @app.get("/api/system")
    async def vitals(request: Request) -> dict:
        # Sampling /proc/stat needs a real pause, so it goes to a thread.
        return await asyncio.to_thread(system.snapshot, request.app.state.jail.roots)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        missing = ", ".join(str(e["loc"][-1]) for e in exc.errors())
        return JSONResponse({"error": f"bad or missing query parameter: {missing}"}, status_code=400)

    # Registered last so it never shadows the API: unknown paths are the frontend's.
    @app.get("/{requested:path}")
    async def static_handler(requested: str) -> Response:
        return serve_static(requested)

    app.add_middleware(TokenAuthMiddleware, token=cfg.token)
    return app


def favourites_target(request: Request, raw: str) -> Path:
    from .safepath import PathError

    try:
        return request.app.state.jail.resolve(raw)
    except PathError:
        raise ApiError(403, "outside the configured roots") from None


def serve_static(requested: str) -> Response:
    target = (STATIC_DIR / (requested or "index.html")).resolve()
    # Never serve outside the static directory, whatever the URL says.
    if not (target == STATIC_DIR or target.is_relative_to(STATIC_DIR)) or not target.is_file():
        index = STATIC_DIR / "index.html"
        if not index.is_file():
            return Response(PLACEHOLDER, media_type="text/html", status_code=503)
        target = index

    # Vendored libraries carry their version in the path, so they are safe to pin. The
    # app's own files must not be, or an update never reaches an installed PWA.
    cache = "public, max-age=31536000, immutable" if requested.startswith("vendor/") else "no-cache"
    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return Response(
        target.read_bytes(), media_type=media, headers={"cache-control": cache}
    )


def parse_listen(listen: str) -> tuple[str, int]:
    host, _, port = listen.rpartition(":")
    if not port.isdigit():
        raise ConfigError(f"`listen` is not a host:port address: {listen}")
    return (host or "0.0.0.0"), int(port)


def url_for(host: str, port: int, cfg: Config) -> str:
    scheme = "https" if cfg.tls() else "http"
    # 0.0.0.0 is not a usable destination — show a loopback URL and let the banner
    # mention that it is reachable from the network too.
    shown = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    return f"{scheme}://{shown}:{port}/?token={cfg.token}"


def banner(config_path: Path, created: bool, host: str, port: int, cfg: Config, sock: tmux.Socket) -> None:
    print(f"argus {VERSION}")
    print(f"  created {config_path} with a fresh token" if created else f"  config  {config_path}")
    shown = [str(r) for r in cfg.roots]
    print(f"  roots   {', '.join(shown[:4])}{f' (+{len(shown) - 4} more)' if len(shown) > 4 else ''}")
    print(f"  resize  {cfg.resize_policy}")
    print(f"  tmux    socket {sock.label()}")
    print(f"  files   {'read-write (mkdir/rename/move/copy/delete)' if cfg.allow_write else 'read-only'}")
    print()
    print(f"  open    {url_for(host, port, cfg)}")
    if host in ("0.0.0.0", "::", ""):
        print(f"          (bound to {host}:{port} — reachable from the network; put it behind Tailscale)")
    # Flush explicitly: when the output is a log file rather than a terminal, the banner
    # would otherwise sit in the buffer until the server is stopped.
    print(flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="argus",
        description="Browse files and attach to tmux sessions from your phone",
    )
    parser.add_argument("-c", "--config", type=Path, help="config file (created with a fresh token on first run)")
    parser.add_argument("-l", "--listen", help="override `listen`, e.g. 0.0.0.0:8080")
    parser.add_argument("-r", "--root", action="append", default=[], type=Path, help="override `roots` (repeatable)")
    parser.add_argument(
        "--socket",
        help="drive a specific tmux server: socket name (-L), or socket path if it "
        "contains '/' (-S). Use a throwaway one when testing — a crashing tmux server "
        "takes every session on its socket down with it",
    )
    parser.add_argument(
        "--allow-write",
        action="store_true",
        help="permit mkdir/rename/move/copy/delete through the API. Off by default: a "
        "read-only viewer is a safe thing to leave listening on a network",
    )
    parser.add_argument(
        "--mounts",
        action="store_true",
        help="add every real filesystem on the machine to the browsable roots",
    )
    parser.add_argument("--print-url", action="store_true", help="print the URL with the access token and exit")
    args = parser.parse_args(argv)

    config_path = args.config or default_path()
    try:
        cfg, created = Config.load_or_create(config_path)
        if args.listen:
            cfg.listen = args.listen
        if args.root:
            cfg.roots = args.root
        if args.socket:
            cfg.tmux_socket = args.socket
        if args.allow_write:
            cfg.allow_write = True
        if args.mounts:
            cfg.include_mounts = True
        if cfg.include_mounts:
            # Configured roots first: they are the ones the user cares about, and the
            # UI opens on the first.
            cfg.roots = cfg.roots + [m for m in mounts.discover() if m not in cfg.roots]
        cfg.validate()
        host, port = parse_listen(cfg.listen)
    except (ConfigError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.print_url:
        print(url_for(host, port, cfg))
        return 0

    try:
        app = create_app(cfg)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    app.state.favourites = favourites.default_store(config_path)
    banner(config_path, created, host, port, cfg, app.state.socket)
    tls = cfg.tls()
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        ssl_certfile=str(tls[0]) if tls else None,
        ssl_keyfile=str(tls[1]) if tls else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
