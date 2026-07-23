// ROAN AI — Service Worker
// Rôle : rendre l'app installable sur Android (PWA) et mettre en cache
// la coquille statique (HTML/icônes) pour un chargement plus rapide.
// Les appels API (/api/...) ne sont JAMAIS mis en cache : ils doivent
// toujours passer par le réseau pour rester à jour et authentifiés.

const CACHE_NAME = 'roan-ai-shell-v1';

const SHELL_ASSETS = [
  '/login.html',
  '/signup.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Jamais de cache pour l'API (auth, chat, upload) : toujours réseau frais.
  if (url.pathname.startsWith('/api/')) return;

  // Pour la page protégée '/' et '/index.html' : réseau d'abord (car elle
  // dépend de l'auth serveur), avec fallback cache si hors-ligne.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/login.html'))
    );
    return;
  }

  // Pour le reste (assets statiques) : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
