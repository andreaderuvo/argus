"""The team's graph, drawn and changed: the layout and the edits behind the clicks (teamgraph.js).

Run in Node against the module itself. The layout must put every step where it happens — two
branches in one column, the arrows that go back marked as such — and an edit must leave a graph
the server will run: an added step wired in, a removed one wired around.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.teams import TEMPLATES, check_graph

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def run(script: str, data) -> dict:
    code = f"""
import {{ layoutGraph, edits }} from '{(ROOT / "static/js/teamgraph.js").as_uri()}';
const data = JSON.parse(process.argv[1]);
{script}
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps(data)], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


LAYOUT = """
const out = {};
for (const [key, g] of Object.entries(data)) {
  const { columns, back } = layoutGraph(g);
  out[key] = { columns, back: [...back].map((e) => `${e.from}>${e.to}:${e.when}`).sort() };
}
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(NODE is None, reason="needs node")
def test_the_templates_lay_out_in_the_order_things_happen():
    got = run(LAYOUT, {k: v["graph"] for k, v in TEMPLATES.items()})
    assert got["optimise"]["columns"] == [["executor"], ["check"], ["reviewer"], ["end"]]
    assert got["optimise"]["back"] == ["check>executor:FAIL", "reviewer>executor:OK", "reviewer>executor:REDO"]
    t = got["tournament"]["columns"]
    assert t[0] == ["planner"] and sorted(t[1]) == ["executor-a", "executor-b"], "two branches, one column"
    assert sorted(t[2]) == ["check-a", "check-b"] and t[3] == ["join"] and t[4] == ["reviewer"]
    assert got["write"]["back"] == ["join>writer:always"], "the next round goes back, drawn underneath"


EDIT = """
const g = data;
const steps = [];
steps.push(edits.after(g, 'executor', { id: 'tests', kind: 'check', of: 'executor', command: 'make test' }));
steps.push(edits.beside(g, 'executor', { id: 'executor-b', kind: 'agent', role: 'executor' }));
edits.rename(g, 'reviewer', 'judge');
const refused = edits.rename(g, 'judge', 'Bad Name');
console.log(JSON.stringify({ g, steps, refused }));
"""


@pytest.mark.skipif(NODE is None, reason="needs node")
def test_edits_keep_a_graph_the_server_will_run():
    got = run(EDIT, TEMPLATES["optimise"]["graph"])
    g = got["g"]
    assert got["steps"] == ["tests", "executor-b"] and got["refused"] is False
    check_graph(g)                                         # the server's own judgement of it
    edges = {(e["from"], e["to"], e["when"]) for e in g["edges"]}
    assert ("executor", "tests", "always") in edges and ("tests", "check", "always") in edges, "wired in after"
    assert ("executor-b", "tests", "always") in edges, "in parallel: the same arrows out"
    assert ("judge", "executor", "REDO") in edges and ("check", "judge", "PASS") in edges, "a rename follows every arrow"
    assert not any("reviewer" in (e["from"], e["to"]) for e in g["edges"])


REMOVE = """
const g = data;
edits.remove(g, 'check');
console.log(JSON.stringify(g));
"""


@pytest.mark.skipif(NODE is None, reason="needs node")
def test_a_removed_step_is_wired_around():
    g = run(REMOVE, TEMPLATES["optimise"]["graph"])
    check_graph(g)
    edges = {(e["from"], e["to"], e["when"]) for e in g["edges"]}
    assert ("executor", "reviewer", "always") in edges, "the executor now goes straight to the reviewer"
    assert all(n["id"] != "check" for n in g["nodes"])
    assert not any(e["from"] == e["to"] for e in g["edges"]), "and never into itself"
