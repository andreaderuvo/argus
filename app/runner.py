"""Starting and stopping the things this machine was told it may start and stop.

A board watching several machines holds one *watcher* token apiece, in a file, and its own
token sits in the storage of every browser that has ever opened it. The whole reason those
keys are safe to spread around is that they are worth almost nothing: they open
`GET /api/overview` and nothing else.

Letting a board restart an agent could undo that in one step, if it were done the obvious
way — a request carrying a command. So no command ever arrives in a request. This machine
publishes a list of things it is willing to do, each with a name, and a board may ask for
one of those names. The worst anything holding that key can do is start or stop something
you wrote down in your own config file.

Stopping means killing the session of that name, and only a name on the list can be killed:
a board cannot touch the work you did not list. Nothing here reads a path, an argument or a
shell fragment from the caller.
"""

from __future__ import annotations

from typing import Any

from . import tmux

# What the reply says happened, in the words a person would use. `already` is not an error:
# a board asking twice, or two people pressing the same button, should not produce one.
STARTED = "started"
ALREADY = "already running"
STOPPED = "stopped"
NOT_RUNNING = "not running"


class NotAllowed(Exception):
    """Asked for something that is not on the list."""


def find(runnable: list[dict], name: str) -> dict:
    for entry in runnable:
        if entry["name"] == name:
            return entry
    raise NotAllowed(f"{name!r} is not something this machine offers to run")


def offered(runnable: list[dict], sock: Any) -> list[dict]:
    """The list as a board should see it — with whether each one is up right now.

    The command is deliberately absent. A board needs to know what it may ask for and
    whether it is already happening; it has no use for the shell line, and every extra
    thing on the wire is one more thing a leaked board leaks.
    """
    try:
        live = {s["name"] for s in tmux.list_sessions(sock)}
    except Exception:
        # No tmux server yet is a perfectly ordinary state, and it means nothing is running.
        live = set()
    return [{"name": e["name"], "running": e["name"] in live} for e in runnable]


def start_argv(sock: Any, entry: dict) -> list[str]:
    """`tmux new-session -d -s name [-c cwd] run`.

    The command is passed as one argument, which tmux hands to the shell — that is how a
    session running `claude --resume` is written. It comes from the config file and never
    from a request, so there is nothing here for a caller to inject into.
    """
    argv = tmux.new_argv(sock, entry["name"], entry.get("cwd") or None)
    return [*argv, entry["run"]]


def start(sock: Any, entry: dict) -> str:
    if tmux.session_exists(sock, entry["name"]):
        return ALREADY
    tmux.run(start_argv(sock, entry))
    return STARTED


def stop(sock: Any, entry: dict) -> str:
    if not tmux.session_exists(sock, entry["name"]):
        return NOT_RUNNING
    tmux.run(tmux.kill_argv(sock, entry["name"]))
    return STOPPED


def act(runnable: list[dict], sock: Any, name: str, action: str) -> dict:
    """One request's worth of work. Raises NotAllowed for anything off the list."""
    entry = find(runnable, name)
    if action == "start":
        return {"name": name, "did": start(sock, entry)}
    if action == "stop":
        return {"name": name, "did": stop(sock, entry)}
    raise NotAllowed(f"{action!r} is not start or stop")
