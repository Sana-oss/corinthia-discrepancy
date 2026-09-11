// Service worker for the Room Discrepancy Report PWA.
// Strategy:
//   - Same-origin files (HTML, config.js, manifest, icons): network-first with
//     cache fallback, so deploys and .env changes are picked up when online
//     and the shell still opens offline.
//   - Cross-origin assets (supabase-js, pdf.js): cache-first,
//     since they are pinned versions / effectively immutable.
//   - Corinthia brand fonts are local files listed in SHELL_FILES below.
//   - Supabase API traffic is passed through untouched (never cached): those
//     responses carry auth tokens and per-user data. The app handles its own
//     offline caching + write outbox in IndexedDB (see discrepancy-report.html).
const VERSION = 'v3';
const SHELL_CACHE = 'shell-' + VERSION;
const ASSET_CACHE = 'assets-' + VERSION;

const SHELL_FILES = [
  './',
  './discrepancy-report.html',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './new-logo.svg',
  './Font/IvyOraDisplay-Regular.otf',
  './Font/GT-America-LC-Extended-Regular.otf',
  './Font/GT-America-LC-Extended-Medium.otf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // writes pass straight through
  const url = new URL(req.url);
  if (url.hostname === 'supabase.co' || url.hostname.endsWith('.supabase.co')) return;
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

// Network-first: fresh copy when online, cached shell when offline.
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

// Cache-first: for pinned CDN libraries and fonts.
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
    const cache = await caches.open(ASSET_CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

// Background sync (Android/Chrome): wake any open client so the in-page outbox
// flush can run. The outbox itself lives in IndexedDB and is replayed by the
// page, which owns the session/auth state.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-discrepancy') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'FLUSH_OUTBOX' }));
      })
    );
  }
});
