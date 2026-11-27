/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import { APP_VERSION, SKIP_BACK, SKIP_FORWARD } from "./utils.js";
import {
  $, applyTheme, getAll, getAllKeys, isSpoken, knownCovers, openDatabase,
  saveSettings, saveTrack, settings, showToast, state, tracks
} from "./db.js";
import { closeDetailsLayers, closeTopLayer, getLayers, initLayers, openLayer } from "./layers.js";
import {
  audio, checkSleep, currentTrack, handleEnded, loadCurrent, moveInQueue, next,
  player, playList, previous, removeFromQueue, restoreSession, savePosition,
  saveSession, seekBy, setSeeking, setSleep, setSpeed, setupMediaSession, sleep,
  togglePlay, toggleShuffle, unlockAudio, updatePlayState, updatePlayerUi,
  updatePositionState, updateProgress, applyVolume, sleepFade, cycleRepeat,
  chooseSpeed, chooseSleep, addBookmark, jumpToBookmark, deleteBookmark,
  renderQueue, applyRate
} from "./player.js";
import {
  applyUpdate, bindPlaylistDrag, chooseImport, clearAll, coverCacheStats,
  createPlaylist, dismissUpdate, importFiles, listing, openDetail, openGroupMenu,
  openPlayer, openQueue, openSettings, openTrackMenu, playFromListing,
  registerServiceWorker, render, resumeIndex, setupInstallHandlers,
  sortContext, sourceLabel, updateStorageStatus, view
} from "./ui.js";

function bindEvents() {
  initLayers();
  setupInstallHandlers();
  bindPlaylistDrag();

  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });

  $("addButton").addEventListener("click", chooseImport);
  $("settingsButton").addEventListener("click", openSettings);
  $("fileInput").addEventListener("change", event => { importFiles(event.target.files); event.target.value = ""; });
  $("folderInput").addEventListener("change", event => { importFiles(event.target.files); event.target.value = ""; });

  const tabs = [...document.querySelectorAll(".tab")];
  async function activateTabButton(button) {
    await closeDetailsLayers();
    settings.tab = button.dataset.tab;
    view.search = "";
    $("searchInput").value = "";
    saveSettings();
    render();
    window.scrollTo(0, 0);
  }

  tabs.forEach((button, index) => {
    button.addEventListener("click", () => activateTabButton(button));
    button.addEventListener("keydown", event => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        tabs[nextIndex].focus();
        activateTabButton(tabs[nextIndex]);
      }
    });
  });

  document.querySelectorAll("#musicViews button").forEach(button => button.addEventListener("click", () => {
    settings.musicView = button.dataset.view;
    saveSettings();
    render();
  }));

  $("sortSelect").addEventListener("change", event => {
    settings.sorts[sortContext().key] = event.target.value;
    saveSettings();
    render();
  });

  let searchTimer = null;
  $("searchInput").addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { view.search = event.target.value; render(); }, 150);
  });

  $("content").addEventListener("click", event => {
    if (event.target.closest(".drag-handle")) return;
    const target = event.target;
    const action = target.closest("[data-action]")?.dataset.action;

    if (action) {
      switch (action) {
        case "import": chooseImport(); break;
        case "new-playlist": createPlaylist(); break;
        case "back": closeTopLayer(); break;
        case "play-all": playFromListing(0); break;
        case "shuffle-all": playList(listing, Math.floor(Math.random() * listing.length), { shuffle: true, source: "Musique" }); break;
        case "play-group": playFromListing(0); break;
        case "shuffle-group": playList(listing, Math.floor(Math.random() * listing.length), { shuffle: true, source: sourceLabel() }); break;
        case "resume-group": {
          const items = listing.map(id => tracks.get(id));
          playList(listing, resumeIndex(items), { source: sourceLabel() });
          break;
        }
        case "restart-group": playList(listing, 0, { source: sourceLabel(), position: 0 }); break;
        case "group-menu": openGroupMenu(); break;
      }
      return;
    }

    const albumLink = target.closest("[data-open-album]");
    if (albumLink) {
      openDetail("album", albumLink.dataset.openAlbum);
      return;
    }

    const menu = target.closest("[data-track-menu]");
    if (menu) { openTrackMenu(Number(menu.dataset.trackMenu)); return; }

    const row = target.closest(".row");
    if (!row) return;
    if (row.dataset.group !== undefined) openDetail(row.dataset.kind, row.dataset.group);
    else if (row.dataset.playlist) openDetail("playlist", row.dataset.playlist);
    else if (row.dataset.track) {
      if (row.dataset.track === currentTrack()?.id && player.loadedId === row.dataset.track) openPlayer();
      else playFromListing(Number(row.dataset.index));
    }
  });

  /* Clavier : Entrée et Espace ouvrent ou lancent une ligne .row sans faire défiler la page. */
  $("content").addEventListener("keydown", event => {
    if (event.target.classList.contains("row") && (event.key === "Enter" || event.code === "Space")) {
      event.preventDefault();
      event.target.click();
    }
  });

  // Mini-lecteur
  $("miniOpen").addEventListener("click", openPlayer);
  $("miniPlay").addEventListener("click", togglePlay);
  $("miniNext").addEventListener("click", () => (isSpoken(currentTrack()) ? seekBy(SKIP_FORWARD) : next()));

  // Lecteur en grand
  $("playerClose").addEventListener("click", () => closeTopLayer());
  $("playButton").addEventListener("click", togglePlay);
  $("prevButton").addEventListener("click", previous);
  $("nextButton").addEventListener("click", next);
  $("backButton").addEventListener("click", () => seekBy(-SKIP_BACK));
  $("forwardButton").addEventListener("click", () => seekBy(SKIP_FORWARD));
  $("shuffleButton").addEventListener("click", toggleShuffle);
  $("repeatButton").addEventListener("click", cycleRepeat);
  $("speedButton").addEventListener("click", chooseSpeed);
  $("sleepButton").addEventListener("click", chooseSleep);
  $("bookmarkButton").addEventListener("click", addBookmark);
  $("queueButton").addEventListener("click", openQueue);

  $("bookmarkList").addEventListener("click", event => {
    const jump = event.target.closest("[data-bookmark-jump]");
    const remove = event.target.closest("[data-bookmark-delete]");
    if (jump) jumpToBookmark(jump.dataset.bookmarkJump);
    if (remove) deleteBookmark(remove.dataset.bookmarkDelete);
  });

  const seekBar = $("seekBar");
  seekBar.addEventListener("input", () => { setSeeking(true); updateProgress(); });
  seekBar.addEventListener("change", () => {
    setSeeking(false);
    const track = currentTrack();
    if (!track) return;
    const ratio = Number(seekBar.value) / 1000;
    if (player.loadedId === track.id && Number.isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration;
    } else {
      player.restorePosition = null;
      loadCurrent({ autoplay: false, position: ratio * (track.duration || 0) });
    }
    updateProgress();
  });

  $("volumeBar").value = String(settings.volume);
  $("volumeBar").addEventListener("input", event => {
    settings.volume = Number(event.target.value);
    applyVolume(sleepFade());
    saveSettings();
  });

  // File d'attente
  $("queueClose").addEventListener("click", () => closeTopLayer());
  $("queueClear").addEventListener("click", () => {
    player.queue = player.queue.slice(0, player.index + 1);
    if (player.original) player.original = player.original.filter(id => player.queue.includes(id));
    saveSession();
    renderQueue();
  });
  $("queueList").addEventListener("click", event => {
    const jump = event.target.closest("[data-queue-jump]");
    const move = event.target.closest("[data-queue-move]");
    const remove = event.target.closest("[data-queue-remove]");
    if (jump) {
      player.index = Number(jump.dataset.queueJump);
      loadCurrent({ autoplay: true });
    } else if (move) {
      moveInQueue(Number(move.dataset.queueMove), Number(move.dataset.delta));
    } else if (remove) {
      removeFromQueue(Number(remove.dataset.queueRemove));
    } else return;
    renderQueue();
  });

  for (const id of ["menuBackdrop", "queueBackdrop", "settingsBackdrop", "aboutBackdrop", "dialogBackdrop", "playerBackdrop"]) {
    $(id).addEventListener("click", event => { if (event.target === $(id)) closeTopLayer(); });
  }
  $("menuClose").addEventListener("click", () => closeTopLayer());
  $("dialogCancel").addEventListener("click", () => closeTopLayer());
  $("settingsClose").addEventListener("click", () => closeTopLayer());
  $("aboutClose").addEventListener("click", () => closeTopLayer());

  // Réglages
  document.querySelectorAll("[data-theme-choice]").forEach(button => button.addEventListener("click", () => {
    applyTheme(button.dataset.themeChoice);
    saveSettings();
  }));
  $("speedSelect").addEventListener("change", event => setSpeed(Number(event.target.value)));
  $("persistButton").addEventListener("click", async () => {
    const granted = await navigator.storage.persist().catch(() => false);
    showToast(granted
      ? "C’est fait : le navigateur ne videra pas la bibliothèque de lui-même."
      : "Le navigateur a refusé pour l’instant. Installer l’application sur l’écran d’accueil aide souvent.", 6000, !granted);
    updateStorageStatus();
  });
  $("clearAllButton").addEventListener("click", clearAll);
  $("aboutButton").addEventListener("click", () => {
    $("aboutVersion").textContent = "Version " + APP_VERSION;
    $("aboutBackdrop").hidden = false;
    openLayer("about", () => { $("aboutBackdrop").hidden = true; }, $("aboutBackdrop"));
  });
  $("updateButton").addEventListener("click", applyUpdate);
  $("updateDismiss").addEventListener("click", dismissUpdate);

  new MutationObserver(() => {
    if ($("dialogBackdrop").hidden) {
      $("dialogCancel").hidden = false;
      $("dialogMessage").style.whiteSpace = "";
    }
  }).observe($("dialogBackdrop"), { attributes: true, attributeFilter: ["hidden"] });

  // Lecteur audio
  audio.addEventListener("play", updatePlayState);
  audio.addEventListener("pause", () => { updatePlayState(); savePosition(true); });
  audio.addEventListener("loadedmetadata", () => {
    if (player.silent) return;
    const track = tracks.get(player.loadedId);
    if (player.pendingSeek !== null) {
      audio.currentTime = Math.min(player.pendingSeek, Math.max(0, audio.duration - 1));
      player.pendingSeek = null;
    }
    if (track) {
      applyRate(track);
      if (Number.isFinite(audio.duration) && Math.abs(audio.duration - track.duration) > 1) {
        track.duration = audio.duration;
        saveTrack(track);
      }
    }
    updateProgress();
    updatePositionState();
  });
  audio.addEventListener("timeupdate", () => {
    if (player.silent) return;
    updateProgress();
    savePosition();
    if (sleep.endsAt) checkSleep();
  });
  audio.addEventListener("seeked", () => { savePosition(true); updatePositionState(); });
  audio.addEventListener("ratechange", updatePositionState);
  audio.addEventListener("ended", handleEnded);
  audio.addEventListener("error", () => {
    if (player.silent || !player.loadedId) return;
    const track = currentTrack();
    showToast(`Lecture impossible : « ${track?.title || "fichier"} ». Passage à la suite.`, 5000, true);
    if (player.index < player.queue.length - 1) setTimeout(next, 1200);
  });

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") savePosition(true); });
  window.addEventListener("pagehide", () => savePosition(true));

  // Raccourcis clavier (ordinateur)
  document.addEventListener("keydown", event => {
    const layers = getLayers();
    if (event.key === "Escape" && layers.length && layers[layers.length - 1].name !== "detail") {
      closeTopLayer();
      return;
    }
    const tag = event.target.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.target.isContentEditable) return;

    if (event.code === "Space" && tag !== "BUTTON" && !event.target.classList.contains("row")) {
      event.preventDefault();
      togglePlay();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "/") {
      const search = $("searchInput");
      if (search && !$("toolbar").hidden) {
        event.preventDefault();
        search.focus();
      }
    } else if (key === "m") {
      audio.muted = !audio.muted;
      showToast(audio.muted ? "Son coupé." : "Son rétabli.", 2000);
    } else if (key === "n") {
      next();
    } else if (key === "p") {
      previous();
    } else if (event.key === "ArrowLeft" && !event.target.closest('[role="tablist"]')) {
      seekBy(-5);
    } else if (event.key === "ArrowRight" && !event.target.closest('[role="tablist"]')) {
      seekBy(5);
    }
  });

  // Glisser-déposer des fichiers (ordinateur)
  let dragDepth = 0;
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", event => { if (!hasFiles(event)) return; dragDepth++; $("dropZone").hidden = false; });
  window.addEventListener("dragleave", event => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropZone").hidden = true; });
  window.addEventListener("dragover", event => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $("dropZone").hidden = true;
    importFiles(event.dataTransfer.files);
  });
}

async function start() {
  applyTheme(settings.theme);
  bindEvents();
  setupMediaSession();

  try {
    await openDatabase();
    const [savedTracks, savedPlaylists, savedBookmarks, coverIds] = await Promise.all([
      getAll("tracks"), getAll("playlists"), getAll("bookmarks"), getAllKeys("covers")
    ]);
    for (const track of savedTracks) tracks.set(track.id, track);
    state.playlists = savedPlaylists;
    state.bookmarks = savedBookmarks;
    for (const id of coverIds) knownCovers.add(id);
  } catch (error) {
    console.error(error);
    $("content").innerHTML = `<div class="empty-state"><strong>Stockage indisponible</strong>
      <p>Ce navigateur refuse d’enregistrer des fichiers (navigation privée ou stockage bloqué). Ouvrez Omni-Musique dans une fenêtre normale.</p></div>`;
    $("addButton").disabled = true;
    registerServiceWorker();
    return;
  }

  restoreSession();
  render();
  updatePlayerUi();
  registerServiceWorker();

  globalThis.__omniMusiqueDiag = {
    getLayers: () => getLayers().map(l => l.name),
    coverCacheStats,
    getSleepActive: () => Boolean(sleep.endsAt || sleep.endOfTrack),
    setSleepTest: minutes => setSleep(minutes),
    getPlayerState: () => ({ repeat: player.repeat, details: [...view.details] })
  };
}

start();
