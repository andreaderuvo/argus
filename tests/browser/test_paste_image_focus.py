"""Ctrl+V of a screenshot into a terminal leaves the keyboard in that terminal.

"When I Ctrl+V an image into the prompt, at the end I want the focus back on the prompt"
(2026-11-03). The path was typed into the session and the terminal focused, and then the quiet copy
of the path to the clipboard — a hidden field, on a plain-http address — took the focus and, removed,
left it on the page. The next key went nowhere.
"""

from __future__ import annotations

from .test_flows import eventually

# A 1×1 PNG.
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def test_a_pasted_screenshot_gives_the_keyboard_back_to_the_terminal(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "shot", "-x", "90", "-y", "25")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "shot"}]}]}})
    try:
        page = make_page(route="#/wall")
        term = "document.querySelector('.win[data-session=\"shot\"]')"
        page.wait(f"!!{term}?.querySelector('.xterm-screen')", timeout=20)
        # As on a LAN address over http: no async clipboard, so the copy goes through a hidden field.
        page.eval("Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })")
        page.click_at(*page._center(f"{term}.querySelector('.xterm-screen')"))
        page.wait(f"{term}.contains(document.activeElement)", timeout=5, what="the keyboard in the terminal")

        page.eval(f"""(() => {{
          const bytes = Uint8Array.from(atob({PNG!r}), (c) => c.charCodeAt(0));
          const data = new DataTransfer();
          data.items.add(new File([bytes], 'image.png', {{ type: 'image/png' }}));
          document.activeElement.dispatchEvent(new ClipboardEvent('paste', {{ clipboardData: data, bubbles: true, cancelable: true }}));
        }})()""")
        drops = argus.root / "argus-drops"
        eventually(lambda: any(p.name.startswith("screenshot") for p in drops.glob("*.png")) if drops.exists() else False,
                   timeout=10, what="the screenshot saved")
        page.wait(f"{term}.classList.contains('landed') || {term}.querySelector('.landed')", timeout=10, what="typed in")
        page.wait(f"{term}.contains(document.activeElement) && !!document.activeElement.closest('.xterm')",
                  timeout=3, what="the keyboard still in the terminal after the copy")
    finally:
        argus.tmux("kill-session", "-t", "shot", check=False)
