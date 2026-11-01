/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Tests automatiques d'Omni-Musique.
   Ils ouvrent l'application dans un vrai navigateur (Chromium, piloté
   par Playwright), ajoutent de petits fichiers audio fabriqués par le
   test (des notes de musique), les écoutent, et vérifient le résultat.
   Rien n'est envoyé sur internet.

   Lancer (Playwright doit être installé) :  node tests/tester.js
   ============================================================ */
'use strict';
const { lancer, section, verifier, nouvellePage, controlesCommuns } = require('./outils.js');

/* Un fichier WAV : une note de « frequence » Hz pendant « secondes ». */
function wav(nom, frequence, secondes) {
  const taux = 8000;
  const n = taux * secondes;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(taux, 24); b.writeUInt32LE(taux * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * frequence * i / taux)), 44 + i * 2);
  return { name: nom, mimeType: 'audio/wav', buffer: b };
}

const lignes = (p) => p.$$eval('.row[data-track] .row-title', (t) => t.map((x) => x.textContent.trim()));

async function ajouter(p, fichiers) {
  await p.setInputFiles('#fileInput', fichiers);
  await p.waitForSelector('#importBackdrop[hidden]', { state: 'attached', timeout: 20000 });
  await p.waitForTimeout(500);
}

lancer('Omni-Musique', async () => {
  await controlesCommuns({ serviceWorker: 'service-worker.js' });

  const { ctx, p } = await nouvellePage();
  await p.waitForTimeout(1000);

  await section('Police incluse dans l’application', async () => {
    const ok = await p.evaluate(async () => {
      await document.fonts.load('16px "Oxanium"');
      return [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Oxanium' && f.status === 'loaded');
    });
    verifier(ok, 'police Oxanium chargée depuis l’application');
  });

  await section('Ajouter de la musique', async () => {
    await ajouter(p, [wav('La note la.wav', 440, 4), wav('Do grave.wav', 131, 3)]);
    const titres = await lignes(p);
    verifier(titres.length === 2, 'deux morceaux dans la bibliothèque', titres);
    await ajouter(p, [wav('La note la.wav', 440, 4)]);
    verifier((await lignes(p)).length === 2, 'le même fichier n’est pas ajouté deux fois');
  });

  await section('Écouter', async () => {
    await p.click('.row[data-track]');
    await p.waitForFunction(() => {
      const a = document.getElementById('audio');
      return a && !a.paused && a.currentTime > 0.3;
    }, null, { timeout: 10000 });
    verifier(true, 'le morceau se lit et avance');
    verifier(await p.isVisible('#miniPlayer'), 'le mini-lecteur apparaît');
    const duree = await p.$eval('#audio', (a) => a.duration);
    verifier(Math.abs(duree - 4) < 0.2 || Math.abs(duree - 3) < 0.2, 'la durée est juste', duree);
  });

  await section('Podcast : reprise là où on s’était arrêté', async () => {
    await p.click('[data-tab="podcast"]');
    await p.waitForTimeout(300);
    await ajouter(p, [wav('Episode 1.wav', 300, 90)]);
    // Les épisodes sont rangés par émission : on ouvre l'émission d'abord.
    const ouvrirEmission = async () => { if (await p.$('.row[data-group]')) await p.click('.row[data-group]'); await p.waitForSelector('.row[data-track]'); };
    await ouvrirEmission();
    await p.click('.row[data-track]');
    await p.waitForFunction(() => !document.getElementById('audio').paused, null, { timeout: 10000 });
    await p.$eval('#audio', (a) => { a.currentTime = 30; });
    await p.waitForTimeout(1500);
    await p.click('#playButton').catch(() => {});
    await p.$eval('#audio', (a) => a.pause());
    await p.waitForTimeout(800);
    await p.reload();
    await p.waitForTimeout(1500);
    await p.click('[data-tab="podcast"]');
    await p.waitForTimeout(500);
    await ouvrirEmission();
    const info = await p.textContent('.row[data-track] .row-time').catch(() => '');
    verifier(/Reste/.test(info), 'l’épisode affiche le temps qui reste', info);
  });

  await section('Les fichiers restent après fermeture', async () => {
    await p.click('[data-tab="music"]');
    await p.waitForTimeout(500);
    if (await p.$('[data-action="back"]')) await p.click('[data-action="back"]');
    await p.waitForTimeout(300);
    verifier((await lignes(p)).length === 2, 'les deux morceaux sont toujours là');
  });

  await ctx.close();
});
