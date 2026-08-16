// Record the short clips the project is shown with.
//
// A scene is a list of steps: something to do, and how long to hold afterwards. The page
// is driven through the debugging protocol rather than by hand, so a clip can be made
// again after the interface moves — which is the only way the clips stay true.
//
//   node scripts/record.mjs --list
//   node scripts/record.mjs paths            # one scene
//   node scripts/record.mjs all
//
// Wants: the demo instance (python3 scripts/demo.py) and a Chromium listening for the
// debugger on 9333. Frames come out of the browser's own screencast, each with the moment
// it was painted, so the timing in the file is the timing that happened.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const DEBUGGER = process.env.ARGUS_CDP || 'http://127.0.0.1:9333';
const DEMO = process.env.ARGUS_DEMO || 'http://127.0.0.1:8123';
const TOKEN = process.env.ARGUS_TOKEN || `${'0'.repeat(62)}de`;
const OUT = process.env.ARGUS_CLIPS || '/tmp/argus-clips';
const FFMPEG = [`${homedir()}/miniconda3/envs/argus-video/bin/ffmpeg`, 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p));

const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 780, deviceScaleFactor: 2, mobile: true };

/* ------------------------------------------------------------------ the browser */

const cdp = async () => {
  const pages = await (await fetch(`${DEBUGGER}/json/list`)).json();
  const target = pages.find((t) => t.type === 'page');
  if (!target) throw new Error('no page to drive');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    else if (m.method) listeners.forEach((fn) => fn(m));
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((res) => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- the scenes */

// Each step: what it does, and how long the finished picture is held. The holds are what
// makes a clip readable — an interface that never rests reads as a glitch.
const SCENES = {
  paths: {
    title: 'A path an agent printed opens beside it',
    size: WIDE,
    prefs: {
      sidebar: false,
      workspaces: [{ id: 1, name: 'Salmonella', desktop: [{ kind: 'term', name: 'claude' }] }],
      ws: 1, wsSeq: 1,
      winGeom: { '1:term:claude': { left: '20px', top: '20px', width: '1240px', height: '620px' } },
    },
    steps: [
      { hold: 1400 },
      { say: 'An agent finished. It printed where it wrote.', hold: 1200 },
      { run: `(() => {
          const rows = [...document.querySelectorAll('.deck.on .xterm-rows > div')];
          const row = rows.find(r => /report.md/.test(r.textContent || ''));
          if (!row) return 'no path on screen';
          const a = row.querySelector('a') || row;
          a.scrollIntoView({ block: 'center' });
          return 'found';
        })()`, hold: 900 },
      { click: '.deck.on .xterm-rows a', hold: 2600 },
      { say: 'One click. It is open next to the session that made it.', hold: 1800 },
    ],
  },

  keep: {
    title: 'Keep the arrangement you made',
    size: WIDE,
    prefs: {
      sidebar: false,
      workspaces: [{ id: 1, name: 'Salmonella', desktop: [
        { kind: 'term', name: 'claude' }, { kind: 'term', name: 'codex' },
        { kind: 'file', path: '/tmp/argus-demo/work/salmonella-2026/results/report.md' }] }],
      ws: 1, wsSeq: 1,
      winGeom: {
        '1:term:claude': { left: '8px', top: '8px', width: '620px', height: '330px' },
        '1:term:codex': { left: '8px', top: '346px', width: '620px', height: '300px' },
        '1:file:/tmp/argus-demo/work/salmonella-2026/results/report.md':
          { left: '636px', top: '8px', width: '628px', height: '638px' },
      },
    },
    steps: [
      { hold: 1200 },
      { say: 'Two agents and what they are arguing about.', hold: 1400 },
      { click: '[data-keep]', hold: 1600 },
      { say: 'Kept.', hold: 800 },
      { click: 'button[data-mode="grid"]', hold: 1800 },
      { say: 'Any arrangement throws yours away…', hold: 1200 },
      { click: '[data-mine]', hold: 2400 },
      { say: '…and one button brings it back.', hold: 1600 },
    ],
  },

  phone: {
    title: 'The same session, on the phone',
    size: PHONE,
    prefs: {
      sidebar: false,
      workspaces: [{ id: 1, name: 'Salmonella', desktop: [{ kind: 'term', name: 'claude' }] }],
      ws: 1, wsSeq: 1,
      winGeom: { '1:term:claude': { left: '4px', top: '4px', width: '382px', height: '560px' } },
    },
    steps: [
      { hold: 1600 },
      { say: 'The session that was already running. Not a new one.', hold: 2000 },
      { route: '#/sessions', hold: 2000 },
      { say: 'Three of them, on the machine, still running.', hold: 1800 },
    ],
  },

  path: {
    title: 'Type a path where the path is shown',
    size: WIDE,
    prefs: {
      sidebar: false,
      workspaces: [{ id: 1, name: 'Files', desktop: [{ kind: 'browser', id: 7, path: '/tmp/argus-demo' }] }],
      ws: 1, wsSeq: 1,
      winGeom: { '1:browser:7': { left: '260px', top: '40px', width: '760px', height: '600px' } },
    },
    steps: [
      { hold: 1200 },
      { click: '.deck.on .win .crumb', hold: 900 },
      { say: 'Click the address and write in it.', hold: 900 },
      { type: '/tmp/argus-demo/work/salmonella-2026/results', into: '.crumbbox', hold: 1400 },
      { key: 'Enter', hold: 2200 },
    ],
  },
};

/* ------------------------------------------------------------------- recording */

async function record(name) {
  const scene = SCENES[name];
  if (!scene) throw new Error(`no scene called ${name}`);
  const dir = `${OUT}/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const { send, on, close } = await cdp();
  await send('Page.enable');
  await send('Runtime.enable');
  // The terminal draws to a canvas with WebGL where it can, and a headless GPU renders it
  // blank. Refusing WebGL puts xterm on the DOM renderer, which records.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `const real = HTMLCanvasElement.prototype.getContext;
             HTMLCanvasElement.prototype.getContext = function (k, ...r) {
               return String(k).startsWith('webgl') ? null : real.call(this, k, ...r); };`,
  });
  await send('Emulation.setDeviceMetricsOverride', scene.size);
  if (scene.size.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) return `ERR ${(r.exceptionDetails.exception?.description || '').slice(0, 200)}`;
    return r?.result?.value;
  };
  const url = (route = '#/wall') => `${DEMO}/?token=${TOKEN}${route}`;

  // Settle the preferences, then load the page they describe.
  await send('Page.navigate', { url: 'about:blank' });
  await wait(300);
  await send('Page.navigate', { url: url() });
  await wait(4500);
  await ev(`document.querySelector('#update button:last-child')?.click()`);
  await ev(`localStorage.setItem('argus.prefs', JSON.stringify(${JSON.stringify(scene.prefs)}))`);
  await send('Page.navigate', { url: 'about:blank' });
  await wait(300);
  await send('Page.navigate', { url: url() });
  await wait(scene.size.mobile ? 8000 : 7000);
  await ev(`document.querySelector('#update button:last-child')?.click()`);
  // A caption lives in the page, so it is recorded with everything else rather than
  // burned in afterwards by a filter nobody can read.
  await ev(`(() => {
    const s = document.createElement('style');
    s.textContent = '#shotsay{position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(11,14,20,.92);color:#e6e9ef;border:1px solid #1e2530;border-radius:.6rem;'
      + 'padding:.6rem 1rem;font:500 15px/1.4 system-ui,sans-serif;max-width:80%;text-align:center;'
      + 'opacity:0;transition:opacity .25s;pointer-events:none}#shotsay.on{opacity:1}';
    document.head.append(s);
    const n = document.createElement('div');
    n.id = 'shotsay';
    document.body.append(n);
    window.__say = (t) => { n.textContent = t; n.classList.toggle('on', !!t); };
  })()`);

  const frames = [];
  on((m) => {
    if (m.method !== 'Page.screencastFrame') return;
    frames.push({ data: m.params.data, at: m.params.metadata.timestamp });
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
  });
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

  for (const step of scene.steps) {
    if (step.route) { await send('Page.navigate', { url: url(step.route) }); await wait(4000); }
    if (step.run) await ev(step.run);
    if (step.click) await ev(`document.querySelector(${JSON.stringify(step.click)})?.click()`);
    if (step.type) {
      await ev(`document.querySelector(${JSON.stringify(step.into)})?.select()`);
      for (const ch of step.type) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await wait(45);
      }
    }
    if (step.key) {
      const code = step.key === 'Enter' ? 13 : 27;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: step.key, code: step.key, windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code: step.key });
    }
    if (step.say !== undefined) await ev(`window.__say(${JSON.stringify(step.say)})`);
    await wait(step.hold ?? 1000);
    if (step.say) await ev(`window.__say('')`);
  }
  await send('Page.stopScreencast');
  await wait(400);
  close();

  if (!frames.length) throw new Error('the screencast produced nothing');

  // Real timings: each frame is held until the next one was painted.
  const list = [];
  for (let i = 0; i < frames.length; i += 1) {
    const file = `${dir}/f${String(i).padStart(5, '0')}.png`;
    await writeFile(file, Buffer.from(frames[i].data, 'base64'));
    const next = frames[i + 1]?.at ?? frames[i].at + 0.08;
    list.push(`file '${file}'`, `duration ${Math.max(0.02, next - frames[i].at).toFixed(3)}`);
  }
  list.push(`file '${dir}/f${String(frames.length - 1).padStart(5, '0')}.png'`);
  await writeFile(`${dir}/frames.txt`, `${list.join('\n')}\n`);

  const seconds = (frames.at(-1).at - frames[0].at).toFixed(1);
  await assemble(dir, name);
  console.log(`  ${name}: ${frames.length} frames, ${seconds}s -> ${OUT}/${name}.mp4 and .gif`);
}

const run = (cmd, args) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.slice(-500)))));
});

async function assemble(dir, name) {
  if (!FFMPEG) throw new Error('no ffmpeg — conda create -n argus-video -c conda-forge ffmpeg');
  // yuv420p and an even size, or half the players in the world show nothing.
  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', `${dir}/frames.txt`,
    '-vf', `${even},fps=30`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${OUT}/${name}.mp4`]);
  // A palette of its own, because a dark interface through the default 216 colours bands
  // into something that looks broken.
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', `${dir}/frames.txt`,
    '-vf', `${even},fps=15,scale=900:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
    `${OUT}/${name}.gif`]);
}

/* ------------------------------------------------------------------------ main */

const args = process.argv.slice(2);
if (!args.length || args[0] === '--list') {
  console.log('scenes:');
  for (const [key, s] of Object.entries(SCENES)) console.log(`  ${key.padEnd(8)} ${s.title}`);
  process.exit(0);
}
await mkdir(OUT, { recursive: true });
for (const name of args[0] === 'all' ? Object.keys(SCENES) : args) {
  await record(name);
}
process.exit(0);
