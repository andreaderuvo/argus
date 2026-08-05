"""CLI entry point: load the config, build the app, serve it."""

from __future__ import annotations

import argparse
import asyncio
import os
import mimetypes
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import favourites, files, fsops, languages, mounts, paths, ports, proxy, system, term, tmux
import httpx

from .auth import PROXY_COOKIE, TokenAuthMiddleware
from .config import Config, ConfigError, default_path
from .errors import ApiError
from .safepath import Jail, PathError

VERSION = "0.1.0"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
BUILTIN_LANG = STATIC_DIR / "lang"

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
    app.state.lang = Path("/nonexistent")
    app.state.addresses = []

    app.state.proxied = set()          # ports opened by hand, this run only
    app.state.http = httpx.AsyncClient(timeout=30.0, follow_redirects=False)
    app.state.port = None

    app.include_router(files.router)
    app.include_router(proxy.router)
    app.include_router(fsops.router)
    app.include_router(paths.router)
    app.include_router(term.router)

    @app.get("/api/tmux/sessions")
    async def sessions(request: Request) -> list[dict]:
        try:
            return await asyncio.to_thread(tmux.list_sessions, request.app.state.socket)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e

    @app.get("/api/languages")
    async def list_languages(request: Request) -> list[dict]:
        return languages.available(BUILTIN_LANG, request.app.state.lang)

    @app.get("/api/language/{code}")
    async def one_language(request: Request, code: str) -> dict:
        try:
            path = languages.locate(code, BUILTIN_LANG, request.app.state.lang)
        except languages.BadLanguage as e:
            raise ApiError(400, str(e)) from e
        entry = languages.read(path) if path else None
        if not entry:
            raise ApiError(404, f"no language called {code}")
        return entry

    @app.post("/api/language")
    async def import_language(request: Request, body: dict) -> dict:
        """Anyone can translate the catalogue and add it here; it is a flat JSON object
        keyed by the English strings, so it needs no tooling to produce."""
        try:
            code, name, strings = languages.parse(body)
        except languages.BadLanguage as e:
            raise ApiError(400, str(e)) from e
        try:
            languages.save(request.app.state.lang, code, name, strings)
        except OSError as e:
            raise ApiError(500, f"could not save the language: {e.strerror}") from e
        return {"code": code, "name": name, "count": len(strings)}

    @app.get("/api/favourites")
    async def list_favourites(request: Request) -> dict:
        return favourites.describe_all(favourites.load(request.app.state.favourites))

    @app.post("/api/favourites")
    async def toggle_favourite(request: Request, body: dict) -> dict:
        raw = str(body.get("path", ""))
        # Pinning is jailed like everything else: you cannot bookmark your way out.
        target = str(favourites_target(request, raw))
        group = favourites.group_of(body.get("group"))
        store = request.app.state.favourites
        paths, pinned = favourites.toggle(favourites.load(store), group, target)
        favourites.save(store, paths)
        return {"pinned": pinned, "group": group, "favourites": favourites.describe_all(paths)}

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

    @app.post("/api/tmux/source")
    async def source_conf(request: Request, body: dict) -> dict:
        """Make every session pick up the configuration file.

        tmux options are per-server, so one source-file reaches every session on it —
        there is nothing to do per session. The file is tried on a throwaway server first,
        because sourcing runs it and a bad line can end the server everything is in.
        """
        state = request.app.state
        path = tmux.conf_path()
        if not os.path.isfile(path):
            raise ApiError(404, f"no configuration file at {path}")

        if not bool(body.get("force")):
            complaint = await asyncio.to_thread(tmux.check_conf, path)
            if complaint:
                raise ApiError(400, f"the file was refused on a test server: {complaint}")

        try:
            said = await asyncio.to_thread(tmux.source_conf, state.socket, path)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"path": path, "message": said}

    async def _known(request: Request, session: str) -> str:
        """Only a session tmux itself reported, the same rule attaching follows."""
        name = str(session or "")
        if not await asyncio.to_thread(tmux.session_exists, request.app.state.socket, name):
            raise ApiError(404, f"no tmux session named {name!r}")
        return name

    @app.get("/api/tmux/copymode")
    async def read_copy_mode(request: Request, session: str) -> dict:
        """Is this session showing history rather than the live end?"""
        name = await _known(request, session)
        return await asyncio.to_thread(tmux.copy_mode, request.app.state.socket, name)

    @app.post("/api/tmux/copymode")
    async def exit_copy_mode(request: Request, body: dict) -> dict:
        """Leave history and return to the live end."""
        name = await _known(request, str(body.get("session", "")))
        state = await asyncio.to_thread(tmux.copy_mode, request.app.state.socket, name)
        try:
            left = await asyncio.to_thread(tmux.leave_copy_mode, request.app.state.socket, name)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        # Saying *why* nothing happened is the difference between a button that is broken
        # and a button that had nothing to do.
        return {"left": left, "alternate": state["alternate"]}

    @app.get("/api/tmux/buffer")
    async def tmux_buffer(request: Request) -> dict:
        """The last thing copied inside tmux, so it can reach the device's clipboard."""
        try:
            text = await asyncio.to_thread(tmux.show_buffer, request.app.state.socket)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"text": text, "chars": len(text)}

    @app.post("/api/tmux/new")
    async def new_session(request: Request, body: dict) -> dict:
        state = request.app.state
        try:
            name = tmux.check_name(str(body.get("name", "")))
        except tmux.BadName as e:
            raise ApiError(400, str(e)) from e
        if await asyncio.to_thread(tmux.session_exists, state.socket, name):
            raise ApiError(409, f"a session called {name} is already there")

        where = body.get("path")
        if where:
            try:
                where = str(state.jail.resolve(str(where)))
            except PathError:
                raise ApiError(403, "outside the configured roots") from None

        try:
            await asyncio.to_thread(tmux.run, tmux.new_argv(state.socket, name, where))
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"name": name, "path": where}

    @app.post("/api/tmux/rename")
    async def rename_session(request: Request, body: dict) -> dict:
        state = request.app.state
        try:
            name = tmux.check_name(str(body.get("name", "")))
            to = tmux.check_name(str(body.get("to", "")))
        except tmux.BadName as e:
            raise ApiError(400, str(e)) from e
        try:
            await asyncio.to_thread(tmux.run, tmux.rename_argv(state.socket, name, to))
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"name": to}

    @app.post("/api/tmux/kill")
    async def kill_session(request: Request, body: dict) -> dict:
        """Killing a session ends everything running in it. The UI asks first."""
        state = request.app.state
        try:
            name = tmux.check_name(str(body.get("name", "")))
        except tmux.BadName as e:
            raise ApiError(400, str(e)) from e
        try:
            await asyncio.to_thread(tmux.run, tmux.kill_argv(state.socket, name))
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"killed": name}

    @app.get("/api/ports")
    async def list_ports(request: Request) -> dict:
        state = request.app.state
        return {
            "allow_proxy": state.cfg.allow_proxy,
            "open": sorted(state.proxied),
            "ports": await asyncio.to_thread(ports.listening, state.port),
        }

    @app.post("/api/ports")
    async def open_port(request: Request, body: dict) -> Response:
        """Opening a port also hands back the cookie the proxied page needs: its own
        stylesheets and scripts cannot carry an Authorization header."""
        state = request.app.state
        if not state.cfg.allow_proxy:
            raise ApiError(403, "proxying is off — start the server with --allow-proxy")
        port = int(body.get("port", 0))
        if not 1 <= port <= 65535:
            raise ApiError(400, "that is not a port")
        if port == state.port:
            raise ApiError(400, "that is Argus itself")

        if body.get("open"):
            state.proxied.add(port)
        else:
            state.proxied.discard(port)

        answer = JSONResponse({"open": sorted(state.proxied), "port": port})
        if body.get("open"):
            answer.set_cookie(
                PROXY_COOKIE, state.cfg.token,
                path="/proxy", httponly=True, samesite="lax",
            )
        return answer

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


def reachable_addresses() -> list[str]:
    """Addresses another device on the network could use.

    The browser cannot work these out: served through an editor's port forward it only
    knows `localhost`, which is useless in a QR code aimed at a phone.
    """
    import socket
    import subprocess

    out = []
    try:
        raw = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        raw = ""
    for addr in raw.split():
        # Docker bridges and loopback are not addresses a phone can reach.
        if addr.startswith(("127.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.")):
            continue
        if ":" in addr:          # keep it to IPv4: a QR is typed by nobody but scanned by phones
            continue
        out.append(addr)
    # Both spellings: on a VPN the short name is often what resolves, and it is what a
    # person types. The fully qualified one is what a browser outside the search domain
    # will need.
    names = []
    for name in (socket.gethostname(), socket.getfqdn()):
        names.append(name)
        # gethostname() often already returns the qualified form, so the short spelling
        # has to be derived rather than looked up — and the short one is what a person
        # on the VPN actually types.
        if "." in name:
            names.append(name.split(".")[0])
    for name in names:
        if name and name not in out and not name.startswith("localhost"):
            out.append(name)
    return out


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


def print_qr(url: str) -> bool:
    """A code you can photograph, in the terminal.

    The one in Settings needs you to be logged in already, which is no use when getting
    logged in is the problem. `segno` is pure Python and prints with half-block
    characters; without it there is still the URL.
    """
    try:
        import segno
    except ImportError:
        print("  (pip install segno for a scannable code)")
        return False
    segno.make(url, error="m").terminal(compact=True)
    return True


def banner(config_path: Path, created: bool, host: str, port: int, cfg: Config, sock: tmux.Socket) -> None:
    print(f"argus {VERSION}")
    print(f"  created {config_path} with a fresh token" if created else f"  config  {config_path}")
    shown = [str(r) for r in cfg.roots]
    print(f"  roots   {', '.join(shown[:4])}{f' (+{len(shown) - 4} more)' if len(shown) > 4 else ''}")
    print(f"  resize  {cfg.resize_policy}")
    print(f"  tmux    socket {sock.label()}")
    print(f"  files   {'read-write (mkdir/rename/move/copy/delete)' if cfg.allow_write else 'read-only'}")
    print(f"  ports   {'proxy allowed, one port at a time' if cfg.allow_proxy else 'no proxying'}")
    print()
    print(f"  open    {url_for(host, port, cfg)}")
    print("          (argus --qr prints a code to photograph)")
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
        "--allow-proxy",
        action="store_true",
        help="permit reverse-proxying a local port through Argus, one port at a time and "
        "only after you open it. Off by default: a service on 127.0.0.1 is there on purpose",
    )
    parser.add_argument(
        "--mounts",
        action="store_true",
        help="add every real filesystem on the machine to the browsable roots",
    )
    parser.add_argument("--print-url", action="store_true", help="print the URL with the access token and exit")
    parser.add_argument(
        "--qr",
        action="store_true",
        help="print a QR code of the URL for every address this machine answers on, and "
        "exit. Photograph it with a phone instead of typing 64 hex characters",
    )
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
        if args.allow_proxy:
            cfg.allow_proxy = True
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

    if args.qr:
        # One per address: which of them a phone can dial depends on where the phone is.
        for address in reachable_addresses() or [host]:
            scheme = "https" if cfg.tls() else "http"
            url = f"{scheme}://{address}:{port}/?token={cfg.token}"
            print(f"\n  {url}\n")
            print_qr(url)
        return 0

    try:
        app = create_app(cfg)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    app.state.favourites = favourites.default_store(config_path)
    app.state.lang = config_path.parent / "lang"
    app.state.port = port
    app.state.addresses = reachable_addresses()
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
