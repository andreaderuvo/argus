"""The mount wizard's server side (app/sshmount.py): where to reach the machine, and letting a key in."""

from __future__ import annotations

import stat

import pytest
from fastapi.testclient import TestClient

from app import sshmount
from app.config import Config
from app.main import create_app

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop"


def test_a_key_is_added_once_with_the_right_permissions(tmp_path):
    said = sshmount.authorize(KEY, tmp_path)
    assert said["added"] and not said["already"]
    keys = tmp_path / ".ssh" / "authorized_keys"
    assert keys.read_text() == KEY + "\n"
    assert stat.S_IMODE(keys.stat().st_mode) == 0o600 and stat.S_IMODE((tmp_path / ".ssh").stat().st_mode) == 0o700
    assert sshmount.authorize("  " + KEY.replace(" me@laptop", "") + "  ", tmp_path)["already"], "the same key, any comment"
    assert keys.read_text().count("ssh-ed25519") == 1


@pytest.mark.parametrize("bad", ["", "hello", "ssh-ed25519 short", KEY + "\nssh-ed25519 AAAA" + "B" * 50,
                                 'command="rm -rf ~" ' + KEY, "ssh-dss " + "A" * 60])
def test_only_one_plain_public_key(tmp_path, bad):
    with pytest.raises(sshmount.BadKey):
        sshmount.authorize(bad, tmp_path)
    assert not (tmp_path / ".ssh" / "authorized_keys").exists()


def test_info_names_the_machine():
    said = sshmount.info(["10.0.0.5", "box.lab.example"], "")
    assert said["user"] and said["host"] == "box.lab.example" and said["port"] >= 1
    assert sshmount.info(["10.0.0.5"], "argus.example")["host"] == "argus.example"


def test_the_routes_and_who_may_authorize(tmp_path, monkeypatch):
    monkeypatch.setattr(sshmount.Path, "home", lambda: tmp_path)
    cfg = Config(token="m" * 64, roots=[tmp_path])
    cfg.agents = [{"name": "a", "token": "a" * 64}]
    c = TestClient(create_app(cfg))
    assert c.get("/api/ssh/info", headers={"authorization": "Bearer " + "m" * 64}).json()["user"]
    assert c.post("/api/ssh/authorize", json={"key": KEY}, headers={"authorization": "Bearer " + "a" * 64}).status_code == 403
    assert c.post("/api/ssh/authorize", json={"key": "nope"}, headers={"authorization": "Bearer " + "m" * 64}).status_code == 400
    assert c.post("/api/ssh/authorize", json={"key": KEY}, headers={"authorization": "Bearer " + "m" * 64}).json()["added"]
    assert (tmp_path / ".ssh" / "authorized_keys").read_text().startswith("ssh-ed25519")


def test_one_command_link_lets_one_key_in_once(tmp_path, monkeypatch):
    import subprocess
    monkeypatch.setattr(sshmount.Path, "home", lambda: tmp_path)
    (tmp_path / "data" / "run 1").mkdir(parents=True)
    c = TestClient(create_app(Config(token="m" * 64, roots=[tmp_path])))
    h = {"authorization": "Bearer " + "m" * 64}
    made = c.post("/api/ssh/setup", json={"path": str(tmp_path / "data" / "run 1"), "base": "http://box.lab:8090",
                                          "user": "me", "host": "box.lab"}, headers=h).json()
    assert made["sh"].startswith("curl -fsSLk http://box.lab:8090/ssh-setup/") and made["sh"].endswith(".sh | sh")
    assert made["ps1"].startswith("irm http://box.lab:8090/ssh-setup/") and made["ps1"].endswith(".ps1 | iex")
    ident = made["sh"].split("/ssh-setup/")[1].split(".sh")[0]
    sh = c.get(f"/ssh-setup/{ident}.sh")                       # no token: the link is the secret
    assert sh.status_code == 200 and "sshfs -p 22 me@box.lab:" in sh.text and "'" + str(tmp_path / "data" / "run 1") + "'" in sh.text
    syntax = subprocess.run(["sh", "-n"], input=sh.text, capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr
    ps1 = c.get(f"/ssh-setup/{ident}.ps1").text
    assert "\\\\sshfs.kr\\me@box.lab\\" in ps1 and "net use Z:" in ps1
    assert c.post(f"/ssh-setup/{ident}/key", content=b"not a key").status_code == 400
    assert c.post(f"/ssh-setup/{ident}/key", content=KEY.encode()).status_code == 200
    assert (tmp_path / ".ssh" / "authorized_keys").read_text().count("ssh-ed25519") == 1
    # Run again (it stopped half-way): the same key is fine, and still in once; another key is not.
    assert c.post(f"/ssh-setup/{ident}/key", content=KEY.replace("me@laptop", "again").encode()).status_code == 200
    assert (tmp_path / ".ssh" / "authorized_keys").read_text().count("ssh-ed25519") == 1
    other = KEY.split()[0] + " " + "B" * 68 + " other"
    assert c.post(f"/ssh-setup/{ident}/key", content=other.encode()).status_code == 410, "one key per link"
    assert c.get("/ssh-setup/" + "0" * 32 + ".sh").status_code == 404
    assert c.post("/api/ssh/setup", json={"path": str(tmp_path), "base": "http://x:1", "user": "me; rm -rf ~"}, headers=h).status_code == 400
    assert c.post("/api/ssh/setup", json={"path": "/etc", "base": "http://x:1"}, headers=h).status_code == 403
