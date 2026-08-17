# Changelog

What changed, and why it changed. Dates are the day the tag was cut.

This file is the source of the release notes, and a running Argus points at it when it
notices a newer version exists. It is kept by hand: a list generated from commit subjects
is a list nobody reads twice.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
caveat every 0.x project shares: while the first number is zero, the second one is where
breaking changes go.

## [Unreleased]

### Fixed

- **Holding a cursor key moved the cursor one position and stopped.** The filter that
  fights Chrome-on-Android's duplicate-word bug asked "the same data twice, longer than one
  character, within 120ms" — and an arrow key is `\x1b[D`, three bytes, identical every
  time, repeating every 33ms on Linux and Windows alike. So every repeat after the first
  was thrown away as an Android artefact. Home, End, PageUp, Delete and the function keys
  went the same way. The filter now only ever looks at printable text; a composition event
  cannot produce an escape sequence. Measured with Chrome driving real `autoRepeat`
  keydowns: ten keydowns delivered one arrow to the pane before, ten after, and the Android
  case is still caught.

## [0.0.1] — 2026-08-17

The first tagged version. Argus has been in daily use for three weeks before this, so
"first" means the first one you can name and compare against, not the first that works.

### Sessions and the terminal

- Attaches to the tmux sessions you already have, through a real pseudo-terminal
  (`pty.openpty` → `login_tty` → `tmux attach`), not a poll of `capture-pane`. Kill Argus
  and every session carries on.
- A finger drag scrolls the session, turned into whole lines with the remainder carried,
  against how far tmux actually moves per wheel turn — measured, not assumed.
- A box to write a line in, for the phones where typing into a terminal duplicates words.
- A key bar for what a phone has not got: Esc, Tab, arrows, `^B`, `^C`, `^D`, `^U`, and a
  sticky Ctrl. Held, an arrow repeats.
- Chain two sessions and type into both.
- Copy out of tmux's own paste buffer, over plain HTTP included.

### Files and documents

- A path printed in a session is clickable and opens in a window beside it.
- Markdown with its figures, PDFs, Word through pandoc, images, and logs that start at the
  end. Video and audio play in the window, streamed with range requests.
- **PDFs are drawn by Argus**, with pdf.js, and open where you left them: the page, the
  scroll position to the pixel, and the zoom.
- Type a path where the path is shown, with completion.

### Desks

- Windows you arrange yourself, magnetic, with shared edges behaving as splitters — and a
  column gives way as a column.
- **Keep** and **Mine**: the arrangement you made, remembered and brought back.
- On a wide screen the navigation is a rail down the left, and the desk's windows are
  listed under it.
- Full screen for one window, and fill-the-desk on the title bar's double-click.

### Knowing when you are wanted

- A bell per session, wired into Claude Code and Codex with one button, that tells
  "finished" apart from "asking you something".

### The machine

- CPU, memory, swap, GPUs, disks, listening ports, and a reverse proxy for a port bound to
  loopback.

### For a board over several machines

- A **watcher** token that opens exactly one door, `GET /api/overview`, and nothing else.
  [Panoptes](https://github.com/andreaderuvo/panoptes) is the board that uses it.

[Unreleased]: https://github.com/andreaderuvo/argus/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/andreaderuvo/argus/releases/tag/v0.0.1
