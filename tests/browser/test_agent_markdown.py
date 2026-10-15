"""An agent's question is Markdown — lists, bold, code — and is drawn as such, in the card and in
While you were away; and its markup is text, never HTML (the page holds the token)."""

from __future__ import annotations

ASKED = ("Two ways to go:\n\n"
         "- **merge** the branch `fix/len`\n"
         "- keep it for *later*\n\n"
         "```\nA -> B\n```\n\n"
         "<img src=x onerror=\"window.pwned=1\"> and <b>not bold</b>")


def test_a_question_is_drawn_as_markdown_and_never_as_html(make_page, argus):
    said = argus.api("/api/ask", "POST", {"text": ASKED, "options": ["Merge", "Later"], "session": "agent-1"})
    page = make_page(route="#/files")
    card = "document.querySelector('.toast.askcard .agentmd')"
    page.wait(f"!!{card}?.querySelector('li')", timeout=15, what="the card, drawn")
    assert page.eval(f"{card}.querySelectorAll('li').length") == 2
    assert page.eval(f"{card}.querySelector('strong').textContent") == "merge"
    assert page.eval(f"{card}.querySelector('li code').textContent") == "fix/len"
    assert page.eval(f"{card}.querySelector('pre code').textContent.trim()") == "A -> B"
    assert page.eval(f"!{card}.querySelector('img') && !{card}.querySelector('b')"), "markup stays text"
    assert "<b>not bold</b>" in page.eval(f"{card}.textContent")
    assert not page.eval("window.pwned")
    page.eval("location.hash = '#/since'")
    page.wait("[...document.querySelectorAll('#view .agentmd')].some(m => m.querySelector('li'))", timeout=15,
              what="the same question, drawn, in While you were away")
    argus.api(f"/api/ask/{said['id']}/answer", "POST", {"answer": "Later"})


def test_a_bell_with_words_is_drawn_as_markdown_too(make_page, argus):
    """The toasts in the corner — "finished", "waiting", with what the agent said — not only the questions."""
    page = make_page(route="#/files")
    page.eval("window.__ready = true")
    argus.api("/api/bell", "POST", {"session": "agent-2", "why": "done",
                                    "text": "Done:\n\n- **3 tests** fixed\n- `total.ts` now applies the coupon first\n\n<img src=x onerror=\"window.pwned=2\">"})
    toast = "[...document.querySelectorAll('.toast:not(.askcard)')].find(t => t.textContent.includes('agent-2'))"
    page.wait(f"!!{toast}?.querySelector('.agentmd li')", timeout=15, what="the bell's toast, drawn")
    assert page.eval(f"{toast}.querySelector('strong').textContent") == "3 tests"
    assert page.eval(f"{toast}.querySelector('code').textContent") == "total.ts"
    assert page.eval(f"{toast}.querySelector('b').textContent") == "agent-2: "
    assert page.eval(f"!{toast}.querySelector('img')") and not page.eval("window.pwned")
