"""Wiring the agents up to the bell, so that it is a button rather than an afternoon.

The signal has to come from the agent — nothing watching a terminal can tell "finished"
from "waiting for you" — but *installing* the thing that emits it is mechanical, and
mechanical work belongs to the program. This writes the small script that posts to
/api/bell and adds the two hooks that call it.

Everything here is additive and exactly reversible: a hook already present is left alone
and reported rather than overwritten, and removal only takes back what carries our own
marker. The files belong to the user, not to us.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

# Any command we wrote contains this, which is how removal knows what is ours and what
# the user put there by hand.
MARK = "argus-bell"
# The other thing that can be wired, and its own marker for the same reason.
WHERE_MARK = "argus-where"

CLAUDE_SETTINGS = ".claude/settings.json"
CODEX_CONFIG = ".codex/config.toml"
GEMINI_SETTINGS = ".gemini/settings.json"

# Claude Code fires Stop at the end of a turn and Notification when it wants you. Codex
# calls one program at the end of a turn, and appends its own JSON as a last argument.
CLAUDE_EVENTS = {"Stop": "done", "Notification": "asking"}
# Gemini CLI's own names for the same two moments — AfterAgent once a turn's answer is
# in, Notification when it is waiting on you (a tool permission, today the only kind it
# raises). Same nested shape as Claude's, `{"hooks": [{"type": "command", "command": …}]}`,
# so the same helper functions read and write both.
GEMINI_EVENTS = {"AfterAgent": "done", "Notification": "asking"}


def script_home(home: Path) -> Path:
    """Where the helper goes. An existing one wins, so this stays idempotent for anyone
    who already put it somewhere by hand."""
    for place in ("bin/argus-bell", ".local/bin/argus-bell"):
        if (home / place).exists():
            return home / place
    return home / ".local/bin/argus-bell"


def source_script() -> Path:
    return Path(__file__).resolve().parent.parent / "tools" / "argus-bell"


def where_home(home: Path) -> Path:
    """Where the folder-reporting helper goes, beside the bell one."""
    for place in ("bin/argus-where", ".local/bin/argus-where"):
        if (home / place).exists():
            return home / place
    return home / ".local/bin/argus-where"


def where_source() -> Path:
    return Path(__file__).resolve().parent.parent / "tools" / "argus-where"


def _status_command(home: Path) -> str:
    """Whatever Claude Code is told to run for its status line, or empty."""
    settings = home / CLAUDE_SETTINGS
    if not settings.exists():
        return ""
    try:
        said = json.loads(settings.read_text()).get("statusLine") or {}
    except (OSError, ValueError):
        return ""
    return said.get("command", "") if isinstance(said, dict) else ""


def where_state(home: Path) -> dict:
    """Whether an agent here is set up to say which folder it considers current.

    Only Claude Code can: it has a status line hook, and that hook is handed
    `workspace.current_dir`. Codex has no equivalent — its folder is the one it was started
    in, and the honest thing is to say so rather than to offer a switch that does nothing.
    """
    agents = []
    if (home / CLAUDE_SETTINGS).exists() or (home / ".claude").is_dir():
        command = _status_command(home)
        agents.append({
            "name": "claude",
            "on": WHERE_MARK in command,
            # A status line they wrote themselves is theirs. Reported, never replaced.
            "taken": bool(command) and WHERE_MARK not in command,
        })
    if (home / CODEX_CONFIG).exists() or (home / ".codex").is_dir():
        agents.append({"name": "codex", "on": False, "taken": False, "cannot": True})
    return {"script": str(where_home(home)) if where_home(home).exists() else None, "agents": agents}


def wire_where(home: Path, on: bool) -> dict:
    """Turn the folder reporting on or off, the same way as the bell: additive, marked,
    and taking back only what carries our own name."""
    done: list[str] = []
    script = where_home(home)

    if on:
        source = where_source()
        if not source.exists():
            raise FileNotFoundError("the helper script is missing from this installation")
        script.parent.mkdir(parents=True, exist_ok=True)
        if not script.exists() or script.read_bytes() != source.read_bytes():
            shutil.copyfile(source, script)
            script.chmod(0o755)
            done.append(f"wrote {script}")
    elif script.exists() and WHERE_MARK in script.name:
        script.unlink()
        done.append(f"removed {script}")

    settings = home / CLAUDE_SETTINGS
    if settings.exists() or (home / ".claude").is_dir():
        try:
            data = json.loads(settings.read_text()) if settings.exists() else {}
        except (OSError, ValueError) as e:
            raise ValueError(f"{settings} is not readable JSON, so it is left alone: {e}") from e
        command = _status_command(home)
        if on and WHERE_MARK not in command:
            if command:
                done.append("left the status line alone — you have your own there")
            else:
                data["statusLine"] = {"type": "command", "command": str(script)}
                settings.parent.mkdir(parents=True, exist_ok=True)
                if settings.exists():
                    _keep_a_copy(settings)
                settings.write_text(json.dumps(data, indent=2) + "\n")
                done.append("added the status line hook")
        elif not on and WHERE_MARK in command:
            data.pop("statusLine", None)
            _keep_a_copy(settings)
            settings.write_text(json.dumps(data, indent=2) + "\n")
            done.append("took the status line hook back out")

    return {"changed": done, "state": where_state(home)}


# --------------------------------------------------------------------------- reading

def state(home: Path) -> dict:
    """What is wired now. Reported per agent, and only for agents that exist here: an
    offer to configure something you do not have is just noise."""
    script = script_home(home)
    out = {
        "script": str(script) if script.exists() else None,
        "agents": [],
    }

    claude = _json_hook_state(home, CLAUDE_SETTINGS, ".claude", "Claude Code", CLAUDE_EVENTS)
    if claude:
        out["agents"].append(claude)

    gemini = _json_hook_state(home, GEMINI_SETTINGS, ".gemini", "Gemini CLI", GEMINI_EVENTS)
    if gemini:
        out["agents"].append(gemini)

    codex = home / CODEX_CONFIG
    if codex.exists() or (home / ".codex").is_dir():
        text = codex.read_text() if codex.exists() else ""
        line = _notify_line(text)
        out["agents"].append({
            "name": "Codex",
            "file": str(codex),
            "on": bool(line) and MARK in line,
            "taken": ["notify"] if line and MARK not in line else [],
        })
    return out


def _ours_in(groups: list) -> bool:
    return any(MARK in h.get("command", "") for g in groups if isinstance(g, dict) for h in g.get("hooks", []))


def _json_hook_state(home: Path, settings_rel: str, marker_dir: str, label: str, events: dict) -> dict | None:
    """Claude Code and Gemini CLI read the identical shape — `{"hooks": {Event:
    [{"hooks": [{"type": "command", "command": …}]}]}}` — in a settings file at a
    different path with different event names. One reader for both."""
    settings = home / settings_rel
    if not settings.exists() and not (home / marker_dir).is_dir():
        return None
    try:
        hooks = json.loads(settings.read_text()).get("hooks", {}) if settings.exists() else {}
    except (OSError, ValueError):
        hooks = {}
    return {
        "name": label,
        "file": str(settings),
        "on": all(_ours_in(hooks.get(event, [])) for event in events),
        # An event the user has already claimed is theirs; we say so instead of quietly
        # adding a second command to it.
        "taken": [e for e in events if e in hooks and not _ours_in(hooks[e])],
    }


def _notify_line(text: str) -> str | None:
    """The top-level `notify`, which is the only one that counts: a bare key after a
    `[table]` header belongs to that table, so one written further down does nothing."""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("["):
            return None
        if re.match(r"^notify\s*=", line):
            return line
    return None


# --------------------------------------------------------------------------- writing

def wire(home: Path, on: bool) -> dict:
    """Turn it on or off. Returns what changed, in words fit to show somebody."""
    done: list[str] = []
    script = script_home(home)

    if on:
        source = source_script()
        if not source.exists():
            raise FileNotFoundError("the helper script is missing from this installation")
        script.parent.mkdir(parents=True, exist_ok=True)
        if not script.exists() or script.read_bytes() != source.read_bytes():
            shutil.copyfile(source, script)
            script.chmod(0o755)
            done.append(f"wrote {script}")
    elif script.exists() and MARK in script.name:
        script.unlink()
        done.append(f"removed {script}")

    done += _wire_json_hooks(home, CLAUDE_SETTINGS, ".claude", CLAUDE_EVENTS, on, script)
    done += _wire_json_hooks(home, GEMINI_SETTINGS, ".gemini", GEMINI_EVENTS, on, script)
    done += _wire_codex(home, on, script)
    return {"changed": done, "state": state(home)}


def _wire_json_hooks(home: Path, settings_rel: str, marker_dir: str, events: dict,
                      on: bool, script: Path) -> list[str]:
    """Add or remove the hooks in a Claude-Code-shaped settings file — shared with Gemini
    CLI, which reads the identical shape at its own path under its own event names."""
    settings = home / settings_rel
    if not settings.exists() and not (home / marker_dir).is_dir():
        return []
    try:
        data = json.loads(settings.read_text()) if settings.exists() else {}
    except (OSError, ValueError) as e:
        raise ValueError(f"{settings} is not readable JSON, so it is left alone: {e}") from e

    hooks = data.setdefault("hooks", {})
    said = []
    for event, why in events.items():
        here = hooks.get(event, [])
        if on:
            if here and not _ours_in(here):
                said.append(f"left {event} alone — you have your own hook there")
                continue
            if _ours_in(here):
                continue
            hooks[event] = [{"hooks": [{"type": "command", "command": f"{script} {why}"}]}]
            said.append(f"added the {event} hook")
        elif _ours_in(here):
            kept = [g for g in here if not any(MARK in h.get("command", "") for h in g.get("hooks", []))]
            if kept:
                hooks[event] = kept
            else:
                hooks.pop(event, None)
            said.append(f"took the {event} hook back out")

    if not said:
        return []
    if not hooks:
        data.pop("hooks", None)
    settings.parent.mkdir(parents=True, exist_ok=True)
    _keep_a_copy(settings)
    settings.write_text(json.dumps(data, indent=2) + "\n")
    return said


def _wire_codex(home: Path, on: bool, script: Path) -> list[str]:
    codex = home / CODEX_CONFIG
    if not codex.exists() and not (home / ".codex").is_dir():
        return []
    text = codex.read_text() if codex.exists() else ""
    lines = text.splitlines()
    line = _notify_line(text)

    if on:
        if line and MARK in line:
            return []
        if line:
            return ["left notify alone — you have your own there"]
        # Before the first table header, or TOML reads the key as part of that table and
        # codex never sees it.
        cut = next((i for i, raw in enumerate(lines) if raw.lstrip().startswith("[")), len(lines))
        lines[cut:cut] = [f'notify = ["{script}", "done"]', ""]
        said = ["added notify"]
    else:
        if not line or MARK not in line:
            return []
        lines = [raw for raw in lines if raw.strip() != line]
        said = ["took notify back out"]

    codex.parent.mkdir(parents=True, exist_ok=True)
    if codex.exists():
        _keep_a_copy(codex)
    codex.write_text("\n".join(lines).rstrip("\n") + "\n")
    return said


def _keep_a_copy(path: Path) -> None:
    """One copy before the first change, never overwritten afterwards: the useful backup
    is the file as it was before Argus ever touched it."""
    spare = path.with_suffix(path.suffix + ".before-argus")
    if not spare.exists():
        shutil.copyfile(path, spare)
