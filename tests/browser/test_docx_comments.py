"""A Word document under review, read beside the work: its comments in a margin at the height of their
words, its tracked changes coloured, and a save of the file reloading the window where the reader was
("a docx viewer that shows me the comments and refreshes at once — or I close Pages and open it again
every time", 2026-11-09)."""

from __future__ import annotations

import shutil
import subprocess

import pytest

from app.files import find_pandoc

from .test_flows import eventually
from .test_needs import shoot

pytestmark = pytest.mark.skipif(not find_pandoc(), reason="needs pandoc")

FILLER = "\n\n".join(f"Paragraph {i}: isolates sequenced and typed by cgMLST against the national scheme." for i in range(60))


def review(path, comment):
    md = (f"# Revisione\n\nThe method uses [{comment}]{{.comment-start id=\"0\" author=\"Vale Ferri\" "
          f"date=\"2026-11-08T10:00:00Z\"}}cgMLST distances[]{{.comment-end id=\"0\"}} on all isolates.\n\n"
          f"{FILLER}\n\nNear the end, [a second remark]{{.comment-start id=\"1\" author=\"Andrea\" "
          f"date=\"2026-11-09T09:00:00Z\"}}these clusters[]{{.comment-end id=\"1\"}} are discussed, with "
          f"[an inserted phrase]{{.insertion author=\"Andrea\" date=\"2026-11-09T09:00:00Z\"}} and "
          f"[a deleted one]{{.deletion author=\"Andrea\" date=\"2026-11-09T09:00:00Z\"}}.\n")
    src = path.with_suffix(".md")
    src.write_text(md)
    subprocess.run([find_pandoc(), str(src), "-o", str(path)], check=True)
    src.unlink()


def test_the_comments_of_a_docx_stand_beside_their_words_and_a_save_keeps_the_place(make_page, argus):
    doc = argus.root / "docs" / "manuscript.docx"
    review(doc, "Too vague: which scheme?")
    try:
        page = make_page(route="#/wall")
        page.eval(f"import('/js/tray.js').then(m => m.openWindow({{ kind: 'file', path: {str(doc)!r} }}))")
        page.wait("!!document.querySelector('.win[data-kind=\"file\"] iframe.preview')", timeout=15, what="the document window")
        notes = "[...document.querySelectorAll('.dn-note')]"
        page.frame_eval("manuscript.docx", f"{notes}.length === 2 || Promise.reject('not yet')", timeout=20)
        said = page.frame_eval("manuscript.docx", f"{notes}.map(n => n.querySelector('b').textContent + ': ' + n.querySelector('p').textContent.replace(/\\s+/g, ' ')).join(' | ')")
        assert said == "Vale Ferri: Too vague: which scheme? | Andrea: a second remark", said
        # The commented words are marked, and the comment stands at their height, in the margin.
        marked = page.frame_eval("manuscript.docx", "[...document.querySelectorAll('.dn-anchor[data-id=\"0\"]')].map(a => a.textContent).join('')")
        assert marked == "cgMLST distances", marked
        gap = page.frame_eval("manuscript.docx", """(() => {
            const a = document.querySelector('.dn-anchor[data-id="1"]').getBoundingClientRect();
            const n = document.querySelector('.dn-note[data-id="1"]').getBoundingClientRect();
            return [Math.round(Math.abs(n.top - a.top)), n.left > a.right]; })()""")
        assert gap[0] < 20 and gap[1], (gap, page.frame_eval("manuscript.docx", "[innerWidth, document.body.className]"))
        assert page.frame_eval("manuscript.docx", "!!document.querySelector('.insertion') && !!document.querySelector('.deletion')")

        # "When I click the text I cannot tell which comment we are on" (2026-11-09): the words carry the
        # comment's number, a click lights the comment, draws a line to it and says which one in the bar;
        # ‹ › go from one to the next.
        assert page.frame_eval("manuscript.docx", "[...document.querySelectorAll('.dn-ref')].map(r => r.textContent).join()") == "1,2"
        page.frame_eval("manuscript.docx", "document.querySelector('.dn-anchor[data-id=\"1\"]').click()")
        state = page.frame_eval("manuscript.docx", """[document.querySelector('.dn-where').textContent,
            document.querySelector('.dn-note.on')?.dataset.id, document.querySelector('.dn-wire').classList.contains('on'),
            !!document.querySelector('.dn-wire path').getAttribute('d')]""")
        assert state == ["Comment 2 of 2 · Andrea", "1", True, True], state
        page.frame_eval("manuscript.docx", "document.querySelector('.dn-anchor[data-id=\"1\"]').scrollIntoView({block: 'center'}); 1")
        shoot(page, "docx-chosen")
        page.frame_eval("manuscript.docx", "document.querySelector('.dn-nav button:last-child').click()")
        assert page.frame_eval("manuscript.docx", "document.querySelector('.dn-where').textContent") == "Comment 1 of 2 · Vale Ferri"

        # Read to the second comment, then the file is saved again with that comment changed.
        page.frame_eval("manuscript.docx", "document.querySelector('.dn-anchor[data-id=\"1\"]').scrollIntoView({block: 'center'}); scrollY")
        eventually(lambda: page.frame_eval("manuscript.docx", "scrollY") > 500, timeout=5, what="scrolled down")
        shoot(page, "docx-comments")
        before = page.frame_eval("manuscript.docx", "scrollY")
        review(doc, "Which scheme, and which version?")
        page.frame_eval("manuscript.docx", "document.querySelector('.dn-note p')?.textContent.replace(/\\s+/g, ' ') === 'Which scheme, and which version?' "
                                           "|| Promise.reject('not reloaded yet')", timeout=20)
        eventually(lambda: abs(page.frame_eval("manuscript.docx", "scrollY") - before) < 40, timeout=5,
                   what="back where the reader was")
    finally:
        doc.unlink(missing_ok=True)


def test_a_document_without_comments_gets_looks_and_zoom_but_no_margin(tmp_path):
    from app.files import pandoc_html
    plain = tmp_path / "plain.docx"
    (tmp_path / "plain.md").write_text("# Plain\n\nNothing to review.\n")
    subprocess.run([shutil.which("pandoc") or find_pandoc(), str(tmp_path / "plain.md"), "-o", str(plain)], check=True)
    html = pandoc_html(plain, "docx")
    assert b"Nothing to review." in html and b"dn-look" in html


def test_a_look_and_a_zoom_are_kept_for_the_next_document(make_page, argus):
    """"Themes in the docx viewer" and "a zoom too" (2026-11-09): a look and a zoom chosen once hold for
    every document, and a reload; the comments still stand beside their words when zoomed."""
    doc = argus.root / "docs" / "looks.docx"
    review(doc, "Which scheme?")
    try:
        page = make_page(route="#/wall")
        page.eval(f"import('/js/tray.js').then(m => m.openWindow({{ kind: 'file', path: {str(doc)!r} }}))")
        page.frame_eval("looks.docx", "document.querySelectorAll('.dn-note').length === 2 || Promise.reject('not yet')", timeout=20)
        paper = "getComputedStyle(document.body).backgroundColor"
        page.frame_eval("looks.docx", "(() => { const s = document.getElementById('dn-look'); s.value = 'sepia'; s.dispatchEvent(new Event('change')); })()")
        assert page.frame_eval("looks.docx", paper) == "rgb(244, 236, 216)"
        page.frame_eval("looks.docx", "document.querySelector('.dn-zoom button:last-child').click(); document.querySelector('.dn-zoom button:last-child').click()")
        assert page.frame_eval("looks.docx", "document.querySelector('.dn-pct').textContent") == "125%"
        gap = page.frame_eval("looks.docx", """(() => {
            const a = document.querySelector('.dn-anchor[data-id="0"]').getBoundingClientRect();
            const n = document.querySelector('.dn-note[data-id="0"]').getBoundingClientRect();
            return Math.round(Math.abs(n.top - a.top)); })()""")
        assert gap < 24, gap
        eventually(lambda: argus.api("/api/prefs").get("prefs", {}).get("docZoom") == 1.25
                   or argus.api("/api/prefs").get("docZoom") == 1.25, timeout=8, what="kept")
        shoot(page, "docx-looks")
        # Read again: the same look and zoom.
        page.eval("document.querySelector('.win[data-kind=\"file\"] .winbtn[title=\"Read it again now\"]')?.click()")
        page.frame_eval("looks.docx", "(document.querySelector('.dn-pct')?.textContent === '125%' && document.body.dataset.look === 'sepia')"
                                      " || Promise.reject('not yet')", timeout=15)
    finally:
        doc.unlink(missing_ok=True)
