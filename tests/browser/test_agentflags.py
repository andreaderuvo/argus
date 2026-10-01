"""The New session box offers an agent's options in words, shows the line they make, starts it with
them, and remembers them for next time."""

from __future__ import annotations

from .test_flows import eventually


def test_skip_permissions_is_a_choice_in_words_and_reaches_the_command(make_page, argus):
    page = make_page(route="#/sessions")
    page.click_at(*page._center("[...document.querySelectorAll('button')].find(b => b.textContent.includes('New session'))"))
    page.wait("document.querySelectorAll('.startpick').length === 4", timeout=15, what="the launchers")
    page.click_text("Claude", within=".startpick")
    page.wait("!!document.querySelector('.startchoice.danger')", timeout=25, what="the options, from its --help")
    page.click_at(*page._center("document.querySelector('.startchoice.danger')"))
    line = page.eval("document.querySelector('.startcmd').textContent")
    assert line.endswith("claude --dangerously-skip-permissions"), line
    assert not page.eval("document.querySelector('.startdanger').hidden"), "it says what that means"
    import os
    if os.environ.get("ARGUS_SHOT"):                       # a picture to look at, never asserted on
        page.screenshot(os.environ["ARGUS_SHOT"])
    page.eval("document.querySelector('.startname').value = 'flagged'; document.querySelector('.startname').dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('button.primary.inline')].find(b => b.textContent === 'Start')"))
    eventually(lambda: "flagged" in argus.sessions(), timeout=15, what="the session")
    started = argus.tmux("list-panes", "-t", "flagged", "-F", "#{pane_start_command}").stdout
    assert "--dangerously-skip-permissions" in started
    # Remembered for next time, on the server like every other preference (synced a moment later).
    eventually(lambda: (argus.api("/api/prefs")["prefs"].get("launchOptions") or {}).get("Claude") == {"permissions": "skip"},
               timeout=10, what="the choice to be remembered")
    argus.tmux("kill-session", "-t", "flagged", check=False)
