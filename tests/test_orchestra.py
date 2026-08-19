"""The orchestration framework: the parts that decide what an agent is told.

None of this needs a server. What it needs is a fake Argus that writes down what it was asked
to do, because the interesting questions are all "what exactly did the agent receive" — the
contract appended to the prompt, the session it was told to ring with, the branch it was given,
the file it will be judged on. Those are the four things a hand-written orchestrator gets wrong,
and the whole reason the framework exists.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_orchestra import Group, Orchestra, Result, slug          # noqa: E402


class FakeArgus:
    """Everything an orchestra asks of Argus, remembered rather than done."""

    def __init__(self, sessions=()):
        self.sessions = [{"name": n} for n in sessions]
        self.launched: list[dict] = []
        self.worktrees: list[str] = []
        self.relayed: list[tuple[str, str]] = []

    def who(self):
        return {"machine": "somewhere", "sessions": self.sessions,
                "launchers": ["Claude Code", "A shell"]}

    def launch(self, launcher, name, where, prompt, run=False, desk=False):
        self.launched.append({"launcher": launcher, "name": name, "where": str(where),
                              "prompt": prompt, "run": run, "desk": desk})
        return {"name": name}

    def worktree(self, repo, branch):
        self.worktrees.append(branch)
        return {"path": f"{repo}-{branch.replace('/', '-')}", "branch": branch}

    def relay(self, to, text, run=False):
        self.relayed.append((to, text))
        return {"name": to}


@pytest.fixture
def fake():
    return FakeArgus()


def orchestra(fake, tmp_path, **kw):
    return Orchestra(tmp_path, launcher="A shell", argus=fake, **kw)


# ------------------------------------------------------------------ the contract


def test_the_prompt_gains_the_contract_naming_its_own_session(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    o.start("worker", say="Do the thing.", until="RESULT.md")
    said = fake.launched[0]["prompt"]
    assert "Do the thing." in said
    assert "write" in said and "RESULT.md" in said
    # The name in the contract is this session's, which is the thing a person copying a prompt
    # between agents always forgets to change.
    assert "argus-say ring --why done --session worker" in said


def test_no_contract_when_nothing_is_expected(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    o.start("worker", say="Just sit there.")
    assert "argus-say" not in fake.launched[0]["prompt"]


def test_a_worktree_is_told_to_stay_in_it(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    o.start("worker", say="Try it.", until="RESULT.md", worktree="try/thing")
    said = fake.launched[0]["prompt"]
    assert "Work only in" in said
    assert str(tmp_path) in said
    # And without one there is nothing to confine it to, so it is not claimed.
    o.start("other", say="Try it.")
    assert "Work only in" not in fake.launched[1]["prompt"]


# ------------------------------------------------------------------ names and branches


def test_the_prefix_reaches_the_name_the_branch_and_the_contract(fake, tmp_path):
    o = orchestra(fake, tmp_path, prefix="night")
    o.start("worker", say="Go.", until="RESULT.md", worktree="try/thing")
    assert fake.launched[0]["name"] == "night-worker"
    # On the last segment, so the namespace still means something.
    assert fake.worktrees == ["try/night-thing"]
    assert "--session night-worker" in fake.launched[0]["prompt"]


def test_a_name_already_running_stops_it_before_anything_starts(tmp_path):
    fake = FakeArgus(sessions=["judge", "an-index"])   # the *slug*, which is what a name is
    o = Orchestra(tmp_path, launcher="A shell", argus=fake)

    with pytest.raises(SystemExit) as stopped:
        o.start("judge", say="x")
    assert "already running" in str(stopped.value)

    # And a fan-out checks every name it is about to use before it uses any of them, which is
    # the case that matters: finding out on the second launch leaves the first agent running
    # with nothing to hand its work to.
    with pytest.raises(SystemExit):
        o.fan_out(["a cache", "an index"], say="x", until="R.md", wait=False)
    assert fake.launched == []


def test_a_launcher_this_machine_does_not_have_is_refused(tmp_path):
    with pytest.raises(SystemExit) as stopped:
        Orchestra(tmp_path, launcher="Nothing Like It", argus=FakeArgus())
    assert "not one of this machine's launchers" in str(stopped.value)


# ------------------------------------------------------------------ fanning out


def test_each_gets_its_own_name_branch_and_file(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    o.fan_out(["a cache", "an index"], say="Try {each}.",
              worktree="try/{each}", until="RESULT.md", wait=False)
    assert [x["name"] for x in fake.launched] == ["a-cache", "an-index"]
    assert fake.worktrees == ["try/a-cache", "try/an-index"]
    assert "Try a cache." in fake.launched[0]["prompt"]
    assert "Try an index." in fake.launched[1]["prompt"]
    # Each is told to write into *its own* checkout, not into the repository.
    assert fake.launched[0]["prompt"].count(str(tmp_path) + "-try-a-cache") >= 1


def test_a_dict_gives_the_short_name_and_the_long_one(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    o.fan_out({"methods": "whether the statistics hold"},
              say="You are reading it for {value}. You are one of {n}.",
              until="REVIEW-{each}.md", wait=False)
    assert fake.launched[0]["name"] == "methods"
    assert "reading it for whether the statistics hold" in fake.launched[0]["prompt"]
    assert "one of 1" in fake.launched[0]["prompt"]
    assert "REVIEW-methods.md" in fake.launched[0]["prompt"]


def test_a_dry_run_types_but_does_not_send(fake, tmp_path):
    o = orchestra(fake, tmp_path, run=False)
    o.fan_out(["one"], say="x", until="R.md")
    assert fake.launched[0]["run"] is False


def test_watching_asks_for_a_window(fake, tmp_path):
    o = orchestra(fake, tmp_path, watch=True)
    o.start("worker", say="x")
    assert fake.launched[0]["desk"] is True


# ------------------------------------------------------------------ what comes back


def test_a_group_offers_the_finished_ones_as_a_prompt_can_carry_them(fake, tmp_path):
    o = orchestra(fake, tmp_path)
    group = o.fan_out(["a cache", "an index"], say="x", until="R.md", wait=False)
    (tmp_path / "R.md").write_text("done", encoding="utf-8")
    for agent in group:
        agent.done = agent.arrived()
    # Only the one that wrote something is offered, and it is offered under the words the
    # person used rather than under a slug.
    listed = group.files
    assert "- a cache:" in listed
    assert len(group.done) + len(group.lost) == 2


def test_a_result_answers_the_two_questions_asked_of_it(tmp_path):
    p = tmp_path / "FAILURES.md"
    p.write_text("1. backend: it 500s\n2. frontend: no pagination\n3. nobody claimed this\n",
                 encoding="utf-8")
    said = Result(p)
    assert said
    assert not said.says("ALL GREEN")
    whose = said.split_by("backend:", "frontend:")
    assert len(whose["backend:"]) == 1
    assert len(whose["frontend:"]) == 1
    # Unattributed lines are kept rather than dropped: a bug nobody owns is still a bug.
    assert len(whose[""]) == 1


def test_green_is_recognised_however_it_is_written(tmp_path):
    p = tmp_path / "F.md"
    p.write_text("all green\n", encoding="utf-8")
    assert Result(p).says("ALL GREEN")


# ------------------------------------------------------------------ telling


def test_telling_reaches_the_prefixed_name(fake, tmp_path):
    o = orchestra(fake, tmp_path, prefix="night")
    agent = o.start("frontend", say="x")
    o.tell(agent, "the contract is written")
    o.tell("backend", "yours now")
    # Both forms land on the prefixed session, because a name is an address: `frontend` in
    # another run is somebody else's agent.
    assert fake.relayed == [("night-frontend", "the contract is written"),
                            ("night-backend", "yours now")]


def test_slug_survives_a_sentence():
    assert slug("a cache in front of the query!") == "a-cache-in-front-of-the"
    assert slug("") == "step"
