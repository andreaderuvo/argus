"""What happened while nobody was looking.

Every other screen in here answers "what is happening". This one answers the question you
actually open a phone for — did anything happen, and does it need me — and only the machine
can answer it, because the browser was shut.

The care goes into two places. The walk has to be bounded, or the question cannot be asked of
a home directory at all; and a summary must not fail because one desk folder has been moved,
since a summary that 404s is not a summary.
"""

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.files import changed_since
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


def aged(path: Path, minutes: float, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    when = time.time() - minutes * 60
    os.utime(path, (when, when))
    return path


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    return root


def client_for(root, **over):
    settings = {"token": TOKEN, "roots": [root]}
    settings.update(over)
    return TestClient(create_app(Config(**settings)))


def ask(client, at, *folders):
    query = "&".join([f"at={at}"] + [f"folder={f}" for f in folders])
    return client.get(f"/api/since?{query}", headers={"Authorization": f"Bearer {TOKEN}"})


def test_it_finds_what_was_written_and_leaves_the_rest(tree):
    aged(tree / "fresh.txt", 5)
    aged(tree / "old.txt", 600)
    found = changed_since(tree, time.time() - 3600)
    assert [f["name"] for f in found] == ["fresh.txt"]


def test_newest_first(tree):
    aged(tree / "middle.txt", 20)
    aged(tree / "newest.txt", 1)
    aged(tree / "oldest.txt", 50)
    found = changed_since(tree, time.time() - 3600)
    assert [f["name"] for f in found] == ["newest.txt", "middle.txt", "oldest.txt"]


def test_directories_are_not_news(tree):
    """A folder's mtime moves whenever anything inside it is written, so reporting folders
    would say "your home directory changed" every time — true, and worth nothing."""
    aged(tree / "sub" / "inside.txt", 1)
    found = changed_since(tree, time.time() - 3600)
    assert [f["name"] for f in found] == ["inside.txt"]


def test_the_noise_is_pruned(tree):
    """The same directories a search skips. Without this the answer to "what happened" on any
    real project is four hundred files under .git."""
    aged(tree / ".git" / "index", 1)
    aged(tree / "node_modules" / "x" / "package.json", 1)
    aged(tree / "results" / "tree.newick", 1)
    found = changed_since(tree, time.time() - 3600)
    assert [f["name"] for f in found] == ["tree.newick"]


def test_dotfiles_are_a_tools_business(tree):
    aged(tree / ".bash_history", 1)
    aged(tree / "report.md", 1)
    found = changed_since(tree, time.time() - 3600)
    assert [f["name"] for f in found] == ["report.md"]


def test_it_stops_counting(tree):
    for n in range(60):
        aged(tree / f"f{n:03d}.txt", n / 60)
    found = changed_since(tree, time.time() - 3600, limit=10)
    assert len(found) == 10, "an answer marked short is useful; an endless one is not"


def test_a_bell_that_rang_while_you_were_out(tree):
    client = client_for(tree)
    client.post("/api/bell", json={"session": "claude", "why": "asking", "text": "shall I?"},
                headers={"Authorization": f"Bearer {TOKEN}"})
    said = ask(client, int(time.time()) - 60).json()
    assert [b["session"] for b in said["bells"]] == ["claude"]
    assert said["bells"][0]["why"] == "asking"


def test_a_bell_from_before_you_left_is_not_news(tree):
    client = client_for(tree)
    client.post("/api/bell", json={"session": "claude", "why": "done"},
                headers={"Authorization": f"Bearer {TOKEN}"})
    # Asked about the future: nothing can have happened since.
    said = ask(client, int(time.time()) + 60).json()
    assert said["bells"] == []


def test_a_folder_that_has_gone_does_not_sink_the_answer(tree):
    """Desks outlive the folders they were made for, and this screen is the one place where
    being approximately right beats being precisely broken."""
    aged(tree / "report.md", 1)
    client = client_for(tree)
    r = ask(client, int(time.time()) - 3600, str(tree), str(tree / "moved-away"), "/etc")
    assert r.status_code == 200
    said = r.json()
    assert said["folders"] == [str(tree)], "the missing one and the forbidden one are skipped"
    assert [f["name"] for f in said["files"]] == ["report.md"]


def test_the_same_folder_twice_is_one_answer(tree):
    """Several desks on one project is the normal way to work here."""
    aged(tree / "report.md", 1)
    said = ask(client_for(tree), int(time.time()) - 3600, str(tree), str(tree)).json()
    assert len(said["files"]) == 1
    assert said["folders"] == [str(tree)]


def test_nothing_happened_is_an_answer(tree):
    said = ask(client_for(tree), int(time.time()) - 3600, str(tree)).json()
    assert said["bells"] == [] and said["files"] == [] and said["runs"] == []
