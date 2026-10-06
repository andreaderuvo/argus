"""Closing a desk can end its sessions too — only when you tick the box, and only the sessions no
other desk is still showing."""

from __future__ import annotations

from .test_flows import eventually


def sessions(argus):
    done = argus.tmux("list-sessions", "-F", "#S", check=False)
    return set(done.stdout.split()) if done.returncode == 0 else set()


def setup(argus):
    argus.kill_sessions()
    for name in ("only-here", "shared", "keep"):
        argus.tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 2, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "shared"}, {"kind": "term", "name": "keep"}]},
        {"id": 2, "name": "Scratch", "desktop": [{"kind": "term", "name": "only-here"}, {"kind": "term", "name": "shared"}]},
    ]}})


def close_scratch(page, tick):
    page.wait("!!document.querySelector('.wstab[data-ws=\"2\"] .tabclose[title=\"Close this workspace\"]')", timeout=10, what="the close button")
    page.click_at(*page._center("document.querySelector('.wstab[data-ws=\"2\"] .tabclose[title=\"Close this workspace\"]')"))
    page.wait("!!document.querySelector('.confirmcheck')", timeout=5, what="the box offering to end its sessions")
    text = page.eval("document.querySelector('.confirmcheck').textContent")
    assert "only-here" in text and "shared" not in text, "a session another desk shows is not offered"
    if tick:
        page.click_at(*page._center("document.querySelector('.confirmcheck input')"))
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Close')"))
    page.wait("!document.querySelector('.wstab[data-ws=\"2\"]')", timeout=10, what="the desk gone")


def test_closing_a_desk_keeps_its_sessions_unless_you_tick_the_box(make_page, argus):
    setup(argus)
    page = make_page(route="#/wall?ws=2")
    close_scratch(page, tick=False)
    assert sessions(argus) == {"only-here", "shared", "keep"}, "unticked: every session still running"
    argus.kill_sessions()


def test_ticked_it_ends_only_the_sessions_no_other_desk_shows(make_page, argus):
    setup(argus)
    page = make_page(route="#/wall?ws=2")
    close_scratch(page, tick=True)
    eventually(lambda: sessions(argus) == {"shared", "keep"}, timeout=10, what="only-here ended, the rest kept")
    argus.kill_sessions()
