#!/usr/bin/env python3
"""Argus as an MCP server: what an agent can do about the other agents on this machine, as tools.

    claude mcp add argus -- argus-mcp              # Claude Code
    codex mcp add argus -- argus-mcp               # Codex
    gemini mcp add argus argus-mcp                 # Gemini CLI

Nothing here is new power. Every tool is one route an agent's key already opens, called through
`argus_client` — the same reading of the config, the same preference for the narrow key, the same
brakes. What MCP changes is who has to know: with `argus-say` the prompt had to say "run this
command"; with this the agent sees `ask`, `ring`, `who` among its own tools and reaches for them.

Optional, like everything an agent is given here. Argus watches the panes whether or not this is
installed, and the ordinary work needs nothing inside the agent.

## The protocol, and only as much of it as tools need

JSON-RPC 2.0, one message per line on stdin and stdout (the stdio transport). `initialize`,
`tools/list`, `tools/call` and `ping`; notifications are read and not answered. Standard library
only, like the client beside it: an MCP SDK would be a dependency for forty lines of framing.
Anything written to stdout that is not a message breaks the client, so nothing else is.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

try:                                              # installed: argus_tools.argus_mcp
    from .argus_client import Argus, ArgusError
except ImportError:                               # run from the folder: tools/argus_mcp.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from argus_client import Argus, ArgusError   # noqa: E402

VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "Argus watches the tmux sessions on this machine and the person who owns them, often from a "
    "phone. Use `ask` when a decision is theirs rather than guessing, and wait for the answer; "
    "`ring` when you finish or fail, so they need not watch your pane; `who` before handing work "
    "to another session with `relay`; `start_agent` to start a second agent, in its own git "
    "worktree when it will change code; `open_desk` and `start_agent` with `desk` when asked to "
    "lay agents out on a desk of their own."
)

TOOLS = [
    {"name": "who",
     "description": "Who else is on this machine: every tmux session, the agent in it, its folder, whether it is "
                    "working or waiting, and which sessions are waiting for the person. Call it before relaying "
                    "work to another session or starting a new one.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "ring",
     "description": "Call the person: a notification in Argus on every device they have it open on. 'done' or "
                    "'failed' when you finish, 'asking' when you are stuck and need them to look.",
     "inputSchema": {"type": "object", "properties": {
         "text": {"type": "string", "description": "What happened, in one line"},
         "why": {"type": "string", "enum": ["done", "failed", "asking"], "default": "done"}},
         "required": ["text"]}},
    {"name": "ask",
     "description": "Ask the person a question and wait for the answer. With options, answering is one tap on "
                    "their phone. Use it when a decision is theirs — deleting data, choosing between approaches, "
                    "spending money — instead of guessing. Returns their answer, or says nobody answered in time.",
     "inputSchema": {"type": "object", "properties": {
         "question": {"type": "string"},
         "options": {"type": "array", "items": {"type": "string"}, "description": "Choices to tap, e.g. [\"drop\", \"keep\"]"},
         "wait_minutes": {"type": "number", "default": 10, "minimum": 1, "maximum": 60}},
         "required": ["question"]}},
    {"name": "relay",
     "description": "Type text into another tmux session — another agent, usually. Without press_enter it is left "
                    "typed for whoever is there to send.",
     "inputSchema": {"type": "object", "properties": {
         "to": {"type": "string", "description": "The session's name, from who"},
         "text": {"type": "string"},
         "press_enter": {"type": "boolean", "default": False}},
         "required": ["to", "text"]}},
    {"name": "open_desk",
     "description": "Open a desk in Argus — a named workspace of windows the person sees in the browser — making it "
                    "empty if there is none by that name, and switch the open pages to it. Use it when asked for "
                    "\"a new desk called …\"; then start agents into it with start_agent's desk.",
     "inputSchema": {"type": "object", "properties": {
         "name": {"type": "string"},
         "folder": {"type": "string", "description": "Where its file browsers and new sessions start"},
         "show": {"type": "boolean", "default": True}},
         "required": ["name"]}},
    {"name": "launchers",
     "description": "What this machine can start (the launcher list in Argus's config), whether each is installed, "
                    "its version, and the options it takes by name — permissions, model, effort.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "start_agent",
     "description": "Start something from the launcher list in a new tmux session, with its first instruction. "
                    "Give worktree_branch when it will change code in a git repository: it gets its own checkout "
                    "on that branch, so the two of you do not edit one tree.",
     "inputSchema": {"type": "object", "properties": {
         "launcher": {"type": "string", "description": "A name from launchers, e.g. \"Claude Code\""},
         "name": {"type": "string", "description": "The new session's name"},
         "folder": {"type": "string", "description": "Where it starts; defaults to your current folder"},
         "prompt": {"type": "string", "description": "Its first instruction"},
         "press_enter": {"type": "boolean", "default": True},
         "worktree_branch": {"type": "string"},
         "options": {"type": "object", "description": "By name, as launchers lists them: {\"permissions\": \"edits\", \"model\": \"sonnet\"}",
                     "additionalProperties": {"type": ["string", "boolean"]}},
         "show_on_desk": {"type": "boolean", "default": True, "description": "Also open its window on the person's desk"},
         "desk": {"type": "string", "description": "Put its window in the desk of this name (made if missing) instead of the one on screen"}},
         "required": ["launcher", "name"]}},
    {"name": "teams",
     "description": "The teams of agents Argus is directing on this machine: goal, round, status, whose turn it is "
                    "and each step's outcome. Read only.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "worktree",
     "description": "A second checkout of a git repository on its own branch, inside the folders Argus serves. "
                    "Refuses a path that already exists.",
     "inputSchema": {"type": "object", "properties": {
         "repo": {"type": "string"}, "branch": {"type": "string"}},
         "required": ["repo", "branch"]}},
    {"name": "prompts",
     "description": "The person's prompt library in Argus: saved prompts by name, with their text.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def own_session() -> str:
    """The tmux session this agent runs in, so a ring or a question says who it came from.

    `display-message` names it from the pane, on the server in $TMUX — the one this agent is on.
    (Not `capture-pane`: see CLAUDE.md.) Nothing outside tmux, and then the bell is unsigned.
    """
    if os.environ.get("ARGUS_SESSION"):
        return os.environ["ARGUS_SESSION"]
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        return ""
    try:
        done = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#S"],
                              capture_output=True, text=True, timeout=3)
        return done.stdout.strip() if done.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


# ------------------------------------------------------------------- the tools

def _who(a: Argus, _args: dict) -> str:
    said = a.who()
    me = own_session()
    lines = [f"machine {said.get('machine', '?')}"]
    for s in said.get("sessions", []):
        state = s.get("state") or ("no agent" if not s.get("agent") else "")
        marks = [x for x in (state, "WAITING FOR THE PERSON" if s.get("wants_you") else "",
                             "you" if s["name"] == me else "") if x]
        who = " · ".join(x for x in (s.get("agent"), s.get("model")) if x) or "-"
        lines.append(f"{s['name']}: {who} in {s.get('folder') or '?'}" + (f" [{', '.join(marks)}]" if marks else ""))
    if said.get("launchers"):
        lines.append("can start: " + ", ".join(said["launchers"]))
    return "\n".join(lines)


def _ring(a: Argus, args: dict) -> str:
    a.ring(args.get("text", ""), args.get("why") or "done", own_session())
    return "rung"


def _ask(a: Argus, args: dict) -> str:
    minutes = max(1.0, min(60.0, float(args.get("wait_minutes") or 10)))
    answer = a.ask(args["question"], args.get("options") or None, wait=min(minutes * 60, 300),
                   session=own_session(), patience=minutes * 60)
    if answer is None:
        return f"Nobody answered within {minutes:g} minutes. Decide for yourself if it is safe to, or stop and say why."
    return f"The person answered: {answer}"


def _relay(a: Argus, args: dict) -> str:
    said = a.relay(args["to"], args["text"], bool(args.get("press_enter")))
    return f"{said.get('characters', len(args['text']))} characters to {said.get('to', args['to'])}" + (
        ", and sent" if said.get("sent") else ", typed and waiting for a return")


def _launchers(a: Argus, _args: dict) -> str:
    out = []
    for one in a.launchers(versions=True):
        head = f"{one['name']}: {one.get('command', '')}"
        if one.get("available") is False:
            head += "  (not installed)"
        elif one.get("version"):
            head += f"  ({one['version']})"
        out.append(head)
        for opt in one.get("options") or []:
            if opt.get("kind") == "choice":
                values = [c["value"] for c in opt.get("choices", []) if c["value"] and not c.get("danger")]
                out.append(f"  options.{opt['id']}: {' | '.join(values)}  — {opt.get('label', '')}")
            else:
                out.append(f"  options.{opt['id']}: true  — {opt.get('label', '')}")
    return "\n".join(out) or "no launchers configured"


def _start(a: Argus, args: dict) -> str:
    said = a.launch(args["launcher"], args["name"], args.get("folder") or os.getcwd(), args.get("prompt", ""),
                    run=bool(args.get("press_enter", True)), worktree=args.get("worktree_branch") or None,
                    desk=(args.get("desk") or bool(args.get("show_on_desk", True))), options=args.get("options") or None)
    return f"{said.get('name', args['name'])} started" + (
        ", and the prompt was sent" if said.get("sent")
        else ", the prompt is typed in and waiting for a return" if said.get("seeded") else "")


def _open_desk(a: Argus, args: dict) -> str:
    said = a.desk(args["name"], args.get("folder") or None, bool(args.get("show", True)))
    return (f"made the desk {said['name']}" if said.get("made") else f"the desk {said['name']} was already there") + (
        ", and switched to it" if args.get("show", True) else "")


def _teams(a: Argus, _args: dict) -> str:
    teams = a.teams()
    if not teams:
        return "no teams"
    out = []
    for t in teams:
        out.append(f"{t['name']} — {t.get('status')}, round {t.get('round')} of {t.get('max_rounds')}: {t.get('goal', '')}")
        for n in t.get("nodes", []):
            if n.get("kind") in ("agent", "check"):
                out.append(f"  {n['id']}: {n.get('state', '')}" + (f", last {n['outcome']}" if n.get("outcome") else "")
                           + (f" (session {n['session']})" if n.get("session") else ""))
    return "\n".join(out)


def _worktree(a: Argus, args: dict) -> str:
    said = a.worktree(args["repo"], args["branch"])
    return f"checkout of {said.get('branch', args['branch'])} at {said.get('path')}"


def _prompts(a: Argus, _args: dict) -> str:
    out = [f"## {p.get('name', '?')}\n{p.get('text', '')}" for p in a.prompts()]
    return "\n\n".join(out) or "the prompt library is empty"


DO = {"who": _who, "ring": _ring, "ask": _ask, "relay": _relay, "open_desk": _open_desk, "launchers": _launchers,
      "start_agent": _start, "teams": _teams, "worktree": _worktree, "prompts": _prompts}


# ------------------------------------------------------------------ the wire

def answer(message: dict, argus) -> dict | None:
    """One request in, one response out; None for a notification."""
    if "id" not in message:
        return None
    ident, method, params = message["id"], message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        result = {"protocolVersion": asked if asked in VERSIONS else VERSIONS[0],
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "argus", "version": "0.1.0"},
                  "instructions": INSTRUCTIONS}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in DO:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32602, "message": f"no tool called {name!r}"}}
        try:
            text, failed = DO[name](argus(), args), False
        except ArgusError as e:
            text, failed = f"Argus refused: {e}", True
        except (KeyError, TypeError, ValueError) as e:
            text, failed = f"bad arguments for {name}: {e}", True
        result = {"content": [{"type": "text", "text": text}], "isError": failed}
    else:
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": ident, "result": result}


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.split("##")[0].strip())
        return 0
    made: list[Argus] = []

    def argus() -> Argus:
        # Made on first use, not at start: a client lists the tools before anything is called,
        # and a machine without Argus should still answer that, then explain on the call.
        if not made:
            made.append(Argus())
        return made[0]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            try:
                out = answer(message, argus)
            except ArgusError as e:          # no config, no token: said on the call that needed it
                out = {"jsonrpc": "2.0", "id": message.get("id"),
                       "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}}
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
