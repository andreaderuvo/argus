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
import sys
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


# Where an answer came from, best first. The names travel to the browser, which uses them to
# say the true sentence rather than a plausible one.
#
#   agent    the program itself said so, in the pane option `@argus_cwd`
#   process  the process that holds the terminal, read from /proc/<pid>/cwd
#   tmux     tmux's own `#{pane_current_path}`, which is an observation and says so
#   start    the directory the pane was made in, which is history, not news
FRESH = ("agent", "process", "tmux")


def _say(sock: tmux.Socket, session: str, fmt: str) -> str:
    try:
        p = subprocess.run(
            ["tmux", *sock.args(), "display-message", "-p", "-t", session, fmt],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return p.stdout.strip() if p.returncode == 0 else ""


def foreground_pid(tty: str) -> int | None:
    """The process that actually holds the terminal in this pane.

    `pane_pid` is the pane's *first* process — usually the shell that launched whatever you
    are looking at — so reading its directory answers a question about the wrong process.
    The one with the terminal is the one whose process group is the terminal's foreground
    group: `pgid == tpgid`, which `ps` will tell us for every process on that tty.

    Measured, on a pane running `cd /tmp && sleep 300`:

        3882697  614513 3882697 3882912 bash     <- the pane's pid, not in the fg group
        3882912 3882697 3882912 3882912 sleep    <- pgid == tpgid, and its cwd is /tmp
    """
    name = tty.rsplit("/", 1)[-1]
    if not name:
        return None
    try:
        p = subprocess.run(
            ["ps", "-t", name, "-o", "pid=,pgid=,tpgid="],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    rows = []
    for line in p.stdout.splitlines():
        bits = line.split()
        if len(bits) != 3 or not all(b.lstrip("-").isdigit() for b in bits):
            continue
        rows.append(tuple(int(b) for b in bits))
    group = next((pgid for _pid, pgid, tpgid in rows if pgid == tpgid), None)
    if group is None:
        return None
    return next((pid for pid, pgid, _t in rows if pgid == group), None)


# The agents worth naming. A pane running one of these is not running "node", whatever tmux
# says: `pane_current_command` reports the wrapper, so a Codex started through its npm shim
# shows up as `node` with the real thing two processes further down.
AGENTS = ("claude", "codex", "gemini", "aider", "opencode", "goose", "cursor-agent")


def agent_in(tty: str) -> str | None:
    """Which known agent is running in this pane, by looking at the whole tty rather than
    the first process on it."""
    name = tty.rsplit("/", 1)[-1]
    if not name:
        return None
    try:
        p = subprocess.run(["ps", "-t", name, "-o", "comm=,args="],
                           capture_output=True, text=True, timeout=4)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    seen = p.stdout.lower()
    for one in AGENTS:
        # In the command name, or as the program a wrapper was pointed at — `bin/codex`,
        # never a folder that merely has the word in it.
        if re.search(rf"(^|\s|/){re.escape(one)}(\s|$)", seen) or f"/{one}" in seen:
            return one
    return None


def process_cwd(pid: int) -> str | None:
    """Where that process is, now.

    Linux keeps it in `/proc/<pid>/cwd`, which is a readlink and costs nothing. macOS has no
    `/proc` at all, so there it is `lsof`, which ships with the system and is slower but only
    asked for one process. Anything else — and a process that is not ours, which the kernel
    refuses either way — falls through, and the caller drops to what tmux says.
    """
    try:
        where = os.readlink(f"/proc/{pid}/cwd")
        return where if where.startswith("/") else None
    except OSError:
        pass
    if sys.platform != "darwin":
        return None
    try:
        p = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    # `-Fn` answers in fields, one per line: `p<pid>`, then `n<path>`.
    for line in p.stdout.splitlines():
        if line.startswith("n/"):
            return line[1:]
    return None


def pane_where(sock: tmux.Socket, session: str) -> dict:
    """Where a session is, and how well that is known.

    Four answers, best first, because they are not equally good and pretending otherwise is
    how a mark ends up believed and wrong:

    1. **The agent said so.** `tmux set -p @argus_cwd /the/folder`, which a Claude Code
       status line hook can write on every turn — it is handed `workspace.current_dir`, the
       directory the agent *considers* current, which is a thing no amount of watching from
       outside can derive.
    2. **The process that holds the terminal.** Not the pane's first process — that is the
       shell that launched the agent — but the one whose process group is the terminal's
       foreground group, read straight from `/proc/<pid>/cwd`.
    3. **What tmux says**, which is its own best effort and documented as such.
    4. **Where the pane was made**, which is history rather than news, and is marked as not
       live so that nothing downstream treats it as an answer about now.

    The one thing none of these can do is follow an agent that runs `cd x && npm test` in a
    child: the child moves, the agent does not, and there is no cwd inherited backwards. That
    is exactly why (1) exists and why it wins.
    """
    line = _say(sock, session, "\t".join([
        "#{pane_tty}", "#{pane_current_path}", "#{pane_current_command}",
        "#{@argus_cwd}", "#{pane_start_path}", "#{@argus_model}",
    ]))
    bits = (line.split("\t") + [""] * 6)[:6]
    tty, current, command, told, began, model = (b.strip() for b in bits)

    answer = {"cwd": None, "source": None, "live": False, "command": command,
              # What is *really* in there, when it is something worth naming.
              "agent": agent_in(tty) if tty else None,
              "began": began if began.startswith("/") else None,
              # What the agent says it is running. Nothing outside it can know: the process
              # is called `claude` whatever model is behind it, and a model named in a config
              # file is the one it started with, not the one /model chose ten minutes ago.
              "model": model or None}
    if told.startswith("/"):
        answer.update(cwd=told, source="agent")
    else:
        pid = foreground_pid(tty) if tty else None
        seen = process_cwd(pid) if pid else None
        if seen:
            answer.update(cwd=seen, source="process")
        elif current.startswith("/"):
            answer.update(cwd=current, source="tmux")
        elif began.startswith("/"):
            answer.update(cwd=began, source="start")
    answer["live"] = answer["source"] in FRESH
    return answer


def pane_cwd(sock: tmux.Socket, session: str) -> str | None:
    """Just the directory, for the callers that only want a path."""
    return pane_where(sock, session)["cwd"]


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
