"use strict";

/*
 * Service worker d'Omni-Musique : rend l'application utilisable hors ligne.
 *
 * - La page (index.html, qui contient tout le code) est servie depuis la
 *   copie en cache de CETTE version : elle n'est demandée au réseau que si
 *   la copie manque (toute première visite).
 * - À chaque nouvelle version, changez le numéro de CACHE_NAME (et
 *   APP_VERSION dans index.html) : l'application affiche alors « Nouvelle
 *   version disponible » et la mise à jour se fait d'un appui, sans couper
 *   l'écoute en cours. Rien ne change avant cet appui.
 * - La police des titres et les icônes sont servies depuis le cache.
 * - Les fichiers audio ne passent jamais par ici : ils sont dans IndexedDB
 *   et lus directement depuis l'appareil.
 */

const CACHE_NAME = "omni-musique-v1.0.1";
const CACHE_PREFIX = "omni-musique-";

const APP_SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./polices/oxanium.woff2"
];

const NAVIGATION_TIMEOUT = 4000;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(
      APP_SHELL.map(url => new Request(url, { cache: "reload" }))
    );
  })());
});

/* Appui sur « Mettre à jour » : la nouvelle version remplace l'ancienne. */
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate" && sameOrigin) {
    event.respondWith(cachedPage(request));
    return;
  }

  if (sameOrigin) {
    event.respondWith(cacheFirst(request));
  }
});

async function cachedPage(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match("./") || await cache.match(request, { ignoreSearch: true });

  if (cached) return cached;

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Réseau trop lent")), NAVIGATION_TIMEOUT);
      })
    ]);

    if (response.ok) {
      await cache.put("./", response.clone());
    }

    return response;
  } catch (error) {
    return new Response(
      "Omni-Musique n’a pas encore été enregistrée pour le mode hors ligne. " +
      "Ouvrez-la une fois avec une connexion.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached) return cached;

  const response = await fetch(request);

  if (response.ok) {
    await cache.put(request, response.clone());
  }

  return response;
}
