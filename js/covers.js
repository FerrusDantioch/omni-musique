/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import { CATEGORY_ICONS, escapeHtml, icon } from "./utils.js";
import { ascii } from "./parsers.js";
import { getOne, knownCovers, putOne, tracks, transaction } from "./db.js";

const MAX_COVER_URLS = 150;
const coverUrls = new Map();
const coverPromises = new Map();
const storePromises = new Map();

function sniffImageType(bytes, declared) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 3) === "GIF") return "image/gif";
  return /^image\//.test(declared) ? declared : "image/jpeg";
}

async function coverIdOf(bytes) {
  if (globalThis.crypto?.subtle) {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash.subarray(0, 16), x => x.toString(16).padStart(2, "0")).join("");
  }
  let sum = bytes.length;
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 4096))) sum = (sum * 31 + bytes[i]) >>> 0;
  return "p" + bytes.length.toString(36) + sum.toString(36);
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image illisible")); };
    image.src = url;
  });
}

function squareThumbnail(image, size) {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const target = Math.min(size, side);
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side,
    0, 0, target, target
  );
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
}

export async function storeCover(picture) {
  const bytes = picture.data;
  const id = await coverIdOf(bytes);
  if (knownCovers.has(id)) return id;
  if (storePromises.has(id)) return storePromises.get(id);

  const promise = (async () => {
    const { image, url } = await loadImage(new Blob([bytes], { type: sniffImageType(bytes, picture.mime) }));
    try {
      const large = await squareThumbnail(image, 512);
      const small = await squareThumbnail(image, 160);
      if (!large || !small) return null;
      await putOne("covers", { id, large, small });
      knownCovers.add(id);
      return id;
    } finally {
      URL.revokeObjectURL(url);
      storePromises.delete(id);
    }
  })();

  storePromises.set(id, promise);
  return promise;
}

/* Déduplication des appels concurrents + cache LRU borné avec révocation blob:. */
export function coverUrl(id, size = "small") {
  if (!id) return Promise.resolve(null);
  const key = id + ":" + size;

  if (coverUrls.has(key)) {
    const url = coverUrls.get(key);
    coverUrls.delete(key);
    coverUrls.set(key, url);
    return Promise.resolve(url);
  }

  if (coverPromises.has(key)) {
    return coverPromises.get(key);
  }

  const promise = (async () => {
    try {
      const record = await getOne("covers", id).catch(() => null);
      if (!record?.[size]) return null;
      if (coverUrls.has(key)) return coverUrls.get(key);

      const url = URL.createObjectURL(record[size]);
      coverUrls.set(key, url);
      while (coverUrls.size > MAX_COVER_URLS) {
        const oldestKey = coverUrls.keys().next().value;
        const oldestUrl = coverUrls.get(oldestKey);
        coverUrls.delete(oldestKey);
        URL.revokeObjectURL(oldestUrl);
      }
      return url;
    } finally {
      coverPromises.delete(key);
    }
  })();

  coverPromises.set(key, promise);
  return promise;
}

export function revokeAllCovers() {
  for (const url of coverUrls.values()) URL.revokeObjectURL(url);
  coverUrls.clear();
  coverPromises.clear();
}

export function coverHtml(coverId, category, size = "small", extraClass = "") {
  return `<span class="cover ${extraClass}" data-category="${category}">${icon(CATEGORY_ICONS[category] || "music")}` +
    (coverId ? `<img alt="" data-cover="${escapeHtml(coverId)}" data-size="${size}">` : "") + `</span>`;
}

const coverObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      fillCover(entry.target);
    }
  }, { rootMargin: "300px" })
  : null;

async function fillCover(image) {
  const url = await coverUrl(image.dataset.cover, image.dataset.size);
  if (url) image.src = url;
}

export function loadCovers(root) {
  root.querySelectorAll("img[data-cover]:not([src])").forEach(image => {
    if (coverObserver) coverObserver.observe(image);
    else fillCover(image);
  });
}

export async function removeUnusedCovers() {
  const used = new Set([...tracks.values()].map(track => track.coverId).filter(Boolean));
  const unused = [...knownCovers].filter(id => !used.has(id));
  if (!unused.length) return;
  await transaction("covers", "readwrite", tx => {
    for (const id of unused) tx.objectStore("covers").delete(id);
  }).catch(() => {});
  for (const id of unused) {
    knownCovers.delete(id);
    for (const size of ["small", "large"]) {
      const key = id + ":" + size;
      const url = coverUrls.get(key);
      if (url) { URL.revokeObjectURL(url); coverUrls.delete(key); }
    }
  }
}

export function coverCacheStats() {
  return { size: coverUrls.size, inFlight: coverPromises.size };
}
