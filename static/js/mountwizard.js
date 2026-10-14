/* Mount a folder of this machine on your own computer — a wizard (app/sshmount.py).
 *
 *  Asked for as "Argus suggests the commands, for Windows, Linux or Mac, to have the folder mounted
 *  — and how to put the key in, so it asks no password". Four steps, for the system it is looked at
 *  from (and the others a tab away): a key and letting it in — pasted here, Argus adds it — the tool,
 *  the mount itself and its undoing, or a copy kept in sync instead. Every command is written for this
 *  folder, this user and this machine, and copies with one press.
 */

// <imports> generated from what this file uses; edit the code, not this list
import { copyText, modal, showText, ticked } from '/js/dialogs.js';
import { el, wikiLink } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON, postJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>

const OSES = [['mac', 'macOS'], ['linux', 'Linux'], ['windows', 'Windows']];

function guessOs() {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'mac';
  return 'linux';
}

// Where Homebrew lives: /opt/homebrew on a Mac with an Apple chip (M1, M2…), /usr/local on an Intel one.
const BREW_AT = { apple: '/opt/homebrew', intel: '/usr/local' };
const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const FUSE_T = 'brew install macos-fuse-t/homebrew-cask/fuse-t macos-fuse-t/homebrew-cask/fuse-t-sshfs';

// Mutagen's names: letters, digits and dashes, not starting with a digit.
const syncName = (s) => { const n = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'argus'; return /^\d/.test(n) ? `f-${n}` : n; };

/** A guess at the Mac's chip, when the browser says (Chromium does, asked); Apple chips are the
 *  likely answer now. The person picks the other in one press. */
function guessChip() {
  const arch = navigator.userAgentData?.architecture;
  return arch === 'x86' ? 'intel' : 'apple';
}

const shq = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The commands, for one system, from what the fields say. */
export function mountCommands(os, { user, host, port, path, point, drive, name }) {
  const at = `${user}@${host}`;
  const p = Number(port) && Number(port) !== 22 ? Number(port) : 0;
  const sshP = p ? ` -p ${p}` : '';
  if (os === 'windows') {
    const win = path.replace(/^\/+/, '').replace(/\//g, '\\');
    // SSHFS-Win reads its key from id_rsa, and only that one (the \\sshfs.kr\ prefix).
    const key = '$env:USERPROFILE\\.ssh\\id_rsa.pub';
    return {
      key: `if (!(Test-Path ${key})) { ssh-keygen -t rsa -b 4096 -f $env:USERPROFILE\\.ssh\\id_rsa }\nGet-Content ${key} | Set-Clipboard`,
      copyId: `Get-Content ${key} | ssh${sshP} ${at} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`,
      test: `ssh${sshP} ${at} echo ok`,
      install: 'winget install -e --id WinFsp.WinFsp\nwinget install -e --id SSHFS-Win.SSHFS-Win',
      sshClient: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
      mount: `net use ${drive} \\\\sshfs.kr\\${at}${p ? `!${p}` : ''}\\${win}`,
      unmount: `net use ${drive} /delete`,
      sync: `mutagen sync create --name=${syncName(name)} "%USERPROFILE%\\${name}" ${at}:${p ? `${p}:` : ''}${path}`,
    };
  }
  const opts = os === 'mac' ? `reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,volname=${name},noappledouble`
    : 'reconnect,ServerAliveInterval=15,ServerAliveCountMax=3';
  return {
    key: os === 'mac'
      ? '[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519\npbcopy < ~/.ssh/id_ed25519.pub'
      : '[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519\ncat ~/.ssh/id_ed25519.pub',
    copyId: `ssh-copy-id${sshP} ${at}`,
    test: `ssh${sshP} ${at} echo ok`,
    install: os === 'mac'
      ? 'brew install macos-fuse-t/homebrew-cask/fuse-t macos-fuse-t/homebrew-cask/fuse-t-sshfs'
      : 'sudo apt install sshfs        # Debian, Ubuntu\nsudo dnf install fuse-sshfs   # Fedora, AlmaLinux, RHEL\n'
        + 'sudo zypper install sshfs     # openSUSE\nsudo pacman -S sshfs          # Arch',
    sshClient: os === 'mac' ? '' : 'sudo apt install openssh-client   # Debian, Ubuntu\nsudo dnf install openssh-clients  # Fedora, AlmaLinux, RHEL',
    mount: `mkdir -p ${shq(point)}\nsshfs${sshP} ${at}:${shq(path)} ${shq(point)} -o ${opts}`,
    unmount: os === 'mac' ? `umount ${shq(point)}` : `fusermount -u ${shq(point)}   # fusermount3 -u on newer systems`,
    sync: os === 'mac'
      ? `mkdir -p ~/.local/mutagen && curl -fsSL "$(curl -fsSL https://api.github.com/repos/mutagen-io/mutagen/releases/latest | grep -o 'https://[^"]*mutagen_darwin_'"$(uname -m | sed s/x86_64/amd64/)"'_v[^"]*[.]tar[.]gz' | head -1)" | tar -xz -C ~/.local/mutagen\n`
        + `~/.local/mutagen/mutagen sync create --name=${syncName(name)} ~/${shq(name)} ${at}:${p ? `${p}:` : ''}${shq(path)}`
      : `mutagen sync create --name=${syncName(name)} ~/${shq(name)} ${at}:${p ? `${p}:` : ''}${shq(path)}`,
  };
}

export async function mountWizard(path) {
  if (document.querySelector('dialog.mountwizard[open]')) return;
  const name = (path.replace(/\/+$/, '').split('/').pop() || 'argus').replace(/[^\w.-]+/g, '-');
  const said = await getJSON('/api/ssh/info').catch(() => ({ user: '', host: location.hostname, hosts: [], port: 22 }));
  const st = { os: guessOs(), user: said.user || '', host: said.host || location.hostname, port: said.port || 22, path,
    point: `~/mnt/${name}`, drive: 'Z:', name, chip: guessChip() };

  const body = el('div', { className: 'sheetbody mountbody' });
  const sheet = modal(t('Mount {name} on your computer', { name }), body, [
    el('button', { className: 'primary inline', type: 'button', textContent: t('Done'), onclick: () => sheet.close() }),
  ]);
  sheet.classList.add('mountwizard');

  const field = (label, key, attrs = {}) => {
    const { list, ...rest } = attrs;
    const input = el('input', { type: 'text', value: String(st[key]), spellcheck: false, autocapitalize: 'off', ...rest });
    if (list) input.setAttribute('list', list);   // a getter only, as a property
    input.oninput = () => { st[key] = input.value.trim(); paint(); makeFast(); };
    return el('label', { className: 'mwfield' }, [el('span', { textContent: label }), input]);
  };
  const hostList = el('datalist', { id: 'mwhosts' }, (said.hosts || []).map((h) => el('option', { value: h })));
  const tabs = el('div', { className: 'mwtabs', role: 'tablist' });
  const steps = el('div', { className: 'mwsteps' });

  const block = (text) => {
    const pre = el('pre', { className: 'mwcmd', textContent: text });
    const copy = el('button', { className: 'winbtn mwcopy', type: 'button', title: t('Copy') }, icon('copy'));
    copy.onclick = async () => { if (await copyText(text)) ticked(copy, 'copy'); else showText(t('The command'), text); };
    return el('div', { className: 'mwblock' }, [pre, copy]);
  };
  const step = (n, title, kids) => el('section', { className: 'mwstep' }, [
    el('h3', {}, [el('span', { className: 'mwn', textContent: String(n) }), el('span', { textContent: title })]), ...kids]);
  const note = (text) => el('p', { className: 'hint', textContent: text });

  // Pasted here, the key is let in by Argus itself: no password needed even the first time.
  const keyBox = el('textarea', { className: 'mwkey', rows: 2, spellcheck: false, placeholder: 'ssh-ed25519 AAAA… you@laptop' });
  const keySay = el('span', { className: 'meta' });
  const keyGo = el('button', { className: 'ghost inline', type: 'button', textContent: t('Let this key in') });
  keyGo.onclick = async () => {
    keyGo.disabled = true;
    try {
      const r = await postJSON('/api/ssh/authorize', { key: keyBox.value });
      keySay.textContent = r.already ? t('already let in: {key}', { key: r.key }) : t('let in: {key} — no password from now on', { key: r.key });
      keySay.className = 'meta mwok';
    } catch (e) { keySay.textContent = e.message; keySay.className = 'meta warn'; }
    keyGo.disabled = false;
  };

  // The fastest way first: one line to paste, made for this folder — a link Argus serves once, for
  // fifteen minutes, whose script makes the key, has Argus let it in, installs the tool and mounts.
  let fast = null;
  let making = null;
  const fastBox = el('div', { className: 'mwfast' });
  const makeFast = () => {
    clearTimeout(making);
    making = setTimeout(async () => {
      try {
        fast = await postJSON('/api/ssh/setup', { path, user: st.user, host: st.host, port: Number(st.port) || 22,
          point: st.point, drive: st.drive, base: location.origin });
      } catch (e) { fast = { error: e.message }; }
      paintFast();
    }, 250);
  };
  const paintFast = () => {
    if (!fast) { fastBox.replaceChildren(el('p', { className: 'hint', textContent: '…' })); return; }
    if (fast.error) { fastBox.replaceChildren(el('p', { className: 'meta warn', textContent: fast.error })); return; }
    const win = st.os === 'windows';
    fastBox.replaceChildren(
      el('h3', {}, [el('span', { textContent: win ? t('One command, in PowerShell') : t('One command, in a terminal') })]),
      block(win ? fast.ps1 : fast.sh),
      el('p', { className: 'hint' }, [
        t('It makes a key if you have none, has Argus let it in (no password, ever), installs what is missing and mounts the folder. The link works once, for {n} minutes.', { n: fast.minutes }), ' ',
        el('button', { className: 'ghost inline', type: 'button', textContent: t('New link'), onclick: () => { fast = null; paintFast(); makeFast(); } }),
      ]),
    );
  };

  /* The Mac's step 2, both ways it can go: which chip (Homebrew lives in a different place), and
   *  whether this account is an administrator — Homebrew and FUSE-T install system parts. */
  const macTool = () => {
    const brew = `${BREW_AT[st.chip]}/bin/brew`;
    const env = `eval "$(${brew} shellenv)"`;
    const chips = el('div', { className: 'mwtabs mwchips', role: 'tablist' }, [['apple', t('Apple chip (M1, M2…)')], ['intel', t('Intel')]].map(([k, label]) => {
      const b = el('button', { type: 'button', role: 'tab', textContent: label });
      b.setAttribute('aria-selected', String(st.chip === k));
      b.onclick = () => { st.chip = k; paint(); };
      return b;
    }));
    return [
      note(t('Which Mac? “uname -m” answers arm64 on an Apple chip, x86_64 on Intel (or the Apple menu → About This Mac).')),
      chips,
      note(t('Your account is an administrator (it may run sudo): install Homebrew, then FUSE-T and sshfs.')),
      block(`${BREW_INSTALL}\n${env}\necho '${env}' | tee -a ~/.zprofile ~/.bash_profile >/dev/null\n${FUSE_T}`),
      note(t('Not an administrator, but another account on this Mac is: install as that one (its name for <admin-account>), then come back.')),
      block('su - <admin-account>'),
      note(t('It asks that account’s password. Then, as that account:')),
      block(`${BREW_INSTALL}\n${env}\n${FUSE_T}\nexit`),
      note(t('Back in your own account, so that brew and sshfs are found:')),
      block(`${env}\necho '${env}' | tee -a ~/.zprofile ~/.bash_profile >/dev/null`),
      note(t('No administrator at all: mounting is out of reach on a Mac — step 4, a copy kept in sync, needs none.')),
      note(t('FUSE-T needs no change to macOS security settings (macFUSE does).')),
    ];
  };

  const paint = () => {
    tabs.replaceChildren(...OSES.map(([os, label]) => {
      const b = el('button', { type: 'button', role: 'tab', textContent: label });
      b.setAttribute('aria-selected', String(st.os === os));
      b.onclick = () => { st.os = os; paint(); paintFast(); };
      return b;
    }));
    const c = mountCommands(st.os, st);
    const win = st.os === 'windows';
    steps.replaceChildren(
      step(1, t('No password, ever: a key'), [
        note(win ? t('In PowerShell: make a key if there is none, and copy it.') : t('In a terminal: make a key if there is none, and copy it.')),
        ...(c.sshClient ? [
          note(win ? t('“ssh-keygen” not found? Turn on Windows’ OpenSSH client, in PowerShell as administrator:')
            : t('“ssh-keygen” not found? Install the SSH client:')),
          block(c.sshClient),
        ] : []),
        block(c.key),
        note(t('Then paste it here, and Argus lets it in on this machine:')),
        el('div', { className: 'mwkeyrow' }, [keyBox, keyGo]),
        keySay,
        note(t('— or let it in from your computer (this one asks the password once):')),
        block(c.copyId),
        note(t('Check: it should answer ok, with no password.')),
        block(c.test),
      ]),
      step(2, t('The tool that mounts it, once'), [
        ...(st.os === 'mac' ? macTool() : []),
        ...(win ? [note(t('WinFsp and SSHFS-Win, from winget (or their installers).'))] : []),
        ...(st.os === 'mac' ? [] : [block(c.install)]),
        ...(win ? [el('p', { className: 'hint' }, [t('No winget? Install the two from their pages, WinFsp first:'), ' ',
          el('a', { href: 'https://github.com/winfsp/winfsp/releases/latest', target: '_blank', rel: 'noopener', textContent: 'WinFsp' }), ' · ',
          el('a', { href: 'https://github.com/winfsp/sshfs-win/releases/latest', target: '_blank', rel: 'noopener', textContent: 'SSHFS-Win' })])] : []),
      ]),
      step(3, t('Mount it'), [
        note(win ? t('It appears as the drive {drive} in Explorer.', { drive: st.drive }) : t('It appears in {point}, and in the Finder or your file manager.', { point: st.point })),
        block(c.mount),
        note(t('Unmount:')),
        block(c.unmount),
        note(t('Files are read over the network when they are opened: fine for reports and figures, slow for a 10 GB FASTQ. A copy kept in sync is the other way:')),
      ]),
      step(4, t('Or keep a copy in sync (Mutagen)'), [
        note(t('A local copy that follows the folder both ways, and works offline.')),
        block(c.sync),
      ]),
    );
  };

  body.append(
    tabs,
    el('div', { className: 'mwfields' }, [
      field(t('user'), 'user'),
      field(t('machine'), 'host', { list: 'mwhosts' }),
      field(t('port'), 'port', { inputMode: 'numeric', size: 5 }),
      field(t('mount it at'), 'point'),
      field(t('drive (Windows)'), 'drive', { size: 3 }),
      hostList,
    ]),
    el('p', { className: 'meta mwpath' }, [t('Folder: {path}', { path }), ' · ', wikiLink('Mounting-a-folder', t('how it works'))]),
    fastBox,
    el('details', { className: 'mwmanual' }, [el('summary', { textContent: t('Step by step, to see what it does') }), steps]),
  );
  paint();
  paintFast();
  makeFast();
}
