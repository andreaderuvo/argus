// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { showCount } from '/js/counts.js';
import { ask, confirmBox, copyPath, copyText, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { translateMarkup } from '/js/markup.js';
import { delJSON, getJSON, human, patchJSON, postJSON, serverInfo, setTitle, when, withToken } from '/js/reconnect.js';
import { render } from '/js/router.js';
import { prefs, setLeaving, view } from '/js/state.js';
import { openWindow } from '/js/tray.js';
import { activeLang, loadLanguage, t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ vitals */

/** Write a string into a node without replacing it.
 *
 *  `textContent = x` throws the text node away and makes another one, even when the string
 *  is identical — cheap on its own, and not cheap forty times every four seconds on a screen
 *  somebody is reading. Setting `nodeValue` on the text node that is already there changes
 *  the characters and nothing else. */
function writeInto(node, text) {
  const only = node.childNodes.length === 1 ? node.firstChild : null;
  if (only && only.nodeType === 3) {
    if (only.nodeValue !== text) only.nodeValue = text;
    return;
  }
  if (node.textContent !== text) node.textContent = text;
}

/** The pencil that puts a word of your own on a process.
 *
 *  "java, 2.2 GB" is where the question comes from: which java, doing what, and can it go.
 *  The label is kept on the server against that one process — its pid and the moment it
 *  started — so it follows the process to the phone and dies with it (app/labels.py).
 *  `current()` is read at click time, because the row it sits on is reused as the list moves.
 */
function labelButton(current, after) {
  return el('button', {
    className: 'more labelpen', type: 'button', title: t('Label this process'),
    'aria-label': t('Label this process'),
    onclick: async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const { pid, label, name } = current();
      if (!pid) return;
      const text = await ask(t('What is {name}?', { name: name || `pid ${pid}` }), label || '', t('Save'));
      if (text === null) return;
      try {
        const done = await postJSON('/api/labels', { pid, label: text });
        toast(done.label ? t('labelled: {label}', { label: done.label }) : t('label removed'));
      } catch (e) {
        toast(e.message, true);
      }
      after();
    },
  }, icon('rename'));
}

export const LEVEL_WORD = { good: 'ok', warning: 'high', critical: 'critical' };

/** The single worst number on a reading, so "is it dying" is answered before anything
 *  else is. Shared between the System screen's hero tile and the header badge — both are
 *  the same question asked at a different distance, and they must never disagree. */
export function worstVital(s) {
  return [
    { what: 'cpu', pct: s.cpu.pct, level: s.cpu.level },
    { what: 'memory', pct: s.memory.pct, level: s.memory.level },
    ...s.disks.map((d) => ({ what: `disk ${d.path}`, pct: d.pct, level: d.level })),
    ...s.gpus.map((g) => ({ what: 'gpu memory', pct: g.mem_pct, level: g.level })),
  ].sort((a, b) => b.pct - a.pct)[0];
}

/** A labelled meter. The fill carries severity; the word beside it carries the same
 *  thing in text, because a status must never be colour alone. */
function meter(label, value, pct, lvl, note = '') {
  const fill = el('div', { className: `fill ${lvl}` });
  fill.style.width = `${Math.max(1.5, Math.min(100, pct))}%`;
  const tile = el('div', { className: 'tile' }, [
    el('div', { className: 'tilehead' }, [
      el('span', { className: 'tilelabel', textContent: label }),
      el('span', { className: `state ${lvl}`, textContent: LEVEL_WORD[lvl] }),
    ]),
    el('div', { className: 'tilevalue', textContent: value }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'tilenote', textContent: note }),
  ]);
  /* Written into, rather than built again.
   *
   *  These numbers change every four seconds for as long as the screen is open. Replacing
   *  the tile each time is a new element under the pointer, a new element under a tooltip,
   *  and — with the whole screen doing it at once — a visible flash. So a tile knows how to
   *  take a new reading, and each field is touched only when it has actually changed: an
   *  assignment to `textContent` that writes the same string still invalidates the line. */
  tile.take = (v, pct2, lvl2, note2 = '') => {
    const state = tile.querySelector('.state');
    const value2 = tile.querySelector('.tilevalue');
    const noteNode = tile.querySelector('.tilenote');
    const width = `${Math.max(1.5, Math.min(100, pct2))}%`;
    if (fill.style.width !== width) fill.style.width = width;
    if (fill.className !== `fill ${lvl2}`) fill.className = `fill ${lvl2}`;
    if (state.className !== `state ${lvl2}`) state.className = `state ${lvl2}`;
    writeInto(state, LEVEL_WORD[lvl2]);
    writeInto(value2, v);
    writeInto(noteNode, note2);
  };
  return tile;
}

export const duration = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** Where this machine is, where you are, and the line that joins the two.
 *
 *  Three facts that were nowhere and are asked constantly the moment Argus is on a machine
 *  that is not the one in front of you: what do I type to reach this box, which of my machines
 *  am I coming from, and what is the ssh line for a port that only listens on loopback.
 */
function whereSection() {
  const box = el('div', { className: 'wheresec' });
  const head = el('div', { className: 'tilelabel', textContent: t('Where it is') });
  const body = el('div', { className: 'wherebody' });
  box.append(head, body);

  const draw = (said) => {
    body.replaceChildren();
    body.append(factRow(t('this machine'), said.hostname,
                        said.user ? t('you would ssh in as {user}', { user: said.user }) : ''));

    for (const one of said.addresses || []) {
      const words = {
        lan: t('on the network'), public: t('reachable from the internet'),
        loopback: t('this machine only'), 'link-local': t('link-local'), other: '',
      }[one.kind] || '';
      body.append(addressLine(
        one.routed ? t('address · the one to use') : t('also'),
        `${location.protocol}//${one.address}:${said.port}/`,
        words,
      ));
    }

    /* Reaching Argus itself over a tunnel, not a port behind it.
     *
     *  `said.ssh` already existed — the ports screen has been reading `OpenSSH` out of it
     *  and substituting a different port number into the line for months, to reach a
     *  *service* through a tunnel. Argus's own address sits behind the same firewall as
     *  that service, on a box with nothing routed to it at all, and there was no button
     *  for that: the ssh line for Argus itself was computed on every request and shown
     *  nowhere. Asked for in those words, on a machine where the LAN address is real and
     *  still unreachable from outside it — a firewall is invisible from here, so this is
     *  offered unconditionally rather than guessed at from the address's own kind.
     *
     *  The address underneath carries the token, the same as any other handoff link: once
     *  the tunnel exists, 127.0.0.1 on *your* machine is a plain loopback address like any
     *  other, and pasting one without the token only hands you the token screen again.
     */
    const openssh = (said.ssh || []).find((x) => x.name === 'OpenSSH');
    if (openssh) {
      body.append(commandLine(t('tunnel to it'), openssh.line, t('run this on your own machine')));
      body.append(addressLine(t('then open'), withToken(`${location.protocol}//127.0.0.1:${said.port}/`),
        t('works once the tunnel above is up')));
    }

    if (said.you) {
      // Behind a reverse proxy the socket says 127.0.0.1 and the header says who really asked.
      // Both, and which is which: one is a fact, the other is a claim.
      body.append(factRow(t('you are'), said.you, said.you_claimed
        ? t('through a proxy, which says you are {who}', { who: said.you_claimed })
        : { lan: t('on the network'), public: t('from the internet'),
            loopback: t('on this machine') }[said.you_kind] || ''));
    }

    if (said.may_ask_outside) {
      const ask = el('button', {
        className: 'ghost inline', textContent: t('What does the world see?'),
        onclick: async () => {
          ask.disabled = true;
          try {
            const got = await postJSON('/api/network/outside', {});
            ask.replaceWith(addressLine(t('from outside'), `${location.protocol}//${got.address}:${said.port}/`,
                                        t('according to {who}', { who: got.asked })));
          } catch (e) { toast(e.message, true); ask.disabled = false; }
        },
      });
      body.append(el('div', { className: 'addrrow' }, [
        ask,
        // Said before it is pressed, not after: asking a service what your address is *is*
        // telling that service your address, and that is a choice rather than a lookup.
        el('span', { className: 'meta', textContent: t('asks {who} — the only thing here that speaks to anybody', { who: said.would_ask }) }),
      ]));
    }
  };

  getJSON('/api/network').then((said) => { box.said = said; draw(said); })
    .catch((e) => body.append(el('p', { className: 'meta', textContent: e.message })));
  return box;
}

/** An address, written out and copyable.
 *
 *  The reason this exists: somebody with a dashboard on `127.0.0.1:11000` pressed *Reach it*,
 *  saw it open in a window, and then had no idea what to type into the browser on their own
 *  laptop. The address was real, worked, and appeared nowhere — it existed only inside an
 *  `onclick`. A link you cannot see is a link you cannot use anywhere else, and "anywhere
 *  else" is most of why the port was opened.
 */
function addressLine(label, url, note) {
  return factRow(label, url, note, { link: url });
}

/** The same, for something to run in a terminal rather than to open. */
function commandLine(label, command, note) {
  return factRow(label, command, note, { code: true });
}

/** A label, a value, and a button that copies it. Always the button.
 *
 *  Asked for in those words — "the copy button everywhere" — and the reason is the same every
 *  time: every value on this panel exists to be typed somewhere else. An address you can read
 *  and not copy is an address you retype, and an address retyped from a screen is an address
 *  with a digit wrong in it.
 */
function factRow(label, value, note, { link = null, code = false } = {}) {
  const shown = link
    ? el('a', { className: 'addrtext', href: link, target: '_blank', rel: 'noopener noreferrer',
                textContent: value, title: value })
    : el(code ? 'code' : 'span', { className: 'addrtext', textContent: value, title: value });
  const copy = el('button', {
    className: 'winbtn', type: 'button', title: t('Copy'), 'aria-label': `${t('Copy')} ${value}`,
    onclick: async function copied(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!await copyText(value)) return;
      this.replaceChildren(icon('tick'));
      this.classList.add('done');
      setTimeout(() => { this.replaceChildren(icon('clipboard')); this.classList.remove('done'); }, 1200);
    },
  }, icon('clipboard'));
  // Built as a list and filtered, because `el` here appends whatever it is given: a `null`
  // child arrives as the word "null" on the screen. It did, under a port with no note.
  return el('div', { className: 'addrrow' }, [
    el('span', { className: 'addrlabel', textContent: label }),
    shown, copy,
    ...(note ? [el('span', { className: 'meta', textContent: note })] : []),
  ]);
}

/** What is listening, and how to reach it.
 *
 *  A port on 0.0.0.0 is already reachable from your phone — you only needed to be told
 *  it exists. One on 127.0.0.1 is not, and that is what the proxy is for. */
function portsSection(where) {
  /* Which rows have their details open.
   *
   *  Outside `paint`, deliberately: this section redraws itself every fifteen seconds, and a
   *  strip that folded shut under your hands while you were reading the ssh line out of it
   *  would be worse than not having it.
   */
  const unfolded = new Set();
  const box = el('div', { className: 'proclist ports' });
  const head = el('div', { className: 'tilelabel', textContent: t('Listening ports') });
  box.append(head);
  const list = el('div');
  box.append(list);

  /** Reach a port nobody detected, or finish a login that went to the wrong machine.
   *
   *  The case this is really for: a tool running in here starts a browser login whose
   *  callback is `http://localhost:1455/…`. You log in on your own machine, and localhost
   *  there is *your* machine, so the callback lands on nothing. Paste that dead URL in
   *  here and Argus forwards it to the port it was always meant for. A bare number works
   *  too, for a service that is not listening yet or that the scan did not see.
   */
  async function reach(raw) {
    const text = raw.trim();
    if (!text) return;
    let port = 0;
    let rest = '/';
    if (/^\d+$/.test(text)) {
      port = Number(text);
    } else {
      let url;
      try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`); } catch { url = null; }
      if (!url) return toast(t('That is neither a port nor a URL'), true);
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      rest = url.pathname.replace(/^\//, '') + url.search;
    }
    if (!(port >= 1 && port <= 65535)) return toast(t('That is not a port'), true);
    try {
      await postJSON('/api/ports', { port, open: true });
      openWindow({ kind: 'web', url: withToken(`/proxy/${port}/${rest}`), label: `:${port}` });
      paint();
    } catch (e) { toast(e.message, true); }
  }

  const byHand = () => {
    const field = el('input', {
      type: 'text', spellcheck: false, autocapitalize: 'off', autocomplete: 'off',
      placeholder: t('a port, or a localhost URL that went nowhere'),
    });
    const go = el('button', { className: 'ghost dup', textContent: t('Reach it'), onclick: () => reach(field.value) });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); reach(field.value); } });
    return el('div', { className: 'portpick' }, [field, go]);
  };

  // What the list was drawn from last time. Redrawing it costs you the box you are typing
  // in and the row under your pointer, so it happens when something has actually changed.
  let asDrawn = '';

  const paint = async (quietly = false) => {
    let data;
    try { data = await getJSON('/api/ports'); } catch (e) {
      if (quietly) return;
      list.textContent = '';
      return list.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    const now = JSON.stringify(data);
    if (quietly && now === asDrawn) return;
    // Never mid-sentence: this box holds a URL somebody is pasting into it.
    const field = list.querySelector('.portpick input');
    if (quietly && field && (field.value.trim() || document.activeElement === field)) return;
    asDrawn = now;
    list.textContent = '';
    head.textContent = data.open.length
      ? t('Listening ports · {n} reachable through Argus', { n: data.open.length })
      : 'Listening ports';
    const mine = data.ports.filter((p) => p.mine && !p.self);
    if (data.allow_proxy) list.append(byHand());

    // A port opened by hand may belong to nothing the scan can see — a service that has
    // not started yet, or one listening in a way `ss` did not report. It still has to be
    // listed, or there is no way to close it again.
    const unseen = data.open.filter((port) => !mine.some((p) => p.port === port));
    for (const port of unseen) {
      list.append(el('div', { className: 'portrow' }, [
        el('span', { className: 'portnum', textContent: String(port) }),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: t('opened by hand') }),
          el('span', { className: 'meta', textContent: t('forwarded to 127.0.0.1:{port}', { port }) }),
        ]),
        el('span', { className: 'state good', textContent: t('reachable') }),
        el('button', {
          className: 'ghost dup on', textContent: t('View'),
          onclick: () => openWindow({ kind: 'web', url: withToken(`/proxy/${port}/`), label: `:${port}` }),
        }),
        el('button', {
          className: 'winbtn', title: `Stop reaching port ${port}`,
          onclick: async () => {
            try {
              await postJSON('/api/ports', { port, open: false });
              toast(t('port {port} closed', { port }));
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('close')),
      ]));
    }

    if (!mine.length && !unseen.length) {
      list.append(el('p', { className: 'empty tiny', textContent: t('Nothing of yours is listening.') }));
    }

    for (const p of mine) {
      const open = data.open.includes(p.port);
      const direct = `${location.protocol}//${location.hostname}:${p.port}/`;
      const through = withToken(`/proxy/${p.port}/`);

      // Your label first when there is one; what the machine calls it moves underneath.
      const said = p.label
        ? [p.process, p.command.slice(0, 90)].filter(Boolean).join(' · ')
        : p.command.slice(0, 90) || p.address;
      const row = el('div', { className: `portrow${p.label ? ' labelled' : ''}` }, [
        el('span', { className: 'portnum', textContent: String(p.port) }),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: p.label || p.process || 'unknown' }),
          el('span', { className: 'meta', textContent: said }),
        ]),
        p.pid ? labelButton(() => ({ pid: p.pid, label: p.label, name: p.process }), () => paint()) : null,
        el('span', { className: `state ${p.loopback ? 'warning' : 'good'}`, textContent: p.loopback ? 'local only' : 'on the network' }),
      ].filter(Boolean));

      if (!p.loopback) {
        // Nothing to proxy: the phone can dial this itself.
        row.append(el('button', {
          className: 'ghost dup',
          textContent: t('Open'),
          onclick: () => openWindow({ kind: 'web', url: direct, label: `:${p.port}` }),
        }));
      } else if (!data.allow_proxy) {
        row.append(el('span', { className: 'verb', textContent: t('needs --allow-proxy') }));
      } else if (open) {
        // Already reachable: say so, and make closing it as easy as opening was.
        row.append(el('span', { className: 'state good', textContent: t('reachable') }));
        row.append(el('button', {
          className: 'ghost dup on',
          textContent: t('View'),
          onclick: () => openWindow({ kind: 'web', url: through, label: `:${p.port}` }),
        }));
        row.append(el('button', {
          className: 'winbtn',
          title: `Stop reaching port ${p.port}`,
          onclick: async () => {
            try {
              await postJSON('/api/ports', { port: p.port, open: false });
              toast(t('port {port} closed', { port: p.port }));
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('close')));
      } else {
        row.append(el('button', {
          className: 'ghost dup',
          textContent: t('Reach it'),
          onclick: async () => {
            try {
              // Always ask, even when the server already has it open: this call is what
              // hands this browser the cookie, and another client may have opened it.
              await postJSON('/api/ports', { port: p.port, open: true });
              // Redrawn straight away rather than at the next fifteen-second beat: pressing
              // this is exactly when the address underneath is wanted, and waiting a quarter
              // of a minute for the row to admit it worked reads as it not having worked.
              paint();
              openWindow({ kind: 'web', url: through, label: `:${p.port}` });
            } catch (e) { toast(e.message, true); }
          },
        }));
      }

      /* The details, behind one press, on every row.
       *
       *  They used to appear only once a port had been opened to the proxy, which meant the
       *  way to *read the ssh line* was to press `Reach it` — an action with a consequence,
       *  to see a piece of text. Reported in those words. Now every port can be unfolded,
       *  opened or not: the tunnel line is true either way, and it is the answer for the two
       *  things a proxy in front of HTTP cannot do — a socket that is not HTTP, and a page
       *  that talks over a WebSocket.
       */
      const more = el('div', { className: 'portmore', hidden: !unfolded.has(p.port) });
      /* The address, whether or not the port has been opened yet.
       *
       *  It used to appear only once the port was open, which meant the way to *see the link*
       *  was to open the port — and the link is the thing people came for: something to paste
       *  into a new tab on the laptop they are actually working on. So it is always written
       *  out, and when the port is still shut the line underneath says so rather than the
       *  address being absent and unexplained.
       *
       *  With the token in it, because that is what makes it work anywhere. `Reach it` gives
       *  *this* browser a cookie scoped to `/proxy`, so the bare address works here and
       *  nowhere else — the opposite of the point.
       */
      if (!p.loopback) {
        more.append(addressLine(t('open it anywhere'), direct, t('it is on the network already')));
      } else {
        const ready = addressLine(t('open it anywhere'), withToken(`${location.origin}/proxy/${p.port}/`),
                                  open ? t('carries the key — treat it like the address bar')
                                       : t('clicking it opens the port first'));
        if (!open) {
          /* Clicking the link is the same intent as pressing `Reach it`, so it does both.
           *
           *  What it does *not* do is let the server open a port on its own when something
           *  asks for it: a port bound to loopback was bound there deliberately, and that
           *  stays a decision somebody makes. This is that decision, made by clicking.
           *
           *  The tab is opened after the port is, which some browsers treat as no longer
           *  being your click and refuse. If they do, the port is open anyway and the same
           *  link works on the second press — so that is what it says.
           */
          ready.querySelector('a').onclick = (ev) => {
            ev.preventDefault();
            /* The tab is opened *now*, empty, and sent somewhere once the port is.
             *
             *  A browser only allows `window.open` while it still believes it is inside your
             *  click, and an `await` ends that belief. So the first version opened the port and
             *  then asked for a tab it was no longer allowed to have, said so, and left you to
             *  click a second time — which is two clicks for one intention, and was reported in
             *  exactly those words. Opening a blank tab first keeps the gesture; the address
             *  goes in when the port answers, and if it refuses the tab is closed again rather
             *  than left sitting there on nothing.
             */
            const where = ev.currentTarget.href;
            const tab = window.open('', '_blank', 'noopener');
            postJSON('/api/ports', { port: p.port, open: true })
              .then(() => {
                paint();
                // A blocked popup must not become "we take you there instead": leaving Argus
                // was not what was asked for. The port is open by then, so the link works —
                // and saying so is better than hijacking the page you were on.
                if (tab) tab.location = where;
                else toast(t('port {port} is open — the link works now', { port: p.port }));
              })
              .catch((e) => { tab?.close(); toast(e.message, true); });
          };
        }
        more.append(ready);
      }
      const ssh = (where?.said?.ssh || []).find((x) => x.name === 'OpenSSH');
      if (ssh) {
        more.append(commandLine('ssh',
          ssh.line.replaceAll(String(where.said.port), String(p.port)),
          t('run this on your own machine, then open localhost:{port}', { port: p.port })));
      }
      more.append(commandLine(t('the process'), p.command || p.address, ''));

      const twist = el('button', {
        className: `winbtn twist${unfolded.has(p.port) ? ' on' : ''}`,
        title: t('How to reach it'), 'aria-label': t('How to reach it'),
        onclick: () => {
          const now = !unfolded.has(p.port);
          if (now) unfolded.add(p.port); else unfolded.delete(p.port);
          more.hidden = !now;
          twist.classList.toggle('on', now);
        },
      }, icon('down'));
      row.append(twist);

      list.append(row);
      list.append(more);
    }
  };
  paint();
  /* Its own beat, slower than the meters.
   *
   *  A port appearing is news; a port appearing four seconds sooner is not. This screen used
   *  to rebuild the whole ports section on every reading of the CPU, which fetched again,
   *  redrew rows nobody had asked it to redraw, and emptied the box mid-paste. Fifteen
   *  seconds, and only when the answer is different from the one on screen.
   */
  const beat = setInterval(() => { if (!document.hidden) paint(true); }, 15000);
  box.stop = () => clearInterval(beat);
  return box;
}

export async function screenSystem() {
  setTitle(t('System'));
  const body = el('div', { className: 'vitals' });
  view.append(body);

  /* Built once, then written into.
   *
   *  This screen used to empty itself and build again on every reading, four seconds apart,
   *  and that is what "the page blinks" was: the whole thing torn down and re-created while
   *  you were reading it. It also took the ports section with it — which fetches when it is
   *  constructed, so the polling was doubled, and which holds a text box you might be
   *  halfway through typing in.
   *
   *  So the shape is made once and each reading updates what has changed. Tiles are kept by
   *  name: a disk that appears gets a tile, one that goes away loses it, and the rest are
   *  moved into place rather than replaced — appending an element that is already in the
   *  document moves it, and moving does not flash.
   */
  /* How often it reads, and who decides.
   *
   *  Four seconds was the only answer, and it is the right one while you are watching a job
   *  eat a disk. It is the wrong one for a screen left open on a second monitor all day, and
   *  wrong again for somebody on a metered connection who wants to look when they look. So
   *  it is a choice, on the screen it governs rather than three menus away, and it is
   *  remembered.
   */
  const BEATS = [
    { key: 4000, label: t('4s') },
    { key: 15000, label: t('15s') },
    { key: 60000, label: t('1m') },
    { key: 300000, label: t('5m') },
    { key: 0, label: t('manual') },
  ];
  const beatNow = () => {
    const want = Number(prefs.systemEvery);
    return BEATS.some((b) => b.key === want) ? want : 4000;
  };
  let timer = null;
  let readAt = 0;

  const said = el('span', { className: 'meta' });
  const again = el('button', { className: 'winbtn', title: t('Read it again now') }, icon('refresh'));
  const beats = el('div', { className: 'jbar setjump' });
  const bar = el('div', { className: 'vitalbar' }, [
    again,
    said,
    el('span', { className: 'grow' }),
    el('span', { className: 'meta', textContent: t('every') }),
    beats,
  ]);

  const heroNum = el('div', { className: 'heronum' });
  const heroState = el('span', { className: 'state' });
  const heroWhat = el('span');
  const heroNote = el('div', { className: 'tilenote' });
  const hero = el('div', { className: 'hero' }, [
    heroNum,
    el('div', { className: 'herolabel' }, [heroState, heroWhat]),
    heroNote,
  ]);
  const grid = el('div', { className: 'tiles' });
  const procs = el('div', { className: 'proclist' });
  const procHead = el('div', { className: 'tilelabel', textContent: t('Largest processes') });
  procs.append(procHead);
  const trouble = el('p', { className: 'error', hidden: true });

  const where = whereSection();
  const ports = portsSection(where);
  // First, not last: "which address do I type" is the question people arrive with, and it
  // was under three screens of meters.
  body.append(bar, trouble, where, hero, grid, ports, procs);

  const tiles = new Map();
  const rows = [];

  const write = writeInto;

  const paint = (s) => {
    const worst = worstVital(s);

    if (hero.className !== `hero ${worst.level}`) hero.className = `hero ${worst.level}`;
    write(heroNum, `${Math.round(worst.pct)}%`);
    if (heroState.className !== `state ${worst.level}`) heroState.className = `state ${worst.level}`;
    write(heroState, LEVEL_WORD[worst.level]);
    write(heroWhat, ` · ${t('busiest')}: ${worst.what}`);
    write(heroNote, t('{host} · up {up} · {cores} cores',
      { host: s.hostname, up: duration(s.uptime), cores: s.cpu.cores }));

    const want = [
      { key: 'cpu', label: 'CPU', value: `${s.cpu.pct}%`, pct: s.cpu.pct, level: s.cpu.level,
        note: `load ${s.cpu.load.join('  ')} over ${s.cpu.cores} cores` },
      { key: 'memory', label: 'Memory', value: `${human(s.memory.used)} / ${human(s.memory.total)}`,
        pct: s.memory.pct, level: s.memory.level,
        note: `${human(s.memory.available)} available · ${human(s.memory.cached)} cached` },
    ];
    if (s.memory.swap_total) {
      want.push({ key: 'swap', label: 'Swap',
        value: `${human(s.memory.swap_used)} / ${human(s.memory.swap_total)}`,
        pct: s.memory.swap_pct, level: s.memory.swap_level,
        note: 'swapping under pressure is the warning sign' });
    }
    for (const g of s.gpus) {
      want.push({ key: `gpu:${g.name}`, label: g.name,
        value: `${human(g.mem_used)} / ${human(g.mem_total)}`, pct: g.mem_pct, level: g.level,
        note: `${g.util}% busy · ${g.temp}°C` });
    }
    for (const d of s.disks) {
      want.push({ key: `disk:${d.path}`, label: d.path,
        value: `${human(d.used)} / ${human(d.total)}`, pct: d.pct, level: d.level,
        note: `${human(d.free)} free` });
    }

    const here = new Set();
    let at = 0;
    for (const one of want) {
      here.add(one.key);
      let tile = tiles.get(one.key);
      if (!tile) {
        tile = meter(one.label, one.value, one.pct, one.level, one.note);
        tiles.set(one.key, tile);
      } else {
        tile.take(one.value, one.pct, one.level, one.note);
      }
      // Moved only when it is in the wrong place. Appending an element that is already
      // where it belongs still counts as taking it out and putting it back — measured:
      // twelve of those a tick, on a screen whose whole problem was churn.
      if (grid.children[at] !== tile) grid.insertBefore(tile, grid.children[at] || null);
      at += 1;
    }
    for (const [key, tile] of [...tiles]) {
      if (here.has(key)) continue;
      tile.remove();
      tiles.delete(key);
    }

    procs.hidden = !s.processes.length;
    // Same rows, new numbers. The list is "the six biggest", so which process is on which
    // row changes — the row is the shape, the text is the reading.
    while (rows.length > s.processes.length) rows.pop().node.remove();
    while (rows.length < s.processes.length) {
      /* Two lines now: the name alone — `java`, `python3` — is what made people ask what a
       * process was. Under it the full command, or, once you have labelled it, your label on
       * top and the name and command underneath. */
      const title = el('span', { className: 'proctitle' });
      const sub = el('span', { className: 'procsub' });
      const name = el('span', { className: 'procname' }, [title, sub]);
      const rss = el('span', { className: 'procnum' });
      const cpu = el('span', { className: 'procnum dim' });
      const row = { pid: null, label: '', proc: '' };
      const pen = labelButton(() => ({ pid: row.pid, label: row.label, name: row.proc }), () => tick());
      const node = el('div', { className: 'procrow' }, [name, rss, cpu, pen]);
      Object.assign(row, { node, name, title, sub, rss, cpu, pen });
      rows.push(row);
      procs.append(node);
    }
    s.processes.forEach((p, i) => {
      const r = rows[i];
      r.pid = typeof p.pid === 'number' ? p.pid : null;
      r.label = p.label || '';
      r.proc = p.name;
      write(r.title, p.label || p.name);
      write(r.sub, p.label ? [p.name, p.command].filter(Boolean).join(' · ') : (p.command || ''));
      r.sub.hidden = !r.sub.textContent;
      r.name.title = [p.label, p.command || p.name, r.pid ? `pid ${r.pid}` : ''].filter(Boolean).join('\n');
      r.node.classList.toggle('labelled', !!p.label);
      r.pen.hidden = !r.pid;
      write(r.rss, human(p.rss));
      write(r.cpu, `${p.cpu}%`);
    });
  };

  const tick = async () => {
    try {
      paint(await getJSON('/api/system'));
      readAt = Date.now();
      trouble.hidden = true;
    } catch (e) {
      // The reading that failed is not a reason to take away the last one that worked.
      write(trouble, e.message);
      trouble.hidden = false;
    }
    sayWhen();
  };

  // "read 12s ago" matters most when it is not being read often: on manual, it is the only
  // thing telling you how old the numbers in front of you are.
  function sayWhen() {
    const age = readAt ? Math.round((Date.now() - readAt) / 1000) : null;
    write(said, age === null ? t('not read yet')
      : age < 2 ? t('just now') : t('read {age}s ago', { age }));
  }

  // Only while the screen is actually in front of someone. A tab in the background reads
  // nothing, whatever the interval says, and reads once the moment it comes back.
  function setBeat() {
    clearInterval(timer);
    timer = null;
    const every = beatNow();
    for (const chip of beats.children) chip.classList.toggle('on', Number(chip.dataset.every) === every);
    if (every) timer = setInterval(() => { if (!document.hidden) tick(); }, every);
  }

  for (const one of BEATS) {
    const chip = el('button', { className: 'chip', type: 'button', textContent: one.label });
    chip.dataset.every = String(one.key);
    chip.onclick = () => {
      prefs.systemEvery = one.key;
      savePrefs();
      setBeat();
      if (one.key) tick();
    };
    beats.append(chip);
  }
  again.onclick = () => tick();

  await tick();
  setBeat();
  const ageing = setInterval(sayWhen, 1000);
  const wake = () => { if (!document.hidden && beatNow()) tick(); };
  document.addEventListener('visibilitychange', wake);
  setLeaving(() => {
    clearInterval(timer);
    clearInterval(ageing);
    document.removeEventListener('visibilitychange', wake);
    ports.stop?.();
  });
}

/** The token is 64 hex characters. Nobody should ever type that on a phone, and the
 *  address has to come from the server: reached through an editor's port forward the
 *  browser only knows `localhost`, which would send the phone nowhere. */
export async function handoffSheet() {
  const info = await serverInfo();
  const addresses = info.addresses?.length ? info.addresses : [location.hostname];
  const body = el('div', { className: 'sheetbody handoff' });
  let sheet;

  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  const holder = el('div', { className: 'qr' });
  const label = el('div', { className: 'tilenote' });
  const picker = el('div', { className: 'sheetbody actions' });

  const show = async (host) => {
    // The same fragment form the banner prints: this is a handoff link, and it is the one
    // most likely to be photographed, saved and reopened.
    const url = `${scheme}://${host}:${info.port}/#token=${encodeURIComponent(info.token)}`;
    label.textContent = url;
    holder.textContent = t('drawing…');
    try {
      const { default: qrcode } = await import('/vendor/qrcode-2.0.4/qrcode.mjs');
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch {
      holder.textContent = '';
      holder.append(el('p', { className: 'error', textContent: t('could not draw the code') }));
    }
    for (const b of picker.querySelectorAll('button')) b.classList.toggle('on', b.dataset.host === host);
  };

  for (const host of addresses) {
    const b = el('button', { className: 'ghost dup', textContent: host, onclick: () => show(host) });
    b.dataset.host = host;
    picker.append(b);
  }

  body.append(holder, label, picker);
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => copyText(label.textContent).then((ok) => toast(ok ? t('link copied') : t('could not reach the clipboard'), !ok)),
  }, [icon('clipboard'), el('span', { textContent: t('Copy the link instead') })]));

  // The code carries the token: photographing this screen is handing over the keys.
  body.append(el('p', { className: 'tilenote warn', textContent: t('This code contains the access token. Anyone who scans it is in.') }));

  sheet = modal(t('Open on another device'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  show(addresses[0]);
}

/** Pick a language, add one, or take the catalogue away to translate. */
export function languageSheet(list) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  for (const lang of list) {
    const on = activeLang === lang.code;
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        prefs.lang = lang.code;
        savePrefs();
        await loadLanguage(lang.code);
        translateMarkup();
        render();
      },
    }, [
      icon(on ? 'star' : 'file'),
      el('span', { className: 'grow', textContent: lang.name }),
      el('span', { className: 'verb', textContent: lang.source === 'user' ? t('yours') : lang.code }),
    ]));
  }

  body.append(el('div', { className: 'sheetsep' }));

  // Take the current catalogue away, translate it, bring it back.
  body.append(el('button', {
    className: 'ghost block',
    onclick: async () => {
      sheet.close();
      const code = prefs.lang || 'en';
      try {
        const doc = await getJSON(`/api/language/${code}`);
        const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `argus-${code}.json` });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (e) { toast(e.message, true); }
    },
  }, [icon('download'), el('span', { textContent: t('Download this catalogue to translate') })]));

  const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  picker.onchange = async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const r = await postJSON('/api/language', parsed);
      toast(t('{name} added, {n} strings', { name: r.name, n: r.count }));
      prefs.lang = r.code;
      savePrefs();
      await loadLanguage(r.code);
      translateMarkup();
      render();
    } catch (e) {
      toast(e instanceof SyntaxError ? t('that file is not JSON') : e.message, true);
    }
  };
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => picker.click(),
  }, [icon('upload'), el('span', { textContent: t('Import a language file…') })]), picker);

  sheet = modal(t('Language'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/** Draw a code you can photograph, into a box. */
async function drawQr(holder, url) {
  holder.textContent = t('drawing…');
  try {
    const { default: qrcode } = await import('/vendor/qrcode-2.0.4/qrcode.mjs');
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    holder.innerHTML = code.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch {
    holder.textContent = '';
    holder.append(el('p', { className: 'error', textContent: t('could not draw the code') }));
  }
}

/** The one and only time a device's token exists in readable form.
 *
 *  Said plainly, because the alternative — quietly hoping the reader photographs it now — ends
 *  with somebody minting five devices called "phone" looking for the one that works.
 */
function showNewDevice(name, link) {
  const holder = el('div', { className: 'qr' });
  const box = el('textarea', { className: 'copybox', value: link, readOnly: true, spellcheck: false });
  const body = el('div', { className: 'sheetbody' }, [
    el('p', { className: 'hint', textContent: t('Open this on {name}, once. It is not shown again — only a hash of it is kept here.', { name }) }),
    holder,
    box,
  ]);
  const sheet = modal(t('{name} is ready', { name }), body, [
    el('button', { className: 'ghost', textContent: t('Copy'), onclick: () => copyPath(link) }),
    el('button', { className: 'primary inline', textContent: t('Done'), onclick: () => sheet.close() }),
  ]);
  drawQr(holder, link);
  box.focus();
  box.select();
}

export function deviceRows() {
  const box = el('div');

  const draw = async () => {
    box.replaceChildren();
    let listed;
    try {
      listed = await getJSON('/api/devices');
    } catch (e) {
      if (e.status && e.status !== 403) {
        box.append(el('p', { className: 'hint', textContent: e.message }));
        return;
      }
      // A device token asking: the server says 403 and the honest thing is to say why.
      box.append(el('p', { className: 'hint', textContent: t('Only the token from the config can manage devices — this browser is holding a device token.') }));
      return;
    }
    for (const one of listed) {
      const row = el('div', { className: 'row setting' }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.name }),
          el('span', {
            className: 'meta',
            textContent: one.last_seen
              ? t('last used {when}', { when: duration(Date.now() / 1000 - one.last_seen) + ' ' + t('ago') })
              : t('never used'),
          }),
        ]),
        el('button', {
          className: 'ghost inline', textContent: t('Rename'),
          onclick: async () => {
            const now = await ask(t('What is this device called?'), one.name, t('Rename'));
            if (!now || now === one.name) return;
            try {
              await postJSON(`/api/devices/${encodeURIComponent(one.id)}`, { name: now });
            } catch (e) { toast(e.message, true); }
            draw();
          },
        }),
        el('button', {
          className: 'ghost inline danger', textContent: t('Revoke'),
          onclick: async () => {
            if (!await confirmBox(t('Revoke {name}?', { name: one.name }),
              t('That device will be signed out on its next request. Nothing else is affected.'),
              t('Revoke'))) return;
            try {
              await delJSON(`/api/devices/${encodeURIComponent(one.id)}`);
              toast(t('{name} revoked', { name: one.name }));
            } catch (e) { toast(e.message, true); }
            draw();
          },
        }),
      ]);
      box.append(row);
    }
    if (!listed.length) {
      box.append(el('p', { className: 'hint', textContent: t('No devices yet. The token in the config still works everywhere; a device gets its own, so one can be taken back on its own.') }));
    }
    box.append(el('button', {
      className: 'ghost inline', textContent: t('Add a device'),
      onclick: async () => {
        const name = await ask(t('What is this device called?'), '', t('Add'));
        if (!name) return;
        try {
          const made = await postJSON('/api/devices', { name });
          showNewDevice(made.device.name, made.link);
        } catch (e) { toast(e.message, true); }
        draw();
      },
    }));
  };

  draw();
  return box;
}

/* What has been done here, and what was refused.
 *
 *  The point of this screen is one question — *has somebody been in here* — so it is built
 *  around the answer to that rather than around a table. Refusals are counted at the top and
 *  marked in the list, and the address is given as much room as the action, because an address
 *  you do not recognise is the whole signal.
 *
 *  Only the token from the config can read it. A record that a stolen device could read is a
 *  record that tells whoever took it exactly what you can see.
 */
/** A short list of things to do, on the machine rather than in this browser.
 *
 *  Three columns because that is the whole idea: when you wrote it, what it says, and where it
 *  is. Every to-do list grows tags, projects, priorities and recurrence until it is a second
 *  job; the thing this competes with is a sticky note on a monitor, and a sticky note has no
 *  fields.
 *
 *  It lives beside the config on the server, like the pinned folders and unlike the desks: a
 *  note written at the desk and invisible from the phone would be worse than no note.
 */
export async function screenTodo() {
  setTitle(t('To do'));
  const wrap = el('div', { className: 'settings todo' });
  view.replaceChildren(wrap);

  let items = [];
  const STATES = ['open', 'doing', 'done'];
  const WORD = { open: t('to do'), doing: t('doing'), done: t('done') };
  let only = 'all';
  let needle = '';

  const rows = el('div', { className: 'todolist' });

  const chips = el('div', { className: 'todochips' });
  const drawChips = () => {
    chips.replaceChildren();
    for (const [key, label] of [['all', t('all')], ['open', WORD.open], ['doing', WORD.doing], ['done', WORD.done]]) {
      const n = key === 'all' ? items.length : items.filter((x) => x.status === key).length;
      chips.append(el('button', {
        className: `chip${only === key ? ' on' : ''}`,
        onclick: () => { only = key; paint(); },
      }, [el('span', { textContent: label }), el('span', { className: 'count', textContent: String(n) })]));
    }
  };


  const paint = () => {
    // The counts are part of the drawing, not a step beside it: called by hand they were right
    // when the screen opened and wrong the moment anything was added.
    drawChips();
    // And the badge on the icon, which is looking at the same list: ticking something off here
    // and watching the tab still say four until the next tick is the badge being wrong in the
    // one place you can see it is wrong.
    showCount('todo', items.filter((one) => one.status !== 'done').length);
    const want = items.filter((one) =>
      (only === 'all' || one.status === only)
      && (!needle || one.note.toLowerCase().includes(needle)));
    rows.replaceChildren();
    if (!items.length) {
      rows.append(el('p', { className: 'empty', textContent: t('Nothing on the list.') }));
    } else if (!want.length) {
      rows.append(el('p', { className: 'empty', textContent: t('Nothing matches that.') }));
    }
    for (const one of want) {
      /* The state is the button, and it cycles. Three states and a dropdown would be two
       *  presses for a thing that is really "I have started it" and "it is finished". */
      const state = el('button', {
        className: `todostate ${one.status}`, textContent: WORD[one.status],
        title: t('Press to move it on'),
        onclick: async () => {
          const next = STATES[(STATES.indexOf(one.status) + 1) % STATES.length];
          try {
            const said = await patchJSON(`/api/todo/${one.id}`, { status: next });
            Object.assign(one, said);
            paint();
          } catch (e) { toast(e.message, true); }
        },
      });
      // Click the words to change them, which is the only editing a line of text needs.
      const note = el('button', {
        className: 'todonote', textContent: one.note, title: t('Click to change the words'),
        onclick: function edit() {
          const box = el('input', { type: 'text', className: 'todobox', value: one.note });
          const done = async (save) => {
            if (!save || !box.value.trim() || box.value === one.note) return paint();
            try {
              Object.assign(one, await patchJSON(`/api/todo/${one.id}`, { note: box.value }));
            } catch (e) { toast(e.message, true); }
            paint();
          };
          box.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); done(true); }
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
          };
          box.onblur = () => done(true);
          this.replaceWith(box);
          box.focus();
          box.select();
        },
      });
      rows.append(el('div', { className: `todorow ${one.status}` }, [
        // The number you can say to an agent: "work on #3 and mark it done".
        el('span', { className: 'todonum', textContent: one.n ? `#${one.n}` : '', title: t('Say this number to an agent: “work on {n} and mark it done”', { n: `#${one.n}` }) }),
        state,
        note,
        one.by ? el('span', { className: 'todoby', textContent: t('by {who}', { who: one.by }), title: t('the agent that last moved it') }) : null,
        el('span', { className: 'todowhen', textContent: when(one.at), title: new Date(one.at * 1000).toLocaleString() }),
        el('button', {
          className: 'winbtn', title: t('Take it off the list'),
          onclick: async () => {
            try {
              await delJSON(`/api/todo/${one.id}`);
              items = items.filter((x) => x !== one);
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('trash')),
      ]));
    }
  };

  const box = el('input', {
    type: 'text', className: 'todobox', placeholder: t('what needs doing?'), spellcheck: false,
  });
  const add = async () => {
    const note = box.value.trim();
    if (!note) return;
    try {
      items = [await postJSON('/api/todo', { note }), ...items];
      box.value = '';
      paint();
    } catch (e) { toast(e.message, true); }
  };
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  const find = el('input', {
    type: 'search', className: 'jfind', placeholder: t('filter'), spellcheck: false,
    oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
  });

  wrap.append(
    el('div', { className: 'todoadd' }, [box, el('button', { className: 'primary inline', textContent: t('Add'), onclick: add })]),
    el('div', { className: 'jbar todobar' }, [chips, find]),
    rows,
  );

  try {
    items = (await getJSON('/api/todo')).items || [];
  } catch (e) {
    wrap.append(el('p', { className: 'hint', textContent: e.message }));
  }
  paint();
}
