"""An orchestration, while it is happening.

The framework in `tools/argus_orchestra.py` knows the shape of what it is doing — these agents,
in this order, each waiting for that file — and until now that shape existed only as lines
scrolling past in the terminal that started it. Which is the wrong place: the reason to run
several agents at once is that you cannot watch them all, and a list of print statements in a
pane you have scrolled away from is not watching.

So a run posts itself here as it goes, and the browser draws it: a diagram whose nodes change
colour, on the desk, beside the terminals it is talking about.

Kept in memory and nowhere else, like the bells. A run is interesting while it is running and
for a few minutes afterwards; a record of what ran last Tuesday is what the journal is for.
Nothing here starts, stops or touches an agent — it is a noticeboard, and the orchestration
goes on perfectly well if every browser is shut.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request

from . import bells
from .errors import ApiError

router = APIRouter()

# Enough to watch two or three orchestrations at once and the ones that finished while you were
# looking away; small enough that a script in a loop cannot grow it without bound.
KEEP = 16
MAX_AGENTS = 64
MAX_TEXT = 200
STATES = {"waiting", "working", "asking", "done", "lost"}


def store(request: Request) -> dict[str, Any]:
    state = request.app.state
    if not hasattr(state, "runs"):
        state.runs = {}
    return state.runs


def clean(raw: Any) -> dict | None:
    """A run as posted, with everything unrecognised dropped.

    Written the same way as the to-do list's cleaner: whatever arrives is somebody's data and
    may be anything at all, and a noticeboard that trusts what it is handed is a noticeboard
    that can be made to hold a megabyte of somebody else's HTML.
    """
    if not isinstance(raw, dict):
        return None
    ident = str(raw.get("id") or "").strip()[:64]
    if not ident:
        return None

    steps = []
    for step in (raw.get("steps") or [])[:KEEP]:
        if not isinstance(step, dict):
            continue
        agents = []
        for one in (step.get("agents") or [])[:MAX_AGENTS]:
            if not isinstance(one, dict):
                continue
            state = str(one.get("state") or "waiting")
            agents.append({
                "name": str(one.get("name") or "")[:64],
                "label": str(one.get("label") or "")[:MAX_TEXT],
                "state": state if state in STATES else "waiting",
                "file": str(one.get("file") or "")[:MAX_TEXT],
            })
        steps.append({"name": str(step.get("name") or "")[:MAX_TEXT], "agents": agents})

    return {
        "id": ident,
        "name": str(raw.get("name") or "a run")[:MAX_TEXT],
        "where": str(raw.get("where") or "")[:MAX_TEXT],
        "state": "done" if raw.get("state") == "done" else "running",
        "at": float(raw.get("at") or time.time()),
        "seen": time.time(),
        "steps": steps,
    }


def trim(runs: dict) -> None:
    """The oldest *finished* run goes first, and only then a running one.

    A cap that drops by age alone throws away the orchestration you are watching in favour of
    one that ended twenty minutes ago — which is exactly backwards.
    """
    while len(runs) > KEEP:
        finished = [k for k, v in runs.items() if v["state"] == "done"]
        pool = finished or list(runs)
        runs.pop(min(pool, key=lambda k: runs[k]["seen"]))


@router.get("/api/runs", tags=["Sessions"], summary="Orchestrations happening now")
async def listing(request: Request) -> dict:
    """What is running, newest first. A page that arrives in the middle of a run draws it from
    here; after that it is told about every change on the bell stream."""
    runs = store(request)
    return {"runs": sorted(runs.values(), key=lambda r: r["at"], reverse=True)}


@router.post("/api/runs", tags=["Sessions"], summary="Post the shape and state of an orchestration")
async def post(request: Request, body: dict) -> dict:
    """Called by the framework, every time something about a run changes.

    The whole document each time rather than a patch: a run is a dozen lines of JSON, the
    sender always knows the truth, and a diff protocol between a script and a noticeboard is
    machinery in exchange for nothing.
    """
    run = clean(body)
    if not run:
        raise ApiError(400, "a run needs an id, and steps with agents in them")
    runs = store(request)
    if run["id"] in runs:
        run["at"] = runs[run["id"]]["at"]      # when it started, not when it last spoke
    runs[run["id"]] = run
    trim(runs)
    # Straight to whoever is looking, rather than making a page poll for a thing that changes
    # every few seconds and then not at all for twenty minutes.
    bells.announce(request, {"what": "run", "run": run})
    return {"id": run["id"], "watching": len(store(request))}
