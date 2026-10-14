"""JSON answers are compressed; files, downloads and streams are not."""

from __future__ import annotations

import gzip

from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

M = {"authorization": "Bearer " + "m" * 64}


def test_a_big_listing_is_compressed_and_a_download_is_not(tmp_path):
    big = tmp_path / "big"
    big.mkdir()
    for i in range(400):
        (big / f"file_{i:04d}.txt").write_text("x")
    (tmp_path / "reads.fastq").write_bytes(b"ACGT" * 5000)
    c = TestClient(create_app(Config(token="m" * 64, roots=[tmp_path])))
    listing = c.get(f"/api/files?path={big}", headers={**M, "accept-encoding": "gzip"})
    assert listing.headers["content-encoding"] == "gzip" and len(listing.json()) == 400
    raw = c.get(f"/api/files?path={big}", headers={**M, "accept-encoding": "identity"})
    assert "content-encoding" not in raw.headers and raw.json() == listing.json()
    down = c.get(f"/api/download?path={tmp_path / 'reads.fastq'}", headers={**M, "accept-encoding": "gzip"})
    assert down.status_code == 200 and "content-encoding" not in down.headers and down.content == b"ACGT" * 5000
    small = c.get("/api/config", headers={**M, "accept-encoding": "gzip"})
    assert "content-encoding" not in small.headers, "under one packet: not worth it"


def test_what_travels_is_really_smaller(tmp_path):
    big = tmp_path / "big"
    big.mkdir()
    for i in range(400):
        (big / f"file_{i:04d}.txt").write_text("x")
    c = TestClient(create_app(Config(token="m" * 64, roots=[tmp_path])))
    with c.stream("GET", f"/api/files?path={big}", headers={**M, "accept-encoding": "gzip"}) as r:
        wire = b"".join(r.iter_raw())
    assert len(wire) < len(gzip.decompress(wire)) / 4
