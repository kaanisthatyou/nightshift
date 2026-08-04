// Render every pixel asset to a PNG contact sheet so the art can be judged by eye
// instead of by imagination. Run:  npx tsx tools/pixel-preview.mts [outDir]
import fs from "node:fs";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { ART, type Asset } from "../web/src/pixel/art.ts";

// ------------------------------------------------------------------ colour

function parseColor(c: string): [number, number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 255];
    }
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v));
    return [p[0] | 0, p[1] | 0, p[2] | 0, Math.round((p[3] ?? 1) * 255)];
  }
  return [255, 0, 255, 255];
}

// ------------------------------------------------------------------ canvas

class Surface {
  w: number;
  h: number;
  d: Uint8ClampedArray;
  constructor(w: number, h: number, bg: string = "#00000000") {
    this.w = w;
    this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
    if (bg !== "#00000000") this.fill(0, 0, w, h, bg);
  }
  px(x: number, y: number, [r, g, b, a]: [number, number, number, number]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a === 0) return;
    const i = (y * this.w + x) * 4;
    if (a === 255) {
      this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = 255;
      return;
    }
    const k = a / 255;
    this.d[i] = this.d[i] * (1 - k) + r * k;
    this.d[i + 1] = this.d[i + 1] * (1 - k) + g * k;
    this.d[i + 2] = this.d[i + 2] * (1 - k) + b * k;
    this.d[i + 3] = Math.max(this.d[i + 3], a);
  }
  fill(x: number, y: number, w: number, h: number, col: string) {
    const c = parseColor(col);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.px(x + xx, y + yy, c);
  }
  /** blit a char-grid asset, scaled by integer `s` */
  blit(a: Asset, ox: number, oy: number, s = 1) {
    for (let y = 0; y < a.rows.length; y++) {
      const row = a.rows[y];
      for (let x = 0; x < row.length; x++) {
        const col = a.pal[row[x]];
        if (!col) continue;
        const c = parseColor(col);
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) this.px(ox + x * s + dx, oy + y * s + dy, c);
      }
    }
  }
  png() {
    return encodePNG(this.w, this.h, this.d);
  }
}

// ------------------------------------------------------------------- font

const F: Record<string, string[]> = {
  A: ["###", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."],
  C: ["###", "#..", "#..", "#..", "###"], D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: ["###", "#..", "#.#", "#.#", "###"], H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"], J: ["..#", "..#", "..#", "#.#", "###"],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"], N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: ["###", "#.#", "#.#", "#.#", "###"], P: ["###", "#.#", "###", "#..", "#.."],
  Q: ["###", "#.#", "#.#", "###", "..#"], R: ["###", "#.#", "##.", "#.#", "#.#"],
  S: ["###", "#..", "###", "..#", "###"], T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"], V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"], X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."], Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"], "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"], "7": ["###", "..#", "..#", "..#", "..#"],
  "8": ["###", "#.#", "###", "#.#", "###"], "9": ["###", "#.#", "###", "..#", "###"],
  " ": ["...", "...", "...", "...", "..."], "-": ["...", "...", "###", "...", "..."],
  ".": ["...", "...", "...", "...", ".#."], "/": ["..#", "..#", ".#.", "#..", "#.."],
  ":": ["...", ".#.", "...", ".#.", "..."], "+": ["...", ".#.", "###", ".#.", "..."],
  "x": ["...", "#.#", ".#.", "#.#", "..."],
};

function text(s: Surface, str: string, x: number, y: number, col: string, scale = 1) {
  const c = parseColor(col);
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = F[ch] ?? F[ch.toLowerCase()] ?? F[" "];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) s.px(cx + gx * scale + dx, y + gy * scale + dy, c);
      }
    }
    cx += 4 * scale;
  }
}

// ---------------------------------------------------------------- validate

const problems: string[] = [];
for (const [name, a] of Object.entries(ART)) {
  const widths = new Set(a.rows.map((r) => r.length));
  if (widths.size !== 1) {
    problems.push(`  ${name}: ragged rows -> widths ${[...widths].sort((p, q) => p - q).join(",")}`);
    a.rows.forEach((r, i) => {
      if (r.length !== a.rows[0].length) problems.push(`      row ${i} = ${r.length} (want ${a.rows[0].length})  "${r}"`);
    });
  }
  const missing = new Set<string>();
  for (const r of a.rows) for (const ch of r) if (!(ch in a.pal)) missing.add(ch);
  if (missing.size) problems.push(`  ${name}: chars with no palette entry: ${[...missing].join(" ")}`);
}
// an asset nobody draws is dead weight — say so out loud
const sceneSrc = fs.readFileSync(new URL("../web/src/pixel/scene.ts", import.meta.url), "utf8");
const unused = Object.keys(ART).filter(
  (k) => !new RegExp(`PROPS(\\.${k}\\b|\\[)|"${k}"`).test(sceneSrc),
);
if (unused.length) problems.push(`  never drawn by scene.ts: ${unused.join(", ")}`);

if (problems.length) {
  console.error("ART PROBLEMS:\n" + problems.join("\n"));
  process.exitCode = 1;
}

// ------------------------------------------------------------ contact sheet

const outDir = process.argv[2] ?? ".";
fs.mkdirSync(outDir, { recursive: true });

const SCALE = 4;
const PAD = 10;
const entries = Object.entries(ART);

// pack into columns of a fixed width
const COLS = 6;
const cellW = Math.max(...entries.map(([, a]) => a.rows[0].length)) * SCALE + PAD * 2;
const rowsOf: Array<[string, Asset][]> = [];
for (let i = 0; i < entries.length; i += COLS) rowsOf.push(entries.slice(i, i + COLS) as Array<[string, Asset]>);
const rowH = rowsOf.map((r) => Math.max(...r.map(([, a]) => a.rows.length)) * SCALE + PAD * 2 + 10);

const sheet = new Surface(cellW * COLS, rowH.reduce((a, b) => a + b, 0) + 20, "#101320");
text(sheet, "NIGHTSHIFT ASSET SHEET", 8, 6, "#ffb454", 2);
let cy = 22;
for (let r = 0; r < rowsOf.length; r++) {
  let cx = 0;
  for (const [name, a] of rowsOf[r]) {
    // checkerboard behind so transparency is visible
    for (let y = 0; y < a.rows.length * SCALE; y += 8) {
      for (let x = 0; x < a.rows[0].length * SCALE; x += 8) {
        const alt = ((x / 8 + y / 8) | 0) % 2 === 0;
        sheet.fill(cx + PAD + x, cy + PAD + y, 8, 8, alt ? "#1a1e2e" : "#161a28");
      }
    }
    sheet.blit(a, cx + PAD, cy + PAD, SCALE);
    text(sheet, `${name} ${a.rows[0].length}x${a.rows.length}`, cx + PAD, cy + PAD + a.rows.length * SCALE + 3, "#7d879e", 1);
    cx += cellW;
  }
  cy += rowH[r];
}
fs.writeFileSync(path.join(outDir, "assets.png"), sheet.png());

// ------------------------------------------------------------- room mock-up

// Mirrors the placements in scene.ts so scale/composition can be checked.
const VW = 360, VH = 240, Z = 3;
const room = new Surface(VW * Z, VH * Z, "#1b2036");
// floor + wall bands, roughly what the scene paints
room.fill(0, 58 * Z, VW * Z, (VH - 58) * Z, "#242942");
room.fill(0, 0, VW * Z, 58 * Z, "#2a3050");
room.fill(0, 50 * Z, VW * Z, 2 * Z, "#3d456e");
room.fill(0, 52 * Z, VW * Z, 6 * Z, "#1b2036");

const put = (name: string, x: number, y: number) => {
  const a = (ART as Record<string, Asset>)[name];
  if (!a) { console.warn(`room mock: no asset "${name}"`); return; }
  room.blit(a, x * Z, y * Z, Z);
};

const DESK_X = [46, 122, 198, 274];
const ROW_Y = [94, 166];
const clutter = ["books", "succulent", "papers", "mugEmpty"];
ROW_Y.forEach((dy, row) => {
  DESK_X.forEach((cx, col) => {
    put("chair", cx - 8, dy - 30);
    // the worker bust would land here: (cx-6, dy-28), 14 tall
    room.fill((cx - 6) * Z, (dy - 28) * Z, 12 * Z, 13 * Z, "rgba(255,255,255,0.10)");
    put("desk", cx - 19, dy);
    put("monitor", cx - 12, dy - 17);          // back of the desk, bottom on dy
    const c = (ART as Record<string, Asset>)[clutter[(row * 4 + col) % clutter.length]];
    put(clutter[(row * 4 + col) % clutter.length], cx - 19, -c.rows.length + dy + 1);
    put("mug", cx + 12, dy - 7);               // mid depth, bottom on dy+1
    put("keyboard", cx - 12, dy - 1);          // front edge, bottom on dy+3
    put("mouse", cx + 8, dy - 1);
  });
});
put("rack", 3, 60);
put("printer", 3, 108);
put("trash", 3, 130);
put("cooler", 344, 60);
put("filing", 338, 90);
put("boxes", 340, 118);
put("coatRack", 342, 134);
put("plant", 344, 160);
put("plant", 2, 168);
put("tray", 15, 200);
put("cat", 150, 214);
put("pizza", 170, 200);
put("bossDesk", 288, 192);
put("phone", 296, 186);
put("papers", 316, 187);
put("lamp", 334, 181);
put("clock", 115, 8);
put("corkboard", 3, 8);
put("whiteboard", 215, 6);
put("poster", 330, 6);
put("exitSign", 106, 34);
put("fireExt", 218, 34);
put("vent", 44, 40);
fs.writeFileSync(path.join(outDir, "room.png"), room.png());

console.log(`wrote ${path.join(outDir, "assets.png")} and ${path.join(outDir, "room.png")}`);
console.log(`${entries.length} assets, ${problems.length ? "WITH PROBLEMS" : "all grids rectangular"}`);
