"""End-to-end through the real ASGI app: the gate, the jail and the error contract."""

import pytest
from fastapi.testclient import TestClient

from app import tmux
from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "hello.txt").write_text("ciao\n")
    (tmp_path / "root" / "blob.bin").write_bytes(b"\x00\x01\x02")
    (tmp_path / "root" / "dir").mkdir()
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_text("nope\n")
    return tmp_path


@pytest.fixture
def client(tree):
    cfg = Config(
        token=TOKEN,
        roots=[tree / "root"],
        max_preview_bytes=1024,
        tmux_socket="tmuxc-test-suite",
    )
    return TestClient(create_app(cfg))


def get(client, url):
    return client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})


def test_the_api_is_closed_without_a_token(client, tree):
    r = client.get(f"/api/files?path={tree / 'root'}")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


def test_a_wrong_token_is_refused(client, tree):
    r = client.get(f"/api/files?path={tree / 'root'}", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_the_query_token_works_for_downloads_and_websockets(client, tree):
    assert client.get(f"/api/files?path={tree / 'root'}&token={TOKEN}").status_code == 200


def test_listing_puts_directories_first(client, tree):
    body = get(client, f"/api/files?path={tree / 'root'}").json()
    assert [e["name"] for e in body] == ["dir", "blob.bin", "hello.txt"]
    assert body[0]["type"] == "directory"


def test_reading_a_text_file(client, tree):
    r = get(client, f"/api/file?path={tree / 'root' / 'hello.txt'}")
    assert r.status_code == 200
    assert r.text == "ciao\n"


def test_binary_files_are_refused_with_the_error_shape(client, tree):
    r = get(client, f"/api/file?path={tree / 'root' / 'blob.bin'}")
    assert r.status_code == 415
    assert "error" in r.json(), "the whole API answers {'error': ...}"


def test_a_big_text_file_arrives_as_its_tail(client, tree):
    """A log outgrowing the cap is the normal case, and its end is the useful part."""
    (tree / "root" / "big.log").write_text("".join(f"line {i}\n" for i in range(500)))
    r = get(client, f"/api/file?path={tree / 'root' / 'big.log'}")
    assert r.status_code == 200
    assert r.headers["x-truncated"] == "tail"
    assert int(r.headers["x-total-size"]) == (tree / "root" / "big.log").stat().st_size
    assert r.text.endswith("line 499\n")
    assert not r.text.startswith("line 0\n"), "the head is what got dropped"
    assert r.text.splitlines()[0].startswith("line "), "never start mid-line"


def test_a_big_binary_file_is_still_refused(client, tree):
    (tree / "root" / "big.bin").write_bytes(b"\x00\x01" * 2048)
    r = get(client, f"/api/file?path={tree / 'root' / 'big.bin'}")
    assert r.status_code == 413


def test_outside_the_roots_is_403_and_missing_inside_is_404(client, tree):
    assert get(client, f"/api/file?path={tree / 'outside' / 'secret.txt'}").status_code == 403
    assert get(client, f"/api/file?path={tree / 'root' / 'gone.txt'}").status_code == 404


def test_a_missing_query_parameter_is_a_400_not_a_422(client):
    r = get(client, "/api/files")
    assert r.status_code == 400
    assert "path" in r.json()["error"]


def test_download_carries_a_safe_content_disposition(client, tree):
    r = get(client, f"/api/download?path={tree / 'root' / 'hello.txt'}")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="hello.txt"')


def test_sessions_endpoint_reports_what_tmux_says(client, monkeypatch):
    monkeypatch.setattr(
        tmux, "list_sessions", lambda sock: [{"name": "claude", "windows": 2, "attached": 0, "created": 1}]
    )
    assert get(client, "/api/tmux/sessions").json()[0]["name"] == "claude"


def test_a_dead_tmux_becomes_a_502_not_a_crash(client, monkeypatch):
    def boom(sock):
        raise tmux.TmuxError("no tmux here")

    monkeypatch.setattr(tmux, "list_sessions", boom)
    r = get(client, "/api/tmux/sessions")
    assert r.status_code == 502 and r.json()["error"] == "no tmux here"


def test_the_frontend_is_served_without_a_token(client):
    """The UI has to load before it can ask the user for one."""
    assert client.get("/").status_code in (200, 503)


def test_a_websocket_without_a_token_never_upgrades(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/tmux/whatever"):
            pass
