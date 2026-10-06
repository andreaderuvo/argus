# The Argus plugin

Connects an agent to [Argus](https://github.com/andreaderuvo/argus) on the same machine:

- **hooks** — the agent says when a turn starts, when it finishes (with its last words) and when
  it needs you (naming the command it wants to run), so Argus does not have to guess from the pane;
- **MCP tools** — `who`, `ask`, `ring`, `relay`, `start_agent`, `launchers`, `teams`, `worktree`,
  `prompts`: the agent can ask you something and wait for the tap on your phone, start another
  agent in its own worktree, see who else is working.

Argus has to be running on the machine; the plugin reads its address and key from
`~/.config/argus/config.yaml` (or `$ARGUS_CONFIG`).

```text
Claude Code   /plugin marketplace add andreaderuvo/argus
              /plugin install argus@argus
Codex         codex plugin marketplace add andreaderuvo/argus
              codex plugin add argus@argus
Gemini CLI    gemini extensions install https://github.com/andreaderuvo/argus   (MCP tools only;
              its hooks come from Settings → "Let your agents ring" in Argus)
```

Codex runs a plugin's hooks after you review them once, in Codex. The files in `bin/` are copies of
`tools/` in the repository, kept identical by the tests.
