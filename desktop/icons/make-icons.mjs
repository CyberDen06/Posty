// Dev tooling: generate Posty desktop icons (PNG + ICO) with zero dependencies.
// Run: node desktop/icons/make-icons.mjs
// Design: forest-green rounded square + mint dot, matching the web palette.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
const GREEN = [0x1d, 0x4d, 0x2b, 255];
const MINT = [0xd9, 0xec, 0xdf, 255];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const cx = size * 0.68;
  const cy = size * 0.66;
  const cr = size * 0.17;
  const inRound = (x, y) => {
    const qx = Math.min(Math.max(x, r), size - r);
    const qy = Math.min(Math.max(y, r), size - r);
    return (x - qx) ** 2 + (y - qy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= cr * cr) px.set(MINT, i);
      else if (inRound(x + 0.5, y + 0.5)) px.set(GREEN, i);
    }
  }
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    px.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png32 = draw(32);
const png128 = draw(128);
const png256 = draw(256);
fs.writeFileSync(path.join(DIR, '32x32.png'), png32);
fs.writeFileSync(path.join(DIR, '128x128.png'), png128);

// ICO container with PNG-compressed entries (Vista+).
const entries = [
  { size: 32, png: png32 },
  { size: 256, png: png256 },
];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = 6 + entries.length * 16;
const dirs = [];
for (const e of entries) {
  const d = Buffer.alloc(16);
  d[0] = e.size >= 256 ? 0 : e.size;
  d[1] = e.size >= 256 ? 0 : e.size;
  d[4] = 1;
  d.writeUInt16LE(32, 6);
  d.writeUInt32LE(e.png.length, 8);
  d.writeUInt32LE(offset, 12);
  offset += e.png.length;
  dirs.push(d);
}
fs.writeFileSync(path.join(DIR, 'icon.ico'), Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]));
console.log('icons written to', DIR);
