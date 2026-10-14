"""The app's own files: compressed, and revalidated with an ETag instead of sent again whole.

1.9 MB of JavaScript and CSS went out uncompressed on every load, and in full on every reload
(`no-cache` with nothing to revalidate against) — the slowness of an old PC over a VPN."""

from __future__ import annotations

import gzip

from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app


def client(tmp_path):
    return TestClient(create_app(Config(token="m" * 64, roots=[tmp_path])))


def test_compressed_when_asked_and_identical_once_unpacked(tmp_path):
    c = client(tmp_path)
    plain = c.get("/js/wall.js", headers={"accept-encoding": "identity"})
    packed = c.get("/js/wall.js", headers={"accept-encoding": "gzip, deflate, br"})
    assert "content-encoding" not in plain.headers
    assert packed.headers["content-encoding"] == "gzip" and packed.headers["vary"] == "accept-encoding"
    assert packed.content == plain.content, "httpx unpacks it: the same file"
    raw = c.get("/js/wall.js", headers={"accept-encoding": "gzip"}, extensions={})
    assert len(gzip.compress(plain.content)) < len(plain.content) / 3


def test_a_reload_asks_and_gets_304(tmp_path):
    c = client(tmp_path)
    first = c.get("/style.css")
    etag = first.headers["etag"]
    assert first.headers["cache-control"] == "no-cache" and etag
    again = c.get("/style.css", headers={"if-none-match": etag})
    assert again.status_code == 304 and again.content == b""
    assert c.get("/style.css", headers={"if-none-match": '"something-else"'}).status_code == 200
    vendor = c.get("/vendor/xterm-6.0.0/xterm.mjs", headers={"accept-encoding": "gzip"})
    assert vendor.headers["cache-control"].endswith("immutable") and vendor.headers["content-encoding"] == "gzip"
    assert vendor.headers["access-control-allow-origin"] == "*"


def test_images_are_not_recompressed(tmp_path):
    c = client(tmp_path)
    r = c.get("/icon-192.png", headers={"accept-encoding": "gzip"})
    if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/png"):
        assert "content-encoding" not in r.headers


def test_index_gives_every_module_a_versioned_address_and_preloads_it(tmp_path):
    import json
    import re
    c = client(tmp_path)
    html = c.get("/").text
    imports = json.loads(re.search(r'<script type="importmap">\s*(\{.*?\})\s*</script>', html, re.S).group(1))["imports"]
    assert imports["three"].startswith("/vendor/"), "the import map it had is kept"
    wall = imports["/js/wall.js"]
    assert re.fullmatch(r"/js/wall\.js\?v=[0-9a-f]{12}", wall)
    assert f'<link rel="modulepreload" href="{wall}">' in html
    assert re.search(r'<script type="module" src="/app\.js\?v=[0-9a-f]{12}">', html)
    assert re.search(r'href="/style\.css\?v=[0-9a-f]{12}"', html)
    pinned = c.get(wall)
    assert pinned.headers["cache-control"].endswith("immutable") and "export" in pinned.text
    stale = c.get("/js/wall.js?v=000000000000")
    assert stale.headers["cache-control"] == "no-cache", "an old page's address: the current file, not pinned"
    again = c.get("/", headers={"if-none-match": c.get("/").headers["etag"]})
    assert again.status_code == 304
    assert c.get("/files/somewhere").text == html, "an app route is the same page"
