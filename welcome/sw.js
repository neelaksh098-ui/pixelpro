/* Pixel Pro launch site: service worker
   Keeps the site on the visitor's device after the first visit, so repeat
   visits open instantly and the scroll story never waits on the network.

   - Pages, scripts and styles: network first (so a new upload shows up at
     once), falling back to the saved copy when offline or slow (2.5 s).
   - Photos, the narration pack, Three.js and Google Fonts files: saved copy
     first, refreshed in the background.
   - Nothing else is touched (ElevenLabs calls, the Pixel Pro app, POSTs).

   After changing the photos or the narration pack you do not need to do
   anything: the saved copies refresh themselves on the next visit. */
const CACHE = 'pixelpro-site-v1';
const CORE = ['./', 'index.html', 'css/device.css', 'js/music.js', 'js/device.js', 'js/hero3d.js',
  'media/rocket.jpg', 'media/espresso.jpg', 'media/cat.jpg', 'media/deep-field.jpg'];
const THREE = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => c.add(u).catch(() => {})));
    try { await c.add(new Request(THREE, { mode: 'cors' })); } catch (err) {}
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
  if (same && url.pathname.endsWith('/audio/manifest.json')) { e.respondWith(networkFirst(req)); return; }
  if (same && (req.mode === 'navigate' || /\.(html|js|css)$/.test(url.pathname) || url.pathname.endsWith('/'))) { e.respondWith(networkFirst(req)); return; }
  if (same && /\.(jpe?g|png|webp|svg|mp3|wav|m4a|ogg|mp4|webm)$/.test(url.pathname)) { e.respondWith(cacheFirst(req)); return; }
  if (req.url === THREE || url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') { e.respondWith(cacheFirst(req)); return; }
});
