"""Noticing that a newer Argus exists.

This is the one thing Argus does that reaches out to the internet, so it is worth being
exact about what it is. Once a day it asks github.com for the latest tag of the public
repository. It sends nothing: no identifier, no configuration, no telemetry, not even
which version is running. GitHub learns that some address asked a public question, which
is what it would learn from anybody opening the releases page in a browser.

It never updates anything. Argus is somebody's shell, and a program that can rewrite
itself on a schedule is a program that can be made to rewrite itself into something else.
The most this does is say a number and offer a link.

Off is a supported answer, and on a machine with no route out it is silent rather than
noisy: an unreachable network is not a fault worth reporting to somebody reading a log.
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

LATEST = "https://api.github.com/repos/andreaderuvo/argus/releases/latest"
# Once a day. A release is not an event you need to hear about within the hour, and a
# server that asks more often is a server being rude to somebody else's API.
EVERY = 24 * 60 * 60
TIMEOUT = 5.0

NUMBERS = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def parts(tag: str) -> tuple[int, int, int] | None:
    """The three numbers of a tag, or nothing if it is not shaped like a version."""
    found = NUMBERS.match((tag or "").strip())
    return (int(found[1]), int(found[2]), int(found[3])) if found else None


def newer(running: str, offered: str) -> bool:
    """Is `offered` a later version than `running`?

    Anything unparseable answers no. A tag nobody can read is not a reason to tell someone
    they are out of date.
    """
    here, there = parts(running), parts(offered)
    return bool(here and there and there > here)


async def look(state: Any, running: str, *, now: float | None = None) -> dict:
    """The cached answer, refreshed at most once a day.

    Kept on the application rather than on disk: a fact that expires in a day is not worth
    a file, and forgetting it on restart costs one request.
    """
    now = time.time() if now is None else now
    kept = getattr(state, "release", None)
    if kept and now - kept.get("checked", 0) < EVERY:
        return kept

    answer = {"running": running, "latest": None, "url": None, "checked": now, "newer": False}
    try:
        async with httpx.AsyncClient() as client:
            got = await client.get(
                LATEST,
                timeout=TIMEOUT,
                headers={"accept": "application/vnd.github+json", "user-agent": "argus"},
            )
        if got.status_code == 200:
            body = got.json()
            tag = str(body.get("tag_name") or "")
            if parts(tag):
                answer["latest"] = tag
                answer["url"] = body.get("html_url")
                answer["newer"] = newer(running, tag)
    except Exception:
        # No network, GitHub down, rate limited: all the same thing from here, which is
        # that we do not know. Saying nothing is the correct amount to say.
        pass

    state.release = answer
    return answer
