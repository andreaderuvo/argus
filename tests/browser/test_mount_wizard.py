"""Mount a folder on your own computer: from a starred folder's menu, a wizard whose one-command
link and step-by-step commands are written for that folder, this user and this machine."""

from __future__ import annotations

import json


def test_the_wizard_writes_the_commands_for_the_folder(make_page, argus):
    folder = argus.root / "docs"
    argus.api("/api/favourites", "POST", {"path": str(folder), "group": "main"})
    argus.api("/api/prefs", "PATCH", {"changes": {"railWide": True}})
    try:
        page = make_page(route="#/files")
        row = "[...document.querySelectorAll('#railfavs .railfav')].find(b => b.querySelector('.railname').textContent === 'docs')"
        page.wait(f"!!{row}", timeout=10)
        x, y = page._center(row)
        page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "right", "clickCount": 1})
        page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "right", "clickCount": 1})
        item = "[...document.querySelectorAll('.popmenu .popmenuitem')].find(b => b.textContent.includes('Mount'))"
        page.wait(f"!!{item}", timeout=5, what="Mount on your computer… in the folder's menu")
        page.click_at(*page._center(item))
        page.wait("!!document.querySelector('dialog.mountwizard[open] .mwfast pre')", timeout=10, what="the one-command link")
        fast = page.eval("document.querySelector('.mwfast pre').textContent")
        assert "/ssh-setup/" in fast and ("| sh" in fast or "| iex" in fast), fast

        # Linux: the steps carry the folder and the user; the link is fetched again when a field changes.
        page.eval("[...document.querySelectorAll('.mwtabs button')].find(b => b.textContent === 'Linux').click()")
        page.wait("document.querySelector('.mwfast pre').textContent.includes('| sh')", timeout=5)
        steps = page.eval("[...document.querySelectorAll('.mwsteps pre')].map(p => p.textContent).join('\\n')")
        user = argus.api("/api/ssh/info")["user"]
        assert str(folder) in steps and f"{user}@" in steps and "sshfs" in steps, steps
        page.eval("""(() => { const i = [...document.querySelectorAll('.mwfield')].find(l => l.textContent.startsWith('machine')).querySelector('input');
                     i.value = 'lab.example.org'; i.dispatchEvent(new Event('input')); })()""")
        page.wait("[...document.querySelectorAll('.mwsteps pre')].some(p => p.textContent.includes('@lab.example.org:'))", timeout=5)
        page.wait(f"document.querySelector('.mwfast pre').textContent !== {json.dumps(fast)}", timeout=5, what="a new link for the new machine")

        # Windows: a drive through SSHFS-Win, with the key it reads.
        page.eval("[...document.querySelectorAll('.mwtabs button')].find(b => b.textContent === 'Windows').click()")
        page.wait("document.querySelector('.mwfast pre').textContent.includes('| iex')", timeout=5)
        steps = page.eval("[...document.querySelectorAll('.mwsteps pre')].map(p => p.textContent).join('\\n')")
        assert "sshfs.kr" in steps and "id_rsa" in steps and "Z:" in steps, steps
    finally:
        argus.api("/api/favourites", "POST", {"path": str(folder), "group": "main"})


def test_copy_works_inside_a_sheet_without_the_clipboard_api(make_page, argus):
    """Over plain http to a LAN name there is no navigator.clipboard; the old way's hidden field was
    put in <body>, which a modal sheet makes inert — Copy in the wizard copied nothing on a Mac."""
    page = make_page(route="#/files")
    page.wait("!!document.querySelector('#view')", timeout=10)
    page.eval("Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })")
    page.eval(f"import('/js/mountwizard.js').then(m => m.mountWizard({str(argus.root / 'docs')!r}))")
    page.wait("!!document.querySelector('dialog.mountwizard[open] .mwfast pre')", timeout=10)
    page.eval("document.addEventListener('copy', () => { window.copied = String(getSelection()) || document.activeElement?.value?.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd); }, true)")
    assert page.eval("import('/js/dialogs.js').then(m => m.copyText('hello'))") is True
    assert page.eval("window.copied") == "hello", "what was selected when the copy happened"
