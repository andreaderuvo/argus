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

import time
from collections import deque
from typing import Any

from pathlib import Path

from fastapi import APIRouter, Request

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


def store(request: Request) -> dict[str, Any]:
    state = request.app.state
    if not hasattr(state, "bells"):
        state.bells = {"seq": 0, "list": deque(maxlen=KEEP)}
    return state.bells


@router.post("/api/bell")
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
    return bell


@router.get("/api/bells")
async def since(request: Request, since: int = 0) -> dict:
    """Everything rung after `since`.

    The answer always carries the current sequence, so a browser that has just started —
    or one that was away long enough for the list to roll over — can catch up to the
    present without replaying a morning's worth of notifications at you.
    """
    kept = store(request)
    fresh = [b for b in kept["list"] if b["seq"] > since] if since else []
    return {"seq": kept["seq"], "bells": fresh}


@router.get("/api/bell/wiring")
async def wired(_request: Request) -> dict:
    """Which agents on this machine are set up to ring, and which are not."""
    return wiring.state(Path.home())


@router.post("/api/bell/wiring")
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
