---
name: argus
description: What you can do in Argus for the person — desks, sessions, agents, teams, to-dos, questions — which you do yourself and which you request for their tap (Do it / No). Use whenever asked to do something "in Argus", on a desk, with a session, a team or the to-do list, and before saying something cannot be done.
---

# Acting in Argus

Argus is the web app the person uses to watch the tmux sessions on this machine, often from a
phone. You reach it with the Argus tools (or `argus-say` from a shell). Three kinds of action:

- **Yours** — do it, then say what you did.
- **With their OK** — call `request`; they get the question with **Do it / No** and Argus does it on
  their tap. Never say "I cannot": request it. Give a one-line `why`. If it is still waiting when
  the tool returns, tell them it is waiting for their tap.
- **Not through Argus** — say so in one line, with what they can do instead (below).

## Yours

| Asked | Tool |
|---|---|
| a desk by name: open, make, switch to it | `open_desk` (`folder` optional) |
| rename a desk | `rename_desk` |
| put an existing session on a desk | `open_desk` with `session` |
| start an agent (Claude, Codex, Gemini, a shell), with a prompt, options, in a desk, in a worktree | `launchers` for what exists and its options; `start_agent` |
| who is working or waiting | `who` |
| tell another session something | `relay` (`run` to press Enter) |
| ask the person and wait / tell them you are done | `ask` / `ring` |
| the to-do list: read, add, mark doing/done | `todos`, `todo_add`, `todo_set` |
| teams: how they are doing | `teams` |
| design a team | `team_check`, then `team_propose` (skill `argus-team-author`) |
| in a team: your task, your report | `team_task`, `team_done` (skill `argus-team`) |
| a git worktree | `worktree` |
| their saved prompts | `prompts` |
| files | your own tools — you work on the disk directly |

## With their OK — `request`

| Asked | action | args |
|---|---|---|
| start a team, in a desk | `start_team` | `team` (a proposal, one of their models, or a template: Optimise, Fix a bug, Build and review, Write, Tournament, Split the work, Feature with tests), `desk`, `folder` (else the proposal's or the desk's), `goal` (else the team's own), `gate` (ask / auto / goal), `permissions` (ask / edit / everything), `check` (if a check step has no command) |
| continue, pause, stop a team | `team_go`, `team_pause`, `team_stop` | `team` (its name); `kill: true` also ends its sessions |
| end a session | `kill_session` | `session` |
| rename a session | `rename_session` | `session`, `to` |
| start an agent with no questions at all | `start_agent` | `launcher`, `name`, `path`, `prompt`, `options` (`{"permissions": "skip"}` …) |
| remove a worktree | `remove_worktree` | `path` |
| delete a to-do | `todo_delete` | `todo` (its number) |

A request that cannot be done as asked (no such team, no goal…) is refused at once with the
reason — fix it and request again; nothing was put to the person.

## Not through Argus

- **Read another session's screen** — never; ask that agent to write to a file, or `relay` to it.
- **Answer a question meant for the person** — never.
- **Arrange, close or remove desks and windows; change their settings or prompts; open ports;
  tokens, devices, the journal, tmux config, installing the plugin, stopping Argus** — theirs, in
  the app (Settings, the desk's tab, the Ports screen).
- **Change a running team's graph** — for nobody: stop it and start the changed one.
