"""A pressed button keeps its icon visible: the colour it is drawn in against what is behind it. A
rule giving a button the accent while another gave it the accent background made icons vanish —
the PDF lens, a starred prompt (2026-10-13). Toggles are turned on the way a person does, then every
button that is on is measured, in both themes."""

from __future__ import annotations

import time

import pytest

CHECK = """(() => {
  const rgb = (s) => { const m = (s || '').match(/[\\d.]+/g); return m ? m.slice(0, 4).map(Number) : null; };
  const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && (c.length < 4 || c[3] > 0.5)) return c; } return [0, 0, 0]; };
  const bad = [];
  for (const b of document.querySelectorAll('button.on, button[aria-pressed="true"], [role=button].on')) {
    if (!b.offsetParent || !b.querySelector('svg')) continue;
    const path = b.querySelector('svg path') || b.querySelector('svg');
    const cs = getComputedStyle(path);
    const ink = cs.stroke && cs.stroke !== 'none' ? rgb(cs.stroke) : rgb(cs.fill !== 'none' ? cs.fill : getComputedStyle(b).color);
    const r = ratio(ink, bgOf(b));
    if (r < 2.5) bad.push(`${b.className}${b.title ? ' | ' + b.title : ''}: ${r.toFixed(2)}`);
  }
  return bad;
})()"""


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_a_pressed_button_keeps_its_icon_visible(make_page, argus, theme):
    argus.api("/api/prefs", "PATCH", {"changes": {"theme": theme, "templates": [{"name": "fav", "text": "x", "fav": True}]}})
    page = make_page(route=f"#/preview?path={argus.root / 'docs' / 'paper.pdf'}")
    page.wait("!!document.querySelector('button.pdffind')", timeout=15)
    page.eval("document.querySelector('button.pdffind').click()")
    page.wait("document.querySelector('button.pdffind').classList.contains('on')", timeout=5)
    bad = page.eval(CHECK)
    for route in ("#/files", "#/prompts", "#/sessions"):
        page = make_page(route=route)
        time.sleep(1.5)
        bad += page.eval(CHECK)
    assert not bad, bad
