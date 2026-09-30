"""Whether each agent is working or waiting for you — worked out, not declared.

Bells and questions tell you when an agent *says* it needs you, which needs a hook in that
agent. This answers the same question for any agent with nothing installed, from two things
tmux and /proc already know:

- **what is running in the pane**: a process called `claude`, `codex`, `gemini`… anywhere under
  the pane's shell (or a launcher of yours) makes it an agent; a bare shell is not one;
- **whether the pane is still drawing**. Measured on Claude Code on 2026-09-30: while it works
  it redraws continuously — its spinner, about 700 bytes every half second — including while a
  tool it started runs for fifteen seconds; the moment it has answered, or stopped to ask, the
  pane goes quiet, apart from one small redraw every ten seconds or so.

So an agent is **working** while its window's activity keeps moving, and **waiting** once it
has stopped. `#{window_activity}` has one-second resolution, so a single glance cannot tell a
spinner from that lone redraw: the window is sampled once a second and "working" means the
activity advanced in most of the last few seconds. The sampler runs only while somebody is
looking — each read of the states keeps it alive for a minute — unless it is `always` on, which
is how the server runs it so that an agent that stops can ring with no browser open. It never
reads the screen (no capture-pane: see CLAUDE.md).

Each change of state is also queued as an event, `(session, was, now, agent)`, for whoever
drains `changes()`: that is how "it stopped" becomes a notification (bells.py).
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time
from collections import deque

# Names a coding agent answers to, as argv[0] or — for node and python launchers — argv[1].
KNOWN = frozenset({
    "claude", "codex", "gemini", "aider", "opencode", "cursor-agent", "goose", "amp", "qwen",
    "crush", "copilot", "kiro", "droid",
})
# Words before the program on a launcher's line: `sudo -E x`, `env A=1 x`, `nohup x`.
PREFIXES = frozenset({"sudo", "env", "exec", "nohup", "time", "nice", "command", "stdbuf"})
# A segment that only prepares the environment: `conda activate x && claude`.
SETUP = frozenset({"conda", "mamba", "micromamba", "source", ".", "cd", "export", "module", "pyenv", "nvm", "set"})

SAMPLE_EVERY = 1.0          # seconds between readings of window activity
WINDOW = 4                  # readings considered
MOVING = 2                  # advances within them that mean "still drawing"
AGENTS_EVERY = 5.0          # the process tree is dearer than a list-windows: less often
AGENTS_UNWATCHED = 15.0     # …and less often still while no browser is reading the states
KEEP_ALIVE = 60.0           # the sampler stops this long after the last reader


def launcher_words(commands: list[str]) -> frozenset[str]:
    """The program each configured launcher runs, so an agent of your own is recognised too —
    `conda activate x && my-agent` counts as `my-agent`, `sudo -E thing` as `thing`."""
    out = set()
    for line in commands:
        for segment in line.replace("&&", ";").replace("||", ";").replace("|", ";").split(";"):
            words = [w for w in segment.split() if w]
            while words and (words[0] in PREFIXES or words[0].startswith("-") or "=" in words[0]):
                words.pop(0)
            if not words:
                continue
            program = os.path.basename(words[0])
            if program and program not in SETUP:
                out.add(program)
    return frozenset(out)


def agent_in(argv: list[str], names: frozenset[str]) -> str | None:
    """The agent a command line is, if any: argv[0], or argv[1] after an interpreter."""
    if not argv:
        return None
    first = os.path.basename(argv[0])
    if first in names:
        return first
    if first in ("node", "bun", "deno", "python", "python3") and len(argv) > 1:
        second = os.path.basename(argv[1])
        for suffix in (".js", ".mjs", ".cjs", ".py"):
            second = second.removesuffix(suffix)
        if second in names:
            return second
    return None


def parse_ps(text: str) -> dict[int, tuple[int, list[str]]]:
    """`ps -eo pid=,ppid=,args=` → pid -> (ppid, argv)."""
    out = {}
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        out[int(parts[0])] = (int(parts[1]), parts[2].split() if len(parts) > 2 else [])
    return out


def agent_under(root: int, tree: dict[int, tuple[int, list[str]]], names: frozenset[str]) -> str | None:
    """The first agent found at or below a pane's own process."""
    children: dict[int, list[int]] = {}
    for pid, (ppid, _argv) in tree.items():
        children.setdefault(ppid, []).append(pid)
    stack, seen = [root], set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        found = agent_in(tree.get(pid, (0, []))[1], names)
        if found:
            return found
        stack.extend(sorted(children.get(pid, ())))
    return None


def moving(readings: list[int]) -> bool:
    """Whether a window's activity kept advancing: a spinner, not one lone redraw."""
    recent = readings[-WINDOW:]
    advances = sum(1 for a, b in zip(recent, recent[1:]) if b > a)
    return advances >= MOVING


def decide(readings: list[int], now: float) -> str | None:
    """working or waiting, for a window that holds an agent — or None while there are too few
    readings to tell. Guessing from the last activity alone was tried and was wrong: on the
    first reading of a real machine every idle agent had redrawn something in the last two
    seconds, and all of them came out "working". Three seconds without a state is better than
    three seconds of a false one."""
    if len(readings) < 3:
        return None
    return "working" if moving(readings) else "waiting"


class Watch:
    """The sampler. `states()` is what the API reads; reading it keeps the sampler running."""

    def __init__(self, sock, commands: list[str] | None = None):
        self.sock = sock
        self.names = KNOWN | launcher_words(commands or [])
        self.readings: dict[str, deque] = {}        # window id -> activity readings
        self.windows: dict[str, str] = {}           # window id -> session
        self.agents: dict[str, str] = {}            # window id -> agent name
        self.state: dict[str, tuple[str, float]] = {}   # session -> (state, since)
        self.agents_read = 0.0
        self.asked = 0.0
        self.task: asyncio.Task | None = None
        self.always = False                         # keep sampling with nobody reading
        self.events: deque = deque(maxlen=256)      # (session, was, now, agent) changes
        self.on_change = None                       # called in the loop with each change

    # ------------------------------------------------------------ reading tmux and /proc

    def _tmux(self, *args: str) -> str:
        env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
        try:
            p = subprocess.run(["tmux", *self.sock.args(), *args], capture_output=True,
                               text=True, timeout=4, env=env)
        except (OSError, subprocess.SubprocessError):
            return ""
        return p.stdout if p.returncode == 0 else ""

    def read_windows(self) -> dict[str, tuple[str, int]]:
        out = {}
        for line in self._tmux("list-windows", "-a", "-F",
                               "#{window_id}\t#{window_activity}\t#{session_name}").splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3 and parts[1].isdigit():
                out[parts[0]] = (parts[2], int(parts[1]))
        return out

    def read_agents(self) -> dict[str, str]:
        panes = []
        for line in self._tmux("list-panes", "-a", "-F", "#{window_id}\t#{pane_pid}").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].isdigit():
                panes.append((parts[0], int(parts[1])))
        if not panes:
            return {}
        try:
            ps = subprocess.run(["ps", "-ww", "-eo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=4)
            tree = parse_ps(ps.stdout) if ps.returncode == 0 else {}
        except (OSError, subprocess.SubprocessError):
            tree = {}
        found: dict[str, str] = {}
        for window, pid in panes:
            name = agent_under(pid, tree, self.names)
            if name and window not in found:
                found[window] = name
        return found

    # ------------------------------------------------------------ one reading

    def tick(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        windows = self.read_windows()
        every = AGENTS_EVERY if now - self.asked < KEEP_ALIVE else AGENTS_UNWATCHED
        if now - self.agents_read >= every or set(windows) - set(self.windows):
            self.agents = self.read_agents()
            self.agents_read = now
        self.windows = {w: s for w, (s, _a) in windows.items()}
        for w, (_s, activity) in windows.items():
            self.readings.setdefault(w, deque(maxlen=WINDOW + 2)).append(activity)
        for gone in set(self.readings) - set(windows):
            del self.readings[gone]
        # A session is waiting if any agent in it is; working if any is working.
        by_session: dict[str, str] = {}
        for w, agent in self.agents.items():
            if w not in self.windows:
                continue
            s = self.windows[w]
            verdict = decide(list(self.readings.get(w, ())), now)
            if verdict is None:
                continue
            if verdict == "waiting" or by_session.get(s) != "waiting":
                by_session[s] = verdict
        for s, verdict in by_session.items():
            was = self.state.get(s, ("", 0))[0]
            if was != verdict:
                self.state[s] = (verdict, now)
                agent = next((a for w, a in self.agents.items() if self.windows.get(w) == s), None)
                self.events.append((s, was or None, verdict, agent))
        for s in set(self.state) - set(by_session):
            del self.state[s]

    # ------------------------------------------------------------ the loop, and reading it

    def changes(self) -> list[tuple]:
        """The changes of state since the last call, oldest first."""
        out = list(self.events)
        self.events.clear()
        return out

    async def _loop(self) -> None:
        try:
            while self.always or time.time() - self.asked < KEEP_ALIVE:
                try:
                    await asyncio.to_thread(self.tick)
                    if self.on_change:
                        for change in self.changes():
                            self.on_change(*change)
                except Exception:
                    pass                             # one bad reading must not stop the watch
                await asyncio.sleep(SAMPLE_EVERY)
        finally:
            self.task = None

    def wake(self) -> None:
        """Start the sampler if it is asleep. Needs a running event loop."""
        if self.task is None:
            self.task = asyncio.get_running_loop().create_task(self._loop())

    def states(self) -> dict[str, dict]:
        """{session: {agent, state, since}}; starts the sampler if it was asleep."""
        self.asked = time.time()
        if self.task is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None                          # a script or a test: whoever calls tick() drives it
            if loop is not None:
                self.task = loop.create_task(self._loop())
        agents_by_session: dict[str, str] = {}
        for w, agent in self.agents.items():
            s = self.windows.get(w)
            if s and s not in agents_by_session:
                agents_by_session[s] = agent
        return {s: {"agent": agents_by_session.get(s), "state": st, "since": since}
                for s, (st, since) in self.state.items()}
