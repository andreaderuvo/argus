// App shell only. The API and the terminal must never be served from a cache — stale
// file listings are confusing, and a cached WebSocket is meaningless.
const CACHE = 'argus-v174';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/xterm-6.0.0/xterm.mjs',
  '/vendor/xterm-6.0.0/addon-fit.mjs',
  '/vendor/xterm-6.0.0/addon-webgl.mjs',
  '/vendor/xterm-6.0.0/xterm.css',
];

// Deliberately no skipWaiting() here: a new worker stays in `waiting` until the page
// asks for it, which is what lets the app say "there is an update" instead of swapping
// itself out from under an open terminal.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (e.request.method !== 'GET') return;

  // Network first, so a rebuilt frontend reaches an installed PWA; the cache is the
  // fallback for a phone that has wandered off the network.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  );
});
