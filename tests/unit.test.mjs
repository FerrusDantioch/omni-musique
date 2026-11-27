/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readTags, parseId3, parseFlac, parseOgg, parseMp4, parseRiff } from "../js/parsers.js";
import { groupKey } from "../js/utils.js";

function toSyncsafe(n) {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

function makeId3Frame(id, payloadBytes) {
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  header.writeUInt32BE(payloadBytes.length, 4);
  return Buffer.concat([header, payloadBytes]);
}

function makeId3v24Frame(id, payloadBytes) {
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  Buffer.from(toSyncsafe(payloadBytes.length)).copy(header, 4);
  return Buffer.concat([header, payloadBytes]);
}

test("parseId3 lit ID3v2.3 et ID3v2.4 avec flag unsync global (0x80)", async () => {
  const tit2Payload = Buffer.concat([Buffer.from([3]), Buffer.from("Chanson Test", "utf8")]);
  const f1 = makeId3Frame("TIT2", tit2Payload);
  const tagHeader3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...toSyncsafe(f1.length)]);
  const blob3 = new Blob([Buffer.concat([tagHeader3, f1])]);
  const tags3 = {};
  await parseId3(blob3, tags3);
  assert.equal(tags3.title, "Chanson Test");

  // ID3v2.4 avec unsync global 0x80 : 0xFF 0x00 0x41 -> 0xFF 0x41 dans un cadre UTF-8 ou latin1
  const textWithFF = Buffer.from([0x00, 0x41, 0xff, 0x00, 0x42]); // latin1 "AÿB"
  const f4 = makeId3v24Frame("TIT2", textWithFF);
  const tagHeader4 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x80, ...toSyncsafe(f4.length)]);
  const blob4 = new Blob([Buffer.concat([tagHeader4, f4])]);
  const tags4 = {};
  await parseId3(blob4, tags4);
  assert.equal(tags4.title, "A\u00ffB");
});

test("readTags applique ID3v1 sur MP3 avec genre, mais pas sur WAV/RIFF", async () => {
  const id3v1 = Buffer.alloc(128, 0);
  id3v1.write("TAG", 0, "ascii");
  id3v1.write("Vieux Titre", 3, "latin1");
  id3v1.write("Vieux Artiste", 33, "latin1");
  id3v1[127] = 17; // Rock

  const mp3Blob = new Blob([Buffer.alloc(32, 0xff), id3v1]);
  const mp3Tags = await readTags(mp3Blob);
  assert.equal(mp3Tags.title, "Vieux Titre");
  assert.equal(mp3Tags.genre, "Rock");

  // Un WAV sans titre ne doit PAS lire les 128 derniers octets comme ID3v1
  const wav = Buffer.alloc(44 + 128);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + 128, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(128, 40);
  id3v1.copy(wav, 44);
  const wavTags = await readTags(new Blob([wav]));
  assert.equal(wavTags.title, undefined);
  assert.ok(Math.abs(wavTags.duration - 128 / 16000) < 1e-6);
});

test("parseFlac extrait la durée depuis STREAMINFO", async () => {
  // fLaC + bloc 0 (last=1, length=34) avec sampleRate=44100 et totalSamples=441000 (10 s)
  const flac = Buffer.alloc(4 + 4 + 34, 0);
  flac.write("fLaC", 0, "ascii");
  flac[4] = 0x80 | 0; // last + type 0
  flac[5] = 0; flac[6] = 0; flac[7] = 34;
  // info à offset 8 : bytes 10..17 portent sampleRate (20 bits) + channels(3) + bps(5) + totalSamples(36 bits)
  const sr = 44100;
  flac[8 + 10] = (sr >>> 12) & 0xff;
  flac[8 + 11] = (sr >>> 4) & 0xff;
  flac[8 + 12] = ((sr & 0x0f) << 4);
  const samples = 441000;
  flac.writeUInt32BE(samples, 8 + 14);
  const tags = {};
  await parseFlac(new Blob([flac]), 0, tags);
  assert.equal(tags.duration, 10);
});

test("parseMp4 extrait la durée depuis moov/mvhd", async () => {
  const mvhd = Buffer.alloc(8 + 20, 0);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write("mvhd", 4, "ascii");
  mvhd[8] = 0; // version 0
  mvhd.writeUInt32BE(1000, 8 + 12); // timescale
  mvhd.writeUInt32BE(45000, 8 + 16); // duration -> 45s
  const moov = Buffer.alloc(8 + mvhd.length);
  moov.writeUInt32BE(moov.length, 0);
  moov.write("moov", 4, "ascii");
  mvhd.copy(moov, 8);
  const tags = {};
  await parseMp4(new Blob([moov]), tags, "M4A ");
  assert.equal(tags.duration, 45);
});

test("parseOgg gère proprement un en-tête tronqué sans lever d'erreur", async () => {
  const ogg = Buffer.alloc(30, 0);
  ogg.write("OggS", 0, "ascii");
  ogg[26] = 50; // table plus grande que le blob
  const tags = {};
  await parseOgg(new Blob([ogg]), tags);
  assert.deepEqual(tags, {});
});

test("groupKey('album') regroupe un album sans albumArtist même si importé en mixte fichier/dossier", () => {
  const t1 = { album: "Horizon", albumArtist: "", artist: "Synth", folder: "" };
  const t2 = { album: "Horizon", albumArtist: "", artist: "Synth", folder: "AlbumFolder" };
  const t3 = { album: "Horizon", albumArtist: "", artist: "AutreArtiste", folder: "" };
  assert.equal(groupKey(t1, "album"), groupKey(t2, "album"));
  assert.notEqual(groupKey(t1, "album"), groupKey(t3, "album"));
});
