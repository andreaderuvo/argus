"""Talking to tmux: which server, and what sessions are on it."""

from __future__ import annotations

import contextlib
import subprocess
from dataclasses import dataclass

# An explicit format string, so we parse fields we chose rather than tmux's
# human-readable layout (which changes between versions).
FORMAT = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}"


class TmuxError(Exception):
    """tmux ran and complained, or could not be run at all."""


@dataclass(frozen=True)
class Socket:
    """Which tmux server every command in this process talks to.

    ``None`` is tmux's default socket — the one a bare ``tmux`` in a shell reaches,
    holding the user's real work. Point this at a throwaway socket (``tmux_socket:`` in
    the config, or ``--socket``) and nothing this process does can reach those sessions:
    not a stray command, not a crash of the server we drive. Tests and dev runs must
    always set it.
    """

    spec: str | None = None

    @classmethod
    def new(cls, spec: str | None) -> Socket:
        spec = spec.strip() if spec else ""
        return cls(spec or None)

    def args(self) -> list[str]:
        """Global flags, which tmux only accepts *before* the command name. A spec with
        a ``/`` is a socket path (``-S``), anything else a socket name under tmux's
        tmpdir (``-L``)."""
        if self.spec is None:
            return []
        return ["-S", self.spec] if "/" in self.spec else ["-L", self.spec]

    def label(self) -> str:
        """For the startup banner, so which server we drive is never a guess."""
        return self.spec or "default"


def is_no_server(stderr: str) -> bool:
    """"no server running" is the normal state when nothing is open — an empty list,
    not an error the UI should shout about."""
    s = stderr.lower()
    return any(
        m in s
        for m in ("no server running", "error connecting", "no current client", "failed to connect to server")
    )


def parse_sessions(stdout: str) -> list[dict]:
    out = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        # Session names may contain anything except a tab, so split from the right:
        # the last three fields are always ours.
        parts = line.rsplit("\t", 3)
        if len(parts) != 4:
            continue
        name, windows, attached, created = parts
        if not name:
            continue
        out.append(
            {
                "name": name,
                "windows": _int(windows),
                "attached": _int(attached),
                "created": _int(created),
            }
        )
    return out


def _int(s: str) -> int:
    try:
        return int(s.strip())
    except ValueError:
        return 0


def list_sessions(sock: Socket) -> list[dict]:
    try:
        p = subprocess.run(
            ["tmux", *sock.args(), "list-sessions", "-F", FORMAT],
            capture_output=True,
            text=True,
        )
    except OSError as e:
        raise TmuxError(f"could not run tmux: {e}") from e

    if p.returncode != 0:
        if is_no_server(p.stderr):
            return []
        raise TmuxError(p.stderr.strip() or "tmux failed")
    return parse_sessions(p.stdout)


class BadName(Exception):
    """The name cannot be used as a tmux target."""


def check_name(name: str) -> str:
    """tmux reads `:` and `.` as window and pane separators, so a session wearing either
    is unaddressable afterwards. Everything else a person might type is fine."""
    name = (name or "").strip()
    if not name:
        raise BadName("a session needs a name")
    if len(name) > 64:
        raise BadName("that name is too long")
    if any(c in name for c in ":."):
        raise BadName("a session name cannot contain ':' or '.'")
    if any(ord(c) < 32 for c in name):
        raise BadName("that name has control characters in it")
    return name


def new_argv(sock: Socket, name: str, path: str | None) -> list[str]:
    argv = ["tmux", *sock.args(), "new-session", "-d", "-s", name]
    if path:
        argv += ["-c", path]
    return argv


# `=name` is an exact match. Without it tmux accepts a prefix, and killing the wrong
# session because two names share a beginning is not a mistake worth risking.
def rename_argv(sock: Socket, name: str, to: str) -> list[str]:
    return ["tmux", *sock.args(), "rename-session", "-t", f"={name}", to]


def kill_argv(sock: Socket, name: str) -> list[str]:
    return ["tmux", *sock.args(), "kill-session", "-t", f"={name}"]


def run(argv: list[str]) -> None:
    try:
        p = subprocess.run(argv, capture_output=True, text=True)
    except OSError as e:
        raise TmuxError(f"could not run tmux: {e}") from e
    if p.returncode != 0:
        raise TmuxError(p.stderr.strip() or "tmux refused")


# A paste buffer holds a selection, not a file. Past this it is a mistake, and shipping
# megabytes into a phone's clipboard helps nobody.
MAX_BUFFER = 1024 * 1024


def show_buffer(sock: Socket) -> str:
    """What tmux last copied.

    Selecting with the mouse inside tmux puts the text in a *tmux* paste buffer on this
    machine — that is what the "copied 26 chars" message means — and a browser has no way
    to see it. Reading it back out is the only bridge to the clipboard of the device you
    are actually holding.

    Not `capture-pane`: that one takes the tmux server down on this host (see CLAUDE.md).
    `show-buffer` is a different command and is safe.
    """
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "show-buffer"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise TmuxError(f"could not read the buffer: {e}") from e
    if done.returncode != 0:
        stderr = done.stderr.strip()
        # An empty buffer stack is not a failure, it is "nothing has been copied yet".
        if "no buffer" in stderr.lower():
            return ""
        raise TmuxError(stderr or "tmux refused")
    return done.stdout[:MAX_BUFFER]


# Where tmux looks for its configuration, in the order it looks.
CONF_PLACES = ("~/.tmux.conf", "~/.config/tmux/tmux.conf")
CHECK_SOCKET = "argus-conf-check"


def conf_path() -> str:
    """The config file tmux would read, or where it should be written."""
    import os.path

    for place in CONF_PLACES:
        full = os.path.expanduser(place)
        if os.path.isfile(full):
            return full
    return os.path.expanduser(CONF_PLACES[0])


def complaint(done: subprocess.CompletedProcess) -> str:
    """What tmux is objecting to.

    `source-file` writes "file:12: unknown command: nonsense" to *stdout*, not stderr —
    reading only stderr turns a precise line number into a blank "it refused".
    """
    return (done.stderr.strip() or done.stdout.strip()).splitlines()[0] if (done.stderr.strip() or done.stdout.strip()) else ""


def check_conf(path: str) -> str | None:
    """Try the file on a throwaway tmux server. Returns the complaint, or None if fine.

    Sourcing a config *runs* it — including `run-shell`, `if-shell`, and anything else it
    holds — and a file that takes the server down takes every session with it. That has
    already happened once on this machine. So it is tried on a server of its own first,
    where the worst case costs nothing, and only then on the real one.

    This does mean side effects in the file happen twice. A config that starts programs
    is a config to apply by hand.
    """
    scratch = Socket.new(CHECK_SOCKET)
    run = lambda *args: subprocess.run(  # noqa: E731 — one shape, used three times
        ["tmux", *scratch.args(), *args], capture_output=True, text=True, timeout=20,
    )
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        run("kill-server")
    try:
        # A bare server first — `-f /dev/null` so it starts with no configuration at all —
        # and then the file through the very command the real server will run. Starting it
        # with `-f <path>` instead would not do: tmux shows those errors in the client's
        # window rather than on stderr, so a broken line came back looking fine.
        started = run("-f", "/dev/null", "new-session", "-d", "-s", "check", "-x", "80", "-y", "24")
        if started.returncode != 0:
            return complaint(started) or "could not start a test server"
        done = run("source-file", path)
    except (OSError, subprocess.SubprocessError) as e:
        return f"could not test the file: {e}"
    finally:
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            run("kill-server")

    if done.returncode != 0 or complaint(done):
        return complaint(done) or "tmux refused the file"
    return None


def source_conf(sock: Socket, path: str) -> str:
    """Make the running server read the file. Returns whatever tmux had to say."""
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "source-file", path],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise TmuxError(f"could not source the file: {e}") from e
    if done.returncode != 0:
        raise TmuxError(complaint(done) or "tmux refused the file")
    return complaint(done)


def session_exists(sock: Socket, name: str) -> bool:
    """True when a session with exactly this name exists right now. The WebSocket
    handler gates on this so a client can never name a session we did not enumerate."""
    try:
        return any(s["name"] == name for s in list_sessions(sock))
    except TmuxError:
        return False
