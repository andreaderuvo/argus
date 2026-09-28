// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { copies, copyText, showText, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { setCurrent } from '/js/pointing.js';
import { getJSON, human, parentOf, postJSON, setTitle, signOut, triggerDownload, when, withToken } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { keepMyPlace, playedTo } from '/js/screens.js';
import { paintRailDesks } from '/js/sidebar.js';
import { bar, prefs, server, view } from '/js/state.js';
import { chooseDesk, nextWindowId, openWindow, watchers } from '/js/tray.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------- the PDF viewer */

/* Drawn here rather than handed to the browser.
 *
 *  The browser's own viewer will not say where it is. Measured: an <embed> answers
 *  documentLoaded and getSelectedText and stays silent while you scroll, so the place you
 *  had reached was not something that could be recorded, let alone put back — and it obeys
 *  `view=Fit` while silently dropping `view=FitH`, which is why page width never survived
 *  anything. Every one of those is a consequence of not owning the viewer.
 *
 *  So: pdf.js. Page width applies because we compute it, the place is remembered because
 *  we know it, and a rebuilt document comes back where you were reading.
 */
const PDFJS = '/vendor/pdfjs-4.10.38/';
let pdfjs = null;
async function pdfEngine() {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
  }
  return pdfjs;
}

/** Where you had got to in each document: the zoom you chose and how far down you read.
 *  In the preferences, because the reload is exactly when it is wanted. */
const pdfPlace = new Map(Object.entries(prefs.pdfPlace || {}));
const PLACES_KEPT = 60;
let placeSaved = 0;
function keepThePlace(path, place, force = false) {
  pdfPlace.delete(path);
  pdfPlace.set(path, place);
  while (pdfPlace.size > PLACES_KEPT) pdfPlace.delete(pdfPlace.keys().next().value);
  const now = Date.now();
  if (!force && now - placeSaved < 2000) return;   // scrolling fires constantly
  placeSaved = now;
  prefs.pdfPlace = Object.fromEntries(pdfPlace);
  savePrefs();
}

const PAGE_GAP = 10;

/* What the browser's own viewer will accept.
 *
 *  Measured, because the specification and the implementation disagree: Chrome honours
 *  `view=Fit` and `view=FitBH`, and silently drops `view=FitH` — which is the whole reason
 *  page width never survived a reload back when the viewer was the browser's. `page=` is
 *  honoured, so the page you had reached can be handed over even though the scroll position
 *  within it cannot.
 */
const NATIVE_FITS = {
  page: 'view=Fit&zoom=page-fit',
  width: 'view=FitBH&zoom=page-width',
  actual: '',
};

/** Read the app's own colours off the document, the way `termTheme` does — so a mesh sits
 *  in the page rather than in a box some other palette drew. */
function paletteColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Every mesh on screen, redone after the palette changed under it. Mirrors
 *  `repaintDiagrams` — a colour baked into a drawing has to be told, a CSS one does not. */
export function repaintMeshes() {
  for (const canvas of document.querySelectorAll('canvas.meshview')) canvas._meshRepaint?.();
}

/** three.js, loaded once and shared by every kind of mesh this app draws. */
async function loadThree() {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('three'),
    import('/vendor/three-0.185.1/OrbitControls.js'),
  ]);
  return { THREE, OrbitControls };
}

/* One loader per process, however many models get opened.
 *
 *  `occtimportjs()` compiles a 7.5 MB WebAssembly module — the OpenCascade CAD kernel,
 *  which is a different scale of thing from a mesh format's own parser and is why STEP is
 *  loaded separately from STL rather than folded into the same bundle. Doing that twice in
 *  one visit because two STEP files were opened would be paying for it twice; the promise
 *  is cached, not the result, so a failed load can still be retried on the next file.
 */
let occtLoading = null;
function loadOcct() {
  if (!occtLoading) {
    /* A classic script, not a module — Emscripten's own glue attaches `occtimportjs` as a
     *  plain global, with `export` nowhere in it, so `import()` resolves to an empty
     *  namespace and calling anything off it fails; a `<script>` tag is what this build
     *  was actually written for. */
    occtLoading = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = '/vendor/occt-import-js-0.0.23/occt-import-js.js';
      tag.onload = () => resolve(window.occtimportjs);
      tag.onerror = () => reject(new Error('could not load occt-import-js.js'));
      document.head.append(tag);
    }).then((init) => init({
      locateFile: (path) => `/vendor/occt-import-js-0.0.23/${path}`,
    }))
      .catch((e) => { occtLoading = null; throw e; });
  }
  return occtLoading;
}

/** One `THREE.BufferGeometry` per part in a STEP assembly. Colours are not read from the
 *  file — this wears the app's palette, the same choice STL already made — only the shape. */
function occtGeometries(THREE, result) {
  return (result.meshes || []).map((m) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index.array), 1));
    return g;
  });
}

/** A triangle mesh, orbitable — an STL's one part, or a STEP assembly's several.
 *
 *  three.js is vendored for exactly this and loaded only when a document of this kind is
 *  opened — the same bargain mermaid and pdf.js already made. `STLLoader` takes binary or
 *  ASCII without being told which, because the format itself does not say either; nothing
 *  here has to guess. STEP is read by OCCT itself, compiled to WebAssembly, because a STEP
 *  file is a boundary representation — curved surfaces described algebraically — and
 *  tessellating that into triangles is a CAD kernel's job, not something worth
 *  reimplementing badly here.
 *
 *  Faceted on purpose: `flatShading` computes each triangle's normal from its own geometry
 *  rather than trusting whatever the file says, which for a mechanical part is both the
 *  conventional look — edges, not a smooth blend across them — and the safer choice, since
 *  a bad or absent normal in the file is a real thing that happens and a computed one
 *  cannot be wrong in the same way.
 *
 *  Disposal has two routes in because this is mounted from two places that dispose
 *  differently. A window's own `dispose()` reaches it through `ctl.onDispose` — the one
 *  reliable signal that a desk window has closed while the desk itself has not gone
 *  anywhere, so no navigation follows for a `hashchange` to catch. The full-screen route
 *  has no such signal of its own, so a `hashchange` listener stands in for it: leaving
 *  `#/preview` for anywhere else fires one. Both are wired, both call the same guarded
 *  function, and whichever fires first wins — a stray rAF loop holding a WebGL context
 *  open on a canvas nobody can see any more is the failure mode this exists to prevent.
 */
async function mountMesh(host, buf, ctl, kind = 'stl') {
  host._meshDispose?.();

  let THREE, OrbitControls;
  try {
    ({ THREE, OrbitControls } = await loadThree());
  } catch {
    host.append(el('p', { className: 'error', textContent: t('the 3D viewer did not load') }));
    return;
  }

  let geometries;
  try {
    if (kind === 'step') {
      const occt = await loadOcct();
      const result = occt.ReadStepFile(new Uint8Array(buf), null);
      if (!result.success) throw new Error(t('OCCT could not read this file'));
      geometries = occtGeometries(THREE, result);
      if (!geometries.length) throw new Error(t('the file has no shapes in it'));
    } else {
      const { STLLoader } = await import('/vendor/three-0.185.1/STLLoader.js');
      geometries = [new STLLoader().parse(buf)];
    }
  } catch (e) {
    host.append(el('p', {
      className: 'error',
      textContent: `${t('this file did not open as a 3D model')} — ${String(e.message || e).split('\n')[0]}`,
    }));
    return;
  }

  // Raw coordinates are wherever the part sat in whatever program exported it — often
  // nowhere near the origin, and for an assembly of several parts the offset has to be the
  // *same* one for every part, or centring each on its own would tear the assembly apart.
  const box = new THREE.Box3();
  for (const g of geometries) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const middle = box.getCenter(new THREE.Vector3());
  for (const g of geometries) g.translate(-middle.x, -middle.y, -middle.z);
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;

  const canvas = el('canvas', { className: 'meshview' });
  host.append(canvas);

  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.6, flatShading: true, side: THREE.DoubleSide });
  // Both sides, because a face's winding is only a convention and plenty of real files get
  // some of their triangles backwards — a hole in the surface would read as a bug in the
  // viewer rather than as what it actually is. One material for the whole assembly, same
  // as one part: colour here is the app's, not whatever the file happened to say.
  for (const g of geometries) scene.add(new THREE.Mesh(g, material));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x30384a, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(radius, radius * 1.5, radius * 2);
  scene.add(key);

  const paint = () => {
    scene.background = new THREE.Color(paletteColor('--bg', '#0b0e14'));
    material.color = new THREE.Color(paletteColor('--accent', '#8fd6a0'));
  };
  paint();
  canvas._meshRepaint = paint;

  const camera = new THREE.PerspectiveCamera(45, 1, radius / 1000, radius * 100);
  camera.position.set(radius * 1.6, radius * 1.2, radius * 1.8);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const fit = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(host);

  let raf = requestAnimationFrame(frame);
  function frame() {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('hashchange', dispose);
    controls.dispose();
    for (const g of geometries) g.dispose();
    material.dispose();
    renderer.dispose();
    if (host._meshDispose === dispose) host._meshDispose = null;
  };
  host._meshDispose = dispose;
  /* Two routes in, because a hash change means two different things depending on who
   *  mounted this.
   *
   *  A window's `ctl.onDispose` is the precise signal: this fires only when the window
   *  itself has closed, and a window survives navigating to Settings and back exactly as
   *  a live terminal does, so it must NOT be torn down by an unrelated hash change — which
   *  is what a blanket listener did the first time this was measured: opening the mesh in
   *  a window, visiting Settings, and coming back left a dead render loop on a canvas that
   *  looked untouched, because the hashchange fired for a navigation that had nothing to do
   *  with this window at all.
   *
   *  The full-screen route has no such signal of its own — leaving `#/preview` for
   *  anywhere else really is the whole of this viewer's lifetime ending — so the
   *  `hashchange` fallback is kept for exactly the caller that needs it.
   */
  if (ctl.onDispose) ctl.onDispose(dispose);
  else window.addEventListener('hashchange', dispose, { once: true });
}

/** The browser's viewer, for a reader who asked for it.
 *
 *  It is faster on a long document and some people simply prefer it. What is given up is
 *  everything that comes from owning the viewer: the scroll position within a page, the fit
 *  surviving a reload, and finding text from a phone. The page number is handed over because
 *  that much it will take.
 */
function mountNativePdf(host, path, address) {
  const place = pdfPlace.get(path);
  const asks = [NATIVE_FITS[prefs.pdfFit || 'page'], place?.page > 1 ? `page=${place.page}` : '']
    .filter(Boolean).join('&');
  host.textContent = '';
  host.append(el('iframe', {
    className: 'preview pdfnative',
    src: asks ? `${address}#${asks}` : address,
    title: path.split('/').pop() || 'PDF',
  }));
}

async function mountPdf(host, path, address, download) {
  // Asked for, rather than fallen back to. The fallback further down is a different thing:
  // that one happens when pdf.js cannot open the file at all.
  if (prefs.pdfNative) return mountNativePdf(host, path, address);

  const scroller = el('div', { className: 'pdfscroll' });
  /* Going to a page you have in mind.
   *
   *  A number on its own is a label; on a fifty-page paper what you want is to put 31 in
   *  and be there. So the number is the box you type in, with a step either side of it —
   *  and the arrows earn their room, because "the next page" is the commonest jump there
   *  is and a scroll is a poor way to ask for it.
   */
  const back = el('button', { className: 'winbtn', title: t('Previous page') }, icon('up'));
  const on = el('input', { className: 'pdfat', type: 'text', inputMode: 'numeric', spellcheck: false });
  const count = el('span', { className: 'pdfcount' });
  const next = el('button', { className: 'winbtn', title: t('Next page') }, icon('down'));
  const zoomOut = el('button', { className: 'winbtn', title: t('Smaller') }, icon('compress'));
  const zoomIn = el('button', { className: 'winbtn', title: t('Bigger') }, icon('expand'));
  const zoomSays = el('span', { className: 'pdfzoom' });
  const fitBtn = el('button', { className: 'winbtn wide', title: t('How it fits') }, [icon('fit'), el('span', {})]);
  const results = el('div', { className: 'pdfhits', hidden: true });
  const box = el('input', { type: 'search', placeholder: t('find in this document…'), spellcheck: false });
  const bar = el('div', { className: 'pdfsearch', hidden: true }, [box, results]);
  // A search box costs a row of the document for as long as it is open, and most of the
  // time nobody is searching. It folds into the button that opens it, over the page.
  // In the bar, not floating over the page. It floated because there was no bar to put it
  // in; now there is one, and a button hovering over the top corner of a document is a
  // button covering the top corner of a document.
  /* Out to the browser, for the things it does and we do not: printing, its own search,
   *  handing the file to something else. The fit we would ask for goes with it, since that
   *  is a preference you have already expressed. */
  const away = el('button', { className: 'winbtn', title: t('Open in a browser tab') }, icon('newtab'));
  away.onclick = () => {
    const asks = { width: '#view=FitBH&zoom=page-width', page: '#view=Fit&zoom=page-fit' };
    window.open(`${address}${asks[mode] || ''}`, '_blank', 'noopener');
  };
  const finder = el('button', { className: 'winbtn pdffind', title: t('Find in this document') }, icon('search'));
  const head = el('div', { className: 'pdfbar' },
    [back, on, count, next, el('span', { className: 'grow' }), zoomOut, zoomSays, zoomIn, fitBtn, away, finder]);
  const wrap = el('div', { className: 'pdfwrap' }, [head, scroller, bar]);
  host.textContent = '';
  host.append(wrap);

  let lib;
  let doc;
  try {
    lib = await pdfEngine();
    doc = await lib.getDocument({ url: address, standardFontDataUrl: `${PDFJS}standard_fonts/` }).promise;
  } catch (e) {
    // Never leave the reader with nothing: the browser's viewer is still there, and for a
    // document pdf.js will not open it may well cope.
    host.textContent = '';
    host.append(el('div', { className: 'notice', textContent: t('shown by the browser: {why}', { why: e?.message || 'pdf.js' }) }));
    host.append(el('iframe', { className: 'preview', src: `${address}#view=FitBH&zoom=page-width` }));
    return;
  }

  // Every page's own size, asked once. Everything else is arithmetic on these.
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const v = page.getViewport({ scale: 1 });
    sizes.push({ width: v.width, height: v.height });
  }
  const widest = Math.max(...sizes.map((s) => s.width));
  const tallest = Math.max(...sizes.map((s) => s.height));

  const MODES = ['width', 'page', 'actual'];
  const NAMED = () => ({ width: t('page width'), page: t('whole page'), actual: t('as it comes') });
  const was = pdfPlace.get(path);
  let mode = was?.mode || (MODES.includes(prefs.pdfFit) ? prefs.pdfFit : 'width');
  let scale = 1;

  const room = () => ({
    width: Math.max(120, scroller.clientWidth - PAGE_GAP * 2 - 2),
    height: Math.max(120, scroller.clientHeight - PAGE_GAP * 2),
  });
  const scaleFor = () => {
    const r = room();
    if (mode === 'actual') return lib.PixelsPerInch.PDF_TO_CSS_UNITS;
    if (mode === 'page') return Math.min(r.width / widest, r.height / tallest);
    return r.width / widest;
  };

  const slots = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const slot = el('div', { className: 'pdfsheet' });
    slot.dataset.page = String(n);
    slots.push(slot);
    scroller.append(slot);
  }

  /** Give every page its size at this scale, so the scrollbar tells the truth before a
   *  single page has been drawn. */
  const layout = () => {
    slots.forEach((slot, i) => {
      const w = Math.floor(sizes[i].width * scale);
      const h = Math.floor(sizes[i].height * scale);
      slot.style.width = `${w}px`;
      slot.style.height = `${h}px`;
      slot.style.setProperty('--scale-factor', String(scale));
    });
    zoomSays.textContent = `${Math.round((scale / lib.PixelsPerInch.PDF_TO_CSS_UNITS) * 100)}%`;
    fitBtn.lastChild.textContent = NAMED()[mode];
  };

  const drawn = new Map();          // page number -> the scale it was drawn at
  const busy = new Set();

  async function draw(slot) {
    const n = Number(slot.dataset.page);
    if (busy.has(n) || drawn.get(n) === scale) return;
    busy.add(n);
    try {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);   // beyond 2 it is memory for nothing
      const canvas = el('canvas', { className: 'pdfcanvas' });
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      }).promise;
      // The text, invisible, laid exactly over the picture: that is what makes a selection
      // you can copy out of a drawing of a page.
      const layer = el('div', { className: 'textLayer' });
      const text = new lib.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
      await text.render();
      slot.replaceChildren(canvas, layer);
      drawn.set(n, scale);
    } catch { /* one page that will not draw must not take the document with it */ }
    busy.delete(n);
  }

  /** Pages far from the eye give their pixels back. A 53-page paper at page width is
   *  200MB of canvas if every page is kept, which a phone does not have. */
  const forget = (slot) => {
    const n = Number(slot.dataset.page);
    if (!drawn.has(n)) return;
    slot.replaceChildren();
    drawn.delete(n);
  };

  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) draw(entry.target);
      else forget(entry.target);
    }
  }, { root: scroller, rootMargin: '600px 0px' });
  slots.forEach((slot) => near.observe(slot));

  /** Which page you are looking at: the one crossing the middle of the window. */
  const showing = () => {
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let at = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i].offsetTop <= middle) at = i; else break;
    }
    return at + 1;
  };
  const sayPage = () => {
    const n = showing();
    count.textContent = t('of {total}', { total: doc.numPages });
    // Not while you are typing in it: scrolling must not rewrite the number under your
    // fingers before you have finished asking for one.
    if (document.activeElement !== on) on.value = String(n);
    back.disabled = n <= 1;
    next.disabled = n >= doc.numPages;
  };

  const remember = (force = false) => {
    keepThePlace(path, { mode, scale, top: Math.round(scroller.scrollTop), page: showing() }, force);
  };

  // A desk that is not the one on screen is display:none, and everything inside it
  // measures zero. Nothing here may act on those measurements.
  const onScreen = () => scroller.clientWidth > 0 && scroller.clientHeight > 0;

  const rescale = (next, keepMiddle = true) => {
    // Clamped to a fraction. Unclamped, a hidden desk gives scrollHeight and clientHeight
    // of nothing, the divisor falls back to 1, and "the fraction you were scrolled to"
    // comes out as four thousand — which lands, every time, at the end of the document.
    const span = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const before = Math.min(1, Math.max(0, scroller.scrollTop / span));
    scale = next;
    layout();
    drawn.clear();
    for (const slot of slots) if (slot.firstChild) slot.replaceChildren();
    if (keepMiddle) {
      scroller.scrollTop = before * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }
    for (const slot of slots) {
      const top = slot.offsetTop;
      if (top + slot.offsetHeight > scroller.scrollTop - 600 && top < scroller.scrollTop + scroller.clientHeight + 600) draw(slot);
    }
    sayPage();
    remember(true);
  };

  fitBtn.onclick = () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    rescale(scaleFor());
  };
  zoomIn.onclick = () => { mode = 'free'; rescale(Math.min(scale * 1.25, 8)); };
  zoomOut.onclick = () => { mode = 'free'; rescale(Math.max(scale / 1.25, 0.1)); };

  scroller.addEventListener('scroll', () => {
    if (!onScreen()) return;   // a hidden desk scrolling to zero is not you moving
    sayPage();
    remember();
  }, { passive: true });
  window.addEventListener('pagehide', () => remember(true), { once: true });

  // A window being resized changes what "page width" means, and only while a fit is what
  // you asked for: a zoom you set by hand is yours to keep.
  let last = 0;
  const watchRoom = new ResizeObserver(() => {
    if (!onScreen()) { last = 0; return; }
    // Coming back from a desk you had switched away from: display:none threw the scroll
    // position away, so it is put back rather than re-measured.
    if (last === 0) {
      last = scroller.clientWidth;
      const place = pdfPlace.get(path);
      if (place?.top) scroller.scrollTop = place.top;
      sayPage();
      return;
    }
    if (mode === 'free' || Math.abs(scroller.clientWidth - last) < 2) return;
    last = scroller.clientWidth;
    rescale(scaleFor());
  });
  watchRoom.observe(scroller);

  scale = was?.scale || scaleFor();
  if (was?.mode) mode = was.mode;
  layout();
  sayPage();
  // Back where you were reading, to the pixel — the whole reason for drawing this ourselves.
  if (was?.top) scroller.scrollTop = was.top;
  for (const slot of slots.slice(0, 3)) draw(slot);

  const goToPage = (n) => {
    const slot = slots[Math.max(0, Math.min(doc.numPages, n) - 1)];
    if (slot) scroller.scrollTop = slot.offsetTop - PAGE_GAP;
  };
  back.onclick = () => goToPage(showing() - 1);
  next.onclick = () => goToPage(showing() + 1);
  on.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToPage(Number(on.value) || 1); on.blur(); }
    if (e.key === 'Escape') { on.blur(); sayPage(); }
  });
  // Leaving the box without asking for anything puts the real number back, rather than
  // leaving a half-typed one sitting there looking like where you are.
  on.addEventListener('blur', sayPage);
  on.addEventListener('focus', () => on.select());

  finder.onclick = () => {
    bar.hidden = !bar.hidden;
    finder.classList.toggle('on', !bar.hidden);
    if (bar.hidden) { results.hidden = true; results.textContent = ''; } else box.focus();
  };
  let asked = null;
  const look = async () => {
    const needle = box.value.trim();
    clearTimeout(asked);
    if (needle.length < 2) { results.hidden = true; results.textContent = ''; return; }
    results.hidden = false;
    results.textContent = t('looking…');
    try {
      const r = await getJSON(`/api/pdf/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(needle)}`);
      results.textContent = '';
      if (!r.hits.length) {
        results.append(el('p', { className: 'empty tiny', textContent: t('not in these {count} pages', { count: r.pages }) }));
        return;
      }
      for (const hit of r.hits) {
        results.append(el('button', { className: 'pdfhit', type: 'button', onclick: () => goToPage(hit.page) }, [
          el('span', { className: 'pdfpage', textContent: t('p. {n}', { n: hit.page }) }),
          el('span', { className: 'grow', textContent: hit.text }),
        ]));
      }
    } catch (e) {
      results.textContent = '';
      results.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
  };
  box.addEventListener('input', () => { clearTimeout(asked); asked = setTimeout(look, 350); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); look(); }
    if (e.key === 'Escape') finder.onclick();
  });
  void download;
}

export async function mountPreview(host, path, ctl) {
  host.textContent = '';
  const src = withToken(`/api/file?path=${encodeURIComponent(path)}`);
  const download = () => { triggerDownload(withToken(`/api/download?path=${encodeURIComponent(path)}`)); };
  ctl.download?.(download);

  /* The address of this exact version of the document.
   *
   *  Two things hang off naming the version. A file handed to the browser's own viewer
   *  keeps its address as its identity: it is the same page, so the viewer is free to
   *  carry over what it was doing — the zoom, the place on the page — and the open
   *  parameters we send are ones it has already applied and can ignore. When the file is
   *  rebuilt underneath, that is precisely wrong: it is a new document and must open the
   *  way a new document opens.
   *
   *  The version is asked for before the file rather than read off it, and that ordering
   *  is load-bearing: this address is fetched twice — once here to find out what the file
   *  is, and again by the frame that shows it — and the browser only spares the second
   *  transfer while both are the same address. Measured: 760 KiB for a 760 KiB paper,
   *  which is what it was before any of this. Deriving the version from the first reply
   *  would send it down the wire twice.
   */
  let versioned = src;
  try {
    const s = await getJSON(`/api/stat?path=${encodeURIComponent(path)}`);
    versioned = `${src}&v=${Math.floor(s.mtime)}-${s.size}`;
  } catch { /* no stat, no version: the fetch below reports whatever is really wrong */ }

  let r;
  try {
    r = await fetch(versioned);
  } catch {
    host.append(el('p', { className: 'error', textContent: t('could not reach the server') }));
    return;
  }
  if (r.status === 401) return signOut();

  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    host.append(el('div', { className: 'pad' }, [
      el('p', { className: 'error', textContent: msg }),
      el('button', { className: 'ghost', textContent: t('Download'), onclick: download }),
    ]));
    return;
  }

  const type = r.headers.get('content-type') || '';

  if (type.startsWith('image/')) {
    ctl.fill?.(false);
    host.append(el('img', { className: 'preview', src: versioned }));
    return;
  }

  /* A recording, played where it sits.
   *
   *  These used to be refused as "binary — download it instead", which for the one output
   *  a pipeline produces that you cannot read as text was the least useful answer
   *  available. The server streams it and answers a range request, so the scrubber works
   *  rather than the file having to arrive whole before anything can be seen.
   */
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    const moving = type.startsWith('video/');
    ctl.fill?.(moving);
    const player = el(moving ? 'video' : 'audio', {
      className: `preview player${moving ? '' : ' sound'}`,
      src: versioned, controls: true, preload: 'metadata',
    });
    // Or a phone takes the whole screen the moment it starts, which is not what a window
    // next to a running job is for.
    player.playsInline = true;

    /* Keeping your place. A window watching a file reloads when the file changes, and a
     *  recording still being written changes constantly: landing back at zero every time
     *  makes the window useless for the thing it is best at. Unlike the browser's PDF
     *  viewer, a media element says where it is, so this is remembered rather than
     *  guessed at. */
    const was = playedTo.get(path);
    player.addEventListener('loadedmetadata', () => {
      // Not the last half second: coming back to the end is coming back to nothing.
      if (was && was < player.duration - 0.5) player.currentTime = was;
    });
    let noted = 0;
    player.addEventListener('timeupdate', () => {
      if (Math.abs(player.currentTime - noted) < 1) return;
      noted = player.currentTime;
      keepMyPlace(path, noted);
    });
    // Leaving is the moment that matters most, and the moment the throttle would lose.
    for (const stop of ['pause', 'ended', 'emptied']) {
      player.addEventListener(stop, () => keepMyPlace(path, player.currentTime, true));
    }
    window.addEventListener('pagehide', () => keepMyPlace(path, player.currentTime, true), { once: true });

    // A container the browser will not decode — mkv and mov usually — fails silently
    // otherwise: a black rectangle and no way to guess why.
    player.addEventListener('error', () => {
      host.textContent = '';
      host.append(el('div', { className: 'pad' }, [
        el('p', { className: 'error', textContent: t('this browser cannot play {name}', { name: path.split('/').pop() }) }),
        el('button', { className: 'ghost', textContent: t('Download'), onclick: download }),
      ]));
    });
    host.append(player);
    return;
  }

  if (type.startsWith('text/html')) {
    // A converted Word document has no source anyone wants to read — the HTML is ours,
    // not the file's — so it goes straight into the frame with no toggle.
    if (r.headers.get('x-rendered')) {
      ctl.fill?.(true);
      host.append(el('iframe', { className: 'preview', src, sandbox: 'allow-popups allow-forms' }));
      return;
    }
    const source = await r.text();
    ctl.fill?.(true);
    return ctl.source((rendered) => {
      host.textContent = '';
      if (rendered) {
        // The server already answers with a CSP sandbox; the attribute repeats it here so
        // the rule is visible where the frame is created, not only in a header.
        host.append(el('iframe', { className: 'preview', src, sandbox: 'allow-scripts allow-popups allow-forms' }));
      } else {
        host.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: source }));
      }
    });
  }

  // The browser has a better PDF viewer than anything we would write — but no way to
  // search from a phone, and inside an iframe Ctrl+F searches the page around it rather
  // than the document. So the finding is done here and the viewer is sent to the page.
  if (type.startsWith('application/pdf')) {
    ctl.fill?.(true);
    /* A rebuilt document reloads by itself, like every other kind.
     *
     *  It used to offer instead — "this file has changed, [Reload]" — on the reasoning that a
     *  document rebuilt while you are reading page thirty must not throw you to page one. That
     *  reasoning stopped being true when this viewer started remembering the place: the page,
     *  the scroll and the zoom all come back. What was left was a notice standing between you
     *  and a document you had already asked to be shown the new version of, and it read as the
     *  watcher not noticing at all.
     *
     *  A reload that lands mid-write draws a broken document for one tick and then fixes
     *  itself, because a file still being written keeps changing and the next poll reloads it
     *  again. The last reload is the finished one.
     */
    await mountPdf(host, path, versioned, download);
    return;
  }

  if (type.startsWith('model/stl') || type.startsWith('model/step')) {
    ctl.fill?.(true);
    const buf = await r.arrayBuffer();
    await mountMesh(host, buf, ctl, type.startsWith('model/step') ? 'step' : 'stl');
    return;
  }

  ctl.fill?.(false);
  const text = await r.text();

  // Big logs arrive as their last chunk rather than not at all; say so, and start at the
  // end, which is where the interesting part of a log lives.
  const truncated = r.headers.get('x-truncated');
  if (truncated) {
    const total = Number(r.headers.get('x-total-size') || 0);
    host.append(el('div', {
      className: 'notice',
      textContent: t('showing the last {shown} of {total} — download for the whole file', { shown: human(text.length), total: human(total) }),
    }));
  }

  const wanted = viewerFor(path);
  if (wanted === 'diagram') {
    const body = el('div', { className: 'md' });
    host.append(body);
    return ctl.source(async (rendered) => {
      body.textContent = '';
      if (!rendered) {
        body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
        return;
      }
      const box = el('div', {});
      body.append(box);
      try {
        await drawInto(box, text);
      } catch (e) {
        /* The source stays, and the complaint goes under it.
         *
         *  A diagram that will not parse is somebody halfway through writing one, and the
         *  useful thing is the line mermaid objected to — not an empty box, and not the file
         *  hidden behind an error. So it falls back to exactly what the source view shows,
         *  with the reason above it.
         */
        box.replaceChildren(el('p', {
          className: 'error',
          textContent: `${t('this diagram did not draw')} — ${String(e.message || e).split('\n')[0]}`,
        }));
        body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
      }
    });
  }
  if (wanted === 'markdown') {
    const body = el('div', { className: 'md' });
    host.append(body);
    return ctl.source((rendered) => {
      body.className = rendered ? 'md' : '';
      if (rendered) return renderMarkdown(text, body, path);
      body.textContent = '';
      body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
    });
  }

  const pre = el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text });

  /* Numbers down the side, when you want them and they can be trusted.
   *
   *  Not counters on each line: a highlighted file is one run of HTML whose spans cross
   *  lines — a block comment, a long string — and cutting it into per-line elements to hang
   *  a counter on would break exactly those. So the numbers are their own column beside the
   *  text, in the same scroller, stuck to the left so they stay put while the code slides
   *  sideways under them.
   *
   *  And they are off while lines wrap, because then they would be lying: a wrapped line
   *  takes two rows and the column would drift a row further out with every one of them.
   */
  const numbered = prefs.lineNums && !prefs.wrap && wanted !== 'markdown';   // 'diagram' returns above
  if (numbered) {
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const gutter = el('div', { className: 'gutter', 'aria-hidden': 'true' });
    gutter.textContent = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
    host.append(el('div', { className: 'codewrap' }, [gutter, pre]));
  } else {
    host.append(pre);
  }
  if (wanted === 'code') colour(pre, text, path);
  ctl.wrapToggle?.(() => { pre.classList.toggle('wrap'); pre.classList.toggle('nowrap'); });
  if (truncated) ctl.toBottom?.();

  // Editing is offered only when the whole file is here. What arrived as a tail is not
  // the file, and saving it back would throw the head away.
  if (server?.allow_write && !truncated) {
    ctl.edit?.({ text, mtime: Number(r.headers.get('x-mtime') || 0), host, path });
  }
}

/* Colouring code, only when there is code to colour.
 *
 *  A file preview was a `<pre>` of plain text, which is right for a log and wrong for four
 *  hundred lines of TypeScript. highlight.js is vendored — 24K of core and 27 languages of
 *  8K each — and *loaded on the first code file you open*, never before: somebody who reads
 *  logs and markdown all day pays nothing for it, and the first paint of the app is
 *  unchanged.
 *
 *  The colours are ours, not a theme downloaded with it. A borrowed theme brings its own
 *  idea of a background and its own greens, and two palettes in one window is how an
 *  interface starts looking like a collage.
 */
const TONGUES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python', rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  swift: 'swift', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  css: 'css', scss: 'scss', sass: 'scss',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  sql: 'sql', md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
};
// By name, for the files that carry no extension at all.
const NAMED = { dockerfile: 'dockerfile', makefile: 'makefile', 'nginx.conf': 'nginx' };

/* Which viewer a file gets, and who decides.
 *
 *  Argus guesses from the name — markdown is rendered, code is coloured, everything else is
 *  plain — and the guess is right nearly always and wrong in the cases that matter to the
 *  person it is wrong for: a `.log` full of JSON, a `.txt` that is really a config, a `.md`
 *  you want to read as source because it is a template. So the guess is a default and the
 *  answer is a setting, per extension, kept as `{ ext: viewer }`.
 */
export const VIEWERS = ['auto', 'code', 'plain', 'markdown', 'diagram'];

const viewerFor = (path) => {
  const leaf = (path.split('/').pop() || '').toLowerCase();
  const ext = leaf.includes('.') ? leaf.split('.').pop() : leaf;
  const said = (prefs.viewers || {})[ext];
  if (said && said !== 'auto' && VIEWERS.includes(said)) return said;
  if (/\.(md|markdown|mdown)$/i.test(leaf)) return 'markdown';
  /* A diagram written on its own, rather than fenced inside a document.
   *
   *  `.mmd` is what the mermaid command-line reads and writes, and it was arriving here as a
   *  wall of arrows — the one place a reader is worse off than running `cat`, which is the
   *  same sentence that got fences drawn in the first place. The engine is already vendored
   *  and already loaded on demand, so this costs a branch.
   */
  if (/\.(mmd|mermaid)$/i.test(leaf)) return 'diagram';
  return tongueOf(path) ? 'code' : 'plain';
};

const tongueOf = (path) => {
  const leaf = (path.split('/').pop() || '').toLowerCase();
  return NAMED[leaf] || TONGUES[leaf.split('.').pop()] || null;
};

// Loaded once each, kept for the rest of the visit.
const hlCore = { engine: null, tongues: new Set() };

async function colour(pre, text, path) {
  const tongue = tongueOf(path);
  // Above a quarter of a megabyte the highlighter takes longer than the reading does, and a
  // frozen tab is worse than plain text.
  if (!tongue || text.length > 260_000) return;
  try {
    if (!hlCore.engine) {
      const mod = await import('/vendor/highlight-11.12.0/core.min.js');
      hlCore.engine = mod.default || mod;
    }
    if (!hlCore.tongues.has(tongue)) {
      const mod = await import(`/vendor/highlight-11.12.0/languages/${tongue}.min.js`);
      hlCore.engine.registerLanguage(tongue, mod.default || mod);
      hlCore.tongues.add(tongue);
    }
    // The text is already on the page as text; this replaces it with the same text in spans.
    // If the highlighter throws — a language it cannot parse, a file that is not what its
    // name says — the plain version is what stays.
    pre.innerHTML = hlCore.engine.highlight(text, { language: tongue, ignoreIllegals: true }).value;
    pre.classList.add('hl');
  } catch (e) {
    /* Plain text is a perfectly good answer, and silence is not.
     *
     *  Swallowing the reason meant a file that would not colour looked exactly like a file
     *  with nothing to colour — reported from a machine where the vendored copy was in place
     *  and something else was in the way. One line in the console says which: a 404, a MIME
     *  type a browser will not import as a module, a language file that is not there.
     */
    console.warn(`argus: no highlighting for ${tongue} — ${e.message}`);
  }
}

/** Turn a preview into something you can type in.
 *
 *  The mtime read with the file goes back with the save, and the server refuses if it
 *  moved: a job writing the same file while you edit it on a phone is the normal case
 *  here, not a rare one.
 */
export function editor({ text, mtime, host, path }, { onDone, watch } = {}) {
  const area = el('textarea', { className: 'editor', spellcheck: false, value: text });
  const status = el('span', { className: 'editnote' });
  const save = el('button', { className: 'primary inline', textContent: t('Save') });
  const cancel = el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => onDone?.() });
  const bar = el('div', { className: 'editbar' }, [status, cancel, save]);

  host.textContent = '';
  host.append(area, bar);
  area.focus();
  watch?.(false);        // a reload underneath the cursor would eat the edit

  const dirty = () => area.value !== text;
  area.addEventListener('input', () => { status.textContent = dirty() ? 'unsaved' : ''; });

  const store = async () => {
    save.disabled = true;
    status.textContent = t('saving…');
    try {
      const r = await postJSON('/api/fs/write', { path, content: area.value, mtime });
      toast(t('saved {name} · {size}', { name: path.split('/').pop(), size: human(r.size) }));
      onDone?.(r);
    } catch (e) {
      status.textContent = '';
      save.disabled = false;
      toast(e.message, true);
    }
  };
  save.onclick = store;
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); store(); }
    if (e.key === 'Escape') onDone?.();
  });
  return { dirty };
}

/** The caption under a document: where it is, and the two things you want from that.
 *
 *  Used by the full-screen viewer and by a file opened as a window in a desk, which is how most
 *  files are actually opened here — the first version only had it on the screen, and the window
 *  is the one you live in.
 */
/** One row of controls, and the folder as a fact underneath.
 *
 *  Two rows became one because they were the same row: a PDF had its page and zoom buttons on
 *  top and three more buttons about the *file* directly beneath, which reads as two toolbars
 *  disagreeing about which is the toolbar. So the document's own controls and the file's own
 *  controls share a line, and the folder — a long path, and usually one you already know —
 *  moves out of it entirely.
 *
 *  It moves into the same strip a terminal wears under its title bar: a labelled fact, in the
 *  same style, behind the same `i`. A terminal says *where tmux thinks it is*; a document says
 *  *where it is*. Same question, same place, same look.
 */
export const strips = () => prefs.docWhere === true;

/** Park a desk: off the strip, into the rail.
 *
 *  One function, because it is now reached from two places — the tab and its menu — and two
 *  copies of "step off it first, then hide it" is how one of them ends up leaving you standing
 *  on a desk that is not in the strip.
 */
export function putDeskAway(ws, spaces, activate, drawTabs) {
  if (ws.id === prefs.ws) {
    const next = spaces.find((w) => !w.hidden && w.id !== ws.id);
    if (next) activate(next.id);
  }
  ws.hidden = true;
  savePrefs();
  drawTabs();
  paintRailDesks();
  toast(t('{name} is in the rail now', { name: ws.name }));
}

/** Focus one desk: every other one open in the strip goes to the rail at once — the same
 *  place "Put it away" sends one, applied to everything except the desk you are looking
 *  at, and in one motion rather than one press per desk you want gone.
 *
 *  Not built on `putDeskAway` in a loop: that would draw the tabs and toast once per desk
 *  parked, which for six desks is five redraws and five messages saying the same thing.
 *  Here it is one save, one redraw, one toast that counts.
 */
export function focusDesk(ws, spaces, activate, drawTabs) {
  activate(ws.id);
  const parked = spaces.filter((w) => w.id !== ws.id && !w.hidden);
  if (!parked.length) return;
  for (const other of parked) other.hidden = true;
  savePrefs();
  drawTabs();
  paintRailDesks();
  toast(t('{n} desks moved to the rail — {name} on its own now', { n: parked.length, name: ws.name }));
}

export function toggleStrips() {
  prefs.docWhere = !strips();
  savePrefs();
  // Every document at once, the way the terminals' facts work: it is a way of reading, not a
  // property of one window, and half of them showing it would be a puzzle rather than a view.
  for (const one of document.querySelectorAll('.docfacts')) one.hidden = !strips();
  for (const b of document.querySelectorAll('.twist.docwhere')) b.classList.toggle('on', strips());
}

/** The buttons that belong to the *file* rather than to the document: where it is, its link,
 *  its path. Icons only — the words were the path, and the path has moved. */
function whereButtons(path) {
  const here = parentOf(path);
  return [
    el('button', {
      className: 'winbtn', type: 'button', title: `${here} — ${t('A file browser here, in this desk')}`,
      onclick: () => openWindow({ kind: 'browser', id: nextWindowId(), path: here, fresh: true }),
    }, icon('split')),
    copies(() => withToken(`${location.origin}/api/file?path=${encodeURIComponent(path)}`),
           'link', t('Copy a link to this file')),
    copies(() => path, 'clipboard', t('Copy the absolute path')),
  ];
}

/* The folder and when it last changed, as the terminals say things — but *only* as they
 * say them. It wore `winfacts` as well, for the look, and a class here is not a stylesheet:
 * it is who owns the node. The painter that fills a terminal's strip from its `data-cwd`
 * takes every `.winfacts` on the page, found this one, and — a document having no session —
 * wrote `tmux ?` over the folder and the time, every ten seconds, which is the whole of
 * "the info bar sometimes goes to hell". The terminal's own `i` was hiding these too. The
 * look is shared in the stylesheet, where sharing a look belongs. */
function whereFacts(path) {
  const here = parentOf(path);
  const strip = el('div', { className: 'docfacts', hidden: !strips() });
  strip.append(el('button', {
    className: 'fact goes', type: 'button',
    title: `${here} · ${t('press to open a file browser here')}`,
    onclick: () => openWindow({ kind: 'browser', id: nextWindowId(), path: here, fresh: true }),
  }, [
    el('span', { className: 'factname', textContent: t('folder') }),
    el('span', { className: 'factvalue', textContent: here }),
  ]));

  /* When it last changed, to the minute.
   *
   *  The listing says "18:04" for today and "25 Aug" for anything older, which is the right
   *  answer in a column of forty files and the wrong one here: a document you are reading
   *  while something rewrites it is a document whose *time* you want, and "25 Aug" does not
   *  tell you whether the run that was supposed to update it has finished.
   *
   *  Asked for after the fact rather than passed in, because the strip is built from a path
   *  and nothing else — and rebuilt on every reload, so it is re-asked every time the file
   *  changes underneath.
   */
  const changed = el('span', { className: 'fact' }, [
    el('span', { className: 'factname', textContent: t('changed') }),
    el('span', { className: 'factvalue', textContent: '…' }),
  ]);
  strip.append(changed);
  getJSON(`/api/stat?path=${encodeURIComponent(path)}`).then((s) => {
    const at = new Date(s.mtime * 1000);
    changed.querySelector('.factvalue').textContent = at.toLocaleString([], {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    // The size beside it in the tooltip: it is the other half of "has it finished writing",
    // and a second chip for it would push the folder off a narrow strip.
    changed.title = `${human(s.size)} · ${when(s.mtime)}`;
  }).catch(() => changed.remove());
  return strip;
}

/** Put both where they belong: the buttons on the document's own row when it has one, on a row
 *  of their own when it does not; the facts always underneath. */
/** Take the whole thing: select it, or copy it.
 *
 *  Missing, and the two halves of the same want — a file opened to be read is usually a file
 *  something else is about to receive. Selecting is for when you want part of it after all and
 *  the drag across three screens is the annoying bit; copying is for when you want all of it
 *  and never wanted the drag.
 *
 *  Only where there is text to take. A PDF is pages of drawn glyphs and there is nothing here
 *  to select; its own row already has a search that does what you would want instead.
 */
function wholeButtons(into) {
  const body = into.querySelector('pre.file, .md');
  if (!body) return [];
  const all = el('button', {
    className: 'winbtn', type: 'button', title: t('Select the whole document'),
    onclick: () => {
      const range = document.createRange();
      range.selectNodeContents(body);
      const picked = getSelection();
      picked.removeAllRanges();
      picked.addRange(range);
    },
  }, icon('selectall'));
  const grab = el('button', {
    className: 'winbtn', type: 'button', title: t('Copy the whole document'),
    onclick: async () => {
      const text = body.innerText;
      if (await copyText(text)) {
        ticked(grab, 'copy');
        toast(t('copied {count} characters', { count: text.length }));
      } else showText(t('Copy this'), text);
    },
  }, icon('copy'));
  return [all, grab];
}

export function putStrip(into, path) {
  /* The facts go directly under the title bar, exactly where a terminal keeps its own — that
   *  is the whole point of using the same strip and the same `i`, and putting them under the
   *  page controls instead made them a third bar rather than the same one.
   *
   *  The buttons go on the document's own row when it has one, because two toolbars in a
   *  column read as two toolbars disagreeing about which is the toolbar.
   *
   *  Idempotent, not merely additive: this runs again on every reload, and a race between
   *  two overlapping loads — a watcher's own reload landing beside a manual one, two
   *  reload triggers close together — must replace what is already here rather than stack
   *  a second copy beside it. Reported as two bars, sometimes, in the PDF viewer: exactly
   *  what stacking looks like. `docwherebtns` is `display: contents` — a marker to find
   *  and remove, invisible to the flex row it sits in.
   */
  into.querySelector(':scope > .docfacts')?.remove();
  into.querySelector(':scope > .prevwhere')?.remove();
  into.querySelector('.pdfbar > .docwherebtns')?.remove();
  const own = into.querySelector('.pdfbar');
  if (own) own.append(el('span', { className: 'docwherebtns' }, whereButtons(path)));
  else into.prepend(el('div', { className: 'prevwhere' }, [...wholeButtons(into), ...whereButtons(path)]));
  into.prepend(whereFacts(path));
}

export async function screenPreview(path) {
  setCurrent(path);
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);

  // Same file, in a window on the wall, next to whatever is running.
  bar.alt.hidden = false;
  bar.alt.title = t('Open in a window');
  bar.alt.replaceChildren(icon('split'));
  bar.alt.onclick = () => chooseDesk({ kind: 'file', path }, path.split('/').pop());

  /* Where this file is, under the title, with the two things you want from it there.
   *
   *  The header says the file's name and nothing else, which is right until the moment you want
   *  the folder — to see what is beside it, or to paste the path into a terminal. Both were two
   *  or three moves away: back out to Files, or read the address off the URL bar and retype it.
   *  A strip with the absolute path, a button that opens a browser there, and a button that
   *  copies it.
   */
  /* The same `i` the terminals wear, in the header where the other document buttons are.
   *
   *  Asked for in those words: the folder is usually a thing you already know, so it should be
   *  something you open rather than something you scroll past. It is one answer for every
   *  document, like the facts under a terminal, rather than a state per file.
   */
  bar.where.hidden = false;
  bar.where.replaceChildren(icon('info'));
  bar.where.title = t('Where this file is');
  bar.where.className = `icon twist docwhere${strips() ? ' on' : ''}`;
  bar.where.onclick = toggleStrips;



  await mountPreview(view, path, {
    download: (fn) => {
      bar.action.hidden = false;
      bar.action.replaceChildren(icon('download'));
      bar.action.onclick = fn;
    },
    fill: (on) => { view.style.overflow = on ? 'hidden' : ''; },
    source: headerSourceToggle,
    wrapToggle: (fn) => { bar.title.onclick = fn; },
    toBottom: () => { view.scrollTop = view.scrollHeight; },
    edit: (ctx) => {
      bar.action.hidden = false;
      bar.action.title = t('Edit this file');
      bar.action.replaceChildren(icon('rename'));
      bar.action.onclick = () => {
        view.style.overflow = 'hidden';
        editor(ctx, { onDone: () => screenPreview(path) });
      };
    },
  });

  // After the mount, because mounting empties the view. First child, so it reads as a caption
  // rather than as something that arrived with the file.
  putStrip(view, path);
}

/** A visible switch between a rendered document and its source. Tapping the title does
 *  the same, but nobody discovers that on their own. */
function headerSourceToggle(paint) {
  let rendered = true;
  const apply = () => {
    bar.alt.hidden = false;
    bar.alt.title = rendered ? 'View the source' : 'View it rendered';
    bar.alt.replaceChildren(icon(rendered ? 'code' : 'eye'));
    bar.alt.className = `icon${rendered ? '' : ' on'}`;
    paint(rendered);
  };
  const flip = () => { rendered = !rendered; apply(); };
  bar.alt.onclick = flip;
  bar.title.onclick = flip;
  return apply();
}

/** Markdown, loaded only when a .md is actually opened.
 *
 *  The source is HTML-escaped *before* parsing, so raw tags in a document someone else
 *  wrote render as text instead of executing in a page that holds the access token.
 *  Anything that survives as a link or an image is then checked again.
 */
async function renderMarkdown(text, container, from = '') {
  container.textContent = t('rendering…');
  let marked;
  try {
    ({ marked } = await import('/vendor/marked-18.0.7/marked.esm.js'));
  } catch {
    container.textContent = '';
    container.append(el('pre', { className: 'file wrap', textContent: text }));
    return;
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  container.innerHTML = marked.parse(escaped, { gfm: true });

  /* Undo the second escape, inside code only.
   *
   *  The document is escaped once here, before marked sees it, so raw HTML in a file somebody
   *  else wrote renders as text instead of executing in a page that holds the access token.
   *  That part is right. What it did not account for is that marked escapes code *again*, and
   *  unconditionally: `A -> B` in a fence arrived as `-&amp;gt;` in the HTML and was drawn on
   *  screen, literally, as `-&gt;`. Every fence with a `<`, a `>` or an `&` in it — which is
   *  most fences that matter — was being shown wrong. Reported from a document full of
   *  arrows.
   *
   *  One layer comes back off, and only within `code`, where it is unambiguous: the text of a
   *  code element is text. Writing it back through `textContent` cannot execute anything,
   *  which is what makes this safe to do rather than a hole reopened.
   */
  for (const box of container.querySelectorAll('code')) {
    const plain = undoEntities(box.textContent || '');
    if (plain !== box.textContent) box.textContent = plain;
  }

  drawDiagrams(container);

  for (const a of container.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href'))) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.removeAttribute('href');   // javascript:, data:, and relative links that cannot resolve
    }
  }
  // A report's plots sit next to it on disk — `![](results/plot.png)` — and dropping
  // every non-http image, as this used to, threw away the figures that were the point of
  // reading the document. They are resolved against the document's own folder and served
  // the way any other file is, which means the jail still decides what can be read.
  const folder = from ? parentOf(from) : '';
  for (const img of container.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^https?:/i.test(src)) continue;
    if (/^data:image\//i.test(src)) continue;      // embedded, and already harmless
    const local = src && !src.includes('://')
      ? (src.startsWith('/') ? src : folder && `${folder}/${src}`)
      : '';
    if (!local) { img.remove(); continue; }
    img.src = withToken(`/api/file?path=${encodeURIComponent(local.replace(/\/+/g, '/'))}`);
    img.loading = 'lazy';
    // A figure that cannot be read should say so rather than leave a broken glyph.
    img.onerror = () => {
      img.replaceWith(el('span', { className: 'meta', textContent: t('missing figure: {src}', { src }) }));
    };
  }
}

/** ```mermaid fences, drawn.
 *
 *  A fenced block whose language is `mermaid` is a diagram everywhere it is written —
 *  GitHub, GitLab, the editor the document was written in — and here it was three lines of
 *  arrows in a grey box, which is the one place the reader is worse off than reading the
 *  file with `cat`.
 *
 *  Loaded only when a document actually has one: it is by far the largest thing vendored
 *  here, and the overwhelming majority of documents opened are not diagrams.
 */
const mmd = { engine: null, drawn: 0 };

/** The document was escaped once before marked ever saw it, so the text in the DOM is the
 *  source with one layer of entities still on it — and `-->`, the commonest thing in a
 *  mermaid diagram, arrives as `--&gt;` and parses as nothing. A textarea decodes exactly
 *  one layer, and never as markup: its content is raw text to the parser. */
function undoEntities(s) {
  const box = document.createElement('textarea');
  box.innerHTML = s;
  return box.value;
}

/** The engine, ready and dressed.
 *
 *  Shared, because a run window and a document both want it and the theme has to be re-read
 *  each time: the colours are baked into the svg at draw time, so a diagram drawn at night is
 *  a black box on a white page.
 *
 *  **Which palette, and why this is a choice rather than a decision.** The first version built
 *  one out of the app's own variables, so that a diagram was the same greys and the same green
 *  as the page holding it. That is right for a small picture inside a document and wrong for a
 *  diagram you are working *on*: those variables are three shades of dark, so every node came
 *  out the same box with the same border, and beside mermaid's own themes it looks broken
 *  rather than restrained. Reported exactly that way, and the report is correct.
 *
 *  So mermaid's own theme is the default — `dark` or `default`, following the app, which is
 *  what any other mermaid tool would give you — and the flat one is kept as `match the app`
 *  for anybody who liked it. Either way a diagram's own `classDef` and `style` lines win: the
 *  theme decides what an unstyled node looks like, never what a styled one does.
 */
async function readyDiagrams() {
  if (!mmd.engine) ({ default: mmd.engine } = await import('/vendor/mermaid-11.16.1/mermaid.esm.min.mjs'));
  const paint = getComputedStyle(document.documentElement);
  const hue = (name) => paint.getPropertyValue(name).trim();
  /* Which of mermaid's themes, or none of them.
   *
   *  `auto` follows the app, which is what any other mermaid tool does. It is also the reason
   *  the first complaint did not go away when the flat palette did: mermaid's *dark* theme is
   *  greys, and the colourful one everybody has seen on mermaid.live is `default`, which is a
   *  light theme. So it is offered by name and can be chosen against a dark app, because
   *  wanting a colourful diagram on a dark page is not a contradiction.
   */
  const light = document.documentElement.dataset.theme === 'light';
  const asked = prefs.diagramTheme || 'auto';
  const flat = asked === 'app';
  const named = { colourful: 'default', forest: 'forest', neutral: 'neutral' }[asked]
    || (light ? 'default' : 'dark');
  mmd.engine.initialize({
    startOnLoad: false,
    securityLevel: 'strict',        // labels go through the sanitiser; no scripts, no click handlers
    suppressErrorRendering: true,   // a bad diagram must not put mermaid's own red box on the page
    fontFamily: paint.fontFamily,
    theme: flat ? 'base' : named,
    // Only when flattening. Handing `themeVariables` to mermaid's own themes overrides the
    // very palette that was asked for, one key at a time, which is how you end up with a
    // theme that is neither.
    ...(flat ? {
      themeVariables: {
        background: hue('--panel'),
        primaryColor: hue('--line'),
        primaryTextColor: hue('--bright'),
        primaryBorderColor: hue('--accent'),
        secondaryColor: hue('--panel'),
        tertiaryColor: hue('--bg'),
        mainBkg: hue('--line'),
        nodeBorder: hue('--accent'),
        lineColor: hue('--dim'),
        textColor: hue('--text'),
        errorBkgColor: hue('--panel'),
        errorTextColor: hue('--danger'),
      },
    } : {}),
  });
  return mmd.engine;
}

/** One diagram into one box, remembering its source so a theme switch can redraw it. */
export async function drawInto(box, source) {
  const engine = await readyDiagrams();
  box.innerHTML = (await engine.render(`mmd-${++mmd.drawn}`, source)).svg;
  box.source = source;
  box.classList.add('diagram');
}

async function drawDiagrams(container) {
  /* `[class*=]`, not the exact class: an info string is not always the bare word — ```mermaid
   *  with anything after it becomes `language-mermaid-something`, and a fence written that
   *  way is still a diagram. */
  const blocks = [...container.querySelectorAll('pre > code[class*="language-mermaid"]')];
  // Colours are baked into the svg at draw time, so a theme switch has to redraw whatever is
  // already on the page — a diagram drawn at night is a black box on a white document.
  const again = [...container.querySelectorAll('.diagram')].filter((d) => d.source);
  if (!blocks.length && !again.length) return;
  try {
    await readyDiagrams();
  } catch (e) {
    /* Say it on the page, not only in the console.
     *
     *  A library that will not load looks exactly like a feature that is not there — which
     *  is the whole difficulty of "the diagrams are not drawn": nothing distinguishes a copy
     *  of Argus too old to have this from one where the file is missing or is being served
     *  with a MIME type a browser will not import. One line, under the block, does. */
    console.warn(`argus: no diagrams — ${e.message}`);
    for (const code of blocks) {
      code.parentElement.after(el('p', { className: 'meta', textContent: t('the diagram library did not load') }));
    }
    return;
  }
  for (const code of blocks) {
    // Already decoded by renderMarkdown, which is the only thing that puts a fence here.
    const source = code.textContent || '';
    try {
      const box = el('div', { className: 'diagram' });
      box.innerHTML = (await mmd.engine.render(`mmd-${++mmd.drawn}`, source)).svg;
      box.source = source;          // kept for the redraw a theme switch asks for
      code.parentElement.replaceWith(box);
    } catch (e) {
      /* The source stays exactly where it was — a diagram that will not parse is still the
       *  text somebody wrote, and hiding it would lose the thing they are trying to fix. */
      code.parentElement.after(el('p', {
        className: 'meta',
        textContent: `${t('this diagram did not draw')} — ${String(e.message || e).split('\n')[0]}`,
      }));
    }
  }
  for (const box of again) {
    try {
      box.innerHTML = (await mmd.engine.render(`mmd-${++mmd.drawn}`, box.source)).svg;
    } catch { /* it drew once; the one on screen is better than an empty box */ }
  }
}

/** Redraw what is on screen after the palette changed under it. */
export function repaintDiagrams() {           // a declaration: applyTheme runs long before this line
  // Every box that has drawn something, wherever it lives: a run window is a diagram outside
  // any document, and the first version of this only knew how to find the ones in `.md`.
  for (const box of document.querySelectorAll('.diagram')) {
    if (box.source) drawInto(box, box.source).catch(() => {});
  }
  // A run's colours are written into its source, so redrawing the stored source would keep
  // last night's palette. These build theirs again.
  for (const draw of watchers) draw();
}
