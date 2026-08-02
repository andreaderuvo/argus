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


def make_client(tree, allow_write=True, max_preview_bytes=2 * 1024 * 1024):
    cfg = Config(
        token=TOKEN, roots=[tree / "root"],
        allow_write=allow_write, max_preview_bytes=max_preview_bytes,
    )
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


def write(client, path, content, mtime=None, token=TOKEN):
    body = {"path": str(path), "content": content}
    if mtime is not None:
        body["mtime"] = mtime
    return client.post("/api/fs/write", json=body, headers={"Authorization": f"Bearer {token}"})


def test_saving_replaces_the_contents(client, tree):
    target = tree / "root" / "hello.txt"
    r = write(client, target, "nuovo contenuto\n")
    assert r.status_code == 200
    assert target.read_text() == "nuovo contenuto\n"


def test_saving_keeps_the_files_permissions(client, tree):
    import stat as st

    target = tree / "root" / "hello.txt"
    target.chmod(0o640)
    write(client, target, "x")
    assert st.S_IMODE(target.stat().st_mode) == 0o640, "a rename must not reset the mode"


def test_a_file_that_moved_on_is_refused(client, tree):
    """A job writing the same file is the normal case, not a rare one."""
    target = tree / "root" / "hello.txt"
    stale = int(target.stat().st_mtime) - 10
    r = write(client, target, "sovrascrivo", mtime=stale)
    assert r.status_code == 409
    assert target.read_text() == "ciao\n", "the running job's work is untouched"


def test_the_matching_mtime_goes_through(client, tree):
    target = tree / "root" / "hello.txt"
    r = write(client, target, "va bene", mtime=int(target.stat().st_mtime))
    assert r.status_code == 200
    assert target.read_text() == "va bene"


def test_a_file_too_big_to_preview_whole_cannot_be_saved(tree):
    """The preview was only its tail; saving it back would throw the head away."""
    small = make_client(tree, max_preview_bytes=1024)
    target = tree / "root" / "huge.log"
    target.write_text("x" * 5000)
    r = write(small, target, "tiny")
    assert r.status_code == 413
    assert target.stat().st_size == 5000


def test_writing_outside_the_roots_is_refused(client, tree):
    outside = tree / "outside" / "secret.txt"
    outside.write_text("nope\n")
    r = write(client, outside, "mio")
    assert r.status_code == 403
    assert outside.read_text() == "nope\n"


def test_writing_is_refused_on_a_read_only_server(tree):
    ro = make_client(tree, allow_write=False)
    assert write(ro, tree / "root" / "hello.txt", "x").status_code == 403
    assert (tree / "root" / "hello.txt").read_text() == "ciao\n"


def test_a_directory_is_not_a_text_file(client, tree):
    assert write(client, tree / "root" / "dir", "x").status_code == 400


def test_no_part_file_is_left_behind(client, tree):
    write(client, tree / "root" / "hello.txt", "pulito")
    assert not list((tree / "root").glob(".*argus-part"))


def upload_seq(client, path, name, data, sequence, token=TOKEN):
    return client.post(
        "/api/fs/upload",
        data={"path": str(path), "sequence": sequence},
        files=[("files", (name, data, "image/png"))],
        headers={"Authorization": f"Bearer {token}"},
    )


def test_a_pasted_image_is_numbered_not_named(client, tree):
    """The clipboard offers the same "image.png" every time; the number has to come from
    the folder, not from the sender."""
    r = upload_seq(client, tree / "root", "image.png", b"\x89PNG", "screenshot")
    assert r.status_code == 200
    assert (tree / "root" / "screenshot-1.png").exists()


def test_the_number_carries_on_from_what_is_there(client, tree):
    (tree / "root" / "screenshot-1.png").write_bytes(b"a")
    (tree / "root" / "screenshot-2.png").write_bytes(b"b")
    upload_seq(client, tree / "root", "image.png", b"\x89PNG", "screenshot")
    assert (tree / "root" / "screenshot-3.png").exists()
    assert (tree / "root" / "screenshot-1.png").read_bytes() == b"a", "nothing is overwritten"


def test_a_gap_in_the_numbering_is_filled(client, tree):
    (tree / "root" / "screenshot-1.png").write_bytes(b"a")
    (tree / "root" / "screenshot-3.png").write_bytes(b"c")
    upload_seq(client, tree / "root", "image.png", b"\x89PNG", "screenshot")
    assert (tree / "root" / "screenshot-2.png").exists()


def test_the_extension_follows_the_image_that_was_pasted(client, tree):
    upload_seq(client, tree / "root", "grab.jpeg", b"\xff\xd8", "screenshot")
    assert (tree / "root" / "screenshot-1.jpeg").exists()


def test_a_nonsense_extension_becomes_png(client, tree):
    upload_seq(client, tree / "root", "grab.../etc/passwd", b"x", "screenshot")
    assert (tree / "root" / "screenshot-1.png").exists()
    assert not (tree / "etc").exists()


def test_the_sequence_name_cannot_escape_the_folder(client, tree):
    r = upload_seq(client, tree / "root", "image.png", b"x", "../outside/shot")
    assert r.status_code == 400
    assert not list((tree / "outside").glob("*"))


def test_pasting_is_refused_on_a_read_only_server(tree):
    ro = make_client(tree, allow_write=False)
    assert upload_seq(ro, tree / "root", "image.png", b"x", "screenshot").status_code == 403
