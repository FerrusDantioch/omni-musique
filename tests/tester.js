/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

'use strict';
const zlib = require('zlib');
const { lancer, section, verifier, nouvellePage, controlesCommuns } = require('./outils.js');

/* Un fichier WAV : une note de « frequence » Hz pendant « secondes ». */
function wavBuffer(frequence, secondes) {
  const taux = 8000;
  const n = taux * secondes;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(taux, 24); b.writeUInt32LE(taux * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * frequence * i / taux)), 44 + i * 2);
  return b;
}

function wav(nom, frequence, secondes) {
  return { name: nom, mimeType: 'audio/wav', buffer: wavBuffer(frequence, secondes) };
}

function pngSample() {
  const size = 48;
  const raw = Buffer.alloc((1 + size * 3) * size, 0);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = (x * 11 + y * 5) & 255;
      raw[p + 1] = (x * 3 + y * 13) & 255;
      raw[p + 2] = (x * 7 ^ y * 17) & 255;
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* Construit un WAV portant un chunk « id3  » avec titre, artiste, album et pochette APIC. */
function wavWithTags(nom, frequence, { title, artist, album, withCover = false }) {
  const base = wavBuffer(frequence, 2);
  const frames = [];
  const addText = (id, text) => {
    if (!text) return;
    const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const h = Buffer.alloc(10);
    h.write(id, 0, 'ascii');
    h.writeUInt32BE(payload.length, 4);
    frames.push(h, payload);
  };
  addText('TIT2', title);
  addText('TPE1', artist);
  addText('TALB', album);
  if (withCover) {
    const pic = pngSample();
    const apicPayload = Buffer.concat([
      Buffer.from([0]),
      Buffer.from('image/png\0', 'ascii'),
      Buffer.from([3, 0]),
      pic
    ]);
    const h = Buffer.alloc(10);
    h.write('APIC', 0, 'ascii');
    h.writeUInt32BE(apicPayload.length, 4);
    frames.push(h, apicPayload);
  }
  const body = Buffer.concat(frames);
  const s = body.length;
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (s >>> 21) & 0x7f, (s >>> 14) & 0x7f, (s >>> 7) & 0x7f, s & 0x7f]);
  const id3 = Buffer.concat([id3Header, body]);
  const pad = id3.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunkHead = Buffer.alloc(8);
  chunkHead.write('id3 ', 0, 'ascii');
  chunkHead.writeUInt32LE(id3.length, 4);
  const full = Buffer.concat([base, chunkHead, id3, pad]);
  full.writeUInt32LE(full.length - 8, 4);
  return { name: nom, mimeType: 'audio/wav', buffer: full };
}

const lignes = (p) => p.$$eval('.row[data-track] .row-title', (t) => t.map((x) => x.textContent.trim()));

async function ajouter(p, fichiers) {
  await p.setInputFiles('#fileInput', fichiers);
  await p.waitForSelector('#importBackdrop[hidden]', { state: 'attached', timeout: 20000 });
  await p.waitForTimeout(400);
}

lancer('Omni-Musique', async () => {
  await controlesCommuns({ serviceWorker: 'service-worker.js' });

  const { ctx, p } = await nouvellePage();
  await p.waitForTimeout(1000);

  await section('Polices incluses dans l’application', async () => {
    const polices = await p.evaluate(async () => {
      await document.fonts.load('16px "Oxanium"');
      await document.fonts.load('16px "Literata"');
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
    });
    verifier(polices.includes('Oxanium'), 'police Oxanium chargée depuis l’application', polices);
    verifier(polices.includes('Literata'), 'police Literata chargée depuis l’application', polices);
  });

  await section('Import, empreinte binaire (01.wav distincts) et pochette concurrente', async () => {
    await p.evaluate(() => {
      window.__blobUrlCalls = 0;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (b) {
        if (b && b.type === 'image/jpeg') window.__blobUrlCalls++;
        return orig(b);
      };
    });

    // Deux fichiers différents portant le même nom et la même taille exacte
    await ajouter(p, [
      wavWithTags('01.wav', 440, { title: 'Piste A', artist: 'Artiste Groupe', album: 'Album Un', withCover: true }),
      wavWithTags('01.wav', 880, { title: 'Piste B', artist: 'Artiste Groupe', album: 'Album Deux', withCover: true })
    ]);
    let titres = await lignes(p);
    verifier(titres.length === 2, 'deux fichiers « 01.wav » distincts de même taille sont tous deux importés', titres);

    // Le doublon binaire exact est bien rejeté
    await ajouter(p, [
      wavWithTags('01.wav', 440, { title: 'Piste A', artist: 'Artiste Groupe', album: 'Album Un', withCover: true })
    ]);
    titres = await lignes(p);
    verifier(titres.length === 2, 'le doublon binaire exact n’est pas réajouté', titres);

    const urlCalls = await p.evaluate(() => window.__blobUrlCalls);
    verifier(urlCalls === 1, 'pochette partagée dédupliquée sans appel createObjectURL redondant', urlCalls);
  });

  await section('Vue Artiste groupée par album et navigation', async () => {
    await p.click('#musicViews button[data-view="artists"]');
    await p.waitForSelector('.row[data-group]');
    await p.click('.row[data-group]');
    await p.waitForSelector('.album-section');
    const sections = await p.$$('.album-section');
    verifier(sections.length === 2, 'la fiche Artiste regroupe ses pistes en 2 sections d’album', sections.length);
    await p.click('.album-section-link >> nth=0');
    const label = await p.textContent('.hero-text small');
    verifier(label.trim() === 'Album', 'clic sur le titre d’album ouvre la fiche Album', label);
    await p.click('[data-action="back"]');
    await p.click('[data-action="back"]');
    await p.click('#musicViews button[data-view="tracks"]');
  });

  await section('Listes de lecture : création, ajout et réordonnancement', async () => {
    await p.click('.row[data-track] [data-track-menu] >> nth=0');
    const menuRoles = await p.$$eval('#menuItems [role="menuitem"]', els => els.length);
    verifier(menuRoles > 0, 'les actions de #menuItems portent role="menuitem"', menuRoles);
    await p.click('#menuItems button:has-text("Ajouter à une liste")');
    await p.click('#menuItems button:has-text("Nouvelle liste")');
    await p.fill('#dialogInput', 'Ma Liste');
    await p.click('#dialogOk');
    await p.waitForTimeout(250);

    await p.click('.row[data-track] [data-track-menu] >> nth=1');
    await p.click('#menuItems button:has-text("Ajouter à une liste")');
    await p.click('#menuItems button:has-text("Ma Liste")');
    await p.waitForTimeout(250);

    await p.click('[data-tab="playlists"]');
    await p.click('.row[data-playlist]');
    await p.waitForSelector('.drag-handle');
    const avant = await lignes(p);
    await p.focus('.drag-handle >> nth=0');
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(300);
    const apres = await lignes(p);
    verifier(avant[0] !== apres[0] && apres[1] === avant[0], 'réordonnancement playlist par poignée clavier', { avant, apres });
    await p.click('[data-action="back"]');
    await p.click('[data-tab="music"]');
  });

  await section('Accessibilité (Espace, tablist, focus trap, cibles >= 44px, contact)', async () => {
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.focus('.row[data-track] >> nth=0');
    await p.keyboard.press('Space');
    await p.waitForFunction(() => {
      const a = document.getElementById('audio');
      return a && !a.paused && a.currentTime > 0.2;
    }, null, { timeout: 10000 });
    verifier(await p.isVisible('#miniPlayer'), 'Espace sur .row lance la lecture et affiche le mini-lecteur');
    await p.$eval('#audio', a => a.pause());

    await p.focus('[data-tab="music"]');
    await p.keyboard.press('ArrowRight');
    const selectedTab = await p.evaluate(() => document.querySelector('.tab[aria-selected="true"]')?.dataset.tab);
    verifier(selectedTab === 'podcast', 'flèche droite sur tablist passe à Podcasts', selectedTab);
    await p.keyboard.press('ArrowLeft');

    await p.click('#settingsButton');
    await p.waitForTimeout(100);
    const insideFocus = await p.evaluate(() => {
      const backdrop = document.getElementById('settingsBackdrop');
      return backdrop.contains(document.activeElement);
    });
    verifier(insideFocus, 'focus déplacé dans la feuille Réglages à l’ouverture');

    // Vérifier que Tab reste piégé dans #settingsBackdrop
    for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
    const stillInside = await p.evaluate(() => document.getElementById('settingsBackdrop').contains(document.activeElement));
    verifier(stillInside, 'focus trap maintient Tab à l’intérieur de Réglages');

    await p.click('#aboutButton');
    const aboutText = await p.textContent('#aboutBackdrop');
    verifier(aboutText.includes('omni-systeme.choking513@passmail.net'), 'contact officiel présent dans À propos');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    const restoredId = await p.evaluate(() => document.activeElement?.id);
    verifier(restoredId === 'settingsButton', 'fermeture Réglages rend le focus à #settingsButton', restoredId);

    const sizes = await p.evaluate(() => {
      const check = sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        add: check('#addButton'),
        rowMenu: check('.row .icon-button'),
        seg: check('#musicViews button')
      };
    });
    verifier(sizes.add.h >= 44 && sizes.rowMenu.w >= 44 && sizes.rowMenu.h >= 44 && sizes.seg.h >= 44, 'cibles tactiles >= 44×44 px', sizes);
  });

  await section('Podcast : reprise là où on s’était arrêté', async () => {
    await p.click('[data-tab="podcast"]');
    await p.waitForTimeout(250);
    await ajouter(p, [wav('Episode 1.wav', 300, 90)]);
    const ouvrirEmission = async () => { if (await p.$('.row[data-group]')) await p.click('.row[data-group]'); await p.waitForSelector('.row[data-track]'); };
    await ouvrirEmission();
    await p.click('.row[data-track]');
    await p.waitForFunction(() => !document.getElementById('audio').paused, null, { timeout: 10000 });
    await p.$eval('#audio', (a) => { a.currentTime = 30; });
    await p.waitForTimeout(1000);
    await p.$eval('#audio', (a) => a.pause());
    await p.waitForTimeout(500);
    await p.reload();
    await p.waitForTimeout(1000);
    await p.click('[data-tab="podcast"]');
    await p.waitForTimeout(400);
    await ouvrirEmission();
    const info = await p.textContent('.row[data-track] .row-time').catch(() => '');
    verifier(/Reste/.test(info), 'l’épisode affiche le temps qui reste', info);
  });

  await section('clearAll() stoppe la minuterie et réinitialise les couches, puis 503 hors ligne', async () => {
    await p.evaluate(() => window.__omniMusiqueDiag.setSleepTest(15));
    verifier(await p.evaluate(() => window.__omniMusiqueDiag.getSleepActive()), 'minuterie activée avant clearAll');
    await p.click('#settingsButton');
    await p.click('#clearAllButton');
    await p.click('#dialogOk');
    await p.waitForTimeout(400);
    const diag = await p.evaluate(() => ({
      sleep: window.__omniMusiqueDiag.getSleepActive(),
      layers: window.__omniMusiqueDiag.getLayers(),
      state: window.__omniMusiqueDiag.getPlayerState(),
      rows: document.querySelectorAll('.row[data-track]').length
    }));
    verifier(!diag.sleep && diag.layers.length === 0 && diag.state.repeat === 'off' && diag.rows === 0, 'clearAll réinitialise minuterie, couches et bibliothèque', diag);

    await ctx.setOffline(true);
    const p503 = await ctx.newPage();
    await p503.goto(require('./outils.js').adresse());
    const status = await p503.evaluate(async () => (await fetch('./absent-test.txt')).status);
    await p503.close();
    verifier(status === 503, 'cacheFirst renvoie HTTP 503 propre hors ligne sur asset manquant', status);
  });

  await ctx.close();
});
