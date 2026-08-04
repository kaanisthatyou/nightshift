// Hand-drawn .ico files. Same char-grid trick as the sprites, written straight
// into the BMP-in-ICO container so nothing external is needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "icons");

/** 16x16 art. one char = one pixel. */
const NIGHTSHIFT = {
  palette: {
    ".": null,
    K: "#0a0c13", // background
    R: "#d97757", // boss coat
    r: "#b4573c",
    S: "#f0cbb0", // skin
    G: "#141018", // shades
    g: "#6de2ff", // shade glint
    M: "#ff3d7f", // neon
    m: "#8a4a4a", // mouth
    W: "#f4e7dc",
  },
  rows: [
    "KKKKKKKKKKKKKKKK",
    "KMMMMMMMMMMMMMMK",
    "KKKKKKKKKKKKKKKK",
    "KKKKKRRRRRRKKKKK",
    "KKKKRRRRRRRRKKKK",
    "KKKKSSSSSSSSKKKK",
    "KKKGGgGGGGGGKKKK",
    "KKKKSSSSSSSSKKKK",
    "KKKKSSSmmSSSKKKK",
    "KKKKKSSSSSSKKKKK",
    "KKKRRRRRRRRRRKKK",
    "KKRRRRWWWWRRRRKK",
    "KKRRRRWWWWRRRRKK",
    "KKRrRRRRRRRRrRKK",
    "KKRRRRRRRRRRRRKK",
    "KKKKKKKKKKKKKKKK",
  ],
};

const OMNIROUTE = {
  palette: {
    ".": null,
    K: "#0a0c13",
    C: "#35d6ff", // routes
    c: "#1d7fa0",
    G: "#6ee787", // live
    M: "#ff3d7f", // hub
    D: "#2a3047",
  },
  rows: [
    "KKKKKKKKKKKKKKKK",
    "KGKKKKKKKKKKKKGK",
    "KKCKKKKKKKKKKCKK",
    "KKKCKKKKKKKKCKKK",
    "KKKKCCKKKKCCKKKK",
    "KKKKKKCCCCKKKKKK",
    "KKGCCCMMMMCCCGKK",
    "KKKKKCMMMMCKKKKK",
    "KKGCCCMMMMCCCGKK",
    "KKKKKKCCCCKKKKKK",
    "KKKKCCKKKKCCKKKK",
    "KKKCKKKKKKKKCKKK",
    "KKCKKKKKKKKKKCKK",
    "KGKKKKKKKKKKKKGK",
    "KKDDDDDDDDDDDDKK",
    "KKKKKKKKKKKKKKKK",
  ],
};

function hex(c) {
  const h = c.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** rows -> RGBA pixel array, scaled by an integer factor */
function rasterise(art, scale) {
  const size = 16 * scale;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = art.rows[Math.floor(y / scale)][Math.floor(x / scale)] ?? ".";
      const col = art.palette[ch];
      const i = (y * size + x) * 4;
      if (!col) {
        px[i + 3] = 0;
        continue;
      }
      const [r, g, b] = hex(col);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return { size, px };
}

/** one ICO image: BITMAPINFOHEADER + bottom-up BGRA + AND mask */
function icoImage(size, px) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height counts colour + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      body[d] = px[s + 2]; // B
      body[d + 1] = px[s + 1]; // G
      body[d + 2] = px[s]; // R
      body[d + 3] = px[s + 3]; // A
    }
  }

  // AND mask: one bit per pixel, rows padded to 4 bytes
  const stride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(stride * size, 0);
  return Buffer.concat([header, body, mask]);
}

function buildIco(art, sizes = [1, 2, 3]) {
  const images = sizes.map((scale) => {
    const { size, px } = rasterise(art, scale);
    return { size, data: icoImage(size, px) };
  });

  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    dir.writeUInt8(0, e + 2); // palette
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "nightshift.ico"), buildIco(NIGHTSHIFT));
fs.writeFileSync(path.join(OUT, "omniroute.ico"), buildIco(OMNIROUTE));
console.log("wrote", path.join(OUT, "nightshift.ico"), "and omniroute.ico (16/32/48px)");
