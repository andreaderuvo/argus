"""Talking to tmux: which server, and what sessions are on it."""

from __future__ import annotations

import contextlib
import re
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


def declared(sock: Socket) -> dict[str, dict]:
    """What the agents on this machine have said about themselves, by session.

    `@argus_agent` and `@argus_model` are pane options — written by a hook that knows, since
    nothing outside an agent can work either of them out — and this is one `list-panes` for
    the whole server rather than a question per session. A board sweeping ten machines every
    few seconds is the reason: the answer has to cost the same whether a machine has two
    sessions or forty.

    Session options are not consulted on purpose. A pane says what is in *that* pane, and a
    session with two of them holding two different agents should not be made to pick one.
    """
    try:
        p = subprocess.run(
            ["tmux", *sock.args(), "list-panes", "-a", "-F",
             "#{session_name}\t#{@argus_agent}\t#{@argus_model}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if p.returncode != 0:
        return {}
    said = {}
    for line in p.stdout.splitlines():
        parts = line.rsplit("\t", 2)
        if len(parts) != 3:
            continue
        name, agent, model = (bit.strip() for bit in parts)
        if not name or (not agent and not model):
            continue
        # The first pane that says anything wins: a second one answering differently is a
        # split with two agents in it, and the tile has room for one word.
        said.setdefault(name, {"agent": agent or None, "model": model or None})
    return said


def pane_pids(sock: Socket) -> dict[str, list[int]]:
    """Every pane's own pid, by session — the root of whatever is actually running in it.

    One `list-panes` for the whole server, the same shape and the same reason as
    `declared`: asking what a session costs should cost the same whether there are two
    panes or two hundred.
    """
    try:
        p = subprocess.run(
            ["tmux", *sock.args(), "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if p.returncode != 0:
        return {}
    out: dict[str, list[int]] = {}
    for line in p.stdout.splitlines():
        parts = line.rsplit("\t", 1)
        if len(parts) != 2:
            continue
        name, pid = parts
        if not name or not pid.strip().isdigit():
            continue
        out.setdefault(name, []).append(int(pid))
    return out


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


def copy_mode(sock: Socket, session: str) -> dict:
    """Whether the pane is showing history, and how far back.

    Scrolling in Argus does not scroll the browser: tmux owns the scrollback, and a wheel
    over the pane puts tmux into copy-mode. So "am I at the live end?" is a question only
    tmux can answer.
    """
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "display-message", "-p", "-t", session,
             # `alternate_on` is the difference between "tmux is holding the history" and
             # "a full-screen program is drawing its own": in the second case there is no
             # copy-mode to leave, and the scrolling belongs to the program.
             "#{pane_in_mode} #{scroll_position} #{alternate_on}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return {"in_mode": False, "position": 0}
    parts = done.stdout.split()
    if done.returncode != 0 or len(parts) < 3:
        return {"in_mode": False, "position": 0, "alternate": False}
    return {"in_mode": parts[0] == "1", "position": _int(parts[1]), "alternate": parts[2] == "1"}


def leave_copy_mode(sock: Socket, session: str) -> bool:
    """Back to the live end. Returns False when there was nothing to leave.

    `send-keys -X cancel` is the whole trick: in copy-mode it ends it, and outside copy-mode
    it answers "not in a mode" and — this is the part that matters — types nothing into the
    shell, which sending a literal `q` would.
    """
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "send-keys", "-t", session, "-X", "cancel"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise TmuxError(str(e)) from e
    if done.returncode == 0:
        return True
    if "not in a mode" in done.stderr.lower():
        return False
    raise TmuxError(done.stderr.strip() or "tmux refused")


def session_exists(sock: Socket, name: str) -> bool:
    """True when a session with exactly this name exists right now. The WebSocket
    handler gates on this so a client can never name a session we did not enumerate."""
    try:
        return any(s["name"] == name for s in list_sessions(sock))
    except TmuxError:
        return False


# The only options a look may set. Style options and nothing else: no keys, no behaviour,
# nothing a running program can notice — and a fixed list rather than a pattern, because
# "looks like a style option" is not a security boundary.
STYLE_OPTIONS = frozenset({
    "status-style",
    "status-left",
    "status-right",
    "window-status-style",
    "window-status-current-style",
    "pane-border-style",
    "pane-active-border-style",
    "message-style",
    "mode-style",
})

# What a value may contain. tmux styles are colours, attributes and its own #{} bits;
# anything outside this is refused rather than escaped, since there is no reason for a
# look to need it.
SAFE_STYLE = re.compile(r"^[\w #,=\-.:?%{}\[\]<>|&!/]*$")


def style(sock: Socket, session: str, options: dict[str, str]) -> None:
    """Dress one session, without touching the config file.

    Style options are session options, so this reaches exactly the session named and
    nothing else — which is what "just this window" means. An empty value unsets it,
    putting that option back to whatever the server says.
    """
    for name, value in options.items():
        if name not in STYLE_OPTIONS:
            raise TmuxError(f"{name} is not a style option")
        if not isinstance(value, str) or not SAFE_STYLE.match(value):
            raise TmuxError(f"that is not a style value for {name}")
        argv = ["tmux", *sock.args(), "set-option", "-t", session]
        argv += ["-u", name] if value == "" else [name, value]
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as e:
            raise TmuxError(f"could not set {name}: {e}") from e
        if done.returncode != 0:
            raise TmuxError(complaint(done) or f"tmux refused {name}")
