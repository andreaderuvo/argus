"""What agents can do (#/agents): every tool and action as a sentence you could say, grouped, searchable,
with what each needs and whether it asks you first — "how do I get to know everything argus-mcp can do, in a
friendly way?" (2026-11-12)."""

from __future__ import annotations

import os

from .test_flows import eventually


def shoot(page, name):
    where = os.environ.get("ARGUS_SHOTS")
    if where:
        page.screenshot(os.path.join(where, f"{name}.png"))


def test_the_page_says_what_to_say_finds_and_lets_an_action_through(make_page, argus):
    page = make_page(route="#/agents")
    page.wait("document.querySelectorAll('.agentcangroup').length >= 6", what="the groups")
    assert page.eval("document.querySelectorAll('.agentcancard').length") >= 55
    assert page.eval("[...document.querySelectorAll('.agentcangroup h2')].map(h => h.textContent).join('|')").startswith("Sessions and agents")
    shoot(page, "agentcan")
    # Found by words, in the sentence or the name.
    page.eval("(() => { const f = document.querySelector('.agentcanfind'); f.value = 'downloads'; f.dispatchEvent(new Event('input')); })()")
    page.wait("document.querySelectorAll('.agentcancard').length === 2", what="the two about Downloads")
    page.eval("(() => { const f = document.querySelector('.agentcanfind'); f.value = 'zzz-nothing'; f.dispatchEvent(new Event('input')); })()")
    page.wait("!!document.querySelector('.agentcanlist p.meta')", what="nothing matches, said")
    # An action that asks: let through from here, as in Settings → Agents.
    page.eval("(() => { const f = document.querySelector('.agentcanfind'); f.value = 'to-do 5'; f.dispatchEvent(new Event('input')); })()")
    page.wait("!!document.querySelector('.agentcancard .askchip input')", what="the delete to-do line, with its box")
    page.click_at(*page._center("document.querySelector('.agentcancard .askchip input')"))
    eventually(lambda: "todo_delete" in (argus.api("/api/prefs")["prefs"].get("agentsWithoutAsking") or []), what="kept")
    # Things that need the person's computer say so when none lends them.
    page.eval("(() => { const f = document.querySelector('.agentcanfind'); f.value = 'brew'; f.dispatchEvent(new Event('input')); })()")
    page.wait("[...document.querySelectorAll('.agentcancard .chip.off')].some(c => c.textContent.includes('Actions'))", what="needs Actions, said")


def test_settings_lead_to_it_and_the_rail_has_it(make_page):
    page = make_page(route="#/settings")
    page.wait("!!document.querySelector('a[href=\"#/agents\"]')", what="a way there")
    page.click_at(*page._center("document.querySelector('#nav a[data-tab=\"agents\"]') || document.querySelector('a[href=\"#/agents\"]')"))
    page.wait("location.hash === '#/agents' && !!document.querySelector('.agentcangroup')", what="the page")
