"use strict";

(function () {
  try {
    var reglages = JSON.parse(localStorage.getItem("omni-musique-reglages")) || {};
    var theme = reglages.theme;
    if (["clair", "sombre", "nuit"].indexOf(theme) !== -1) {
      document.documentElement.dataset.theme = theme;
      var meta = document.getElementById("metaThemeColor");
      if (meta) {
        meta.content = { clair: "#f7f5fb", sombre: "#1a1a1a", nuit: "#14111d" }[theme];
      }
    }
  } catch (error) {
    /* Le thème sera appliqué après le chargement des réglages. */
  }
}());
