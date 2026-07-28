# CLAUDE.md — tmux-companion

Python + FastAPI backend serving a mobile-first vanilla-JS PWA to browse files and attach
to tmux sessions from a phone, with a **real PTY** (not capture-pane polling). No build
step, no bundler: the frontend is plain ES modules and xterm.js is vendored.

## ⚠️ Never touch the default tmux socket

This machine's tmux server holds long-running work (AI agents, benchmarks). A tmux server
that dies takes **every session on its socket** with it — that already happened once, on
2026-07-27, and cost 9 sessions.

Therefore, for anything in this repo:

```bash
# running the server in dev — always pin a throwaway socket
python3 -m app.main --config /tmp/tmuxc-test.yaml --socket tmuxc-test --listen 127.0.0.1:8399

# any tmux command you type while testing — always -L
tmux -L tmuxc-test new-session -d -s probe -x 90 -y 25
tmux -L tmuxc-test kill-server          # safe: only the test server
```

A bare `tmux …`, or the app with no `tmux_socket`/`--socket`, drives the real server. The
socket is printed in the startup banner (`tmux    socket …`) — check it before testing.

Also: `pgrep -f`/`pkill -f` with a pattern that appears in your own command line kills the
shell running it. Write `pgrep -f 'app[.]main'`, never `pgrep -f 'app.main'`.

## ⚠️ `tmux capture-pane -p` crashes tmux on this host

`tmux-3.3a-13.20230918gitb202a2f.el10` has heap corruption in `cmd_capture_pane_exec`:

```
free() → malloc_printerr → abort      #7 cmd_capture_pane_exec
```

Reproducible on the **first** `capture-pane -p` against a freshly created server, no
attach needed. It aborts the whole server, killing every session on that socket. Prior
occurrences: 2026-07-17 (×2, during benchmarks), 2026-07-27 (×2).

Do not run `capture-pane -p` anywhere on this host, even on a test socket, unless you mean
to lose that server. The app never calls it — verify that stays true (`grep -rn capture
app/`). This is also why the product does a real PTY instead of capture-pane polling.

## Run & test

```bash
python3 -m pytest -q                       # 62 tests, no tmux server required
python3 -m app.main --help
python3 -m app.main --listen 0.0.0.0:8090  # config auto-created on first run
python3 -m app.main --print-url            # the URL including the token
```

Dependencies are already in the conda base env (fastapi, uvicorn, pyyaml, pytest, httpx);
`requirements.txt` lists them for anywhere else.

## Layout

```
app/main.py       CLI (argparse), app assembly, static handler, banner
app/config.py     YAML config + first-run token generation; `tmux_socket`, `allow_write`
app/auth.py       Bearer header + ?token=, raw ASGI so it also gates WebSockets
app/safepath.py   path jail — canonicalize, then prefix-check the roots. The critical module.
app/files.py      list / read / download / search, document text, tail of big files
app/fsops.py      mkdir / rename / move / copy / delete — refused unless allow_write
app/tmux.py       Socket (-L/-S) + list-sessions parsing
app/term.py       PTY ↔ WebSocket bridge
static/           index.html, app.js, style.css, sw.js, vendor/{xterm-6.0.0,marked-18.0.7}
legacy-rust/      the original axum implementation, kept for reference
```

The frontend is one ES module, no bundler and no build step. Editing `static/` and
reloading is the whole loop — only Python changes need the server restarted.

## Frontend notes

- **Preferences** live in `localStorage` under `tmuxc.prefs`: theme, hidden files, sidebar,
  tree view, wall layout, per-session colours, font size, wrap.
- **Theme** is resolved in JS (including `auto`) onto `data-theme`, so the stylesheet has
  one palette block per theme and no media queries. An inline script in `<head>` replays
  the choice before first paint, otherwise a dark-theme user gets a white flash.
- **Session colours** default to a hash of the session name, so they are stable across
  reloads and devices with nothing stored; an override goes in `prefs.colors`.
- **The wall** (`#/wall`) tiles with CSS grid. Each terminal has a `ResizeObserver` on its
  own container, so changing layout re-fits and tells tmux the new size by itself.
- **Markdown** is escaped *before* `marked` parses it, and surviving links/images are
  re-checked — a hostile `.md` must not run script in a page holding the token.
- **Service worker** waits rather than calling `skipWaiting()`, so an update is announced
  and applied on request instead of reloading under someone's fingers. It only registers
  in a secure context: over plain http to a LAN address there is no worker and no install.

## Design notes

- **Auth must be raw ASGI.** Starlette's `BaseHTTPMiddleware` never sees WebSocket
  connections, and the terminal is a WebSocket. Closing before accept makes the handshake
  fail with an HTTP error instead of upgrading.
- **`os.path.exists`, not `Path.exists()`** in the jail: on Python 3.13 the pathlib one
  propagates `PermissionError`, which would turn a 403 into a 500.
- **PTY**: `pty.openpty` → set winsize on the slave → `fork` → `os.login_tty` (3.11+) →
  `execvpe`. Without a controlling terminal tmux refuses to attach. A reader thread does
  blocking reads into a bounded `asyncio.Queue`, so a slow client backpressures the PTY
  instead of ballooning memory.
- **Resize**: the plan's `grouped_attach` idea does not work — grouped sessions share their
  windows and therefore their size. Replaced by `resize_policy: adapt | preserve`, where
  `preserve` attaches with `-f ignore-size` so other clients keep their geometry.
- **Session names** reach tmux as argv (never a shell string), and are gated against
  `list-sessions` on the configured socket, so a client can only reach sessions we listed.
- **Disconnect** kills our attach client only — the tmux session and its processes survive.
  That is the entire point of the product.
- **Service worker** only registers over HTTPS (secure context), so plain http on a LAN
  address works fine but cannot be installed as an offline PWA.

## State (2026-07-28)

Feature-complete against everything asked for so far; **82 tests green**. Running on
`0.0.0.0:8090` with `--allow-write`.

Verified end to end against an isolated tmux socket: keystrokes, output, resize
propagation (a 100×30 client gives tmux 100×29 — the status line takes a row), session
survival on disconnect, a clean refusal for unknown sessions. The file operations were
smoke-tested against the live server, and the frontend was loaded in headless chromium
(`~/.cache/ms-playwright/chromium-1140/chrome-linux/chrome --headless --dump-dom`) to
confirm it boots with zero console errors and that the wall renders one window per
session. No git commits yet.

Deliberately not built: file upload, and any editing of file contents.
