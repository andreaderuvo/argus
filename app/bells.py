"""Something finished, or wants you.

The useful signal does not come from watching the terminal. Both of the agents people
run in here can call a program when a turn ends — codex has `notify` and its own hooks,
Claude Code has `Stop`, `SubagentStop` and `Notification` — and a hook knows the one
thing no amount of watching can tell you apart: whether it *finished* or whether it is
*waiting for you*. So the hook posts here and the browser rings.

Nothing is stored on disk and nothing is delivered anywhere: this is a short list the
browsers read from. Notifications that leave the machine (a phone with the tab closed)
need either HTTPS for Web Push or a relay like ntfy, and that is deliberately not decided
here.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from . import wiring
from .errors import ApiError

router = APIRouter()

# Enough that a browser polling every few seconds never misses one, small enough that a
# stuck hook in a loop cannot grow it.
KEEP = 64
MAX_TEXT = 300

# What a hook is saying. "done" and "asking" are the two that matter and they earn
# different treatment: one is news, the other is a block on the work.
REASONS = {"done", "asking", "failed", "note"}


# A page in a background tab has its timers throttled to about once a minute, so polling
# is the wrong shape for the one case that matters: you are in another tab, which is
# exactly when you need telling. An open stream is not throttled — the message arrives and
# the page wakes.
HEARTBEAT = 25
LISTENERS = 32


def store(request: Request) -> dict[str, Any]:
    state = request.app.state
    if not hasattr(state, "bells"):
        state.bells = {"seq": 0, "list": deque(maxlen=KEEP), "ears": set()}
    return state.bells


@router.post("/api/bell", tags=["Notifications"], summary="Ring: something finished, or wants you")
async def ring(request: Request, body: dict) -> dict:
    """Called by an agent hook, or by anything else that knows it has finished."""
    kept = store(request)
    why = str(body.get("why") or "done")
    if why not in REASONS:
        raise ApiError(400, f"why must be one of {', '.join(sorted(REASONS))}")

    kept["seq"] += 1
    bell = {
        "seq": kept["seq"],
        "at": int(time.time()),
        # A bell that names no session still rings; it just cannot mark a window.
        "session": (str(body.get("session") or "").strip() or None),
        "why": why,
        "text": str(body.get("text") or "")[:MAX_TEXT],
    }
    kept["list"].append(bell)
    for ear in list(kept["ears"]):
        # A listener that has stopped reading must not hold up the hook that is ringing.
        try:
            ear.put_nowait(bell)
        except asyncio.QueueFull:
            kept["ears"].discard(ear)
    return bell


@router.get("/api/bells", tags=["Notifications"], summary="What has rung since a given point")
async def since(request: Request, since: int = 0) -> dict:
    """Everything rung after `since`.

    The answer always carries the current sequence, so a browser that has just started —
    or one that was away long enough for the list to roll over — can mark where "now" is
    and catch up from there rather than replaying a morning's worth of notifications.

    Deciding *that* is the browser's job, not this one's. An earlier version tried to help
    by treating `since=0` as "you have just arrived, here is nothing", and it meant a
    server that had not rung yet handed out `seq: 0`, took `since=0` back for ever after,
    and stayed silent for the life of the page.
    """
    kept = store(request)
    return {"seq": kept["seq"], "bells": [b for b in kept["list"] if b["seq"] > since]}


@router.get("/api/bell/wiring", tags=["Notifications"], summary="Which agents on this machine are set up to ring")
async def wired(_request: Request) -> dict:
    """Which agents on this machine are set up to ring, and which are not."""
    return wiring.state(Path.home())


@router.post("/api/bell/wiring", tags=["Notifications"], summary="Set the agents up to ring, or undo it")
async def rewire(_request: Request, body: dict) -> dict:
    """Do the setting up, or take it back out.

    This writes into the agents' own configuration files, which is exactly the work the
    person would otherwise be doing by hand — and it is additive: an event they have
    already claimed is reported, never overwritten, and a copy of each file as it was
    before Argus first touched it is kept beside it.
    """
    try:
        return wiring.wire(Path.home(), bool(body.get("on", True)))
    except (OSError, ValueError, FileNotFoundError) as e:
        raise ApiError(400, str(e)) from e


@router.get("/api/where/wiring", tags=["Sessions"], summary="Which agents are set up to say which folder they are in")
async def where_wired(_request: Request) -> dict:
    """Which agents here can tell Argus the folder they consider current.

    Only Claude Code can: it hands its status line hook `workspace.current_dir`. Nothing
    outside an agent can work that out — an agent never moves its own process — so this is
    the difference between a mark that follows the work and one that names where the
    session started.
    """
    return wiring.where_state(Path.home())


@router.post("/api/where/wiring", tags=["Sessions"], summary="Set the agents up to say where they are, or undo it")
async def where_rewire(_request: Request, body: dict) -> dict:
    """Do the setting up, or take it back out.

    The same bargain as the bell: it writes into the agent's own configuration, keeps a copy
    of the file as it was before Argus first touched it, reports a status line you wrote
    yourself rather than replacing it, and removes only what carries our own marker.
    """
    try:
        return wiring.wire_where(Path.home(), bool(body.get("on", True)))
    except (OSError, ValueError, FileNotFoundError) as e:
        raise ApiError(400, str(e)) from e


@router.get("/api/bells/stream", tags=["Notifications"], summary="Bells as they happen, over one open connection")
async def stream(request: Request, since: int = 0) -> StreamingResponse:
    """Bells as they happen, over one connection that stays open.

    This is what makes a background tab work. It also needs no HTTPS, unlike the
    browser's own notifications — the sound and the tab title are what is left over
    plain http, and both want to happen the moment it rings rather than a minute later.
    """
    kept = store(request)
    ear: asyncio.Queue = asyncio.Queue(maxsize=KEEP)
    if len(kept["ears"]) >= LISTENERS:
        raise ApiError(429, "too many listeners")
    kept["ears"].add(ear)

    async def bells():
        try:
            # Anything missed between the last connection and this one, then live.
            for old in [b for b in kept["list"] if b["seq"] > since]:
                yield f"data: {json.dumps(old)}\n\n"
            yield f": here, at {kept['seq']}\n\n"
            while True:
                try:
                    bell = await asyncio.wait_for(ear.get(), timeout=HEARTBEAT)
                except asyncio.TimeoutError:
                    yield ": still here\n\n"          # keeps a proxy from closing us
                    continue
                yield f"data: {json.dumps(bell)}\n\n"
        finally:
            kept["ears"].discard(ear)

    return StreamingResponse(bells(), media_type="text/event-stream", headers={
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",       # nginx would sit on this otherwise
    })
