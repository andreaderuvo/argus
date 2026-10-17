"""Talking to tmux: which server, and what sessions are on it."""

from __future__ import annotations

import contextlib
import re
import subprocess
from pathlib import Path
from dataclasses import dataclass

# An explicit format string, so we parse fields we chose rather than tmux's
# human-readable layout (which changes between versions).
# `session_activity`: the last time anything happened in it — output or a key — which is what
# tells a session that is quietly working from one forgotten for a week.
FORMAT = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}"
# A note of the person's about what a session is for, kept in tmux as a session option: it lives and
# dies with the session, follows a rename, and a new session under the same name does not inherit it.
NOTE_OPTION = "@argus_note"
NOTE_MAX = 300


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
    not an error the UI should shout about. So is a server caught in the act of ending
    ("server exited unexpectedly", "lost server"): asked a moment later, it is not there."""
    s = stderr.lower()
    return any(
        m in s
        for m in ("no server running", "error connecting", "no current client", "failed to connect to server",
                  "server exited unexpectedly", "lost server", "no sessions")
    )


def parse_sessions(stdout: str) -> list[dict]:
    out = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        # Session names may contain anything except a tab, so split from the right: the fields
        # after the name are always ours (four of them; three from an older format).
        parts = line.rsplit("\t", 4)
        if len(parts) == 5 and parts[4].strip().isdigit() and parts[3].strip().isdigit():
            name, windows, attached, created, activity = parts
        else:
            parts = line.rsplit("\t", 3)
            if len(parts) != 4:
                continue
            name, windows, attached, created = parts
            activity = created
        if not name:
            continue
        out.append(
            {
                "name": name,
                "windows": _int(windows),
                "attached": _int(attached),
                "created": _int(created),
                "activity": _int(activity),
            }
        )
    return out


def _int(s: str) -> int:
    try:
        return int(s.strip())
    except ValueError:
        return 0


def list_sessions(sock: Socket) -> list[dict]:
    """Every session, with its note and its last activity — in ONE tmux call (three commands
    joined by `;`). It was three processes one after the other, on every Sessions screen, every
    overview a board asks for and every count in the header (measured 2026-10-14)."""
    try:
        p = subprocess.run(
            ["tmux", *sock.args(),
             "list-sessions", "-F", "S\t" + FORMAT, ";",
             # The notes: their own lines, so a note can never confuse the fields above.
             "list-sessions", "-F", f"N\t#{{session_name}}\t#{{{NOTE_OPTION}}}", ";",
             # `session_activity` moves only when a client does something; a program printing does
             # not touch it. Its windows' `window_activity` does: the last activity is the latest.
             "list-windows", "-a", "-F", "W\t#{session_name}\t#{window_activity}"],
            capture_output=True,
            text=True,
        )
    except OSError as e:
        raise TmuxError(f"could not run tmux: {e}") from e

    # Three commands in one call: when a session (or the server) goes in the middle of it — a team
    # restarting ends its sessions while a page is counting them — tmux stops at the command that
    # found nothing and says so, after answering the first. What it answered is the answer.
    answered = any(line.startswith("S\t") for line in p.stdout.splitlines())
    if p.returncode != 0 and not answered:
        if is_no_server(p.stderr):
            return []
        raise TmuxError(p.stderr.strip() or "tmux failed")
    rows, notes, latest = [], {}, {}
    for line in p.stdout.splitlines():
        kind, _, rest = line.partition("\t")
        if kind == "S":
            rows.append(rest)
        elif kind == "N":
            name, _, note = rest.partition("\t")
            if name and note:
                notes[name] = note
        elif kind == "W":
            name, _, when = rest.rpartition("\t")
            if name and when.strip().isdigit():
                latest[name] = max(latest.get(name, 0), int(when))
    out = parse_sessions("\n".join(rows))
    for s in out:
        s["note"] = notes.get(s["name"], "")
        s["activity"] = max(s["activity"], latest.get(s["name"], 0))
    return out


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


def parent_of(pid: int) -> int:
    """The parent pid, from /proc (0 when it cannot be read). The command name in `stat` may hold
    spaces and parentheses, so the fields are read after the *last* `)`."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return int(stat[stat.rindex(")") + 2:].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def session_of_pid(sock: Socket, pid: int) -> str | None:
    """The tmux session a process runs in, found by walking up its parents to a pane's own pid.

    For a program that cannot ask tmux itself: Codex starts its MCP servers with a bare
    environment — no TMUX, no TMUX_PANE — so `display-message` there names nothing, and a
    team's `team_done` could not say whose turn it was reporting (seen on a real team,
    2026-10-07). Reads `list-panes` and /proc only."""
    panes = {p: name for name, ps in pane_pids(sock).items() for p in ps}
    seen = 0
    while pid > 1 and seen < 64:
        if pid in panes:
            return panes[pid]
        pid, seen = parent_of(pid), seen + 1
    return None


def has_children(pid: int) -> bool:
    """Whether anything runs under this process — for a pane's shell: is it at its prompt, or
    running something. Reads /proc (field 4 of each stat, after the command name's last `)`),
    else asks `pgrep -P`."""
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text()
            except OSError:
                continue
            fields = stat[stat.rfind(")") + 2:].split()
            if len(fields) > 1 and fields[1] == str(pid):
                return True
        return False
    try:
        return subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, timeout=4).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


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


def copy_modes(sock: Socket, sessions: list[str]) -> dict[str, dict]:
    """`copy_mode` for many sessions in ONE tmux call — the active pane of each one's active
    window, which is what an attached client shows. A desk of four terminals asked once each
    every 2.5 s, two tmux processes per question (is it there? what mode?): 32 a minute… per
    page, and each tab or device its own. Sessions not listed come back `{gone: True}`."""
    wanted = set(sessions)
    out: dict[str, dict] = {}
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "list-panes", "-a", "-F",
             "#{window_active}#{pane_active}\t#{pane_in_mode}\t#{scroll_position}\t#{alternate_on}\t#{session_name}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        done = None
    if done is not None and done.returncode == 0:
        for line in done.stdout.splitlines():
            parts = line.split("\t", 4)
            if len(parts) < 5 or parts[0] != "11" or parts[4] not in wanted:
                continue
            out[parts[4]] = {"in_mode": parts[1] == "1", "position": _int(parts[2]), "alternate": parts[3] == "1"}
    for name in wanted - out.keys():
        out[name] = {"in_mode": False, "position": 0, "alternate": False, "gone": True}
    return out


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
    # One tmux for all of them, the commands chained with `;`: nine processes per session made
    # "apply to everything" on thirteen sessions a long freeze (2026-10-13).
    commands: list[list[str]] = []
    for name, value in options.items():
        if name not in STYLE_OPTIONS:
            raise TmuxError(f"{name} is not a style option")
        if not isinstance(value, str) or not SAFE_STYLE.match(value):
            raise TmuxError(f"that is not a style value for {name}")
        commands.append(["set-option", "-t", session] + (["-u", name] if value == "" else [name, value]))
    if not commands:
        return
    argv = ["tmux", *sock.args()]
    for i, command in enumerate(commands):
        argv += ([";"] if i else []) + command
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as e:
        raise TmuxError(f"could not set the style: {e}") from e
    if done.returncode != 0:
        raise TmuxError(complaint(done) or "tmux refused the style")


def clean_note(text: str) -> str:
    """One line, no control characters, at most NOTE_MAX: it is shown on a row, and tabs and
    newlines would break the list it is read back from."""
    flat = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or "")).strip()
    return re.sub(r" {2,}", " ", flat)[:NOTE_MAX]


def set_note(sock: Socket, session: str, text: str) -> str:
    """Write (or, empty, remove) the note of a session. Argv, never a shell: the text is whatever
    the person typed."""
    note = clean_note(text)
    argv = ["tmux", *sock.args(), "set-option", "-t", session] + (["-u", NOTE_OPTION] if not note else [NOTE_OPTION, note])
    done = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    if done.returncode != 0:
        raise TmuxError(complaint(done) or "tmux refused the note")
    return note
