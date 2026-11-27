/* Omni-Musique — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

export const MAX_TAG_SIZE = 32 * 1024 * 1024;

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const utf16le = new TextDecoder("utf-16le");
const utf16be = new TextDecoder("utf-16be");

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
  "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock",
  "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
  "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
  "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
  "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
  "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40",
  "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
  "Psychadelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk",
  "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock"
];

export async function readBytes(blob, start, end) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(blob.size, end);
  if (safeEnd <= safeStart) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(safeStart, safeEnd).arrayBuffer());
}

export const ascii = (bytes, start, length) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));
export const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
export const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
export const u16le = (b, o) => b[o] + (b[o + 1] << 8);
export const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function setTag(tags, key, value) {
  if (typeof value === "string") value = value.replace(/\0/g, "").trim();
  if (value && !tags[key]) tags[key] = value;
}

function offerPicture(tags, picture) {
  if (!picture?.data || picture.data.length < 100) return;
  if (!tags.picture || (picture.type === 3 && tags.picture.type !== 3)) tags.picture = picture;
}

export async function readTags(blob) {
  const tags = {};
  try {
    const head = await readBytes(blob, 0, 12);
    let container = "unknown";

    if (ascii(head, 0, 3) === "ID3") {
      const length = await parseId3(blob, tags);
      const after = await readBytes(blob, length, length + 4);
      if (ascii(after, 0, 4) === "fLaC") {
        container = "flac";
        await parseFlac(blob, length, tags);
      } else {
        container = "mp3";
      }
    } else if (ascii(head, 0, 4) === "fLaC") {
      container = "flac";
      await parseFlac(blob, 0, tags);
    } else if (ascii(head, 0, 4) === "OggS") {
      container = "ogg";
      await parseOgg(blob, tags);
    } else if (ascii(head, 4, 4) === "ftyp") {
      container = "mp4";
      await parseMp4(blob, tags, ascii(head, 8, 4));
    } else if (ascii(head, 0, 4) === "RIFF") {
      container = "riff";
      await parseRiff(blob, tags);
    } else {
      container = "mp3";
    }

    if (container === "mp3" && (!tags.title || !tags.artist || !tags.genre) && blob.size >= 128) {
      await parseId3v1(blob, tags);
    }
  } catch (error) {
    console.warn("Étiquettes illisibles :", error);
  }
  return tags;
}

const ID3_TEXT_FRAMES = {
  TIT2: "title", TT2: "title",
  TPE1: "artist", TP1: "artist",
  TALB: "album", TAL: "album",
  TPE2: "albumArtist", TP2: "albumArtist",
  TCON: "genre", TCO: "genre",
  TRCK: "track", TRK: "track",
  TPOS: "disc", TPA: "disc",
  TYER: "year", TYE: "year", TDRC: "year"
};

export function removeUnsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[j++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeId3Text(bytes, encoding) {
  let text;
  if (encoding === 0) text = latin1.decode(bytes);
  else if (encoding === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) text = utf16be.decode(bytes.subarray(2));
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = utf16le.decode(bytes.subarray(2));
    else text = utf16le.decode(bytes);
  } else if (encoding === 2) text = utf16be.decode(bytes);
  else text = utf8.decode(bytes);
  return text.split("\0").map(part => part.trim()).find(Boolean) || "";
}

function parseId3Picture(frame, version) {
  const encoding = frame[0];
  let p;
  let mime;

  if (version === 2) {
    mime = ascii(frame, 1, 3).toUpperCase() === "PNG" ? "image/png" : "image/jpeg";
    p = 4;
  } else {
    const end = frame.indexOf(0, 1);
    if (end < 0) return null;
    mime = latin1.decode(frame.subarray(1, end));
    p = end + 1;
  }

  const type = frame[p];
  p += 1;

  if (encoding === 1 || encoding === 2) {
    while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < frame.length && frame[p] !== 0) p++;
    p += 1;
  }

  return { type, mime, data: frame.subarray(p) };
}

export async function parseId3(blob, tags) {
  const header = await readBytes(blob, 0, 10);
  if (header.length < 10) return 0;
  const version = header[3];
  const flags = header[5];
  const size = syncsafe(header, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (version < 2 || version > 4) return total;

  let data = await readBytes(blob, 10, 10 + Math.min(size, MAX_TAG_SIZE));
  if (version < 4 && (flags & 0x80)) data = removeUnsync(data);

  let pos = 0;
  if ((flags & 0x40) && version === 3 && data.length >= 4) pos = 4 + u32be(data, 0);
  else if ((flags & 0x40) && version === 4 && data.length >= 4) pos = syncsafe(data, 0);

  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;

  while (pos + headerLength <= data.length) {
    const id = ascii(data, pos, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;

    const frameSize = version === 2
      ? (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5]
      : version === 4 ? syncsafe(data, pos + 4) : u32be(data, pos + 4);
    const frameFlags = version === 2 ? 0 : data[pos + 9];
    const start = pos + headerLength;
    pos = start + frameSize;
    if (frameSize <= 0 || pos > data.length) break;

    let frame = data.subarray(start, start + frameSize);
    if (version === 4) {
      if (frameFlags & 0x0c) continue;
      if (frameFlags & 0x40) frame = frame.subarray(1);
      if (frameFlags & 0x01) frame = frame.subarray(4);
      if ((flags & 0x80) || (frameFlags & 0x02)) frame = removeUnsync(frame);
    } else if (version === 3) {
      if (frameFlags & 0xc0) continue;
      if (frameFlags & 0x20) frame = frame.subarray(1);
    }

    if (ID3_TEXT_FRAMES[id]) {
      setTag(tags, ID3_TEXT_FRAMES[id], decodeId3Text(frame.subarray(1), frame[0]));
    } else if (id === "APIC" || id === "PIC") {
      offerPicture(tags, parseId3Picture(frame, version));
    } else if (id === "PCST") {
      tags.podcast = true;
    }
  }

  return total;
}

export async function parseId3v1(blob, tags) {
  if (blob.size < 128) return;
  const b = await readBytes(blob, blob.size - 128, blob.size);
  if (b.length < 128 || ascii(b, 0, 3) !== "TAG") return;
  const text = (start, length) => latin1.decode(b.subarray(start, start + length)).replace(/\0.*$/s, "").trim();
  setTag(tags, "title", text(3, 30));
  setTag(tags, "artist", text(33, 30));
  setTag(tags, "album", text(63, 30));
  setTag(tags, "year", text(93, 4));
  if (b[125] === 0 && b[126] !== 0) setTag(tags, "track", String(b[126]));
  if (b[127] < ID3V1_GENRES.length) setTag(tags, "genre", ID3V1_GENRES[b[127]]);
}

const VORBIS_FIELDS = {
  TITLE: "title", ARTIST: "artist", ALBUM: "album",
  ALBUMARTIST: "albumArtist", "ALBUM ARTIST": "albumArtist",
  GENRE: "genre", TRACKNUMBER: "track", DISCNUMBER: "disc", DATE: "year", YEAR: "year"
};

function base64ToBytes(text) {
  const binary = atob(text.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseFlacPicture(b) {
  let p = 0;
  const type = u32be(b, p); p += 4;
  const mimeLength = u32be(b, p); p += 4;
  const mime = latin1.decode(b.subarray(p, p + mimeLength)); p += mimeLength;
  const descriptionLength = u32be(b, p); p += 4 + descriptionLength;
  p += 16;
  const dataLength = u32be(b, p); p += 4;
  return { type, mime, data: b.subarray(p, p + dataLength) };
}

function parseVorbisComment(b, offset, tags) {
  let p = offset;
  if (p + 4 > b.length) return;
  p += 4 + u32le(b, p);
  if (p + 4 > b.length) return;
  const count = u32le(b, p);
  p += 4;

  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const length = u32le(b, p);
    p += 4;
    if (p + length > b.length) break;
    const entry = utf8.decode(b.subarray(p, p + length));
    p += length;

    const equal = entry.indexOf("=");
    if (equal < 1) continue;
    const key = entry.slice(0, equal).toUpperCase();
    const value = entry.slice(equal + 1);

    if (VORBIS_FIELDS[key]) setTag(tags, VORBIS_FIELDS[key], value);
    else if (key === "METADATA_BLOCK_PICTURE") {
      try { offerPicture(tags, parseFlacPicture(base64ToBytes(value))); } catch (_) { /* image abîmée */ }
    } else if (key === "COVERART") {
      try { offerPicture(tags, { type: 3, mime: "image/jpeg", data: base64ToBytes(value) }); } catch (_) { /* image abîmée */ }
    }
  }
}

export async function parseFlac(blob, offset, tags) {
  let pos = offset + 4;
  for (let i = 0; i < 128 && pos + 4 <= blob.size; i++) {
    const header = await readBytes(blob, pos, pos + 4);
    if (header.length < 4) break;
    const last = header[0] & 0x80;
    const type = header[0] & 0x7f;
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    pos += 4;
    if (pos + length > blob.size) break;

    if (type === 0 && length >= 18) {
      const info = await readBytes(blob, pos, pos + 18);
      const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
      const totalSamples = (info[13] & 0x0f) * 2 ** 32 + u32be(info, 14);
      if (sampleRate > 0 && totalSamples > 0) tags.duration = totalSamples / sampleRate;
    } else if (type === 4 && length < MAX_TAG_SIZE) {
      parseVorbisComment(await readBytes(blob, pos, pos + length), 0, tags);
    } else if (type === 6 && length < MAX_TAG_SIZE) {
      offerPicture(tags, parseFlacPicture(await readBytes(blob, pos, pos + length)));
    }

    pos += length;
    if (last) break;
  }
}

export async function parseOgg(blob, tags) {
  let pos = 0;
  let packetIndex = 0;
  const parts = [];
  let length = 0;

  for (let page = 0; page < 4000 && pos + 27 <= blob.size; page++) {
    const header = await readBytes(blob, pos, pos + 27);
    if (header.length < 27 || ascii(header, 0, 4) !== "OggS") return;
    const segments = header[26];
    if (pos + 27 + segments > blob.size) return;
    const table = await readBytes(blob, pos + 27, pos + 27 + segments);
    const bodyLength = table.reduce((sum, lace) => sum + lace, 0);
    if (pos + 27 + segments + bodyLength > blob.size) return;
    const body = await readBytes(blob, pos + 27 + segments, pos + 27 + segments + bodyLength);
    pos += 27 + segments + bodyLength;

    let q = 0;
    for (const lace of table) {
      if (packetIndex === 1) { parts.push(body.subarray(q, q + lace)); length += lace; }
      q += lace;
      if (lace < 255) {
        if (packetIndex === 1) {
          const packet = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) { packet.set(part, offset); offset += part.length; }
          if (ascii(packet, 1, 6) === "vorbis") parseVorbisComment(packet, 7, tags);
          else if (ascii(packet, 0, 8) === "OpusTags") parseVorbisComment(packet, 8, tags);
          else if ((packet[0] & 0x7f) === 4) parseVorbisComment(packet, 4, tags);
          return;
        }
        packetIndex++;
      }
    }
    if (length > MAX_TAG_SIZE) return;
  }
}

function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerSize || p + size > end) return;
    yield { type, start: p + headerSize, end: p + size };
    p += size;
  }
}

function findBox(b, start, end, type) {
  for (const box of boxes(b, start, end)) if (box.type === type) return box;
  return null;
}

function parseMoov(b, tags) {
  const mvhd = findBox(b, 0, b.length, "mvhd");
  if (mvhd && mvhd.end - mvhd.start >= 20) {
    const version = b[mvhd.start];
    if (version === 0 && mvhd.end - mvhd.start >= 20) {
      const timescale = u32be(b, mvhd.start + 12);
      const duration = u32be(b, mvhd.start + 16);
      if (timescale > 0 && duration > 0) tags.duration = duration / timescale;
    } else if (version === 1 && mvhd.end - mvhd.start >= 32) {
      const timescale = u32be(b, mvhd.start + 20);
      const duration = u32be(b, mvhd.start + 24) * 2 ** 32 + u32be(b, mvhd.start + 28);
      if (timescale > 0 && duration > 0) tags.duration = duration / timescale;
    }
  }

  const udta = findBox(b, 0, b.length, "udta");
  const meta = (udta && findBox(b, udta.start, udta.end, "meta")) || findBox(b, 0, b.length, "meta");
  if (!meta) return;

  const metaStart = ascii(b, meta.start + 4, 4) === "hdlr" ? meta.start : meta.start + 4;
  const ilst = findBox(b, metaStart, meta.end, "ilst");
  if (!ilst) return;

  for (const item of boxes(b, ilst.start, ilst.end)) {
    const data = findBox(b, item.start, item.end, "data");
    if (!data || data.end - data.start < 8) continue;
    const kind = u32be(b, data.start) & 0xffffff;
    const value = b.subarray(data.start + 8, data.end);
    const text = () => utf8.decode(value);

    switch (item.type) {
      case "©nam": setTag(tags, "title", text()); break;
      case "©ART": setTag(tags, "artist", text()); break;
      case "aART": setTag(tags, "albumArtist", text()); break;
      case "©alb": setTag(tags, "album", text()); break;
      case "©gen": setTag(tags, "genre", text()); break;
      case "©day": setTag(tags, "year", text().slice(0, 4)); break;
      case "trkn": if (value.length >= 4) setTag(tags, "track", String((value[2] << 8) | value[3])); break;
      case "disk": if (value.length >= 4) setTag(tags, "disc", String((value[2] << 8) | value[3])); break;
      case "covr": offerPicture(tags, { type: 3, mime: kind === 14 ? "image/png" : "image/jpeg", data: value }); break;
      case "stik":
        if (value[0] === 2) tags.kind = "book";
        else if (value[0] === 21) tags.kind = "podcast";
        break;
      case "pcst": if (value[0]) tags.kind = "podcast"; break;
    }
  }
}

export async function parseMp4(blob, tags, brand) {
  if (brand === "M4B ") tags.kind = "book";

  let pos = 0;
  for (let i = 0; i < 1000 && pos + 8 <= blob.size; i++) {
    const header = await readBytes(blob, pos, pos + 16);
    if (header.length < 8) return;
    let size = u32be(header, 0);
    const type = ascii(header, 4, 4);
    let headerSize = 8;
    if (size === 1) { size = u32be(header, 8) * 2 ** 32 + u32be(header, 12); headerSize = 16; }
    else if (size === 0) size = blob.size - pos;
    if (size < headerSize || pos + size > blob.size) return;

    if (type === "moov") {
      if (size > 4 * MAX_TAG_SIZE) return;
      parseMoov(await readBytes(blob, pos + headerSize, pos + size), tags);
      return;
    }
    pos += size;
  }
}

function decodeGuess(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (_) { return latin1.decode(bytes); }
}

export async function parseRiff(blob, tags) {
  const RIFF_FIELDS = { INAM: "title", IART: "artist", IPRD: "album", IGNR: "genre", ICRD: "year", ITRK: "track", IPRT: "track" };
  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;

  for (let i = 0; i < 1000 && pos + 8 <= blob.size; i++) {
    const header = await readBytes(blob, pos, pos + 12);
    if (header.length < 8) break;
    const id = ascii(header, 0, 4);
    const size = u32le(header, 4);
    if (pos + 8 + size > blob.size) break;

    if (id === "fmt " && size >= 16) {
      const fmt = await readBytes(blob, pos + 8, pos + 24);
      if (fmt.length >= 12) byteRate = u32le(fmt, 8);
    } else if (id === "data") {
      dataSize = size;
    } else if (id === "LIST" && header.length >= 12 && ascii(header, 8, 4) === "INFO" && size < MAX_TAG_SIZE) {
      const data = await readBytes(blob, pos + 12, pos + 8 + size);
      let p = 0;
      while (p + 8 <= data.length) {
        const key = ascii(data, p, 4);
        const length = u32le(data, p + 4);
        if (p + 8 + length > data.length) break;
        if (RIFF_FIELDS[key]) setTag(tags, RIFF_FIELDS[key], decodeGuess(data.subarray(p + 8, p + 8 + length)));
        p += 8 + length + (length & 1);
      }
    } else if ((id === "id3 " || id === "ID3 ") && size < MAX_TAG_SIZE) {
      await parseId3(blob.slice(pos + 8, pos + 8 + size), tags);
    }

    pos += 8 + size + (size & 1);
  }

  if (byteRate > 0 && dataSize > 0) tags.duration = dataSize / byteRate;
}
