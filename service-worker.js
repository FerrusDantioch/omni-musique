"use strict";

/*
 * Service worker d'Omni-Musique : rend l'application utilisable hors ligne.
 */

const CACHE_NAME = "omni-musique-v1.1.0";
const CACHE_PREFIX = "omni-musique-";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./polices/oxanium.woff2",
  "./polices/literata.woff2",
  "./js/theme-init.js",
  "./js/utils.js",
  "./js/parsers.js",
  "./js/db.js",
  "./js/covers.js",
  "./js/layers.js",
  "./js/player.js",
  "./js/ui.js",
  "./js/app.js"
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

  try {
    const response = await fetch(request);

    if (response.ok) {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    return new Response(
      "Ressource indisponible hors ligne.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}
