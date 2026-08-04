// Hand-drawn sprites. Every character on this floor is 1 char per pixel.
// Colours come from a palette map so one drawing makes a whole crew.
//
// The furniture lives in art.ts (which is DOM-free so it can be rendered to a
// PNG by tools/pixel-preview.mts); this file bakes it, plus the people.

import { ART, type Asset, type Palette, type Rows } from "./art.ts";

export type { Rows, Palette } from "./art.ts";
export { MONITOR_SCREEN, RACK_LEDS, RACK_PLATE, TRAY_PLATE, COOLER_WATER, DESK_GEOM } from "./art.ts";

/** Bake a char-grid into an offscreen canvas at 1:1 pixel scale. */
export function bake(rows: Rows, palette: Palette): HTMLCanvasElement {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const col = palette[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

const bakeAsset = (a: Asset) => bake(a.rows, a.pal);

/** every prop in art.ts, baked once at module load */
export const PROPS = Object.fromEntries(
  Object.entries(ART).map(([k, v]) => [k, bakeAsset(v)]),
) as Record<keyof typeof ART, HTMLCanvasElement>;

// ---------------------------------------------------------------- workers

// 12 x 14 bust: head clears the monitor, hands rest on the desk. The right
// hand column of every row is a shade darker so the figure has a light side
// and a dark side instead of reading as a flat sticker.
const BODY_BASE: Rows = [
  "............",
  "............",
  "..#SSSSSS#..",
  "..#SESSEq#..",
  "..#SSSSSq#..",
  "..#SSMMSq#..",
  "...SSSSSq...",
  "....NNNq....",
  "..TTTTTTdd..",
  ".TTTTTTTTdd.",
  ".TTTCCCCTdd.",
  ".KTTTTTTTdK.",
  ".KTTTTTTTdK.",
  "..TTTTTTdd..",
];

// hair styles overlay the top rows (rows 0..3)
const HAIR: Rows[] = [
  [ // 0 short
    "...HHHHHH...",
    "..HhHHHHHH..",
    "..H......H..",
    "..H......H..",
  ],
  [ // 1 long
    "...HHHHHH...",
    "..HhHHHHHH..",
    ".HHH....HHH.",
    ".HH......HH.",
  ],
  [ // 2 spiky
    ".H.HH.HH.H..",
    "..HhHHHHHH..",
    "..H......H..",
    "............",
  ],
  [ // 3 cap
    "..HHHHHHHH..",
    ".HHhHHHHHHH.",
    "..BBBBBBBB..",
    "............",
  ],
  [ // 4 bun / tied back
    "...HHHHHH.H.",
    "..HhHHHHHHH.",
    "..H......H..",
    "............",
  ],
  [ // 5 receding
    "....SSSS....",
    "...HSSSSH...",
    "..H......H..",
    "............",
  ],
  [ // 6 curls
    "..HH.HH.HH..",
    ".HHhHHHHHHH.",
    ".HH......HH.",
    "..H......H..",
  ],
];

/** hands-on-keyboard variants; index 0 rest, 1/2 typing */
const HANDS: Rows[] = [
  [".KTTTTTTTdK.", ".KTTTTTTTdK."],
  ["..TTTTTTTdd.", ".KTTTTTTTdK."],
  [".KTTTTTTTdd.", "..TTTTKKTdd."],
];

/** over-ear headphones, for the ones who mean it */
const CANS: Rows = [
  ".PPPPPPPPPP.",
  "PP........PP",
  "Pp........pP",
  "PP........PP",
];

const SKIN = ["#f3c8a0", "#e0aa7c", "#c98a5b", "#9c6239", "#71432a", "#f7d9bd"];
const SKIN_DARK = ["#d8a87e", "#c08d61", "#a86e43", "#7d4a29", "#57311d", "#dcbb9b"];
const HAIRCOL = ["#2a2233", "#4b3a2a", "#8a5a35", "#c9c2b8", "#3a4d6b", "#7b3f5e", "#1a1a22", "#d9a441"];
const SHIRT = ["#4f6bd8", "#3f8f6f", "#b8544f", "#7a5bb5", "#c2803a", "#3f7d99", "#8f4f7a", "#5c6472"];
const SHIRT_DARK = ["#3a50a8", "#2e6b52", "#8d3e3a", "#5b4189", "#94602a", "#2e5f75", "#6b3a5c", "#444a56"];
const COLLAR = ["#e6e6f0", "#242a3d", "#ffd166"];

export interface WorkerSkin {
  idle: HTMLCanvasElement;
  blink: HTMLCanvasElement;
  type1: HTMLCanvasElement;
  type2: HTMLCanvasElement;
  slump: HTMLCanvasElement;
  sleep: HTMLCanvasElement;
  sip: HTMLCanvasElement;
  hairColor: string;
  shirtColor: string;
}

function rngFrom(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

interface Pose {
  closedEyes?: boolean;
  slump?: boolean;
  /** raise the left hand to the face with a mug in it */
  sip?: boolean;
}

function compose(hairIdx: number, handIdx: number, cans: boolean, opts: Pose): Rows {
  const rows = BODY_BASE.slice();
  const hair = HAIR[hairIdx % HAIR.length];
  for (let i = 0; i < hair.length; i++) {
    const under = rows[i] ?? "............";
    let merged = "";
    for (let x = 0; x < 12; x++) {
      const o = hair[i][x] ?? ".";
      merged += o === "." ? (under[x] ?? ".") : o;
    }
    rows[i] = merged;
  }
  if (cans) {
    for (let i = 0; i < CANS.length; i++) {
      const under = rows[i + 1] ?? "............";
      let merged = "";
      for (let x = 0; x < 12; x++) {
        const o = CANS[i][x] ?? ".";
        merged += o === "." ? (under[x] ?? ".") : o;
      }
      rows[i + 1] = merged;
    }
  }
  const hands = HANDS[handIdx % HANDS.length];
  rows[11] = hands[0];
  rows[12] = hands[1];
  if (opts.closedEyes) rows[3] = "..#S-SS-q#..";
  if (opts.sip) {
    // a hand comes up past the shoulder holding something hot
    rows[7] = ".UUu.NNNq...";
    rows[8] = ".uKUTTTTTdd.";
  }
  if (opts.slump) {
    // head sinks a row into the shoulders
    rows.unshift("............");
    rows.splice(9, 1);
  }
  return rows;
}

export function makeWorkerSkin(seed: number): WorkerSkin {
  const rnd = rngFrom(seed);
  const si = Math.floor(rnd() * SKIN.length);
  const hair = HAIRCOL[Math.floor(rnd() * HAIRCOL.length)];
  const sh = Math.floor(rnd() * SHIRT.length);
  const collar = COLLAR[Math.floor(rnd() * COLLAR.length)];
  const hairIdx = Math.floor(rnd() * HAIR.length);
  const cans = rnd() < 0.35;

  const pal: Palette = {
    ".": null,
    S: SKIN[si],
    q: SKIN_DARK[si],
    E: "#20161c",
    "-": "#20161c",
    M: "#8a4a4a",
    N: SKIN[si],
    H: hair,
    h: "rgba(255,255,255,0.22)", // one lit strand, so hair isn't a flat cap
    B: "#2c2f45",
    T: SHIRT[sh],
    d: SHIRT_DARK[sh],
    C: collar,
    K: SKIN[si],
    P: "#20242f", // headphone band
    p: "#4a5266",
    U: "#dcd8cf", // the mug, in the sip pose
    u: "#a8a399",
    "#": "rgba(0,0,0,0.35)",
  };

  const mk = (h: number, c: boolean, o: Pose) => bake(compose(hairIdx, h, c, o), pal);
  return {
    idle: mk(0, cans, {}),
    blink: mk(0, cans, { closedEyes: true }),
    type1: mk(1, cans, {}),
    type2: mk(2, cans, {}),
    slump: mk(0, cans, { closedEyes: true, slump: true }),
    sleep: mk(0, cans, { closedEyes: true }),
    sip: mk(0, cans, { sip: true }),
    hairColor: hair,
    shirtColor: SHIRT[sh],
  };
}

// ------------------------------------------------------------------ boss

// 12 x 18. Long rust coat, shades on at 3am. You.
const BOSS_PAL: Palette = {
  ".": null,
  S: "#f0cbb0",
  q: "#d3ac92",
  G: "#141018",
  g: "#6de2ff",
  M: "#7a4444",
  H: "#2a2028",
  h: "rgba(255,255,255,0.18)",
  C: "#d97757",
  c: "#b4573c",
  v: "#8f4530", // the deepest fold of the coat
  W: "#f4e7dc",
  K: "#f0cbb0",
  P: "#2b2636",
  B: "#15121c",
  "#": "rgba(0,0,0,0.3)",
};

const BOSS_BODY: Rows = [
  "...HHHHHH...",
  "..HhHHHHHH..",
  "..#SSSSSS#..",
  "..#GGgGGG#..",
  "..#SSSSSq#..",
  "..#SSMMSq#..",
  "...SSSSSq...",
  "..CCCCCCcc..",
  ".CCCCWWCCcc.",
  ".CCCCWWCCcc.",
  ".KCCCWWCCcK.",
  ".KCCCCCCCcK.",
  "..CCCCCCcc..",
  "..cCCCCCcv..",
  "..CCCCCCcc..",
];

const LEGS: Rows[] = [
  ["..PP..PP....", "..PP..PP....", "..BB..BB...."], // stand
  ["..PP...PP...", "...PP..PP...", "...BB..BB..."],
  ["..PPP..PP...", "..PP....PP..", "..BB....BB.."],
  ["...PP.PP....", "...PP.PP....", "...BB.BB...."],
];

/** the coat hem swings a pixel the other way on alternate strides */
const HEM: Rows[] = [
  ["..CCCCCCcc..", "..cCCCCCcv..", "..CCCCCCcc.."],
  [".CCCCCCCcc..", "..cCCCCCcv..", "..CCCCCcc..."],
  ["..CCCCCCcc..", "..cCCCCCcv..", "..CCCCCCcc.."],
  ["..CCCCCCCc..", "..cCCCCCcv..", "...CCCCCcc.."],
];

export interface BossSkin {
  stand: HTMLCanvasElement;
  walk: HTMLCanvasElement[];
  talk: HTMLCanvasElement;
  point: HTMLCanvasElement;
}

export function makeBossSkin(): BossSkin {
  const build = (legIdx: number, opts: { talking?: boolean; pointing?: boolean } = {}) => {
    const rows = BOSS_BODY.slice();
    if (opts.talking) rows[5] = "..#SMMMMq#..";
    if (opts.pointing) rows[10] = ".KCCCWWCCccK"; // arm out, finger on your desk
    // swap the last three rows of coat for this stride's hem
    const hem = HEM[legIdx];
    rows[12] = hem[0];
    rows[13] = hem[1];
    rows[14] = hem[2];
    return bake([...rows, ...LEGS[legIdx]], BOSS_PAL);
  };
  return {
    stand: build(0),
    walk: [build(1), build(0), build(2), build(3)],
    talk: build(0, { talking: true }),
    point: build(0, { talking: true, pointing: true }),
  };
}
