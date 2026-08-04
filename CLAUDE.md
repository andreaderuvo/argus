# CLAUDE.md — argus

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
python3 -m app.main --config /tmp/argus-test.yaml --socket argus-test --listen 127.0.0.1:8399

# any tmux command you type while testing — always -L
tmux -L argus-test new-session -d -s probe -x 90 -y 25
tmux -L argus-test kill-server          # safe: only the test server
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
```

The frontend is one ES module, no bundler and no build step. Editing `static/` and
reloading is the whole loop — only Python changes need the server restarted.

## Frontend notes

- **Editing the tmux config** lives at `#/tmuxconf` (Settings → tmux configuration): the
  ordinary editor on `tmux.conf_path()`, plus "apply to every session". Applying is one
  `source-file` — tmux options belong to the *server*, so there is nothing to do per
  session — but sourcing **runs** the file, and a bad line can end the server holding all
  the work. So `check_conf()` tries it first on a throwaway socket (`argus-conf-check`):
  a bare server with `-f /dev/null`, then the same `source-file`. Starting that test
  server with `-f <path>` instead does *not* work — tmux shows those errors in the
  client's window, so a broken file came back looking fine. And the complaint arrives on
  **stdout**, not stderr; reading the wrong stream loses the line number.

- **A phone keyboard commits a word twice.** Android's predictive input delivers the
  commit as its own input event on top of what the composition already produced, so tmux
  received the word, then the word again. `attachTerminal` records the text of each
  `compositionend` and drops a *second* identical chunk within 250ms of it — the first one
  always goes through, because a keyboard that does not duplicate would otherwise lose the
  word entirely. Reproducible with CDP: `Input.imeSetComposition` then two
  `Input.insertText` gives `["listeria","listeria"]` without the guard and `["listeria"]`
  with it, while ordinary keystrokes stay `["l","s"]`.
- **No button in a title bar is a drag handle.** `dragBy` used to skip an explicit list of
  the four buttons that existed when it was written; every button added since — the
  viewer's download, edit, source and watch, the terminal's copy and size — began a drag
  instead. `setPointerCapture` then retargets the release, so the events read
  `pointerdown -> Download`, `pointerup -> DIV`, `click -> DIV`: the button is pressed and
  the click is delivered to the bar. It now skips anything inside a `button`.
- **URLs in a session are clickable too**, not only paths: xterm ships no web-link
  provider and ours skipped anything with `://`. The interesting case is a loopback URL —
  an agent saying "serving on http://localhost:5002" — because on the phone reading it,
  localhost is the phone. Argus is already on the right machine, so it opens the port and
  serves it through `/proxy/<port>/` instead. That decision reads `allow_proxy`, which
  `/api/config` did not expose; the ports screen got it from `/api/ports`, so a clicked
  link saw "off" and refused.
- **Markdown figures** are resolved against the document's folder and fetched through
  `/api/file` — the jail still decides what can be read. They used to be deleted outright
  (anything not `http(s):`), which quietly threw away the plots that are the point of a
  report.
- **PDF search** is `pdftotext -q -- file -` split on form feeds, so one pass gives every
  page in order and "which page is this on" becomes answerable. `NoExtractor` and
  `Unreadable` are separate: telling someone the server cannot search PDFs when the truth
  is that *this* PDF is damaged sends them looking in the wrong place. A PDF with no text
  at all says it is probably a scan.
- **A paste has to be legible.** The upload of a screenshot is over in a blink, so
  without help nothing on screen changes long enough to be seen. Three stages, one each:
  the destination pane lights for 700ms, the progress bar stays up for `BAR_MINIMUM`
  (1.4s) and ends reading "saved screenshot-3.png", and the new row is revealed and
  flashed — the same gesture a path clicked in a terminal gets. Deliberately *one* channel
  at the bottom of the screen: a toast and the bar share that corner and covered each
  other.
- **Pasting an image** goes through the ordinary upload with a `sequence` field: the
  server picks the first free `screenshot-N.ext`, because the clipboard offers the same
  "image.png" every time and the folder is the only thing that knows what is taken. The
  paste handler ignores events from inputs, textareas and terminals — those own their own
  paste — and targets the last pane touched.
- **`drawTree` builds into a fragment and swaps it in.** It used to empty the container
  and *then* await: two draws racing (a reload plus `refreshAllBrowsers`) each cleared and
  each appended, and the folder listed everything twice. `paint()` also carries a
  generation counter so a slow answer cannot land on top of a newer one.
- **A listing notices files it did not create.** `/api/files` is fetched once per folder,
  and the app only refreshed after *its own* operations — a file written by a job in tmux
  never passed through it, so the folder just sat there. A 5s watcher re-asks and redraws
  only when the signature (`name:size:mtime` per entry) differs, so the scroll position
  survives; it stops itself when the pane leaves the DOM, since nothing calls a teardown.
  Flat listings only: re-running a tree would close every branch you opened, so the tree
  has the refresh button instead.

- **Each desk can have its own folder** (`ws.home`): the Browser button and a session
  started from the desk both begin there instead of the global home. Set from the tab
  menu, which offers the roots *and* the folders the desk's browsers already show —
  usually the one meant.
- **The window list** (`windowSheet`) exists because a free-floating window can end up
  completely behind another one, and then nothing on screen says it is there. A window is
  called `hidden` only when something in front of it covers it corner to corner —
  overlapping a little is the normal state of a desk — and `off the desk` when it has
  drifted past the edge. Raising one also drags it back inside, and flashes it, because
  raising a window that was already on top would otherwise answer with nothing.

- **Desk tabs drag to reorder, and pin.** `reorderTab()` starts only once the pointer has
  travelled 8px, which leaves a tap (activate), a double-click (rename) and a hold (menu)
  alone; `slideInto()` FLIP-animates the neighbours so you can see what moved. The click
  that follows a drag is suppressed with a `data-dragged` flag, or the drop would also
  switch desk. The move/up listeners live on `window` and there is no `setPointerCapture`
  on purpose: reordering removes the tab from the document for an instant to reinsert it,
  and a captured element that leaves the document loses its capture — which stopped every
  drag dead after exactly one swap. `ws.pinned` keeps a desk at the front — `saveTabOrder()` sorts pinned
  first whatever the drag said — and a pinned tab loses its ✕: unpin it first.

- **Copying out of tmux.** A selection made with tmux's own mouse mode lands in a *tmux*
  paste buffer on the server, which the browser cannot see — that is what "copied 26
  chars" means. `/api/tmux/buffer` reads it back with `show-buffer` (never `capture-pane`,
  see above), and the copy button in the key bar prefers `term.getSelection()` and falls
  back to that buffer. The click is the user gesture the clipboard needs, so `copyText`'s
  execCommand path works on the plain-http LAN address where `navigator.clipboard` does
  not exist; if even that is refused, `showText()` hands the text over selected. OSC 52 is
  also honoured, which covers `set -g set-clipboard on`.

- **Full screen** is the header's ⤢ button (`#fullscreen`), hidden where the browser has
  no Fullscreen API — an iPhone, notably — rather than sitting there doing nothing. The
  icon and title follow `fullscreenchange`, not the click, so leaving by Esc or F11 keeps
  them honest. The terminal needs no telling: the viewport resizing resizes its container.

- **Word documents go through pandoc** when the machine has it: `/api/file` answers with
  rendered HTML (`x-rendered: document`) under the same CSP sandbox as any other HTML, and
  `--embed-resources` inlines the figures so nothing is fetched. Missing, failing, or over
  12 MB of output falls back to the stdlib text extraction — pandoc is never a
  requirement. `find_pandoc()` also looks beside `sys.executable`, because a systemd
  service has a bare PATH and every tool here lives in conda.

- **A file opened from a desk stays in the desk.** `fileBrowser`'s `openFile` checks
  `live?.key === 'wall'`: on the wall the file becomes a window beside the one it came
  from, everywhere else (Files screen, phone) it takes the screen as before. `beside()`
  picks the side that *covers least*, not the widest one — on a full desk the widest side
  is usually where another window already is. Off with `openInDesk` in Settings.

- **Folder sizes are never computed on their own.** `/api/fs/usage` walks a tree only when
  the button on that row is pressed — a listing still reports directories as size 0, and
  nothing runs on hover, paint or scroll. The walk does not follow symlinks (a cycle would
  hang, and a link out of the jail would be counted), and stops at 400k entries or 20s,
  after which the answer is reported as "at least" rather than as a total. Same for a
  directory it may not read into: partial, and said so.

- **Shared edges are splitters.** `touching()` in `resizable()` finds the windows whose
  opposite edge sits within 12px of the one being dragged (and that overlap along it by
  more than 24px); they give up exactly what the dragged window takes, clamped so nobody
  goes under MIN_W/MIN_H. Both windows are saved on release — a pushed neighbour that is
  not persisted snaps back on the next visit. Note that with two windows touching, the
  handle on top belongs to whichever window is drawn last, so the same gesture arrives as
  `e` on one and `w` on the other; both paths are implemented.
- **Dropping into a gap.** `gapZone()` is offered between the wall's own edges (`aeroZone`)
  and the window under the pointer (`dockZone`): it walks the peers for the free rectangle
  around the pointer and previews it, so a window dropped in the corridor between two
  columns fills it exactly. Guarded by "walled and tight" — a window must bound it and it
  must be under 70% of the desk on that axis — or every drop into open space would resize
  the window being dropped.

- **Preferences** live in `localStorage` under `argus.prefs`: theme, hidden files, sidebar,
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
- **Two clients, one window**: tmux draws a window at one size and, with `window-size
  latest`, hands it to whoever acted last — it has no idea who is actually looking. So the
  size is *claimed*: the browser resends its size on `focus`/`visibilitychange`, and the ⤢
  button forces the same thing on demand. The lock button next to it sets `ignore-size` on
  that one live client with `refresh-client -t <tty> -f ignore-size` (release it with
  `-f '!ignore-size'` — `-f ''` looks right and silently does nothing), which is "watch
  without disturbing the desk". The client's tty comes from `os.ttyname(slave)` at spawn.
- **Clickable paths**: `app/paths.py` + `linkPaths()` in the frontend. Hovering a line
  sends its path-shaped words to `POST /api/fs/locate`, which answers only for what the
  jail would serve — so it cannot be used to probe the filesystem. Relative paths resolve
  against `#{pane_current_path}` of the session, absolute ones against nothing. A phone
  has no hover: a 500 ms press opens whatever is under the finger. Clicking works even
  with tmux `mouse on` (xterm's linkifier is not gated by mouse reporting); the wrapped
  case is handled by rebuilding the logical line across `isWrapped` rows. Opening a path
  also *points* the filesystem at it, the way VS Code's "Reveal in Explorer" does: the
  sidebar when it is open, otherwise the first browser window. A flat listing moves to
  the containing folder, a tree expands down to it (`holder.expand`, deliberately not the
  click handler, which toggles), and the row flashes and scrolls into view.
- **Session names** reach tmux as argv (never a shell string), and are gated against
  `list-sessions` on the configured socket, so a client can only reach sessions we listed.
- **Disconnect** kills our attach client only — the tmux session and its processes survive.
  That is the entire point of the product.
- **Service worker** only registers over HTTPS (secure context), so plain http on a LAN
  address works fine but cannot be installed as an offline PWA.

## State (2026-07-28)

Feature-complete against everything asked for so far; **188 tests green**. Running under
systemd (`systemctl --user restart argus`) on `0.0.0.0:8090`, config in
`~/.config/argus/config.yaml` (`resize_policy: adapt`, write and proxy on).

Verified end to end against an isolated tmux socket: keystrokes, output, resize
propagation (a 100×30 client gives tmux 100×29 — the status line takes a row), session
survival on disconnect, a clean refusal for unknown sessions. The file operations were
smoke-tested against the live server, and the frontend was loaded in headless chromium
(`~/.cache/ms-playwright/chromium-1140/chrome-linux/chrome --headless --dump-dom`) to
confirm it boots with zero console errors and that the wall renders one window per
session. No git commits yet.

Still open: TLS (which would unlock an installable PWA, push notifications and an in-app
QR scanner), per-device tokens, session-activity notifications, and any frontend tests —
all 170 are Python. `sudo loginctl enable-linger $USER` is still needed, or Argus dies
at the last logout.
