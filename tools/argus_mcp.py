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
import time
import os
import subprocess
import sys
from pathlib import Path

try:                                              # installed: argus_tools.argus_mcp
    from . import argus_browser as browser
    from .argus_client import Argus, ArgusError, own_session
except ImportError:                               # run from the folder: tools/argus_mcp.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import argus_browser as browser                           # noqa: E402
    from argus_client import Argus, ArgusError, own_session   # noqa: E402

VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "Argus watches the tmux sessions on this machine for the person who owns them, often from a phone. "
    "Sessions, desks, windows, notes and to-dos go through these tools — never tmux itself: no "
    "`tmux rename-session`, `kill-session`, `new-session` or `send-keys`. Argus keeps every open page in "
    "step with what you do, and a stray tmux command here can end every session on the server. "
    "Open a new session with an agent in one call: `start_agent` (launcher \"Claude Code\" or \"Codex\", name, "
    "folder, prompt) — no looking around in tmux first. "
    "Asked to… rename this session: `request` rename_session (`who` says which session is yours); rename "
    "the desk: `rename_desk`; end a session: `request` kill_session; restart yourself on the new version: "
    "`request` restart_agent; start another agent: `start_agent` (in a worktree when it will change code; "
    "`desk` to put it on one); open a desk: `open_desk`; tell another session something: `who`, then "
    "`relay`; write or read a note: `notes`, `note_*`; the to-do list, a deadline Argus rings for: `todos`, "
    "`todo_add`, `todo_set`. `ask` when a decision is the person's, and wait; `ring` when you finish or fail. "
    "`actions` lists what `request` can ask for — the person taps Do it or No. In an Argus team: `team_task`, "
    "then `team_done`; to design one: `team_check`, `team_propose`. "
    "The person's own computer (their Mac or PC, connected through argus-bridge): its browser is yours with "
    "`browser_open` (a page), `browser_look` (a screenshot, the text and everything clickable, numbered), "
    "`browser_click`, `browser_type`, `browser_eval`, `browser_tabs` — they watch it happen on their screen. "
    "A command on that computer: `request` computer_run. Never ask them for SSH tunnels, debugging ports or "
    "to start Chrome by hand: if no browser is lent, the tool says what to switch on."
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
                    "\"a new desk called …\"; then start agents into it with start_agent's desk. With `folder` it "
                    "also sets the desk's folder (where its browsers and new sessions start), for a desk that "
                    "exists too — \"make ~/x the folder of the desk Trading\": open_desk(name, folder, show: false).",
     "inputSchema": {"type": "object", "properties": {
         "name": {"type": "string"},
         "folder": {"type": "string", "description": "Where its file browsers and new sessions start — set on a new desk, "
                                                    "changed on one that exists"},
         "show": {"type": "boolean", "default": True},
         "session": {"type": "string", "description": "Also put a window on this existing tmux session in the desk"}},
         "required": ["name"]}},
    {"name": "rename_desk",
     "description": "Rename a desk in Argus: the desk called `desk` (any case) is called `to` from now on, in every "
                    "open page too. Leave `desk` out to rename the desk YOUR session is in — what \"rename the "
                    "desk\" means when nobody names one. Refused if another desk already has that name. A desk's "
                    "name is not its session's: a wrong `desk` is answered with the desks there are and yours.",
     "inputSchema": {"type": "object", "properties": {
         "desk": {"type": "string", "description": "Its name now — leave out for the desk you are in"},
         "to": {"type": "string", "description": "Its new name"}},
         "required": ["to"]}},
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
                    "start), or every problem with its line and, where it is obvious, the fix. Starts nothing.",
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
                    "agents {step: launcher}, layout grid|cols|rows|none — how the desk is arranged, grid by default, ring_turns true to ring at every agent's turn — off by default, desk_folder: the desk starts in the team's folder — if it has none by default, true always, false never), team_go / team_pause / team_stop (team — its name as `teams` shows "
                    "it; kill to end its sessions), team_reset / team_restart (team — delete what its reset: declares; "
                    "restart also starts it again from round 1), kill_session (session), rename_session (session, to), close_desk (desk — its windows go, sessions stay), "
                    "start_agent (launcher, name, folder, prompt, press_enter, options — e.g. permissions skip), "
                    "remove_worktree (path), todo_delete (todo), update_plugin (agent: claude or codex — install or update the "
                    "Argus plugin there), reload_plugins (no args; never asked — the Claude sessions at their prompt "
                    "take the plugin installed), restart_agent (session — on the version installed now, same conversation), "
                    "computer_run (computer — its name, command, cwd? — on the person's own Mac or PC connected through "
                    "argus-bridge with its actions on; the output comes back). Waits up to two minutes for the outcome; then "
                    "request_status.",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["start_team", "team_go", "team_pause", "team_stop", "team_reset", "team_restart", "close_desk", "kill_session",
                                                "rename_session", "start_agent", "remove_worktree", "todo_delete",
                                                "update_plugin", "reload_plugins", "restart_agent", "computer_run"]},
         "args": {"type": "object", "description": "The action's arguments, as listed"},
         "why": {"type": "string", "description": "One line the person reads with the question"}},
         "required": ["action"]}},
    {"name": "request_status",
     "description": "Where a request stands: asked (waiting for the person), doing, done, refused, failed or unanswered.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "computers",
     "description": "The person's own computers (Mac, PC) connected to Argus through argus-bridge, and what each lends: "
                    "its browser — `endpoint`, a ws://127.0.0.1 address to drive it with Playwright "
                    "(chromium.connect_over_cdp), Puppeteer (browserWSEndpoint) or chrome-devtools-mcp (--wsEndpoint); "
                    "and whether its actions are on, for `request` with action computer_run {computer, command, cwd?}, "
                    "which the person allows with a tap and whose output comes back in request_status.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "browser_open",
     "description": "Open a page in the browser of the person's own computer (their Chrome on their Mac or PC, "
                    "lent through argus-bridge) — in your tab of it, which they watch. Then browser_look to see it.",
     "inputSchema": {"type": "object", "properties": {
         "url": {"type": "string"},
         "new_tab": {"type": "boolean", "default": False, "description": "A tab of its own instead of yours"},
         "computer": {"type": "string", "description": "Which computer, when they have several (its name)"}},
         "required": ["url"]}},
    {"name": "browser_look",
     "description": "What your tab of the person's browser shows: a screenshot, the title and address, the page's "
                    "text, and every link, button and field numbered — the numbers browser_click and browser_type take.",
     "inputSchema": {"type": "object", "properties": {
         "screenshot": {"type": "boolean", "default": True},
         "computer": {"type": "string"}}}},
    {"name": "browser_click",
     "description": "Click (a real mouse click) on something in your tab: its number from browser_look, or the words it shows.",
     "inputSchema": {"type": "object", "properties": {
         "target": {"type": "string", "description": "A number from browser_look, or the words on it"},
         "computer": {"type": "string"}}, "required": ["target"]}},
    {"name": "browser_type",
     "description": "Type into a field of your tab (what it held is replaced): its number from browser_look or its "
                    "label/placeholder; `enter` presses Return after. For passwords and MFA, let the person type.",
     "inputSchema": {"type": "object", "properties": {
         "target": {"type": "string"}, "text": {"type": "string"},
         "enter": {"type": "boolean", "default": False}, "computer": {"type": "string"}},
         "required": ["target", "text"]}},
    {"name": "browser_eval",
     "description": "Run JavaScript in your tab and get its value back (JSON) — for what the other tools do not reach.",
     "inputSchema": {"type": "object", "properties": {
         "expression": {"type": "string"}, "computer": {"type": "string"}}, "required": ["expression"]}},
    {"name": "browser_tabs",
     "description": "The tabs open in the person's browser, with yours marked.",
     "inputSchema": {"type": "object", "properties": {"computer": {"type": "string"}}}},
    {"name": "needs",
     "description": "What is waiting on the person right now, in one list: questions and requests for their OK, "
                    "teams stopped for them, agents waiting, teams proposed, to-dos rung or late. Look before "
                    "asking them something else: if they are already asked three things, say so.",
     "inputSchema": {"type": "object", "properties": {}}},
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
         "note": {"type": "string", "description": "New words for it, if they should change"},
         "due": {"type": "string", "description": "A deadline in the machine's local time: 2026-10-20, or 2026-10-20T15:00 — \"\" takes it away"},
         "remind": {"type": "integer", "enum": [0, 15, 60, 1440, 10080],
                    "description": "Minutes before the deadline that Argus rings the person (a day alone: from 9:00 that day)"},
         },
         "required": ["todo"]}},
    {"name": "todo_add",
     "description": "Add something to the person's to-do list — a follow-up you found but should not do now. With "
                    "`due` (and `remind`), Argus rings them when it is time: \"remind me tomorrow at 3 to call the lab\".",
     "inputSchema": {"type": "object", "properties": {"note": {"type": "string"},
         "due": {"type": "string", "description": "A deadline in the machine's local time: 2026-10-20, or 2026-10-20T15:00"},
         "remind": {"type": "integer", "enum": [0, 15, 60, 1440, 10080],
                    "description": "Minutes before the deadline that Argus rings the person (a day alone: from 9:00 that day)"},
         }, "required": ["note"]}},
    {"name": "notes",
     "description": "The person's notes in Argus (the Notes screen), the latest first: name, first line, and the "
                    "path of the plain file. When asked about \"my notes\" or \"the note on X\", look here first.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "note_read",
     "description": "One note's whole text.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "e.g. plan.md"}},
                     "required": ["name"]}},
    {"name": "note_new",
     "description": "A new note, shown at once in the person's Notes. Without a name it is note-N.md.",
     "inputSchema": {"type": "object", "properties": {
         "text": {"type": "string", "description": "Its words (Markdown; ```mermaid fences are drawn as diagrams)"},
         "name": {"type": "string", "description": "A file name; .md is added if it has no suffix"}}}},
    {"name": "note_add",
     "description": "Add words at the end of a note, after a blank line — a finding, a result, a follow-up. "
                    "The note is made if there is none of that name.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "text": {"type": "string"}},
                     "required": ["name", "text"]}},
    {"name": "note_write",
     "description": "Replace a note's whole text. Prefer note_add unless asked to rewrite it.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "text": {"type": "string"}},
                     "required": ["name", "text"]}},
    {"name": "note_rename",
     "description": "Give a note another name; refused when the new name is taken.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "to": {"type": "string"}},
                     "required": ["name", "to"]}},
    {"name": "note_delete",
     "description": "Delete a note: it goes into the notes' trash beside them, where it can be taken back.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
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
    {"name": "worktrees",
     "description": "The git repository a path is in, and every checkout of it (worktrees an earlier run left too).",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "actions",
     "description": "What this key cannot do by itself but may `request` (the person taps Do it / No), and which "
                    "the person lets through without asking.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "bells",
     "description": "What rang lately on this machine: which session finished, failed or is waiting, with its words.",
     "inputSchema": {"type": "object", "properties": {
         "last": {"type": "integer", "default": 10, "description": "How many, the latest last (1-50)"}}}},
    {"name": "wait_for_files",
     "description": "Wait until files exist (another agent's result), woken by bells; says which arrived and which "
                    "did not when the time is up.",
     "inputSchema": {"type": "object", "properties": {
         "paths": {"type": "array", "items": {"type": "string"}},
         "minutes": {"type": "number", "default": 10, "description": "How long to wait (at most 60)"}},
         "required": ["paths"]}},
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
    try:
        me = a.me()
    except Exception:
        me = None
    was = (args.get("desk") or "").strip()
    said = a.desk(args["to"], show=False, rename=was or None, asker=me, rename_mine=not was)
    return f"the desk {was or 'you are in'} is now called {said['name']}"


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


def _line(p: dict) -> str:
    """One problem, the way an editor says it: where, what, and the fix when there is one."""
    where = f"line {p['line']}: " if p.get("line") else ""
    fix = f" (fix: {p['fix']['label']})" if p.get("fix") else ""
    return f"{where}{p['message']}{fix}"


def _team_check(a: Argus, args: dict) -> str:
    said = a.team_check(args["text"])
    problems = said.get("problems") or []
    if not said["ok"]:
        errors = [p for p in problems if p.get("level") == "error"] or [{"message": said["error"]}]
        return "Not yet:\n- " + "\n- ".join(_line(p) for p in errors + [p for p in problems if p.get("level") != "error"])
    warn = [_line(p) for p in problems if p.get("level") == "warning"] or said.get("warnings") or []
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


def _computers(a: Argus, args: dict) -> str:
    rows = []
    for c in a.computers():
        lends = [k for k, on in (c.get("offers") or {}).items() if on]
        rows.append(f"{c['name']}: " + ("connected" if c.get("connected") else "not connected")
                    + (f" ({c.get('os')})" if c.get("os") else "") + (f" — lends {', '.join(lends)}" if lends else " — lends nothing")
                    + (f"\n  browser: {c['endpoint']}" if c.get("endpoint") else "")
                    + (f"\n  but the browser is not working: {c['browser_trouble']}" if c.get("browser_trouble") else ""))
    return "\n".join(rows) or "no computer is connected — the person connects one in Argus: Settings → Computers"


def _browser(fn):
    """A browser tool: Argus says where the person's browser is, at every call."""
    def run(a: Argus, args: dict):
        try:
            return fn(a.computers(), args)
        except browser.BrowserError as e:
            raise ArgusError(0, str(e)) from None
        except OSError as e:
            raise ArgusError(0, f"the person's browser did not answer: {e}") from None
    return run


def _said(d: dict) -> str:
    return (f"{d.get('title') or '(no title)'} — {d.get('url', '')} (on {d.get('computer')})"
            + (f"\n\n⚠ {d['warning']}" if d.get("warning") else ""))


def _look_text(d: dict) -> str:
    rows = [f"[{e['n']}] {e['kind']} {e['words']!r}" + (f" → {e['href']}" if e.get("href") else "")
            + (f" = {e['value']!r}" if e.get("value") else "") for e in d.get("elements") or []]
    return (_said(d) + "\n\nClickable and fillable, by number:\n" + ("\n".join(rows) or "(nothing)")
            + "\n\nThe page's text:\n" + (d.get("text") or "(empty)"))


def _look(computers, args):
    d = browser.look(computers, args.get("computer"), shot=args.get("screenshot", True) is not False)
    blocks = [{"type": "text", "text": _look_text(d)}]
    if d.get("screenshot"):
        blocks.insert(0, {"type": "image", "data": d["screenshot"], "mimeType": "image/jpeg"})
    return blocks


BROWSER = {
    "browser_open": _browser(lambda c, a: "opened: " + _said(browser.open_page(c, a["url"], a.get("computer"), bool(a.get("new_tab"))))),
    "browser_look": _browser(_look),
    "browser_click": _browser(lambda c, a: "clicked; now: " + _said(browser.click(c, a["target"], a.get("computer")))),
    "browser_type": _browser(lambda c, a: "typed; now: " + _said(browser.type_text(c, a["target"], a["text"], bool(a.get("enter")), a.get("computer")))),
    "browser_eval": _browser(lambda c, a: json.dumps(browser.evaluate(c, a["expression"], a.get("computer"))["value"], ensure_ascii=False)),
    "browser_tabs": _browser(lambda c, a: "\n".join(("→ " if t["yours"] else "  ") + f"{t['title'] or '(no title)'} — {t['url']}"
                                                    for t in browser.tabs(c, a.get("computer"))["tabs"]) or "no tabs"),
}


def _needs(a: Argus, args: dict) -> str:
    def line(x: dict) -> str:
        who = x.get("session") or x.get("name") or (f"#{x['n']}" if x.get("n") else "")
        what = x.get("text") or x.get("folder") or ""
        tag = "request" if x.get("request") else x["kind"]
        return f"[{tag}] {who}: {what}".replace(": :", ":").strip()
    items = a.needs()
    return "\n".join(line(x) for x in items) or "nothing is waiting on the person"


def _todos(a: Argus, args: dict) -> str:
    items = sorted(a.todos(), key=lambda x: x.get("n", 0))
    if not args.get("all"):
        items = [x for x in items if x.get("status") != "done"]
    return "\n".join(f"#{x['n']} [{x['status']}] {x['note']}" + (f"  (due {x['due'].replace('T', ' ')})" if x.get("due") else "")
                     + (f"  (by {x['by']})" if x.get("by") else "")
                     for x in items) or "nothing on the list"


def _todo_set(a: Argus, args: dict) -> str:
    said = a.todo(note=args.get("note"), ident=str(args["todo"]), status=args.get("status"), by=a.me(),
                  due=args.get("due"), remind=args.get("remind"))
    return f"#{said['n']} is {said['status']}: {said['note']}" + _due_words(said)


def _todo_add(a: Argus, args: dict) -> str:
    said = a.todo(note=args["note"], due=args.get("due"), remind=args.get("remind"))
    return f"added #{said['n']}: {said['note']}" + _due_words(said)


def _due_words(item: dict) -> str:
    if not item.get("due"):
        return ""
    ring = item.get("remind")
    return f" — due {item['due'].replace('T', ' ')}" + ("" if ring is None else
        ", Argus rings at the time" if ring == 0 else f", Argus rings {ring} minutes before")


def _notes(a: Argus, _args: dict) -> str:
    said = a.notes()
    lines = [f"{n['name']}: {n['title'] or '(empty)'}" for n in said.get("notes") or []]
    return (f"notes in {said['dir']}:\n" + "\n".join(lines)) if lines else f"no notes yet (they go in {said['dir']})"


def _note_read(a: Argus, args: dict) -> str:
    said = a.note(args["name"])
    return f"{said['path']}\n\n{said['text']}"


def _note_new(a: Argus, args: dict) -> str:
    said = a.note_new(args.get("text") or "", args.get("name") or "")
    return f"made {said['name']}: {said['path']}"


def _note_add(a: Argus, args: dict) -> str:
    said = a.note_add(args["name"], args["text"])
    return f"added to {said['name']}: {said['path']}"


def _note_write(a: Argus, args: dict) -> str:
    said = a.note_write(args["name"], args["text"])
    return f"wrote {said['name']}: {said['path']}"


def _note_rename(a: Argus, args: dict) -> str:
    said = a.note_rename(args["name"], args["to"])
    return f"{args['name']} is now {said['name']}"


def _note_delete(a: Argus, args: dict) -> str:
    said = a.note_delete(args["name"])
    return f"deleted {said['deleted']} — kept in the notes' trash: {said['kept']}"


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


def _worktrees(a: Argus, args: dict) -> str:
    said = a.worktrees(args["path"])
    rows = [f"{w.get('branch') or '(detached)'}: {w.get('path')}" for w in said.get("worktrees") or []]
    return (f"{said.get('repo') or said.get('top') or args['path']}\n" + "\n".join(rows)) if rows else "not in a git repository"


def _actions(a: Argus, _args: dict) -> str:
    return "\n".join(f"{x['action']}: {x['what']}" + ("" if x.get("asks", True) else "  (done without asking)")
                     + ("  [risky]" if x.get("danger") else "") for x in a.actions()) or "nothing to request"


def _bells(a: Argus, args: dict) -> str:
    last = max(1, min(50, int(args.get("last") or 10)))
    rang = (a.call("GET", "/api/bells?since=0").get("bells") or [])[-last:]
    return "\n".join(f"{time.strftime('%H:%M', time.localtime(b.get('at', 0)))} {b.get('session') or '-'} {b.get('why')}: "
                     f"{(b.get('text') or '').splitlines()[0][:160] if b.get('text') else ''}" for b in rang) or "nothing rang"


def _wait_for_files(a: Argus, args: dict) -> str:
    minutes = max(0.1, min(60.0, float(args.get("minutes") or 10)))
    arrived, missing = a.wait_for(args["paths"], time.monotonic() + minutes * 60)
    return "arrived: " + (", ".join(map(str, arrived)) or "none") + (f"\nstill missing: {', '.join(map(str, missing))}" if missing else "")


def _prompts(a: Argus, _args: dict) -> str:
    out = [f"## {p.get('name', '?')}\n{p.get('text', '')}" for p in a.prompts()]
    return "\n\n".join(out) or "the prompt library is empty"


DO = {"who": _who, "ring": _ring, "ask": _ask, "relay": _relay, "open_desk": _open_desk, "rename_desk": _rename_desk, "launchers": _launchers,
      "start_agent": _start, "team_task": _team_task, "team_done": _team_done, "team_check": _team_check, "team_propose": _team_propose, "request": _request, "request_status": _request_status, "close_gone_windows": _close_gone, "computers": _computers, "needs": _needs, "todos": _todos, "todo_set": _todo_set, "todo_add": _todo_add, "notes": _notes, "note_read": _note_read, "note_new": _note_new, "note_add": _note_add, "note_write": _note_write, "note_rename": _note_rename, "note_delete": _note_delete, "teams": _teams, "worktree": _worktree, "prompts": _prompts, "worktrees": _worktrees, "actions": _actions, "bells": _bells, "wait_for_files": _wait_for_files, **BROWSER}


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
            text, failed = f"Argus refused: {e}" if not name.startswith("browser_") else str(e), True
        except (KeyError, TypeError, ValueError) as e:
            text, failed = f"bad arguments for {name}: {e}", True
        # A tool may answer with blocks of its own (browser_look: a picture, then words).
        content = text if isinstance(text, list) else [{"type": "text", "text": text}]
        result = {"content": content, "isError": failed}
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
