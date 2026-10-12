"""File icons: one per kind of file (Material Icon Theme), Argus's own for genomics, the same in
Files and Links; off in Settings, the line icons with their extension badge."""

from __future__ import annotations

from .test_flows import eventually



def test_files_and_links_wear_the_icon_of_their_kind(make_page, argus):
    d = argus.root / "kinds"
    d.mkdir(exist_ok=True)
    for n in ("reads_R1.fastq.gz", "score.py", "core.nwk", "main.nf"):
        (d / n).write_text("x")
    page = make_page(route=f"#/files?path={d}")
    page.wait("document.querySelectorAll('img.fimg').length >= 4", timeout=15, what="coloured icons")
    srcs = page.eval("Object.fromEntries([...document.querySelectorAll('.row')].filter(r => r.querySelector('.name')).map(r => [r.querySelector('.name').textContent.trim(), r.querySelector('img.fimg')?.getAttribute('src') || '']))")
    assert srcs["reads_R1.fastq.gz"].endswith("/img/fileicons/sequence.svg"), srcs
    assert srcs["core.nwk"].endswith("/fileicons/tree.svg") and srcs["main.nf"].endswith("/fileicons/pipeline.svg"), srcs
    assert "/material-icon-theme-" in srcs["score.py"] and srcs["score.py"].endswith("/python.svg"), srcs
    assert page.eval("[...document.querySelectorAll('img.fimg')].every(i => i.complete && i.naturalWidth > 0)"), "every icon loaded"

    links = [{"text": "https://example.org/files/My%20Report.pdf", "at": 9e12, "count": 1, "url": True},
             {"text": "http://localhost:5002/", "at": 9e12, "count": 1, "url": True}]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "links": {"1": links}, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "links"}]}]}})
    wall = make_page(route="#/wall?ws=1")
    wall.wait("document.querySelectorAll('.trayrow').length === 2", timeout=15)
    assert wall.eval("document.querySelectorAll('.trayrow')[0].querySelector('img.fimg')?.getAttribute('src') || ''").endswith("/pdf.svg")
    assert wall.eval("!document.querySelectorAll('.trayrow')[1].querySelector('img.fimg')"), "a URL to no file keeps the link"


def test_off_in_settings_the_plain_icons_come_back(make_page, argus):
    d = argus.root / "kinds2"
    d.mkdir(exist_ok=True)
    (d / "score.py").write_text("x")
    argus.api("/api/prefs", "PATCH", {"changes": {"fileIcons": "simple"}})
    page = make_page(route=f"#/files?path={d}")
    page.wait("!!document.querySelector('.row svg.ficon')", timeout=15)
    assert not page.eval("!!document.querySelector('img.fimg')")
