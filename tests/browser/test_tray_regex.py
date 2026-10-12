"""The Links window's filter: plain text, or a regular expression with `.*` (kept per desk) or
between slashes; a broken expression is said and the list is left whole."""

from __future__ import annotations

from .test_flows import eventually



def test_the_links_filter_takes_a_regular_expression(make_page, argus):
    links = [{"text": t, "at": 9e12, "count": 1, **({"url": True} if t.startswith("http") else {})}
             for t in ("/data/run1/report.pdf", "/data/run2/a.b.txt", "https://localhost:5002/x", "README.md")]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "links": {"1": links}, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "links"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("!!document.querySelector('.traysearch')", timeout=15)
    count = "document.querySelector('.trayfind .meta').textContent"
    box = "document.querySelector('.traysearch')"
    typed = lambda s: page.eval(f"(() => {{ const b = {box}; b.value = {s!r}; b.dispatchEvent(new Event('input')); }})()")
    typed("a.b")
    page.wait(f"{count} === '1 of 4'", timeout=5, what="plain: the dot a dot")
    typed(r"/\.(pdf|md)$/")
    page.wait(f"{count} === '2 of 4'", timeout=5, what="between slashes: a regex, switch off")
    page.click_at(*page._center("document.querySelector('.trayrx')"))
    typed("run[12]/")
    page.wait(f"{count} === '2 of 4'", timeout=5, what="with the switch: a regex")
    typed("*.pdf")
    page.wait(f"{count} === '1 of 4' && !{box}.classList.contains('bad')", timeout=5,
              what="a file pattern with the switch on: read as one, not refused")
    typed("(unclosed")
    page.wait(f"{count} === 'not a regular expression' && {box}.classList.contains('bad')", timeout=5, what="said")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("trayRegex", {}).get("1") is True, timeout=10, what="kept for the desk")


def test_a_link_shows_its_file_name_first(make_page, argus):
    links = [{"text": "https://example.org/a/very/long/path/that/goes/on/and/on/My%20Report.pdf", "at": 9e12, "count": 1, "url": True},
             {"text": "/mnt/data/projects/salmonella/cgmlst/runs/2026-10-11/results/distance_matrix.tsv", "at": 9e12, "count": 1}]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "links": {"1": links}, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "links"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("document.querySelectorAll('.linkname').length === 2", timeout=15)
    names = page.eval("[...document.querySelectorAll('.linkname')].map(n => n.textContent)")
    assert names == ["My Report.pdf", "distance_matrix.tsv"], names
    # The name is never the part cut: it fits whole even with the window narrow.
    page.eval("document.querySelector('.win[data-kind=\"links\"]').style.width = '300px'")
    assert page.eval("[...document.querySelectorAll('.linkname')].every(n => n.scrollWidth <= n.clientWidth + 1)")
    assert page.eval("document.querySelector('.linkwhere').textContent").startswith("example.org/a/very")
