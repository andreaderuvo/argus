"""An agent asks; a person answers from wherever they are.

This is the one thing an agent cannot do for itself and no other tool here does for it. It can
already read, write, run and tell you it has finished — and then it stops, because the next
decision is yours, and asking for it means printing a question into a pane and hoping somebody
is looking at that pane. Half the questions are `yes` or `no`, and the cost of answering one
is walking to a desk.

So: the question comes here, rings the same bell everything else rings, waits, and gives the
agent back the answer as the return value of one call. Two taps on a phone, and the work goes
on.

Nothing is written to disk, for the same reason bells are not: a question that outlived the
process that asked it is a question nobody can answer, since the agent waiting on it is gone
too. What survives a restart is the work in tmux, which is the promise this whole program is
built on.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from fastapi import APIRouter, Request

from . import bells
from .errors import ApiError

router = APIRouter()

# Enough that a fan-out of agents can all be waiting at once, small enough that a loop asking
# in a cycle cannot grow it without bound.
KEEP = 32
MAX_TEXT = 2000
MAX_OPTIONS = 6
MAX_OPTION = 80
# An answered question stays visible for a moment so the page that answered it can see it
# land, and so a second device does not simply find it gone.
LINGER = 60
# Nobody is coming. The agent is told so and can ask again or decide for itself; a question
# that waits for ever is a session that hangs for ever.
STALE_AFTER = 6 * 3600
# One request is not allowed to hold a connection open indefinitely: proxies close them, and a
# caller that has to come back is a caller whose question survives a dropped line.
MAX_WAIT = 300.0


def store(request: Request) -> dict[str, Any]:
    state = request.app.state
    if not hasattr(state, "asks"):
        state.asks = {}
    return state.asks


def _clean(kept: dict, now: float | None = None) -> None:
    now = now or time.time()
    for ident, one in list(kept.items()):
        done = one["answered_at"] and now - one["answered_at"] > LINGER
        stale = not one["answered_at"] and now - one["at"] > STALE_AFTER
        if done or stale:
            kept.pop(ident, None)
    # Oldest first, so a runaway asker loses its own earlier questions rather than somebody
    # else's newer one.
    while len(kept) > KEEP:
        kept.pop(next(iter(sorted(kept, key=lambda k: kept[k]["at"]))), None)


def as_told(one: dict) -> dict:
    """What a caller is allowed to see: everything except the machinery for waiting."""
    return {k: v for k, v in one.items() if k != "landed"}


@router.post("/api/ask", tags=["Notifications"], summary="Ask the person a question, and wait for the answer")
async def ask(request: Request, body: dict) -> dict:
    """Put a question in front of whoever is holding the phone, and wait.

    `options` turns the answer into taps: two or three words, and answering costs no typing at
    all. Without them there is a box, which is right for "what should I call it" and wrong for
    "shall I overwrite it" — and the difference between those two is most of why this exists.

    The wait is bounded and the question is not: when `wait` runs out the answer is simply not
    there yet, and the same id can be waited on again. An agent that would rather not sit
    there can pass `wait=0`, ask, get on with something else and come back.
    """
    kept = store(request)
    _clean(kept)

    text = str(body.get("text") or "").strip()[:MAX_TEXT]
    if not text:
        raise ApiError(400, "a question needs some words")
    options = [str(o).strip()[:MAX_OPTION] for o in (body.get("options") or []) if str(o).strip()]
    if len(options) > MAX_OPTIONS:
        raise ApiError(400, f"at most {MAX_OPTIONS} options — past that it is a form, not a question")

    ident = uuid.uuid4().hex[:12]
    kept[ident] = {
        "id": ident,
        "at": time.time(),
        "session": str(body.get("session") or "").strip() or None,
        "who": getattr(request.state, "who", None) or None,
        "text": text,
        "options": options,
        "answer": None,
        "answered_at": None,
        # What a waiter waits on. Never sent anywhere.
        "landed": asyncio.Event(),
    }

    # The same bell as everything else, carrying the id: a phone that already tells you an
    # agent wants you should not need a second mechanism to tell you *what it wants*.
    bells.rung(request, "asking", session=kept[ident]["session"], text=text, ask=ident)

    waited = await _wait(kept[ident], body.get("wait"))
    return {"ok": True, **as_told(kept[ident]), "answered": waited}


@router.get("/api/ask/{ident}", tags=["Notifications"], summary="Wait for an answer, or read one")
async def one(request: Request, ident: str, wait: float = 0) -> dict:
    """Come back for an answer that was not there yet. Same question, same id."""
    kept = store(request)
    found = kept.get(ident)
    if not found:
        # Gone rather than never: a question that has been answered and cleared reads the
        # same as one that was never asked, and only the caller knows which it meant.
        raise ApiError(404, "no question with that id — it may have been answered long ago")
    waited = await _wait(found, wait)
    return {"ok": True, **as_told(found), "answered": waited}


@router.get("/api/asks", tags=["Notifications"], summary="Questions waiting for an answer")
async def listing(request: Request) -> dict:
    """What is waiting on a person, oldest first — the order they should be answered in."""
    kept = store(request)
    _clean(kept)
    open_ones = [as_told(o) for o in kept.values() if not o["answered_at"]]
    return {"asks": sorted(open_ones, key=lambda o: o["at"])}


@router.post("/api/ask/{ident}/answer", tags=["Notifications"], summary="Answer one")
async def answer(request: Request, ident: str, body: dict) -> dict:
    """The tap, or the sentence.

    Deliberately not something an agent key can reach. The whole value of a question is that a
    person answered it; an agent that could answer its own — or another's — would turn this
    into a slower way of deciding by itself.
    """
    kept = store(request)
    found = kept.get(ident)
    if not found:
        raise ApiError(404, "no question with that id")
    if found["answered_at"]:
        raise ApiError(409, f"already answered: {found['answer']}")

    said = str(body.get("answer") or "").strip()[:MAX_TEXT]
    if not said:
        raise ApiError(400, "an answer needs some words")
    if found["options"] and said not in found["options"]:
        raise ApiError(400, "that is not one of the options offered")

    found["answer"] = said
    found["answered_at"] = time.time()
    found["landed"].set()
    # So every open page takes the question down, including the ones that did not answer it.
    bells.announce(request, {"what": "answered", "id": ident, "answer": said})
    return {"ok": True, **as_told(found)}


async def _wait(one: dict, wait: Any) -> bool:
    """Hold for up to `wait` seconds. True if the answer is there by the end of it."""
    if one["answered_at"]:
        return True
    try:
        patience = min(max(float(wait or 0), 0.0), MAX_WAIT)
    except (TypeError, ValueError):
        raise ApiError(400, "`wait` is a number of seconds") from None
    if not patience:
        return False
    try:
        await asyncio.wait_for(one["landed"].wait(), timeout=patience)
    except asyncio.TimeoutError:
        return False
    return True
