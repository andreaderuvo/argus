"""The machine's processes, read once and shared.

Four parts of Argus wanted the process table: the agent-state sampler (every second, always),
the folders of the terminals on a desk (every 10 s per tab), the System screen (every second while
open), and the agents-seen register (every 30 s). Each ran its own `ps` — 40 ms and a process to
start every time, two per terminal for the folders (measured 2026-10-14: 65 ms per terminal,
~1.6 `ps` a second with the sampler alone).

On Linux the same facts are files in /proc, readable without starting anything: 1,700 processes
in ~15 ms. Read once, kept for half a second, every caller in that moment shares it. A command
line is read only when somebody looks at it — the sampler looks at the few under a pane, not at
the 1,700. Where there is no /proc (macOS) `table()` answers None and callers keep using `ps`.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Sequence

FRESH_FOR = 0.5
PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
TICK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


class Argv(Sequence):
    """A process's command line, read from /proc/<pid>/cmdline the first time it is used."""

    __slots__ = ("pid", "_words")

    def __init__(self, pid: int):
        self.pid = pid
        self._words: list[str] | None = None

    def _load(self) -> list[str]:
        if self._words is None:
            try:
                with open(f"/proc/{self.pid}/cmdline", "rb") as f:
                    raw = f.read()
                self._words = [w.decode("utf-8", "replace") for w in raw.split(b"\0") if w]
            except OSError:
                self._words = []
        return self._words

    def __getitem__(self, i):
        return self._load()[i]

    def __len__(self) -> int:
        return len(self._load())

    def __iter__(self):
        return iter(self._load())

    def __eq__(self, other) -> bool:
        return list(self._load()) == list(other)

    def __repr__(self) -> str:
        return f"Argv({self._load()!r})"


class Proc:
    __slots__ = ("pid", "ppid", "pgid", "tpgid", "tty", "comm", "argv", "rss", "cpu", "start")

    def __init__(self, pid, ppid, pgid, tpgid, tty, comm, rss, cpu, start):
        self.pid, self.ppid, self.pgid, self.tpgid, self.tty = pid, ppid, pgid, tpgid, tty
        self.comm, self.rss, self.cpu, self.start = comm, rss, cpu, start
        self.argv = Argv(pid)

    @property
    def args(self) -> str:
        return " ".join(self.argv)


def _read_all() -> dict[int, Proc] | None:
    try:
        names = os.listdir("/proc")
    except OSError:
        return None
    out: dict[int, Proc] = {}
    for d in names:
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat", "rb") as f:
                raw = f.read().decode("utf-8", "replace")
        except OSError:
            continue                      # gone between the listing and the look
        # The command name may hold spaces and parentheses: it ends at the LAST ')'.
        left, right = raw.find("("), raw.rfind(")")
        if left < 0 or right < 0:
            continue
        rest = raw[right + 2:].split()
        if len(rest) < 22:
            continue
        try:
            out[int(d)] = Proc(
                pid=int(d), ppid=int(rest[1]), pgid=int(rest[2]), tpgid=int(rest[5]), tty=int(rest[4]),
                comm=raw[left + 1:right], rss=int(rest[21]) * PAGE,
                cpu=(int(rest[11]) + int(rest[12])) / TICK, start=int(rest[19]) / TICK,
            )
        except ValueError:
            continue
    return out


_lock = threading.Lock()
_cached: tuple[float, dict[int, Proc] | None] = (0.0, None)


def table(fresh_for: float = FRESH_FOR) -> dict[int, Proc] | None:
    """pid -> Proc for every process, or None where there is no /proc. Shared for `fresh_for`
    seconds: the callers of one moment read the machine once."""
    global _cached
    with _lock:
        at, procs = _cached
        if procs is not None and time.monotonic() - at < fresh_for:
            return procs
        procs = _read_all()
        _cached = (time.monotonic(), procs)
        return procs


def tree(fresh_for: float = FRESH_FOR) -> dict[int, tuple[int, Sequence[str]]] | None:
    """pid -> (ppid, argv), the shape `ps -eo pid=,ppid=,args=` was parsed into — argv lazy."""
    procs = table(fresh_for)
    if procs is None:
        return None
    return {p.pid: (p.ppid, p.argv) for p in procs.values()}


def tty_number(tty: str) -> int | None:
    """/dev/pts/7 → the device number /proc/<pid>/stat reports as tty_nr."""
    try:
        return os.stat(tty).st_rdev
    except OSError:
        return None


def on_tty(tty: str) -> list[Proc] | None:
    """Every process whose controlling terminal is `tty`, in pid order; None without /proc."""
    procs = table()
    if procs is None:
        return None
    number = tty_number(tty)
    if number is None:
        return []
    return sorted((p for p in procs.values() if p.tty == number), key=lambda p: p.pid)


def uptime() -> float:
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0
