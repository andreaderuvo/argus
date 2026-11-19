"""The New session box says when Claude Code, Codex or Gemini is out of date, with Update ("it does not tell me
they are old — and a button that updates them", 2026-11-19). The server's two answers are given in the page
here: the real ones ask npm and run an install (tests/test_agentupdate.py tests that side)."""

from __future__ import annotations

import os

FAKE = """(() => {
  const real = window.fetch;
  window.__updated = [];
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, init) => {
    if (String(url).includes('/api/agents/updates')) return json({ agents: [
      { agent: 'claude', name: 'Claude Code', installed: '2.1.9', latest: '2.2.0', outdated: true, how: 'claude', command: 'claude update' },
      { agent: 'codex', name: 'Codex', installed: '0.160.0', latest: '0.160.0', outdated: false, how: 'npm', command: 'npm install -g @openai/codex@latest' },
      { agent: 'gemini', name: 'Gemini', installed: '0.6.0', latest: '0.9.0', outdated: true, how: '', command: '' },
    ] });
    if (String(url).includes('/api/agents/update')) { window.__updated.push(JSON.parse(init.body).agent);
      return json({ ok: true, installed: '2.2.0', agent: 'claude', command: 'claude update', code: 0, output: '' }); }
    return real(url, init);
  };
  return 1;
})()"""


def test_an_old_agent_is_said_in_the_new_session_box_and_updated_with_a_press(make_page):
    page = make_page(route="#/sessions")
    page.eval(FAKE)
    page.click_at(*page._center("[...document.querySelectorAll('button')].find(b => b.textContent.includes('New session'))"))
    page.wait("document.querySelectorAll('.agentupdate').length === 2", timeout=20, what="the two out of date, not the one that is not")
    rows = page.eval("[...document.querySelectorAll('.agentupdate')].map(r => r.textContent)")
    assert "Claude Code" in rows[0] and "2.1.9" in rows[0] and "2.2.0" in rows[0], rows
    assert "update it the way you installed it" in rows[1], "no button when how it was installed is not known"
    if os.environ.get("ARGUS_SHOTS"):
        page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "agent-updates.png"))
    page.click_at(*page._center("document.querySelector('.agentupdate button')"))
    page.wait("!!document.querySelector('.agentupdate.done')", what="updated, and said")
    assert page.eval("window.__updated") == ["claude"]
    assert "2.2.0" in page.eval("document.querySelector('.agentupdate.done').textContent")
