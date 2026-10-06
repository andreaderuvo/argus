"""Bearer-token gate for `/api` and `/ws`."""

from __future__ import annotations

import hmac
from pathlib import Path
from urllib.parse import parse_qs

from starlette.responses import PlainTextResponse

from . import devices

PROTECTED_PREFIXES = ("/api", "/ws", "/proxy")
# A proxied page loads its own stylesheets and scripts, and cannot put an Authorization
# header on any of them. A cookie scoped to /proxy is the only way those requests can
# carry the token; it is set deliberately, when a port is opened.
PROXY_COOKIE = "argus_proxy" 

# Everything a token may reach when all it is allowed to do is watch. One door, on
# purpose: a board across several machines holds one of these per machine, and the value
# of that arrangement is entirely in how little each key is worth.
WATCHER_PATHS = ("/api/overview",)
# `GET /api/ask/<id>`: an agent waiting on the answer to its own question. The trailing slash
# matters — it is what stops this from also matching `/api/asks`, which lists everybody's.
ASK_PREFIX = "/api/ask/"

# Two more doors, and only for a watcher whose entry says `may_run: true`.
#
# The key stays nearly worthless even so, because no command ever arrives in a request:
# `/api/runnable/<name>/<action>` may only name something this machine already published in
# its own config, and `/api/shutdown` stops this Argus and nothing else. The worst anything
# holding the key can do is start or stop what you wrote down, or turn the server off — and
# turning it off needs `may_stop_argus`, which stands on its own — a machine with nothing
# worth publishing as `runnable` can still be one you want to be able to switch off.
RUN_LIST = "/api/runnable"
RUN_PREFIX = "/api/runnable/"
STOP_PATH = "/api/shutdown"

# What a key marked `agents:` in the config may do, by method and path, and nothing else.
#
# The reason this list exists rather than "give the agent the token": an agent living in a
# session on this machine can already read the config file — it runs as you — so the question
# was never whether it *can* drive Argus. It was what it should be able to reach when it does.
# The master key would mean killing sessions, deleting files, exposing a loopback port to the
# network, minting and revoking device tokens, emptying the journal and stopping the server.
# None of that is needed to hand work to another agent.
#
# So: read what is happening, ring the person, pass a sentence to another session, start
# something from the launcher list. Everything else answers 403 and says what it may do.
AGENT_ROUTES = frozenset({
    ("GET", "/api/who"),
    ("GET", "/api/overview"),
    ("GET", "/api/launchers"),
    # Read, not write. The prompt library and the desks are in here, and an agent that wants to
    # send a prompt should be able to read the library it comes from — while an agent quietly
    # rearranging your windows is a different proposition, and one line away if it is ever
    # wanted.
    ("GET", "/api/prefs"),
    ("GET", "/api/tmux/sessions"),
    ("GET", "/api/tmux/cwd"),
    ("POST", "/api/bell"),
    # Asking a person a question, and waiting for the answer. Answering one is *not* here and
    # never will be: the whole value of a question is that a person answered it, and an agent
    # that could answer its own would have invented a slower way of deciding by itself.
    ("POST", "/api/ask"),
    ("POST", "/api/relay"),
    ("POST", "/api/tmux/launch"),
    # A worktree, because the alternative is worse. An agent that may start a second agent but
    # not give it a checkout of its own will start it in the same one, which is the collision
    # the whole feature exists to avoid. It is still a bounded write: `--allow-write` must be
    # on, the branch name is checked, the path has to land inside the configured roots, and an
    # existing path is refused. Removing one is *not* here — that deletes work.
    ("POST", "/api/git/worktree"),
    ("GET", "/api/bells"),
    ("GET", "/api/bells/stream"),
    # A run posting the shape of what it is doing, so a person can watch it. It writes to a
    # noticeboard held in memory and nothing else: it cannot start, stop or reach an agent,
    # and the orchestration goes on unchanged if nobody is looking.
    ("GET", "/api/runs"),
    ("POST", "/api/runs"),
    # The teams, read only: an agent in one wants to know the round, whose turn it is and what
    # the last check said. Starting, pausing or stopping one stays with the person.
    ("GET", "/api/teams"),
    # Making a desk, or finding one by name, and showing it: "open a desk called pippo with two
    # agents in it" from an agent, and renaming one when asked to. Nothing here removes a desk or
    # what is in it.
    ("POST", "/api/desks"),
    # The to-do list: read it, add to it, move one along ("work on #1 and mark it done"). Changing
    # one is PATCH /api/todo/<id or number>, let through by prefix below. Removing one is not here.
    ("GET", "/api/todo"),
    ("POST", "/api/todo"),
    # Its own turn in a team: the task, the report, and the Stop guard's question. All about the
    # session the agent names — on the same machine, which is where this key lives.
    ("GET", "/api/teams/task"),
    ("POST", "/api/teams/done"),
    ("GET", "/api/teams/expecting"),
})
TODO_PREFIX = "/api/todo/"


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
    if values:
        return values[0]

    if scope.get("path", "").startswith("/proxy"):
        for raw_key, raw_val in scope.get("headers") or []:
            if raw_key.lower() != b"cookie":
                continue
            for part in raw_val.decode("latin-1").split(";"):
                name, _, value = part.strip().partition("=")
                if name == PROXY_COOKIE:
                    return value
    return None


# Remembering a browser, the way Jupyter does after its ?token= link: the page keeps the token in
# localStorage, but a phone loses that more often than one would think — Safari deletes what a
# script stored after seven days without a visit, and a link opened from a chat lands in that
# app's own browser. A cookie the *server* sets, HttpOnly, is kept far better. It is not a second
# way in: it is read at one path only, which hands the token back to this same origin so the page
# can go on as before, and every other request still carries the token in its header.
REMEMBER_PATH = "/api/remember"
REMEMBER_FOR = 400 * 86400          # the longest a browser will keep a cookie (Chrome's cap)


def remember_cookie(scope: dict) -> str:
    """One cookie per port: cookies ignore the port, and two Argus on one machine must not
    overwrite each other's."""
    server = scope.get("server") or ("", 0)
    return f"argus_keep_{server[1] or 0}"


def cookie_value(scope: dict, name: str) -> str | None:
    for raw_key, raw_val in scope.get("headers") or []:
        if raw_key.lower() != b"cookie":
            continue
        for part in raw_val.decode("latin-1").split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
    return None


def matches(presented: str, expected: str) -> bool:
    """Constant-time comparison. ``compare_digest`` also returns false on a length
    mismatch, so the wire never learns how long the real token is."""
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


def is_protected(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in PROTECTED_PREFIXES)


# Managing devices is the one thing the master token keeps to itself.
MASTER_PATHS = ("/api/devices", "/api/journal")
MASTER_PREFIX = "/api/devices/"


class TokenAuthMiddleware:
    """Raw ASGI rather than Starlette's BaseHTTPMiddleware, because that one never sees
    WebSocket connections — and the terminal is a WebSocket."""

    def __init__(self, app, token: str, watchers: list[dict] | None = None,
                 devices_store: Path | None = None, agents: list[dict] | None = None):
        self.app = app
        self.token = token
        self.watchers = list(watchers or [])
        self.agents = list(agents or [])
        # Where the per-device tokens live. Read on each attempt rather than cached: revoking
        # a device has to take effect now, and a board or a phone retrying a second later must
        # not still get in because the list was loaded at startup.
        self.devices_store = devices_store

    def device_for(self, presented: str) -> dict | None:
        if not self.devices_store:
            return None
        return devices.matching(devices.load(self.devices_store), presented)

    def remember(self, device: dict) -> None:
        """Note that this device was used. Throttled inside `touch`, and never allowed to fail
        a request: a read-only config directory is a reason to lose the timestamp, not the
        session."""
        try:
            devices.touch(self.devices_store, device)
        except Exception:
            pass

    def agent_for(self, presented: str) -> dict | None:
        """The agent key this token belongs to, if any. Compared like the others: every
        candidate is checked even after a match, so the time taken says nothing about which."""
        found = None
        for a in self.agents:
            if matches(presented, a.get("token", "")):
                found = a
        return found

    def watching(self, presented: str) -> dict | None:
        """The watcher this token belongs to, if any. Every candidate is compared even
        after a match, so the time taken says nothing about which one it was."""
        found = None
        for w in self.watchers:
            if matches(presented, w["token"]):
                found = w
        return found

    async def recall(self, scope, receive, send) -> None:
        """`/api/remember`. GET answers the remembered token, if it still opens this server;
        POST remembers the token the request carries; DELETE forgets. Only a full key or a
        device's key is ever remembered — a watcher's or an agent's is not a browser's."""
        import json
        method = scope.get("method", "GET").upper()
        name = remember_cookie(scope)
        secure = "; Secure" if scope.get("scheme") == "https" else ""
        base = f"{name}=%s; Path={REMEMBER_PATH}; HttpOnly; SameSite=Strict{secure}"
        keep = lambda tok: (base % tok + f"; Max-Age={REMEMBER_FOR}").encode("latin-1")
        drop = (base % "" + "; Max-Age=0").encode("latin-1")
        valid = lambda tok: bool(tok) and (matches(tok, self.token) or self.device_for(tok) is not None)

        async def answer(status: int, body: dict | None, cookie: bytes | None) -> None:
            headers = [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]
            if cookie:
                headers.append((b"set-cookie", cookie))
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": json.dumps(body or {}).encode()})

        if method == "GET":
            kept = cookie_value(scope, name)
            if valid(kept):
                return await answer(200, {"token": kept}, keep(kept))      # and it rolls on
            # Not an error: most browsers have nothing remembered, and asking is how they find out.
            return await answer(200, {"token": None}, drop if kept else None)
        if method == "DELETE":
            return await answer(200, {"forgotten": True}, drop)
        if method == "POST":
            given = presented_token(scope)
            if not valid(given):
                return await answer(401, {"detail": "only a working token can be remembered"}, None)
            return await answer(200, {"remembered": True}, keep(given))
        return await answer(405, {"detail": "GET, POST or DELETE"}, None)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not is_protected(scope["path"]):
            return await self.app(scope, receive, send)
        if scope["type"] == "http" and scope["path"] == REMEMBER_PATH:
            return await self.recall(scope, receive, send)

        token = presented_token(scope)
        if token is not None and matches(token, self.token):
            # The master key. Only this one may add and revoke devices.
            scope["argus_master"] = True
            return await self.app(scope, receive, send)

        device = self.device_for(token) if token is not None else None
        if device:
            if scope["path"] in MASTER_PATHS or scope["path"].startswith(MASTER_PREFIX):
                # A device may do everything except manage devices. That asymmetry is the
                # point of the feature: a phone that is lost cannot be used to lock its owner
                # out of their own machine.
                if scope["type"] == "http":
                    response = PlainTextResponse(
                        "this device may not add or revoke devices — use the token from the config",
                        status_code=403,
                    )
                    return await response(scope, receive, send)
            scope["argus_device"] = device
            self.remember(device)
            return await self.app(scope, receive, send)

        agent = self.agent_for(token) if token is not None else None
        if agent:
            # No WebSocket, ever. The terminal is a WebSocket, and an agent holding one could
            # type into any session on the machine — which is the one thing this scope exists
            # to make impossible by accident.
            if scope["type"] != "http":
                await receive()
                return await send({"type": "websocket.close", "code": 1008})
            method = scope.get("method", "GET").upper()
            # Coming back for an answer that was not there yet. A prefix, because the id is in
            # the path — and GET only, which is what keeps `POST /api/ask/<id>/answer` out of
            # reach: an agent may wait for a person, never speak for one.
            waiting = (method == "GET" and scope["path"].startswith(ASK_PREFIX)) or (
                method == "PATCH" and scope["path"].startswith(TODO_PREFIX))
            if not waiting and (method, scope["path"]) not in AGENT_ROUTES:
                response = PlainTextResponse(
                    "an agent key may only read what is happening (/api/who, /api/overview, "
                    "/api/tmux/sessions, /api/tmux/cwd, /api/launchers, /api/prefs, /api/teams, "
                    "/api/bells, /api/runs), ring the bell (/api/bell), ask you a question and "
                    "wait for the answer (/api/ask), pass a sentence to another session "
                    "(/api/relay), start something from the launcher list (/api/tmux/launch), "
                    "make a worktree (/api/git/worktree), report a run (/api/runs), make or "
                    "rename a desk (/api/desks) and read, add to and move along the to-do list "
                    "(/api/todo)",
                    status_code=403,
                )
                return await response(scope, receive, send)
            scope["argus_agent"] = agent
            return await self.app(scope, receive, send)

        watcher = self.watching(token) if token is not None else None
        if watcher:
            path = scope["path"]
            allowed = path in WATCHER_PATHS
            # The list itself is behind the same flag. A board that may not start anything
            # has no use for it, and it is one more thing a read-only key would reveal.
            if watcher.get("may_run") and (path == RUN_LIST or path.startswith(RUN_PREFIX)):
                allowed = True
            # Its own permission, not a step above `may_run`: a machine can be stoppable
            # without publishing anything to run.
            if watcher.get("may_stop_argus") and path == STOP_PATH:
                allowed = True
            if allowed and scope["type"] == "http":
                # Which watcher this is, for a handler that wants to answer about the caller
                # rather than about the config in general — `can_stop_argus` on the overview
                # is per-key, so a board without that permission is not shown a button that
                # would only give it a 403.
                scope["argus_watcher"] = watcher
                return await self.app(scope, receive, send)
            # A real token asking for the wrong thing: say so plainly, rather than
            # pretending it was never valid.
            if scope["type"] == "http":
                response = PlainTextResponse(
                    "this token may only ask what is happening here",
                    status_code=403,
                )
                return await response(scope, receive, send)

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
