"""argus-sync's server side (app/syncapi.py): a key that opens one folder and nothing else, the
manifest, and writes and deletes that are safe on their own — atomic, conflict-checked, trashed."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from app import syncapi
from app.config import Config
from app.main import create_app

MASTER = "m" * 64


def make(tmp_path, allow_write=True):
    root = tmp_path / "root"
    (root / "data" / "sub").mkdir(parents=True)
    (root / "data" / "a.txt").write_text("alpha")
    (root / "data" / "sub" / "b.txt").write_text("beta")
    (root / "data" / ".DS_Store").write_text("x")
    (root / "other").mkdir()
    (root / "other" / "secret.txt").write_text("no")
    os.symlink(root / "other", root / "data" / "out")             # a way out, which must stay shut
    cfg = Config(token=MASTER, roots=[root])
    cfg.allow_write = allow_write
    cfg.devices_store = tmp_path / "conf" / "devices.json"
    c = TestClient(create_app(cfg))
    return c, root


def key_for(c, root, write=True):
    said = c.post("/api/sync/keys", json={"path": str(root / "data"), "base": "http://box:8090", "write": write},
                  headers={"authorization": "Bearer " + MASTER}).json()
    assert said["link"].startswith("argus-sync://pair?url=http%3A%2F%2Fbox%3A8090&key=as_")
    return said["token"], {"authorization": "Bearer " + said["token"]}


def test_a_sync_key_opens_its_folder_and_nothing_else(tmp_path):
    c, root = make(tmp_path)
    token, h = key_for(c, root)
    assert c.get("/api/sync/hello", headers=h).json()["folder"] == "data"
    for path in ("/api/files?path=" + str(root), "/api/tmux/sessions", "/api/prefs", "/api/sync/keys"):
        assert c.get(path, headers=h).status_code == 403, path
    assert c.post("/api/sync/keys", json={"path": str(root), "base": "http://x:1"}, headers=h).status_code == 403
    assert c.get("/api/sync/file", params={"p": "out/secret.txt"}, headers=h).status_code == 403, "a link out stays shut"
    assert c.get("/api/sync/file", params={"p": "../other/secret.txt"}, headers=h).status_code == 400
    assert c.get("/api/sync/file", params={"p": "a.txt"}, headers=h).text == "alpha"
    with pytest.raises(Exception):
        with c.websocket_connect("/ws/term?session=x&token=" + token):
            pass
    # Taken back: at once.
    kid = c.get("/api/sync/keys", headers={"authorization": "Bearer " + MASTER}).json()["keys"][0]["id"]
    c.delete(f"/api/sync/keys/{kid}", headers={"authorization": "Bearer " + MASTER})
    assert c.get("/api/sync/hello", headers=h).status_code == 401
    assert "hash" not in json.dumps(c.get("/api/sync/keys", headers={"authorization": "Bearer " + MASTER}).json())


def test_the_manifest_lists_files_not_links_nor_litter(tmp_path):
    c, root = make(tmp_path)
    _, h = key_for(c, root)
    said = c.get("/api/sync/manifest", headers=h).json()
    paths = {e["p"]: e for e in said["entries"]}
    assert set(paths) == {"a.txt", "sub", "sub/b.txt"}, paths
    assert paths["a.txt"]["s"] == 5 and paths["a.txt"]["m"] == os.stat(root / "data" / "a.txt").st_mtime_ns
    assert c.get("/api/sync/manifest", params={"since": said["signature"]}, headers=h).json() == {"same": True, "signature": said["signature"]}


def test_writes_are_atomic_timed_and_checked_against_what_the_client_saw(tmp_path):
    c, root = make(tmp_path)
    _, h = key_for(c, root)
    m = 1_700_000_000_123_456_789
    put = c.put("/api/sync/file", params={"p": "new/deep/c.txt", "m": m, "base": "none"}, content=b"gamma", headers=h)
    assert put.status_code == 200 and (root / "data" / "new" / "deep" / "c.txt").read_text() == "gamma"
    assert os.stat(root / "data" / "new" / "deep" / "c.txt").st_mtime_ns == m == put.json()["m"]
    # "Nothing there" when something is: a conflict, and the file is untouched.
    again = c.put("/api/sync/file", params={"p": "a.txt", "m": m, "base": "none"}, content=b"mine", headers=h)
    assert again.status_code == 409 and json.loads(again.json()["error"])["conflict"] == "exists"
    seen = os.stat(root / "data" / "a.txt").st_mtime_ns
    (root / "data" / "a.txt").write_text("changed on the server")
    os.utime(root / "data" / "a.txt", ns=(seen + 10**9, seen + 10**9))
    stale = c.put("/api/sync/file", params={"p": "a.txt", "m": m, "base": str(seen)}, content=b"mine", headers=h)
    assert stale.status_code == 409 and (root / "data" / "a.txt").read_text() == "changed on the server"
    assert not [f for f in os.listdir(root / "data") if f.startswith(".argus-sync-")], "no part file left"
    assert c.put("/api/sync/file", params={"p": ".DS_Store", "m": m}, content=b"x", headers=h).status_code == 400


def test_a_delete_goes_to_the_trash_and_folders_only_when_empty(tmp_path):
    c, root = make(tmp_path)
    _, h = key_for(c, root)
    m = os.stat(root / "data" / "sub" / "b.txt").st_mtime_ns
    assert c.delete("/api/sync/dir", params={"p": "sub"}, headers=h).status_code == 409, "not empty"
    gone = c.delete("/api/sync/file", params={"p": "sub/b.txt", "base": str(m)}, headers=h).json()["trashed"]
    assert open(gone).read() == "beta" and gone.startswith(str(tmp_path / "conf" / "sync-trash"))
    assert c.delete("/api/sync/dir", params={"p": "sub"}, headers=h).status_code == 200
    assert not (root / "data" / "sub").exists()
    assert c.post("/api/sync/dir", params={"p": "made/here"}, headers=h).status_code == 200 and (root / "data" / "made" / "here").is_dir()
    assert c.delete("/api/sync/dir", params={"p": ""}, headers=h).status_code == 400, "never the folder itself"


def test_read_only_keys_and_servers(tmp_path):
    c, root = make(tmp_path)
    _, h = key_for(c, root, write=False)
    assert c.get("/api/sync/hello", headers=h).json()["write"] is False
    assert c.put("/api/sync/file", params={"p": "x.txt", "m": 1}, content=b"x", headers=h).status_code == 403
    c2, root2 = make(tmp_path / "ro", allow_write=False)
    _, h2 = key_for(c2, root2)
    assert c2.get("/api/sync/hello", headers=h2).json()["write"] is False
    assert c2.delete("/api/sync/file", params={"p": "a.txt"}, headers=h2).status_code == 403


def test_a_write_over_the_upload_limit_is_refused_and_leaves_nothing(tmp_path):
    c, root = make(tmp_path)
    c.app.state.cfg.max_upload_bytes = 1000
    _, h = key_for(c, root)
    r = c.put("/api/sync/file", params={"p": "big.bin", "m": 1, "base": "none"}, content=b"x" * 5000, headers=h)
    assert r.status_code == 413
    assert not (root / "data" / "big.bin").exists()
    assert not [f for f in os.listdir(root / "data") if f.startswith(".argus-sync-")], "no part file left"
