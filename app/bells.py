"""Something finished, or wants you.

The useful signal does not come from watching the terminal. Both of the agents people
run in here can call a program when a turn ends — codex has `notify` and its own hooks,
Claude Code has `Stop`, `SubagentStop` and `Notification` — and a hook knows the one
thing no amount of watching can tell you apart: whether it *finished* or whether it is
*waiting for you*. So the hook posts here and the browser rings.

Nothing is stored on disk: this is a short list the browsers read from. When ``ntfy`` is
configured, a deliberately small copy of a bell can also go to that server so a locked phone
or a closed browser still hears it.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
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
REASONS = {"done", "asking", "failed", "note", "start"}

# "It stopped and it is your turn", however it is said. An interactive agent that has finished a
# turn is waiting for you exactly as much as one that asked, so these are one event per turn:
# the first to arrive rings, the rest of that turn are repeats. Measured before this existed:
# Claude Code's Stop hook said `done`, and its idle notification said `asking` exactly sixty
# seconds later, about a turn that had already rung — two tones, twice, for one thing.
NEEDS = {"done", "asking"}
# How long a turn the server noticed by itself (the sampler) waits for the hook that will say the
# same thing with more words, before the hook counts as a turn of its own.
HOOK_LATE = 15
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


# A page in a background tab has its timers throttled to about once a minute, so polling
# is the wrong shape for the one case that matters: you are in another tab, which is
# exactly when you need telling. An open stream is not throttled — the message arrives and
# the page wakes.
HEARTBEAT = 25
LISTENERS = 32


def store(request: Request) -> dict[str, Any]:
    state = request.app.state
    if not hasattr(state, "bells"):
        # `open`: session -> (seq, at, source) of the bell that said its current turn is over.
        state.bells = {"seq": 0, "list": deque(maxlen=KEEP), "ears": set(), "open": {}, "conversations": {}}
    return state.bells


def is_agent(request, session: str | None) -> bool:
    """Whether the sampler knows this session as an agent. Only then is "its turn is over"
    something that ends: it ends when the sampler sees it working again. A session it does not
    know rings every time, as it always has."""
    watch = getattr(request.app.state, "agents", None)
    return bool(session and watch is not None and session in getattr(watch, "state", {}))


def repeat_of(request, why: str, session: str | None, source: str) -> dict | None:
    """The bell this one would repeat, or None if it is news."""
    if why not in NEEDS or not session or not is_agent(request, session):
        return None
    kept = store(request)
    opened = kept["open"].get(session)
    if not opened:
        return None
    seq, at, by = opened
    # The one exception: the sampler noticed first, and this is the hook arriving a moment later
    # to say the same thing. Still a repeat — but a hook that turns up long after is a new turn
    # the sampler missed (a turn too short to see it working).
    if source == "hook" and why == "done" and by == "hook":
        return None
    if source == "hook" and why == "done" and time.time() - at > HOOK_LATE:
        return None
    return next((b for b in kept["list"] if b["seq"] == seq), {"seq": seq})


def plugin_seen(request, session: str, version: str) -> None:
    """Which Argus plugin version a session's agent said it is running."""
    store(request).setdefault("plugins", {})[session] = version.strip()[:20]


def told(request, session: str, state: str) -> None:
    """What the agent itself said about its state, for the watch to believe over the pane."""
    watch = getattr(request.app.state, "agents", None)
    if watch is not None:
        watch.told[session] = (state, time.time())


def turn_began(request, session: str) -> None:
    """The sampler saw this session working again: its next stop is news."""
    store(request)["open"].pop(session, None)


@router.post("/api/bell", tags=["Notifications"], summary="Ring: something finished, or wants you")
async def ring(request: Request, body: dict) -> dict:
    """Called by an agent hook, or by anything else that knows it has finished.

    A second "done" or "asking" about a turn that has already rung is answered with that bell
    and `repeat: true`, and rings nothing: see NEEDS."""
    why = str(body.get("why") or "done")
    if why not in REASONS:
        raise ApiError(400, f"why must be one of {', '.join(sorted(REASONS))}")
    session = str(body.get("session") or "").strip() or None
    text = str(body.get("text") or "")
    # The plugin's own copy of argus-bell says which plugin version this session is running, so a
    # window can say "plugin 0.1.4 — reload" after an update (see main.tmux_states).
    if session and body.get("plugin"):
        plugin_seen(request, session, str(body["plugin"]))
    # Which conversation the agent is in, for bringing it back after a reboot (resume.py).
    # Kept even for a repeat: it is the freshest word on it, and it rings nothing.
    conversation = str(body.get("conversation") or "").strip().lower()
    if session and UUID.fullmatch(conversation):
        store(request)["conversations"][session] = conversation
    # "A turn has started" is not news for anybody: it rings nothing, and only tells the watch
    # that this agent is at work until it says otherwise.
    if why == "start":
        if session:
            told(request, session, "working")
            turn_began(request, session)
        return {"started": True, "session": session}
    if why in NEEDS and session:
        told(request, session, "waiting")
    earlier = repeat_of(request, why, session, "hook")
    if earlier is not None:
        return {**earlier, "repeat": True}
    return rung(request, why, session=session, text=text, source="hook")


def rung(request: Request, why: str, session: str | None = None, text: str = "", **extra) -> dict:
    """Ring, from inside this program rather than over the wire.

    A question asked of a person is a bell — the same phone, the same badge, the same line
    under "waiting for you" — and it would be absurd for one part of this server to post to
    another to say so. `extra` is how a bell carries the thing it is about: an `ask` puts its
    own id there, and a browser that does not know the word ignores it, which is the same
    bargain the whole stream is built on.
    """
    kept = store(request)
    kept["seq"] += 1
    bell = {
        "seq": kept["seq"],
        "at": int(time.time()),
        # A bell that names no session still rings; it just cannot mark a window.
        "session": session,
        "why": why,
        "text": str(text or "")[:MAX_TEXT],
        **extra,
    }
    kept["list"].append(bell)
    if why in NEEDS and session:
        kept["open"][session] = (bell["seq"], time.time(), extra.get("source", "hook"))
    for ear in list(kept["ears"]):
        # A listener that has stopped reading must not hold up the hook that is ringing.
        try:
            ear.put_nowait(bell)
        except asyncio.QueueFull:
            kept["ears"].discard(ear)
    dispatch_ntfy(request, bell)
    return bell


def dispatch_ntfy(request: Request, bell: dict) -> None:
    """Send without holding up the hook that rang.

    A notification relay is useful precisely when it is somewhere else, so it must not turn
    a slow network or an ntfy outage into a slow agent hook. Delivery is best-effort; the
    in-memory bell and every open browser remain independent of it.
    """
    config = getattr(request.app.state.cfg, "ntfy", {})
    if not config or bell["why"] not in config.get("on", ["asking", "failed", "done"]):
        return
    task = asyncio.create_task(deliver_ntfy(config, bell))
    # Keep a reference until completion: event loops only hold weak references to tasks.
    pending = getattr(request.app.state, "notification_tasks", None)
    if pending is None:
        pending = request.app.state.notification_tasks = set()
    pending.add(task)
    task.add_done_callback(pending.discard)


async def deliver_ntfy(config: dict, bell: dict, *, transport=None) -> bool:
    """Deliver one privacy-minimised message. False means the relay was unavailable."""
    server = str(config.get("server") or "https://ntfy.sh").rstrip("/")
    url = f"{server}/{quote(str(config['topic']), safe='')}"
    why = bell["why"]
    session = bell.get("session")
    title = {
        "asking": "Argus - an agent needs you",
        "failed": "Argus - a run failed",
        "done": "Argus - work finished",
        "note": "Argus",
    }[why]
    fallback = {
        "asking": "Waiting for an answer",
        "failed": "A run failed",
        "done": "Work finished",
        "note": "New notification",
    }[why]
    message = str(bell.get("text") or fallback)[:MAX_TEXT]
    if session:
        message = f"{session}: {message}"
    headers = {
        "Title": title,
        "Priority": "5" if why in {"asking", "failed"} else "3",
        "Tags": "question" if why == "asking" else "warning" if why == "failed" else "white_check_mark",
    }
    if config.get("token"):
        headers["Authorization"] = f"Bearer {config['token']}"
    try:
        async with httpx.AsyncClient(timeout=10, transport=transport) as client:
            answer = await client.post(url, content=message.encode("utf-8"), headers=headers)
            answer.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


def announce(request: Request, said: dict) -> None:
    """Tell the open browsers something that is *not* a bell.

    The stream was built for bells and is the only thing this server has that reaches a page
    the moment something happens, so the alternative to reusing it is a second connection
    doing the same job. What keeps the two apart is that this is not given a sequence and
    never joins the kept list: it is not counted, not replayed to a browser that reconnects,
    and cannot ring anything. A page that does not know the word simply ignores it.

    Nothing is delivered to a machine with no page open, which is the honest shape of it —
    "show me this now" only means something while somebody is looking.
    """
    kept = store(request)
    for ear in list(kept["ears"]):
        try:
            ear.put_nowait(said)
        except asyncio.QueueFull:
            kept["ears"].discard(ear)


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
