/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

const layers = [];
const layerWaiters = [];

function focusablesIn(container) {
  if (!container) return [];
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => {
    if (el.closest("[hidden]")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function restoreFocus(previousFocus) {
  if (
    previousFocus &&
    previousFocus instanceof HTMLElement &&
    document.contains(previousFocus) &&
    !previousFocus.closest("[hidden]")
  ) {
    previousFocus.focus({ preventScroll: true });
  }
}

function topModalLayer() {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].container) return layers[i];
  }
  return null;
}

export function getLayers() {
  return layers;
}

export function initLayers() {
  if (!history.state?.omniLayer) {
    history.replaceState({ omniLayer: true, depth: 0 }, "");
  }

  window.addEventListener("popstate", event => {
    const targetDepth = event.state?.omniLayer
      ? Math.max(0, Number(event.state.depth) || 0)
      : 0;

    while (layers.length > targetDepth) {
      const layer = layers.pop();
      if (layer) {
        layer.close();
        if (layer.container) restoreFocus(layer.previousFocus);
      }
    }

    document.body.classList.toggle("no-scroll", layers.some(item => item.name !== "detail"));
    while (layerWaiters.length && layers.length <= targetDepth) {
      layerWaiters.shift()?.();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const top = topModalLayer();
    if (!top?.container) return;

    const focusables = focusablesIn(top.container);
    if (!focusables.length) {
      event.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!top.container.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function openLayer(name, close, container = null, initialFocus = null) {
  if (!history.state?.omniLayer && layers.length === 0) {
    history.replaceState({ omniLayer: true, depth: 0 }, "");
  }
  const previousFocus = container && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  layers.push({ name, close, container, previousFocus });
  history.pushState({ omniLayer: true, depth: layers.length }, "");
  document.body.classList.toggle("no-scroll", layers.some(layer => layer.name !== "detail"));

  if (container) {
    queueMicrotask(() => {
      const target = initialFocus && !initialFocus.closest("[hidden]")
        ? initialFocus
        : focusablesIn(container)[0];
      target?.focus({ preventScroll: true });
    });
  }
}

export function closeTopLayer() {
  return new Promise(resolve => {
    if (!layers.length) { resolve(); return; }
    layerWaiters.push(resolve);
    history.back();
  });
}

export async function closeDetailsLayers() {
  while (layers.length && layers[layers.length - 1].name === "detail") {
    await closeTopLayer();
  }
}

export async function closeAllLayers() {
  while (layers.length) {
    await closeTopLayer();
  }
}
