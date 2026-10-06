"""The Argus plugin in each agent on this machine: installed or not, which version, and the commands
that install or update it — so Settings can offer it with a press instead of a list of commands.

What it reads is the agents' own records: Claude Code's `~/.claude/plugins/installed_plugins.json`,
Codex's `[plugins."argus@argus"]` in `~/.codex/config.toml` and the version directories of its
plugin cache. The version to compare with is the one in this checkout's `plugin/`, which is the
one this server is running beside.

Installing uses *this checkout* as the marketplace when the agent has none called `argus` yet, so
the plugin always matches the server that offers it — a pull and a press, and they move together,
with nothing fetched from GitHub. A marketplace already added (from GitHub, say) is kept and
updated where it is.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_ID = "argus@argus"


def repo_version() -> str:
    try:
        return str(json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())["version"])
    except (OSError, ValueError, KeyError):
        return ""


def _key(v: str) -> tuple:
    out = []
    for part in (v or "").split("."):
        out.append(int(part) if part.isdigit() else 0)
    return tuple(out)


def older(installed: str, offered: str) -> bool:
    return bool(installed and offered) and _key(installed) < _key(offered)


def claude_state(home: Path) -> dict:
    record = home / ".claude" / "plugins" / "installed_plugins.json"
    version, marketplace = "", False
    try:
        entries = json.loads(record.read_text()).get("plugins", {}).get(PLUGIN_ID) or []
        version = max((str(e.get("version") or "") for e in entries), key=_key, default="")
    except (OSError, ValueError, AttributeError):
        pass
    try:
        marketplace = "argus" in json.loads((home / ".claude" / "plugins" / "known_marketplaces.json").read_text())
    except (OSError, ValueError):
        pass
    return {"version": version, "marketplace": marketplace}


def codex_state(home: Path) -> dict:
    import tomllib
    version, marketplace, enabled = "", False, False
    try:
        conf = tomllib.loads((home / ".codex" / "config.toml").read_text())
        marketplace = "argus" in (conf.get("marketplaces") or {})
        enabled = bool((conf.get("plugins") or {}).get(PLUGIN_ID, {}).get("enabled"))
    except (OSError, ValueError):
        pass
    cache = home / ".codex" / "plugins" / "cache" / "argus" / "argus"
    if enabled and cache.is_dir():
        version = max((p.name for p in cache.iterdir() if p.is_dir()), key=_key, default="")
    return {"version": version, "marketplace": marketplace}


def state(home: Path, present: dict[str, bool]) -> dict:
    """`{version, agents: [{agent, name, present, installed, outdated}]}` for Claude Code and Codex."""
    offered = repo_version()
    agents = []
    for agent, name, read in (("claude", "Claude Code", claude_state), ("codex", "Codex", codex_state)):
        got = read(home)
        agents.append({"agent": agent, "name": name, "present": bool(present.get(agent)),
                       "installed": got["version"], "outdated": older(got["version"], offered),
                       "marketplace": got["marketplace"]})
    return {"version": offered, "agents": agents}


def commands(agent: str, home: Path, action: str) -> list[list[str]]:
    """The command lines that install or update the plugin in one agent, in order."""
    got = (claude_state if agent == "claude" else codex_state)(home)
    if agent == "claude":
        out = [] if got["marketplace"] else [["claude", "plugin", "marketplace", "add", str(ROOT)]]
        if got["marketplace"]:
            out.append(["claude", "plugin", "marketplace", "update", "argus"])
        out.append(["claude", "plugin", "update" if action == "update" and got["version"] else "install", PLUGIN_ID])
        return out
    if agent == "codex":
        out = [] if got["marketplace"] else [["codex", "plugin", "marketplace", "add", str(ROOT)]]
        # From a local marketplace Codex takes the new version by adding the plugin again
        # (measured on 0.160); a Git one is refreshed first.
        if got["marketplace"]:
            out.append(["codex", "plugin", "marketplace", "upgrade", "argus"])
        out.append(["codex", "plugin", "add", PLUGIN_ID])
        return out
    raise ValueError(f"no plugin for {agent}")


def run(agent: str, home: Path, action: str, timeout: float = 120) -> dict:
    """Run them in a login shell — the agents are installed where an interactive PATH finds them,
    which a systemd service's PATH does not. Returns `{ok, said}` with what the agent printed."""
    import shlex
    said = []
    for argv in commands(agent, home, action):
        line = " ".join(shlex.quote(a) for a in argv)
        try:
            done = subprocess.run(["bash", "-lc", line + " </dev/null"], capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"ok": False, "said": said + [f"{line}: no answer in {timeout:.0f}s"]}
        text = "\n".join(x for x in (done.stdout + done.stderr).splitlines()
                         if x.strip() and not x.startswith("WARNING: proceeding")).strip()
        said.append(f"$ {line}\n{text}" if text else f"$ {line}")
        # "upgrade" of a marketplace that is a local folder is not an error worth stopping on.
        if done.returncode != 0 and not (argv[:4] == ["codex", "plugin", "marketplace", "upgrade"]):
            return {"ok": False, "said": said}
    return {"ok": True, "said": said}
