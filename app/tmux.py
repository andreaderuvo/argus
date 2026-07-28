"""Talking to tmux: which server, and what sessions are on it."""

from __future__ import annotations

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


def session_exists(sock: Socket, name: str) -> bool:
    """True when a session with exactly this name exists right now. The WebSocket
    handler gates on this so a client can never name a session we did not enumerate."""
    try:
        return any(s["name"] == name for s in list_sessions(sock))
    except TmuxError:
        return False
