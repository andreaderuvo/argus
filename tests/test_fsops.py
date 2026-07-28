"""Mutating operations. The jail applies to the destination as much as the source."""

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root" / "dir").mkdir(parents=True)
    (tmp_path / "root" / "dir" / "inner.txt").write_text("in\n")
    (tmp_path / "root" / "hello.txt").write_text("ciao\n")
    (tmp_path / "root" / "target").mkdir()
    (tmp_path / "outside").mkdir()
    return tmp_path


def make_client(tree, allow_write=True):
    cfg = Config(token=TOKEN, roots=[tree / "root"], allow_write=allow_write)
    return TestClient(create_app(cfg))


@pytest.fixture
def client(tree):
    return make_client(tree)


def post(client, url, body):
    return client.post(url, json=body, headers={"Authorization": f"Bearer {TOKEN}"})


def test_read_only_is_the_default_and_refuses_everything(tree):
    ro = make_client(tree, allow_write=False)
    r = post(ro, "/api/fs/mkdir", {"path": str(tree / "root"), "name": "nope"})
    assert r.status_code == 403
    assert "read-only" in r.json()["error"]
    assert not (tree / "root" / "nope").exists()


def test_mkdir(client, tree):
    r = post(client, "/api/fs/mkdir", {"path": str(tree / "root"), "name": "fresh"})
    assert r.status_code == 200
    assert (tree / "root" / "fresh").is_dir()


def test_rename(client, tree):
    r = post(client, "/api/fs/rename", {"path": str(tree / "root" / "hello.txt"), "name": "ciao.txt"})
    assert r.status_code == 200
    assert (tree / "root" / "ciao.txt").read_text() == "ciao\n"
    assert not (tree / "root" / "hello.txt").exists()


def test_move_into_another_folder(client, tree):
    r = post(client, "/api/fs/move", {"path": str(tree / "root" / "hello.txt"), "dest": str(tree / "root" / "target")})
    assert r.status_code == 200
    assert (tree / "root" / "target" / "hello.txt").exists()


def test_copy_keeps_the_original(client, tree):
    r = post(client, "/api/fs/copy", {"path": str(tree / "root" / "hello.txt"), "dest": str(tree / "root" / "target")})
    assert r.status_code == 200
    assert (tree / "root" / "hello.txt").exists()
    assert (tree / "root" / "target" / "hello.txt").read_text() == "ciao\n"


def test_copy_a_whole_directory(client, tree):
    r = post(client, "/api/fs/copy", {"path": str(tree / "root" / "dir"), "dest": str(tree / "root" / "target")})
    assert r.status_code == 200
    assert (tree / "root" / "target" / "dir" / "inner.txt").exists()


def test_delete_a_file(client, tree):
    r = post(client, "/api/fs/delete", {"path": str(tree / "root" / "hello.txt")})
    assert r.status_code == 200
    assert not (tree / "root" / "hello.txt").exists()


def test_a_full_directory_needs_an_explicit_recursive(client, tree):
    body = {"path": str(tree / "root" / "dir")}
    assert post(client, "/api/fs/delete", body).status_code == 409
    assert (tree / "root" / "dir" / "inner.txt").exists(), "nothing may vanish on the first ask"

    assert post(client, "/api/fs/delete", {**body, "recursive": True}).status_code == 200
    assert not (tree / "root" / "dir").exists()


def test_nothing_is_overwritten_silently(client, tree):
    (tree / "root" / "target" / "hello.txt").write_text("mine\n")
    r = post(client, "/api/fs/move", {"path": str(tree / "root" / "hello.txt"), "dest": str(tree / "root" / "target")})
    assert r.status_code == 409
    assert (tree / "root" / "target" / "hello.txt").read_text() == "mine\n"
    assert (tree / "root" / "hello.txt").exists(), "the source stays put when the move is refused"


def test_the_destination_is_jailed_too(client, tree):
    r = post(client, "/api/fs/move", {"path": str(tree / "root" / "hello.txt"), "dest": str(tree / "outside")})
    assert r.status_code == 403
    assert (tree / "root" / "hello.txt").exists()


def test_a_name_cannot_escape_its_folder(client, tree):
    for bad in ("../escaped.txt", "sub/dir.txt", "..", "", "   "):
        r = post(client, "/api/fs/rename", {"path": str(tree / "root" / "hello.txt"), "name": bad})
        assert r.status_code == 400, bad
    assert not (tree / "escaped.txt").exists()


def test_a_root_cannot_be_renamed_or_deleted(client, tree):
    assert post(client, "/api/fs/rename", {"path": str(tree / "root"), "name": "x"}).status_code == 400
    assert post(client, "/api/fs/delete", {"path": str(tree / "root"), "recursive": True}).status_code == 400
    assert (tree / "root").is_dir()


def test_a_folder_cannot_be_moved_into_itself(client, tree):
    r = post(client, "/api/fs/move", {"path": str(tree / "root" / "dir"), "dest": str(tree / "root" / "dir")})
    assert r.status_code == 400


def test_write_endpoints_need_the_token(client, tree):
    r = client.post("/api/fs/mkdir", json={"path": str(tree / "root"), "name": "x"})
    assert r.status_code == 401
    assert not (tree / "root" / "x").exists()


def upload(client, path, files, token=TOKEN):
    return client.post(
        "/api/fs/upload",
        data={"path": str(path)},
        files=files,
        headers={"Authorization": f"Bearer {token}"},
    )


def test_upload_writes_the_file(client, tree):
    r = upload(client, tree / "root", [("files", ("note.txt", b"ciao\n", "text/plain"))])
    assert r.status_code == 200
    assert (tree / "root" / "note.txt").read_bytes() == b"ciao\n"
    assert r.json()["files"][0]["size"] == 5


def test_upload_takes_several_files_at_once(client, tree):
    r = upload(client, tree / "root", [
        ("files", ("a.txt", b"a", "text/plain")),
        ("files", ("b.txt", b"bb", "text/plain")),
    ])
    assert r.status_code == 200
    assert (tree / "root" / "a.txt").exists() and (tree / "root" / "b.txt").exists()


def test_upload_never_overwrites(client, tree):
    r = upload(client, tree / "root", [("files", ("hello.txt", b"mine", "text/plain"))])
    assert r.status_code == 409
    assert (tree / "root" / "hello.txt").read_text() == "ciao\n", "the original is untouched"


def test_a_traversing_filename_is_flattened_into_the_destination(client, tree):
    """`../escaped.txt` is not an error, it is a basename: the leading path is dropped
    and the file lands where the upload was aimed, never a directory above it."""
    r = upload(client, tree / "root", [("files", ("../escaped.txt", b"x", "text/plain"))])
    assert r.status_code == 200
    assert (tree / "root" / "escaped.txt").read_bytes() == b"x"
    assert not (tree / "escaped.txt").exists(), "nothing may appear outside the destination"


def test_a_filename_that_is_only_a_path_is_refused(client, tree):
    r = upload(client, tree / "root", [("files", ("../", b"x", "text/plain"))])
    assert r.status_code == 400


def test_upload_outside_the_roots_is_refused(client, tree):
    r = upload(client, tree / "outside", [("files", ("x.txt", b"x", "text/plain"))])
    assert r.status_code == 403
    assert not (tree / "outside" / "x.txt").exists()


def test_upload_is_refused_on_a_read_only_server(tree):
    ro = make_client(tree, allow_write=False)
    assert upload(ro, tree / "root", [("files", ("x.txt", b"x", "text/plain"))]).status_code == 403
    assert not (tree / "root" / "x.txt").exists()


def test_upload_needs_the_token(client, tree):
    r = client.post("/api/fs/upload", data={"path": str(tree / "root")},
                    files=[("files", ("x.txt", b"x", "text/plain"))])
    assert r.status_code == 401


def test_a_file_over_the_cap_is_refused_and_leaves_nothing_behind(tree):
    from app.config import Config
    from app.main import create_app
    from fastapi.testclient import TestClient

    cfg = Config(token=TOKEN, roots=[tree / "root"], allow_write=True, max_upload_bytes=10)
    small = TestClient(create_app(cfg))
    r = upload(small, tree / "root", [("files", ("big.bin", b"x" * 50, "application/octet-stream"))])
    assert r.status_code == 413
    assert not (tree / "root" / "big.bin").exists()
    assert not list((tree / "root").glob(".*argus-part")), "the part file is cleaned up"
