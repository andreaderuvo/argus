"""The team file's JSON Schema (docs/team.schema.json): what an editor checks while team.yaml is
typed. It must say what Argus's own reader says — no more, no less — and every example we ship
or document must pass it."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

from app import teams, teammermaid

jsonschema = pytest.importorskip("jsonschema")
ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "docs/team.schema.json").read_text())
V = jsonschema.Draft7Validator(SCHEMA)


def test_the_schema_is_a_schema():
    jsonschema.Draft7Validator.check_schema(SCHEMA)


def test_its_keys_are_the_readers():
    assert set(SCHEMA["properties"]) == teammermaid.TOP_KEYS - {"argus_team_pack"}
    assert set(SCHEMA["definitions"]["step"]["properties"]) == teammermaid.STEP_KEYS
    assert set(SCHEMA["properties"]["reset"]["properties"]) == {"files", "run", "log"}
    assert SCHEMA["properties"]["gate"]["enum"] == list(teams.GATES)
    assert SCHEMA["properties"]["reset"]["properties"]["log"]["enum"] == list(teams.RESET_LOG)


def yaml_blocks(text):
    return [b for b in re.findall(r"```yaml\n(.*?)```", text, re.S) if re.search(r"^steps:", b, re.M)]


def test_every_team_we_ship_or_document_passes():
    docs = [teams.to_yaml(t["graph"], t["label"]) for t in teams.TEMPLATES.values()]
    for skill in (ROOT / "plugin/skills").glob("*/SKILL.md"):
        docs += yaml_blocks(skill.read_text())
    wiki = Path.home() / "argus.wiki"
    if wiki.is_dir():
        for page in wiki.glob("*.md"):
            docs += yaml_blocks(page.read_text())
    assert len(docs) >= 8
    for text in docs:
        errors = [f"{list(e.path)}: {e.message}" for e in V.iter_errors(yaml.safe_load(text))]
        assert not errors, (text[:200], errors)
        teams.from_yaml(text)                      # and Argus reads it too


def test_a_file_argus_writes_tells_the_editor_where_its_schema_is(tmp_path):
    text = teams.to_yaml(teams.TEMPLATES["fix"]["graph"], "Fix")
    assert text.splitlines()[0] == teams.SCHEMA_LINE
    teams.propose(tmp_path, "name: P\nsteps:\n  a: {role: executor}\nflow:\n  - a -> a if REDO\n", "x")
    lines = (tmp_path / "team.yaml").read_text().splitlines()
    assert lines[0].startswith(teams.PROPOSED) and lines[1] == teams.SCHEMA_LINE


@pytest.mark.parametrize("text, said", [
    ("steps:\n  a: {role: x, judges: true}\n", "did you mean `judge:`"),
    ("stepz: {}\nsteps:\n  a: {role: x}\n", "did you mean `steps:`"),
    ("steps:\n  a: {role: x}\nflow:\n  - a, b -> c\n", "is not an arrow"),
    ("steps:\n  Bad_Id: {role: x}\n", "a step name is a lowercase letter"),
    ("steps:\n  c: {check: pytest, join: true}\n", "not two"),
    ("gate: maybe\nsteps:\n  a: {role: x}\n", "'maybe' is not one of"),
    ("steps:\n  a: {role: x}\nreset: {files: [/etc/passwd]}\n", "reset.files"),
])
def test_what_is_wrong_is_said_in_words(text, said):
    assert any(said in line for line in teams.schema_errors(yaml.safe_load(text))), teams.schema_errors(yaml.safe_load(text))


def test_argus_serves_it(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app
    c = TestClient(create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")))
    said = c.get("/team.schema.json")
    assert said.status_code == 200 and said.json() == SCHEMA
