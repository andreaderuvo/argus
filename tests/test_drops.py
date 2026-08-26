"""A file dropped on a session, and where it is allowed to land.

A terminal is not a folder, so the destination cannot come from the sender — nobody was
looking at a folder when they let go. The server names it, makes it the first time it is
needed, and hands back the absolute path, which is the thing the drop was for: pasting it
into whatever is running in that session.

The rules worth pinning down are all about *where*: inside the jail always, inside the
first root by default rather than inside somebody's home directory, and nowhere at all on
a server that says so.
"""

import pytest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Config, ConfigError
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root").mkdir()
    (tmp_path / "outside").mkdir()
    return tmp_path


def make_client(tree, **over):
    settings = {"token": TOKEN, "roots": [tree / "root"], "allow_write": True}
    settings.update(over)
    return TestClient(create_app(Config(**settings)))


def drop(client, *files):
    return client.post(
        "/api/fs/drop",
        files=[("files", (name, body)) for name, body in files],
        headers={"Authorization": f"Bearer {TOKEN}"},
    )


def test_the_folder_is_made_on_the_first_drop_and_not_before(tree):
    client = make_client(tree)
    landing = tree / "root" / "argus-drops"
    assert not landing.exists(), "a machine nobody drops on should not grow the folder"

    r = drop(client, ("notes.txt", b"ciao\n"))
    assert r.status_code == 200, r.text
    assert (landing / "notes.txt").read_bytes() == b"ciao\n"


def test_it_answers_with_the_absolute_path(tree):
    """The whole point: what comes back is what you paste into the session."""
    r = drop(make_client(tree), ("paper.pdf", b"%PDF-1.4\n"))
    said = r.json()
    assert said["folder"] == str(tree / "root" / "argus-drops")
    assert said["files"][0]["path"] == str(tree / "root" / "argus-drops" / "paper.pdf")
    assert Path(said["files"][0]["path"]).is_absolute()
    assert said["files"][0]["size"] == len(b"%PDF-1.4\n")


def test_the_second_version_lands_beside_the_first(tree):
    """Dropping report.pdf again is the normal case, not a mistake worth refusing.

    Uploading into a folder you picked still refuses a name that is taken — you are looking
    at that folder. Nobody is looking at this one.
    """
    client = make_client(tree)
    first = drop(client, ("report.pdf", b"one")).json()["files"][0]["path"]
    second = drop(client, ("report.pdf", b"two")).json()["files"][0]["path"]

    assert Path(first).name == "report.pdf"
    assert Path(second).name == "report-2.pdf"
    assert Path(first).read_bytes() == b"one", "the first must not be overwritten"
    assert Path(second).read_bytes() == b"two"


def test_several_at_once_all_come_back(tree):
    r = drop(make_client(tree), ("a.txt", b"a"), ("b.txt", b"b"))
    assert [Path(f["path"]).name for f in r.json()["files"]] == ["a.txt", "b.txt"]


def test_a_read_only_server_takes_nothing(tree):
    r = drop(make_client(tree, allow_write=False), ("notes.txt", b"ciao"))
    assert r.status_code == 403
    assert "read-only" in r.json()["error"]
    assert not (tree / "root" / "argus-drops").exists()


def test_an_empty_drop_dir_means_no_drops(tree):
    r = drop(make_client(tree, drop_dir=None), ("notes.txt", b"ciao"))
    assert r.status_code == 404
    assert "drop_dir" in r.json()["error"]


def test_the_default_follows_the_roots_rather_than_the_home_directory(tree):
    """The reason the default is relative.

    An absolute default — `~/argus-drops` — is inside the jail only on a machine whose roots
    happen to include the home directory. On one serving `/data` it is outside, and a drop
    would land somewhere nothing in this app could read back. Relative makes it right by
    construction instead of by luck.
    """
    cfg = Config(token=TOKEN, roots=[tree / "root"], allow_write=True)
    assert cfg.drops() == tree / "root" / "argus-drops"
    assert cfg.drops().is_relative_to(tree / "root")


def test_a_path_written_by_hand_is_taken_as_written(tree):
    mine = tree / "root" / "scratch" / "incoming"
    client = make_client(tree, drop_dir=mine)
    landed = drop(client, ("notes.txt", b"ciao")).json()["files"][0]["path"]
    assert landed == str(mine / "notes.txt")
    assert mine.is_dir(), "parents are made too — it is one decision, not three"


def test_a_drop_dir_outside_the_roots_is_refused_at_startup(tree):
    """Said when the config is read, not at the first drop.

    A folder outside the jail is one that files vanish into: they are written, and then
    nothing in this app can list, open or serve them.
    """
    cfg = Config(token=TOKEN, roots=[tree / "root"], drop_dir=tree / "outside")
    with pytest.raises(ConfigError, match="outside `roots`"):
        cfg.validate()


def test_the_endpoint_refuses_it_too(tree):
    """The second lock, on the code path that does the creating.

    `validate()` is the first, and it is the one people meet. This is here because the
    endpoint makes a directory, and a thing that makes directories should not be relying on
    somebody else having checked.
    """
    client = make_client(tree, drop_dir=tree / "outside" / "drops")
    r = drop(client, ("notes.txt", b"ciao"))
    assert r.status_code == 403
    assert not (tree / "outside" / "drops").exists()


def test_the_browser_is_told_where_drops_go(tree):
    """The UI only offers a session as somewhere to drop when there is somewhere to drop."""
    client = make_client(tree)
    said = client.get("/api/config", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert said["drop_dir"] == str(tree / "root" / "argus-drops")

    off = make_client(tree, drop_dir=None)
    said = off.get("/api/config", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert said["drop_dir"] == ""


def test_the_cap_on_a_single_file_applies_here_too(tree):
    client = make_client(tree, max_upload_bytes=8)
    r = drop(client, ("big.bin", b"x" * 64))
    assert r.status_code == 413
    left = list((tree / "root" / "argus-drops").iterdir())
    assert left == [], f"a part-file was left behind: {[p.name for p in left]}"
