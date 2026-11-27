/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(__dirname, "..");

function lire(rel) {
  return fs.readFileSync(path.join(RACINE, rel), "utf8");
}

function normaliserChemin(ref) {
  const propre = ref.split("#")[0].split("?")[0].trim();
  if (!propre || propre === "./" || propre === ".") return "index.html";
  return propre.replace(/^\.\//, "");
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const f = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function extractCssVars(css, selectorPattern) {
  const match = css.match(selectorPattern);
  assert.ok(match, `Bloc CSS introuvable : ${selectorPattern}`);
  const vars = {};
  for (const m of match[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

test("1. Hygiène GitHub Pages : .nojekyll présent à la racine", () => {
  assert.ok(fs.existsSync(path.join(RACINE, ".nojekyll")), ".nojekyll manquant");
});

test("2. Syntaxe JS valide (node --check) et zéro ressource externe", () => {
  const jsFiles = [
    "service-worker.js",
    ...fs.readdirSync(path.join(RACINE, "js")).filter(f => f.endsWith(".js")).map(f => path.join("js", f)),
    ...fs.readdirSync(path.join(RACINE, "tests")).filter(f => f.endsWith(".js") || f.endsWith(".mjs")).map(f => path.join("tests", f))
  ];
  for (const rel of jsFiles) {
    execFileSync(process.execPath, ["--check", path.join(RACINE, rel)], { stdio: "pipe" });
  }

  const html = lire("index.html");
  assert.ok(!/<style[\s>]/i.test(html), "Balise <style> inline interdite");
  assert.ok(!/\bstyle\s*=\s*["'][^"']*--danger/i.test(html), "Style inline danger interdit");
  assert.ok(!/<(?:link|script|img)\b[^>]*\b(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html), "Ressource externe interdite");
});

test("3. Cohérence version, APP_SHELL et fichiers sur disque", () => {
  const sw = lire("service-worker.js");
  const utils = lire(path.join("js", "utils.js"));
  const vMatch = utils.match(/APP_VERSION\s*=\s*"([^"]+)"/);
  const cMatch = sw.match(/CACHE_NAME\s*=\s*"omni-musique-v([^"]+)"/);
  assert.ok(vMatch && cMatch && vMatch[1] === cMatch[1], "APP_VERSION et CACHE_NAME doivent correspondre");

  const shellMatch = sw.match(/const\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/);
  assert.ok(shellMatch, "APP_SHELL introuvable");
  const swSet = new Set([...shellMatch[1].matchAll(/["']([^"']+)["']/g)].map(m => normaliserChemin(m[1])));

  for (const f of swSet) {
    assert.ok(fs.existsSync(path.join(RACINE, f)), `Fichier APP_SHELL manquant : ${f}`);
  }

  const refs = new Set();
  for (const m of lire("index.html").matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const u = (m[1] ?? m[2] ?? "").trim();
    if (!u || /^(#|mailto:|data:|https?:|\/\/)/i.test(u)) continue;
    refs.add(normaliserChemin(u));
  }
  for (const m of lire("style.css").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const u = m[1].trim();
    if (/^(data:|https?:|\/\/)/i.test(u)) continue;
    refs.add(normaliserChemin(u));
  }
  for (const f of fs.readdirSync(path.join(RACINE, "js")).filter(x => x.endsWith(".js"))) {
    refs.add("js/" + f);
  }
  const manifest = JSON.parse(lire("manifest.webmanifest"));
  for (const icon of manifest.icons || []) {
    if (icon.src) refs.add(normaliserChemin(icon.src));
  }

  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(RACINE, ref)), `Ressource manquante : ${ref}`);
    assert.ok(swSet.has(ref), `Ressource absente de APP_SHELL : ${ref}`);
  }
});

test("4. Contrastes WCAG 2.1 AA (>= 4,5:1) sur les 3 thèmes", () => {
  const css = lire("style.css");
  const themes = {
    clair: extractCssVars(css, /html\[data-theme="clair"\]\s*\{([\s\S]*?)\}/),
    sombre: extractCssVars(css, /html\[data-theme="sombre"\]\s*\{([\s\S]*?)\}/),
    nuit: extractCssVars(css, /html\[data-theme="nuit"\]\s*\{([\s\S]*?)\}/)
  };

  for (const [name, v] of Object.entries(themes)) {
    for (const surf of ["--bg", "--panel", "--panel-2"]) {
      const rAcc = contrastRatio(v["--accent"], v[surf]);
      const rDan = contrastRatio(v["--danger"], v[surf]);
      assert.ok(rAcc >= 4.5, `${name} --accent sur ${surf} = ${rAcc.toFixed(2)} < 4.5`);
      assert.ok(rDan >= 4.5, `${name} --danger sur ${surf} = ${rDan.toFixed(2)} < 4.5`);
    }
    const rOnAcc = contrastRatio(v["--on-accent"], v["--accent"]);
    const rOnDan = contrastRatio(v["--on-danger"], v["--danger"]);
    assert.ok(rOnAcc >= 4.5, `${name} --on-accent sur --accent = ${rOnAcc.toFixed(2)} < 4.5`);
    assert.ok(rOnDan >= 4.5, `${name} --on-danger sur --danger = ${rOnDan.toFixed(2)} < 4.5`);
  }
});

test("5. Conformité charte Omni-Système et icône Apple 180x180", () => {
  const html = lire("index.html");
  const readme = lire("README.md");
  const license = lire("LICENSE");
  for (const [nom, contenu] of [["index.html", html], ["README.md", readme], ["LICENSE", license]]) {
    assert.ok(contenu.includes("Ferrus Dantioch"), `Auteur manquant dans ${nom}`);
    assert.ok(contenu.includes("BY-NC-ND 4.0"), `Licence manquante dans ${nom}`);
    assert.ok(contenu.includes("omni-systeme.choking513@passmail.net"), `Contact manquant dans ${nom}`);
  }
  const buf = fs.readFileSync(path.join(RACINE, "icons", "apple-touch-icon.png"));
  assert.equal(buf.readUInt32BE(16), 180);
  assert.equal(buf.readUInt32BE(20), 180);
});
