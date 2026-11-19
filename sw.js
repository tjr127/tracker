// Caches only the app's own files so it opens fast. Sheet data is never cached.
const CACHE = 'tracker-v7';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ocr.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return; // sheet calls go straight to the network
  // 'no-cache' makes the phone check GitHub for a newer copy instead of reusing its 10-minute browser cache.
  e.respondWith(fetch(url.href, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
