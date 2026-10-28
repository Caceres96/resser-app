// Service worker : permet d'ouvrir l'application hors connexion.
// Fichiers de l'app : réseau d'abord (pour toujours voir la dernière version), cache en secours.
// Open Food Facts : toujours le réseau (les données sont enregistrées dans chaque référence).
const CACHE = 'resser-pruebaA-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'reglas.js', 'manifest.webmanifest', 'icon.svg'];
const LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, LIB])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
  } else if (url.href === LIB) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
