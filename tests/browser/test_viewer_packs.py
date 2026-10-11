"""Viewers anybody can mount for some files (app/viewerpacks.py, static/js/packs.js).

A pack runs in a frame sandboxed at an opaque origin: it is handed the file, may remember a
little, may ask for a save — which Argus does itself, through the jail — and can reach nothing
else: not the API, not the page's storage, not another host. These tests mount one of their
own, in the config's `viewers/` folder, and read what it reports back."""

from __future__ import annotations

import json
import time

import pytest

PROBE = """<!doctype html><meta charset="utf-8"><body>probe<script>
const say = (m) => parent.postMessage(m, '*');
addEventListener('message', async (e) => {
  const m = e.data || {};
  if (m.argus !== 'open') return;
  const tried = {};
  try { await fetch('/api/files?path=/'); tried.fetch = 'reached'; } catch { tried.fetch = 'blocked'; }
  try { localStorage.getItem('x'); tried.storage = 'reached'; } catch { tried.storage = 'blocked'; }
  try { tried.parent = String(parent.document.title); } catch { tried.parent = 'blocked'; }
  try { tried.cookie = document.cookie; } catch { tried.cookie = 'blocked'; }
  say({ argus: 'state', state: { text: m.text, editable: m.editable, theme: m.theme, bg: (m.colors || {}).bg,
        was: (m.state || {}).text || null, words: m.words, ...tried } });
  if (m.editable && m.text.startsWith('make me loud')) say({ argus: 'save', text: m.text.toUpperCase() });
});
say({ argus: 'ready', v: 1 });
</script>"""


@pytest.fixture
def probe_pack(argus):
    folder = argus.config.parent / "viewers" / "probe"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "viewer.json").write_text(json.dumps({
        "name": "probe", "title": "Probe", "files": ["*.probe"], "edits": True,
        "words": {"it": {"Hello": "Ciao"}}}))
    (folder / "index.html").write_text(PROBE)
    broken = argus.config.parent / "viewers" / "Broken"
    broken.mkdir(exist_ok=True)
    (broken / "viewer.json").write_text("{not json")
    yield folder
    for one in (folder, broken):
        for f in one.iterdir():
            f.unlink()
        one.rmdir()


def reported(argus, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        got = (argus.api("/api/prefs")["prefs"].get("viewerState") or {}).get("probe")
        if got:
            return got
        time.sleep(0.1)
    raise AssertionError("the pack never reported")


def test_a_pack_gets_the_file_and_nothing_else(make_page, argus, probe_pack):
    f = argus.root / "hello.probe"
    f.write_text("make me loud\n")
    page = make_page(route=f"#/preview?path={f}")
    page.wait("!!document.querySelector('iframe.packframe')", timeout=10, what="the pack's frame")
    got = reported(argus)
    assert got["was"] is None and got["text"] == "make me loud\n" and got["editable"] is True, got
    assert got["fetch"] == "blocked", "a pack reaches no API"
    assert got["storage"] == "blocked" and got["parent"] == "blocked" and got["cookie"] in ("", "blocked"), got
    assert got["bg"] and got["theme"] in ("dark", "light"), "it is told the page's colours"
    end = time.monotonic() + 10
    while time.monotonic() < end and f.read_text() != "MAKE ME LOUD\n":
        time.sleep(0.1)
    assert f.read_text() == "MAKE ME LOUD\n", "its save is written by Argus"
    assert "frame-src" not in page.eval("document.querySelector('iframe.packframe').getAttribute('sandbox')")
    assert page.eval("document.querySelector('iframe.packframe').getAttribute('sandbox')") == "allow-scripts allow-downloads"


def test_settings_list_packs_and_the_broken_with_their_reason(make_page, argus, probe_pack):
    said = argus.api("/api/viewers")
    assert {"diff", "probe"} <= {p["name"] for p in said["packs"]}
    assert [p for p in said["packs"] if p["name"] == "probe"][0]["source"] == "yours"
    assert said["broken"] and said["broken"][0]["folder"] == "Broken"
    page = make_page(route="#/settings")
    page.wait("document.querySelectorAll('.packlist .packrow').length >= 3", timeout=10)
    text = page.text(".packlist")
    assert "Probe" in text and "Diff" in text and "Broken" in text and "not JSON" in text, text
    opts = page.eval("[...document.querySelector('.setviewers select').options].map(o => o.value)")
    assert "pack:probe" in opts and "pack:diff" in opts, opts


def test_choosing_argus_own_viewer_for_the_extension_wins(make_page, argus, probe_pack):
    f = argus.root / "plain.probe"
    f.write_text("just text\n")
    argus.api("/api/prefs", "PATCH", {"changes": {"viewers": {"probe": "plain"}}})
    page = make_page(route=f"#/preview?path={f}")
    page.wait("document.querySelector('pre.file')?.textContent === 'just text\\n'", timeout=10)
    assert not page.eval("!!document.querySelector('iframe.packframe')")


def test_a_patch_is_drawn_by_the_diff_pack(make_page, argus):
    f = argus.root / "change.diff"
    f.write_text("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2\n")
    page = make_page(route=f"#/preview?path={f}")
    page.wait("!!document.querySelector('iframe.packframe')", timeout=10)
    drawn = page.frame_eval("/viewers/diff/", """new Promise((ok) => { const t0 = Date.now(); (function look() {
        const n = document.querySelectorAll('.d2h-file-wrapper').length;
        if (n || Date.now() - t0 > 8000) ok({ n, sum: document.getElementById('sum').textContent,
          ins: document.querySelectorAll('.d2h-ins').length, kw: document.querySelectorAll('.hljs-keyword').length });
        else setTimeout(look, 100); })(); })""", timeout=15)
    assert drawn["n"] == 1 and "+1" in drawn["sum"] and "−1" in drawn["sum"] and drawn["ins"] >= 1, drawn
    assert drawn["kw"] >= 1, "python coloured, its grammar imported across the opaque origin"
