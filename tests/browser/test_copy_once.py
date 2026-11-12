"""One selection, one copy: "copied 175 characters appears twice when I select" (2026-11-12). The same text
arrives twice in a moment — the program in the pane says it, and tmux says it too — and is copied once."""

from __future__ import annotations

import time

# A program copying the same text twice in a row through OSC 52, then a different one.
TWICE = r"""printf '\033]52;c;%s\a' $(printf 'samtools view -b' | base64) $(printf 'samtools view -b' | base64); sleep 1; printf '\033]52;c;%s\a' $(printf 'bcftools call' | base64); sleep 600"""


def test_the_same_copy_twice_in_a_moment_is_copied_once(make_page, argus, tmp_path):
    # The program waits until the test says the terminal is there: a fixed delay was too short on CI.
    go = tmp_path / "go"
    argus.tmux("new-session", "-d", "-s", "copier", "-x", "80", "-y", "12",
               f"sh -c 'while [ ! -e {go} ]; do sleep 0.1; done; " + TWICE.replace("'", "'\\''") + "'")
    argus.tmux("set", "-g", "set-clipboard", "on")
    argus.tmux("set", "-as", "terminal-features", ",xterm-256color:clipboard")
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
            {"id": 1, "name": "Copy", "desktop": [{"kind": "term", "name": "copier"}]}]}})
        page = make_page(route="#/wall")
        # The clipboard recorded: a headless browser refuses a copy no click came with, as WebKit does.
        page.eval("navigator.clipboard.writeText = async (text) => { (window.__copies ||= []).push(text); }; 1")
        page.wait("!!document.querySelector('.win[data-session=\"copier\"] .xterm-screen')", timeout=15, what="the terminal")
        time.sleep(1)                   # attached, and drawn once
        go.touch()
        page.wait("(window.__copies || []).includes('bcftools call')", timeout=15, what="the second, different copy")
        time.sleep(0.5)
        assert page.eval("window.__copies") == ["samtools view -b", "bcftools call"]
        said = page.eval("[...document.querySelectorAll('.toast')].map(t => t.textContent).filter(t => t.includes('copied'))")
        assert sum("copied 16 characters" in x for x in said) == 1, said
    finally:
        argus.tmux("set", "-gu", "set-clipboard", check=False)
        argus.tmux("kill-session", "-t", "copier", check=False)
