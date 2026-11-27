/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

export const APP_VERSION = "1.1.0";

export const CATEGORY_NAMES = { music: "Musique", podcast: "Podcasts", book: "Livres audio" };
export const CATEGORY_ICONS = { music: "music", podcast: "podcast", book: "book", playlist: "playlist" };
export const SPEEDS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const SKIP_BACK = 15;
export const SKIP_FORWARD = 30;
export const THEME_COLORS = { clair: "#f7f5fb", sombre: "#1a1a1a", nuit: "#14111d" };

export const FORMATS = {
  mp3: { type: "audio/mpeg", tests: ["audio/mpeg", "audio/mp3"] },
  m4a: { type: "audio/mp4", tests: ["audio/mp4", "audio/x-m4a", "audio/aac"] },
  m4b: { type: "audio/mp4", tests: ["audio/mp4", "audio/x-m4b", "audio/x-m4a"] },
  mp4: { type: "audio/mp4", tests: ["audio/mp4", "video/mp4"] },
  aac: { type: "audio/aac", tests: ["audio/aac", "audio/x-aac", "audio/mp4"] },
  ogg: { type: "audio/ogg", tests: ["audio/ogg", "audio/ogg; codecs=vorbis", "audio/ogg; codecs=opus"] },
  oga: { type: "audio/ogg", tests: ["audio/ogg", "audio/ogg; codecs=vorbis"] },
  opus: { type: "audio/ogg", tests: ["audio/ogg; codecs=opus", "audio/opus"] },
  flac: { type: "audio/flac", tests: ["audio/flac", "audio/x-flac"] },
  wav: { type: "audio/wav", tests: ["audio/wav", "audio/x-wav", "audio/wave"] },
  webm: { type: "audio/webm", tests: ["audio/webm", "audio/webm; codecs=opus"] },
  weba: { type: "audio/webm", tests: ["audio/webm", "audio/webm; codecs=opus"] }
};

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
export const compareText = (a, b) => collator.compare(a || "", b || "");

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

export function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
}

export function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* stockage plein ou bloqué */ }
}

export function newId() {
  return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function icon(name) {
  return `<svg class="ic" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function setIcon(button, name) {
  button.querySelector("use")?.setAttribute("href", "#i-" + name);
}

/* 3725 secondes → « 1:02:05 » */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* 3725 secondes → « 1 h 02 » ; 600 → « 10 min » */
export function formatLength(seconds) {
  if (!seconds) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return `${Math.round(seconds)} s`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

export function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1).replace(".", ",") + " Go";
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + " Mo";
  return Math.max(1, Math.round(bytes / 1e3)) + " ko";
}

export function plural(count, one, many) {
  return `${count} ${count > 1 ? many : one}`;
}

export function shuffleArray(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function detectCategory(tags, extension) {
  if (extension === "m4b" || tags.kind === "book") return "book";
  if (tags.kind === "podcast" || tags.podcast) return "podcast";
  const genre = (tags.genre || "").toLowerCase();
  if (/podcast/.test(genre)) return "podcast";
  if (/audiobook|audio book|livres? audio|livre-audio|hörbuch|hoerbuch|audiolibro/.test(genre)) return "book";
  return null;
}

export function cleanGenre(genre) {
  return (genre || "").replace(/^\(\d+\)/, "").replace(/^\d+$/, "").trim();
}

export function parseNumber(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/* « 03 - Ma chanson.mp3 » → titre « Ma chanson », piste 3 */
export function titleFromFileName(name) {
  let base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  let track = 0;
  const match = base.match(/^(\d{1,3})\s*[-.–)]\s*(.+)$/);
  if (match) { track = parseInt(match[1], 10); base = match[2]; }
  return { title: base || name, track };
}

export function naturalOrder(a, b) {
  return (a.disc || 0) - (b.disc || 0) ||
    (a.track || 0) - (b.track || 0) ||
    compareText(a.fileName, b.fileName);
}

/* Clé de regroupement corrigée pour éviter la scission d'albums sans albumArtist. */
export function groupKey(track, kind) {
  const lower = text => (text || "").toLowerCase();
  switch (kind) {
    case "artist": return lower(track.artist);
    case "album": return track.album ? lower(track.album) + "|" + lower(track.albumArtist || track.artist || track.folder) : "";
    case "show": return lower(track.album || track.artist || track.folder);
    default: return lower(track.album || track.folder || track.title);
  }
}

export function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return { value: best, distinct: counts.size };
}

/* Empreinte binaire rapide (taille + 4 ko début + 4 ko fin) pour déduplication fiable. */
export async function fileFingerprint(file) {
  const headLen = Math.min(file.size, 4096);
  const tailStart = Math.max(headLen, file.size - 4096);
  const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());
  const tail = tailStart < file.size
    ? new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
    : new Uint8Array(0);
  const sample = new Uint8Array(8 + head.length + tail.length);
  const view = new DataView(sample.buffer);
  view.setUint32(0, Math.floor(file.size / 0x100000000), false);
  view.setUint32(4, file.size >>> 0, false);
  sample.set(head, 8);
  sample.set(tail, 8 + head.length);

  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", sample));
    return file.size + ":" + Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, "0")).join("");
  }

  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < sample.length; i++) {
    h1 = Math.imul(h1 ^ sample[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + sample[i] + i, 0x85ebca6b) >>> 0;
  }
  return `${file.size}:${h1.toString(16)}-${h2.toString(16)}`;
}
