"""CLI entry point: load the config, build the app, serve it."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import mimetypes
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, Response

from . import (announce, asks, bells, devices, favourites, files, fsops, gitwork, journal, languages,
               launch, mounts, network, paths, ports, prefs, proxy, release, runner, runs,
               system, term, tmux, todo)
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

    # And the orchestrations, if any are running. A summary and never the graph: a board
    # sweeping ten machines every five seconds wants "three of four, one asking", and the
    # picture belongs on the machine where you can act on it. Absent entirely when nothing is
    # running, for the same reason `agent` is absent below — a key that is null everywhere
    # is a payload paying for a feature nobody switched on.
    watching = []
    for kept_run in getattr(app.state, "runs", {}).values():
        # Through the same reading as the page's: one place decides that a run has lost touch.
        run = runs.as_told(kept_run)
        agents = [a for step in run["steps"] for a in step["agents"]]
        watching.append({
            "id": run["id"],
            "name": run["name"],
            "state": run["state"],
            "done": sum(1 for a in agents if a["state"] == "done"),
            "agents": len(agents),
            "asking": sum(1 for a in agents if a["state"] == "asking"),
            "lost": sum(1 for a in agents if a["state"] == "lost"),
        })

    return {
        "name": os.uname().nodename,
        "version": VERSION,
        "runnable": offers,
        **({"runs": sorted(watching, key=lambda r: (r["state"] != "running", r["name"]))}
           if watching else {}),
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


DAY = 86400


async def sweeping_the_drops(app: FastAPI) -> None:
    """Take out the old drops, if a number of days has been set.

    Once when the server starts and once a day after that. Not on a timer inside the drop
    itself: a machine left running for a month should still be tidying, and a machine
    restarted every morning should not have to wait until the evening for its first sweep.

    Every file it removes is named in the log. This deletes without asking — that is what
    was asked for — so what it did has to be readable afterwards.
    """
    while True:
        cfg = app.state.cfg
        folder = cfg.drops()
        if cfg.drop_keep_days and folder:
            try:
                gone = await asyncio.to_thread(fsops.sweep_drops, folder, cfg.drop_keep_days)
                for one in gone:
                    print(f"drops: removed {one} (older than {cfg.drop_keep_days} days)", flush=True)
            except Exception as e:                          # a tidy-up must never take the server with it
                print(f"drops: sweep failed: {e}", file=sys.stderr, flush=True)
        await asyncio.sleep(DAY)


@contextlib.asynccontextmanager
async def announcing(app: FastAPI):
    """Announce this machine to a board, if it has been told about one."""
    cfg = app.state.cfg
    sweeper = asyncio.create_task(sweeping_the_journal(app.state.journal))
    drops = asyncio.create_task(sweeping_the_drops(app))
    task = None
    if getattr(cfg, "report_to", None):
        async def mine() -> dict:
            return await overview_of(app)
        task = asyncio.create_task(announce.keep_announcing(cfg, mine, app.state.socket))
    try:
        yield
    finally:
        for one in (sweeper, drops):
            one.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await one
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
    app.state.todo = getattr(cfg, "todo_store", None) or Path("/nonexistent")
    app.state.prefs = getattr(cfg, "prefs_store", None) or Path("/nonexistent")
    app.state.devices = cfg.devices_store or Path("/nonexistent")
    app.state.journal = cfg.journal_store
    app.state.lang = Path("/nonexistent")
    app.state.config_path = None
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
    app.include_router(asks.router)
    app.include_router(runs.router)
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

    @app.get("/api/prefs", tags=["Setup"], summary="Everything the browser remembers, from here")
    async def read_prefs(request: Request) -> dict:
        """The desks, the windows and where they sit, the prompt library, the placeholder sets,
        the shortcuts, the theme — the sixty keys that used to live only in one browser's
        storage.

        Two things become possible by moving them here, and they are the two people ask for: a
        desk made at the desk exists on the phone, and something that is not a browser can read
        the workspace — a script that wants the prompt library, an agent that has just started
        three jobs and could lay out a desk to watch them in.

        The version comes with the document and is what a full replacement has to present.
        """
        version, doc = prefs.load(request.app.state.prefs)
        return {"version": version, "prefs": doc}

    @app.get("/api/since", tags=["Setup"], summary="What happened while you were not looking")
    async def what_happened(request: Request, at: float, folder: list[str] = Query(default=[])) -> dict:
        """Everything that changed since a moment, in one answer.

        The question this app exists for is not "what is happening" — a screen full of
        terminals already says that, and says it whether or not any of it is new. It is "did
        anything happen while I was away, and does it need me". That question can only be
        answered by the machine: the browser was closed.

        Four sources, because four different things count as news. An agent that rang. A
        session that appeared. An orchestration that ended or is stuck on a question. And
        files that were written — which is the only evidence there is that a job produced
        something, and the one thing none of the others can tell you.

        The folders are the caller's business: the desks are the browser's idea, not this
        server's, so it says which ones it cares about rather than being second-guessed. One
        that has gone, or that points outside the roots, is skipped rather than refused —
        this is a summary, and a summary that 404s because one desk moved is no summary.
        """
        state = request.app.state
        now = time.time()
        seen = max(0.0, float(at))

        rung = [b for b in bells.store(request)["list"] if b["at"] >= seen]

        try:
            live = await asyncio.to_thread(tmux.list_sessions, state.socket)
        except tmux.TmuxError:
            live = []
        fresh = [s for s in live if s.get("created", 0) >= seen]

        # Ended while you were away, or waiting on an answer — both are reasons to look.
        told = [runs.as_told(r, now) for r in runs.store(request).values()]
        worth = [r for r in told if r["state"] != "running"
                 or any(a.get("state") == "asking" for step in r.get("steps", [])
                        for a in step.get("agents", []))]

        written: list[dict] = []
        looked: list[str] = []
        for raw in dict.fromkeys(folder):            # the same desk folder twice is one walk
            try:
                where = under_roots(request, raw)
            except ApiError:
                continue
            if not where.is_dir():
                continue
            looked.append(str(where))
            written.extend(await asyncio.to_thread(files.changed_since, where, seen))

        # Newest first across every folder, and deduplicated: two desks in the same tree
        # would otherwise report the same file twice.
        unique = {f["path"]: f for f in written}
        newest = sorted(unique.values(), key=lambda f: -f["mtime"])[:40]

        return {
            "at": seen,
            "now": now,
            "bells": rung,
            "sessions": sorted(fresh, key=lambda s: -s.get("created", 0)),
            "runs": sorted(worth, key=lambda r: -r.get("at", 0)),
            "files": newest,
            "folders": looked,
        }

    @app.post("/api/drops/keep", tags=["Writing"], summary="How long a dropped file is kept")
    async def set_drops_keep(request: Request, body: dict) -> dict:
        """Set `drop_keep_days`, write it to the config, and sweep straight away.

        A setting rather than a button, and one of the very few the browser may change: it
        decides that files get deleted, so it belongs in the file everybody reads to find out
        what this server does, next to `drop_dir` — not in the preferences, which are the
        browser's own memory and are not where anybody would look for "why did my file go".

        Only one key is written, and only this one. The config is a document people edit by
        hand and comment; re-dumping it to change a number would quietly erase what they
        wrote, so the line is replaced in place.
        """
        state = request.app.state
        if not state.cfg.allow_write:
            raise ApiError(403, "this server is read-only — start it with --allow-write to change that")
        try:
            days = int(body.get("days"))
        except (TypeError, ValueError):
            raise ApiError(400, "`days` must be a whole number of days, 0 for keeping everything") from None
        if days < 0 or days > 3650:
            raise ApiError(400, "`days` must be between 0 and 3650")
        if days and not state.cfg.drops():
            raise ApiError(400, "there is no `drop_dir` to sweep")
        if not state.config_path:
            raise ApiError(409, "this server was not started from a config file")

        state.cfg.set_in_file(Path(state.config_path), "drop_keep_days", days)
        # At once, rather than at the next daily sweep: somebody who just typed 7 wants to
        # know what that means for the folder they are looking at, not tomorrow.
        gone = await asyncio.to_thread(fsops.sweep_drops, state.cfg.drops(), days) if days else []
        for one in gone:
            print(f"drops: removed {one} (older than {days} days)", flush=True)
        return {"ok": True, "days": days, "removed": len(gone)}

    @app.patch("/api/prefs", tags=["Setup"], summary="Change some of them, leaving the rest alone")
    async def patch_prefs(request: Request, body: dict) -> dict:
        """Merge the keys you send into whatever is there now, and nothing else.

        This is how the browser saves, and the reason it is a merge rather than a replacement:
        last-write-wins on the whole document loses a desk made on the phone the moment a laptop
        saves an older copy of everything. Two devices changing different keys both keep their
        change; two devices changing the same key still resolve to the last one, and there is no
        honest way around that without asking somebody which they meant.

        A key sent as `null` is removed, which is how a browser says it has stopped keeping
        something.
        """
        changes = body.get("changes")
        if not isinstance(changes, dict):
            raise ApiError(400, "send {changes: {key: value}} — a null value removes a key")
        store = request.app.state.prefs
        version, doc = prefs.load(store)
        try:
            prefs.save(store, version + 1, prefs.merge(doc, changes))
        except (ValueError, OSError) as e:
            raise ApiError(413 if isinstance(e, ValueError) else 500, str(e)) from e
        return {"version": version + 1, "changed": sorted(changes)}

    @app.put("/api/prefs", tags=["Setup"], summary="Replace the whole document")
    async def put_prefs(request: Request, body: dict) -> dict:
        """The whole thing at once — an import, a restore, a browser adopting a machine that has
        nothing yet.

        It must present the version it believes it is replacing. A mismatch is a 409 carrying the
        current document, so the caller can look at what changed underneath rather than
        discovering later that an afternoon of window-moving went away. `version: 0` is "there
        should be nothing here", which is exactly what a first upload means.
        """
        doc = body.get("prefs")
        if not isinstance(doc, dict):
            raise ApiError(400, "send {version: n, prefs: {…}}")
        store = request.app.state.prefs
        version, current = prefs.load(store)
        if int(body.get("version", -1)) != version:
            raise ApiError(409, f"this is version {version}, not {body.get('version')} — "
                                "read it again and merge")
        try:
            prefs.save(store, version + 1, doc)
        except (ValueError, OSError) as e:
            raise ApiError(413 if isinstance(e, ValueError) else 500, str(e)) from e
        return {"version": version + 1}

    @app.get("/api/todo", tags=["Setup"], summary="The list of things to do")
    async def list_todo(request: Request) -> dict:
        """Kept on the server rather than in the browser, so the note you wrote at the desk is
        on the phone as well. That is the whole reason it is here and not in the preferences."""
        return {"items": todo.load(request.app.state.todo)}

    @app.post("/api/todo", tags=["Setup"], summary="Add something to do")
    async def add_todo(request: Request, body: dict) -> dict:
        store = request.app.state.todo
        try:
            items, made = todo.add(todo.load(store), str(body.get("note", "")),
                                   str(body.get("status", "open")))
        except ValueError as e:
            raise ApiError(400, str(e)) from e
        todo.save(store, items)
        return made

    @app.patch("/api/todo/{ident}", tags=["Setup"], summary="Change one: its words or its state")
    async def edit_todo(request: Request, ident: str, body: dict) -> dict:
        store = request.app.state.todo
        try:
            items, found = todo.change(todo.load(store), ident,
                                       body.get("note"), body.get("status"))
        except ValueError as e:
            raise ApiError(400, str(e)) from e
        if not found:
            raise ApiError(404, "there is nothing here with that id")
        todo.save(store, items)
        return found

    @app.delete("/api/todo/{ident}", tags=["Setup"], summary="Take one off the list")
    async def drop_todo(request: Request, ident: str) -> dict:
        store = request.app.state.todo
        items, gone = todo.remove(todo.load(store), ident)
        if not gone:
            raise ApiError(404, "there is nothing here with that id")
        todo.save(store, items)
        return {"removed": ident}

    @app.get("/api/favourites", tags=["Files"], summary="Pinned folders, kept on the server")
    async def list_favourites(request: Request) -> dict:
        return favourites.describe_all(favourites.load(request.app.state.favourites))

    @app.post("/api/favourites", tags=["Files"], summary="Pin or unpin a folder")
    async def toggle_favourite(request: Request, body: dict) -> dict:
        """Pinning is jailed; unpinning is not, and the difference is the whole of this.

        A favourite is a folder somebody kept. Folders get renamed, moved and deleted, and the
        pin outlives them — which is fine, it goes grey and says so. What was not fine is that
        removing it went through the jail too, and the jail refuses a path that is not there.
        So the one favourite you certainly want gone was the one that could not be removed.
        Reported exactly that way.

        Taking something *off* a list needs no path on disk: the entry was jailed on the way
        in, so matching the stored string is enough and nothing can be smuggled by it. Putting
        one *on* still resolves strictly — you cannot bookmark your way out, and a typo should
        not become a favourite.
        """
        raw = str(body.get("path", ""))
        group = favourites.group_of(body.get("group"))
        store = request.app.state.favourites
        paths = favourites.load(store)

        target = raw if raw in paths.get(group, []) else str(favourites_target(request, raw))
        paths, pinned = favourites.toggle(paths, group, target)
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
            where = str(under_roots(request, str(where)))

        try:
            await asyncio.to_thread(tmux.run, tmux.new_argv(state.socket, name, where))
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"name": name, "path": where}

    @app.get("/api/who", tags=["Sessions"],
             summary="What is on this machine, in one answer, for an agent")
    async def who(request: Request) -> dict:
        """The one call an agent makes first.

        The same facts the browser assembles from four requests, put together on this side: the
        sessions, who is in each one and in which folder, which of them are asking for a person,
        and where the machine is. An agent that has to make four calls to find out who else is
        working will make none.
        """
        state = request.app.state
        try:
            sessions = await asyncio.to_thread(tmux.list_sessions, state.socket)
        except Exception:
            sessions = []
        try:
            said = await asyncio.to_thread(tmux.declared, state.socket)
        except Exception:
            said = {}
        # Who has rung and not been answered, as far as this server knows: the last bell each
        # session rang, kept if it was a question rather than a finish. `asking` is the whole
        # point of the call — an agent deciding whether to bother somebody wants to know if
        # somebody is already being bothered.
        rung = getattr(state, "bells", None) or {}
        waiting = set()
        for bell in list(rung.get("list", [])):
            if not bell.get("session"):
                continue
            if bell.get("why") == "asking":
                waiting.add(bell["session"])
            else:
                waiting.discard(bell["session"])
        out = []
        for one in sessions:
            name = one["name"]
            told = said.get(name) or {}
            out.append({
                "name": name,
                "windows": one.get("windows"),
                "attached": bool(one.get("attached")),
                "agent": told.get("agent"),
                "model": told.get("model"),
                "folder": told.get("cwd"),
                "wants_you": name in waiting,
            })
        return {
            "machine": os.uname().nodename,
            "sessions": out,
            "asking": [x["name"] for x in out if x["wants_you"]],
            "launchers": [one.name for one in launch.configured(state.cfg)],
        }

    # How many sentences may be pushed into other sessions in a minute, and how many things may
    # be started in one. Not a security boundary — the launcher list is that — but a brake on the
    # failure this arrangement invites: A pokes B, B pokes A, and by morning there are nine
    # hundred lines of two robots talking.
    #
    # The launch number was six and that was wrong: a runaway loop does hundreds, while a
    # deliberate fan-out — four referees and an editor, three roles on one repository — is five
    # or eight in a few seconds, and hitting a wall halfway through leaves half an orchestra
    # running. Measured against the examples in `scripts/`: two of the three tripped it.
    # Twelve, and both are config keys, because whoever runs a fan-out of twenty knows they are.
    RELAY_A_MINUTE = int(getattr(cfg, "relay_a_minute", 0) or 30)
    STARTS_A_MINUTE = int(getattr(cfg, "launches_a_minute", 0) or 12)
    lately: dict[str, list[float]] = {}

    def too_fast(kind: str, cap: int) -> bool:
        now = time.time()
        seen = [t for t in lately.get(kind, []) if now - t < 60]
        seen.append(now)
        lately[kind] = seen
        return len(seen) > cap

    @app.post("/api/relay", tags=["Sessions"],
              summary="Hand a sentence to another session, the way a person would")
    async def relay(request: Request, body: dict) -> dict:
        """Type text into another session, and press return if asked.

        This is what the browser does when you drop a prompt onto a terminal, offered to the
        thing already sitting in a session: *I have finished, go and look*. It carries text and
        not a prompt from the library, because the library lives in the browser — an agent that
        wants a template can read it out of the desk it belongs to, or simply write the
        sentence, which is what it is good at.

        The same care as everywhere else: bracketed paste, and the return as a separate write a
        moment later, or an input box that reads writes rather than lines swallows it.
        """
        state = request.app.state
        to = str(body.get("to", "")).strip()
        text = str(body.get("text", ""))
        if not to or not text:
            raise ApiError(400, "relay wants `to` (a session) and `text`")
        if not await asyncio.to_thread(tmux.session_exists, state.socket, to):
            raise ApiError(404, f"there is no session called {to}")
        if too_fast("relay", RELAY_A_MINUTE):
            raise ApiError(429, f"more than {RELAY_A_MINUTE} relays in a minute — something is "
                                "talking to itself; nothing was sent. Raise `relay_a_minute` in "
                                "the config if you meant it.")
        try:
            await asyncio.to_thread(launch.seed, state.socket, to, text, bool(body.get("run")))
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e
        return {"to": to, "characters": len(text), "sent": bool(body.get("run"))}

    @app.get("/api/launchers", tags=["Sessions"], summary="What this machine can start")
    async def launchers(request: Request, versions: bool = False) -> dict:
        """The list a browser is allowed to pick from, and whether each one is really here.

        `available` is `null` when the answer is not knowable: a command with a pipe or a
        `&&` in it is a shell line rather than a program, and checking the PATH for it would
        be a guess dressed as a fact.

        `?versions=1` also runs each of them with `--version`, which is a second question and
        deliberately a second request: finding out a word is on the PATH is free, and starting
        three node programs to ask their version costs about two seconds. The box appears with
        its choices; the versions arrive after and fill themselves in.
        """
        # One shell for the lot, and remembered: asked one at a time this took 2.9 seconds,
        # which is a button that looks broken and then works.
        return {"launchers": await asyncio.to_thread(launch.describe, request.app.state.cfg, versions)}

    @app.post("/api/tmux/launch", tags=["Sessions"], summary="Start an agent, with its first instruction")
    async def launch_agent(request: Request, body: dict) -> dict:
        """Create a session, start a launcher in it, wait for it to settle, type the prompt.

        Only a launcher **named in the config** can be started, which is what keeps this from
        being "run anything" — the terminal next to it always was, but an endpoint that takes
        a command line is a different thing to leave on a network.

        The return says what actually happened rather than only that it worked: whether the
        thing settled before the wait ran out, and whether the return was pressed. A prompt
        typed into an agent that was still drawing its banner is the failure this is designed
        around, so when `ready` is false the text is left sitting there unsent, for you.
        """
        state = request.app.state
        chosen = launch.named(state.cfg, str(body.get("launcher", "")))
        if not chosen:
            raise ApiError(400, "no launcher of that name — see /api/launchers")

        try:
            name = tmux.check_name(str(body.get("name", "")))
        except tmux.BadName as e:
            raise ApiError(400, str(e)) from e
        if await asyncio.to_thread(tmux.session_exists, state.socket, name):
            raise ApiError(409, f"a session called {name} is already there")

        where = body.get("path")
        if where:
            where = str(under_roots(request, str(where)))

        if too_fast("start", STARTS_A_MINUTE):
            raise ApiError(429, f"more than {STARTS_A_MINUTE} launches in a minute — nothing was "
                                "started. A machine fills up quietly; raise `launches_a_minute` "
                                "in the config if this is a fan-out you meant.")
        try:
            await asyncio.to_thread(launch.start, state.socket, name, where, chosen.command)
        except tmux.TmuxError as e:
            raise ApiError(502, str(e)) from e

        prompt = str(body.get("prompt") or "")
        wants_return = bool(body.get("run"))
        settled = None
        if prompt:
            if body.get("wait", True) and chosen.command.strip():
                # The request is held while this waits, which is why the cap here is twelve
                # seconds rather than the module's own twenty-five: a browser on a train should
                # not be holding a POST open while an agent thinks. Ask for longer with
                # `wait_seconds` when you are driving this from a script and do not care.
                patience = float(body.get("wait_seconds") or 12)
                settled = await asyncio.to_thread(launch.wait_until_settled, state.socket, name,
                                                  min(max(patience, 1.0), 60.0))
            else:
                settled = True
            # Never the return into something still drawing: the text goes in either way, and
            # an unsettled launcher keeps the Enter for the person watching.
            await asyncio.to_thread(launch.seed, state.socket, name, prompt,
                                    wants_return and bool(settled))
        # And, if asked, tell whoever has the app open that it is there.
        #
        # Not by writing into their desks from here: the arrangement of a desk belongs to the
        # browser, and a server appending a window to a document the browser is also editing is
        # a merge conflict waiting for the one moment you are dragging something. It says a
        # session started; each open page decides, and the page that started it from its own
        # New-session sheet never asks for this because it has already put the window where it
        # wanted it.
        if body.get("desk"):
            bells.announce(request, {"what": "started", "name": name, "launcher": chosen.name})
        return {
            "name": name,
            "path": where,
            "launcher": chosen.name,
            "command": chosen.command,
            "seeded": bool(prompt),
            "ready": settled,
            "sent": bool(prompt) and wants_return and bool(settled),
        }

    @app.get("/api/git/worktrees", tags=["Sessions"], summary="The working directories of a repository")
    async def list_worktrees(request: Request, path: str) -> dict:
        state = request.app.state
        here = under_roots(request, path)
        top = await asyncio.to_thread(gitwork.top_of, here)
        if not top:
            return {"repo": None, "worktrees": []}
        try:
            found = await asyncio.to_thread(gitwork.worktrees, top)
        except gitwork.GitError as e:
            raise ApiError(502, str(e)) from e
        return {"repo": str(top), "worktrees": found}

    @app.post("/api/git/worktree", tags=["Sessions"], summary="Add a working directory on its own branch")
    async def add_worktree(request: Request, body: dict) -> dict:
        """A second checkout of the same repository, on its own branch.

        Writing, so it needs `--allow-write`: it makes a directory, and one that git will go
        on believing in until somebody removes it properly.
        """
        state = request.app.state
        if not state.cfg.allow_write:
            raise ApiError(403, "this server is read-only — start it with --allow-write to change that")
        here = under_roots(request, str(body.get("path", "")))
        top = await asyncio.to_thread(gitwork.top_of, here)
        if not top:
            raise ApiError(400, f"{here} is not inside a git repository")
        if too_fast("worktree", STARTS_A_MINUTE):
            raise ApiError(429, f"more than {STARTS_A_MINUTE} worktrees in a minute — nothing was "
                                "made. A disk fills up quietly; `launches_a_minute` raises this "
                                "too.")
        try:
            branch = launch.check_branch(str(body.get("branch", "")))
        except ValueError as e:
            raise ApiError(400, str(e)) from e

        wanted = body.get("to")
        target = Path(str(wanted)) if wanted else gitwork.suggested_path(top, branch)
        # Where a worktree may go is where anything else may go: inside the roots. Otherwise
        # Argus would make a checkout it cannot then browse, edit or open a session in.
        try:
            state.jail.resolve(str(target.parent))
        except PathError:
            raise ApiError(403, f"{target} would be outside the configured roots") from None

        try:
            made = await asyncio.to_thread(gitwork.add, top, target, branch)
        except gitwork.GitError as e:
            raise ApiError(409, str(e)) from e
        return made

    @app.delete("/api/git/worktree", tags=["Sessions"], summary="Remove a working directory")
    async def drop_worktree(request: Request, path: str, force: bool = False) -> dict:
        state = request.app.state
        if not state.cfg.allow_write:
            raise ApiError(403, "this server is read-only — start it with --allow-write to change that")
        here = under_roots(request, path)
        top = await asyncio.to_thread(gitwork.top_of, here)
        if not top:
            raise ApiError(400, f"{here} is not inside a git repository")
        if Path(str(top)) == Path(str(here)):
            raise ApiError(400, "that is the repository itself, not one of its worktrees")
        try:
            await asyncio.to_thread(gitwork.remove, top, here, force)
        except gitwork.GitError as e:
            raise ApiError(409, str(e)) from e
        return {"removed": str(here)}

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

    @app.get("/api/network", tags=["The machine"],
             summary="Where this machine is, where you are, and the ssh line between them")
    async def where_we_are(request: Request) -> dict:
        """Read entirely from this machine and this request — no network call, ever.

        The machine's own address comes from asking the kernel which source it would use for
        the default route, which sends nothing. Yours comes from the socket the request arrived
        on, which the server was holding anyway. The public address is deliberately *not* here:
        it needs a stranger, so it needs a press — see `/api/network/outside`.
        """
        peer, claimed = journal.where_from(request.scope)
        said = network.summary(int(getattr(request.app.state, "port", 0) or 0), peer, claimed)
        said["may_ask_outside"] = bool(request.app.state.cfg.ask_outside)
        said["would_ask"] = network.OUTSIDE[0]
        return said

    @app.post("/api/network/outside", tags=["The machine"],
              summary="Ask a stranger what this machine's public address is")
    async def from_outside(request: Request) -> dict:
        """The only thing in Argus that tells somebody else anything, and it is a POST for that
        reason: it is an action with a consequence, not a reading.

        Asking a service "what is my address" *is* telling that service your address, which is
        why nothing here does it on a timer, on load, or on anybody's behalf. The answer is
        returned and not written down: no cache, no config, no journal entry beyond the fact
        that the route was called, which the journal records for every route anyway.
        """
        cfg = request.app.state.cfg
        if not cfg.ask_outside:
            raise ApiError(403, "this machine is set not to ask anybody — `ask_outside: false`")
        for who in network.OUTSIDE:
            try:
                async with httpx.AsyncClient(timeout=6) as client:
                    got = await client.get(who, headers={"user-agent": f"argus/{VERSION}"})
                said = got.text.strip()
                if got.status_code == 200 and 6 < len(said) < 46:
                    return {"address": said, "asked": who}
            except (httpx.HTTPError, OSError):
                continue
        raise ApiError(502, "nobody answered — no way out, or both services are down")

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

    @app.get("/api/docs", include_in_schema=False)
    async def api_docs() -> Response:
        """Swagger UI, vendored, behind the token.

        FastAPI serves this in one line and that line fetches its JavaScript from a CDN, which
        is the one thing this project does not do — Argus runs on machines with no way out, and
        a documentation page that needs the internet is a documentation page that is not there
        when you need it. So the bundle sits in `static/vendor/` like xterm and pdf.js, and this
        route hands over the page that loads it.

        Under `/api/`, deliberately: the route list of a server that holds a shell is not a
        thing to publish, and everything under that prefix wants the token.
        """
        return serve_static("apidocs.html")

    @app.get("/manifest.webmanifest", include_in_schema=False)
    async def manifest(request: Request) -> Response:
        return app_manifest(request.headers.get("host", ""))

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
        # `same-origin` and not `no-referrer`: the promise here is that the *other end* learns
        # nothing, and this keeps it — nothing is sent to another site at all. What it stops
        # throwing away is this server hearing which of its own pages a request came from,
        # which is the only way an absolute path from a proxied service can be sent home.
        answer.headers.setdefault("referrer-policy", "same-origin")
        return answer

    app.add_middleware(TokenAuthMiddleware, token=cfg.token, watchers=cfg.watchers,
                       devices_store=cfg.devices_store, agents=cfg.agents)

    @app.middleware("http")
    async def home_again(request: Request, call_next):
        """Something a proxied page asked for, with an absolute path, sent where it meant to go.

        A page served through `/proxy/8000/` gets a `<base>` tag, which corrects every
        *relative* reference in it and cannot touch an absolute one: `/static/app.js` and
        `/api/dashboard` are requests for the root of *this* server. What came back was
        Argus's own `index.html` with a 200, or — for anything under `/api/` — a flat 401,
        because the page holds a cookie scoped to `/proxy` and nothing else. Either way the
        dashboard rendered as bare markup with no script, no style and no data.

        The `Referer` says which proxied page asked. This is added *after* the auth middleware
        so that it wraps *outside* it — Starlette wraps in reverse — because `/api/dashboard`
        is refused before any handler sees it, and being refused is exactly the case that needs
        redirecting. Nothing is loosened: the address it redirects *to* is authenticated the
        same as ever, so this only sends a request somewhere it can be judged properly.

        It works at all because the referrer policy is `same-origin` rather than `no-referrer`.
        The promise that policy keeps is that *another site* learns nothing about this machine,
        and `same-origin` keeps it exactly while letting this server hear from its own pages.
        """
        came_from = re.match(r"^/proxy/(\d+)/", urlsplit(request.headers.get("referer", "")).path)
        # Whatever a proxied page asks for belongs to that page — *even when this server has a
        # file by the same name*. That was the first attempt's mistake and it was invisible in
        # testing: `/static/app.js` was corrected while `/app.js` was not, because Argus has an
        # `app.js` of its own, so a dashboard asking for the commonest filename there is got
        # Argus's own application. Argus's own assets are only ever asked for by Argus's own
        # pages, and their referer is not a proxy path.
        if came_from and not request.url.path.startswith(f"/proxy/{came_from.group(1)}/"):
            return RedirectResponse(f"/proxy/{came_from.group(1)}{request.url.path}"
                                    + (f"?{request.url.query}" if request.url.query else ""),
                                    status_code=307)
        return await call_next(request)
    # Added *after* the auth middleware, so it runs *outside* it — Starlette wraps in reverse
    # order — and therefore sees the `argus_master` / `argus_device` / `argus_watcher` that auth
    # put on the scope. Written here rather than in twenty handlers so a route added next month
    # is recorded without anybody remembering to.
    app.add_middleware(JournalMiddleware, store_of=lambda: app.state.journal)
    return app


def under_roots(request: Request, raw: str) -> Path:
    """A path from a client, resolved — with the two ways it can fail kept apart.

    The jail is careful about this: a path that does not exist *inside* the roots is a 404 and
    one that points outside them is a 403, so an answer never confirms the existence of
    anything Argus does not serve. Seven routes then caught the common parent and said
    "outside the configured roots" for both, which is how somebody spends an afternoon
    checking a `roots:` line that was right all along because the folder they typed is simply
    not there. Reported from a worktree that would not start: `~/thing` had been moved.
    """
    from .safepath import Denied, NotFound

    try:
        return request.app.state.jail.resolve(raw)
    except NotFound:
        raise ApiError(404, f"there is nothing at {raw}") from None
    except Denied:
        raise ApiError(403, "outside the configured roots") from None


def favourites_target(request: Request, raw: str) -> Path:
    return under_roots(request, raw)


def app_manifest(host: str) -> Response:
    """The manifest, wearing the address it was asked for.

    Two Argus instances installed on one phone are two icons called Argus, drawn with the
    same picture, and nothing anywhere says which machine either of them is — which is not a
    corner case for an app whose companion exists because people run it on several machines.

    So the name carries the host as the browser asked for it. Nothing is stored and nothing
    is guessed: it is the Host header, which is what the person typed.
    """
    doc = json.loads((STATIC_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    where = host.strip()
    if where and not where.startswith(("localhost", "127.0.0.1", "[")):
        doc["name"] = f"Argus · {where}"
        # The label under the icon is `short_name`, so that is the one that has to differ.
        # `www` is nobody's machine name, and the port belongs in the long name only.
        labels = [bit for bit in where.split(":")[0].split(".") if bit and bit != "www"]
        if labels:
            doc["short_name"] = labels[0]
    return Response(
        json.dumps(doc, ensure_ascii=False),
        media_type="application/manifest+json",
        headers={"cache-control": "no-cache"},
    )


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
    # A root of `/` is a legitimate thing to want and an easy thing to end up with by accident,
    # and the difference matters enough to say out loud: with it, "the file jail" is a sentence
    # about nothing.
    if any(str(r) == "/" for r in cfg.roots):
        print("          (one of them is / — every file this user can read is reachable)")
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
    # `--version` before anything else: it is the first thing anybody types at a program they
    # have just installed, the first thing an issue report is asked for, and the banner is no
    # substitute — that only appears once the server has started, which is exactly the case
    # where you cannot ask.
    parser.add_argument("--version", action="version", version=f"argus {VERSION}")
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
    parser.add_argument(
        "--drop-keep-days",
        type=int,
        metavar="N",
        help="delete files in the drop folder after N days, swept at startup and once a "
             "day. 0, the default, keeps them for ever",
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
        # `is not None`, so `--drop-keep-days 0` can turn off a sweep the config asks for.
        if args.drop_keep_days is not None:
            cfg.drop_keep_days = args.drop_keep_days
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

    # So the one setting the UI may change can be written back to the file it came from.
    app.state.config_path = config_path
    app.state.favourites = favourites.default_store(config_path)
    app.state.todo = todo.default_store(config_path)
    app.state.prefs = prefs.default_store(config_path)
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
