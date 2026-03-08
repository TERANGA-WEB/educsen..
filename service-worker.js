// service-worker.js

const CACHE_NAME = 'mon site-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
    '/userdashboard.html',
  '/images/icon-192.png', 
  '/images/icon-512.png'
];

// Installation : on ouvre un cache et on ajoute les fichiers
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache ouvert');
        return cache.addAll(urlsToCache);
      })
  );
});

// Interception des requêtes : on répond avec le cache si disponible
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Si la ressource est dans le cache, on la retourne
        if (response) {
          return response;
        }
        // Sinon on va la chercher sur le réseau
        return fetch(event.request);
      })
  );
});

// Nettoyage des anciens caches (optionnel mais recommandé)
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            // Supprimer les anciens caches
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});