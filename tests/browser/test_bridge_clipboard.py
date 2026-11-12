"""Inside argus-bridge's window the clipboard is the computer's own, written through the app.

"Selected in tmux, it says copy to clipboard, then ⌘V pastes nothing" (2026-11-12): WebKit refuses a clipboard
write that no click came with, and a copy made in tmux arrives on its own. argus-bridge (0.1.22) lets the Argus
window write text to the clipboard natively; the page uses it when it is there, and the browser's ways when not.
"""

from __future__ import annotations


def test_a_copy_goes_through_argus_bridge_when_the_page_is_inside_it(make_page):
    page = make_page()
    page.eval("""window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => { (window.__asked ||= []).push([cmd, args.text]); } }; 1""")
    assert page.eval("import('/js/dialogs.js').then(m => m.copyText('samtools view -b'))") is True
    assert page.eval("window.__asked") == [["plugin:clipboard-manager|write_text", "samtools view -b"]]


def test_an_older_argus_bridge_without_the_clipboard_falls_back_to_the_browser(make_page):
    page = make_page()
    page.eval("""window.__TAURI_INTERNALS__ = { invoke: async () => { throw new Error('not allowed'); } }; 1""")
    # The browser's own ways answer, as they would anywhere else (headless Chromium copies on execCommand).
    assert page.eval("import('/js/dialogs.js').then(m => m.copyText('hello'))") is True
