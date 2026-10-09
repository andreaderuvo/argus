"""Is this machine ready for a team — said before Start, not discovered in the middle of one.

A team ran on a real machine (2026-10-07) with a Codex that could not report its turn through
the Argus tool: nothing had said, before Start, what would be missing. Each agent a team is about
to use is looked at for what its turns depend on:

- the Argus plugin, installed and current — the tools (`team_task`, `team_done`) and, for Claude
  Code and Codex, the Stop guard that sends an agent back to report;
- in Codex, whether the team tools may run without asking — in a team nobody is there to
  approve a call, and a turn waits for ever on the question;
- whether Codex's hooks have been heard at all: Codex runs them only after a person has
  reviewed them, once, in Codex — until then there is no Stop guard;
- an agent at all: a shell takes no turn.

Nothing here is refused: a team runs without the plugin, its agents report by writing to the
log. Each note says what happens instead, and the fix where there is one to press.
"""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path

from . import pluginstate

TEAM_TOOLS = ("team_task", "team_done")
CODEX_CONFIG = ".codex/config.toml"


def codex_tool_modes(home: Path) -> dict[str, str]:
    """`{tool: approval_mode}` for the team tools in Codex's config ("" where nothing is set)."""
    try:
        import tomllib
        doc = tomllib.loads((home / CODEX_CONFIG).read_text())
    except (OSError, ValueError, ImportError):
        return {t: "" for t in TEAM_TOOLS}
    tools = (((doc.get("plugins") or {}).get("argus@argus") or {}).get("mcp_servers") or {}).get("argus", {}).get("tools", {})
    return {t: str((tools.get(t) or {}).get("approval_mode") or "") for t in TEAM_TOOLS}


def allow_codex_team_tools(home: Path) -> list[str]:
    """Let Codex run `team_task` and `team_done` without asking: `approval_mode = "approve"` for
    each, as Codex's own "always allow" writes it. A copy of the file as it was is kept beside it
    (`config.toml.argus-<time>`). Returns the tools changed."""
    path = home / CODEX_CONFIG
    text = path.read_text() if path.exists() else ""
    changed = []
    for tool in TEAM_TOOLS:
        head = f'[plugins."argus@argus".mcp_servers.argus.tools.{tool}]'
        if head in text:
            section = re.compile(re.escape(head) + r"\n(?:(?!\[).*\n?)*")
            block = section.search(text).group(0)
            if re.search(r'^approval_mode\s*=\s*"(approve|auto)"', block, re.M):
                continue
            new = re.sub(r"^approval_mode\s*=.*$", 'approval_mode = "approve"', block, flags=re.M)
            if new == block:
                new = block.rstrip("\n") + '\napproval_mode = "approve"\n'
            text = text.replace(block, new, 1)
        else:
            text = text.rstrip("\n") + ("\n\n" if text.strip() else "") + f'{head}\napproval_mode = "approve"\n'
        changed.append(tool)
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            shutil.copy2(path, path.with_name(f"config.toml.argus-{int(time.time())}"))
        path.write_text(text)
    return changed


def _note(level: str, say: str, fix: str | None = None, **values) -> dict:
    """A note as words the page can translate: `say` is the English sentence with `{holes}`,
    `values` fill them, and `text` is the two put together — what older pages show as it is.
    The `say` sentences are catalogue keys (tests/test_catalogues.py checks)."""
    note = {"level": level, "text": say.format(**values), "say": say, "values": {k: str(v) for k, v in values.items()}}
    if fix:
        note["fix"] = fix
    return note


def check(home: Path, launchers: list[dict], codex_heard: bool) -> list[dict]:
    """For each launcher a team is about to use: `{name, agent, notes: [{level, text, fix?}]}`."""
    plugin = {a["agent"]: a for a in pluginstate.state(home, {})["agents"]}
    offered = pluginstate.repo_version()
    modes = None
    out = []
    for launcher in launchers:
        agent = launcher.get("agent")
        notes = []
        if not agent:
            notes.append(_note("warn", "not an agent: a shell takes no turn and reports nothing — the team will wait on it"))
        elif agent in ("claude", "codex"):
            got = plugin.get(agent) or {}
            if not got.get("installed"):
                notes.append(_note("warn", "no Argus plugin: no team tools and no Stop guard — it will report by writing to the "
                                           "team's log, which works but is checked by nobody until the next round",
                                   fix=f"plugin:{agent}"))
            elif got.get("outdated"):
                notes.append(_note("warn", "the Argus plugin is {installed}, {offered} is out — the team tools may be missing",
                                   fix=f"plugin:{agent}", installed=got["installed"], offered=offered))
            if agent == "codex" and got.get("installed"):
                modes = modes or codex_tool_modes(home)
                asking = [t for t, m in modes.items() if m not in ("approve", "auto")]
                if asking:
                    notes.append(_note("warn", "Codex asks before {tools} — in a team nobody is there to say yes, "
                                               "and the turn waits", fix="codex-team-tools", tools=", ".join(asking)))
                if not codex_heard:
                    notes.append(_note("info", "Codex's hooks have not been heard yet: they run only after you review them "
                                               "once in Codex — until then there is no Stop guard (open Codex, accept the hooks)"))
        elif agent == "gemini":
            notes.append(_note("info", "Gemini gets the team tools from its extension but no Stop guard: a turn ended "
                                       "without a report is noticed by the reminder, after two minutes"))
        out.append({"name": launcher.get("name"), "agent": agent, "notes": notes})
    return out
