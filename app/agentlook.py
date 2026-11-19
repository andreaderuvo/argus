"""Which model an agent session is on, and with what effort — read off its own transcript.

"An icon of the agent CLI on the title bar, so one sees at a glance what is being used, which model and which
effort" (2026-11-19). Not the flags it was started with: a model changed inside the session (/model) would not
show. Each agent writes every turn to a file — Claude Code `~/.claude/projects/<folder>/<id>.jsonl`, Codex
`~/.codex/sessions/…/rollout-…-<id>.jsonl` — and the last `"model"` and `"effort"` there are what it runs now.
The conversation of each session is the one the register already keeps (resume.py). Gemini keeps no such file:
the model it was started with, if one was given.
"""

from __future__ import annotations

import glob
import os
import re
from pathlib import Path

TAIL = 256 * 1024
READ_MAX = 8 * 1024 * 1024
MODEL = re.compile(r'"model"\s*:\s*"([^"<][^"]*)"')
EFFORT = re.compile(r'"(?:effort|reasoning_effort|model_reasoning_effort)"\s*:\s*"([a-z]+)"')
_files: dict[tuple[str, str], str | None] = {}
_read: dict[str, tuple[float, int, dict]] = {}


def transcript(agent: str, conversation: str, home: Path | None = None) -> str | None:
    """The file an agent writes its conversation to, found by its id (remembered once found)."""
    if not conversation or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", conversation):
        return None
    key = (agent, conversation)
    if _files.get(key) and os.path.exists(_files[key]):
        return _files[key]
    home = home or Path.home()
    pattern = {"claude": f"{home}/.claude/projects/*/{conversation}.jsonl",
               "codex": f"{home}/.codex/sessions/*/*/*/rollout-*-{conversation}.jsonl"}.get(agent)
    found = sorted(glob.glob(pattern)) if pattern else []
    _files[key] = found[-1] if found else None
    return _files[key]


def read(path: str) -> dict:
    """The last model and effort in a transcript; the end of the file only, and again only when it changed."""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    got = _read.get(path)
    if got and got[0] == st.st_mtime and got[1] == st.st_size:
        return got[2]
    # The end first; further back while the model is not in it — Codex says it once at the start of a turn,
    # and one long turn of tool output pushed it out of the last 256 KB.
    models: list[str] = []
    efforts: list[str] = []
    span = TAIL
    try:
        with open(path, "rb") as f:
            while True:
                f.seek(max(0, st.st_size - span))
                text = f.read(span).decode("utf-8", "replace")
                models, efforts = MODEL.findall(text), EFFORT.findall(text)
                if models or span >= st.st_size or span >= READ_MAX:
                    break
                span *= 4
    except OSError:
        return {}
    said = {k: v for k, v in (("model", models[-1] if models else None), ("effort", efforts[-1] if efforts else None)) if v}
    _read[path] = (st.st_mtime, st.st_size, said)
    return said


def from_flags(flags: list[str] | None) -> dict:
    """`--model X`, `-m X`, `-c model=X`, `--effort Y` from the command line it was started with."""
    out: dict[str, str] = {}
    words = list(flags or [])
    for i, w in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else ""
        if w in ("--model", "-m") and nxt:
            out["model"] = nxt
        elif w.startswith("--model="):
            out["model"] = w.split("=", 1)[1]
        elif w in ("--effort", "--reasoning-effort") and nxt:
            out["effort"] = nxt
        elif w == "-c" and nxt.startswith(("model=", "model_reasoning_effort=")):
            k, _, v = nxt.partition("=")
            out["model" if k == "model" else "effort"] = v.strip("\"'")
    return out


def look(record: dict | None) -> dict:
    """{model, effort} for a session's register record — what its transcript says, else its flags."""
    if not record:
        return {}
    said = from_flags(record.get("flags"))
    path = transcript(record.get("agent") or "", record.get("conversation") or "")
    if path:
        said.update(read(path))
    return said


def pretty(model: str) -> str:
    """claude-opus-5-5 → Opus 5.5, claude-sonnet-5 → Sonnet 5, claude-haiku-4-5-20251001 → Haiku 4.5; others as
    they are (gpt-5.6-terra)."""
    m = re.fullmatch(r"claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[1m\])?", model or "")
    if not m:
        return model
    return f"{m.group(1).capitalize()} {m.group(2)}" + (f".{m.group(3)}" if m.group(3) else "")
