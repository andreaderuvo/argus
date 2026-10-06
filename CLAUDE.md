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

## ⚠️ `tmux capture-pane -p` crashes tmux on some builds

`tmux-3.3a-13.20230918gitb202a2f.el10` has heap corruption in `cmd_capture_pane_exec`:

```
free() → malloc_printerr → abort      #7 cmd_capture_pane_exec
```

Reproducible on the **first** `capture-pane -p` against a freshly created server, no
attach needed. It aborts the whole server, killing every session on that socket. Seen four times on the machine this was written on, twice during benchmarks.

Do not run `capture-pane -p` on a machine with that build, even on a test socket, unless
you mean to lose that server. The app never calls it — verify that stays true (`grep -rn capture
app/`). This is also why the product does a real PTY instead of capture-pane polling.

## Run & test

```bash
python3 -m pytest -q -m "not browser"      # the quick loop: Python only, ~35s
python3 -m pytest -q                       # everything, including the browser suite (~2.5 min)
npm ci                                     # once, for ESLint (development only)
python3 -m app.main --help
python3 -m app.main --listen 0.0.0.0:8090  # config auto-created on first run
python3 -m app.main --print-url            # the URL including the token
```

Dependencies are already in the conda base env (fastapi, uvicorn, pyyaml, pytest, httpx);
`requirements.txt` lists them for anywhere else.

**The browser harness** (`tests/browser/`) is how the frontend is tested, since it has no
build step to catch anything. A real Argus is started as a subprocess with a temp config, a
temp root full of sample files, its own `HOME` and a tmux socket `argus-t-<pid>-<n>` — never the
default one — and a headless Chromium drives it over CDP (`cdp.py`, on `websockets`). Things
worth knowing before adding a test:

- **Any problem fails the test by itself**: an uncaught exception, a console error, a 4xx/5xx or
  failed request of ours, a `.js` answered with HTML (a missing module — `serve_static` falls
  back to the index). There is no expected 404: the wall asks for `PLAN/BRIDGE.argus.md` with `missing_ok` and gets 204.
- Every test gets a fresh browser **context** (own localStorage) and the server's `/api/prefs`
  is emptied around it — preferences live on the server too, and would leak between tests.
- Desktop means a **mouse**: headless Chromium reports no hover and no fine pointer, so it is
  started with `--blink-settings` declaring one. Never call `setTouchEmulationEnabled(false)` —
  it resets to "no pointer", not to the mouse. Phone pages get touch emulation and real taps.
- Taps are converted from layout to screen pixels, in case a page is wider than the phone and
  the phone shrinks it (the header was 424px until 2026-10-02; `test_layout.py` keeps it ≤ 360).
- The terminal is checked by **effect** (a typed command writes a file): xterm draws on a
  canvas, and reading the pane back is never an option here (see the crash above).
- `tests/test_modules.py` checks the module graph without a browser: every import resolves,
  every module is reachable from `app.js` and listed in `sw.js`'s SHELL, nothing imports
  `app.js` back, and ESLint (`eslint.config.js`: `no-undef`, `no-import-assign`, correctness
  only) is clean. `tests/frontend_source.py` is how a test reads the JS as text — all of it,
  however many modules it is split into.
- Chromium: `$ARGUS_CHROMIUM`, else Playwright's cache, else the PATH; missing → skip, unless
  `ARGUS_BROWSER_REQUIRED=1` (CI), which makes it a failure.
- The suite was checked against itself: seven deliberate bugs (a misspelt name in a rare path,
  a screen that throws, a console error, kill without confirmation, a broken figure URL, the
  versions wiped on pick) — every one fails it.

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
static/js/        the frontend, one module per section of what used to be app.js
scripts/modules.mjs  regenerates the import blocks; moves code between modules safely
```

The frontend is plain ES modules, no bundler and no build step. Editing `static/` and
reloading is the whole loop — only Python changes need the server restarted.

**The modules** (`static/js/`, split from a 16,600-line app.js on 2026-09-28, behaviour
unchanged and the browser suite green at every step):

```
app.js         the entry point: one import. Kept by name (index.html, sw.js, PWAs know it)
js/main.js     the boot. Imported by app.js alone; its body runs after every section
js/state.js    storage keys, the tmuxc.* migration, DOM handles, DEFAULTS, prefs, token,
               server, live and the other shared lets + their setters. Imports NOTHING.
js/dom.js      el(), svg() — the builders. Imports nothing.
js/words.js    t(), the language catalogue.        js/icons.js   the icon set
js/core.js     prefs sync, the header's wiring     js/reconnect.js  api(), getJSON…, the veil
js/router.js   render(), go()                      js/screens.js the ordinary screens
js/filerows.js file rows and the browser           js/viewers.js PDF, images, markdown, …
js/sidebar.js  sidebar, drawer, rail               js/wall.js    desks and windows (3,000 lines)
js/termpaths.js clickable paths in a terminal      js/tray.js    the link tray
js/handover.js prompts, placeholders, pairs        js/since.js   while you were away
js/vitals.js · bells.js · shortcuts.js · counts.js · markup.js · theme.js · plumbing.js ·
js/pointing.js · fileicons.js · dialogs.js · terminal.js · chains.js · installing.js
```

Rules the tests enforce (`tests/test_modules.py`), each learnt the hard way during the split:

- **Imports are generated.** Each file has one `// <imports>` block; never edit it — write the
  code, then `npm run relink`. A stale block fails the tests. ESLint's `no-undef` says a name
  is missing, `no-import-assign` that an imported `let` is being assigned: give it a setter in
  its own module (`node scripts/modules.mjs setters /js/state.js name`), because an ES import
  is read-only.
- **Load order is not file order.** The sections import each other in circles, so a module's
  top-level code may run before a module it reads from. Reading another module's `const`/`let`
  *at load* — directly or through a function called at load — is only allowed from a module in
  no import cycle (state.js, dom.js, words.js, icons.js…). `tests/js/loadorder.mjs` follows the
  calls and names the chain. It found `buildDrawer → icon → svg` reading `SVG_NS` before
  words.js had run, which is why dom.js exists. Functions are hoisted; helpers written as
  `const f = () => …` are not (`node scripts/modules.mjs hoist`).
- **A module run for its effect needs an import for it** (`import '/js/plumbing.js'` in
  main.js): nothing uses its exports, and without that line the token in the banner link would
  never be read. Unreachable modules fail the tests.
- Every module is in `sw.js`'s SHELL (tested); bump `CACHE` when the set changes.

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
- **"Back to the live end" talks to tmux, not to xterm.** Scrolling here never scrolls the
  browser: tmux owns the scrollback, so a wheel over the pane puts *tmux* into copy-mode
  and `term.buffer` never moves — which is why a first attempt built on `viewportY` and
  `scrollToBottom()` did nothing at all. The button posts `send-keys -X cancel`, which ends
  copy-mode and, outside it, answers "not in a mode" without typing a `q` into the shell.
  It follows tmux rather than the wheel: `#{pane_in_mode}` is polled every 2.5s while the
  terminal is on screen (and not at all when it is parked or the tab is hidden), so it
  appears however you entered history — the prefix `^B [` is the only way in when a program
  has taken the mouse — and leaves however you left. A wheel-up just triggers an immediate
  check, in the **capture** phase, because xterm consumes the wheel and stops it bubbling.
  With tmux attached the terminal has no scrollback of its own: measured, always 0/0, which
  is why nothing here can be built on `viewportY`.
- **Double-click maximises and un-maximises**, and the size it had before is stored *with*
  the geometry (`prev`), not in `dataset` alone — the DOM is thrown away by a reload or a
  tab switch, which is how un-maximising used to land on a default. Two things had to be
  true for it to work at all: a press that never travels is a click, not a drag, or
  `dragBy`'s settle handler rewrites the geometry and clears the maximised state before the
  `dblclick` even arrives; and moving or resizing by hand forgets the remembered size,
  because that is now where you want the window.
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
- **A browser window lands where the desk says** (`ws.home`), or in the home directory,
  rather than in the folder it was last left in — except at the moment of creation, when
  clicking a folder has to land on that folder (`spec.fresh`). Browser windows therefore
  carry an `id`: identity used to be the path, so two of them in one desk on the same
  folder collided and navigating changed the window's identity and its geometry key.
- **The PDF finder folds into a button** over the page. A search row costs a strip of every
  document for as long as it is open, and nobody is searching most of the time. Note
  `.pdfwrap` needs `height: 100%` *and* `flex: 1`: the preview screen's host is not a flex
  container, and `flex` alone collapsed the viewer to 150px.
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

- **A selection is offered to the desk's other sessions** (`showSelectionOffer` in wall.js,
  `handle.onSelected` in termpaths.js, `tests/browser/test_seloffer.py`). Select text in one
  terminal and a button appears where the mouse let go; it types the text into another
  session of the desk, not sent. Two sources: xterm's own selection, read on the release, and
  tmux's — with `mouse on` + `set-clipboard on` the browser never sees a selection, the copy
  arrives as OSC 52 just after the release. Either counts only within 2 s of a release *in that
  window* (tmux sends the copy to every client). **Claude Code and Codex keep the mouse**
  (tmux `mouse_any_flag`=1, alternate screen): a drag over them goes to them and selects nothing,
  which is why it worked with every fake agent and never on a real one. Shift-drag selects in
  xterm regardless; a plain drag over such a program that ends with nothing selected says so
  once a visit (`onUncaughtDrag`). Test fakes that stand in for an agent should turn on mouse
  reporting too (`KEEPS_MOUSE` in test_seloffer.py). In CDP a drag needs `buttons: 1` on each move,
  and a fitted terminal has many more rows than the session was created with.
- **"Also →": a prompt typed to one agent, given to another of the desk** (wall.js
  `paintAlso`/`submittedAlso`, termpaths.js `typed`, `tests/browser/test_also.py`). A press
  **sends it now** (typed, with its Enter). It first armed and waited for the Enter in the
  source window; a server-side trace of a real use (since removed) showed armed, disarmed, armed
  again and no Enter — the button looked dead. When something only fails in the user's real
  setup, a short-lived trace to the server finds it faster than more guesses. The line is
  rebuilt from the keystrokes, never read off the screen (`static/js/typedline.js`, a leaf module
  tested in Node by `tests/test_typedline.py`). The rule is by exclusion: only keys that move the
  cursor or edit (arrows in both ESC [ and application ESC O forms, the ESC [ n ~ family, Alt-,
  other control keys) make the line unknown; every other escape sequence — the terminal's answers
  to tmux and the program (DA, the DCS version string, OSC colours, cursor reports), focus and
  mouse reports — is skipped whole. Listing the replies instead missed some, and on a real
  Claude the button never appeared. A target is left out only if it shares the desk's chain with
  the source: a chain of one sends nothing, and hid the button on a real desk.
- **"Got it, all"** (counts.js `seeEverything`): the tab strip and the Sessions screen, shown
  only while an agent waits or a bell is up; one POST /api/tmux/seen for every waiting agent.
- **A session made again under the same name is a new session** (agentstate `held`): keyed by
  window id *and* `#{session_created}`, because a new tmux server numbers windows from @0 again.
  Without it a recreated session inherited the old one's wait and its dismissal.
- **Each `.deck` is `isolation: isolate`.** A window's z-index grows by one per raise with no
  ceiling, and outranked the desk card and every overlay on the page; contained, it cannot.
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

- **Whether an agent is working or waiting is worked out, not declared** (`app/agentstate.py`,
  `GET /api/tmux/states`). An agent is a process named `claude`/`codex`/`gemini`/… (or a
  launcher's program; argv[1] after node/python) under the pane. Measured on Claude Code: while
  it works the pane redraws continuously — the spinner, ~700 bytes per half second, *including*
  while a tool runs — and goes quiet the moment it answers or asks, bar one small redraw every
  ~10s. So a 1 Hz sampler reads `#{window_activity}` and "working" means it advanced in most of
  the last few seconds; one lone advance is not enough. The sampler runs only while something
  reads the states (the browser asks every 3s while visible) and stops a minute after. `ps` is
  run with **`-ww`**: without it the command line is cut to `$COLUMNS` and an agent installed
  under a long path is never recognised (found by the tests, under pytest). Never probe this
  with a real agent and blind keystrokes: a dialog it shows can change the user's settings.

- **An agent with hooks is believed over its pane.** Measured 2026-10-01: a Claude in a long
  command left its pane still for minutes (read as *waiting*), then rang every time the
  command's output landed — the "LED a caso". So Claude is wired with a third hook,
  `UserPromptSubmit` → `argus-bell start` (rings nothing, `bells.told`): from it until Stop or
  Notification the agent is *working*, whatever the pane does; after it stopped, only drawing at
  every one of four readings (`agentstate.busy`), 5 s on, counts as back at work. The pane never
  rings for a session that has told anything, nor for an agent whose end-of-turn hook is ours
  (`wiring.ringing_agents`, read by `main`; the tests' apps have none). Codex stays pane-watched:
  its notify is end-of-turn only. `wiring.wire()` wires *every* agent present — on 2026-10-01
  it added hooks to a Gemini nobody had wired; that was undone by hand.
- **One ring per turn** (`bells.NEEDS`, `tests/test_turns.py`). `done` and `asking` both mean
  "your turn" and fold into one bell per turn: a turn opens when the sampler sees the agent
  working, and the first of hook-or-sampler to say it stopped rings; the rest are answered
  `repeat: true` and ring nothing. Measured before: every Claude turn rang `done` (Stop) and
  then `asking` exactly 60 s later (its idle Notification). An agent with no hook now rings
  when the sampler sees it stop. The server runs the sampler **always** (`main` sets it, the
  tests' apps do not), so ntfy can reach a phone with every tab shut. A window's mark clears
  when its agent is working again. `argus-bell` now reads the notification text Claude and
  Gemini send on stdin ("needs your permission to use Bash"), with a 0.5 s limit.

- **Agents come back after a reboot** (`app/resume.py`, `tests/test_resume.py`). Every 30 s the
  server records which sessions hold an agent: folder, agent, the flags worth keeping, and the
  conversation — Claude's from its hook (`argus-bell` reads `session_id` from stdin; **not**
  `$CLAUDE_CODE_SESSION_ID`, which leaks into every pane of a tmux server started from a Claude
  shell), Codex's from the `rollout-…-<uuid>.jsonl` it holds open. Lost means *the tmux server
  changed* (pid:start_time, read with `list-sessions`, which needs no client), never just "the
  session is gone": one closed on a live server was closed on purpose. A tmux call that times
  out is not a dead server. The Sessions screen offers them back (`claude --resume <id>`,
  `codex resume <id>`, else a fresh agent in the same folder, said so). Kept in
  `agents-seen.json` beside the config; the browser harness runs it every second
  (`ARGUS_REGISTER_EVERY`) and forgets losses between tests.
- **A screen that awaits before appending checks `renderSeq`** (router.js): two overlapping
  renders both emptied the view first and both appended, and Sessions showed twice.

- **A process can carry a label of your own** (System screen: the pencil on a process or a
  port). Kept on the server in `labels.json` beside the config, keyed by **pid and start
  time** (field 22 of `/proc/<pid>/stat`, read after the *last* `)` because the command name
  may contain spaces and parentheses) — so a recycled pid never inherits somebody else's
  note, and a label is dropped, and written out of the file, once its process has ended.
  `/api/system` and `/api/ports` carry `label` on every row (always present, "" when none);
  the process rows now also carry `pid` and the full `command`, since `java` alone is what
  made people ask. `POST /api/labels {pid, label}`; empty clears. Not an agent route.

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

- **An agent's options, in words** (`app/agentflags.py`, `tests/test_agentflags.py`). The New
  session box offers permissions / model / effort / continue for Claude, Codex and Gemini, from
  a table here — filtered by the agent's own `--help` (login shell, ~2 s, asked with the
  versions and remembered per version), because flags change: Codex 0.153 has no `--full-auto`.
  The browser sends option names; the server builds the flags and 400s anything off the table.
  The browser harness has a stand-in `claude` launcher (conftest `FAKE_CLAUDE`) that answers
  `--help`; the launcher list there is four long.
- **Teams: agents on one goal, directed by the server** (`app/teams.py`, `tests/test_teams.py`).
  A reversal, made on purpose: Two agents and the wiki said Argus is only a *reader* and ships
  no orchestrator, and its minding ran only with a tab open. A team needs somebody to keep it
  going with the browser shut, and an answer that is not an agent's opinion. The director is a
  loop on the server (`directing_teams`, every 3 s, started by `main` like the sampler): it
  prompts a role (`launch.seed`), waits for that role's `@TURN … @END` in `TEAM.argus.md`, runs
  the **check** when the flow says so, and decides from the judge's verdict (OK / REDO / DONE /
  BLOCKED) or the check's PASS/FAIL. Gates: `ask` (a press per round), `auto` (stops on two
  failed checks or BLOCKED), `goal`. The check is a command line typed into the team's own tmux
  session `<team>-check` (`TeamIO.run_check`) — visible, stoppable, and only for the full token
  with `--allow-write`. Its exit code is written from inside a subshell *before* the `| tee`:
  `$?` after a pipe is tee's and PIPESTATUS is bash-only, so under zsh a failing check would
  have passed; and the command sits in a subshell of its own, so an `exit` in it ends only that.
  Side effects go through `io`, so the state machine is tested without tmux; one test runs a
  whole team through the API with stand-in agents that answer by appending their turn.
- **A team is a graph** (`teams.check_graph`, `static/js/teamgraph.js`, `tests/test_teamgraph.py`).
  Nodes are `agent` / `check` / `join` / `end`; arrows carry a condition (`always`, PASS/FAIL,
  OK/REDO/DONE/BLOCKED). Parallel branches start together, a `join` waits for every arrow in,
  and returning to a step already run this round starts the next round — that is the whole
  notion of "round". The six templates are just graphs (`_g`), and so is a model saved from the
  sheet (`prefs.teamModels`, stripped of sessions by `bare()`): the server validates whatever
  comes, so the editor can offer anything. Two traps found by the tests: removing a step wired
  its predecessor into itself (`always` self-loop = a team that never stops; refused on both
  sides), and arrows between the same two steps (OK *and* REDO back to the executor) drew one
  on top of the other until `drawGraph` merged them into one labelled "ok · redo". Each agent
  and each check has a session `<team>-<node>`; a worktree is per node (`team/<team>-<node>`),
  which is what lets a Tournament's two executors try different things in one repository.
- **`argus-mcp`, Argus as MCP tools** (`tools/argus_mcp.py`, `tests/test_argus_mcp.py`). Stdio
  JSON-RPC, standard library, every tool one call through `argus_client` on the agent key — no
  new power. `who ring ask relay launchers start_agent teams worktree prompts`. The agent key
  gained `GET /api/teams` (read only; the route guard in test_agent_key.py is now 16), and lost
  something it had by accident: starting an agent with a `danger` option
  (`--dangerously-skip-permissions`) is 403 for it (`agentflags.dangerous`). The session a ring
  comes from is `tmux display-message -p -t $TMUX_PANE '#S'`. Checked with a real headless
  `claude -p --strict-mcp-config --mcp-config …` against a throwaway Argus: who, relay, ring.
  Nothing on stdout but messages, or the client breaks.
- **The Argus plugin** (`plugin/`, `.claude-plugin/marketplace.json`, `tests/test_plugin.py`).
  Hooks (UserPromptSubmit/Stop/Notification/PermissionRequest → `argus-bell`) plus `argus-mcp`,
  installed from the agent: `/plugin marketplace add andreaderuvo/argus`. **Codex 0.160 reads the
  same plugin** (`.claude-plugin/plugin.json`, `hooks/hooks.json`) and has Claude's hooks
  (`~/.codex/hooks.json`, same events and stdin JSON) — measured on an isolated `CODEX_HOME` with
  `--dangerously-bypass-hook-trust`; without it a hook runs only after a person reviews it in
  Codex, which is why `notify` stays wired too. Codex does **not** expand `${CLAUDE_PLUGIN_ROOT}`
  in `.mcp.json` (it does in hooks): hence the `sh -c` that falls back to its plugin cache.
  `plugin/bin/` holds *copies* of tools/ (an installed plugin is copied; links would dangle) —
  tested identical. `wiring.plugin_enabled` makes Settings say "the Argus plugin". Probes of real
  agents: `claude -p --plugin-dir`, isolated `CODEX_HOME` with a *copy* of auth.json deleted after;
  `claude plugin init` writes into the real `~/.claude/skills/` — do not run it to "see a layout".
  `argus-bell` signs a bell with the tmux session only inside tmux: outside, `tmux display` named
  the most recent session of the default server.
- **A desk by name** (`POST /api/desks`, `ensure_desk`, MCP `open_desk`, `launch(desk="pippo")`,
  `tests/browser/test_desk_by_name.py`). The one place the server writes into the desks: it makes
  the *empty* desk in the preferences (once, however many pages are open — each page making it
  would give one per page) and announces `{what: "desk"}`; pages adopt missing desks by id
  (`adoptDesks`, serialised) and switch to it. Windows still go in from the page, on `started`
  with `desk_id`. A doc with no desks yet gets "Desk 1" (id 1) too, or the new desk would take
  the number a browser gives its first. On the agent key (route guard: 17).
- **Two agents was folded into Teams** (2026-10-06). Its button and `pairSheet` are gone; its
  patterns are the templates *Build and review* and *Split the work* (two executors at once in
  the same folder, each on the files the planner gave it, no worktree). What reads an existing
  pair stays — the desk card on `BRIDGE.argus.md`, the REDO loop, Also's "partner first" — so a
  pair started before keeps working; there is just no way to start a new one.
- **A browser is remembered by the server too** (`/api/remember`, in the auth gate, `tests/test_remember.py`).
  localStorage is the page's copy, and a phone loses it (Safari clears script storage after
  seven days away; a link opened from a chat lands in that app's own browser). After a token
  works, the page POSTs it and the server sets `argus_keep_<port>` — HttpOnly, SameSite=Strict,
  Path=/api/remember, 400 days, rolled on every visit. With no token, the page GETs it back
  before showing the token screen. The cookie opens nothing else; only a full or a device key
  is kept, never a watcher's or an agent's; a key that stopped working is dropped, and sign-out
  forgets it. "Nothing remembered" answers 200 `{token: null}`, not 401 (the harness counts
  every 401 as a problem). Different addresses (IP, hostname, Tailscale) are still different
  sites to a browser: each remembers on its own.
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

## Where it stands

`python -m pytest -q` is the truth; the count changes most days. Everything asked for so
far is built. The frontend is tested from Python too, by driving a real Chromium over CDP
against a real Argus (`tests/browser/`, above) and reading a measurement back — never by
asserting on a screenshot.

The header fits a phone (it was 424px, so every phone narrower than that was shown the page
shrunk to fit): below 560px it does without the keyboard's shortcuts and the repository (in
Settings → About Argus), and keeps System only while it is an alarm; below 400px its buttons are
42px. `test_layout.py` holds it at 360, 390 and 412px, with the alarm showing too.

Two long-standing gaps, both about the same thing: no TLS, which is what would unlock an
installable PWA, real push notifications and an in-app QR scanner; and no per-device
tokens, so revoking a phone means rotating for everybody.

Kept in mind when touching anything here:

- **`loginctl enable-linger` is not optional** for a `systemd --user` unit. Without it the
  server dies at the last logout, and the report is always "it was working this morning".
- **A board may be watching.** `GET /api/overview` is the one endpoint a watcher token
  opens, so what goes in it is a published interface: adding a field is free, renaming one
  is not.
