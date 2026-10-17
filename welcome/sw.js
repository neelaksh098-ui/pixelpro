/* Pixel Pro launch site: service worker
   Keeps the site on the visitor's device after the first visit, so repeat
   visits open instantly.

   - The page and its stylesheet: network first (so a new upload shows up at
     once), falling back to the saved copy when offline or slow (2.5 s).
   - The photo and the Google Fonts files: saved copy first, refreshed in the
     background.
   - Nothing else is touched (the Pixel Pro app, POSTs, other sites).

   The cache name changed with the redesign (v1 held the old film's scripts,
   music and photos); activating this version deletes it. */
const CACHE = 'pixelpro-site-v2';
const CORE = ['./', 'index.html', 'css/site.css', 'media/rocket.jpg'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('pixelpro-site-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), timeout(2500)]);
    if (res && res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') { const home = await c.match('index.html'); if (home) return home; }
    throw err;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const refresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (same && (req.mode === 'navigate' || /\.(html|js|css)$/.test(url.pathname) || url.pathname.endsWith('/'))) { e.respondWith(networkFirst(req)); return; }
  if (same && /\.(jpe?g|png|webp|svg)$/.test(url.pathname)) { e.respondWith(cacheFirst(req)); return; }
  if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') { e.respondWith(cacheFirst(req)); return; }
});
