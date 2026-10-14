"""A folder of thousands of files shows its top at once and the rest without blocking, and a
row not drawn yet can still be pointed at (measured 8.6 s before, on a 6x slowed CPU)."""

from __future__ import annotations

import time


def test_a_long_folder_shows_at_once_and_fills_in(make_page, argus):
    big = argus.root / "long"
    big.mkdir(exist_ok=True)
    for i in range(3000):
        (big / f"sample_{i:05d}.fastq.gz").write_bytes(b"")
    page = make_page(route="#/files")
    page.send("Emulation.setCPUThrottlingRate", {"rate": 6})
    t = time.time()
    page.eval(f"location.hash = '#/files?path={big}'")
    page.wait("document.querySelectorAll('#view .panelist .row').length >= 100", timeout=30)
    first = time.time() - t
    page.wait("document.querySelectorAll('#view .panelist .row').length === 3000", timeout=60, what="every row, in the end")
    page.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    assert first < 2.5, f"the top of the folder took {first:.1f}s"
    names = page.eval("[...document.querySelectorAll('#view .panelist .row .name')].map(n => n.textContent)")
    assert names == sorted(names) and len(set(names)) == 3000, "in order, each once"
    # The last row, pointed at from a terminal, is found even if it was drawn last.
    page.eval(f"location.hash = '#/files?path={argus.root}'")
    page.wait("!!document.querySelector('#view .panelist .row')")
    target = str(big / "sample_02999.fastq.gz")
    page.eval(f"import('/js/pointing.js').then(m => m.pointAt({target!r}))")
    page.wait("[...document.querySelectorAll('.panelist .row.pointed .name')].some(n => n.textContent === 'sample_02999.fastq.gz')",
              timeout=15, what="the last row of the folder, found and flashed")


def test_a_newer_listing_stops_an_older_one(make_page, argus):
    big = argus.root / "long2"
    big.mkdir(exist_ok=True)
    for i in range(2000):
        (big / f"x_{i:05d}.txt").write_bytes(b"")
    page = make_page(route="#/files")
    page.eval(f"location.hash = '#/files?path={big}'")
    page.wait("document.querySelectorAll('#view .panelist .row').length >= 100")
    page.eval(f"location.hash = '#/files?path={argus.root}'")
    time.sleep(1.5)
    names = page.eval("[...document.querySelectorAll('#view .panelist .row .name')].map(n => n.textContent)")
    assert not any(n.startswith("x_") for n in names), "nothing of the folder left behind"
