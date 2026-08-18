"""CLI entry point: load the config, build the app, serve it."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import mimetypes
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import announce, bells, devices, favourites, files, fsops, journal, languages, mounts, paths, ports, proxy, release, runner, system, term, tmux
import httpx

from .auth import PROXY_COOKIE, TokenAuthMiddleware
from .config import Config, ConfigError, default_path
from .errors import ApiError
from .safepath import Jail, PathError

VERSION = "0.0.1"
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


# What the API is, for whoever reads the spec rather than the app. Kept here rather than
# in a wiki page so it cannot drift away from the routes it describes.
ABOUT = """
Everything Argus does, it does through this API — the browser is one client of it, not a
privileged one. That is the whole extension story: a script, a cron job, an agent hook or
another machine can do anything the app can, with no plugin to install and nothing running
inside the page.

**Every route is behind the same token**, in an `Authorization: Bearer …` header or a
`?token=` query for the places a header cannot go — a WebSocket, an `<img>`, a page opened
directly. Anyone holding it can run anything you can: treat it like an SSH key.

**Everything lives under `/api`.** Nothing outside it answers with data, this document
included, so a single rule guards the lot.

The most useful thing to build against first is `POST /api/bell` — that is how an agent
tells you it has finished or wants you, and it needs nothing but curl.
"""

TAGS = [
    {"name": "Files", "description": "Reading the filesystem, previewing and searching it. Confined to the configured roots, canonicalised before the check, symlinks out of them refused."},
    {"name": "Writing", "description": "Making, moving, deleting, uploading. Every route here is off unless the server was started with `--allow-write`."},
    {"name": "Sessions", "description": "tmux: what exists, where it is, what it is showing, and how it looks. The terminal itself is a WebSocket."},
    {"name": "Notifications", "description": "Something has finished, or wants you. Post to it from an agent hook; read the stream to be told as it happens."},
    {"name": "Prompts", "description": "Working out what a path in a session refers to, so it can be opened."},
    {"name": "The machine", "description": "CPU, memory, disks, GPUs, and the ports that are listening."},
    {"name": "Ports", "description": "Standing in front of a service that only listens on loopback, one port at a time."},
    {"name": "Setup", "description": "What this server allows, which languages it has, and the tmux configuration it reads."},
]


class JournalMiddleware:
    """Record everything that changes something. Raw ASGI, to see the status without buffering
    the body."""

    # Reads are the overwhelming majority of the traffic and none of the interesting part.
    CHANGES = ("POST", "PUT", "PATCH", "DELETE")
    # …but the method is a poor proxy for "changed something". Searching is a POST because a
    # query goes in a body, and search-as-you-type filled the journal with a dozen identical
    # lines a second — which is precisely the file nobody opens that this was meant not to be.
    READS = ("/api/fs/locate", "/api/fs/usage")

    def __init__(self, app, store_of):
        self.app = app
        self.store_of = store_of

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api"):
            return await self.app(scope, receive, send)

        started = time.monotonic()
        status = 0

        async def watched(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, watched)
        finally:
            # Two things go in the journal, and the second is the reason it is worth having:
            # anything that changed something, and anything that was refused — whatever method
            # it used. A break-in looks like a run of 401s from an address you do not know, and
            # a GET is what a scanner sends.
            worth_it = journal.refused(status) or (
                scope.get("method") in self.CHANGES and scope.get("path") not in self.READS
            )
            store = self.store_of()
            if worth_it and store:
                journal.record(store, scope, status, int((time.monotonic() - started) * 1000))


async def overview_of(app: FastAPI, watcher: dict | None = None) -> dict:
    """What a board needs, and nothing else.

    Deliberately cheap: no CPU sampling window, no `nvidia-smi`, no process list. Load
    average says as much about a busy machine as a 120ms CPU sample does and costs nothing
    to read, which matters when several boards ask several machines every few seconds.
    Everything here is a read of /proc plus two tmux calls: the sessions, and what the
    agents in them have declared about themselves.
    """
    cfg = app.state.cfg
    cores = os.cpu_count() or 1
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = 0.0
    try:
        mem = system.memory(Path("/proc/meminfo").read_text())
    except OSError:
        mem = {"pct": 0.0, "swap_pct": 0.0}
    try:
        up = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        up = 0.0
    # Two different questions, and on a board of several Argus instances on one box the
    # machine's answer is the same for all of them while this one is not.
    serving = max(0.0, time.time() - getattr(app.state, "started", time.time()))

    # Only the disk in the most trouble: a board wants to know there is a problem, not to
    # inventory the filesystems.
    worst = None
    for root in cfg.roots:
        d = system.disk(root)
        if d and (worst is None or d["pct"] > worst["pct"]):
            worst = d

    try:
        sessions = await asyncio.to_thread(tmux.list_sessions, app.state.socket)
    except Exception:
        # A board asking about a machine whose tmux server is not running should see the
        # machine, with no sessions, rather than an error.
        sessions = []

    # And what the agents in them have said about themselves. One `list-panes` for the whole
    # server, so a machine with forty sessions costs a board what a machine with two does —
    # and nothing at all is inferred here: a session says `claude` because a hook wrote it,
    # never because a process tree looked like one. Guessing is for the window in front of
    # somebody, not for a tile on a wall.
    try:
        said = await asyncio.to_thread(tmux.declared, app.state.socket)
    except Exception:
        said = {}
    for one in sessions:
        told = said.get(one["name"])
        if told:
            one.update(told)

    # What has rung and not been collected: the reason to look at this machine rather than
    # another one.
    kept = getattr(app.state, "bells", None)
    ringing = {}
    for bell in list(kept["list"]) if kept else []:
        if bell.get("session"):
            ringing[bell["session"]] = bell.get("why")

    # What this machine offers to start and stop, with the overview rather than as a second
    # request: a board sweeping ten machines every five seconds should ask each of them once.
    # It also means a machine announcing itself carries the list, which is the only way a
    # board on the far side of a one-way network could ever know what it may ask for.
    try:
        offers = await asyncio.to_thread(runner.offered, cfg.runnable, app.state.socket)
    except Exception:
        offers = []

    return {
        "name": os.uname().nodename,
        "version": VERSION,
        "runnable": offers,
        # About the key that asked, not about the config: two boards can hold two watcher
        # tokens with different permissions. `None` means the main token or this machine
        # announcing itself, and neither is a board being offered a button.
        # Two ways to be stoppable, and a machine only ever has one of them. A board that
        # polls holds a watcher token, and the answer is about that key. A machine that
        # announces itself has no watcher at all — its permission is `board_may_stop_argus`,
        # and saying so here is the only way the board can know to offer the button.
        "can_stop_argus": bool(watcher.get("may_stop_argus")) if watcher
        else bool(cfg.obey_board and cfg.board_may_stop_argus),
        "uptime": up,
        "serving": serving,
        "cores": cores,
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "load_pct": round(100 * load1 / cores, 1),
        "memory_pct": round(mem.get("pct", 0.0), 1),
        "swap_pct": round(mem.get("swap_pct", 0.0), 1),
        "disk": worst and {"path": worst["path"], "pct": worst["pct"], "level": worst["level"]},
        "sessions": [
            {
                "name": s["name"],
                "windows": s.get("windows", 1),
                "attached": bool(s.get("attached")),
                "bell": ringing.get(s["name"]),
                # Only when something said so. A key per session that is null on every
                # machine where nobody has wired the hook is a payload paying for a feature
                # it is not using, and a board sweeps this every few seconds.
                **({"agent": s["agent"]} if s.get("agent") else {}),
                **({"model": s["model"]} if s.get("model") else {}),
            }
            for s in sessions
        ],
    }


async def sweeping_the_journal(store) -> None:
    """Write out swallowed refusals even when nothing else happens.

    `record` flushes them on the way past, which covers a machine somebody is using. A machine
    nobody is using is exactly where a run of refusals matters most, and there is no next
    request to ride on.
    """
    while True:
        await asyncio.sleep(journal.QUIET_FOR)
        try:
            if store:
                journal.flush_swallowed(store)
        except Exception:
            pass


@contextlib.asynccontextmanager
async def announcing(app: FastAPI):
    """Announce this machine to a board, if it has been told about one."""
    cfg = app.state.cfg
    sweeper = asyncio.create_task(sweeping_the_journal(app.state.journal))
    task = None
    if getattr(cfg, "report_to", None):
        async def mine() -> dict:
            return await overview_of(app)
        task = asyncio.create_task(announce.keep_announcing(cfg, mine, app.state.socket))
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(
        title="Argus",
        version=VERSION,
        summary="Watch your agents run in tmux, and read what they produced.",
        description=ABOUT,
        openapi_tags=TAGS,
        # Under /api like everything else, which is what puts it behind the token: the
        # list of routes of a shell-access server is not a thing to hand out.
        openapi_url="/api/openapi.json",
        docs_url=None,
        redoc_url=None,
        license_info={"name": "MIT", "url": "https://github.com/andreaderuvo/argus/blob/master/LICENSE"},
        contact={"name": "Argus", "url": "https://github.com/andreaderuvo/argus"},
        lifespan=announcing,
    )
    app.state.cfg = cfg
    # When this process started, so a board can tell "the machine has been up for months"
    # apart from "this Argus came up ten minutes ago". Set here rather than in the lifespan
    # so it is right in tests too, which build the app without ever starting it.
    app.state.started = time.time()
    app.state.jail = Jail(cfg.roots)
    app.state.socket = tmux.Socket.new(cfg.tmux_socket)
    app.state.favourites = getattr(cfg, "favourites_store", None) or Path("/nonexistent")
    app.state.devices = cfg.devices_store or Path("/nonexistent")
    app.state.journal = cfg.journal_store
    app.state.lang = Path("/nonexistent")
    app.state.addresses = []

    app.state.proxied = set()          # ports opened by hand, this run only
    app.state.http = httpx.AsyncClient(timeout=30.0, follow_redirects=False)
    app.state.port = None
    app.state.host = None

    # Readable, stable names for the operations.
    #
    #  FastAPI builds them from the function and the method, and for the proxy — one
    #  function answering seven verbs — it walks a *set*, so the names came out in a
    #  different order on every run and the published copy of the spec never matched the
    #  code. These are derived from the verb and the path, which is both deterministic and
    #  far kinder to anyone generating a client: `getApiTmuxSessions`, not
    #  `sessions_api_tmux_sessions_get`.
    plain = app.openapi

    def described() -> dict:
        schema = plain()
        for path, operations in schema.get("paths", {}).items():
            for verb, operation in operations.items():
                words = [w for w in path.replace("{", "").replace("}", "").split("/") if w]
                operation["operationId"] = verb + "".join(
                    "".join(part.capitalize() for part in word.replace("-", "_").split("_"))
                    for word in words
                )
        return schema

    app.openapi = described

    app.include_router(files.router)
    app.include_router(proxy.router)
    app.include_router(bells.router)
    app.include_router(fsops.router, tags=["Writing"])
    app.include_router(paths.router, tags=["Prompts"])
    app.include_router(term.router, tags=["Sessions"])

    @app.get("/api/tmux/sessions", tags=["Sessions"], summary="Every tmux session on this server")
    async def sessions(request: Request) -> list[dict]:
        try:
            return await asyncio.to_thread(tmux.list_sessions, request.app.state.socket)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e

    @app.get("/api/languages", tags=["Setup"], summary="The interface languages available")
    async def list_languages(request: Request) -> list[dict]:
        return languages.available(BUILTIN_LANG, request.app.state.lang)

    @app.get("/api/language/{code}", tags=["Setup"], summary="One language catalogue")
    async def one_language(request: Request, code: str) -> dict:
        try:
            path = languages.locate(code, BUILTIN_LANG, request.app.state.lang)
        except languages.BadLanguage as e:
            raise ApiError(400, str(e)) from e
        entry = languages.read(path) if path else None
        if not entry:
            raise ApiError(404, f"no language called {code}")
        return entry

    @app.post("/api/language", tags=["Setup"], summary="Add or replace a language catalogue")
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

    @app.get("/api/favourites", tags=["Files"], summary="Pinned folders, kept on the server")
    async def list_favourites(request: Request) -> dict:
        return favourites.describe_all(favourites.load(request.app.state.favourites))

    @app.post("/api/favourites", tags=["Files"], summary="Pin or unpin a folder")
    async def toggle_favourite(request: Request, body: dict) -> dict:
        raw = str(body.get("path", ""))
        # Pinning is jailed like everything else: you cannot bookmark your way out.
        target = str(favourites_target(request, raw))
        group = favourites.group_of(body.get("group"))
        store = request.app.state.favourites
        paths, pinned = favourites.toggle(favourites.load(store), group, target)
        favourites.save(store, paths)
        return {"pinned": pinned, "group": group, "favourites": favourites.describe_all(paths)}

    @app.get("/api/stat", tags=["Files"], summary="Size and modification time, for watching a file")
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

    @app.post("/api/tmux/source", tags=["Setup"], summary="Hand the tmux config to every session, after trying it safely")
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

    @app.post("/api/tmux/style", tags=["Sessions"], summary="Dress one session, without touching the config")
    async def dress(request: Request, body: dict) -> dict:
        """Put a look on one session, live.

        A look in the config file belongs to the server and dresses everything; this
        dresses the session named and leaves the rest alone. Only style options are
        accepted, from a fixed list — see tmux.STYLE_OPTIONS.
        """
        name = await _known(request, str(body.get("session", "")))
        options = body.get("options")
        if not isinstance(options, dict):
            raise ApiError(400, "options must be an object")
        try:
            await asyncio.to_thread(tmux.style, request.app.state.socket, name, options)
        except tmux.TmuxError as e:
            raise ApiError(400, str(e)) from e
        return {"session": name, "set": sorted(options)}

    @app.get("/api/tmux/cwd", tags=["Sessions"], summary="The directory a session is really in")
    async def pane_directory(request: Request, session: str) -> dict:
        """Where this session actually is, and how well that is known.

        Not the same thing as the folder a desk was given: that one decides where a file
        browser lands and what a hand-over sentence says, while this is the directory the
        work is really happening in. Telling the other agent to look somewhere its
        counterpart never was is a whole round wasted.

        `cwd_source` says where the answer came from, best first — `agent` (the program said
        so, in the pane option `@argus_cwd`), `process` (read from the process that holds the
        terminal), `tmux` (tmux's own observation), `start` (the directory the pane was made
        in). `cwd_live` is false only for the last, which is history rather than news.
        """
        name = await _known(request, session)
        found = await asyncio.to_thread(paths.pane_where, request.app.state.socket, name)
        # Where the answer came from travels with it. A directory the agent declared, one
        # read off the process holding the terminal, one tmux observed, and the one the pane
        # was made in are four different degrees of true, and a browser that is told which
        # can say the right sentence instead of a plausible one.
        return {
            "session": name,
            "cwd": found["cwd"],
            "cwd_source": found["source"],
            "cwd_live": found["live"],
            # Where the pane was made, always, and not as a fallback: a session dragged onto
            # a desk keeps the folder it was born in, and that fact does not stop being true
            # when a better answer exists. Both are shown, so neither has to stand for the
            # other.
            "started_in": found["began"],
            "command": found["command"],
            # `command` is what tmux sees — often the wrapper, `node`. `agent` is what is
            # actually running in there, found by looking at the whole tty.
            "agent": found["agent"],
            "model": found["model"],
        }

    @app.get("/api/tmux/copymode", tags=["Sessions"], summary="Is this session showing history rather than the live end")
    async def read_copy_mode(request: Request, session: str) -> dict:
        """Is this session showing history rather than the live end?"""
        name = await _known(request, session)
        return await asyncio.to_thread(tmux.copy_mode, request.app.state.socket, name)

    @app.post("/api/tmux/copymode", tags=["Sessions"], summary="Back to the live end")
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

    @app.get("/api/tmux/buffer", tags=["Sessions"], summary="The last thing copied inside tmux")
    async def tmux_buffer(request: Request) -> dict:
        """The last thing copied inside tmux, so it can reach the device's clipboard."""
        try:
            text = await asyncio.to_thread(tmux.show_buffer, request.app.state.socket)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"text": text, "chars": len(text)}

    @app.post("/api/tmux/new", tags=["Sessions"], summary="Start a session")
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

    @app.post("/api/tmux/rename", tags=["Sessions"], summary="Rename a session")
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

    @app.post("/api/tmux/kill", tags=["Sessions"], summary="End a session")
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

    @app.get("/api/ports", tags=["Ports"], summary="What is listening, and what is holding it")
    async def list_ports(request: Request) -> dict:
        state = request.app.state
        return {
            "allow_proxy": state.cfg.allow_proxy,
            "open": sorted(state.proxied),
            "ports": await asyncio.to_thread(ports.listening, state.port),
        }

    @app.post("/api/ports", tags=["Ports"], summary="Open or close a port for proxying")
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

    @app.get("/api/system", tags=["The machine"], summary="CPU, memory, swap, GPUs, disks, uptime")
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

    @app.get("/api/version", tags=["Setup"], summary="What is running here, and whether anything newer exists")
    async def version(request: Request) -> dict:
        """Answers immediately from a day-old cache; the question is only asked of GitHub
        when that cache is stale. Switched off, it answers about this machine and stops
        there, which is also what it does when there is no way out to the network."""
        cfg = request.app.state.cfg
        if not cfg.check_releases:
            return {"running": VERSION, "latest": None, "url": None, "newer": False, "checked": 0}
        return await release.look(request.app.state, VERSION)

    @app.get("/api/overview", tags=["The machine"],
             summary="What is happening on this machine, in one cheap call")
    async def overview(request: Request) -> dict:
        """Everything a board watching several machines needs, and nothing it does not.

        This is the one door a watcher token opens, and the same answer a machine
        announces to a board that cannot reach it.
        """
        return await overview_of(request.app, request.scope.get("argus_watcher"))

    @app.get("/api/devices", tags=["Setup"], summary="The devices that may get in")
    async def list_devices(request: Request) -> list[dict]:
        """Names, when each was added and when each was last used. Never the tokens: only a
        hash of those is kept, and the plain form existed once, when it was created."""
        return devices.public(devices.load(request.app.state.devices))

    @app.post("/api/devices", tags=["Setup"], summary="Give a device its own token")
    async def add_device(request: Request, body: dict) -> dict:
        """Mints one and returns it **once**. There is no way to see it again — the file holds
        only a hash — which is the same bargain GitHub makes for a personal access token, and
        for the same reason.

        Only the token in the config may do this. A device cannot mint another, so a phone
        that is lost cannot be used to grow its own foothold.
        """
        try:
            entry, plain = devices.add(request.app.state.devices, str(body.get("name") or ""))
        except devices.DeviceError as e:
            raise ApiError(400, str(e)) from e
        return {
            "device": devices.public([entry])[0],
            "token": plain,
            "link": url_for(app.state.host or "127.0.0.1", app.state.port or 0, cfg).replace(
                cfg.token, plain),
        }

    @app.post("/api/devices/{device_id}", tags=["Setup"], summary="Rename a device")
    async def rename_device(request: Request, device_id: str, body: dict) -> dict:
        """The token is untouched: this is the label, not the key. Renaming does not sign
        anything out, which is the whole reason it is a separate action from revoking."""
        try:
            now = devices.rename(request.app.state.devices, device_id, str(body.get("name") or ""))
        except devices.DeviceError as e:
            raise ApiError(400 if "already" in str(e) or "needs a name" in str(e) else 404,
                           str(e)) from e
        return {"device": devices.public([now])[0]}

    @app.delete("/api/devices/{device_id}", tags=["Setup"], summary="Take a device's token back")
    async def drop_device(request: Request, device_id: str) -> dict:
        """Takes effect on the next request that device makes: the file is re-read every time
        a token is presented, precisely so that revoking is not something you have to restart
        for."""
        try:
            gone = devices.revoke(request.app.state.devices, device_id)
        except devices.DeviceError as e:
            raise ApiError(404, str(e)) from e
        return {"revoked": gone["name"]}

    @app.delete("/api/journal", tags=["Setup"], summary="Empty the journal, or the old part of it")
    async def clear_journal(request: Request, older_than: int | None = None) -> dict:
        """Everything, or everything before a cutoff given in seconds.

        The deletion is recorded like any other change — the middleware sees this request and
        writes it down — so the journal always says that it was emptied, when, and from where.
        """
        gone = journal.clear(request.app.state.journal, older_than if older_than else None)
        journal.note(request.scope, f"{gone} entries" + (f" older than {older_than}s" if older_than else ""))
        return {"ok": True, "removed": gone}

    @app.get("/api/journal", tags=["Setup"], summary="What has been done here, and what was refused")
    async def read_journal(request: Request, limit: int = 200) -> dict:
        """Most recent first. Only the token from the config may read it: a record that a
        possibly-stolen device can read is a record that tells whoever took it what you can see.
        """
        kept = journal.read(request.app.state.journal, max(1, min(int(limit), 500)))
        return {
            "entries": kept,
            # Attempts, not lines: a collapsed burst is one line and many knocks, and the
            # number a person reads at the top has to be the number of knocks.
            "refused": sum(e.get("times", 1) for e in kept if e.get("refused")),
            "since": kept[-1]["at"] if kept else None,
        }

    @app.get("/api/runnable", tags=["The machine"],
             summary="What this machine offers to start and stop")
    async def runnable(request: Request) -> list[dict]:
        """The names, and whether each is up right now. Not the commands.

        A board needs to know what it may ask for and what is already happening; it has no
        use for the shell line, and every extra thing on the wire is one more thing a leaked
        board leaks.
        """
        return runner.offered(cfg.runnable, request.app.state.socket)

    @app.post("/api/runnable/{name}/{action}", tags=["The machine"],
              summary="Start or stop one of them")
    async def run_one(request: Request, name: str, action: str) -> dict:
        """`action` is start or stop, and `name` must be something this machine published.

        No command arrives in this request and none ever will. That is what keeps a watcher
        token nearly worthless: the worst anything holding it can do is start or stop what is
        written in this machine's own config.
        """
        try:
            return await asyncio.to_thread(
                runner.act, cfg.runnable, request.app.state.socket, name, action)
        except runner.NotAllowed as e:
            raise ApiError(404, str(e)) from e
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e

    @app.post("/api/shutdown", tags=["The machine"], summary="Stop this Argus")
    async def shutdown(request: Request) -> dict:
        """Stops the server. Nothing here can start it again.

        That asymmetry is the whole character of this endpoint: every tmux session carries on
        untouched — Argus is a client, not their parent — but the only way back to this page
        is a shell on this machine, or a supervisor that restarts it. Which is why it takes
        `may_stop_argus` on top of `may_run`, and why the answer says so.
        """
        # Answered first, then stopped: a caller that gets a dropped connection cannot tell
        # "it worked" from "it was never reachable", and this is not a thing to be unsure of.
        async def bye() -> None:
            await asyncio.sleep(0.35)
            # SIGTERM rather than os._exit: uvicorn runs its shutdown, the lifespan closes
            # the http client and stops announcing, and open websockets are closed properly.
            os.kill(os.getpid(), signal.SIGTERM)

        asyncio.create_task(bye())
        return {
            "stopping": True,
            "sessions_keep_running": True,
            "how_to_start_it_again": "a shell on this machine, or the service that supervises it",
        }

    # Registered last so it never shadows the API: unknown paths are the frontend's.
    @app.get("/{requested:path}", include_in_schema=False)
    async def static_handler(requested: str) -> Response:
        return serve_static(requested)

    @app.middleware("http")
    async def say_nothing_outward(request: Request, call_next):
        """Follow a link out of here and the other end learns nothing about this machine.

        The token is already stripped from the address bar on load, so it was never in a
        Referer; what remains is the address itself, and a private one is still worth not
        handing to github.com because somebody clicked the link in the header.
        """
        answer = await call_next(request)
        answer.headers.setdefault("referrer-policy", "no-referrer")
        return answer

    app.add_middleware(TokenAuthMiddleware, token=cfg.token, watchers=cfg.watchers,
                       devices_store=cfg.devices_store)
    # Added *after* the auth middleware, so it runs *outside* it — Starlette wraps in reverse
    # order — and therefore sees the `argus_master` / `argus_device` / `argus_watcher` that auth
    # put on the scope. Written here rather than in twenty handlers so a route added next month
    # is recorded without anybody remembering to.
    app.add_middleware(JournalMiddleware, store_of=lambda: app.state.journal)
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
    """The link to open, with the token in the fragment rather than the query.

    `#token=` is never sent to the server. Not in the request line, so not in an access log,
    not in the log of any proxy on the way, and not in a `Referer` — where `?token=` is in all
    three. The page reads it from `location.hash` and scrubs it out of the bar.

    The query form is still accepted, because links and QR codes already saved on people's
    phones have to keep working; it is simply no longer the one printed.
    """
    scheme = "https" if cfg.tls() else "http"
    # 0.0.0.0 is not a usable destination — show a loopback URL and let the banner
    # mention that it is reachable from the network too.
    shown = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    return f"{scheme}://{shown}:{port}/#token={cfg.token}"


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


def tmux_version() -> str | None:
    """What `tmux -V` says, or None if there is no tmux here.

    Worth asking once, at startup, rather than finding out one failed request at a time. The
    banner used to print happily on a machine with no tmux at all, and then every session
    screen was empty with an error nobody reads — the same shape of bug as a missing
    `python-multipart`, which also only showed up on a clean machine.
    """
    where = shutil.which("tmux")
    if not where:
        return None
    try:
        done = subprocess.run([where, "-V"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    said = (done.stdout or done.stderr or "").strip()
    return said or "tmux"


def banner(config_path: Path, created: bool, host: str, port: int, cfg: Config, sock: tmux.Socket) -> None:
    print(f"argus {VERSION}")
    print(f"  created {config_path} with a fresh token" if created else f"  config  {config_path}")
    shown = [str(r) for r in cfg.roots]
    print(f"  roots   {', '.join(shown[:4])}{f' (+{len(shown) - 4} more)' if len(shown) > 4 else ''}")
    print(f"  resize  {cfg.resize_policy}")
    # Not fatal: files, documents and the machine page work without it, and refusing to
    # start would take those away over something half the screens do not need. But it is
    # said plainly, because the half that does need it is the reason most people are here.
    version = tmux_version()
    if version:
        print(f"  tmux    {version}, socket {sock.label()}")
    else:
        print(f"  tmux    NOT FOUND — no sessions and no terminals until it is installed")
        print(f"          (files, documents and the machine page work regardless)")
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
            url = f"{scheme}://{address}:{port}/#token={cfg.token}"
            print(f"\n  {url}\n")
            print_qr(url)
        return 0

    # Before the app is built: the auth middleware takes this path at construction, because
    # it re-reads the file on every attempt so that revoking a device takes effect at once.
    cfg.devices_store = devices.default_store(config_path)
    cfg.journal_store = journal.default_store(config_path)

    try:
        app = create_app(cfg)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    app.state.favourites = favourites.default_store(config_path)
    app.state.lang = config_path.parent / "lang"
    app.state.port = port
    app.state.host = host
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
        # Stopping used to take a minute and a half — the service's kill timeout, every
        # time. Not a hang: uvicorn's shutdown waits for open connections to end, and this
        # app is *made* of connections that never end. A terminal's WebSocket stays open as
        # long as the terminal is on screen, and the bell stream is by definition endless,
        # so "wait for the clients to finish" waits for people to close browser tabs.
        #
        # Three seconds, then it closes them itself. Nothing is lost by cutting a terminal's
        # socket: the tmux session it is attached to does not care, and the page reconnects
        # on its own — which is now the difference between a restart you wait out and one
        # you barely notice.
        timeout_graceful_shutdown=3,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
