/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import {
  APP_VERSION, CATEGORY_ICONS, CATEGORY_NAMES, FORMATS, SPEEDS,
  cleanGenre, compareText, detectCategory, escapeHtml, fileFingerprint,
  formatLength, formatSize, formatTime, groupKey, icon, mostCommon,
  naturalOrder, newId, parseNumber, plural, titleFromFileName
} from "./utils.js";
import { readTags } from "./parsers.js";
import {
  $, applyTheme, clearAllStores, isQuotaError, isSpoken, knownCovers,
  putOne, saveSettings, saveTrack, settings, showToast, state, storeTrack,
  tracks, transaction
} from "./db.js";
import {
  coverCacheStats, coverHtml, loadCovers, removeUnusedCovers,
  revokeAllCovers, storeCover
} from "./covers.js";
import {
  closeAllLayers, closeDetailsLayers, closeTopLayer, getLayers, openLayer
} from "./layers.js";
import {
  addToQueue, audio, cancelSleep, currentTrack, loadCurrent, markPlaying, next,
  playList, playNext, player, renderQueue, savePosition, saveSession,
  setPlayerHooks, setSpeed, speedLabel, unloadAudio, updatePlayerUi
} from "./player.js";

export const view = {
  search: "",
  details: []
};

export let listing = [];
let importing = false;
let deferredInstallPrompt = null;
let waitingWorker = null;
let updateRequested = false;

export function getView() {
  return view;
}

export function getListing() {
  return listing;
}

/* ============================================================
   BIBLIOTHÈQUE : TRI ET REGROUPEMENTS
   ============================================================ */
export function tracksIn(category) {
  return [...tracks.values()].filter(track => track.category === category);
}

const SORT_OPTIONS = {
  tracks: [["title", "Titre"], ["artist", "Artiste"], ["album", "Album"], ["added", "Ajout récent"], ["duration", "Durée"]],
  groups: [["name", "Nom"], ["added", "Ajout récent"], ["played", "Écoute récente"]],
  playlists: [["name", "Nom"], ["added", "Création récente"]]
};

export function sortContext() {
  if (settings.tab === "music") return { key: "music-" + settings.musicView, kind: settings.musicView === "tracks" ? "tracks" : "groups" };
  if (settings.tab === "playlists") return { key: "playlists", kind: "playlists" };
  return { key: settings.tab, kind: "groups" };
}

function currentSort() {
  const { key, kind } = sortContext();
  const options = SORT_OPTIONS[kind];
  const saved = settings.sorts[key];
  return options.some(([value]) => value === saved) ? saved : options[0][0];
}

function sortTracks(list, sort) {
  const sorted = [...list];
  switch (sort) {
    case "artist": return sorted.sort((a, b) => compareText(a.artist, b.artist) || compareText(a.album, b.album) || naturalOrder(a, b));
    case "album": return sorted.sort((a, b) => compareText(a.album, b.album) || naturalOrder(a, b));
    case "added": return sorted.sort((a, b) => b.addedAt - a.addedAt);
    case "duration": return sorted.sort((a, b) => b.duration - a.duration);
    default: return sorted.sort((a, b) => compareText(a.title, b.title));
  }
}

export function buildGroups(list, kind) {
  const map = new Map();
  for (const track of list) {
    const key = groupKey(track, kind);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(track);
  }

  return [...map].map(([key, items]) => {
    const first = items[0];
    items.sort(kind === "artist"
      ? (a, b) => compareText(a.album, b.album) || naturalOrder(a, b)
      : naturalOrder);

    let name;
    let subtitle = "";
    if (kind === "artist") {
      name = first.artist || "Artiste inconnu";
      const albums = new Set(items.map(track => track.album).filter(Boolean)).size;
      subtitle = [albums ? plural(albums, "album", "albums") : "", plural(items.length, "morceau", "morceaux")].filter(Boolean).join(" · ");
    } else if (kind === "album") {
      name = first.album || "Sans album";
      const artists = mostCommon(items.map(track => track.artist));
      subtitle = first.albumArtist || (artists.distinct > 1 ? "Artistes variés" : artists.value);
    } else if (kind === "show") {
      name = first.album || first.artist || first.folder || "Épisodes sans émission";
      subtitle = first.album ? first.artist : "";
    } else {
      name = first.album || first.folder || first.title;
      subtitle = mostCommon(items.map(track => track.artist || track.albumArtist)).value;
    }

    return {
      key,
      kind,
      name,
      subtitle,
      tracks: items,
      coverId: items.find(track => track.coverId)?.coverId || null,
      category: first.category,
      duration: items.reduce((sum, track) => sum + (track.duration || 0), 0),
      addedAt: Math.max(...items.map(track => track.addedAt)),
      playedAt: Math.max(...items.map(track => track.playedAt || 0))
    };
  });
}

function sortGroups(groups, sort) {
  const sorted = [...groups];
  if (sort === "added") return sorted.sort((a, b) => b.addedAt - a.addedAt);
  if (sort === "played") return sorted.sort((a, b) => b.playedAt - a.playedAt || compareText(a.name, b.name));
  return sorted.sort((a, b) => (a.key === "") - (b.key === "") || compareText(a.name, b.name));
}

function groupKindFor(category) {
  return category === "podcast" ? "show" : category === "book" ? "book" : "album";
}

function findGroup(detail) {
  const pool = detail.kind === "artist" || detail.kind === "album"
    ? tracksIn("music")
    : tracksIn(detail.kind === "show" ? "podcast" : "book");
  return buildGroups(pool, detail.kind).find(group => group.key === detail.key) || null;
}

function listenedSeconds(track) {
  if (track.finished) return track.duration || 0;
  return Math.min(track.position || 0, track.duration || 0);
}

export function resumeIndex(items) {
  const index = items.findIndex(track => !track.finished);
  return index < 0 ? 0 : index;
}

/* ============================================================
   AFFICHAGE DE LA BIBLIOTHÈQUE
   ============================================================ */
function trackRowHtml(track, index, { number = null, subtitle = null, draggable = false } = {}) {
  const sub = subtitle ?? [track.artist, track.album].filter(Boolean).join(" · ");
  let time = formatTime(track.duration);
  let progress = "";

  if (isSpoken(track)) {
    if (track.finished) {
      time = `<span class="done-label">Écouté</span>`;
    } else if (track.position > 5 && track.duration) {
      const percent = Math.min(100, Math.round((track.position / track.duration) * 100));
      time = `Reste ${formatLength(track.duration - track.position) || "1 min"}`;
      progress = `<span class="row-progress"><span style="width:${percent}%"></span></span>`;
    }
  }

  const dragBtn = draggable
    ? `<button class="drag-handle" type="button" data-drag-index="${index}" aria-label="Réordonner « ${escapeHtml(track.title)} »">${icon("grip")}</button>`
    : "";

  const lead = number !== null
    ? `<span class="row-number">${number || ""}</span>`
    : coverHtml(track.coverId, track.category);

  return `<div class="row" data-index="${index}" data-track="${track.id}" role="button" tabindex="0">
    ${dragBtn}
    ${lead}
    <span class="row-text">
      <span class="row-title">${escapeHtml(track.title)}</span>
      ${sub ? `<span class="row-sub">${escapeHtml(sub)}</span>` : ""}
      ${progress}
    </span>
    <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="row-time">${time}</span>
    <button class="icon-button" type="button" data-track-menu="${index}" aria-label="Options de « ${escapeHtml(track.title)} »">${icon("more")}</button>
  </div>`;
}

function groupRowHtml(group) {
  let meta = group.subtitle;
  let progress = "";

  if (group.kind === "show" || group.kind === "book") {
    const waiting = group.tracks.filter(track => !track.finished).length;
    if (group.kind === "show") {
      meta = [group.subtitle, waiting ? plural(waiting, "épisode à écouter", "épisodes à écouter") : "Tout est écouté"].filter(Boolean).join(" · ");
    } else {
      const listened = group.tracks.reduce((sum, track) => sum + listenedSeconds(track), 0);
      const percent = group.duration ? Math.min(100, Math.round((listened / group.duration) * 100)) : 0;
      meta = [group.subtitle, formatLength(group.duration), percent >= 100 ? "Terminé" : percent ? `${percent} %` : ""].filter(Boolean).join(" · ");
      if (percent > 0 && percent < 100) progress = `<span class="row-progress"><span style="width:${percent}%"></span></span>`;
    }
  }

  return `<div class="row" data-group="${escapeHtml(group.key)}" data-kind="${group.kind}" role="button" tabindex="0">
    ${coverHtml(group.coverId, group.category)}
    <span class="row-text">
      <span class="row-title">${escapeHtml(group.name)}</span>
      ${meta ? `<span class="row-sub">${escapeHtml(meta)}</span>` : ""}
      ${progress}
    </span>
    <span class="row-time">${icon("right")}</span>
  </div>`;
}

function playlistRowHtml(playlist) {
  const items = playlist.tracks.map(id => tracks.get(id)).filter(Boolean);
  const duration = items.reduce((sum, track) => sum + (track.duration || 0), 0);
  const coverId = items.find(track => track.coverId)?.coverId || null;
  return `<div class="row" data-playlist="${playlist.id}" role="button" tabindex="0">
    ${coverHtml(coverId, "playlist")}
    <span class="row-text">
      <span class="row-title">${escapeHtml(playlist.name)}</span>
      <span class="row-sub">${plural(items.length, "piste", "pistes")}${duration ? " · " + formatLength(duration) : ""}</span>
    </span>
  </div>`;
}

function emptyStateHtml(category) {
  const texts = {
    music: ["Votre musique apparaîtra ici", "Ajoutez des fichiers audio de cet appareil (MP3, M4A, FLAC, OGG, WAV…). Ils restent enregistrés dans l’application et s’écoutent même sans Internet."],
    podcast: ["Aucun podcast pour l’instant", "Ajoutez des épisodes déjà téléchargés sur cet appareil. Chaque épisode reprend là où vous l’avez laissé. Omni-Musique fonctionne sans Internet : il ne s’abonne pas aux podcasts en ligne."],
    book: ["Aucun livre audio pour l’instant", "Ajoutez un fichier M4B ou tous les fichiers d’un livre (un par chapitre). Le livre reprend là où vous l’avez laissé, à la vitesse de votre choix."],
    playlists: ["Aucune liste de lecture", "Créez une liste, puis ajoutez-y des pistes avec le bouton ⋮ placé à côté de chacune."]
  };
  const [title, text] = texts[category];
  const buttons = category === "playlists"
    ? `<button class="primary-button" type="button" data-action="new-playlist">${icon("plus")}Nouvelle liste</button>`
    : `<button class="primary-button" type="button" data-action="import">${icon("plus")}Ajouter des fichiers</button>`;
  return `<div class="empty-state">
    ${coverHtml(null, category === "playlists" ? "playlist" : category)}
    <strong>${title}</strong>
    <p>${text}</p>
    <div class="button-row">${buttons}</div>
  </div>`;
}

function updateToolbar() {
  const detail = view.details[view.details.length - 1];
  const tab = settings.tab;
  const hasItems = tab === "playlists" ? state.playlists.length > 0 : tracksIn(tab).length > 0;

  $("toolbar").hidden = Boolean(detail) || !hasItems;
  $("musicViews").hidden = tab !== "music" || Boolean(view.search);
  $("toolbar").classList.toggle("with-views", !$("musicViews").hidden);
  $("searchInput").placeholder = tab === "playlists" ? "Rechercher une liste…" : "Rechercher…";
  document.querySelectorAll("#musicViews button").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.view === settings.musicView));
  });

  const { kind } = sortContext();
  const select = $("sortSelect");
  select.parentElement.hidden = Boolean(view.search) && tab !== "playlists";
  select.innerHTML = SORT_OPTIONS[kind].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  select.value = currentSort();

  document.querySelectorAll(".tab").forEach(button => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

export function render() {
  updateToolbar();
  const box = $("content");
  const detail = view.details[view.details.length - 1];
  listing = [];

  if (detail) {
    box.innerHTML = detailHtml(detail);
  } else if (settings.tab === "playlists") {
    box.innerHTML = playlistsHtml();
  } else {
    box.innerHTML = libraryHtml(settings.tab);
  }

  loadCovers(box);
  markPlaying();
}

function libraryHtml(category) {
  const all = tracksIn(category);
  if (!all.length) return emptyStateHtml(category);

  const query = view.search.trim().toLowerCase();
  if (query) {
    const found = sortTracks(all.filter(track =>
      [track.title, track.artist, track.album, track.albumArtist, track.fileName].some(text => (text || "").toLowerCase().includes(query))
    ), "title");
    listing = found.map(track => track.id);
    if (!found.length) return `<p class="section-note">Aucun résultat pour « ${escapeHtml(view.search.trim())} ».</p>`;
    return `<p class="section-note">${plural(found.length, "résultat", "résultats")}</p><div class="list">` +
      found.map((track, index) => trackRowHtml(track, index)).join("") + `</div>`;
  }

  const sort = currentSort();

  if (category === "music" && settings.musicView === "tracks") {
    const sorted = sortTracks(all, sort);
    listing = sorted.map(track => track.id);
    const total = sorted.reduce((sum, track) => sum + (track.duration || 0), 0);
    return `<div class="hero-actions" style="margin: 4px 8px 8px">
        <button class="primary-button" type="button" data-action="play-all">${icon("play")}Tout lire</button>
        <button class="secondary-button" type="button" data-action="shuffle-all">${icon("shuffle")}Aléatoire</button>
        <span class="section-note">${plural(sorted.length, "morceau", "morceaux")} · ${formatLength(total)}</span>
      </div><div class="list">` +
      sorted.map((track, index) => trackRowHtml(track, index)).join("") + `</div>`;
  }

  const kind = category === "music" ? (settings.musicView === "artists" ? "artist" : "album") : groupKindFor(category);
  const groups = sortGroups(buildGroups(all, kind), sort);
  return `<div class="list">` + groups.map(groupRowHtml).join("") + `</div>`;
}

function playlistsHtml() {
  const query = view.search.trim().toLowerCase();
  let items = state.playlists.filter(playlist => !query || playlist.name.toLowerCase().includes(query));
  if (!state.playlists.length) return emptyStateHtml("playlists");

  items = currentSort() === "added"
    ? [...items].sort((a, b) => b.createdAt - a.createdAt)
    : [...items].sort((a, b) => compareText(a.name, b.name));

  return `<div class="hero-actions" style="margin: 4px 8px 8px">
      <button class="primary-button" type="button" data-action="new-playlist">${icon("plus")}Nouvelle liste</button>
    </div>` +
    (items.length
      ? `<div class="list">` + items.map(playlistRowHtml).join("") + `</div>`
      : `<p class="section-note">Aucune liste ne correspond.</p>`);
}

function artistAlbumsHtml(items) {
  const sections = new Map();
  items.forEach((track, index) => {
    const albumKey = groupKey(track, "album");
    if (!sections.has(albumKey)) sections.set(albumKey, []);
    sections.get(albumKey).push({ track, index });
  });

  return [...sections].map(([albumKey, entries]) => {
    const first = entries[0].track;
    const albumName = first.album || "Sans album";
    const coverId = entries.find(e => e.track.coverId)?.track.coverId || null;
    const duration = entries.reduce((sum, e) => sum + (e.track.duration || 0), 0);
    const meta = [first.year, plural(entries.length, "piste", "pistes"), formatLength(duration)].filter(Boolean).join(" · ");
    const heading = albumKey
      ? `<button class="album-section-link" type="button" data-open-album="${escapeHtml(albumKey)}">${escapeHtml(albumName)}</button>`
      : `<span class="album-section-link">${escapeHtml(albumName)}</span>`;

    const rows = entries.map(({ track, index }, localIdx) =>
      trackRowHtml(track, index, { number: track.track || localIdx + 1, subtitle: "" })
    ).join("");

    return `<section class="album-section">
      <div class="album-section-head">
        ${coverHtml(coverId, "music")}
        <div class="album-section-title">
          ${heading}
          <span class="album-section-meta">${escapeHtml(meta)}</span>
        </div>
      </div>
      <div class="list numbered">${rows}</div>
    </section>`;
  }).join("");
}

function detailHtml(detail) {
  let label;
  let name;
  let subtitle;
  let items;
  let coverId;
  let category;
  let actions = "";

  if (detail.kind === "playlist") {
    const playlist = state.playlists.find(item => item.id === detail.key);
    if (!playlist) return `<p class="section-note">Cette liste n’existe plus.</p>`;
    label = "Liste de lecture";
    name = playlist.name;
    items = playlist.tracks.map(id => tracks.get(id)).filter(Boolean);
    coverId = items.find(track => track.coverId)?.coverId || null;
    category = "playlist";
  } else {
    const group = findGroup(detail);
    if (!group) return `<p class="section-note">Ce contenu n’est plus dans la bibliothèque.</p>`;
    label = { album: "Album", artist: "Artiste", show: "Émission", book: "Livre audio" }[detail.kind];
    name = group.name;
    subtitle = group.subtitle;
    items = group.tracks;
    coverId = group.coverId;
    category = group.category;
  }

  listing = items.map(track => track.id);
  const duration = items.reduce((sum, track) => sum + (track.duration || 0), 0);
  const spokenGroup = detail.kind === "show" || detail.kind === "book";
  const unit = detail.kind === "show" ? ["épisode", "épisodes"] : detail.kind === "book" ? ["partie", "parties"] : ["piste", "pistes"];
  const stats = [plural(items.length, ...unit), formatLength(duration)].filter(Boolean).join(" · ");

  if (items.length) {
    if (spokenGroup) {
      const started = items.some(track => track.position > 5 || track.finished);
      actions = `<button class="primary-button" type="button" data-action="resume-group">${icon("play")}${started ? "Reprendre" : "Écouter"}</button>` +
        (started ? `<button class="secondary-button" type="button" data-action="restart-group">Depuis le début</button>` : "");
    } else {
      actions = `<button class="primary-button" type="button" data-action="play-group">${icon("play")}Lire</button>
        <button class="secondary-button" type="button" data-action="shuffle-group">${icon("shuffle")}Aléatoire</button>`;
    }
  }
  actions += `<button class="icon-button" type="button" data-action="group-menu" aria-label="Plus d’options">${icon("more")}</button>`;

  let bodyHtml;
  if (detail.kind === "artist" && items.length) {
    bodyHtml = artistAlbumsHtml(items);
  } else {
    const numbered = detail.kind === "album" || detail.kind === "book";
    const rows = items.map((track, index) => {
      if (detail.kind === "album") return trackRowHtml(track, index, { number: track.track || index + 1, subtitle: track.albumArtist && track.artist !== track.albumArtist ? track.artist : "" });
      if (detail.kind === "book") return trackRowHtml(track, index, { number: index + 1, subtitle: "" });
      if (detail.kind === "show") return trackRowHtml(track, index, { subtitle: [track.year, track.artist !== subtitle ? track.artist : ""].filter(Boolean).join(" · ") });
      if (detail.kind === "playlist") return trackRowHtml(track, index, { draggable: true });
      return trackRowHtml(track, index);
    }).join("");
    bodyHtml = `<div class="list${numbered ? " numbered" : ""}">${rows || `<p class="section-note">Cette liste est vide. Ajoutez-y des pistes avec le bouton ⋮ à côté de chacune.</p>`}</div>`;
  }

  return `<button class="back-button" type="button" data-action="back">${icon("left")}Retour</button>
    <div class="hero">
      ${coverHtml(coverId, category, "large")}
      <div class="hero-text">
        <small>${label}</small>
        <h2>${escapeHtml(name)}</h2>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
        <p>${stats || "Vide"}</p>
        <div class="hero-actions">${actions}</div>
      </div>
    </div>
    ${bodyHtml}`;
}

export function openDetail(kind, key) {
  const scroll = window.scrollY;
  view.details.push({ kind, key });
  render();
  window.scrollTo(0, 0);
  openLayer("detail", () => {
    view.details.pop();
    render();
    window.scrollTo(0, scroll);
  });
}

/* ============================================================
   MENUS ET FENÊTRES (avec role="menuitem", focus trap et iOS sync)
   ============================================================ */
export function openMenu(title, items, note = "") {
  $("menuTitle").textContent = title;
  $("menuItems").innerHTML = (note ? `<p class="section-note">${escapeHtml(note)}</p>` : "") +
    items.map((item, index) => `<button class="action-item${item.danger ? " danger" : ""}${item.current ? " current" : ""}" type="button" role="menuitem" data-index="${index}">
      ${icon(item.icon || "check")}<span>${escapeHtml(item.label)}</span>
    </button>`).join("");

  $("menuItems").onclick = async event => {
    const button = event.target.closest("[data-index]");
    if (!button) return;
    const item = items[Number(button.dataset.index)];
    if (!item) return;
    if (item.immediate) {
      item.run();
      await closeTopLayer();
    } else {
      await closeTopLayer();
      item.run();
    }
  };

  $("menuItems").onkeydown = event => {
    const menuButtons = [...$("menuItems").querySelectorAll('[role="menuitem"]')];
    if (!menuButtons.length) return;
    const idx = menuButtons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      menuButtons[(idx + 1) % menuButtons.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      menuButtons[(idx - 1 + menuButtons.length) % menuButtons.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      menuButtons[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      menuButtons[menuButtons.length - 1].focus();
    }
  };

  $("menuBackdrop").hidden = false;
  openLayer("menu", () => { $("menuBackdrop").hidden = true; }, $("menuBackdrop"));
}

export function askDialog({ title, message = "", input = null, okLabel = "Valider", danger = false }) {
  return new Promise(resolve => {
    let result = null;
    $("dialogTitle").textContent = title;
    $("dialogMessage").textContent = message;
    $("dialogMessage").hidden = !message;
    $("dialogInput").hidden = input === null;
    $("dialogInput").value = input?.value || "";
    $("dialogInput").placeholder = input?.placeholder || "";
    $("dialogOk").textContent = okLabel;
    $("dialogOk").className = danger ? "danger-button" : "primary-button";

    $("dialogForm").onsubmit = event => {
      event.preventDefault();
      result = input === null ? true : $("dialogInput").value.trim();
      closeTopLayer();
    };

    $("dialogBackdrop").hidden = false;
    openLayer(
      "dialog",
      () => {
        $("dialogBackdrop").hidden = true;
        resolve(input === null ? result === true : result);
      },
      $("dialogBackdrop"),
      input === null ? $("dialogOk") : $("dialogInput")
    );
  });
}

export function confirmDialog(title, message, okLabel, danger = true) {
  return askDialog({ title, message, okLabel, danger });
}

/* ============================================================
   AJOUT DE FICHIERS (empreinte + durée conteneur + lots bornés)
   ============================================================ */
function formatOf(file) {
  const extension = (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const format = FORMATS[extension];
  if (!format) return null;
  const probe = $("audio");
  const tests = file.type ? [file.type, ...format.tests] : format.tests;
  const playable = tests.some(type => probe.canPlayType(type) !== "");
  return { extension, type: format.type, playable };
}

function probeDuration(blob) {
  return new Promise(resolve => {
    const probe = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    let done = false;

    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probe.removeAttribute("src");
      probe.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timer = setTimeout(() => finish(0), 20000);
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => finish(Number.isFinite(probe.duration) ? probe.duration : 0));
    probe.addEventListener("error", () => finish(null));
    probe.src = url;
  });
}

function folderOf(file) {
  const parts = (file.webkitRelativePath || "").split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

export async function importFiles(fileList) {
  if (importing) return;
  const all = [...fileList];
  const files = all.filter(file => formatOf(file) || /^audio\//.test(file.type));
  const ignored = all.length - files.length;

  if (!files.length) {
    showToast(all.length ? "Aucun fichier audio reconnu dans cette sélection." : "Aucun fichier choisi.", 5000, true);
    return;
  }

  importing = true;
  $("importBackdrop").hidden = false;
  navigator.storage?.persist?.().catch(() => {});

  const forcedCategory = settings.tab === "podcast" || settings.tab === "book" ? settings.tab : null;
  const existingFingerprints = new Set([...tracks.values()].map(t => t.fingerprint).filter(Boolean));
  const legacyExisting = new Set(
    [...tracks.values()].filter(t => !t.fingerprint).map(t => t.fileName + "|" + t.size)
  );
  const added = { music: 0, podcast: 0, book: 0 };
  const duplicates = [];
  const unsupported = [];
  const failed = [];
  let quotaReached = false;
  const startedAt = Date.now();
  const BATCH_SIZE = 4;
  let processed = 0;

  async function processOne(file, index) {
    const fp = await fileFingerprint(file);
    const legacyKey = file.name + "|" + file.size;
    if (existingFingerprints.has(fp) || legacyExisting.has(legacyKey)) {
      duplicates.push(file.name);
      return;
    }

    const format = formatOf(file) || { extension: "", type: file.type, playable: true };
    if (!format.playable) { unsupported.push(file.name); return; }

    const tags = await readTags(file);
    const blob = file.slice(0, file.size, format.type);
    const duration = Number.isFinite(tags.duration) && tags.duration > 0
      ? tags.duration
      : await probeDuration(blob);
    if (duration === null) { unsupported.push(file.name); return; }

    let coverId = null;
    if (tags.picture) coverId = await storeCover(tags.picture).catch(() => null);

    const fallback = titleFromFileName(file.name);
    const category = forcedCategory || detectCategory(tags, format.extension) || "music";
    const track = {
      id: newId(),
      title: tags.title || fallback.title,
      artist: tags.artist || "",
      albumArtist: tags.albumArtist || "",
      album: tags.album || "",
      genre: cleanGenre(tags.genre),
      track: parseNumber(tags.track) || fallback.track,
      disc: parseNumber(tags.disc),
      year: (tags.year || "").slice(0, 4),
      duration,
      category,
      coverId,
      fingerprint: fp,
      fileName: file.name,
      folder: folderOf(file),
      size: file.size,
      type: format.type,
      addedAt: startedAt + index,
      playedAt: 0,
      position: 0,
      finished: false
    };

    if (existingFingerprints.has(fp)) {
      duplicates.push(file.name);
      return;
    }
    existingFingerprints.add(fp);
    await storeTrack(track, file);
    tracks.set(track.id, track);
    added[category]++;
  }

  for (let start = 0; start < files.length && !quotaReached; start += BATCH_SIZE) {
    const batch = files.slice(start, start + BATCH_SIZE);
    $("importStatus").textContent = `Fichier ${start + 1} sur ${files.length} : ${batch[0].name}`;
    $("importBar").style.width = Math.round((start / files.length) * 100) + "%";

    const results = await Promise.allSettled(
      batch.map((file, offset) => processOne(file, start + offset))
    );

    for (let j = 0; j < results.length; j++) {
      processed++;
      if (results[j].status === "rejected") {
        const error = results[j].reason;
        const file = batch[j];
        console.warn("Ajout impossible :", file.name, error);
        if (isQuotaError(error)) quotaReached = true;
        else failed.push(file.name);
      }
    }

    if (processed % 10 === 0 && !quotaReached) render();
  }

  $("importBar").style.width = "100%";
  $("importBackdrop").hidden = true;
  importing = false;
  render();

  const total = added.music + added.podcast + added.book;
  const lines = [];
  if (total) {
    const detail = Object.entries(added).filter(([, n]) => n)
      .map(([category, n]) => `${CATEGORY_NAMES[category]} : ${n}`).join(" · ");
    lines.push(`${plural(total, "fichier ajouté", "fichiers ajoutés")} (${detail}).`);
  }
  if (duplicates.length) lines.push(`${plural(duplicates.length, "fichier déjà présent", "fichiers déjà présents")}.`);
  if (unsupported.length) lines.push(`Format non lu par ce navigateur : ${unsupported.slice(0, 3).join(", ")}${unsupported.length > 3 ? "…" : ""}`);
  if (failed.length) lines.push(`Fichier illisible : ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
  if (ignored) lines.push(`${plural(ignored, "fichier ignoré", "fichiers ignorés")} (pas de l’audio).`);
  if (quotaReached) lines.push("L’espace de stockage de l’appareil est plein : l’ajout s’est arrêté.");

  const problem = quotaReached || unsupported.length > 0 || failed.length > 0;
  showToast(lines.join("\n") || "Aucun fichier ajouté.", problem ? 9000 : 5000, problem && !total);
}

export function chooseImport() {
  const isApple = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const items = [{ label: "Choisir des fichiers", icon: "file", immediate: true, run: () => $("fileInput").click() }];
  if (!isApple && "webkitdirectory" in $("folderInput")) {
    items.push({ label: "Choisir un dossier entier", icon: "folder", immediate: true, run: () => $("folderInput").click() });
  }
  const where = settings.tab === "podcast" || settings.tab === "book"
    ? `Les fichiers seront rangés dans « ${CATEGORY_NAMES[settings.tab]} ».`
    : "La rubrique est choisie d’après les informations des fichiers (Musique par défaut).";
  openMenu("Ajouter de l’audio", items, where);
}

/* ============================================================
   LECTEUR, FILE D'ATTENTE ET MENUS CONTEXTUELS
   ============================================================ */
export function openPlayer() {
  if (!currentTrack()) return;
  $("playerBackdrop").hidden = false;
  updatePlayerUi();
  openLayer("player", () => {
    $("playerBackdrop").hidden = true;
    render();
  }, $("playerBackdrop"));
}

export function openQueue() {
  renderQueue();
  $("queueBackdrop").hidden = false;
  openLayer("queue", () => { $("queueBackdrop").hidden = true; }, $("queueBackdrop"));
  $("queueList").querySelector(".current")?.scrollIntoView({ block: "center" });
}

export function sourceLabel() {
  const detail = view.details[view.details.length - 1];
  if (detail?.kind === "playlist") return state.playlists.find(item => item.id === detail.key)?.name || "Liste de lecture";
  if (detail) return findGroup(detail)?.name || "";
  if (view.search) return "Recherche";
  return CATEGORY_NAMES[settings.tab] || "";
}

export function playFromListing(index) {
  playList(listing, index, { source: sourceLabel() });
}

export function openTrackMenu(index) {
  const track = tracks.get(listing[index]);
  if (!track) return;
  const detail = view.details[view.details.length - 1];
  const items = [
    { label: "Lire ensuite", icon: "next-up", run: () => playNext([track.id]) },
    { label: "Ajouter à la file d’attente", icon: "queue", run: () => addToQueue([track.id]) },
    { label: "Ajouter à une liste de lecture", icon: "playlist", run: () => chooseTargetPlaylist([track.id]) }
  ];

  if (detail?.kind === "playlist") {
    const playlist = state.playlists.find(item => item.id === detail.key);
    if (index > 0) items.push({ label: "Monter dans la liste", icon: "up", run: () => movePlaylistTrack(playlist, index, -1) });
    if (index < playlist.tracks.length - 1) items.push({ label: "Descendre dans la liste", icon: "arrow-down", run: () => movePlaylistTrack(playlist, index, 1) });
    items.push({ label: "Retirer de cette liste", icon: "close", run: () => removePlaylistTrack(playlist, index) });
  }

  if (track.category === "music") {
    if (track.album && detail?.kind !== "album") items.push({ label: "Voir l’album", icon: "album", run: () => openDetail("album", groupKey(track, "album")) });
    if (track.artist && detail?.kind !== "artist") items.push({ label: "Voir l’artiste", icon: "person", run: () => openDetail("artist", groupKey(track, "artist")) });
  }

  if (isSpoken(track)) {
    items.push(track.finished || track.position > 5
      ? { label: "Marquer comme non écouté", icon: "close", run: () => markListened([track.id], false) }
      : { label: "Marquer comme écouté", icon: "check", run: () => markListened([track.id], true) });
  }

  items.push(
    { label: "Ranger dans une autre rubrique", icon: "move", run: () => chooseCategory([track.id]) },
    { label: "Informations", icon: "info", run: () => showTrackInfo(track) },
    { label: "Supprimer de l’appareil", icon: "trash", danger: true, run: () => deleteTracks([track.id]) }
  );
  openMenu(track.title, items);
}

export function openGroupMenu() {
  const detail = view.details[view.details.length - 1];
  if (!detail) return;
  const ids = [...listing];

  if (detail.kind === "playlist") {
    const playlist = state.playlists.find(item => item.id === detail.key);
    openMenu(playlist.name, [
      { label: "Lire ensuite", icon: "next-up", run: () => playNext(ids) },
      { label: "Ajouter à la file d’attente", icon: "queue", run: () => addToQueue(ids) },
      { label: "Renommer la liste", icon: "edit", run: () => renamePlaylist(playlist) },
      { label: "Supprimer la liste", icon: "trash", danger: true, run: () => deletePlaylist(playlist) }
    ]);
    return;
  }

  const group = findGroup(detail);
  if (!group) return;
  const items = [
    { label: "Lire ensuite", icon: "next-up", run: () => playNext(ids) },
    { label: "Ajouter à la file d’attente", icon: "queue", run: () => addToQueue(ids) },
    { label: "Ajouter à une liste de lecture", icon: "playlist", run: () => chooseTargetPlaylist(ids) }
  ];
  if (detail.kind === "show" || detail.kind === "book") {
    items.push(
      { label: "Tout marquer comme écouté", icon: "check", run: () => markListened(ids, true) },
      { label: "Tout marquer comme non écouté", icon: "close", run: () => markListened(ids, false) }
    );
  }
  items.push(
    { label: "Ranger dans une autre rubrique", icon: "move", run: () => chooseCategory(ids) },
    { label: `Supprimer ${ids.length > 1 ? `ces ${ids.length} pistes` : "cette piste"} de l’appareil`, icon: "trash", danger: true, run: () => deleteTracks(ids) }
  );
  openMenu(group.name, items);
}

function showTrackInfo(track) {
  const lines = [
    ["Titre", track.title],
    ["Artiste", track.artist],
    ["Artiste de l’album", track.albumArtist],
    ["Album", track.album],
    ["Genre", track.genre],
    ["Année", track.year],
    ["Piste", track.track ? String(track.track) + (track.disc ? ` (disque ${track.disc})` : "") : ""],
    ["Durée", formatTime(track.duration)],
    ["Rubrique", CATEGORY_NAMES[track.category]],
    ["Fichier", track.fileName],
    ["Dossier", track.folder],
    ["Taille", formatSize(track.size)]
  ].filter(([, value]) => value);
  askDialog({
    title: "Informations",
    message: lines.map(([label, value]) => `${label} : ${value}`).join("\n"),
    okLabel: "Fermer"
  });
  $("dialogMessage").style.whiteSpace = "pre-line";
  $("dialogCancel").hidden = true;
}

async function markListened(ids, finished) {
  for (const id of ids) {
    const track = tracks.get(id);
    if (!track) continue;
    track.finished = finished;
    track.position = 0;
    await saveTrack(track);
  }
  render();
}

function chooseCategory(ids) {
  const first = tracks.get(ids[0]);
  openMenu("Ranger dans…", Object.entries(CATEGORY_NAMES).map(([category, name]) => ({
    label: name,
    icon: CATEGORY_ICONS[category],
    current: first?.category === category,
    run: () => moveToCategory(ids, category)
  })));
}

async function moveToCategory(ids, category) {
  for (const id of ids) {
    const track = tracks.get(id);
    if (!track || track.category === category) continue;
    track.category = category;
    await saveTrack(track);
  }
  await closeDetailsLayers();
  render();
  updatePlayerUi();
  showToast(`${plural(ids.length, "piste rangée", "pistes rangées")} dans « ${CATEGORY_NAMES[category]} ».`);
}

async function deleteTracks(ids) {
  const ok = await confirmDialog(
    ids.length > 1 ? `Supprimer ${ids.length} pistes ?` : "Supprimer cette piste ?",
    "Les fichiers seront effacés de l’application sur cet appareil. Vos fichiers d’origine ne sont pas touchés.",
    "Supprimer"
  );
  if (!ok) return;

  const removed = new Set(ids);
  const currentId = currentTrack()?.id;
  const wasPlaying = !audio.paused;
  const changedPlaylists = state.playlists.filter(playlist => playlist.tracks.some(id => removed.has(id)));
  for (const playlist of changedPlaylists) playlist.tracks = playlist.tracks.filter(id => !removed.has(id));
  const removedBookmarks = state.bookmarks.filter(item => removed.has(item.trackId));
  state.bookmarks = state.bookmarks.filter(item => !removed.has(item.trackId));

  await transaction(["tracks", "files", "playlists", "bookmarks"], "readwrite", tx => {
    for (const id of ids) {
      tx.objectStore("tracks").delete(id);
      tx.objectStore("files").delete(id);
    }
    for (const playlist of changedPlaylists) tx.objectStore("playlists").put(playlist);
    for (const item of removedBookmarks) tx.objectStore("bookmarks").delete(item.id);
  });
  for (const id of ids) tracks.delete(id);

  const keptIndex = player.queue.slice(0, player.index).filter(id => !removed.has(id)).length;
  player.queue = player.queue.filter(id => !removed.has(id));
  if (player.original) player.original = player.original.filter(id => !removed.has(id));
  if (removed.has(currentId)) {
    unloadAudio();
    player.index = player.queue.length ? Math.min(keptIndex, player.queue.length - 1) : -1;
    if (player.index >= 0 && wasPlaying) loadCurrent({ autoplay: true });
  } else {
    player.index = player.queue.indexOf(currentId);
  }
  saveSession();

  await removeUnusedCovers();
  if (view.details.length) {
    const detail = view.details[view.details.length - 1];
    const empty = detail.kind === "playlist" ? false : !findGroup(detail);
    if (empty) await closeTopLayer();
  }
  render();
  updatePlayerUi();
  showToast(ids.length > 1 ? `${ids.length} pistes supprimées.` : "Piste supprimée.");
}

/* ============================================================
   LISTES DE LECTURE & GLISSER-DÉPOSER
   ============================================================ */
export async function createPlaylist(initialIds = []) {
  const name = await askDialog({
    title: "Nouvelle liste de lecture",
    input: { placeholder: "Nom de la liste" },
    okLabel: "Créer"
  });
  if (!name) return null;
  const playlist = { id: newId(), name, tracks: [...initialIds], createdAt: Date.now() };
  state.playlists.push(playlist);
  await putOne("playlists", playlist);
  render();
  showToast(initialIds.length ? `Liste « ${name} » créée avec ${plural(initialIds.length, "piste", "pistes")}.` : `Liste « ${name} » créée.`);
  return playlist;
}

function chooseTargetPlaylist(ids) {
  const items = [...state.playlists]
    .sort((a, b) => compareText(a.name, b.name))
    .map(playlist => ({ label: playlist.name, icon: "playlist", run: () => addToPlaylist(playlist, ids) }));
  items.unshift({ label: "Nouvelle liste…", icon: "plus", run: () => createPlaylist(ids) });
  openMenu("Ajouter à une liste", items);
}

async function addToPlaylist(playlist, ids) {
  playlist.tracks.push(...ids);
  await putOne("playlists", playlist);
  render();
  showToast(`${plural(ids.length, "piste ajoutée", "pistes ajoutées")} à « ${playlist.name} ».`);
}

async function renamePlaylist(playlist) {
  const name = await askDialog({
    title: "Renommer la liste",
    input: { value: playlist.name, placeholder: "Nom de la liste" },
    okLabel: "Renommer"
  });
  if (!name) return;
  playlist.name = name;
  await putOne("playlists", playlist);
  render();
}

async function deletePlaylist(playlist) {
  const ok = await confirmDialog(`Supprimer la liste « ${playlist.name} » ?`, "Les pistes restent dans la bibliothèque : seule la liste disparaît.", "Supprimer");
  if (!ok) return;
  state.playlists = state.playlists.filter(item => item.id !== playlist.id);
  await transaction("playlists", "readwrite", tx => { tx.objectStore("playlists").delete(playlist.id); });
  await closeDetailsLayers();
  render();
  showToast("Liste supprimée.");
}

export async function reorderPlaylistTrack(playlist, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= playlist.tracks.length || toIndex < 0 || toIndex >= playlist.tracks.length) return;
  if (fromIndex === toIndex) return;
  const [id] = playlist.tracks.splice(fromIndex, 1);
  playlist.tracks.splice(toIndex, 0, id);
  await putOne("playlists", playlist);
  render();
}

export async function movePlaylistTrack(playlist, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= playlist.tracks.length) return;
  await reorderPlaylistTrack(playlist, index, target);
  const movedHandle = $("content").querySelector(`.drag-handle[data-drag-index="${target}"]`);
  movedHandle?.focus({ preventScroll: true });
}

async function removePlaylistTrack(playlist, index) {
  playlist.tracks.splice(index, 1);
  await putOne("playlists", playlist);
  render();
}

export function bindPlaylistDrag() {
  let dragState = null;

  function clearDropIndicators() {
    $("content").querySelectorAll(".row.drop-before, .row.drop-after, .row.dragging")
      .forEach(el => el.classList.remove("drop-before", "drop-after", "dragging"));
  }

  $("content").addEventListener("pointerdown", event => {
    const handle = event.target.closest(".drag-handle");
    if (!handle) return;
    const detail = view.details[view.details.length - 1];
    if (detail?.kind !== "playlist") return;
    const playlist = state.playlists.find(p => p.id === detail.key);
    if (!playlist) return;

    event.preventDefault();
    const fromIndex = Number(handle.dataset.dragIndex);
    const row = handle.closest(".row");
    row?.classList.add("dragging");
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    dragState = { playlist, fromIndex, targetIndex: fromIndex, pointerId: event.pointerId };
  });

  $("content").addEventListener("pointermove", event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const rows = [...$("content").querySelectorAll(".row[data-index]")];
    clearDropIndicators();
    const originRow = rows.find(r => Number(r.dataset.index) === dragState.fromIndex);
    originRow?.classList.add("dragging");

    let nextTarget = dragState.fromIndex;
    for (const r of rows) {
      const idx = Number(r.dataset.index);
      const rect = r.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
        nextTarget = idx;
        r.classList.add(event.clientY < mid ? "drop-before" : "drop-after");
        break;
      }
    }
    dragState.targetIndex = nextTarget;
  });

  const finishDrag = async event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const { playlist, fromIndex, targetIndex } = dragState;
    dragState = null;
    clearDropIndicators();
    if (targetIndex !== fromIndex) {
      await reorderPlaylistTrack(playlist, fromIndex, targetIndex);
    }
  };

  $("content").addEventListener("pointerup", finishDrag);
  $("content").addEventListener("pointercancel", finishDrag);

  $("content").addEventListener("keydown", event => {
    const handle = event.target.closest(".drag-handle");
    if (!handle) return;
    const detail = view.details[view.details.length - 1];
    if (detail?.kind !== "playlist") return;
    const playlist = state.playlists.find(p => p.id === detail.key);
    if (!playlist) return;
    const idx = Number(handle.dataset.dragIndex);
    if (event.key === "ArrowUp") {
      event.preventDefault();
      movePlaylistTrack(playlist, idx, -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      movePlaylistTrack(playlist, idx, 1);
    }
  });
}

/* ============================================================
   RÉGLAGES, INSTALLATION PWA & RÉINITIALISATION
   ============================================================ */
export async function updateStorageStatus() {
  const count = tracks.size;
  const totalSize = [...tracks.values()].reduce((sum, track) => sum + (track.size || 0), 0);
  let text = `${plural(count, "fichier", "fichiers")} enregistré${count > 1 ? "s" : ""} (${formatSize(totalSize)}).`;

  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) text += ` Espace encore disponible pour l’application : environ ${formatSize(Math.max(0, estimate.quota - estimate.usage))}.`;
  } catch (_) { /* estimation indisponible */ }
  $("storageStatus").textContent = text;

  let persisted = true;
  try { persisted = await navigator.storage?.persisted?.() ?? true; } catch (_) { /* inconnu */ }
  $("persistButton").hidden = persisted || !navigator.storage?.persist;
}

export function openSettings() {
  $("speedSelect").innerHTML = SPEEDS.map(speed => `<option value="${speed}">${speed === 1 ? "1× (normale)" : speedLabel(speed)}</option>`).join("");
  $("speedSelect").value = String(settings.speed);
  applyTheme(settings.theme);
  updateStorageStatus();
  updateInstallControls();
  $("settingsBackdrop").hidden = false;
  openLayer("settings", () => { $("settingsBackdrop").hidden = true; }, $("settingsBackdrop"));
}

export function updateInstallControls() {
  const isApple = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  $("installAppButton").hidden = !deferredInstallPrompt || isStandalone;
  $("iosInstallHint").hidden = !(isApple && !isStandalone && !deferredInstallPrompt);
}

export function setupInstallHandlers() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallControls();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    updateInstallControls();
  });

  $("installAppButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } finally {
      deferredInstallPrompt = null;
      updateInstallControls();
    }
  });
}

export async function clearAll() {
  const ok = await confirmDialog(
    "Tout effacer ?",
    "Toute la bibliothèque (fichiers, listes, signets et positions d’écoute) sera effacée de cet appareil. Vos fichiers d’origine ne sont pas touchés.",
    "Tout effacer"
  );
  if (!ok) return;

  cancelSleep();
  unloadAudio();
  await clearAllStores();
  tracks.clear();
  state.playlists = [];
  state.bookmarks = [];
  knownCovers.clear();
  revokeAllCovers();
  Object.assign(player, {
    queue: [],
    index: -1,
    original: null,
    shuffle: false,
    repeat: "off",
    source: "",
    restorePosition: null
  });
  view.details = [];
  await closeAllLayers();
  saveSession();
  updateStorageStatus();
  render();
  updatePlayerUi();
  showToast("La bibliothèque a été effacée.");
}

/* ============================================================
   MISE À JOUR DE L'APPLICATION
   ============================================================ */
function offerUpdate(worker) {
  waitingWorker = worker;
  $("updateBanner").hidden = false;
}

function watchForUpdates(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") registration.update().catch(() => {});
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested) {
      updateRequested = false;
      savePosition(true);
      location.reload();
    }
  });
}

export function applyUpdate() {
  if (!waitingWorker) return;
  updateRequested = true;
  $("updateButton").disabled = true;
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function dismissUpdate() {
  $("updateBanner").hidden = true;
}

export async function registerServiceWorker() {
  const status = $("offlineStatus");
  if (!("serviceWorker" in navigator)) {
    status.textContent = "Ce navigateur ne permet pas le mode hors ligne.";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("service-worker.js");
    watchForUpdates(registration);
    await navigator.serviceWorker.ready;
    status.textContent = "Application disponible hors ligne.";
  } catch (error) {
    console.warn("Service worker non enregistré :", error);
    status.textContent = "Mode hors ligne indisponible pour le moment ; vos fichiers restent enregistrés sur cet appareil.";
  }
}

setPlayerHooks({ render, openPlayer, openMenu, askDialog });

export { getLayers, coverCacheStats, APP_VERSION };
