// Offline shell for the installed app. Network-first so a deploy is picked up on the next
// visit, with the cache as fallback when the network is gone. /api is never cached: auth and
// chat must always reach the server, and a replayed SSE stream would be worse than an error.
const VERSION = 'nexyl-shell-v1';
const SHELL = [
  '/', '/styles.css', '/app.js', '/sw.js',
  '/icons/site.webmanifest', '/icons/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return event.request.mode === 'navigate' ? caches.match('/') : Response.error();
      })),
  );
});
