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
    from .argus_client import Argus, ArgusError, own_session
except ImportError:                               # run from the folder: tools/argus_mcp.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from argus_client import Argus, ArgusError, own_session   # noqa: E402

VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "Argus watches the tmux sessions on this machine and the person who owns them, often from a "
    "phone. Use `ask` when a decision is theirs rather than guessing, and wait for the answer; "
    "`ring` when you finish or fail, so they need not watch your pane; `who` before handing work "
    "to another session with `relay`; `start_agent` to start a second agent, in its own git "
    "worktree when it will change code; `open_desk` and `start_agent` with `desk` when asked to "
    "lay agents out on a desk of their own; in an Argus team, `team_task` for your task and `team_done` to "
    "report your turn when it is done; `team_check` and `team_propose` when asked to design a team "
    "(write it as Mermaid or YAML, check it, propose it — the person starts it); `request` for what your "
    "key cannot do — start a team in a desk, end a session, … — which the person approves with a tap; `todos` and `todo_set` when asked to work on the person's to-do "
    "#n — mark it doing when you start and done when you finish."
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
         "show": {"type": "boolean", "default": True},
         "session": {"type": "string", "description": "Also put a window on this existing tmux session in the desk"}},
         "required": ["name"]}},
    {"name": "rename_desk",
     "description": "Rename a desk in Argus: the desk called `desk` (any case) is called `to` from now on, in every "
                    "open page too. Refused if another desk already has that name.",
     "inputSchema": {"type": "object", "properties": {
         "desk": {"type": "string", "description": "Its name now"},
         "to": {"type": "string", "description": "Its new name"}},
         "required": ["desk", "to"]}},
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
    {"name": "team_task",
     "description": "Your task in the Argus team you are part of: the goal, your role and duty, the round, whether it "
                    "is your turn, what the steps before you said last, and the last check. Call it when your turn "
                    "comes, and whenever you need to see where the team is.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "team_done",
     "description": "Report your turn in your Argus team when its work is done: a few lines of what you did, and — if "
                    "you judge — status OK (keep it, next step), REDO (say what is wrong), DONE (the goal is met) or "
                    "BLOCKED (a person must decide). Argus records it and gives the next turn to whoever has it; then "
                    "stop and wait.",
     "inputSchema": {"type": "object", "properties": {
         "summary": {"type": "string", "description": "What you did this turn, in a few lines"},
         "status": {"type": "string", "enum": ["OK", "REDO", "DONE", "BLOCKED"], "description": "Only if you judge (or BLOCKED)"},
         "details": {"type": "string", "description": "Anything longer: numbers, a list of findings"}},
         "required": ["summary"]}},
    {"name": "team_check",
     "description": "Check a team you have written — a Mermaid flowchart or YAML, as the argus-team-author skill "
                    "describes — before proposing it. Says ok with a one-line summary (agents, checks, judge, "
                    "start), or the line that is wrong. Starts nothing.",
     "inputSchema": {"type": "object", "properties": {
         "text": {"type": "string", "description": "The team: a Mermaid flowchart (flowchart LR …) or YAML (name, goal, steps, flow)"}},
         "required": ["text"]}},
    {"name": "team_propose",
     "description": "Propose a team to the person: Argus checks it, writes it into the folder as team.yaml and rings "
                    "them; their tap opens Team on that folder with it chosen. Only they can start it — say so, "
                    "do not wait for it. Refused if the folder already has a team.yaml of their own.",
     "inputSchema": {"type": "object", "properties": {
         "text": {"type": "string", "description": "The team, as for team_check"},
         "folder": {"type": "string", "description": "The folder the team works in: absolute, inside what Argus serves"}},
         "required": ["text", "folder"]}},
    {"name": "close_gone_windows",
     "description": "Close the windows on the person's desks whose tmux session has ended (marked 'gone') — on every "
                    "desk, or only the desk named. Only windows: no session is touched.",
     "inputSchema": {"type": "object", "properties": {"desk": {"type": "string", "description": "Only this desk (by name)"}}}},
    {"name": "request",
     "description": "Ask the person to have something done that you cannot do yourself, and it is done on their "
                    "tap (Do it / No): start_team (args: team — a proposal, one of their models or a template, by "
                    "name — desk, folder, goal, gate ask|auto|goal, rounds, permissions ask|edit|everything, check, "
                    "agents {step: launcher}), team_go / team_pause / team_stop (team — its name as `teams` shows "
                    "it; kill to end its sessions), team_reset / team_restart (team — delete what its reset: declares; "
                    "restart also starts it again from round 1), kill_session (session), rename_session (session, to), "
                    "start_agent (launcher, name, folder, prompt, press_enter, options — e.g. permissions skip), "
                    "remove_worktree (path), todo_delete (todo). Waits up to two minutes for the outcome; then "
                    "request_status.",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["start_team", "team_go", "team_pause", "team_stop", "team_reset", "team_restart", "kill_session",
                                                "rename_session", "start_agent", "remove_worktree", "todo_delete"]},
         "args": {"type": "object", "description": "The action's arguments, as listed"},
         "why": {"type": "string", "description": "One line the person reads with the question"}},
         "required": ["action"]}},
    {"name": "request_status",
     "description": "Where a request stands: asked (waiting for the person), doing, done, refused, failed or unanswered.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "todos",
     "description": "The person's to-do list in Argus, each with its number (#1, #2…), state (open, doing, done) and "
                    "words. When asked to \"work on to-do #3\", read it here first.",
     "inputSchema": {"type": "object", "properties": {
         "all": {"type": "boolean", "default": False, "description": "Include the ones already done"}}}},
    {"name": "todo_set",
     "description": "Move a to-do along: mark it doing when you start on it and done when it is finished, so the "
                    "person sees it on their list. Signed with your session.",
     "inputSchema": {"type": "object", "properties": {
         "todo": {"type": "string", "description": "Its number, e.g. \"#3\" or \"3\""},
         "status": {"type": "string", "enum": ["open", "doing", "done"]},
         "note": {"type": "string", "description": "New words for it, if they should change"}},
         "required": ["todo"]}},
    {"name": "todo_add",
     "description": "Add something to the person's to-do list — a follow-up you found but should not do now.",
     "inputSchema": {"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]}},
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


# ------------------------------------------------------------------- the tools

def _who(a: Argus, _args: dict) -> str:
    said = a.who()
    me = a.me()
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
    a.ring(args.get("text", ""), args.get("why") or "done", a.me())
    return "rung"


def _ask(a: Argus, args: dict) -> str:
    minutes = max(1.0, min(60.0, float(args.get("wait_minutes") or 10)))
    answer = a.ask(args["question"], args.get("options") or None, wait=min(minutes * 60, 300),
                   session=a.me(), patience=minutes * 60)
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
    said = a.desk(args["name"], args.get("folder") or None, bool(args.get("show", True)), session=args.get("session") or None)
    return (f"made the desk {said['name']}" if said.get("made") else f"the desk {said['name']} was already there") + (
        ", and switched to it" if args.get("show", True) else "") + (
        f"; {said['session']} is on it" if said.get("session") else "")


def _rename_desk(a: Argus, args: dict) -> str:
    said = a.desk(args["to"], show=False, rename=args["desk"])
    return f"the desk {args['desk']} is now called {said['name']}"


def _team_task(a: Argus, _args: dict) -> str:
    said = a.team_task(a.me())
    if said.get("none"):
        return said.get("why", "you are not in a team")
    lines = [f"Team {said['team']} — goal: {said['goal']}",
             f"You are {said['you']} ({said['role']}){' and you judge' if said['judge'] else ''}; "
             f"round {said['round']} of {said['max_rounds']}; "
             + ("it is your turn." if said["your_turn"] else "it is not your turn: wait."),
             f"Work in {said['folder']}.", f"Your duty: {said['duty']}"]
    for b in said.get("before_you") or []:
        lines.append(f"\n{b['who']} (round {b['round']}{', ' + b['status'] if b.get('status') else ''}) said:\n{b['text']}")
    if said.get("reads"):
        lines.append("\nThe work to look at: " + ", ".join(f"{k} in {v}" for k, v in said["reads"].items()))
    if said.get("last_check"):
        c = said["last_check"]
        lines.append(f"\nLast check {c.get('node')}: {c.get('status')} ({c.get('seconds')}s)")
    lines.append("\nWhen done: call team_done with a short summary"
                 + (" and status OK, REDO, DONE or BLOCKED." if said["judge"] else "."))
    return "\n".join(lines)


def _team_done(a: Argus, args: dict) -> str:
    said = a.team_done(args["summary"], args.get("status", ""), args.get("details", ""), a.me())
    return (f"Recorded: {said['you']}, round {said['round']}" + (f", {said['status']}" if said.get("status") else "")
            + ". Now stop and wait: Argus gives the next turn to whoever has it.")


def _team_check(a: Argus, args: dict) -> str:
    said = a.team_check(args["text"])
    if not said["ok"]:
        return f"Not yet: {said['error']}"
    warn = said.get("warnings") or []
    return (f"OK ({said['format']}): {said['name']} — {said['summary']}."
            + ("\nBut look at these — they are legal and almost certainly not what you meant:\n- " + "\n- ".join(warn)
               if warn else " Propose it with team_propose."))


def _team_propose(a: Argus, args: dict) -> str:
    said = a.team_propose(args["text"], args["folder"], a.me())
    return (f"Proposed: {said['name']}, written to {said['file']} — {said['summary']}. The person has been rung, "
            f"and it waits over their desk and as a card in Team until they start or dismiss it. Tell them so "
            f"in one line; you do not need to wait for it.")


def _close_gone(a: Argus, args: dict) -> str:
    said = a.close_gone(args.get("desk") or "").get("closed") or {}
    if not said:
        return "No window of an ended session" + (f" on {args['desk']}" if args.get("desk") else "") + "."
    return "Closed: " + "; ".join(f"{d} — {', '.join(n)}" for d, n in said.items())


def _said_request(said: dict) -> str:
    if said["state"] == "done":
        return f"Done: {said['text']}."
    if said["state"] == "refused":
        return f"The person said no to: {said['text']}."
    if said["state"] == "failed":
        return f"They said yes, but it failed: {said.get('error')}"
    return (f"Asked the person to {said['text']} — no answer yet (request {said['id']}). Tell them it is waiting "
            f"for their tap; check later with request_status.")


def _request(a: Argus, args: dict) -> str:
    return _said_request(a.request(args["action"], args.get("args") or {}, args.get("why", ""), wait=120,
                                   session=a.me()))


def _request_status(a: Argus, args: dict) -> str:
    return _said_request(a.request_status(args["id"]))


def _todos(a: Argus, args: dict) -> str:
    items = sorted(a.todos(), key=lambda x: x.get("n", 0))
    if not args.get("all"):
        items = [x for x in items if x.get("status") != "done"]
    return "\n".join(f"#{x['n']} [{x['status']}] {x['note']}" + (f"  (by {x['by']})" if x.get("by") else "")
                     for x in items) or "nothing on the list"


def _todo_set(a: Argus, args: dict) -> str:
    said = a.todo(note=args.get("note"), ident=str(args["todo"]), status=args.get("status"), by=a.me())
    return f"#{said['n']} is {said['status']}: {said['note']}"


def _todo_add(a: Argus, args: dict) -> str:
    said = a.todo(note=args["note"])
    return f"added #{said['n']}: {said['note']}"


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


DO = {"who": _who, "ring": _ring, "ask": _ask, "relay": _relay, "open_desk": _open_desk, "rename_desk": _rename_desk, "launchers": _launchers,
      "start_agent": _start, "team_task": _team_task, "team_done": _team_done, "team_check": _team_check, "team_propose": _team_propose, "request": _request, "request_status": _request_status, "close_gone_windows": _close_gone, "todos": _todos, "todo_set": _todo_set, "todo_add": _todo_add, "teams": _teams, "worktree": _worktree, "prompts": _prompts}


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
