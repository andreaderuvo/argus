"""Remembering a browser: an HttpOnly cookie the server sets, read back at one path only.

The page keeps its token in localStorage, and a phone loses that — Safari deletes script-written
storage after seven days without a visit. The cookie is not a second way in: every other route
still wants the token in a header, and only a full key or a device's key is ever remembered.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

TOKEN = "m" * 64
AGENT = "a" * 64


@pytest.fixture
def app(tmp_path):
    from app.config import Config
    from app.main import create_app

    cfg = Config(token=TOKEN, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.agents = [{"name": "in-session", "token": AGENT}]
    return create_app(cfg)


def test_a_working_token_is_remembered_and_handed_back(app):
    c = TestClient(app)
    said = c.post("/api/remember", headers={"authorization": f"Bearer {TOKEN}"})
    assert said.status_code == 200
    cookie = said.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Path=/api/remember" in cookie
    assert "Max-Age=34560000" in cookie
    back = c.get("/api/remember")                      # no header: the cookie alone
    assert back.status_code == 200 and back.json() == {"token": TOKEN}
    assert back.headers["cache-control"] == "no-store"


def test_the_cookie_opens_nothing_else(app):
    c = TestClient(app)
    c.post("/api/remember", headers={"authorization": f"Bearer {TOKEN}"})
    assert c.get("/api/config").status_code == 401, "a request must still carry the token itself"


def test_a_bad_or_lesser_token_is_never_remembered(app):
    c = TestClient(app)
    assert c.post("/api/remember", headers={"authorization": "Bearer wrong"}).status_code == 401
    assert c.post("/api/remember", headers={"authorization": f"Bearer {AGENT}"}).status_code == 401
    assert c.get("/api/remember").json() == {"token": None}


def test_a_remembered_token_that_stopped_working_is_dropped(app):
    c = TestClient(app)
    c.cookies.set("argus_keep_80", "no-longer-valid", path="/api/remember")
    r = c.get("/api/remember")
    assert r.json() == {"token": None} and "Max-Age=0" in r.headers.get("set-cookie", "")


def test_forgetting(app):
    c = TestClient(app)
    c.post("/api/remember", headers={"authorization": f"Bearer {TOKEN}"})
    assert "Max-Age=0" in c.delete("/api/remember").headers["set-cookie"]
    assert c.get("/api/remember").json() == {"token": None}
