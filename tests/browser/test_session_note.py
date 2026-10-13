"""A note on a session — what it is for — kept in tmux (@argus_note): shown under its name, found by
the filter, gone with the session, not inherited by a new one of the same name."""

from __future__ import annotations

from .test_flows import eventually

NOTE = "document.querySelector('#view .rowwrap.sess .sessnote')?.textContent || ''"


def test_a_note_says_what_a_session_is_for(make_page, argus):
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "kraken", "-x", "80", "-y", "24")
    page = make_page(route="#/sessions")
    page.wait("!!document.querySelector('#view .rowwrap.sess')", timeout=10)
    page.eval("[...document.querySelectorAll('#view .rowwrap.sess button')].find(b => b.title.startsWith('Add a note')).click()")
    page.wait("!!document.querySelector('dialog.sheet input')", timeout=5)
    page.eval("(() => { const i = document.querySelector('dialog.sheet input'); i.value = 'Kraken paper, revision 2'; })()")
    page.click_text("Save", within="dialog.sheet button")
    page.wait(f"{NOTE} === 'Kraken paper, revision 2'", timeout=10, what="under its name")
    assert argus.tmux("show-options", "-t", "kraken", "@argus_note").stdout.strip() == '@argus_note "Kraken paper, revision 2"'
    assert any(s["note"] == "Kraken paper, revision 2" for s in argus.api("/api/tmux/sessions"))
    # Gone with the session: a new one with the same name starts without it.
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "kraken", "-x", "80", "-y", "24")
    assert all(not s["note"] for s in argus.api("/api/tmux/sessions"))
    argus.kill_sessions()
