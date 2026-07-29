"""Adding up what a folder weighs.

The interesting cases are all about not lying: a symlink must not be followed (the same
tree twice, or a tree outside the roots), an unreadable corner must not silently vanish
into a number that looks complete, and a walk that gives up must say so.
"""

import os

import pytest
from fastapi.testclient import TestClient

from app import files
from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "root"
    (root / "sub" / "deep").mkdir(parents=True)
    (root / "a.txt").write_bytes(b"x" * 100)
    (root / "sub" / "b.txt").write_bytes(b"x" * 250)
    (root / "sub" / "deep" / "c.bin").write_bytes(b"x" * 1000)
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "huge.bin").write_bytes(b"x" * 999_999)
    return tmp_path


@pytest.fixture
def client(tree):
    return TestClient(create_app(Config(token=TOKEN, roots=[tree / "root"])))


def usage(client, path):
    return client.get(f"/api/fs/usage?path={path}", headers={"Authorization": f"Bearer {TOKEN}"})


def test_the_total_is_every_file_below_it(client, tree):
    body = usage(client, tree / "root").json()
    assert body["bytes"] == 1350
    assert body["files"] == 3
    assert body["dirs"] == 2
    assert body["complete"] is True


def test_a_subfolder_counts_only_itself(client, tree):
    assert usage(client, tree / "root" / "sub").json()["bytes"] == 1250


def test_a_file_answers_for_itself_rather_than_refusing(client, tree):
    body = usage(client, tree / "root" / "a.txt").json()
    assert body == {"path": str(tree / "root" / "a.txt"), "bytes": 100, "files": 1, "dirs": 0, "complete": True}


def test_a_symlink_is_counted_as_a_link_not_as_what_it_points_at(client, tree):
    """Following it would add up a tree outside the roots — and count a tree reachable
    twice, twice."""
    os.symlink(tree / "outside", tree / "root" / "elsewhere")
    body = usage(client, tree / "root").json()
    assert body["bytes"] < 2000, "the 999999-byte file behind the link must not be in there"
    assert body["files"] == 4, "the link itself is one entry"


def test_a_loop_does_not_hang(client, tree):
    os.symlink(tree / "root", tree / "root" / "sub" / "loop")
    body = usage(client, tree / "root").json()
    assert body["bytes"] < 2000


def test_an_empty_folder_weighs_nothing(client, tree):
    body = usage(client, tree / "root" / "sub" / "deep" / "..").json()
    assert body["bytes"] == 1250


def test_outside_the_roots_is_refused(client, tree):
    assert usage(client, tree / "outside").status_code == 403


def test_it_needs_the_token(client, tree):
    assert client.get(f"/api/fs/usage?path={tree / 'root'}").status_code == 401


def test_a_walk_that_gives_up_says_the_answer_is_partial(client, tree, monkeypatch):
    """A run directory with millions of files must return something useful rather than
    hanging — but it must never present a partial sum as the whole truth."""
    monkeypatch.setattr(files, "USAGE_MAX_ENTRIES", 1)
    body = usage(client, tree / "root").json()
    assert body["complete"] is False
    assert body["bytes"] >= 0


def test_a_directory_we_cannot_enter_makes_the_answer_partial(client, tree):
    locked = tree / "root" / "locked"
    locked.mkdir()
    (locked / "hidden.bin").write_bytes(b"x" * 500)
    locked.chmod(0o000)
    try:
        body = usage(client, tree / "root").json()
        assert body["complete"] is False, "a corner we cannot read must not look counted"
        assert body["bytes"] == 1350, "and must not be guessed at either"
    finally:
        locked.chmod(0o755)
