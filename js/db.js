/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import { THEME_COLORS, readJson, writeJson } from "./utils.js";

export const SETTINGS_KEY = "omni-musique-reglages";
export const SESSION_KEY = "omni-musique-session";

export const $ = id => document.getElementById(id);

export const settings = Object.assign({
  theme: "nuit",
  speed: 1,
  volume: 1,
  tab: "music",
  musicView: "tracks",
  sorts: {}
}, readJson(SETTINGS_KEY) || {});

export function saveSettings() {
  writeJson(SETTINGS_KEY, settings);
}

export function applyTheme(theme) {
  if (!THEME_COLORS[theme]) theme = "nuit";
  settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = $("metaThemeColor");
  if (meta) meta.content = THEME_COLORS[theme];
  document.querySelectorAll("[data-theme-choice]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  });
}

let toastTimer = null;
export function showToast(message, duration = 4000, isError = false) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

/* ============================================================
   BASE DE DONNÉES (IndexedDB) & ÉTAT EN MÉMOIRE
   ============================================================ */
let db = null;

export const tracks = new Map();      // id → piste
export const state = {
  playlists: [],                      // listes de lecture
  bookmarks: []                       // signets
};
export const knownCovers = new Set(); // identifiants des pochettes enregistrées

export const isSpoken = track => Boolean(track) && (track.category === "podcast" || track.category === "book");

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("omni-musique", 1);

    request.onupgradeneeded = () => {
      const base = request.result;
      base.createObjectStore("tracks", { keyPath: "id" });
      base.createObjectStore("files", { keyPath: "id" });
      base.createObjectStore("covers", { keyPath: "id" });
      base.createObjectStore("playlists", { keyPath: "id" });
      base.createObjectStore("bookmarks", { keyPath: "id" });
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Base bloquée par un autre onglet"));
  });
}

export function transaction(stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction annulée"));
    const request = work(tx);
    if (request instanceof IDBRequest) request.onsuccess = () => { result = request.result; };
  });
}

export const getAll = store => transaction(store, "readonly", tx => tx.objectStore(store).getAll());
export const getAllKeys = store => transaction(store, "readonly", tx => tx.objectStore(store).getAllKeys());
export const getOne = (store, id) => transaction(store, "readonly", tx => tx.objectStore(store).get(id));
export const putOne = (store, value) => transaction(store, "readwrite", tx => { tx.objectStore(store).put(value); });
export const deleteOne = (store, id) => transaction(store, "readwrite", tx => { tx.objectStore(store).delete(id); });

export function clearAllStores() {
  return transaction(["tracks", "files", "covers", "playlists", "bookmarks"], "readwrite", tx => {
    for (const store of ["tracks", "files", "covers", "playlists", "bookmarks"]) tx.objectStore(store).clear();
  });
}

export function saveTrack(track) {
  return putOne("tracks", track).catch(error => console.warn("Piste non enregistrée :", error));
}

export function isQuotaError(error) {
  return error && (error.name === "QuotaExceededError" || /quota/i.test(error.message || ""));
}

export async function storeTrack(track, file) {
  const write = blob => transaction(["files", "tracks"], "readwrite", tx => {
    tx.objectStore("files").put({ id: track.id, blob });
    tx.objectStore("tracks").put(track);
  });

  try {
    await write(file.slice(0, file.size, track.type));
  } catch (error) {
    if (isQuotaError(error) || file.size > 300 * 1024 * 1024) throw error;
    await write(new Blob([await file.arrayBuffer()], { type: track.type }));
  }
}
