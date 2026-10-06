"""A team drawn as a Mermaid flowchart: the subset read, what it keeps, and the way back."""

from __future__ import annotations

import pytest

from app.teammermaid import from_mermaid, to_mermaid
from app.teams import TEMPLATES

KRAKEN = """flowchart LR
  analyst["market analyst"]
  quant["quant developer"]
  check{{"python3 reversal_paper.py --check"}}
  risk["risk manager · judges"]
  analyst --> quant --> check
  check -->|PASS| risk
  check -->|FAIL| quant
  risk -->|OK, REDO| quant
  risk -->|DONE| done
"""


def shape(g):
    return ({(n["id"], n["kind"], n.get("role"), bool(n.get("judge"))) for n in g["nodes"]},
            {(e["from"], e["to"], e["when"]) for e in g["edges"]}, g["start"])


def test_a_flowchart_becomes_a_team():
    g = from_mermaid(KRAKEN)
    nodes = {n["id"]: n for n in g["nodes"]}
    assert nodes["analyst"] == {"id": "analyst", "kind": "agent", "role": "market analyst"}
    assert nodes["risk"]["judge"] is True and nodes["risk"]["role"] == "risk manager"
    assert nodes["check"]["command"] == "python3 reversal_paper.py --check"
    assert nodes["check"]["of"] == "quant", "a check's work is the agent pointing into it"
    assert nodes["end"]["kind"] == "end"
    assert g["start"] == ["analyst"], "the first step, when nothing says otherwise"
    # A chain is two arrows; "OK, REDO" is two conditions on one arrow.
    assert ("analyst", "quant", "always") in shape(g)[1] and ("quant", "check", "always") in shape(g)[1]
    assert {("risk", "quant", "OK"), ("risk", "quant", "REDO")} <= shape(g)[1]


def test_parallel_branches_start_and_a_join():
    g = from_mermaid("""graph TD
  %% start: plan
  plan[planner] --> a[executor] & b[executor]
  a & b --> j{join}
  j --> r(reviewer judges)
  r -->|DONE| done((done))
  r -->|OK, REDO| plan
""")
    assert {e["to"] for e in g["edges"] if e["from"] == "plan"} == {"a", "b"}
    assert {e["from"] for e in g["edges"] if e["to"] == "j"} == {"a", "b"}
    assert {n["id"]: n["kind"] for n in g["nodes"]}["j"] == "join"
    assert g["start"] == ["plan"]


@pytest.mark.parametrize("key", sorted(TEMPLATES))
def test_every_template_goes_there_and_back(key):
    graph = TEMPLATES[key]["graph"]
    assert shape(from_mermaid(to_mermaid(graph), graph)) == shape(graph)


def test_what_a_flowchart_cannot_say_is_kept_from_the_team():
    base = TEMPLATES["write"]["graph"]
    g = from_mermaid(to_mermaid(base), base)
    duty = {n["id"]: n.get("duty") for n in g["nodes"]}
    assert duty["critic-style"] == next(n["duty"] for n in base["nodes"] if n["id"] == "critic-style")


@pytest.mark.parametrize("text, said", [
    ("", "no steps"),
    ("flowchart LR\n  a[x] -->|MAYBE| b[y]", "line 2: 'maybe' is not a condition"),
    ("flowchart LR\n  a[x] --> ", "line 2: expected a step"),
    ("flowchart LR\n  a[x] --> b[y] ??", "line 2: unexpected"),
])
def test_a_wrong_line_is_named(text, said):
    with pytest.raises(ValueError, match=said.replace("?", r"\?")):
        from_mermaid(text)


def test_the_route_reads_and_writes(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    c = TestClient(create_app(cfg))
    h = {"authorization": "Bearer " + "m" * 64}
    said = c.post("/api/teams/mermaid", json={"text": KRAKEN}, headers=h)
    assert said.status_code == 200 and len(said.json()["graph"]["nodes"]) == 5
    back = c.post("/api/teams/mermaid", json={"graph": said.json()["graph"]}, headers=h)
    assert back.json()["text"].startswith("flowchart LR")
    bad = c.post("/api/teams/mermaid", json={"text": "flowchart LR\n a -->|NOPE| b"}, headers=h)
    assert bad.status_code == 400 and "line 2" in bad.text
    # While typing, a half-written line is answered, not refused.
    assert c.post("/api/teams/mermaid", json={"text": "flowchart LR\n a -->", "preview": True}, headers=h).json()["error"].startswith("line 2")
