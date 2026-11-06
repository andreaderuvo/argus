// <imports> generated from what this file uses; edit the code, not this list
import { confirmBox, copyText, modal, showText, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { delJSON, getJSON, postJSON, when, withToken } from '/js/reconnect.js';
import { openWindow } from '/js/tray.js';
import { t } from '/js/words.js';
// </imports>
/** Your computers, connected through argus-bridge (app/computers.py): Settings → Computers.
 *
 *  Each one with what it lends — Browser, Terminal, Actions, switched on *on that computer* — and
 *  what you can do with it from here: a terminal on it in a window of the desk, the browser's
 *  address for an agent, disconnect, forget. *Connect a computer* makes the link argus-bridge takes,
 *  and waits, live, for the computer to arrive.
 */

const RELEASES = 'https://github.com/andreaderuvo/argus-bridge/releases/latest';
const OFFERS = () => [['browser', t('Browser'), 'eye'], ['terminal', t('Terminal'), 'terminal'], ['actions', t('Actions'), 'play']];

/** A terminal on that computer, as a window of the desk on screen. */
export function openComputerTerminal(one) {
  openWindow({ kind: 'pc', id: one.id, name: one.name });
}

function offerChips(one) {
  return el('span', { className: 'pcoffers' }, OFFERS().map(([key, word, glyph]) => {
    const on = !!one.offers?.[key];
    const chip = el('span', { className: `pcoffer${on ? ' on' : ''}`, title: on ? t('{what}: on, on that computer', { what: word })
      : t('{what}: off — turned on in argus-bridge, on that computer', { what: word }) }, [icon(glyph), el('span', { textContent: word })]);
    chip.dataset.offer = key;
    return chip;
  }));
}

function computerRow(one, paint) {
  const act = (label, glyph, fn, kind = '') => el('button', { type: 'button', className: `pcbtn ${kind}`, title: label,
    onclick: () => Promise.resolve(fn()).catch((e) => toast(e.message, true)) }, [icon(glyph), el('span', { textContent: label })]);
  const buttons = [];
  if (one.offers?.terminal) buttons.push(act(t('Terminal'), 'terminal', () => openComputerTerminal(one), 'primary'));
  if (one.endpoint) {
    const copy = act(t('Browser address'), 'copy', async () => {
      if (await copyText(one.endpoint)) ticked(copy, 'copy'); else showText(t('The browser’s address, for an agent'), one.endpoint);
    });
    copy.title = t('The address an agent connects to (Playwright, Puppeteer, chrome-devtools-mcp) — agents get it themselves too');
    buttons.push(copy);
  }
  if (one.connected) {
    buttons.push(act(t('Disconnect'), 'stop', async () => {
      await postJSON(`/api/computers/${encodeURIComponent(one.id)}/disconnect`, {});
      toast(t('{name} disconnected: what it lent is closed', { name: one.name }));
      paint();
    }));
  }
  buttons.push(act(t('Forget'), 'trash', async () => {
    if (!await confirmBox(t('Forget {name}?', { name: one.name }), t('Its key stops working at once; to connect it again, make a new link.'), t('Forget'))) return;
    await delJSON(`/api/computers/${encodeURIComponent(one.id)}`);
    paint();
  }, 'danger'));
  const card = el('div', { className: `pcrow${one.connected ? ' on' : ''}` }, [
    el('span', { className: 'pcstate', title: one.connected ? t('Connected') : t('Not connected') }),
    el('div', { className: 'pcmain' }, [
      el('div', { className: 'pchead' }, [
        el('b', { className: 'pcname', textContent: one.name }),
        el('span', { className: 'meta', textContent: one.connected
          ? [one.os, one.client, one.since ? t('since {when}', { when: when(one.since) }) : ''].filter(Boolean).join(' · ')
          : t('not connected — argus-bridge is not running there, or that computer is off') }),
      ]),
      offerChips(one),
      (one.forwards || []).length ? el('div', { className: 'pcfws' }, one.forwards.map((f) => el('span', { className: 'pcfw' }, [
        el('span', { textContent: t('port {port} → localhost:{local}', { port: f.port, local: f.local }) }),
        el('button', { type: 'button', className: 'pcfwx', title: t('Stop showing it there'), onclick: async () => {
          await delJSON(`/api/computers/${encodeURIComponent(one.id)}/forward/${f.port}`); paint();
        } }, icon('close'))]))) : null,
      el('div', { className: 'pcacts' }, buttons),
    ]),
  ]);
  card.dataset.computer = one.id;
  return card;
}

/** "Open on Mac": a port of this server on the localhost of each connected computer — what the
 *  `ssh -N -L` line beside it does, without SSH, for whoever has argus-bridge (System). `own`: the port
 *  is Argus's own, and the address it gives carries the token, as any handoff link does. Nothing is
 *  drawn when no computer is connected: the ssh line is the answer then. */
export function onMyComputer(port, { own = false } = {}) {
  const box = el('div', { className: 'pcforward', hidden: true });
  getJSON('/api/computers').then((said) => {
    const here = (said.computers || []).filter((c) => c.connected);
    if (!here.length) return;
    box.hidden = false;
    box.replaceChildren(...here.map((one) => {
      const shown = (one.forwards || []).find((f) => f.port === Number(port));
      const link = (local) => {
        const url = `http://localhost:${local}/`;
        return el('a', { className: 'pcopen', href: own ? withToken(url) : url, target: '_blank', rel: 'noopener', textContent: url });
      };
      const row = el('div', { className: 'pcfwrow' });
      const go = el('button', { type: 'button', className: 'pcbtn primary' }, [icon('expand'),
        el('span', { textContent: t('Open on {name}', { name: one.name }) })]);
      go.title = t('Makes port {port} of this server appear on localhost of {name}, through argus-bridge — no SSH', { port, name: one.name });
      go.onclick = async () => {
        go.disabled = true;
        try {
          const r = await postJSON(`/api/computers/${encodeURIComponent(one.id)}/forward`, { port: Number(port) });
          row.replaceChildren(el('span', { className: 'meta', textContent: t('on {name}:', { name: one.name }) }), link(r.local));
          toast(t('port {port} is on {name} now: localhost:{local}', { port, name: one.name, local: r.local }));
        } catch (e) { toast(e.message, true); go.disabled = false; }
      };
      row.append(...(shown ? [el('span', { className: 'meta', textContent: t('on {name}:', { name: one.name }) }), link(shown.local)] : [go]));
      return row;
    }));
  }).catch(() => {});
  return box;
}

/** The rows of Settings → Computers, kept up to date while they are on screen. */
export function computerRows() {
  const box = el('div', { className: 'pclist' });
  const list = el('div');
  const connect = el('button', { type: 'button', className: 'ghost inline pcconnect' },
    [icon('plus'), el('span', { textContent: t('Connect a computer…') })]);
  connect.onclick = () => connectSheet(paint);
  let drawn = '';
  async function paint() {
    let said;
    try { said = await getJSON('/api/computers'); } catch { return; }
    const all = said.computers || [];
    const sig = JSON.stringify(all);
    if (sig === drawn) return;
    drawn = sig;
    list.replaceChildren(...(all.length ? all.map((one) => computerRow(one, () => { drawn = ''; paint(); }))
      : [el('p', { className: 'hint', textContent: t('Your Mac or PC, linked through argus-bridge: a terminal on it in a window here, its browser for the agents, a command an agent asks and you allow. Each switched on there, on the computer.') })]));
  }
  box.append(list, el('div', { className: 'pcfoot' }, [connect]));
  paint();
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (!document.hidden) paint();
  }, 3000);
  return box;
}

/** Connect a computer: a name, the link, and the computer arriving. */
export function connectSheet(then = () => {}) {
  const body = el('div', { className: 'sheetbody syncbody pcsheet' });
  const guess = /Mac/i.test(navigator.platform) ? 'Mac' : /Win/i.test(navigator.platform) ? 'PC' : t('my computer');
  const name = el('input', { type: 'text', className: 'linkbox', value: guess, ariaLabel: t('Its name'), spellcheck: false });
  const made = el('div', { className: 'syncmade' });
  const make = el('button', { className: 'primary inline', type: 'button', textContent: t('Make the link') });
  let waiting = null;
  const sheet = modal(t('Connect a computer'), body, [
    el('button', { className: 'primary inline', type: 'button', textContent: t('Done'), onclick: () => sheet.close() }),
  ]);
  sheet.classList.add('syncsheet');
  sheet.addEventListener('close', () => { clearInterval(waiting); then(); });

  make.onclick = async () => {
    make.disabled = true;
    try {
      const r = await postJSON('/api/computers/keys', { base: location.origin, name: name.value.trim() || guess });
      const copy = el('button', { className: 'winbtn', type: 'button', title: t('Copy') }, icon('copy'));
      copy.onclick = async () => { if (await copyText(r.link)) ticked(copy, 'copy'); else showText(t('The link'), r.link); };
      const line = `argus-bridge computer '${r.link}' --browser --terminal --actions`;
      const copyLine = el('button', { className: 'winbtn', type: 'button', title: t('Copy') }, icon('copy'));
      copyLine.onclick = async () => { if (await copyText(line)) ticked(copyLine, 'copy'); else showText(t('The command'), line); };
      const state = el('p', { className: 'pcwait' }, [el('span', { className: 'pcstate' }), el('span', { textContent: t('Waiting for {name}…', { name: r.computer.name }) })]);
      made.replaceChildren(
        el('ol', { className: 'pcsteps' }, [
          el('li', {}, [el('a', { className: 'primary inline syncopen', href: r.link, textContent: t('Open in argus-bridge') }),
            ' ', t('— on that computer. Then switch on what it lends: Browser, Terminal, Actions.')]),
          el('li', {}, [t('Or paste the link into argus-bridge:'), el('div', { className: 'mwblock' }, [el('pre', { className: 'mwcmd', textContent: r.link }), copy])]),
          el('li', {}, [t('Or, in a terminal there, with everything switched on:'), el('div', { className: 'mwblock' }, [el('pre', { className: 'mwcmd', textContent: line }), copyLine])]),
        ]),
        el('p', { className: 'meta', textContent: t('Shown once. Keep it to yourself: it connects that computer to this Argus.') }),
        state,
      );
      clearInterval(waiting);
      waiting = setInterval(async () => {
        if (!sheet.open) return clearInterval(waiting);
        const all = (await getJSON('/api/computers').catch(() => ({ computers: [] }))).computers || [];
        const one = all.find((c) => c.id === r.computer.id);
        if (one?.connected) {
          clearInterval(waiting);
          state.classList.add('on');
          state.lastChild.textContent = t('{name} is connected.', { name: one.name });
        }
      }, 1500);
    } catch (e) {
      made.replaceChildren(el('p', { className: 'meta warn', textContent: e.message }));
    }
    make.disabled = false;
  };

  body.append(
    el('p', { className: 'hint' }, t('Link your Mac or PC to Argus through argus-bridge — no SSH, nothing listening on the computer. On it you choose what it lends, all off until you switch it on: its browser, for the agents here; a terminal, for you, in a window of the desk; actions, a command an agent asks and you allow.')),
    el('p', { className: 'hint' }, [t('No app yet?') + ' ',
      el('a', { className: 'doclink', href: RELEASES, target: '_blank', rel: 'noopener', textContent: t('Download argus-bridge') })]),
    el('label', { className: 'pcname' }, [el('span', { className: 'meta', textContent: t('Its name') }), name]),
    el('div', { className: 'syncgo' }, [make]),
    made,
  );
  return sheet;
}
