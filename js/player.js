/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import {
  CATEGORY_NAMES, SKIP_BACK, SKIP_FORWARD, SPEEDS,
  escapeHtml, formatTime, icon, newId, readJson, setIcon, shuffleArray, writeJson
} from "./utils.js";
import {
  $, SESSION_KEY, getOne, isSpoken, putOne, saveSettings, saveTrack,
  settings, showToast, state, tracks, transaction
} from "./db.js";
import { coverHtml, coverUrl, loadCovers } from "./covers.js";

export const isApple = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const volumeAdjustable = (() => {
  const test = document.createElement("audio");
  try { test.volume = 0.5; } catch (_) { return false; }
  return test.volume === 0.5;
})();

export const audio = $("audio");

export const player = {
  queue: [],
  index: -1,
  original: null,
  shuffle: false,
  repeat: "off",
  source: "",
  loadedId: null,
  pendingSeek: null,
  restorePosition: null,
  silent: false
};

export const sleep = { endsAt: 0, endOfTrack: false, timer: null };

let objectUrl = null;
let loadToken = 0;
let lastSave = 0;
let seeking = false;

let hooks = {
  render: () => {},
  openPlayer: () => {},
  openMenu: () => {},
  askDialog: async () => null
};

export function setPlayerHooks(nextHooks) {
  hooks = Object.assign(hooks, nextHooks);
}

export function isSeeking() {
  return seeking;
}

export function setSeeking(value) {
  seeking = value;
}

export function currentTrack() {
  return tracks.get(player.queue[player.index]) || null;
}

export function applyRate(track) {
  const rate = isSpoken(track) ? settings.speed : 1;
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}

export function applyVolume(factor = 1) {
  if (volumeAdjustable) audio.volume = Math.max(0, Math.min(1, settings.volume * factor));
}

export function speedLabel(speed) {
  return String(speed).replace(".", ",") + "×";
}

export function saveSession() {
  writeJson(SESSION_KEY, {
    queue: player.queue,
    index: player.index,
    original: player.original,
    shuffle: player.shuffle,
    repeat: player.repeat,
    source: player.source,
    position: player.loadedId
      ? (player.pendingSeek !== null ? player.pendingSeek : audio.currentTime)
      : player.restorePosition || 0
  });
}

export function restoreSession() {
  const session = readJson(SESSION_KEY);
  if (!session?.queue?.length) return;
  const currentId = session.queue[session.index];
  player.queue = session.queue.filter(id => tracks.has(id));
  player.index = Math.max(0, player.queue.indexOf(currentId));
  if (!player.queue.length) player.index = -1;
  player.original = Array.isArray(session.original) ? session.original.filter(id => tracks.has(id)) : null;
  player.shuffle = Boolean(session.shuffle && player.original);
  player.repeat = ["off", "all", "one"].includes(session.repeat) ? session.repeat : "off";
  player.source = session.source || "";
  player.restorePosition = player.queue[player.index] === currentId ? session.position || 0 : 0;
}

/* Mémorise l'endroit où l'on s'est arrêté (y compris pendingSeek si force=true). */
export function savePosition(force = false) {
  const track = tracks.get(player.loadedId);
  if (!track || player.silent) return;

  if (player.pendingSeek !== null) {
    if (!force) return;
    if (isSpoken(track) && track.position !== player.pendingSeek) {
      track.position = player.pendingSeek;
      saveTrack(track);
    }
    saveSession();
    return;
  }

  if (audio.readyState < 1) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;

  if (isSpoken(track)) {
    const duration = Number.isFinite(audio.duration) ? audio.duration : track.duration;
    const position = audio.currentTime;
    const finished = duration > 0 && duration - position < 5;
    if (track.position !== position || track.finished !== finished) {
      track.position = finished ? 0 : position;
      track.finished = finished || (track.finished && position < 1);
      saveTrack(track);
    }
  }
  saveSession();
}

export function unloadAudio() {
  loadToken++;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  player.loadedId = null;
  player.pendingSeek = null;
}

export async function loadCurrent({ autoplay = true, position = null } = {}) {
  savePosition(true);
  const track = currentTrack();
  if (!track) { unloadAudio(); updatePlayerUi(); return; }

  const token = ++loadToken;
  const record = await getOne("files", track.id).catch(() => null);
  if (token !== loadToken) return;

  if (!record?.blob) {
    showToast(`Le fichier « ${track.title} » est introuvable sur cet appareil.`, 5000, true);
    return;
  }

  const previousUrl = objectUrl;
  objectUrl = URL.createObjectURL(record.blob);
  player.silent = false;
  player.loadedId = track.id;

  const start = position ?? (isSpoken(track) && !track.finished ? track.position : 0);
  player.pendingSeek = start > 0 ? start : null;
  audio.src = objectUrl;
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  applyRate(track);
  applyVolume(sleepFade());

  track.playedAt = Date.now();
  saveTrack(track);
  updatePlayerUi();
  updateMediaSession();
  saveSession();

  if (autoplay) {
    try {
      await audio.play();
    } catch (error) {
      if (error.name !== "AbortError") showToast("Appuyez sur lecture pour démarrer l’écoute.");
    }
  }
}

export function playList(ids, index = 0, { shuffle = false, source = "", position = null } = {}) {
  ids = ids.filter(id => tracks.has(id));
  if (!ids.length) return;
  index = Math.max(0, Math.min(index, ids.length - 1));

  if (shuffle) {
    player.original = [...ids];
    const first = ids[index];
    const rest = shuffleArray(ids.filter((_, i) => i !== index));
    ids = [first, ...rest];
    index = 0;
    player.shuffle = true;
  } else {
    player.original = null;
    player.shuffle = false;
  }

  player.queue = ids;
  player.index = index;
  player.source = source;
  player.restorePosition = null;
  loadCurrent({ autoplay: true, position });
}

export function togglePlay() {
  const track = currentTrack();
  if (!track) return;

  if (player.loadedId !== track.id) {
    const position = isSpoken(track) ? null : player.restorePosition;
    player.restorePosition = null;
    loadCurrent({ autoplay: true, position });
    return;
  }

  if (audio.paused) audio.play().catch(() => showToast("Lecture impossible pour le moment."));
  else audio.pause();
}

export function pause() {
  if (!audio.paused) audio.pause();
}

export function previous() {
  if (player.loadedId && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (player.index > 0) {
    player.index--;
    loadCurrent({ autoplay: true });
  } else if (player.loadedId) {
    audio.currentTime = 0;
  }
}

export function next() {
  if (player.index < player.queue.length - 1) {
    player.index++;
    loadCurrent({ autoplay: true });
  } else if (player.repeat === "all" && player.queue.length) {
    player.index = 0;
    loadCurrent({ autoplay: true });
  } else {
    showToast("C’était la dernière piste de la file d’attente.");
  }
}

export function seekBy(seconds) {
  if (!player.loadedId || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration - 0.1, audio.currentTime + seconds));
}

export async function handleEnded() {
  if (player.silent) return;
  const track = currentTrack();
  if (track && isSpoken(track)) {
    track.finished = true;
    track.position = 0;
    saveTrack(track);
  }

  if (sleep.endOfTrack) {
    cancelSleep();
    showToast("Minuterie : la lecture s’est arrêtée.");
    updatePlayerUi();
    hooks.render();
    return;
  }

  const repeat = isSpoken(track) ? "off" : player.repeat;

  if (repeat === "one") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }

  if (player.index < player.queue.length - 1) {
    player.index++;
    await loadCurrent({ autoplay: true });
  } else if (repeat === "all") {
    player.index = 0;
    await loadCurrent({ autoplay: true });
  } else {
    updatePlayerUi();
  }
  hooks.render();
}

/* --- File d'attente --- */
export function playNext(ids) {
  ids = ids.filter(id => tracks.has(id));
  if (!ids.length) return;
  if (!player.queue.length) { playList(ids, 0, { source: "File d’attente" }); return; }
  player.queue.splice(player.index + 1, 0, ...ids);
  if (player.original) player.original.push(...ids);
  saveSession();
  showToast(ids.length > 1 ? `${ids.length} pistes seront lues ensuite.` : "Sera lu ensuite.");
}

export function addToQueue(ids) {
  ids = ids.filter(id => tracks.has(id));
  if (!ids.length) return;
  if (!player.queue.length) { playList(ids, 0, { source: "File d’attente" }); return; }
  player.queue.push(...ids);
  if (player.original) player.original.push(...ids);
  saveSession();
  showToast(ids.length > 1 ? `${ids.length} pistes ajoutées à la file d’attente.` : "Ajouté à la file d’attente.");
}

export function removeFromQueue(position) {
  const wasCurrent = position === player.index;
  const wasPlaying = !audio.paused;
  player.queue.splice(position, 1);

  if (position < player.index) player.index--;
  if (wasCurrent) {
    if (!player.queue.length) {
      player.index = -1;
      unloadAudio();
    } else {
      player.index = Math.min(player.index, player.queue.length - 1);
      loadCurrent({ autoplay: wasPlaying });
    }
  }
  saveSession();
  updatePlayerUi();
}

export function moveInQueue(position, delta) {
  const target = position + delta;
  if (target < 0 || target >= player.queue.length) return;
  const [id] = player.queue.splice(position, 1);
  player.queue.splice(target, 0, id);
  if (player.index === position) player.index = target;
  else if (player.index === target) player.index = position;
  saveSession();
}

export function toggleShuffle() {
  const currentId = player.queue[player.index];
  if (!player.shuffle) {
    player.original = [...player.queue];
    const rest = shuffleArray(player.queue.filter((_, i) => i !== player.index));
    player.queue = currentId ? [currentId, ...rest] : rest;
    player.index = currentId ? 0 : -1;
    player.shuffle = true;
  } else {
    const kept = (player.original || []).filter(id => player.queue.includes(id));
    const extra = player.queue.filter(id => !kept.includes(id));
    player.queue = [...kept, ...extra];
    player.index = Math.max(0, player.queue.indexOf(currentId));
    player.original = null;
    player.shuffle = false;
  }
  saveSession();
  updatePlayerUi();
  showToast(player.shuffle ? "Lecture aléatoire activée." : "Lecture aléatoire désactivée.", 2500);
}

export function cycleRepeat() {
  player.repeat = { off: "all", all: "one", one: "off" }[player.repeat];
  saveSession();
  updatePlayerUi();
  showToast({ off: "Répétition désactivée.", all: "Répétition de toute la file.", one: "Répétition de la piste en cours." }[player.repeat], 2500);
}

/* --- Déblocage iOS --- */
const SILENCE = (() => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 38, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 2, true);
  return "data:audio/wav;base64," + btoa(String.fromCharCode(...bytes));
})();

let audioUnlocked = !isApple;
export function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  if (audio.getAttribute("src")) return;
  player.silent = true;
  audio.src = SILENCE;
  audio.play().then(() => { if (player.silent) audio.pause(); }).catch(() => {});
}

/* --- Minuterie de sommeil --- */
export function setSleep(minutes) {
  cancelSleep(false);
  sleep.endsAt = Date.now() + minutes * 60000;
  sleep.timer = setInterval(checkSleep, 1000);
  updateSleepLabel();
  showToast(`La lecture s’arrêtera dans ${minutes} min.`, 2500);
}

export function setSleepEndOfTrack() {
  cancelSleep(false);
  sleep.endOfTrack = true;
  updateSleepLabel();
  showToast("La lecture s’arrêtera à la fin de la piste.", 2500);
}

export function cancelSleep(update = true) {
  clearInterval(sleep.timer);
  sleep.timer = null;
  sleep.endsAt = 0;
  sleep.endOfTrack = false;
  applyVolume();
  if (update) updateSleepLabel();
}

export function sleepFade() {
  if (!sleep.endsAt) return 1;
  const remaining = sleep.endsAt - Date.now();
  return remaining < 10000 ? Math.max(0.05, remaining / 10000) : 1;
}

export function checkSleep() {
  if (!sleep.endsAt) return;
  if (Date.now() >= sleep.endsAt) {
    pause();
    cancelSleep();
    showToast("Minuterie : la lecture s’est arrêtée.");
    return;
  }
  applyVolume(sleepFade());
  updateSleepLabel();
}

export function updateSleepLabel() {
  const button = $("sleepButton");
  let label = "Minuterie";
  if (sleep.endsAt) label = formatTime((sleep.endsAt - Date.now()) / 1000);
  else if (sleep.endOfTrack) label = "Fin de piste";
  $("sleepLabel").textContent = label;
  button.classList.toggle("on", Boolean(sleep.endsAt || sleep.endOfTrack));
  button.setAttribute("aria-label", sleep.endsAt || sleep.endOfTrack ? `Minuterie active : ${label}` : "Minuterie de sommeil");
}

export function chooseSleep() {
  const active = sleep.endsAt || sleep.endOfTrack;
  const items = [5, 15, 30, 45, 60, 90].map(minutes => ({
    label: `Dans ${minutes} minutes`, icon: "moon", run: () => setSleep(minutes)
  }));
  items.push({ label: "À la fin de la piste en cours", icon: "moon", current: sleep.endOfTrack, run: setSleepEndOfTrack });
  if (active) items.unshift({ label: "Désactiver la minuterie", icon: "close", run: () => { cancelSleep(); showToast("Minuterie désactivée.", 2500); } });
  hooks.openMenu("Arrêter la lecture…", items);
}

/* --- Vitesse & signets --- */
export function setSpeed(speed) {
  settings.speed = speed;
  saveSettings();
  const track = currentTrack();
  if (track && isSpoken(track)) applyRate(track);
  updatePlayerUi();
  $("speedSelect").value = String(speed);
}

export function chooseSpeed() {
  hooks.openMenu("Vitesse de lecture", SPEEDS.map(speed => ({
    label: speed === 1 ? "1× (normale)" : speedLabel(speed),
    icon: speed === settings.speed ? "check" : "play",
    current: speed === settings.speed,
    run: () => setSpeed(speed)
  })), "Pour les podcasts et les livres audio. La musique reste toujours à vitesse normale.");
}

export async function addBookmark() {
  const track = tracks.get(player.loadedId);
  if (!track) { showToast("Lancez d’abord la lecture."); return; }
  const time = audio.currentTime;
  const note = await hooks.askDialog({
    title: `Signet à ${formatTime(time)}`,
    message: track.title,
    input: { placeholder: "Note (facultatif)" },
    okLabel: "Ajouter"
  });
  if (note === null) return;
  const bookmark = { id: newId(), trackId: track.id, time, note, createdAt: Date.now() };
  state.bookmarks.push(bookmark);
  await putOne("bookmarks", bookmark).catch(() => showToast("Le signet n’a pas pu être enregistré.", 4000, true));
  renderBookmarks();
  showToast("Signet ajouté.", 2000);
}

export async function deleteBookmark(id) {
  state.bookmarks = state.bookmarks.filter(item => item.id !== id);
  await transaction("bookmarks", "readwrite", tx => { tx.objectStore("bookmarks").delete(id); }).catch(() => {});
  renderBookmarks();
}

export function renderBookmarks() {
  const track = currentTrack();
  const items = track ? state.bookmarks.filter(item => item.trackId === track.id).sort((a, b) => a.time - b.time) : [];
  $("bookmarkSection").hidden = !items.length;
  $("bookmarkList").innerHTML = items.map(item => `<div class="bookmark">
      <button class="jump" type="button" data-bookmark-jump="${item.id}">
        <time>${formatTime(item.time)}</time><span>${escapeHtml(item.note || "Sans note")}</span>
      </button>
      <button class="icon-button" type="button" data-bookmark-delete="${item.id}" aria-label="Supprimer ce signet">${icon("trash")}</button>
    </div>`).join("");
}

export function jumpToBookmark(id) {
  const item = state.bookmarks.find(bookmark => bookmark.id === id);
  if (!item) return;
  if (player.loadedId === item.trackId && audio.readyState >= 1) {
    audio.currentTime = item.time;
    if (audio.paused) audio.play().catch(() => {});
  } else {
    loadCurrent({ autoplay: true, position: item.time });
  }
}

/* --- Media Session --- */
function setMediaAction(action, handler) {
  try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* action non prise en charge */ }
}

export function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  setMediaAction("play", () => { if (audio.paused) togglePlay(); });
  setMediaAction("pause", pause);
  setMediaAction("stop", pause);
  setMediaAction("previoustrack", previous);
  setMediaAction("nexttrack", next);
  setMediaAction("seekto", details => {
    if (!player.loadedId || !Number.isFinite(details.seekTime)) return;
    audio.currentTime = details.seekTime;
    updatePositionState();
  });
}

export async function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const track = currentTrack();
  if (!track) { navigator.mediaSession.metadata = null; return; }

  const spoken = isSpoken(track);
  setMediaAction("seekbackward", spoken ? details => seekBy(-(details.seekOffset || SKIP_BACK)) : null);
  setMediaAction("seekforward", spoken ? details => seekBy(details.seekOffset || SKIP_FORWARD) : null);

  const url = await coverUrl(track.coverId, "large");
  if (currentTrack() !== track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || track.albumArtist || CATEGORY_NAMES[track.category],
      album: track.album || "",
      artwork: url
        ? [{ src: url, sizes: "512x512", type: "image/jpeg" }]
        : [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }]
    });
  } catch (_) { /* navigateur trop ancien */ }
}

export function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!player.loadedId || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch (_) { /* valeurs refusées */ }
}

/* --- Affichage lecteur --- */
export function markPlaying() {
  const id = currentTrack()?.id;
  document.querySelectorAll(".row[data-track]").forEach(row => {
    row.classList.toggle("playing", row.dataset.track === id);
  });
}

export function renderQueue() {
  const rows = player.queue.map((id, position) => {
    const track = tracks.get(id);
    if (!track) return "";
    const current = position === player.index;
    const heading = position === player.index + 1 ? `<p class="queue-heading">À suivre</p>` : "";
    return heading + `<div class="queue-row${current ? " current" : ""}">
      <button class="jump" type="button" data-queue-jump="${position}">
        <span class="row-title">${escapeHtml(track.title)}</span>
        <span class="row-sub">${escapeHtml([track.artist, formatTime(track.duration)].filter(Boolean).join(" · "))}</span>
      </button>
      <button class="icon-button" type="button" data-queue-move="${position}" data-delta="-1" aria-label="Monter" ${position === 0 ? "disabled" : ""}>${icon("up")}</button>
      <button class="icon-button" type="button" data-queue-move="${position}" data-delta="1" aria-label="Descendre" ${position === player.queue.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>
      <button class="icon-button" type="button" data-queue-remove="${position}" aria-label="Retirer de la file">${icon("close")}</button>
    </div>`;
  }).join("");

  $("queueList").innerHTML = player.queue.length
    ? `<p class="queue-heading">En cours</p>` + rows
    : `<p class="section-note">La file d’attente est vide.</p>`;
  $("queueClear").disabled = player.index >= player.queue.length - 1;
}

export function updatePlayState() {
  const playing = !audio.paused && !player.silent && Boolean(player.loadedId);
  document.body.classList.toggle("is-playing", playing);
  for (const id of ["playButton", "miniPlay"]) {
    setIcon($(id), playing ? "pause" : "play");
    $(id).setAttribute("aria-label", playing ? "Pause" : "Lecture");
  }
  if ("mediaSession" in navigator && player.loadedId) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

export function updateProgress() {
  const track = currentTrack();
  if (!track) return;
  const loaded = player.loadedId === track.id && player.pendingSeek === null;
  const duration = loaded && Number.isFinite(audio.duration) ? audio.duration : track.duration || 0;
  let position;
  if (loaded) position = audio.currentTime;
  else if (player.pendingSeek !== null && player.loadedId === track.id) position = player.pendingSeek;
  else position = isSpoken(track) ? (track.finished ? 0 : track.position || 0) : player.restorePosition || 0;

  const ratio = duration ? Math.min(1, position / duration) : 0;
  if (!seeking) $("seekBar").value = String(Math.round(ratio * 1000));
  $("timeCurrent").textContent = formatTime(seeking ? (Number($("seekBar").value) / 1000) * duration : position);
  $("timeRemaining").textContent = "-" + formatTime(duration - (seeking ? (Number($("seekBar").value) / 1000) * duration : position));
  $("miniProgress").style.width = (ratio * 100).toFixed(2) + "%";
}

export function updatePlayerUi() {
  const track = currentTrack();
  $("miniPlayer").hidden = !track;
  document.documentElement.style.setProperty("--mini-height", track ? "68px" : "0px");
  updatePlayState();
  if (!track) return;

  const spoken = isSpoken(track);
  const artist = track.artist || track.albumArtist || "";

  $("miniTitle").textContent = track.title;
  $("miniArtist").textContent = artist || CATEGORY_NAMES[track.category];
  $("miniCover").innerHTML = coverHtml(track.coverId, track.category);
  setIcon($("miniNext"), spoken ? "forward30" : "next");
  $("miniNext").setAttribute("aria-label", spoken ? "Avancer de 30 secondes" : "Piste suivante");

  $("playerTitle").textContent = track.title;
  $("playerArtist").textContent = [artist, track.album].filter(Boolean).join(" · ");
  $("playerSource").textContent = player.source || CATEGORY_NAMES[track.category];
  $("playerCover").innerHTML = coverHtml(track.coverId, track.category, "large", "player-cover");

  $("shuffleButton").hidden = spoken;
  $("repeatButton").hidden = spoken;
  $("backButton").hidden = !spoken;
  $("forwardButton").hidden = !spoken;
  $("speedButton").hidden = !spoken;
  $("bookmarkButton").hidden = !spoken;
  $("volumeRow").hidden = !volumeAdjustable;

  $("shuffleButton").classList.toggle("on", player.shuffle);
  $("shuffleButton").setAttribute("aria-pressed", String(player.shuffle));
  $("repeatButton").classList.toggle("on", player.repeat !== "off");
  setIcon($("repeatButton"), player.repeat === "one" ? "repeat-one" : "repeat");
  $("repeatButton").setAttribute("aria-label", { off: "Répétition : désactivée", all: "Répétition : toute la file", one: "Répétition : piste en cours" }[player.repeat]);
  $("speedButton").textContent = speedLabel(settings.speed);
  $("speedButton").classList.toggle("on", settings.speed !== 1);

  loadCovers($("miniPlayer"));
  loadCovers($("playerCover"));
  renderBookmarks();
  updateProgress();
  updateSleepLabel();
  markPlaying();
  if (!$("queueBackdrop").hidden) renderQueue();
}
