"""Whether an agent is out of date, and bringing it up to date with a press.

"When I make a new session it does not tell me Codex, Claude or Gemini are old — and a button that updates
them would not hurt" (2026-11-19). The newest version of each is the npm registry's (all three are published
there, whatever installed them here); the one installed is its own `--version` (launch.versions). The update
is the one that matches how it was installed: `claude update` for Claude Code (native or npm), npm or Homebrew
for Codex and Gemini — read off where the program really lives.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request

from . import launch

AGENTS = {
    "claude": {"name": "Claude Code", "npm": "@anthropic-ai/claude-code", "brew": "claude-code"},
    "codex": {"name": "Codex", "npm": "@openai/codex", "brew": "codex"},
    "gemini": {"name": "Gemini", "npm": "@google/gemini-cli", "brew": "gemini-cli"},
}
LATEST_REMEMBER_FOR = 3600.0
UPDATE_TIMEOUT = 600
_latest: dict[str, tuple[float, str | None]] = {}


def version_of(said: str) -> str | None:
    """"2.1.235 (Claude Code)", "codex-cli 0.147.0", "0.12.0" → the version in it."""
    m = re.search(r"(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)", said or "")
    return m.group(1) if m else None


def newer(a: str | None, b: str | None) -> bool:
    """Whether `b` is newer than `a` (numbers compared as numbers; a pre-release is never "newer")."""
    if not a or not b or "-" in b:
        return False
    num = lambda v: [int(x) for x in re.findall(r"\d+", v.split("-")[0])[:3]]  # noqa: E731
    return num(b) > num(a)


def latest(agent: str) -> str | None:
    """The newest release on npm, remembered for an hour; None when the registry cannot be reached."""
    given = os.environ.get("ARGUS_AGENT_LATEST")
    if given is not None:                          # the tests' answer: no network from them
        try:
            return json.loads(given).get(agent)
        except ValueError:
            return None
    now = time.monotonic()
    got = _latest.get(agent)
    if got and now - got[0] < LATEST_REMEMBER_FOR:
        return got[1]
    version = None
    try:
        with urllib.request.urlopen(f"https://registry.npmjs.org/{AGENTS[agent]['npm']}/latest", timeout=6) as r:
            version = json.loads(r.read()).get("version")
    except Exception:
        version = got[1] if got else None          # offline: the last answer, if there was one
    _latest[agent] = (now, version)
    return version


_where: dict[str, tuple[float, str]] = {}


def where(agent: str) -> str:
    """The real file behind the command, through symlinks, from a login shell (its PATH is the person's).
    Remembered for ten minutes: a login shell each time made the New session box wait."""
    got = _where.get(agent)
    if got and time.monotonic() - got[0] < 600:
        return got[1]
    _where[agent] = (time.monotonic(), _where_now(agent))
    return _where[agent][1]


def _where_now(agent: str) -> str:
    try:
        done = subprocess.run([launch.login_shell(), "-l", "-c",
                               f'p=$(command -v {agent}) && (readlink -f "$p" 2>/dev/null || realpath "$p" 2>/dev/null || echo "$p")'],
                              capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        return done.stdout.strip().splitlines()[-1] if done.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def how(agent: str, path: str) -> tuple[str, str]:
    """(how it was installed, the command that updates it). ("", "") when it cannot be told."""
    meta = AGENTS[agent]
    if agent == "claude":
        return "claude", "claude update"           # knows its own install, native or npm
    if "/node_modules/" in path:
        return "npm", f"npm install -g {meta['npm']}@latest"
    if "/Cellar/" in path or "/homebrew/" in path or "/linuxbrew/" in path:
        return "brew", f"brew upgrade {meta['brew']}"
    return "", ""


def state() -> list[dict]:
    """Every agent here: installed, newest, out of date, and how it would be updated."""
    present = launch.probe(list(AGENTS))
    found = [a for a in AGENTS if present.get(a)]
    versions = launch.versions(found) if found else {}
    out = []
    for agent in found:
        installed = version_of(versions.get(agent, ""))
        newest = latest(agent)
        kind, command = how(agent, where(agent))
        out.append({"agent": agent, "name": AGENTS[agent]["name"], "installed": installed, "latest": newest,
                    "outdated": newer(installed, newest), "how": kind, "command": command})
    return out


def update(agent: str) -> dict:
    """Run the update for `agent`, in a login shell; then its version is asked again."""
    if agent not in AGENTS:
        raise ValueError(f"no agent called {agent}")
    kind, command = how(agent, where(agent))
    if not command:
        raise ValueError(f"how {AGENTS[agent]['name']} was installed here cannot be told — update it the way you installed it")
    try:
        done = subprocess.run([launch.login_shell(), "-l", "-c", f"{command} </dev/null 2>&1"],
                              capture_output=True, text=True, timeout=UPDATE_TIMEOUT, stdin=subprocess.DEVNULL)
        output, code = done.stdout, done.returncode
    except subprocess.TimeoutExpired:
        output, code = f"no answer after {UPDATE_TIMEOUT // 60} minutes", None
    launch._versions.pop(agent, None)              # the version it says now, not the one remembered
    _where.pop(agent, None)
    installed = version_of(launch.versions([agent]).get(agent, ""))
    return {"agent": agent, "command": command, "code": code, "ok": code == 0, "installed": installed,
            "output": output[-2000:]}


# ------------------------------------------------------------------ sessions still on the old version

def boot_time() -> float:
    """When this machine started (epoch seconds): a process's start is counted from it in /proc."""
    try:
        for line in open("/proc/stat"):
            if line.startswith("btime "):
                return float(line.split()[1])
    except OSError:
        pass
    return 0.0


def installed_at(agent: str) -> float | None:
    """When the program installed now was written: an update rewrites it (npm's script, Claude's binary)."""
    path = where(agent)
    try:
        return os.stat(path).st_mtime if path else None
    except OSError:
        return None


def stale(panes: dict[str, list[int]], table: dict | None) -> dict[str, str]:
    """{session: agent} for each session whose agent started before the version installed now was: it still
    runs the old one, until it is restarted ("I updated the CLI but this session still has the old one",
    2026-11-19). From the processes alone — the pane's tree, each process's start — nothing asked of the agent."""
    if not table:
        return {}
    from .agentstate import agent_in
    names = frozenset(AGENTS)
    children: dict[int, list[int]] = {}
    for pid, proc in table.items():
        children.setdefault(proc.ppid, []).append(pid)
    boot = boot_time()
    when: dict[str, float | None] = {}
    out: dict[str, str] = {}
    for session, roots in panes.items():
        stack, seen = list(roots), set()
        while stack:
            pid = stack.pop()
            if pid in seen or pid not in table:
                continue
            seen.add(pid)
            agent = agent_in(list(table[pid].argv), names)
            if agent:
                if agent not in when:
                    when[agent] = installed_at(agent)
                started = boot + table[pid].start
                if when[agent] and boot and started < when[agent] - 5:
                    out[session] = agent
                break
            stack.extend(children.get(pid, ()))
    return out
