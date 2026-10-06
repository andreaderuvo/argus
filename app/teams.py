"""A team of agents working on one goal, directed by Argus — on the server, browser or not.

Two agents taught what holds up: the work goes through a file both can read (append-only turns,
`@TURN … @END`), nobody reads a screen, and "finished" is something an agent says. What it did
not have is somebody to keep it going with no tab open, and an answer that is not an agent's
opinion. This adds both.

**A team** is a goal, roles (an agent each, in its own session), a log file in the project
(`TEAM.argus.md`), a *flow* — the order the roles take their turns in — and, for work that has
a right answer, a **check**: a command (tests, a benchmark) that Argus runs between turns, in a
tmux session of the team's own that you can watch, and whose result goes in the log as a turn
like any other. A round is one pass through the flow; the team's judge (a reviewer, or the check
itself) ends it with a verdict, and that verdict — not a conversation — decides what comes next.

**The director** is a loop on the server. It sends a role its prompt (the same bracketed paste a
hand-off uses), waits for that role's turn to appear in the log, runs the check when the flow
says so, and moves on. How much it does alone is the person's choice: `ask` stops at the end of
every round for a press, `auto` goes on but stops at the first sign of trouble, `goal` goes on
until the judge says the goal is met or the rounds run out. It never decides anything a turn did
not say, and everything it does is written in the log.

Side effects go through `io`, so the state machine is tested without tmux (tests/test_teams.py).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

LOG_NAME = "TEAM.argus.md"
NUDGE_AFTER = 120          # s an agent may sit waiting without writing its turn before a reminder
GIVE_UP_AFTER = 300        # …and before the person is asked
TAIL_LINES = 25            # of a check's output, into the log
MAX_ROUNDS = 30
GATES = ("ask", "auto", "goal")

TEMPLATES: dict[str, dict] = {
    "optimise": {
        "label": "Optimise",
        "hint": "one changes, the check measures, one reviews — the numbers decide",
        "roles": ["executor", "reviewer"],
        "flow": ["executor", "check", "reviewer"],
        "check": True,
        "judge": "reviewer",
    },
    "fix": {
        "label": "Fix a bug",
        "hint": "one fixes, the check (the test that shows the bug) decides",
        "roles": ["executor"],
        "flow": ["executor", "check"],
        "check": True,
        "judge": "check",
    },
    "review": {
        "label": "Build and review",
        "hint": "one builds, one reviews",
        "roles": ["executor", "reviewer"],
        "flow": ["executor", "reviewer"],
        "check": False,
        "judge": "reviewer",
    },
    "write": {
        "label": "Write",
        "hint": "researcher, then writer, then critic",
        "roles": ["researcher", "writer", "critic"],
        "flow": ["researcher", "writer", "critic"],
        "check": False,
        "judge": "critic",
    },
}

DUTIES = {
    "executor": "You make the changes. One focused step per round: do it, make sure it builds, and say what you changed and why.",
    "reviewer": "You review. Read the executor's last turn, the check's result if there is one, and the change itself (git diff). You do not edit the code.",
    "researcher": "You gather what the work needs: sources, facts, numbers, with where each came from.",
    "writer": "You write, from the researcher's material and the critic's last remarks.",
    "critic": "You judge the writer's draft against the goal. You do not rewrite it.",
}
VERDICTS = "OK (keep it, and say the next step), REDO (say what is wrong), DONE (the goal is met), BLOCKED (a person must decide)"


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


# --------------------------------------------------------------------------- prompts

def how_to_answer(team: dict, role: str) -> str:
    log = team["log"]
    status = " status=<OK|REDO|DONE|BLOCKED>" if role == judge_of(team) else ""
    return (f"When you have finished this turn, append exactly one entry to {log} — with a heredoc, "
            f"so nothing in it is run by the shell:\n\n"
            f"cat >> {log} <<'ARGUS_TURN'\n@TURN who={role.upper()} round={team['round']}{status}\n"
            f"<what you did, in a few lines>\n@END\nARGUS_TURN\n\n"
            f"Then stop and wait: Argus gives the next turn to whoever has it. Do not wait for, or "
            f"answer, the other agents yourself.")


def prompt_for(team: dict, role: str) -> str:
    t = TEMPLATES[team["template"]]
    where = team["folders"].get(role) or team["folder"]
    first = team["round"] == 1 and role == t["flow"][0]
    parts = []
    if first or not team.get("introduced", {}).get(role):
        parts.append(f"You are the {role} in a team of agents directed by Argus. Goal: {team['goal']}")
        parts.append(f"Work in {where}. The team's log is {team['log']}: read it before you start; "
                     f"every turn, every check result and every verdict is there.")
        parts.append(DUTIES.get(role, ""))
        if role == judge_of(team):
            parts.append(f"You end each round with a verdict: {VERDICTS}.")
    else:
        parts.append(f"Round {team['round']}. Read the latest entries in {team['log']} and take your turn.")
    if role == "executor" and team.get("last_check") and team["last_check"].get("status") == "FAIL":
        parts.append("The last check FAILED — its output is in the log. Fix that first.")
    parts.append(how_to_answer(team, role))
    return "\n\n".join(p for p in parts if p)


def judge_of(team: dict) -> str:
    return TEMPLATES[team["template"]]["judge"]


# --------------------------------------------------------------------------- the director

class Director:
    """Every team, and the loop that moves them on. `io` does the outside world:

    - `send(session, text)`: type a prompt into a session and press Enter;
    - `state(session)`: `("working"|"waiting", since)` or None;
    - `run_check(team, command, folder, log_path, exit_path)`: start the check, not waiting for it;
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
                self.teams = json.loads(path.read_text()).get("teams", {})
            except (OSError, ValueError):
                self.teams = {}

    def save(self) -> None:
        if not self.path:
            return
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"teams": self.teams}, indent=1))
        os.replace(tmp, self.path)

    # ------------------------------------------------------------- making one

    def create(self, *, name: str, goal: str, template: str, folder: str, roles: dict[str, str],
               folders: dict[str, str] | None = None, check: str | None = None, gate: str = "ask",
               max_rounds: int = 10, ws: int | None = None) -> dict:
        """`roles`: role -> the tmux session that holds its agent (already started)."""
        if template not in TEMPLATES:
            raise ValueError(f"no template {template!r}")
        t = TEMPLATES[template]
        missing = [r for r in t["roles"] if r not in roles]
        if missing:
            raise ValueError(f"no agent for {', '.join(missing)}")
        if t["check"] and not (check or "").strip():
            raise ValueError(f"{t['label']} needs a check: the command whose result decides")
        if gate not in GATES:
            raise ValueError(f"gate is one of {', '.join(GATES)}")
        if not goal.strip():
            raise ValueError("a team needs a goal")
        team_id = secrets.token_hex(4)
        now = self.io.now()
        team = {
            "id": team_id, "name": name or t["label"], "goal": goal.strip(), "template": template,
            "folder": folder, "folders": dict(folders or {}), "roles": dict(roles), "ws": ws,
            "check": (check or "").strip() or None, "gate": gate,
            "max_rounds": max(1, min(MAX_ROUNDS, int(max_rounds))),
            "round": 1, "step": 0, "phase": "working", "status": "running",
            "log": str(Path(folder) / LOG_NAME), "seen": 0, "step_at": now, "nudged": False,
            "introduced": {}, "last_check": None, "fails": 0, "history": [], "started": now,
            "check_session": f"{name or 'team'}-check".replace(" ", "-")[:40] if t["check"] else None,
        }
        Path(team["log"]).write_text(
            f"# Team: {team['name']}\n\nGoal: {team['goal']}\n\n"
            f"Roles: {', '.join(f'{r} ({s})' for r, s in roles.items())}. Flow: {' → '.join(t['flow'])}."
            f"{' Check: `' + team['check'] + '`.' if team['check'] else ''}\n\n"
            "Every turn is appended below, `@TURN who=… round=…` … `@END`. Argus writes the checks' "
            "results and its own decisions here too.\n"
            + turn_text("ARGUS", f"Start. Goal: {team['goal']}", round=1, status="START"))
        self.teams[team_id] = team
        self._note(team, f"started: {' → '.join(t['flow'])}, gate {gate}, up to {team['max_rounds']} rounds")
        self._begin_step(team)
        self.save()
        return team

    # ------------------------------------------------------------- what the person does

    def go(self, team_id: str) -> dict:
        """Continue: past a gate, after a pause, or once you have dealt with what it asked."""
        team = self.teams[team_id]
        if team["status"] in ("done", "stopped"):
            return team
        was_paused = team.pop("paused", False)
        team["status"] = "running"
        if team["phase"] in ("gate", "waiting-you"):
            team["step_at"] = self.io.now()
            team["nudged"] = False
            self._note(team, "continued by you")
            self._begin_step(team)
        elif was_paused:
            self._note(team, "continued by you")
        self.save()
        return team

    def pause(self, team_id: str) -> dict:
        """The turn under way finishes and is recorded; nothing new starts until `go`."""
        team = self.teams[team_id]
        if team["status"] == "running":
            team["paused"] = True
            team["status"] = "paused"
            self._note(team, "paused by you — the current turn finishes, nothing new starts")
            self.save()
        return team

    def stop(self, team_id: str, why: str = "stopped by you") -> dict:
        team = self.teams[team_id]
        if team["status"] not in ("done", "stopped"):
            self._finish(team, "stopped", why)
            self.save()
        return team

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
                self._note(team, f"error: {e}")
                team["phase"] = "waiting-you"
                team["status"] = "waiting-you"
                changed = True
        if changed:
            self.save()

    def _tick(self, team: dict) -> bool:
        if team["phase"] == "checking":
            return self._check_done(team)
        if team["phase"] != "working":
            return False                               # at a gate, or waiting for the person
        role = self._flow(team)[team["step"]]
        turns = self._turns(team)
        mine = [tt for tt in turns[team["seen"]:] if tt.done and tt.who == role.upper()]
        if mine:
            team["seen"] = len(turns)
            turn = mine[-1]
            self._note(team, f"{role}: {first_line(turn.body)}"
                             + (f" — {turn.status}" if role == judge_of(team) and turn.status else ""))
            if role == judge_of(team):
                team["verdict"] = turn.status or "OK"
            self._advance(team)
            return True
        # Not written yet. An agent that has stopped without writing gets one reminder, then the person.
        st = self.io.state(team["roles"][role])
        quiet = bool(st) and st[0] == "waiting"
        waited = self.io.now() - team["step_at"]
        if quiet and waited > NUDGE_AFTER and not team["nudged"]:
            team["nudged"] = True
            self.io.send(team["roles"][role], f"You stopped without writing your turn in {team['log']}. "
                                              f"If you have finished, append it now:\n\n{how_to_answer(team, role)}")
            self._note(team, f"{role} stopped without writing its turn: reminded")
            return True
        if quiet and waited > GIVE_UP_AFTER:
            self._wait_for_you(team, f"{role} has stopped and has not written its turn")
            return True
        return False

    def _flow(self, team: dict) -> list[str]:
        return TEMPLATES[team["template"]]["flow"]

    def _turns(self, team: dict) -> list[Turn]:
        try:
            return parse_turns(Path(team["log"]).read_text())
        except OSError:
            return []

    def _begin_step(self, team: dict) -> None:
        step = self._flow(team)[team["step"]]
        team["step_at"] = self.io.now()
        team["nudged"] = False
        if step == "check":
            self._start_check(team)
            return
        session = team["roles"][step]
        self.io.send(session, prompt_for(team, step))
        team.setdefault("introduced", {})[step] = True
        team["phase"] = "working"
        self._note(team, f"round {team['round']}: {step}'s turn")

    def _start_check(self, team: dict) -> None:
        where = self.home / team["id"] if self.home else Path(team["folder"])
        where.mkdir(parents=True, exist_ok=True)
        log = where / f"check-{team['round']}.log"
        exit_file = where / f"check-{team['round']}.exit"
        for f in (log, exit_file):
            f.unlink(missing_ok=True)
        folder = team["folders"].get("executor") or team["folder"]
        team["check_files"] = [str(log), str(exit_file)]
        team["phase"] = "checking"
        self.io.run_check(team, team["check"], folder, log, exit_file)
        self._note(team, f"round {team['round']}: checking — {team['check']}")

    def _check_done(self, team: dict) -> bool:
        log, exit_file = (Path(p) for p in team["check_files"])
        if not exit_file.exists():
            return False
        try:
            code = int((exit_file.read_text().strip() or "1").split()[0])
        except ValueError:
            code = 1
        took = self.io.now() - team["step_at"]
        try:
            tail = log.read_text(errors="replace").splitlines()[-TAIL_LINES:]
        except OSError:
            tail = []
        status = "PASS" if code == 0 else "FAIL"
        team["last_check"] = {"status": status, "code": code, "seconds": round(took, 1), "round": team["round"]}
        team["fails"] = 0 if status == "PASS" else team["fails"] + 1
        with open(team["log"], "a") as f:
            f.write(turn_text("CHECK", f"`{team['check']}` exited {code} after {took:.1f}s\n\n```\n"
                                       + "\n".join(tail) + "\n```", round=team["round"], status=status))
        team["seen"] = len(self._turns(team))
        self._note(team, f"check: {status} (exit {code}, {took:.1f}s)")
        if TEMPLATES[team["template"]]["judge"] == "check":
            team["verdict"] = "DONE" if status == "PASS" else "REDO"
        elif status == "FAIL":
            # A failed check is not worth a review: back to the one who makes the changes.
            if team["gate"] in ("auto", "goal") and team["fails"] >= 2:
                self._wait_for_you(team, "the check failed twice in a row")
                return True
            team["verdict"] = "REDO"
            self._end_round(team)
            return True
        self._advance(team)
        return True

    def _advance(self, team: dict) -> None:
        team["step"] += 1
        if team["step"] >= len(self._flow(team)):
            self._end_round(team)
            return
        if team.get("paused"):
            team["phase"] = "gate"                     # the next step waits for `go`
            return
        self._begin_step(team)

    def _end_round(self, team: dict) -> None:
        verdict = team.pop("verdict", "OK")
        if verdict == "DONE":
            self._finish(team, "done", f"the goal is met (round {team['round']})")
            return
        if verdict == "BLOCKED":
            self._wait_for_you(team, "the team says a person must decide")
            return
        if team["round"] >= team["max_rounds"]:
            self._finish(team, "done", f"all {team['max_rounds']} rounds used")
            return
        team["round"] += 1
        team["step"] = 0
        self._note(team, f"round {team['round'] - 1} over: {verdict}")
        if team.get("paused"):
            team["phase"] = "gate"
            return
        if team["gate"] == "ask":
            team["phase"] = "gate"
            team["status"] = "waiting-you"
            self._note(team, "waiting for you to continue")
            self.io.ring("asking", f"Team {team['name']}: round {team['round'] - 1} done ({verdict}) — continue?",
                         team["roles"].get(self._flow(team)[0]))
            return
        self._begin_step(team)

    def _wait_for_you(self, team: dict, why: str) -> None:
        team["phase"] = "waiting-you"
        team["status"] = "waiting-you"
        self._note(team, f"waiting for you: {why}")
        self.io.ring("asking", f"Team {team['name']}: {why}", next(iter(team["roles"].values()), None))

    def _finish(self, team: dict, status: str, why: str) -> None:
        team["status"] = status
        team["phase"] = status
        with open(team["log"], "a") as f:
            f.write(turn_text("ARGUS", why, round=team["round"], status="STOP"))
        self._note(team, why)
        self.io.ring("done" if status == "done" else "note", f"Team {team['name']}: {why}",
                     next(iter(team["roles"].values()), None))

    def _note(self, team: dict, what: str) -> None:
        team["history"] = (team.get("history") or [])[-199:] + [{"at": self.io.now(), "what": what[:300]}]

    def public(self) -> list[dict]:
        out = []
        for team in self.teams.values():
            flow = self._flow(team)
            out.append({k: team[k] for k in ("id", "name", "goal", "template", "folder", "roles", "ws", "check",
                                             "gate", "round", "max_rounds", "phase", "status", "log",
                                             "last_check", "started")}
                       | {"flow": flow, "step_name": flow[team["step"]] if team["step"] < len(flow) else None,
                          "history": team.get("history", [])[-30:], "check_session": team.get("check_session")})
        return out


def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:160]
    return "(no words)"


# --------------------------------------------------------------------------- what a folder suggests

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
    if re.search(r"fast|faster|speed|slow|optimi|perform|ottimizz|veloc|lent|memor|throughput|latenc", g):
        return "optimise"
    if re.search(r"\bbug|fix|crash|error|broken|fails?\b|errore|sistema|correggi|rotto", g):
        return "fix"
    if re.search(r"paper|report|write|draft|article|scriv|bozza|articolo|relazione|document", g):
        return "write"
    return "review"
