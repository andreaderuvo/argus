"""The options worth knowing when an agent is started, said in words.

Nobody remembers `--dangerously-skip-permissions`, and nobody should have to: the box that starts
an agent offers what matters — how much it may do without asking, which model, how hard to think,
whether to pick up the last conversation — as switches with a sentence each, and shows the command
line they make.

Two rules keep it honest and safe:

- **Only what the installed version accepts.** Flags come and go between versions (this machine's
  Codex has no `--full-auto` any more), so every option is checked against the agent's own
  `--help`, asked once through a login shell and remembered per version. An option the help does
  not mention is not offered, rather than offered and refused.
- **No command line in a request.** The browser sends option *names* and chosen values; the flags
  are built here, from this table, and a free-text value (a model name) must look like one. The
  rule the launch endpoint was built on — only a launcher named in the config can run — stands.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time

HELP_TIMEOUT = 20
VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}")

# kind: "choice" (one of several, the first is "leave it to the agent" and adds nothing),
# "toggle", or "text". A choice's `needs` are words its help must contain for it to be offered.
CATALOG: dict[str, list[dict]] = {
    "claude": [
        {"id": "permissions", "kind": "choice", "label": "What it may do without asking", "choices": [
            {"value": "ask", "label": "ask before acting", "flags": []},
            {"value": "edits", "label": "edit files freely, ask before running commands",
             "flags": ["--permission-mode", "acceptEdits"], "needs": ["--permission-mode", "acceptEdits"]},
            {"value": "plan", "label": "plan only: read and propose, change nothing",
             "flags": ["--permission-mode", "plan"], "needs": ["--permission-mode", "plan"]},
            {"value": "auto", "label": "decide for itself what is safe to do",
             "flags": ["--permission-mode", "auto"], "needs": ["--permission-mode", '"auto"']},
            {"value": "skip", "label": "everything, no questions (--dangerously-skip-permissions)",
             "flags": ["--dangerously-skip-permissions"], "needs": ["--dangerously-skip-permissions"],
             "danger": True},
        ]},
        {"id": "model", "kind": "choice", "label": "Model", "choices": [
            {"value": "", "label": "its default", "flags": []},
            {"value": "opus", "label": "Opus", "flags": ["--model", "opus"], "needs": ["--model"]},
            {"value": "sonnet", "label": "Sonnet", "flags": ["--model", "sonnet"], "needs": ["--model"]},
            {"value": "haiku", "label": "Haiku", "flags": ["--model", "haiku"], "needs": ["--model"]},
            {"value": "fable", "label": "Fable", "flags": ["--model", "fable"], "needs": ["--model", "fable"]},
        ]},
        {"id": "effort", "kind": "choice", "label": "How hard it thinks", "choices": [
            {"value": "", "label": "its default", "flags": []},
            *({"value": v, "label": v, "flags": ["--effort", v], "needs": ["--effort"]}
              for v in ("low", "medium", "high", "xhigh", "max")),
        ]},
        {"id": "continue", "kind": "toggle", "label": "Continue the last conversation in this folder",
         "flags": ["--continue"], "needs": ["--continue"]},
    ],
    "codex": [
        {"id": "permissions", "kind": "choice", "label": "What it may do without asking", "choices": [
            {"value": "ask", "label": "ask when it wants to", "flags": []},
            {"value": "workspace", "label": "write in this folder, ask for anything beyond",
             "flags": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
             "needs": ["--sandbox", "workspace-write", "--ask-for-approval"]},
            {"value": "review", "label": "have its approvals reviewed automatically",
             "flags": ["--approve-for-me"], "needs": ["--approve-for-me"]},
            {"value": "auto", "label": "work without asking, inside the sandbox",
             "flags": ["--full-auto"], "needs": ["--full-auto"]},
            {"value": "yolo", "label": "everything, no approvals and no sandbox "
                                       "(--dangerously-bypass-approvals-and-sandbox)",
             "flags": ["--dangerously-bypass-approvals-and-sandbox"],
             "needs": ["--dangerously-bypass-approvals-and-sandbox"], "danger": True},
        ]},
        {"id": "model", "kind": "text", "label": "Model", "placeholder": "its default",
         "flag": "--model", "needs": ["--model"]},
        {"id": "search", "kind": "toggle", "label": "Let it search the web",
         "flags": ["--search"], "needs": ["--search"]},
    ],
    "gemini": [
        {"id": "permissions", "kind": "choice", "label": "What it may do without asking", "choices": [
            {"value": "ask", "label": "ask before acting", "flags": []},
            {"value": "yolo", "label": "everything, no questions (--yolo)", "flags": ["--yolo"],
             "needs": ["--yolo"], "danger": True},
        ]},
        {"id": "model", "kind": "text", "label": "Model", "placeholder": "its default",
         "flag": "--model", "needs": ["--model"]},
    ],
}

_helps: dict[str, tuple[float, str]] = {}      # program -> (when asked, its --help)
_lock = threading.Lock()


def agent_of(command: str) -> str | None:
    """Which agent a launcher line starts, if it is one this table knows: the program of its
    last segment, so `conda activate x && claude` is claude."""
    segments = [s for s in re.split(r"&&|\|\||;|\|", command or "") if s.strip()]
    if not segments:
        return None
    words = segments[-1].split()
    while words and (words[0] in ("sudo", "env", "exec", "nohup", "time", "nice", "command")
                     or words[0].startswith("-") or "=" in words[0]):
        words.pop(0)
    program = os.path.basename(words[0]) if words else ""
    return program if program in CATALOG else None


def program_of(command: str) -> str | None:
    segments = [s for s in re.split(r"&&|\|\||;|\|", command or "") if s.strip()]
    words = segments[-1].split() if segments else []
    while words and (words[0] in ("sudo", "env", "exec", "nohup", "time", "nice", "command")
                     or words[0].startswith("-") or "=" in words[0]):
        words.pop(0)
    return words[0] if words else None


def _ask_help(program: str) -> str:
    from .launch import login_shell, shell_quote
    try:
        done = subprocess.run([login_shell(), "-l", "-c", f"{shell_quote(program)} --help </dev/null 2>&1 | head -c 200000"],
                              capture_output=True, text=True, timeout=HELP_TIMEOUT)
        return done.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def help_of(program: str, version: str = "") -> str:
    """The program's `--help`, remembered until its version changes."""
    key = f"{program}\t{version}"
    with _lock:
        got = _helps.get(key)
    if got is not None:
        return got[1]
    text = _ask_help(program)
    with _lock:
        _helps[key] = (time.monotonic(), text)
    return text


def mentions(help_text: str, word: str) -> bool:
    return re.search(r"(?<![\w-])" + re.escape(word) + r"(?![\w-])", help_text) is not None


def options_for(command: str, help_text: str) -> list[dict]:
    """What the browser is offered for this launcher: only what the help mentions."""
    agent = agent_of(command)
    if not agent or not help_text:
        return []
    out = []
    for opt in CATALOG[agent]:
        if opt["kind"] == "choice":
            choices = [{"value": c["value"], "label": c["label"], "flags": c["flags"], "danger": bool(c.get("danger"))}
                       for c in opt["choices"] if all(mentions(help_text, w) for w in c.get("needs", []))]
            if len(choices) > 1:
                out.append({"id": opt["id"], "kind": "choice", "label": opt["label"], "choices": choices})
        elif all(mentions(help_text, w) for w in opt.get("needs", [])):
            one = {k: opt[k] for k in ("id", "kind", "label") }
            if opt["kind"] == "toggle":
                one["flags"] = opt["flags"]
            else:
                one["flag"] = opt["flag"]
                one["placeholder"] = opt.get("placeholder", "")
            out.append(one)
    return out


def dangerous(command: str, help_text: str, chosen: dict) -> bool:
    """Whether what was chosen includes a choice marked `danger` — everything, no questions."""
    offered = {o["id"]: o for o in options_for(command, help_text)}
    for key, value in (chosen or {}).items():
        opt = offered.get(key) or {}
        for c in opt.get("choices", []):
            if c["value"] == value and c.get("danger"):
                return True
    return False


def flags_for(command: str, help_text: str, chosen: dict) -> list[str]:
    """The flags for what was chosen. ValueError for anything not on offer."""
    if not isinstance(chosen, dict):
        raise ValueError("options must be an object")
    offered = {o["id"]: o for o in options_for(command, help_text)}
    flags: list[str] = []
    for key, value in chosen.items():
        opt = offered.get(key)
        if opt is None:
            raise ValueError(f"{key} is not an option this agent has here")
        if opt["kind"] == "choice":
            pick = next((c for c in opt["choices"] if c["value"] == value), None)
            if pick is None:
                raise ValueError(f"{value!r} is not one of the choices for {key}")
            flags += pick["flags"]
        elif opt["kind"] == "toggle":
            if value is True:
                flags += opt["flags"]
            elif value not in (False, None):
                raise ValueError(f"{key} is on or off")
        else:
            value = str(value or "").strip()
            if value:
                if not VALUE.fullmatch(value):
                    raise ValueError(f"{value!r} does not look like a value for {key}")
                flags += [opt["flag"], value]
    return flags
