"""The team editor's checker (app/teamlint.py): every problem on its line, and fixes that fix.

Each case is something a person types: a misspelt key, a step name with a letter missing, a
bracket left open, a value off the list. What is checked is the *place* (line and columns, which
is what gets underlined) and that applying the offered fix leaves a file with that problem gone.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import teamlint, teammermaid, teams

from app.config import Config
from app.main import create_app


def make(tmp_path):
    return create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0"))


def fix(text: str, f: dict) -> str:
    lines = text.split("\n")

    def off(line, col):
        return sum(len(x) + 1 for x in lines[:line - 1]) + min(col, len(lines[line - 1]))
    return text[:off(f["line"], f["col"])] + f["text"] + text[off(f["end_line"], f["end_col"]):]


def under(text: str, p: dict) -> str:
    """The text a problem underlines."""
    line = text.split("\n")[p["line"] - 1]
    return line[p["col"]:p["end_col"]]


GOOD = """name: Fix it
goal: the tests pass
steps:
  fixer: {role: executor, worktree: true}
  tests: {check: pytest -q, of: fixer}
flow:
  - fixer -> tests
  - tests -> done if PASS
  - tests -> fixer if FAIL
"""


def test_a_good_team_has_no_problems_and_says_where_each_step_is():
    said = teamlint.lint(GOOD)
    assert said["ok"] and said["problems"] == [] and said["format"] == "yaml"
    assert said["where"] == {"fixer": 4, "tests": 5}
    assert said["graph"]["start"] == ["fixer"] and said["goal"] == "the tests pass"
    assert "1 agent" in said["summary"]


@pytest.mark.parametrize("name", list(teams.TEMPLATES))
def test_every_template_reads_clean_in_both_forms(name):
    graph = teams.TEMPLATES[name]["graph"]
    for text in (teams.to_yaml(graph, name), teammermaid.to_mermaid(graph)):
        said = teamlint.lint(text)
        assert said["ok"], (name, said["problems"])
        assert not [p for p in said["problems"] if p["level"] == "error"]


def test_a_misspelt_step_name_is_underlined_and_fixed():
    text = GOOD.replace("  - fixer -> tests", "  - fixr -> tests")
    said = teamlint.lint(text)
    (p,) = [p for p in said["problems"] if p["level"] == "error"]
    assert p["line"] == 7 and under(text, p) == "fixr" and "did you mean `fixer`" in p["message"]
    assert teamlint.lint(fix(text, p["fix"]))["ok"]


def test_a_key_not_read_is_a_warning_with_its_rename():
    text = GOOD.replace("{role: executor, worktree: true}", "{role: executor, worktre: true}")
    said = teamlint.lint(text)
    (p,) = said["problems"]
    assert p["level"] == "warning" and p["line"] == 4 and under(text, p) == "worktre"
    assert said["ok"], "a key not read does not stop a team"
    assert "worktree: true" in fix(text, p["fix"]) and teamlint.lint(fix(text, p["fix"]))["problems"] == []


def test_a_value_off_the_list_offers_the_nearest():
    text = GOOD.replace("goal: the tests pass\n", "goal: the tests pass\ngate: autp\n")
    (p,) = teamlint.lint(text)["problems"]
    assert p["level"] == "error" and under(text, p) == "autp" and p["fix"]["text"] == "auto"
    assert teamlint.lint(fix(text, p["fix"]))["ok"]


def test_a_bracket_left_open_is_said_where_it_opens():
    text = GOOD.replace("{role: executor, worktree: true}", "{role: executor, worktree: true")
    (p,) = teamlint.lint(text)["problems"]
    assert p["line"] == 4 and "never closed" in p["message"] and under(text, p).startswith("{")


def test_a_tab_is_named():
    (p,) = teamlint.lint("steps:\n\tfixer: {}\n")["problems"]
    assert p["line"] == 2 and "tab" in p["message"]


def test_a_key_twice_is_an_error_on_the_second():
    text = GOOD.replace("  tests: {check: pytest -q, of: fixer}\n", "  tests: {check: pytest -q, of: fixer}\n  fixer: {role: reviewer}\n")
    said = teamlint.lint(text)
    p = next(p for p in said["problems"] if "twice" in p["message"])
    assert p["line"] == 6 and under(text, p) == "fixer"


def test_a_loop_without_condition_is_placed_on_its_arrow():
    text = "steps:\n  a: {role: executor}\nflow:\n  - a -> a\n"
    (p,) = teamlint.lint(text)["problems"]
    assert p["line"] == 4 and "for ever" in p["message"]


def test_an_arrow_that_never_fires_offers_to_make_its_step_a_judge():
    for step in ("  b: {role: reviewer}\n", "  b:\n    role: reviewer\n", "  b:\n"):
        text = f"steps:\n  a: {{role: executor}}\n{step}flow:\n  - a -> b\n  - b -> a if REDO\n  - b -> done if DONE\n"
        said = teamlint.lint(text)
        p = next(p for p in said["problems"] if "does not judge" in p["message"])
        assert p["level"] == "warning" and under(text, p) == "REDO", step
        fixed = fix(text, p["fix"])
        assert not [q for q in teamlint.lint(fixed)["problems"] if "judge" in q["message"]], fixed
        assert next(n for n in teams.from_yaml(fixed)["graph"]["nodes"] if n["id"] == "b").get("judge"), fixed


def test_references_in_of_reads_and_start():
    text = GOOD.replace("of: fixer", "of: fixe").replace("name: Fix it\n", "name: Fix it\nstart: fiker\n")
    said = teamlint.lint(text)
    got = {under(text, p) for p in said["problems"] if p["level"] == "error"}
    assert got == {"fixe", "fiker"}
    assert all(p["fix"]["text"] == "fixer" for p in said["problems"] if p["level"] == "error")


def test_a_type_error_is_placed_on_its_value():
    text = GOOD.replace("goal: the tests pass\n", "goal: the tests pass\nrounds: ten\n")
    (p,) = teamlint.lint(text)["problems"]
    assert under(text, p) == "ten" and "integer" in p["message"]


def test_mermaid_problems_are_on_their_lines_too():
    text = "flowchart LR\n  fixer[executor]\n  tests{{pytest -q}}\n  fixer --> tests\n  tests -->|PAS| done\n"
    (p,) = teamlint.lint(text)["problems"]
    assert p["line"] == 5 and under(text, p) == "PAS" and p["fix"]["text"] == "PASS"
    assert teamlint.lint(fix(text, p["fix"]))["ok"]
    text = "flowchart LR\n  fixer[executor]\n  tests{{pytest -q}}\n  fixer --> tests\n  tests -->|FAIL| fixr\n  rev[\"reviewer\"] -->|OK| fixer\n"
    said = teamlint.lint(text)
    typo = next(p for p in said["problems"] if "never drawn" in p["message"])
    assert under(text, typo) == "fixr" and typo["fix"]["text"] == "fixer"
    judge = next(p for p in said["problems"] if "does not judge" in p["message"])
    assert 'rev["reviewer · judges"]' in fix(text, judge["fix"])


def test_completion_comes_from_the_schema():
    v = teamlint.vocab()
    assert set(v["top"]) >= {"name", "goal", "steps", "flow", "reset"} and set(v["step"]) == teammermaid.STEP_KEYS
    assert v["values"]["gate"] == list(teams.GATES) and "reviewer" in v["roles"]
    assert v["conditions"]["check"] == ["PASS", "FAIL"]


def test_the_routes(tmp_path):
    app = make(tmp_path)
    with TestClient(app) as c:
        h = {"Authorization": f"Bearer {app.state.cfg.token}"}
        said = c.post("/api/teams/lint", json={"text": GOOD.replace("fixer -> tests", "fixr -> tests")}, headers=h).json()
        assert not said["ok"] and said["problems"][0]["line"] == 7
        assert c.post("/api/teams/lint", json={"text": ""}, headers=h).json()["problems"][0]["level"] == "error"
        assert "roles" in c.get("/api/teams/vocab", headers=h).json()
        # team_check carries the same, for an agent fixing what it wrote.
        assert c.post("/api/teams/check", json={"text": "steps:\n  a: {role: executor, judges: true}\nflow:\n  - a -> done\n"},
                      headers=h).json()["problems"][0]["fix"]["text"] == "judge"


def test_the_same_arrow_twice_is_said_and_removed():
    text = GOOD + "  - tests -> fixer if FAIL\n"
    said = teamlint.lint(text)
    (p,) = said["problems"]
    assert p["level"] == "warning" and p["line"] == 10 and "line 9" in p["message"]
    assert fix(text, p["fix"]) == GOOD
