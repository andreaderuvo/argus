"""Turning text printed in a terminal back into a file.

A build log, a traceback, an `ls` — a terminal is full of paths, and on a phone the only
way to reach one is to read it, remember it, and retype it in the browser. The frontend
finds the path-shaped words on the line under the pointer and asks here whether each one
is a real file; the ones that are get underlined and open in the viewer.

Two things make the guessing safe. Nothing is reported that the jail would not serve, so
this cannot be used to probe the filesystem for what exists outside the roots. And a
relative path is resolved against the working directory of the pane it was printed in —
asking tmux, not guessing — so `src/main.rs` in one session and the same text in another
lead to different files, which is what the person reading it meant.
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

from . import tmux
from .errors import ApiError
from .safepath import PathError

router = APIRouter()

# One hovered line's worth. A line cannot hold many more candidates than this, and the
# cap keeps a pathological line from turning into a hundred stat calls.
MAX_CANDIDATES = 24

# Punctuation a path collects from the prose around it: `see /etc/hosts.` or `("a/b")`.
# A dot is stripped from the end even though a file may end in one, because "the sentence
# ended" is overwhelmingly the more common reading.
TRAILING = ".,;:!?'\"`)]}>"
LEADING = "'\"`([{<"

# `file.rs:12:5`, `file.py:12`, `file.c(12)` — every compiler and test runner writes the
# line number this way, and it is never part of the name.
LINE_SUFFIX = re.compile(r"(?::(\d+))(?::(\d+))?$|(?:\((\d+)(?:,\s*\d+)?\))$")


class LocateBody(BaseModel):
    paths: list[str]
    # The session whose pane working directory relative paths are resolved against.
    session: str | None = None
    # Or an explicit directory, for a window that is not a terminal.
    base: str | None = None


def trim(token: str) -> tuple[str, int | None]:
    """Strip the punctuation and the `:line:col` a path picks up from the text around it.

    Returns the bare path and the line number, when one was there — the viewer can use it
    to scroll, and dropping it silently would mean the file never resolves at all.
    """
    token = token.strip().lstrip(LEADING)
    line = None
    # Alternate until nothing more comes off. One pass in either order gets something
    # wrong: strip first and `thing.c(88)` loses the bracket the line number needs, match
    # first and `foo.js:9).` never matches at all.
    for _ in range(3):
        before = token
        if line is None and (m := LINE_SUFFIX.search(token)):
            line = int(m.group(1) or m.group(3))
            token = token[: m.start()]
        token = token.rstrip(TRAILING)
        if token == before:
            break
    return token, line


def pane_cwd(sock: tmux.Socket, session: str) -> str | None:
    """The working directory of the pane you are looking at.

    Note the target has no `=` prefix: `display-message` answers nothing at all for the
    exact-match form, which reads as "no such session" and is not.
    """
    try:
        p = subprocess.run(
            ["tmux", *sock.args(), "display-message", "-p", "-t", session, "#{pane_current_path}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = p.stdout.strip()
    return out if p.returncode == 0 and out.startswith("/") else None


def expand(token: str, base: str | None) -> str | None:
    """A candidate as an absolute path, or None when it cannot be one.

    `~` is expanded here rather than in the jail because only this layer knows the text
    came from a shell, where `~` is a path and not a file called "~".
    """
    if not token or "\0" in token:
        return None
    if token.startswith("~"):
        token = os.path.expanduser(token)
    if token.startswith("/"):
        return os.path.normpath(token)
    if not base:
        return None
    return os.path.normpath(os.path.join(base, token))


def look_up(jail, token: str, base: str | None) -> dict | None:
    """One candidate, resolved and stat'ed, or None if it is not something we can open."""
    bare, line = trim(token)
    absolute = expand(bare, base)
    if not absolute:
        return None
    try:
        found = jail.resolve(absolute)
    except PathError:              # outside the roots, or nothing there
        return None
    entry = {
        "path": str(found),
        "type": "directory" if os.path.isdir(found) else "file",
    }
    if line:
        entry["line"] = line
    return entry


@router.post("/api/fs/locate")
async def locate(request: Request, body: LocateBody) -> dict:
    """Which of these words are files? Read-only, and jailed like everything else."""
    state = request.app.state
    base = None

    if body.session:
        # Same rule as attaching: only a session tmux itself reported.
        if not await asyncio.to_thread(tmux.session_exists, state.socket, body.session):
            raise ApiError(404, f"no tmux session named {body.session!r}")
        base = await asyncio.to_thread(pane_cwd, state.socket, body.session)
    elif body.base:
        try:
            base = str(state.jail.resolve(body.base))
        except PathError:
            raise ApiError(403, "outside the configured roots") from None

    # A working directory we are not allowed to serve is no working directory: resolving
    # against it would produce paths the jail then refuses one by one.
    if base and not state.jail.contains(Path(base)):
        base = None

    found = {}
    for token in body.paths[:MAX_CANDIDATES]:
        if token in found:
            continue
        if hit := await asyncio.to_thread(look_up, state.jail, token, base):
            found[token] = hit

    return {"base": base, "found": found}
