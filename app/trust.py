"""Trusting a team's folder in the agent before starting it there — what you would answer "yes" to.

Claude Code and Codex both ask, the first time they start in a folder, whether to trust it. A team
starting three agents in a new folder met three questions, and the first prompt Argus typed landed
in the question instead of reaching the agent (reported 2026-10-07: "the agents don't start, they
ask questions"). Starting a team in a folder is already the decision; this records it where each
agent keeps it, exactly as answering the question would:

- Codex: `[projects."<folder>"] trust_level = "trusted"` in `~/.codex/config.toml` (appended, the
  file kept otherwise as it is, a copy kept before the first change);
- Claude Code: `projects["<folder>"].hasTrustDialogAccepted = true` in `~/.claude.json`, written
  atomically. A running Claude rewrites that file from its own copy now and then and may drop the
  key later; by then the new session has read it, which is all this is for.

Both are best effort: if a file cannot be read, the agent asks, as before — and since the first
prompt now travels on the agent's command line rather than being typed, answering it is enough.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def trust(folder: str, program: str, home: Path | None = None) -> bool:
    """Record `folder` as trusted for `program` ('claude' or 'codex'). Returns whether it wrote."""
    home = home or Path.home()
    folder = str(Path(folder).resolve())
    try:
        if program == "codex":
            return _codex(home / ".codex" / "config.toml", folder)
        if program == "claude":
            return _claude(home / ".claude.json", folder)
    except (OSError, ValueError):
        return False
    return False


def _codex(conf: Path, folder: str) -> bool:
    if not conf.parent.is_dir():
        return False
    text = conf.read_text() if conf.exists() else ""
    header = f'[projects."{folder}"]'
    if header in text:
        return False                           # trusted or not, that is the person's own answer
    from .wiring import _keep_a_copy
    if conf.exists():
        _keep_a_copy(conf)
    with open(conf, "a") as f:
        f.write(("" if text.endswith("\n") or not text else "\n") + f'\n{header}\ntrust_level = "trusted"\n')
    return True


def _claude(state: Path, folder: str) -> bool:
    if not state.exists():
        return False
    doc = json.loads(state.read_text())
    projects = doc.setdefault("projects", {})
    entry = projects.setdefault(folder, {})
    if entry.get("hasTrustDialogAccepted"):
        return False
    entry["hasTrustDialogAccepted"] = True
    tmp = state.with_name(state.name + ".argus-tmp")
    tmp.write_text(json.dumps(doc, indent=2))
    os.chmod(tmp, state.stat().st_mode & 0o777)
    tmp.replace(state)
    return True


FIRST_PROMPT = {"claude": "{cmd} {prompt}", "codex": "{cmd} {prompt}", "gemini": "{cmd} -i {prompt}"}


def with_first_prompt(command: str, program: str, prompt: str) -> str | None:
    """The launch line with the first instruction on it — `claude "…"`, `codex "…"`, `gemini -i "…"`
    — so the agent runs it once it is ready, whatever it asks first. None for anything else, which
    is then started and typed into as before."""
    shape = FIRST_PROMPT.get(program)
    if not shape:
        return None
    from .launch import shell_quote
    return shape.format(cmd=command.rstrip(), prompt=shell_quote(prompt))

