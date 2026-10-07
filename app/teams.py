"""A team of agents working on one goal, directed by Argus — on the server, browser or not.

Two agents taught what holds up: the work goes through a file everyone can read (append-only
turns, `@TURN … @END`), nobody reads a screen, and "finished" is something an agent says. What it
did not have is somebody to keep it going with no tab open, an answer that is not an agent's
opinion, and room for more than two. This adds all three.

**A team is a graph.** Its nodes are

- **agent**: a role with an agent in a session of its own (`<team>-<node>`), working in a folder —
  its own git worktree, if it changes code;
- **check**: a command (tests, a benchmark) that Argus runs in a tmux session of the team's own,
  where you can watch it; its exit code is PASS or FAIL;
- **join**: waits for everything that leads into it, then lets the team go on;
- **end**: the goal is met.

Its **arrows** carry a condition: always, or the outcome of the node they leave — PASS / FAIL for a
check, OK / REDO / DONE / BLOCKED for an agent that judges. When a node finishes, Argus follows
every arrow whose condition holds; two of them leaving one node are two branches running at once.

**A round** lasts until something is done again: following an arrow back to a node that has
already run this round starts the next one. That is where the person can be asked (the `ask`
gate), where the rounds are counted against the limit, and why a failed check sent back to the
executor, or a REDO, both count.

**The log** is `TEAM.argus.md` in the project: every turn, every check result, every decision
Argus takes, in the order they happened. **The director** is a loop on the server; it prompts a
node's agent (the same bracketed paste a hand-off uses), waits for that node's turn to appear in
the log, runs checks, and moves on. It never decides anything a turn or a check did not say.

The templates are ready-made graphs. Side effects go through `io`, so all of this is tested
without tmux (tests/test_teams.py).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

LOG_NAME = "TEAM.argus.md"
START_GRACE = 45          # seconds an agent just started has to begin working before you are told
NUDGE_AFTER = 120          # s an agent may sit waiting without writing its turn before a reminder
GIVE_UP_AFTER = 300        # …and before the person is asked
TAIL_LINES = 25            # of a check's output, into the log
MAX_ROUNDS = 30
MAX_NODES = 12
MAX_AGENTS = 8
GATES = ("ask", "auto", "goal")
KINDS = ("agent", "check", "join", "end")
WHEN = ("always", "PASS", "FAIL", "OK", "REDO", "DONE", "BLOCKED")
NODE_ID = re.compile(r"^[a-z][a-z0-9-]{0,19}$")

DUTIES = {
    "planner": "You plan. Break the goal into the next concrete step and say exactly what the others should do. You do not edit the code.",
    "executor": "You make the changes. One focused step per round: do it, make sure it builds, and say what you changed and why.",
    "reviewer": "You review. Read the turns before yours, the checks' results, and the changes themselves (git diff in each folder you are given). You do not edit the code.",
    "researcher": "You gather what the work needs: sources, facts, numbers, with where each came from.",
    "writer": "You write, from the material and the remarks in the log.",
    "critic": "You judge the writing against the goal. You do not rewrite it.",
    "tester": "You write and run tests for what was just changed, and report what fails.",
}
VERDICTS = "OK (keep it, and say the next step), REDO (say what is wrong), DONE (the goal is met), BLOCKED (a person must decide)"


def _g(nodes: list[dict], edges: list[tuple], start: list[str]) -> dict:
    return {"nodes": nodes, "edges": [{"from": a, "to": b, "when": w} for a, b, w in edges], "start": start}


TEMPLATES: dict[str, dict] = {
    "optimise": {
        "label": "Optimise", "check": True,
        "hint": "one changes, the check measures, one reviews — the numbers decide",
        "graph": _g([
            {"id": "executor", "kind": "agent", "role": "executor", "worktree": True},
            {"id": "check", "kind": "check", "of": "executor"},
            {"id": "reviewer", "kind": "agent", "role": "reviewer", "judge": True, "reads": ["executor"]},
            {"id": "end", "kind": "end"},
        ], [("executor", "check", "always"), ("check", "reviewer", "PASS"), ("check", "executor", "FAIL"),
            ("reviewer", "executor", "OK"), ("reviewer", "executor", "REDO"), ("reviewer", "end", "DONE")], ["executor"]),
    },
    "tournament": {
        "label": "Tournament", "check": True,
        "hint": "two try in parallel, each is checked, one reviewer keeps the better",
        "graph": _g([
            {"id": "planner", "kind": "agent", "role": "planner"},
            {"id": "executor-a", "kind": "agent", "role": "executor", "worktree": True},
            {"id": "executor-b", "kind": "agent", "role": "executor", "worktree": True},
            {"id": "check-a", "kind": "check", "of": "executor-a"},
            {"id": "check-b", "kind": "check", "of": "executor-b"},
            {"id": "join", "kind": "join"},
            {"id": "reviewer", "kind": "agent", "role": "reviewer", "judge": True, "reads": ["executor-a", "executor-b"]},
            {"id": "end", "kind": "end"},
        ], [("planner", "executor-a", "always"), ("planner", "executor-b", "always"),
            ("executor-a", "check-a", "always"), ("executor-b", "check-b", "always"),
            ("check-a", "join", "always"), ("check-b", "join", "always"), ("join", "reviewer", "always"),
            ("reviewer", "planner", "OK"), ("reviewer", "planner", "REDO"), ("reviewer", "end", "DONE")], ["planner"]),
    },
    "split": {
        "label": "Split the work", "check": True,
        "hint": "one divides the files, two work at once in the same folder, the check and a reviewer decide",
        "graph": _g([
            {"id": "planner", "kind": "agent", "role": "planner",
             "duty": "You split the work between executor-a and executor-b: the next step for each, and which files each one owns. Every file that will be touched gets exactly one owner. You do not edit the code."},
            {"id": "executor-a", "kind": "agent", "role": "executor",
             "duty": "You do your half of the step the planner gave you. Edit only the files the planner gave to you; the other executor is editing the rest at this moment, in the same folder."},
            {"id": "executor-b", "kind": "agent", "role": "executor",
             "duty": "You do your half of the step the planner gave you. Edit only the files the planner gave to you; the other executor is editing the rest at this moment, in the same folder."},
            {"id": "join", "kind": "join"},
            {"id": "check", "kind": "check", "of": "executor-a"},
            {"id": "reviewer", "kind": "agent", "role": "reviewer", "judge": True, "reads": ["executor-a"]},
            {"id": "end", "kind": "end"},
        ], [("planner", "executor-a", "always"), ("planner", "executor-b", "always"),
            ("executor-a", "join", "always"), ("executor-b", "join", "always"), ("join", "check", "always"),
            ("check", "reviewer", "PASS"), ("check", "planner", "FAIL"),
            ("reviewer", "planner", "OK"), ("reviewer", "planner", "REDO"), ("reviewer", "end", "DONE")], ["planner"]),
    },
    "fix": {
        "label": "Fix a bug", "check": True,
        "hint": "one fixes, the check (the test that shows the bug) decides",
        "graph": _g([
            {"id": "executor", "kind": "agent", "role": "executor", "worktree": True},
            {"id": "check", "kind": "check", "of": "executor"},
            {"id": "end", "kind": "end"},
        ], [("executor", "check", "always"), ("check", "end", "PASS"), ("check", "executor", "FAIL")], ["executor"]),
    },
    "feature": {
        "label": "Feature with tests", "check": True,
        "hint": "one plans, one codes, the tests check, one reviews, one documents",
        "graph": _g([
            {"id": "planner", "kind": "agent", "role": "planner"},
            {"id": "coder", "kind": "agent", "role": "executor", "worktree": True},
            {"id": "check", "kind": "check", "of": "coder"},
            {"id": "reviewer", "kind": "agent", "role": "reviewer", "judge": True, "reads": ["coder"]},
            {"id": "docs", "kind": "agent", "role": "writer", "reads": ["coder"], "duty": "You document what was built: the README and the comments that a reader of the code needs."},
            {"id": "end", "kind": "end"},
        ], [("planner", "coder", "always"), ("coder", "check", "always"), ("check", "reviewer", "PASS"),
            ("check", "coder", "FAIL"), ("reviewer", "coder", "REDO"), ("reviewer", "docs", "OK"),
            ("reviewer", "docs", "DONE"), ("docs", "end", "always")], ["planner"]),
    },
    "review": {
        "label": "Build and review", "check": False,
        "hint": "one builds, one reviews",
        "graph": _g([
            {"id": "executor", "kind": "agent", "role": "executor"},
            {"id": "reviewer", "kind": "agent", "role": "reviewer", "judge": True, "reads": ["executor"]},
            {"id": "end", "kind": "end"},
        ], [("executor", "reviewer", "always"), ("reviewer", "executor", "OK"), ("reviewer", "executor", "REDO"),
            ("reviewer", "end", "DONE")], ["executor"]),
    },
    "write": {
        "label": "Write", "check": False,
        "hint": "a researcher, a writer, and two critics in parallel",
        "graph": _g([
            {"id": "researcher", "kind": "agent", "role": "researcher"},
            {"id": "writer", "kind": "agent", "role": "writer"},
            {"id": "critic-method", "kind": "agent", "role": "critic", "judge": True,
             "duty": "You judge the method and the facts: is every claim supported, is every number right?"},
            {"id": "critic-style", "kind": "agent", "role": "critic", "judge": True,
             "duty": "You judge the writing: is it clear, in order, and no longer than it needs to be?"},
            {"id": "join", "kind": "join"},
            {"id": "end", "kind": "end"},
        ], [("researcher", "writer", "always"), ("writer", "critic-method", "always"), ("writer", "critic-style", "always"),
            ("critic-method", "join", "always"), ("critic-style", "join", "always"), ("join", "writer", "always")], ["researcher"]),
    },
}


# --------------------------------------------------------------------------- the log

TURN_OPEN = re.compile(r"^@TURN\s+(.*)$")
TURN_END = re.compile(r"^@END\b")


@dataclass
class Turn:
    who: str
    fields: dict
    body: str
    done: bool

    @property
    def status(self) -> str:
        return str(self.fields.get("status", "")).upper()


def parse_turns(text: str) -> list[Turn]:
    """`@TURN key=value …` / body / `@END`. A turn without its `@END` is still being written."""
    turns: list[Turn] = []
    cur: Turn | None = None
    lines: list[str] = []
    for line in (text or "").splitlines():
        opened = TURN_OPEN.match(line)
        if opened:
            if cur:
                cur.body = "\n".join(lines).strip()
                turns.append(cur)
            fields = dict(kv.split("=", 1) for kv in opened.group(1).split() if "=" in kv)
            cur = Turn(who=str(fields.get("who", "?")).upper(), fields=fields, body="", done=False)
            lines = []
            continue
        if cur and TURN_END.match(line):
            cur.body = "\n".join(lines).strip()
            cur.done = True
            turns.append(cur)
            cur = None
            lines = []
            continue
        if cur:
            lines.append(line)
    if cur:
        cur.body = "\n".join(lines).strip()
        turns.append(cur)
    return turns


def turn_text(who: str, body: str, **fields) -> str:
    head = " ".join(f"{k}={v}" for k, v in {"who": who.upper(), **fields}.items())
    return f"\n@TURN {head}\n{body.strip()}\n@END at={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"


# --------------------------------------------------------------------------- the graph

def check_graph(graph: dict, needs_check: bool = False) -> dict:
    """A graph that can be run, or ValueError saying what is wrong with it, in words."""
    if not isinstance(graph, dict):
        raise ValueError("the team's graph is missing")
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    start = graph.get("start") or []
    if not nodes or len(nodes) > MAX_NODES:
        raise ValueError(f"a team has between 1 and {MAX_NODES} steps")
    ids = set()
    for n in nodes:
        nid = str(n.get("id", ""))
        if not NODE_ID.match(nid):
            raise ValueError(f"{nid!r} cannot name a step: start with a lowercase letter, then lowercase letters, "
                             f"digits and dashes, at most 20 characters")
        if nid in ids:
            raise ValueError(f"two steps are called {nid}")
        ids.add(nid)
        if n.get("kind") not in KINDS:
            raise ValueError(f"{nid}: a step is an agent, a check, a join or the end")
        # A role may be one of your own (a name and a duty, kept in the preferences): any short
        # name goes, and its duty is whatever you wrote — within reason, since it is typed in.
        if len(str(n.get("role") or "")) > 30:
            raise ValueError(f"{nid}: a role's name is at most 30 characters")
        if len(str(n.get("duty") or "")) > 4000:
            raise ValueError(f"{nid}: a duty is at most 4000 characters")
    agents = [n for n in nodes if n["kind"] == "agent"]
    if not agents:
        raise ValueError("a team needs at least one agent")
    if len(agents) > MAX_AGENTS:
        raise ValueError(f"at most {MAX_AGENTS} agents in a team")
    for n in nodes:
        if n["kind"] == "check" and n.get("of") and n["of"] not in ids:
            raise ValueError(f"{n['id']} checks {n['of']}, which is not in the team")
        for r in n.get("reads") or []:
            if r not in ids:
                raise ValueError(f"{n['id']} reads {r}, which is not in the team")
    for e in edges:
        if e.get("from") not in ids or e.get("to") not in ids:
            raise ValueError("an arrow joins a step that is not in the team")
        if e.get("when", "always") not in WHEN:
            raise ValueError(f"an arrow's condition is one of {', '.join(WHEN)}")
        if e["from"] == e["to"] and e.get("when", "always") == "always":
            raise ValueError(f"{e['from']} would start itself again for ever: an arrow back into a step needs a condition")
    if not start or any(s not in ids for s in start):
        raise ValueError("the team needs a step to start from")
    if needs_check and not any(n["kind"] == "check" for n in nodes):
        raise ValueError("this team needs a check: the command whose result decides")
    for n in nodes:
        if n["kind"] == "join" and not any(e["to"] == n["id"] for e in edges):
            raise ValueError(f"{n['id']} waits for nothing: give it an arrow in")
    return graph


def preds(graph: dict, nid: str) -> list[str]:
    return sorted({e["from"] for e in graph["edges"] if e["to"] == nid})


def node(graph: dict, nid: str) -> dict:
    return next(n for n in graph["nodes"] if n["id"] == nid)


def fill_graph(graph: dict, base: str, folders: dict[str, str] | None = None,
               commands: dict[str, str] | None = None, default_check: str | None = None) -> dict:
    """A graph ready to run: a session for every agent and check (`<base>-<node>`), each agent's
    folder, each check's command (its own, or the team's)."""
    g = deepcopy(graph)
    for n in g["nodes"]:
        if n["kind"] in ("agent", "check"):
            n["session"] = f"{base}-{n['id']}"
        if (folders or {}).get(n["id"]):
            n["folder"] = folders[n["id"]]
        if n["kind"] == "check":
            n["command"] = ((commands or {}).get(n["id"]) or n.get("command") or default_check or "").strip()
    return g


# --------------------------------------------------------------------------- prompts

def how_to_answer(team: dict, nid: str) -> str:
    """How an agent reports its turn — a call first, the file only as the last resort.

    Since 2026-10-07 an agent reports with the Argus tool `team_done` (the plugin's MCP server) or
    `argus-say turn`, and Argus writes the turn into the log itself: an agent appending a block in an
    exact format by hand was the most fragile thing in a team. The heredoc stays for an agent that
    has neither, so a team still runs with any agent at all."""
    log = team["log"]
    n = node(team["graph"], nid)
    judge = bool(n.get("judge"))
    status = " status=<OK|REDO|DONE|BLOCKED>" if judge else ""
    verdict = (f" with status OK, REDO, DONE or BLOCKED" if judge else "")
    flag = " --status <OK|REDO|DONE|BLOCKED>" if judge else ""
    return (f"When you have finished this turn, report it{verdict} and a few lines of what you did:\n"
            f"- with the Argus tool team_done, if you have it (the Argus plugin);\n"
            f"- otherwise with the command:  argus-say turn{flag} \"<what you did>\"\n"
            f"- with neither, append exactly this to {log} (a heredoc, so the shell runs nothing in it):\n\n"
            f"cat >> {log} <<'ARGUS_TURN'\n@TURN who={nid.upper()} round={team['round']}{status}\n"
            f"<what you did, in a few lines>\n@END\nARGUS_TURN\n\n"
            f"Then stop and wait: Argus gives the next turn to whoever has it. Do not wait for, or "
            f"answer, the other agents yourself.")


def prompt_for(team: dict, nid: str) -> str:
    g = team["graph"]
    n = node(g, nid)
    where = n.get("folder") or team["folder"]
    parts = []
    if not team.get("introduced", {}).get(nid):
        others = [m["id"] for m in g["nodes"] if m["kind"] == "agent" and m["id"] != nid]
        parts.append(f"You are {nid} ({n.get('role', 'agent')}) in a team of agents directed by Argus"
                     + (f", with {', '.join(others)}" if others else "") + f". Goal: {team['goal']}")
        parts.append(f"Work in {where}. The team's log is {team['log']}: read it before you start; "
                     f"every turn, every check result and every verdict is there, signed by who wrote it.")
        parts.append(n.get("duty") or DUTIES.get(n.get("role", ""), ""))
        if n.get("judge"):
            parts.append(f"You end your turn with a verdict: {VERDICTS}.")
    else:
        parts.append(f"Round {team['round']}. Your turn again: read the latest entries in {team['log']}.")
    before = preds(g, nid)
    if before:
        parts.append("Before you this round: " + ", ".join(before) + ". Start from their latest turns.")
    reads = [r for r in n.get("reads") or [] if node(g, r).get("folder")]
    for r in reads:
        parts.append(f"The work of {r} is in {node(g, r)['folder']} (git diff there shows its changes).")
    failed = [p for p in before if team.get("outcomes", {}).get(p) == "FAIL"]
    if failed:
        parts.append(f"The check {', '.join(failed)} FAILED — its output is in the log. Deal with that first.")
    parts.append(how_to_answer(team, nid))
    return "\n\n".join(p for p in parts if p)


# --------------------------------------------------------------------------- the director

class Director:
    """Every team, and the loop that moves them on. `io` does the outside world:

    - `send(session, text)`: type a prompt into a session and press Enter;
    - `state(session)`: `("working"|"waiting", since)` or None;
    - `run_check(team, command, folder, log_path, exit_path, session)`: start a check, not waiting;
    - `ring(why, text, session)`: a bell;
    - `now()`.
    """

    def __init__(self, path: Path | None, io, home: Path | None = None):
        self.path = path
        self.io = io
        self.home = home or (path.parent / "teams" if path else None)
        self.teams: dict[str, dict] = {}
        if path and path.exists():
            try:
                loaded = json.loads(path.read_text()).get("teams", {})
                # Only teams of this shape: one made before the graph has no graph to run.
                self.teams = {k: v for k, v in loaded.items() if isinstance(v.get("graph"), dict)}
            except (OSError, ValueError):
                self.teams = {}

    def save(self) -> None:
        if not self.path:
            return
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"teams": self.teams}, indent=1))
        os.replace(tmp, self.path)

    # ------------------------------------------------------------- making one

    def create(self, *, name: str, goal: str, folder: str, graph: dict, template: str = "custom",
               gate: str = "ask", max_rounds: int = 10, ws: int | None = None) -> dict:
        """`graph`: nodes already carrying their `session` (agents and checks), `folder`, `command`."""
        graph = check_graph(deepcopy(graph))
        if gate not in GATES:
            raise ValueError(f"gate is one of {', '.join(GATES)}")
        if not goal.strip():
            raise ValueError("a team needs a goal")
        for n in graph["nodes"]:
            if n["kind"] == "agent" and not n.get("session"):
                raise ValueError(f"{n['id']}: no agent")
            if n["kind"] == "check" and not (n.get("command") or "").strip():
                raise ValueError(f"{n['id']}: a check needs its command")
        team_id = secrets.token_hex(4)
        now = self.io.now()
        team = {
            "id": team_id, "name": name or "team", "goal": goal.strip(), "template": template, "folder": folder,
            "graph": graph, "ws": ws, "gate": gate, "max_rounds": max(1, min(MAX_ROUNDS, int(max_rounds))),
            "round": 1, "status": "running", "phase": "working", "log": str(Path(folder) / LOG_NAME),
            "seen": 0, "running": {}, "ran": [], "arrived": {}, "outcomes": {}, "fails": {}, "pending": [],
            "introduced": {}, "history": [], "started": now, "last_check": None,
        }
        flow = "; ".join(f"{e['from']} →{'' if e['when'] == 'always' else ' ' + e['when']} {e['to']}" for e in graph["edges"])
        Path(team["log"]).write_text(
            f"# Team: {team['name']}\n\nGoal: {team['goal']}\n\n"
            + "".join(f"- **{n['id']}**: {self._describe(n)}\n" for n in graph["nodes"] if n["kind"] != "end")
            + f"\nArrows: {flow}.\n\n"
            "Every turn is appended below, `@TURN who=… round=…` … `@END`. Argus writes the checks' "
            "results and its own decisions here too.\n"
            + turn_text("ARGUS", f"Start. Goal: {team['goal']}", round=1, status="START"))
        self.teams[team_id] = team
        self._note(team, f"started from {', '.join(graph['start'])}; gate {gate}, up to {team['max_rounds']} rounds")
        for nid in graph["start"]:
            self._start(team, nid)
        self.save()
        return team

    @staticmethod
    def _describe(n: dict) -> str:
        if n["kind"] == "agent":
            return f"{n.get('role', 'agent')}, in {n.get('session', '?')}" + (" (judges)" if n.get("judge") else "")
        if n["kind"] == "check":
            return f"check `{n.get('command', '')}`" + (f" on {n['of']}'s work" if n.get("of") else "")
        return "waits for every arrow into it"

    # ------------------------------------------------------------- what the person does

    def go(self, team_id: str) -> dict:
        """Continue: past a gate, after a pause, or once you have dealt with what it asked."""
        team = self.teams[team_id]
        if team["status"] in ("done", "stopped"):
            return team
        team.pop("paused", None)
        team["status"] = "running"
        team["phase"] = "working"
        self._note(team, "continued by you")
        pending, team["pending"] = team.get("pending", []), []
        for nid in dict.fromkeys(pending):
            if nid in team["running"]:
                # Still its turn — it had stopped without writing it: ask again.
                n = node(team["graph"], nid)
                if n["kind"] == "agent":
                    self.io.send(n["session"], prompt_for(team, nid))
                continue
            self._start(team, nid, gated=False)
        for state in team["running"].values():
            state["since"] = self.io.now()
            state["nudged"] = False
        self.save()
        return team

    def pause(self, team_id: str) -> dict:
        """The turns under way finish and are recorded; nothing new starts until `go`."""
        team = self.teams[team_id]
        if team["status"] == "running":
            team["paused"] = True
            team["status"] = "paused"
            self._note(team, "paused by you — the turns under way finish, nothing new starts")
            self.save()
        return team

    def stop(self, team_id: str, why: str = "stopped by you") -> dict:
        team = self.teams[team_id]
        if team["status"] not in ("done", "stopped"):
            self._finish(team, "stopped", why)
            self.save()
        return team

    def sessions_of(self, team_id: str) -> list[str]:
        """Every session the team has: its agents (started or not yet) and its checks."""
        team = self.teams[team_id]
        return [n["session"] for n in team["graph"]["nodes"] if n.get("session")]

    def forget(self, team_id: str) -> None:
        self.teams.pop(team_id, None)
        self.save()

    # ------------------------------------------------------------- the loop

    def tick(self) -> None:
        changed = False
        for team in list(self.teams.values()):
            if team["status"] in ("done", "stopped"):
                continue
            try:
                changed |= self._tick(team)
            except Exception as e:                    # one team's trouble is not every team's
                self._wait_for_you(team, f"error: {e}")
                changed = True
        if changed:
            self.save()

    def _tick(self, team: dict) -> bool:
        changed = False
        turns = None
        for nid in list(team["running"]):
            n = node(team["graph"], nid)
            if n["kind"] == "check":
                changed |= self._check_done(team, nid)
                continue
            if turns is None:
                turns = self._turns(team)
            state = team["running"].get(nid)
            if state is None:
                continue
            mine = [tt for tt in turns[state["seen"]:] if tt.done and tt.who == nid.upper()]
            if mine:
                turn = mine[-1]
                # A judge's verdict decides; anyone else's turn just goes on — except BLOCKED, which
                # anyone may say (a person must decide), and which used to be read as "always".
                outcome = (turn.status or "OK") if n.get("judge") else ("BLOCKED" if turn.status == "BLOCKED" else "always")
                self._note(team, f"{nid}: {first_line(turn.body)}" + (f" — {outcome}" if n.get("judge") else ""))
                self._finished(team, nid, outcome)
                changed = True
                continue
            # Not written yet. An agent that stopped without writing gets one reminder, then the person.
            st = self.io.state(n["session"])
            quiet = bool(st) and st[0] == "waiting"
            waited = self.io.now() - state["since"]
            if st and st[0] == "working":
                state["worked"] = True
            # An agent just started that has not begun working: its first prompt, given on its
            # command line, may be sitting in its box behind a question it asked first (a
            # permissions warning, a hooks review). Pressing Enter for it would be a key typed
            # blind into whatever is on screen — so the person is told where to look, once.
            if state.get("fresh") and not state.get("worked") and waited > START_GRACE and not state.get("told_start"):
                state["told_start"] = True
                self._note(team, f"{nid} has not started: its first prompt may be waiting for Enter in its window")
                self.io.ring("asking", f"Team {team['name']}: {nid} has not started — its prompt may be waiting "
                                       f"for Enter in {n['session']}", n["session"])
                changed = True
                continue
            if state.get("fresh") and not state.get("worked"):
                continue                                  # not reminded of a turn it never began
            if quiet and waited > NUDGE_AFTER and not state["nudged"]:
                state["nudged"] = True
                self.io.send(n["session"], f"You stopped without reporting your turn. "
                                           f"If you have finished, report it now.\n\n{how_to_answer(team, nid)}")
                self._note(team, f"{nid} stopped without writing its turn: reminded")
                changed = True
            elif quiet and waited > GIVE_UP_AFTER and team["phase"] == "working":
                self._wait_for_you(team, f"{nid} has stopped and has not written its turn", retry=[nid])
                changed = True
        return changed

    def _turns(self, team: dict) -> list[Turn]:
        try:
            return parse_turns(Path(team["log"]).read_text())
        except OSError:
            return []

    # ------------------------------------------------------------- moving along the graph

    def _start(self, team: dict, nid: str, gated: bool = True) -> None:
        """Begin a node — or, if this begins a new round, see whether the round may begin."""
        g = team["graph"]
        n = node(g, nid)
        if nid in team["running"]:
            return                                     # already at it
        if n["kind"] == "end":
            self._finish(team, "done", f"the goal is met (round {team['round']})")
            return
        if n["kind"] == "join":
            # Joins are reached, not started: _finished records the arrival.
            return
        if nid in team["ran"]:
            # Back to something already done this round: that is the next round.
            if team["round"] >= team["max_rounds"]:
                self._finish(team, "done", f"all {team['max_rounds']} rounds used")
                return
            team["round"] += 1
            team["ran"] = []
            team["arrived"] = {}
            self._note(team, f"round {team['round']} begins")
            if gated and team["gate"] == "ask":
                team["pending"].append(nid)
                if team["status"] != "waiting-you":
                    team["phase"] = "gate"
                    team["status"] = "waiting-you"
                    self._note(team, "waiting for you to continue")
                    self.io.ring("asking", f"Team {team['name']}: round {team['round'] - 1} done — continue?", self._bell_session(team))
                return
        if gated and (team.get("paused") or team["phase"] in ("gate", "waiting-you")):
            team["pending"].append(nid)
            if team.get("paused"):
                team["phase"] = "gate"
            return
        if n["kind"] == "check":
            self._start_check(team, nid)
            return
        team["running"][nid] = {"since": self.io.now(), "nudged": False, "seen": len(self._turns(team))}
        text = prompt_for(team, nid)
        # An agent starts when its turn first comes, with that first prompt on its command line
        # (io.launch): typed into a session still asking "trust this folder?", it was lost.
        if n.get("launch") and nid not in team.setdefault("launched", []):
            team["launched"].append(nid)
            team["running"][nid]["fresh"] = True      # just started: see START_GRACE in _tick
            self.io.launch(team, n, text)
        else:
            self.io.send(n["session"], text)
        team.setdefault("introduced", {})[nid] = True
        self._note(team, f"round {team['round']}: {nid}'s turn")

    def _finished(self, team: dict, nid: str, outcome: str) -> None:
        """A node is done with `outcome`: follow every arrow that says so."""
        team["running"].pop(nid, None)
        if nid not in team["ran"]:
            team["ran"].append(nid)
        team["outcomes"][nid] = outcome
        if team["status"] in ("done", "stopped"):
            return
        g = team["graph"]
        out = [e for e in g["edges"] if e["from"] == nid]
        if outcome == "BLOCKED" and not any(e["when"] == "BLOCKED" for e in out):
            # No arrow says where BLOCKED goes: a person decides. Continue then goes on as if it had
            # said OK (or REDO, or — from a step that does not judge — along its ordinary arrows).
            on = [e["to"] for e in out if e["when"] == "OK"] or [e["to"] for e in out if e["when"] == "REDO"] \
                or [e["to"] for e in out if e["when"] == "always"]
            self._wait_for_you(team, f"{nid} says a person must decide", retry=on)
            return
        if outcome == "DONE" and not any(e["when"] == "DONE" for e in out):
            # The goal is met, and nothing is drawn for DONE: the team ends — unless its arrows lead
            # into a join, where the other judges arriving there have their say too (Write's two
            # critics: it ends when both say DONE). Followed as "always" before, a DONE from a judge
            # whose only arrows were `always` never ended anything.
            if not out or not all(node(g, e["to"])["kind"] == "join" for e in out if e["when"] == "always"):
                self._finish(team, "done", f"the goal is met — {nid} says DONE (round {team['round']})")
                return
        # BLOCKED is not a turn completed: only its own arrows, never the ordinary ones.
        nexts = [e["to"] for e in out if e["when"] == "BLOCKED"] if outcome == "BLOCKED" \
            else [e["to"] for e in out if e["when"] in ("always", outcome)]
        if not nexts:
            if outcome == "DONE":
                self._finish(team, "done", f"the goal is met (round {team['round']})")
            elif not team["running"] and not team["pending"]:
                self._wait_for_you(team, f"{nid} ended with {outcome}, and no arrow says what comes next")
            return
        for to in dict.fromkeys(nexts):
            target = node(g, to)
            if target["kind"] == "join":
                arrived = set(team["arrived"].get(to, [])) | {nid}
                team["arrived"][to] = sorted(arrived)
                if arrived >= set(preds(g, to)):
                    team["arrived"][to] = []
                    if to not in team["ran"]:
                        team["ran"].append(to)
                    self._note(team, f"{to}: everything arrived")
                    # Every judge that came in said DONE: the goal is met.
                    judges = [p for p in preds(g, to) if node(g, p).get("judge")]
                    if judges and all(team["outcomes"].get(p) == "DONE" for p in judges):
                        self._finish(team, "done", f"the goal is met — {', '.join(judges)} say DONE (round {team['round']})")
                        return
                    self._finished(team, to, "always")
                continue
            self._start(team, to)
            if team["status"] in ("done", "stopped"):
                return

    def _start_check(self, team: dict, nid: str) -> None:
        n = node(team["graph"], nid)
        where = (self.home / team["id"]) if self.home else Path(team["folder"])
        where.mkdir(parents=True, exist_ok=True)
        log = where / f"{nid}-{team['round']}.log"
        exit_file = where / f"{nid}-{team['round']}.exit"
        for f in (log, exit_file):
            f.unlink(missing_ok=True)
        folder = (node(team["graph"], n["of"]).get("folder") if n.get("of") else None) or n.get("folder") or team["folder"]
        team["running"][nid] = {"since": self.io.now(), "nudged": False, "files": [str(log), str(exit_file)]}
        self.io.run_check(team, n["command"], folder, log, exit_file, n.get("session"))
        self._note(team, f"round {team['round']}: {nid} — {n['command']}")

    def _check_done(self, team: dict, nid: str) -> bool:
        state = team["running"][nid]
        log, exit_file = (Path(p) for p in state["files"])
        if not exit_file.exists() or not exit_file.read_text().strip():
            return False
        try:
            code = int(exit_file.read_text().split()[0])
        except ValueError:
            code = 1
        took = self.io.now() - state["since"]
        try:
            tail = log.read_text(errors="replace").splitlines()[-TAIL_LINES:]
        except OSError:
            tail = []
        status = "PASS" if code == 0 else "FAIL"
        n = node(team["graph"], nid)
        team["last_check"] = {"node": nid, "status": status, "code": code, "seconds": round(took, 1), "round": team["round"]}
        team["fails"][nid] = 0 if status == "PASS" else team["fails"].get(nid, 0) + 1
        with open(team["log"], "a") as f:
            f.write(turn_text(nid, f"`{n['command']}` exited {code} after {took:.1f}s\n\n```\n"
                                   + "\n".join(tail) + "\n```", round=team["round"], status=status))
        self._note(team, f"{nid}: {status} (exit {code}, {took:.1f}s)")
        # "Go on, stop if something goes wrong" stops at the second failure in a row; "go on until
        # the goal" keeps trying — the rounds are its limit (the two used to be the same).
        if status == "FAIL" and team["gate"] == "auto" and team["fails"][nid] >= 2:
            team["running"].pop(nid, None)
            team["outcomes"][nid] = status
            if nid not in team["ran"]:
                team["ran"].append(nid)
            # Continue tries again: whatever a failure leads to.
            self._wait_for_you(team, f"{nid} failed twice in a row",
                               retry=[e["to"] for e in team["graph"]["edges"] if e["from"] == nid and e["when"] == "FAIL"])
            return True
        self._finished(team, nid, status)
        return True

    def _bell_session(self, team: dict):
        return next((n.get("session") for n in team["graph"]["nodes"] if n["kind"] == "agent"), None)

    def _wait_for_you(self, team: dict, why: str, retry=()) -> None:
        """Stop and ring. `retry`: what Continue starts again."""
        team["pending"] = list(dict.fromkeys([*team.get("pending", []), *retry]))
        team["phase"] = "waiting-you"
        team["status"] = "waiting-you"
        self._note(team, f"waiting for you: {why}")
        self.io.ring("asking", f"Team {team['name']}: {why}", self._bell_session(team))

    def _finish(self, team: dict, status: str, why: str) -> None:
        if team["status"] in ("done", "stopped"):
            return
        team["status"] = status
        team["phase"] = status
        team["pending"] = []
        with open(team["log"], "a") as f:
            f.write(turn_text("ARGUS", why, round=team["round"], status="STOP"))
        self._note(team, why)
        self.io.ring("done" if status == "done" else "note", f"Team {team['name']}: {why}", self._bell_session(team))

    def _note(self, team: dict, what: str) -> None:
        team["history"] = (team.get("history") or [])[-199:] + [{"at": self.io.now(), "what": what[:300]}]

    # ------------------------------------------------------------- the agent's side (v2)

    LIVE = ("running", "paused", "waiting-you")

    def by_session(self, session: str):
        """(team, node) whose agent runs in this tmux session, among the teams still going."""
        for team in self.teams.values():
            if team["status"] not in self.LIVE:
                continue
            for n in team["graph"]["nodes"]:
                if n.get("session") == session and n["kind"] == "agent":
                    return team, n
        return None, None

    def _reported(self, team: dict, nid: str) -> bool:
        state = team["running"].get(nid)
        if not state:
            return False
        return any(t.done and t.who == nid.upper() for t in self._turns(team)[state["seen"]:])

    def task(self, session: str) -> dict:
        """What `team_task` answers: this agent's task, in full, structured — the same facts its
        prompt carried, plus what the others and the checks said since."""
        team, n = self.by_session(session)
        if not team:
            return {"none": True, "why": f"no team has an agent in the session {session!r}"}
        nid = n["id"]
        g = team["graph"]
        turns = self._turns(team)
        latest = {}
        for t in turns:
            if t.done:
                latest[t.who] = {"who": t.who.lower(), "round": t.fields.get("round"), "status": t.status or None, "text": t.body}
        before = preds(g, nid)
        return {
            "team": team["name"], "goal": team["goal"], "you": nid, "role": n.get("role"),
            "judge": bool(n.get("judge")), "duty": n.get("duty") or DUTIES.get(n.get("role", ""), ""),
            "your_turn": nid in team["running"] and not self._reported(team, nid),
            "round": team["round"], "max_rounds": team["max_rounds"],
            "folder": n.get("folder") or team["folder"], "log": team["log"],
            "before_you": [latest[p.upper()] for p in before if p.upper() in latest],
            "others": [latest[k] for k in latest if k != nid.upper() and k.lower() not in before],
            "reads": {r: node(g, r).get("folder") for r in n.get("reads") or [] if node(g, r).get("folder")},
            "last_check": team.get("last_check"),
            "statuses": ["OK", "REDO", "DONE", "BLOCKED"] if n.get("judge") else [],
            "finish": "call team_done with a short summary" + (" and a status" if n.get("judge") else ""),
        }

    def done(self, session: str, summary: str, status: str = "", details: str = "") -> dict:
        """What `team_done` does: check the report, then write it into the log as the canonical
        turn — so the director reads it exactly as it reads one an agent appended by hand."""
        team, n = self.by_session(session)
        if not team:
            raise ValueError(f"no team has an agent in the session {session!r}")
        nid = n["id"]
        if nid not in team["running"]:
            raise ValueError(f"it is not {nid}'s turn in {team['name']}: Argus gives it the turn when it comes")
        if self._reported(team, nid):
            raise ValueError(f"{nid} has already reported this turn — wait for the next one")
        status = (status or "").strip().upper()
        if n.get("judge"):
            if status not in ("OK", "REDO", "DONE", "BLOCKED"):
                raise ValueError(f"{nid} judges: say status OK, REDO, DONE or BLOCKED")
        elif status not in ("", "BLOCKED"):
            raise ValueError(f"{nid} does not judge: leave the status out (or BLOCKED if a person must decide)")
        text = "\n\n".join(x.strip() for x in (summary, details) if x and x.strip())
        if not text:
            raise ValueError("say what you did, in a few lines")
        # A line of the agent's own that looks like a marker would cut the turn short.
        text = "\n".join((" " + line) if line.startswith(("@TURN", "@END")) else line for line in text.splitlines())
        fields = {"round": team["round"], **({"status": status} if status else {})}
        with open(team["log"], "a") as f:
            f.write(turn_text(nid, text, **fields))
        state = team["running"][nid]
        state["reported"] = True
        self._note(team, f"{nid} reported its turn" + (f" — {status}" if status else ""))
        self.save()
        return {"recorded": True, "team": team["name"], "you": nid, "round": team["round"], "status": status or None}

    def expecting(self, session: str, blocked_already: bool = False) -> dict:
        """For the plugin's Stop guard: is this agent stopping in the middle of a turn it has not
        reported? Said at most twice per turn — an agent that cannot report is not held for ever."""
        team, n = self.by_session(session)
        if not team or n["id"] not in team["running"] or self._reported(team, n["id"]):
            return {"expecting": False}
        state = team["running"][n["id"]]
        if state.get("held", 0) >= 2:
            return {"expecting": False}
        state["held"] = state.get("held", 0) + 1
        judge = " with status OK, REDO, DONE or BLOCKED" if n.get("judge") else ""
        return {"expecting": True, "team": team["name"], "you": n["id"],
                "reason": (f"You are {n['id']} in the Argus team {team['name']} and have not reported this turn. "
                           f"If your work for this turn is done, call the tool team_done{judge} with a short summary "
                           f"(or run: argus-say turn \"<summary>\"). If you cannot go on, report with status BLOCKED "
                           f"and say why. Then stop.")}

    def public(self) -> list[dict]:
        out = []
        for team in self.teams.values():
            g = team["graph"]
            nodes = []
            for n in g["nodes"]:
                state = ("running" if n["id"] in team["running"] else "waiting" if n["id"] in team.get("pending", [])
                         else "ran" if n["id"] in team["ran"] else "idle")
                nodes.append({k: n.get(k) for k in ("id", "kind", "role", "session", "command", "judge", "of", "folder")}
                             | {"state": state, "outcome": team["outcomes"].get(n["id"])})
            out.append({k: team.get(k) for k in ("id", "name", "goal", "template", "folder", "ws", "gate", "round",
                                                 "max_rounds", "phase", "status", "log", "last_check", "started")}
                       | {"nodes": nodes, "edges": g["edges"], "start": g["start"],
                          "history": team.get("history", [])[-30:]})
        return out


def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:160]
    return "(no words)"


# --------------------------------------------------------------------------- what a folder suggests

# --------------------------------------------------------------------------- a team as YAML

TEAM_FILES = ("team.yaml", "team.yml", ".argus/team.yaml")
ARROW = re.compile(r"^\s*(?P<src>[^>]+?)\s*->\s*(?P<dst>.+?)(?:\s+if\s+(?P<when>.+))?\s*$")


def from_yaml(text: str) -> dict:
    """A team written as YAML — what a person or an agent can keep in the project, under git —
    turned into the graph the director runs. `{name, graph, gate?, rounds?, goal?}`; ValueError
    in words, with the line, when it cannot be read.

        name: Fix it
        steps:
          fixer: {role: executor, worktree: true}
          tests: {check: pytest -q, of: fixer}
        flow:
          - fixer -> tests
          - tests -> done if PASS
          - tests -> fixer if FAIL

    A step is an agent unless it says `check: <command>` or `join: true`. `done` (or `end`) is the
    end, made for you. An arrow is `a -> b`, `a -> b, c` for parallel, `if PASS` or `if OK, REDO`
    for conditions. `start:` defaults to the first step.
    """
    import yaml
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        raise ValueError(f"not readable YAML{f' at line {mark.line + 1}' if mark else ''}: "
                         f"{getattr(e, 'problem', None) or e}") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("steps"), dict) or not doc["steps"]:
        raise ValueError("a team file needs `steps:` — each step a name, with its role or its check")
    nodes = []
    # `done:` among the steps keeps an end nothing points at yet (the Write template has one).
    has_end = any(str(k) in ("done", "end") for k in doc["steps"])
    for nid, spec in doc["steps"].items():
        nid = str(nid)
        spec = spec if isinstance(spec, dict) else {}
        if nid in ("done", "end"):
            continue
        if "check" in spec:
            node = {"id": nid, "kind": "check"}
            if spec["check"] not in (None, True, ""):
                node["command"] = str(spec["check"])
            if spec.get("of"):
                node["of"] = str(spec["of"])
        elif spec.get("join"):
            node = {"id": nid, "kind": "join"}
        else:
            node = {"id": nid, "kind": "agent", "role": str(spec.get("role") or "executor")}
            for key in ("duty",):
                if spec.get(key):
                    node[key] = str(spec[key])
            if spec.get("judge"):
                node["judge"] = True
            if spec.get("worktree"):
                node["worktree"] = True
            if spec.get("reads"):
                node["reads"] = [str(x) for x in (spec["reads"] if isinstance(spec["reads"], list) else [spec["reads"]])]
        nodes.append(node)
    edges = []
    flow = doc.get("flow") or []
    if not isinstance(flow, list):
        raise ValueError("`flow:` is a list of arrows, one per line: - a -> b if PASS")
    for i, line in enumerate(flow, 1):
        m = ARROW.match(str(line))
        if not m:
            raise ValueError(f"flow line {i} is not an arrow: {line!r} — write it as  a -> b  or  a -> b if PASS")
        whens = [w.strip().upper() for w in (m["when"] or "always").split(",")]
        for dst in (d.strip() for d in m["dst"].split(",")):
            if dst in ("done", "end"):
                dst, has_end = "end", True
            for when in whens:
                edges.append({"from": m["src"].strip(), "to": dst, "when": "always" if when == "ALWAYS" else when})
    if has_end:
        nodes.append({"id": "end", "kind": "end"})
    start = doc.get("start") or [nodes[0]["id"]]
    graph = {"nodes": nodes, "edges": edges, "start": [str(s) for s in (start if isinstance(start, list) else [start])]}
    check_graph(graph)
    out = {"name": str(doc.get("name") or "team.yaml")[:60], "graph": graph}
    if doc.get("goal"):
        out["goal"] = str(doc["goal"])
    if doc.get("gate") in GATES:
        out["gate"] = doc["gate"]
    if doc.get("permissions") in ("ask", "edit", "everything"):
        out["permissions"] = doc["permissions"]
    if isinstance(doc.get("rounds"), int):
        out["rounds"] = max(1, min(MAX_ROUNDS, doc["rounds"]))
    return out


def to_yaml(graph: dict, name: str = "") -> str:
    """The other way: a graph written as a team file a person can read and edit."""
    import yaml
    steps = {}
    for n in graph.get("nodes", []):
        if n["kind"] == "end":
            continue
        if n["kind"] == "check":
            spec = {"check": n.get("command") or True}
            if n.get("of"):
                spec["of"] = n["of"]
        elif n["kind"] == "join":
            spec = {"join": True}
        else:
            spec = {"role": n.get("role") or "executor"}
            for key in ("judge", "worktree", "reads", "duty"):
                if n.get(key):
                    spec[key] = n[key]
        steps[n["id"]] = spec
    if any(n["kind"] == "end" for n in graph.get("nodes", [])) and not any(e["to"] == "end" for e in graph.get("edges", [])):
        steps["done"] = {}
    grouped: dict[tuple, list[str]] = {}
    for e in graph.get("edges", []):
        grouped.setdefault((e["from"], "done" if e["to"] == "end" else e["to"]), []).append(e["when"])
    flow = [f"{a} -> {b}" + ("" if whens == ["always"] else " if " + ", ".join(whens)) for (a, b), whens in grouped.items()]
    doc = {"name": name or "my team", **({"goal": graph["goal"]} if graph.get("goal") else {}),
           **({"permissions": graph["permissions"]} if graph.get("permissions") else {}), "steps": steps, "flow": flow}
    first = next((n["id"] for n in graph.get("nodes", []) if n["kind"] != "end"), None)
    if graph.get("start") and graph["start"] != [first]:
        doc["start"] = graph["start"]
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100)


def team_file(folder: str) -> dict | None:
    """The team a project keeps for itself (`team.yaml`), read — or None, or `{error}`."""
    for rel in TEAM_FILES:
        path = Path(folder) / rel
        if path.is_file() and path.stat().st_size < 200_000:
            try:
                said = from_yaml(path.read_text(encoding="utf-8", errors="replace"))
            except ValueError as e:
                return {"file": str(path), "error": str(e)}
            return {"file": str(path), **said}
    return None


PROPOSED = "# proposed by "


def propose(folder: Path, text: str, by: str = "") -> dict:
    """An agent's team, written into the project as `team.yaml` for the person to start.

    Never started from here: a team writes files and runs a command, which is the person's
    decision. What an agent may do is put the team where the Team sheet finds it — the folder's
    `team.yaml`, offered as a card the moment that folder is chosen — and ring. A `team.yaml`
    the person wrote is not overwritten (one an agent proposed is: that is "here is version 2").
    `{file, name, format, summary, graph}`; ValueError when the text is not a team, or the file
    is someone else's."""
    from .teammermaid import describe, read_team
    said = read_team(text)
    path = Path(folder) / "team.yaml"
    # A team the person keeps under another name (team.yml, .argus/team.yaml) would be shadowed by a
    # team.yaml written beside it — Team reads team.yaml first.
    for other in TEAM_FILES[1:]:
        if (Path(folder) / other).exists():
            raise ValueError(f"{Path(folder) / other} is the person's team for this folder: a team.yaml beside it "
                             f"would hide it — ask them, or propose it in another folder")
    if path.exists():
        head = path.read_text(encoding="utf-8", errors="replace")[:200]
        if not head.startswith(PROPOSED):
            raise ValueError(f"{path} is already there and was not proposed by an agent: it is the person's — "
                             f"ask them, or propose it in another folder")
    if said["format"] == "yaml":
        body = text.strip() + "\n"
    else:
        graph = dict(said["graph"])
        body = to_yaml(graph, said["name"])
        for key in ("gate", "rounds"):
            if said.get(key):
                body += f"{key}: {said[key]}\n"
    who = by or "an agent"
    path.write_text(f"{PROPOSED}{who} through Argus — start it from Team, or edit it; delete this line to make it yours\n"
                    + body, encoding="utf-8")
    return {"file": str(path), "name": said["name"], "format": said["format"], "summary": describe(said),
            "graph": said["graph"]}


class Proposals:
    """The teams agents have proposed and nobody has taken up yet, wherever they are.

    A proposal is a file in a folder, and Team only reads a folder's team.yaml when that folder is
    typed into it — so a bell missed (a toast lasts six seconds) left the team nowhere to be found
    (2026-10-07, on a real machine: "I had an agent make a team and put it in Argus — nothing").
    Kept here until it is started, dismissed, or its file is gone or no longer a proposal; shown as
    a card in Team and a line over the desk. Beside the config (`proposals.json`) when there is one.
    """

    def __init__(self, path: Path | None = None):
        self.path = path
        self.items: list[dict] = []
        if path and path.exists():
            try:
                self.items = [x for x in json.loads(path.read_text()).get("proposals", []) if isinstance(x, dict)]
            except (OSError, ValueError):
                self.items = []

    def _save(self) -> None:
        if self.path:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"proposals": self.items}, indent=1))
            tmp.replace(self.path)

    def add(self, folder: str, said: dict, by: str, now: float) -> None:
        self.items = [x for x in self.items if x["folder"] != folder]
        self.items.append({"folder": folder, "file": said["file"], "name": said["name"], "by": by,
                           "at": now, "summary": said.get("summary", "")})
        self.items = self.items[-20:]
        self._save()

    def drop(self, folder: str) -> bool:
        before = len(self.items)
        self.items = [x for x in self.items if x["folder"] != folder]
        if len(self.items) != before:
            self._save()
        return len(self.items) != before

    def live(self) -> list[dict]:
        """The proposals still standing, each with its team read from the file — newest first. One
        whose file is gone, or no longer starts with the proposal line (made the person's own, or
        replaced), is dropped."""
        out, keep = [], []
        for x in self.items:
            try:
                text = Path(x["file"]).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if not text.startswith(PROPOSED):
                continue
            keep.append(x)
            try:
                team = from_yaml(text)
            except ValueError as e:
                out.append({**x, "error": str(e)})
                continue
            out.append({**x, **{k: v for k, v in team.items() if k != "name"}, "name": team.get("name") or x["name"]})
        if len(keep) != len(self.items):
            self.items = keep
            self._save()
        return sorted(out, key=lambda x: -x["at"])


# --------------------------------------------------------------------------- packs

PACK_MARK = "argus_team_pack"
ROLE_NAME = re.compile(r"[a-z0-9][a-z0-9 -]{0,29}")


def read_pack(doc) -> dict:
    """A team pack — roles and models in one JSON file, to share or to download — checked
    before any of it is taken in.

    `{"argus_team_pack": 1, "name", "description", "roles": {name: {duty, judge}}, "models":
    {name: graph}}`. Nothing in a pack is a default: it is imported by a person, into their
    own preferences, and can be removed like anything they made themselves. Each role and model
    is judged on its own, so one broken model does not lose the rest; what is refused comes
    back with the reason. ValueError only when the file is not a pack at all.
    """
    if isinstance(doc, dict) and isinstance(doc.get("text"), str) and PACK_MARK not in doc:
        # A pack sent as the text of its file, which is how a YAML one arrives.
        if re.match(r"\s*(<!doctype html|<html)", doc["text"], re.I):
            raise ValueError("this is a web page, not a pack — on GitHub, open the file and use Raw "
                             "(or Download raw file); or pick one of the examples in the sheet")
        import yaml
        try:
            doc = yaml.safe_load(doc["text"])
        except yaml.YAMLError as e:
            raise ValueError(f"not readable as JSON or YAML: {e}") from None
    if not isinstance(doc, dict) or doc.get(PACK_MARK) != 1:
        raise ValueError(f"not an Argus team pack: it needs \"{PACK_MARK}\": 1")
    out = {"name": str(doc.get("name") or "a team pack")[:60],
           "description": str(doc.get("description") or "")[:500],
           "roles": {}, "models": {}, "refused": []}
    roles, models = doc.get("roles") or {}, doc.get("models") or {}
    if not isinstance(roles, dict) or not isinstance(models, dict):
        raise ValueError("roles and models are each an object, name -> what it is")
    for raw, role in list(roles.items())[:50]:
        name = " ".join(str(raw).lower().split())
        if not ROLE_NAME.fullmatch(name):
            out["refused"].append({"what": f"role {raw}", "why": "a role's name is letters, digits, spaces and dashes, at most 30"})
            continue
        duty = role.get("duty") if isinstance(role, dict) else None
        if not isinstance(duty, str) or not duty.strip() or len(duty) > 4000:
            out["refused"].append({"what": f"role {name}", "why": "a role needs a duty, at most 4000 characters"})
            continue
        out["roles"][name] = {"duty": duty.strip(), "judge": bool(role.get("judge"))}
    for raw, graph in list(models.items())[:30]:
        name = " ".join(str(raw).split())[:60]
        try:
            if not isinstance(graph, dict):
                raise ValueError("a model is a graph: nodes, edges, start")
            g = json.loads(json.dumps(graph))
            if "goal" in g and not (isinstance(g["goal"], str) and len(g["goal"]) <= 2000):
                raise ValueError("a model's goal is a sentence, at most 2000 characters")
            # What the agents may do without asking, suggested: ask · edit · everything. Only a
            # suggestion — the sheet shows it, warns about everything, and the person starts it.
            if "permissions" in g and g["permissions"] not in ("ask", "edit", "everything"):
                raise ValueError("a model's permissions are ask, edit or everything")
            for n in g.get("nodes") or []:
                for key in ("session", "folder", "state", "outcome"):
                    n.pop(key, None)
            check_graph(g)
        except (ValueError, TypeError, KeyError) as e:
            out["refused"].append({"what": f"model {name}", "why": str(e)})
            continue
        out["models"][name] = g
    return out


EXAMPLES = Path(__file__).resolve().parent.parent / "examples" / "team-packs"


def example_packs() -> list[dict]:
    """The packs shipped in examples/team-packs/, offered in the sheet to take in with a press —
    still a choice, never a default — so nobody has to find a raw file on GitHub."""
    out = []
    for path in sorted(EXAMPLES.glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": path.stem, "name": str(doc.get("name") or path.stem),
                    "description": str(doc.get("description") or ""), "pack": doc})
    return out


def suggest_check(folder: str) -> list[str]:
    """Commands a folder suggests as its check, most likely first. Looked for, never run."""
    p = Path(folder)
    out: list[str] = []
    if (p / "Cargo.toml").exists():
        out.append("cargo test --release")
        for script in ("benchmarks/run_benchmarks.sh", "bench.sh", "benchmark.sh"):
            if (p / script).exists():
                out.append(f"cargo test --release && ./{script} --quick" if "run_benchmarks" in script else f"cargo test --release && ./{script}")
    if (p / "pyproject.toml").exists() or (p / "pytest.ini").exists() or (p / "tests").is_dir() and any((p / "tests").glob("test_*.py")):
        out.append("python3 -m pytest -q")
    if (p / "package.json").exists():
        try:
            if "test" in json.loads((p / "package.json").read_text()).get("scripts", {}):
                out.append("npm test")
        except (OSError, ValueError):
            pass
    if (p / "Makefile").exists():
        try:
            if re.search(r"^test:", (p / "Makefile").read_text(), re.M):
                out.append("make test")
        except OSError:
            pass
    if (p / "main.nf").exists():
        out.append("nextflow run main.nf -profile test")
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def suggest_template(goal: str) -> str:
    g = (goal or "").lower()
    if re.search(r"two ideas|in parallel|tournament|compare|confront|due idee|in parallelo|torneo", g):
        return "tournament"
    if re.search(r"split|divide|together|both work|share the work|dividet|dividi|insieme|a metà", g):
        return "split"
    if re.search(r"fast|faster|speed|slow|optimi|perform|ottimizz|veloc|lent|memor|throughput|latenc", g):
        return "optimise"
    if re.search(r"\bbug|fix|crash|error|broken|fails?\b|errore|sistema|correggi|rotto", g):
        return "fix"
    if re.search(r"feature|add |implement|aggiungi|implementa|nuova funzion", g):
        return "feature"
    if re.search(r"paper|report|write|draft|article|scriv|bozza|articolo|relazione|document", g):
        return "write"
    return "review"
