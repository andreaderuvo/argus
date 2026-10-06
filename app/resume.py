"""Bringing agents back after the tmux server that held them has gone.

tmux keeps a session alive through a closed browser, a dropped ssh and a restart of Argus —
but not through a reboot, or the death of the tmux server itself: every process on it dies,
and with it the list of what was running where. herdr answers this the honest way, which is
also the only way: the processes cannot survive, but the *conversations* can, because every
agent keeps its own on disk and can be told to resume one.

So the server keeps a register of the agents it sees (`agents-seen.json` beside the config):
per session, the folder, the agent, the flags it was started with, and the conversation it is
in. Claude Code says which conversation at the end of every turn, through its hook (`argus-bell`
passes `CLAUDE_CODE_SESSION_ID` on); Codex keeps the file of its conversation open, and the id
is in that file's name. Nothing is guessed: an agent whose conversation is not known comes back
as a new conversation in the same folder, and says so.

What counts as lost is decided by the tmux server, not by the session: a session that is gone
while the same server is still up ended on purpose — someone typed `exit`, or killed it — and is
simply forgotten. Only when the server itself changed (a different pid or start time, or none at
all) are the sessions it held, and does not hold any more, offered back.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

from . import tmux
from .agentstate import KNOWN, agent_in, parse_ps

KEEP_LOST = 14 * 86400          # a loss nobody acted on for two weeks is not going to be
MAX_AT_ONCE = 20

# Flags worth carrying over, per agent; anything else on the old command line (a prompt, a
# --print, an old --resume) is dropped. Valued flags take the next word with them.
FLAGS = {
    "claude": ({"--dangerously-skip-permissions", "--verbose", "--ide"},
               {"--model", "--permission-mode", "--add-dir", "--agent", "--settings", "--mcp-config"}),
    "codex": ({"--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--search"},
              {"-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile"}),
}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def default_store(config_path: Path) -> Path:
    return config_path.parent / "agents-seen.json"


def boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return ""


def _tmux(sock: tmux.Socket, *args: str) -> subprocess.CompletedProcess | None:
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    try:
        return subprocess.run(["tmux", *sock.args(), *args], capture_output=True, text=True, timeout=5, env=env)
    except (OSError, subprocess.SubprocessError):
        return None


def server_identity(sock: tmux.Socket) -> tuple[bool, str | None]:
    """(answered, identity): the server's pid and start time. `answered` is false when tmux
    could not be asked at all — a timeout is not a dead server, and must not be read as one,
    or one slow moment would declare every session lost. A server that is not running answers,
    with identity None. Asked through list-sessions, which needs no client attached."""
    p = _tmux(sock, "list-sessions", "-F", "#{pid}:#{start_time}")
    if p is None:
        return False, None
    if p.returncode == 0:
        first = p.stdout.strip().splitlines()[:1]
        return (True, first[0]) if first else (True, None)
    said = (p.stderr or "").lower()
    if any(m in said for m in ("no server running", "error connecting", "failed to connect to server")):
        return True, None
    return False, None


def _descendants(root: int, tree: dict) -> list[int]:
    children: dict[int, list[int]] = {}
    for pid, (ppid, _argv) in tree.items():
        children.setdefault(ppid, []).append(pid)
    out, stack = [], [root]
    while stack:
        pid = stack.pop()
        if pid in out:
            continue
        out.append(pid)
        stack.extend(children.get(pid, ()))
    return out


def codex_conversation(pids: list[int]) -> str | None:
    """The conversation a Codex is in: the newest `rollout-…-<uuid>.jsonl` it holds open."""
    best = (0.0, None)
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if "/.codex/sessions/" not in target or not target.endswith(".jsonl"):
                continue
            found = UUID.findall(os.path.basename(target))
            if not found:
                continue
            try:
                when = os.stat(target).st_mtime
            except OSError:
                when = 0.0
            if when >= best[0]:
                best = (when, found[-1])
    return best[1]


def flags_of(agent: str, argv: list[str]) -> list[str]:
    plain, valued = FLAGS.get(agent, (set(), set()))
    out, i = [], 0
    while i < len(argv):
        word = argv[i]
        key = word.split("=", 1)[0]
        if key in plain:
            out.append(word)
        elif key in valued:
            if "=" in word:
                out.append(word)
            elif i + 1 < len(argv):
                out += [word, argv[i + 1]]
                i += 1
        i += 1
    return out


def snapshot(sock: tmux.Socket, names: frozenset[str], told: dict[str, str]) -> dict[str, dict] | None:
    """Every session with an agent in it, as it is now; None if tmux could not be read.
    `told` is session -> conversation id, as the agents' hooks reported it."""
    p = _tmux(sock, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_current_path}")
    if p is None or p.returncode != 0:
        return None
    try:
        ps = subprocess.run(["ps", "-ww", "-eo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=5)
        tree = parse_ps(ps.stdout) if ps.returncode == 0 else {}
    except (OSError, subprocess.SubprocessError):
        return None
    out: dict[str, dict] = {}
    for line in p.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not parts[1].isdigit() or parts[0] in out:
            continue
        session, pane_pid, pane_path = parts[0], int(parts[1]), parts[2]
        for pid in _descendants(pane_pid, tree):
            argv = tree.get(pid, (0, []))[1]
            agent = agent_in(argv, names)
            if not agent:
                continue
            # A node or python launcher: the agent's own words start after the script.
            words = argv[2:] if os.path.basename(argv[0]) in ("node", "bun", "deno", "python", "python3") else argv[1:]
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                cwd = pane_path
            cwd = cwd.removesuffix(" (deleted)")
            conversation = None
            if agent == "codex":
                # The file it holds open first; its hooks say the same id (session_id) since 0.160.
                conversation = codex_conversation(_descendants(pid, tree)) or told.get(session)
            elif agent == "claude":
                conversation = told.get(session)
                if not conversation:
                    for flag in ("--resume", "-r"):
                        if flag in words and words.index(flag) + 1 < len(words):
                            conversation = UUID.match(words[words.index(flag) + 1]) and words[words.index(flag) + 1]
            out[session] = {"agent": agent, "cwd": cwd, "flags": flags_of(agent, words),
                            "conversation": conversation or None, "seen": time.time()}
            break
    return out


def command_for(record: dict) -> tuple[str, str]:
    """(shell line, how) to bring a recorded agent back. `how` is what the page says about it:
    `resume` — the same conversation; `fresh` — a new one, in the same folder."""
    agent = record.get("agent") or ""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", agent):
        raise ValueError("not an agent name")
    flags = [tmux_quote(f) for f in record.get("flags") or []]
    conv = record.get("conversation")
    if conv and not UUID.fullmatch(conv):
        conv = None
    if agent == "claude" and conv:
        return " ".join(["claude", "--resume", conv, *flags]), "resume"
    if agent == "codex" and conv:
        return " ".join(["codex", "resume", *flags, conv]), "resume"
    return " ".join([agent, *flags]), "fresh"


def tmux_quote(s: str) -> str:
    return s if re.fullmatch(r"[A-Za-z0-9._/:=@+-]+", s) else "'" + s.replace("'", "'\\''") + "'"


class Ledger:
    """The register, and the one decision it exists for: what is lost."""

    def __init__(self, path: Path | None):
        self.path = path
        self.data = {"server": None, "boot": "", "sessions": {}, "lost": {}}
        if path and path.exists():
            try:
                loaded = json.loads(path.read_text())
                if isinstance(loaded, dict):
                    self.data.update({k: loaded[k] for k in self.data if k in loaded})
            except (OSError, ValueError):
                pass

    def save(self) -> None:
        if not self.path:
            return
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1))
        os.replace(tmp, self.path)

    def observe(self, server: str | None, boot: str, now: dict[str, dict], alive: set[str]) -> list[str]:
        """Fold one reading in. Returns the sessions that have just been found lost."""
        d = self.data
        found = []
        changed = d.get("server") != server or (boot and d.get("boot") and boot != d.get("boot"))
        if changed:
            for name, rec in d["sessions"].items():
                if name not in alive:
                    d["lost"][name] = {**rec, "lost_at": time.time()}
                    found.append(name)
            d["sessions"] = {}
        else:
            for name in [n for n in d["sessions"] if n not in alive]:
                del d["sessions"][name]          # ended on purpose, on a server still up
        for name, rec in now.items():
            old = d["sessions"].get(name) or {}
            if not rec.get("conversation") and old.get("conversation") and old.get("agent") == rec.get("agent"):
                rec = {**rec, "conversation": old["conversation"]}
            d["sessions"][name] = rec
        for name in [n for n, rec in d["lost"].items()
                     if n in alive or time.time() - rec.get("lost_at", 0) > KEEP_LOST]:
            del d["lost"][name]
        d["server"], d["boot"] = server, boot or d.get("boot", "")
        self.save()
        return found

    def lost(self) -> list[dict]:
        out = []
        for name, rec in sorted(self.data["lost"].items(), key=lambda kv: -kv[1].get("seen", 0)):
            try:
                line, how = command_for(rec)
            except ValueError:
                continue
            out.append({"name": name, "agent": rec.get("agent"), "cwd": rec.get("cwd"),
                        "conversation": rec.get("conversation"), "how": how, "command": line,
                        "seen": rec.get("seen"), "lost_at": rec.get("lost_at")})
        return out

    def forget(self, names: list[str]) -> list[str]:
        gone = [n for n in names if self.data["lost"].pop(n, None) is not None]
        if gone:
            self.save()
        return gone


def read_now(sock: tmux.Socket, names: frozenset[str], told: dict[str, str]):
    """One reading: (answered, server, sessions-with-agents, all live session names)."""
    answered, server = server_identity(sock)
    if not answered:
        return False, None, {}, set()
    if server is None:
        return True, None, {}, set()
    current = snapshot(sock, names, told)
    if current is None:
        return False, None, {}, set()
    try:
        alive = {s["name"] for s in tmux.list_sessions(sock)}
    except Exception:
        return False, None, {}, set()
    return True, server, current, alive


def bring_back(sock: tmux.Socket, record: dict, name: str, home: str) -> str:
    """Start it again, under its old name, in its old folder. Returns how ('resume'/'fresh')."""
    line, how = command_for(record)
    folder = record.get("cwd") if record.get("cwd") and os.path.isdir(record["cwd"]) else home
    from . import launch
    launch.start(sock, name, folder, line)
    return how
