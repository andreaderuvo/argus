"""A team's turns as a conversation, each agent's turn with what it changed in the folder.

"Copy only the best" of a product that shows a team as a chat with diffs as cards (2026-11-04). The
log already holds every turn, verdict and check; what was missing is what each turn *changed*. The
director takes a picture of the folder when an agent's turn starts and when it ends (app/turndiff.py,
through a temporary index — the repository is never touched) and the Chat compares the two.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app import turndiff
from app.main import teams_chat_of
from app.teams import TEMPLATES, Director, fill_graph, turn_text

pytestmark = pytest.mark.skipif(not shutil.which("git"), reason="needs git")


class IO:
    def __init__(self):
        self.sent, self.checks, self.rings, self.clock = [], {}, [], 1000.0

    def send(self, session, text):
        self.sent.append((session, text))

    def launch(self, team, n, prompt):
        self.sent.append((n["session"], prompt))

    def state(self, session):
        return None

    def run_check(self, team, command, folder, log, exit_file, session=None):
        self.checks[session] = (Path(log), Path(exit_file))

    def ring(self, why, text, session):
        self.rings.append((why, text))

    def now(self):
        return self.clock

    def snapshot(self, folder):
        return turndiff.snapshot(folder)


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "site"
    r.mkdir()
    git(r, "init", "-q")
    (r / "pricing.ts").write_text('export const TIERS = [{ name: "Solo", price: 12 }]\n')
    git(r, "add", ".")
    git(r, "commit", "-qm", "start")
    return r


def say(team, who, body, **fields):
    with open(team["log"], "a") as f:
        f.write(turn_text(who, body, round=team["round"], **fields))


def test_each_turn_is_a_message_and_an_agent_turn_carries_its_changes(tmp_path, repo):
    io = IO()
    d = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    graph = fill_graph(TEMPLATES["optimise"]["graph"], "t", {}, default_check="true")
    for n in graph["nodes"]:
        n.pop("worktree", None)
    team = d.create(name="t", goal="two tiers", folder=str(repo), graph=graph, template="optimise", gate="goal", max_rounds=3)

    # The executor's turn: a file changed, a file made — and an untracked data file too big to count.
    (repo / "pricing.ts").write_text('export const TIERS = [\n  { name: "Solo", price: 12 },\n  { name: "Team", price: 29 },\n]\n')
    (repo / "Tier.tsx").write_text("export function Tier() {}\n")
    (repo / "reads.fastq").write_bytes(b"@" * (turndiff.BIG + 10))
    say(team, "EXECUTOR", "Pricing has two tiers now.")
    d.tick()
    log, exit_file = io.checks["t-check"]
    log.write_text("9 passed\n")
    exit_file.write_text("0\n")
    d.tick()
    say(team, "REVIEWER", "Approved, no new packages.", status="DONE")
    d.tick()

    chat = teams_chat_of(team)
    who = [(x["who"], x["kind"], x["status"]) for x in chat["turns"]]
    assert who == [("argus", "argus", "START"), ("executor", "agent", None), ("check", "check", "PASS"),
                   ("reviewer", "agent", "DONE"), ("argus", "argus", "STOP")], who
    executor = chat["turns"][1]
    assert executor["at"] and executor["text"] == "Pricing has two tiers now."
    files = {f["path"]: f for f in executor["changes"]["files"]}
    assert set(files) == {"pricing.ts", "Tier.tsx"}, "the big untracked file is data, not the change"
    assert files["Tier.tsx"]["status"] == "new" and files["pricing.ts"]["added"] == 4
    assert chat["turns"][3]["judge"] and chat["turns"][3]["changes"] == {"files": [], "more": 0, "added": 0, "removed": 0}

    # The diff itself, from the pictures; and the repository was never touched.
    pictures = teams_chat_of(team, pictures=True)
    patch = turndiff.patch(pictures[1]["before"], pictures[1]["after"], "pricing.ts")
    assert '+  { name: "Team", price: 29 },' in patch
    status = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True).stdout
    assert "?? Tier.tsx" in status and " M pricing.ts" in status, "nothing staged, nothing committed"


def test_a_folder_that_is_no_repository_has_turns_without_changes(tmp_path):
    io = IO()
    d = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    plain = tmp_path / "plain"
    plain.mkdir()
    graph = fill_graph(TEMPLATES["optimise"]["graph"], "t", {}, default_check="true")
    team = d.create(name="t", goal="g", folder=str(plain), graph=graph, template="optimise", gate="goal", max_rounds=3)
    say(team, "EXECUTOR", "done")
    d.tick()
    executor = teams_chat_of(team)["turns"][1]
    assert executor["who"] == "executor" and "changes" not in executor
    assert teams_chat_of(team)["working"] == [{"who": "check", "session": "t-check", "kind": "check"}]
