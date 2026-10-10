/* Cache everything on install so the thing still runs with no signal —
   on a train, underground, anywhere. Bump CACHE on every release. */
const CACHE = 'flip-acid-v0.1.0';

const SHELL = [
  './',
  './index.html',
  './acid.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        /* refresh in the background, but never block playing on the network */
        fetch(e.request)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res));
          })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request);
    })
  );
});
