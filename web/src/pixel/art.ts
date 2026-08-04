// Every object on the floor, drawn one pixel at a time as a char grid.
// This file is deliberately free of DOM calls so tools/pixel-preview.mts can
// render the same pixels to a PNG and the art can be judged by eye.
//
// Convention: "." is always transparent. Uppercase tends to be the lit face of
// a thing, lowercase the shaded face, so a sprite reads as a solid object with
// one light source coming from the upper left.
//
// GEOMETRY CONTRACT, because every prop depends on it:
//   A desk is drawn at (cx - 19, dy). Its first four rows are the TOP FACE, so
//   dy+3 is the surface line. Anything standing on a desk is positioned so its
//   last row lands on dy+3. That is why the monitor is 18 tall and drawn at
//   dy-14, the mug is 8 tall at dy-4, and so on.

export type Rows = string[];
export type Palette = Record<string, string | null>;
export interface Asset { rows: Rows; pal: Palette }

const T = { ".": null } as Palette;

/** filled circle with a 1px rim — for anything round, where hand-typing lies */
function disc(size: number, rim: string, face: string): Rows {
  const r = size / 2;
  const rows: Rows = [];
  for (let y = 0; y < size; y++) {
    let s = "";
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - r + 0.5, y - r + 0.5);
      s += d > r ? "." : d > r - 1.05 ? rim : face;
    }
    rows.push(s);
  }
  return rows;
}

// ============================================================ 1. THE DESK
// 38x18 at (cx-19, dy). Four rows of top face you can put things on, a bright
// front lip, an apron, then one leg and one drawer pedestal with a power cable
// nobody has ever tidied. The knee hole is where the nameplate goes.

const DESK: Asset = {
  rows: [
    "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
    "tttttttttttttttttttttttttttttttttttttt",
    "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ".lLLK.....................ddddddddd...",
    ".lLLK...............c.....DDDDDDDDD...",
    ".lLLK...............c.....DDhhhhhDD...",
    ".lLLK................c....DDDDDDDDD...",
    ".lLLK................c....ddddddddd...",
    ".lLLK...............c.....DDDDDDDDD...",
    ".lLLK...............c.....DDhhhhhDD...",
    ".lLLK..............c......DDDDDDDDD...",
    ".lLLK.....................DDDDDDDDD...",
    ".KKKK.....................ddddddddd...",
    "ssssssssssssssssssssssssssssssssssssss",
  ],
  pal: {
    ...T,
    H: "#5f5580", // back edge, catching the monitor glow
    T: "#4a4166", // laminate
    t: "#413a5c",
    E: "#585077", // front lip
    e: "#332c4a",
    a: "#241f36",
    l: "#544a70", // leg, lit side
    L: "#332c4a",
    K: "#221d33",
    D: "#3c3455", // drawer faces
    d: "#241f36",
    h: "#98a0ba", // handles
    c: "#17131f", // cable
    s: "rgba(0,0,0,0.38)",
  },
};

/** the desk's own dimensions, so the scene never hardcodes them twice */
export const DESK_GEOM = { w: 38, h: 18, ox: -19, surface: 3, kneeTop: 7 };

// ---------------------------------------------------- 2. THE BOSS'S DESK
// 60x20. Twice the desk, half the work. Warmer wood, brass handles.

const BOSS_DESK: Asset = {
  rows: [
    "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
    "tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt",
    "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ".dddddddddddd..................................dddddddddddd.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".DDDDDhhhDDDD..................................DDDDDhhhDDDD.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".dddddddddddd..................................dddddddddddd.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".DDDDDhhhDDDD..................................DDDDDhhhDDDD.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".dddddddddddd..................................dddddddddddd.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".DDDDDhhhDDDD..................................DDDDDhhhDDDD.",
    ".DDDDDDDDDDDD..................................DDDDDDDDDDDD.",
    ".kkkkkkkkkkkk..................................kkkkkkkkkkkk.",
    "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
  ],
  pal: {
    ...T,
    H: "#6f5f4d",
    T: "#584a3d",
    t: "#4c4034",
    E: "#6a5b4b",
    e: "#332a23",
    D: "#463a30",
    d: "#2b231d",
    k: "#1e1815",
    h: "#b18f2c", // brass, dulled
    s: "rgba(0,0,0,0.4)",
  },
};

// ============================================================= 3. CHAIR
// 16x18 at (cx-8, dy-30). Only the headrest and the top of the mesh clear the
// monitor, which is exactly how much chair anyone ever sees in an office. Kept
// dark on purpose: it sits behind the worker and must not compete with them.

const CHAIR: Asset = {
  rows: [
    "....RRRRRRRR....",
    "..RRLLLLLLLLRR..",
    ".RRmnmnmnmnmnRR.",
    ".RRnmnmnmnmnmRR.",
    ".RRmnmnmnmnmnRR.",
    ".RRnmnmnmnmnmRR.",
    ".RRmnmnmnmnmnRR.",
    ".RRnmnmnmnmnmRR.",
    "ARRmnmnmnmnmnRRA",
    "ARRnmnmnmnmnmRRA",
    ".RRRRRRRRRRRRRR.",
    "..RRRRRRRRRRRR..",
    "....RRRRRRRR....",
    "......MMMM......",
    "......MMMM......",
    "....MMMMMMMM....",
    "...MMMMMMMMMM...",
    "...dddddddddd...",
  ],
  pal: {
    ...T,
    R: "#282e42", // frame
    L: "#343b52", // headrest, catching the ceiling
    m: "#1e2331", // mesh weave A
    n: "#191d29", // mesh weave B
    A: "#232838", // armrests
    M: "#20242f", // gas post
    d: "rgba(0,0,0,0.35)",
  },
};

// =========================================================== 4. MONITOR
// 24x18 at (cx-12, dy-14) so its foot lands on the desk surface. The screen
// cavity is flat so the scene can paint the token stream into MONITOR_SCREEN.

const MONITOR: Asset = {
  rows: [
    "mmmmmmmmmmmmmmmmmmmmmmmm",
    "MbbbbbbbbbbbbbbbbbbbbbbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbSSSSSSSSSSSSSSSSSSSSbM",
    "MbbbbbbbbbbbbbbbbbbbbgbM",
    "kkkkkkkkkkkkkkkkkkkkkkkk",
    "..........NNNN..........",
    ".........NNNNNN.........",
    "......FFFFFFFFFFFF......",
  ],
  pal: {
    ...T,
    m: "#2c3348", // top bezel edge
    M: "#12151f",
    b: "#1c2131",
    k: "#0b0d15",
    S: "#06101a", // screen, off
    g: "#6ee787", // power LED
    N: "#1a1e2c",
    F: "#232838",
  },
};

/** where the live screen goes, relative to the monitor sprite's origin */
export const MONITOR_SCREEN = { x: 2, y: 2, w: 20, h: 11 };

// ========================================================== 5. KEYBOARD
// 18x5 at (cx-12, dy-1). Sits at the front of the top face, in front of the
// monitor foot — that overlap is what sells the desk as having depth.

const KEYBOARD: Asset = {
  rows: [
    "..KKKKKKKKKKKKKK..",
    ".KyyyyyyyyyyyyyyK.",
    ".KyKyKyKyKyKyKyyK.",
    ".KKyyyyyyyyyyKKKK.",
    "..dddddddddddddd..",
  ],
  pal: { ...T, K: "#20263a", y: "#5b6482", d: "rgba(0,0,0,0.45)" },
};

// ============================================================= 6. MOUSE
const MOUSE: Asset = {
  rows: [
    "..mm..",
    ".mwwm.",
    ".mmmm.",
    ".mmmm.",
    "..dd..",
  ],
  pal: { ...T, m: "#59627f", w: "#8890ab", d: "rgba(0,0,0,0.45)" },
};

const MOUSEPAD: Asset = {
  rows: [
    ".pppppppp.",
    "pppppppppp",
    "ppqqqqqqpp",
    "pppppppppp",
    ".pppppppp.",
  ],
  pal: { ...T, p: "#2b3149", q: "#333b57" },
};

// ======================================================== 7. COFFEE MUG
// 7x8 at (…, dy-4). Full, with a handle you can actually see.

const MUG: Asset = {
  rows: [
    ".rrrr..",
    ".WccW..",
    ".WWWW..",
    ".WWWWHH",
    ".WWWW.H",
    ".WWWWHH",
    ".wwww..",
    "..ss...",
  ],
  pal: {
    ...T,
    r: "#f7f4ee",
    W: "#dcd8cf",
    w: "#a8a399",
    c: "#4a2f21", // coffee
    H: "#cfcac0",
    s: "rgba(0,0,0,0.35)",
  },
};

/** the same mug, drained, ring in the bottom. These pile up. */
const MUG_EMPTY: Asset = {
  rows: MUG.rows.map((r) => r.replace(/cc/, "kk")),
  pal: { ...MUG.pal, k: "#6b5142" },
};

/** cup and saucer — the boss does not drink from a mug */
const CUP_SAUCER: Asset = {
  rows: [
    "..rrrr..",
    "..WccW..",
    "..WWWWH.",
    "..WWWW.H",
    "..WWWWH.",
    "..wwww..",
    ".pppppp.",
    "..ssss..",
  ],
  pal: { ...MUG.pal, p: "#e8e4dc" },
};

// ============================================================ 8. PLANT
// 14x18. A monstera that has outlived four employees.

const PLANT: Asset = {
  rows: [
    ".....gLg......",
    "...gGLLLg.g...",
    "..gGGLGGgGg...",
    ".gGGgGGLGGGGg.",
    ".GLG.GGgGGLGG.",
    "gGGg..GLGGgGGg",
    ".GgG...GGG.Gg.",
    "..g..t..g..g..",
    "....ttt.......",
    "......t.......",
    ".....tt.......",
    "...pppppppp...",
    "...PPPPPPPP...",
    "...PPPPPPPP...",
    "....PPPPPP....",
    "....PPPPPP....",
    "....qqqqqq....",
    "....ssssss....",
  ],
  pal: {
    ...T,
    g: "#2b5f3c",
    G: "#4f9d5d",
    L: "#74cc82",
    t: "#3d6b3e",
    p: "#b06a41",
    P: "#8d5a3b",
    q: "#6a4028",
    s: "rgba(0,0,0,0.35)",
  },
};

/** desk-sized succulent, for the one worker who is coping */
const SUCCULENT: Asset = {
  rows: [
    "..G..G..",
    ".GLGGLG.",
    "..GLLG..",
    ".GLGGLG.",
    "..G..G..",
    ".pppppp.",
    ".PPPPPP.",
    "..ssss..",
  ],
  pal: { ...T, G: "#4f9d5d", L: "#74cc82", p: "#b06a41", P: "#8d5a3b", s: "rgba(0,0,0,0.3)" },
};

/** the debugging duck. Every floor has one and it is always the senior. */
const DUCK: Asset = {
  rows: [
    "..YY..",
    ".YbYy.",
    ".YYYyo",
    "..Yy..",
    ".YYYy.",
    "YYYYyy",
    "YYYyyy",
    ".ssss.",
  ],
  pal: { ...T, Y: "#ffd166", y: "#d9a441", b: "#20161c", o: "#e07a2f", s: "rgba(0,0,0,0.3)" },
};

/** a stack of manuals nobody has opened */
const BOOKS: Asset = {
  rows: [
    "..AAAAAAAA..",
    ".aaaaaaaaaa.",
    ".BBBBBBBBBB.",
    "bbbbbbbbbbbb",
    "CCCCCCCCCCCC",
    "cccccccccccc",
    ".ssssssssss.",
  ],
  pal: {
    ...T,
    A: "#c25a3a", a: "#8e3f28",
    B: "#3f7d99", b: "#2c5a70",
    C: "#7a5bb5", c: "#573f82",
    s: "rgba(0,0,0,0.35)",
  },
};

// ============================================== 9. THE SERVER RACK (!!!)
// 20x44 at (3,60). This is the thing that used to be an unreadable striped
// block with two loose blinking pixels beside it. It now reads as a rack:
// cable loops and a patch panel on top, eight blades with vent slots, two
// empty U's you can see straight through, a PSU, a label plate, casters.
// LED sockets are baked dark; the scene lights them from RACK_LEDS.

const RACK: Asset = {
  rows: [
    "FFFFFFFFFFFFFFFFFFee",
    "FfCcCcCcCcCcCcCcCcfe",
    "FfPpPpPpPpPpPpPpPpfe",
    "FfPPPPPPPPPPPPPPPPfe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfIIIIIIIIIIIIIIIIfe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfIIIIIIIIIIIIIIIIfe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfUUUUUUUUUUUUUUUUfe",
    "FfUvvvvvvvvvUoUoUUfe",
    "FfUvvvvvvvvvUUUUUUfe",
    "Ffuuuuuuuuuuuuuuuufe",
    "FfWWWWWWWWWWWWWWWWfe",
    "Ffwwwwwwwwwwwwwwwwfe",
    "FfLLLLLLLLLLLLLLLLfe",
    "FFFFFFFFFFFFFFFFFFee",
    ".ff..............ff.",
    ".cc..............cc.",
  ],
  pal: {
    ...T,
    F: "#4a5372", // frame, lit edge
    f: "#2a3145",
    e: "#171b28", // frame, shaded edge
    U: "#2b3348", // blade face
    u: "#181c2a", // gap between blades
    v: "#10131d", // vent slot
    o: "#0d1019", // LED socket, unlit
    I: "#080a11", // empty rack unit
    P: "#242a3c", // patch panel
    p: "#0c0f16", // RJ45 port
    C: "#2f7ac9", // cable loop
    c: "#1f1f2c", // caster
    W: "#2e3750", // PSU
    w: "#1b2130",
    L: "#7a5a24", // label plate — the scene writes on this
  },
};

/** LED sockets in RACK, sprite-local. Two per blade, eight blades. */
export const RACK_LEDS: Array<{ x: number; y: number }> = [5, 9, 13, 18, 22, 26, 31, 35]
  .flatMap((y) => [{ x: 13, y }, { x: 15, y }]);
/** the amber plate at the bottom of the rack, sprite-local */
export const RACK_PLATE = { x: 2, y: 40, w: 16, h: 1 };

// ========================================================== 10. PRINTER
// 20x16. Jams on principle.

const PRINTER: Asset = {
  rows: [
    "....tttttttttt......",
    "...tWWWWWWWWWWt.....",
    "..PPPPPPPPPPPPPPPP..",
    ".PPPPPPPPPPPPPPPPPP.",
    ".PbbbbbbbbbbbbbbbbP.",
    ".PbgabbbbbbbbbbbbbP.",
    ".PbbbbbbbbbbbbbbbbP.",
    ".PPPPPPPPPPPPPPPPPP.",
    ".PkkkkkkkkkkkkkkkkP.",
    ".PWWWWWWWWWWWWWWWWP.",
    ".PPPPPPPPPPPPPPPPPP.",
    ".PppppppppppppppppP.",
    ".PPPPPPPPPPPPPPPPPP.",
    "..pppppppppppppppp..",
    "..dddddddddddddddd..",
    "...ssssssssssssss...",
  ],
  pal: {
    ...T,
    P: "#3a4058",
    p: "#2a3044",
    b: "#1e2331",
    k: "#0c0e15", // output slot
    W: "#e6e6f0", // paper
    t: "#8892a6", // feed tray
    g: "#6ee787",
    a: "#ffb454",
    d: "#191d29",
    s: "rgba(0,0,0,0.35)",
  },
};

// ===================================================== 11. WATER COOLER
// 12x24. Bottle, two taps, drip tray. The bubbles are animated by the scene.

const COOLER: Asset = {
  rows: [
    "...NNNNNN...",
    "..bwwwwwwb..",
    ".bwwwwwwwwb.",
    ".bwWwwwwWwb.",
    ".bwwwwwwwwb.",
    ".bwwWwwwwwb.",
    ".bwwwwwwwwb.",
    "..bwwwwwwb..",
    "...NNNNNN...",
    ".CCCCCCCCCC.",
    ".CccccccccC.",
    ".CccccccccC.",
    ".CcLcccRccC.",
    ".CclcccrccC.",
    ".CccccccccC.",
    ".CccccccccC.",
    ".CgggggggcC.",
    ".CccccccccC.",
    ".CccccccccC.",
    ".CCCCCCCCCC.",
    "..dddddddd..",
    "..dddddddd..",
    "...dddddd...",
    "...ssssss...",
  ],
  pal: {
    ...T,
    b: "#3fa9c4",
    w: "#5fd0e8",
    W: "#a4ecf8",
    N: "#2f8ba3",
    C: "#b9c2d0",
    c: "#e3e9f0",
    L: "#4f8ad9",
    l: "#33619c",
    R: "#d95c5c",
    r: "#9c3c3c",
    g: "#8892a6",
    d: "#8892a6",
    s: "rgba(0,0,0,0.35)",
  },
};

/** the water in COOLER, for the bubble animation */
export const COOLER_WATER = { x: 2, y: 1, w: 8, h: 7 };

// ============================================================== 12. CAT
const CAT: Asset = {
  rows: [
    ".e..e.....",
    ".EEEE.....",
    ".EyEyE....",
    ".EEEEE....",
    ".EBBBBBBB.",
    ".BBBBBBBBt",
    ".BBBBBBB.t",
    "..p..p..t.",
  ],
  pal: { ...T, E: "#6b5f80", e: "#a08bb8", y: "#ffd166", B: "#5d5372", t: "#6b5f80", p: "#8a7ba3" },
};

const CAT_LOAF: Asset = {
  rows: [
    ".e..e.....",
    ".EEEE.....",
    ".E--E-....",
    ".EEEEEE...",
    ".EBBBBBBB.",
    ".BBBBBBBBB",
    "..BBBBBBBt",
    "...ssssss.",
  ],
  pal: { ...CAT.pal, "-": "#3d3350", s: "rgba(0,0,0,0.3)" },
};

// ============================================================ 13. PIZZA
const PIZZA: Asset = {
  rows: [
    "LLLLLLLLLLLLLLLL",
    "LllllllllllllllL",
    "LllllllllllllllL",
    "BBBBBBBBBBBBBBBB",
    "BccccccccccccccB",
    "BcrccrccrcckkkkB",
    "BccccccccccckkkB",
    "BcrccrccrccckkkB",
    "BccccccccccccccB",
    "BBBBBBBBBBBBBBBB",
    ".ssssssssssssss.",
  ],
  pal: {
    ...T,
    L: "#a8763f",
    l: "#c9915a",
    B: "#8d5a3b",
    c: "#f0c584",
    r: "#c94f3d",
    k: "#3a2418",
    s: "rgba(0,0,0,0.35)",
  },
};

// ========================================================= 14. THE TRAY
// 22x12 at (TRAY.x-11, TRAY.y-8). Wire basket with a label plate the scene
// writes IN on. Paper stacks on top are drawn live so the count stays honest.

const TRAY: Asset = {
  rows: [
    "MMMMMMMMMMMMMMMMMMMMMM",
    "MbbbbbbbbbbbbbbbbbbbbM",
    "MbMbMbMbMbMbMbMbMbMbbM",
    "MbMbMbMbMbMbMbMbMbMbbM",
    "MbMbMbMbMbMbMbMbMbMbbM",
    "MbbbbbbbbbbbbbbbbbbbbM",
    "MMMAAAAAAAAMMMMMMMMMMM",
    ".M..................M.",
    ".M..................M.",
    "MM..................MM",
    "M....................M",
    ".ssssssssssssssssssss.",
  ],
  pal: { ...T, M: "#4c5570", b: "#20263a", A: "#7a5a24", s: "rgba(0,0,0,0.35)" },
};

/** the amber plate on the tray front, sprite-local */
export const TRAY_PLATE = { x: 3, y: 6, w: 8, h: 1 };

// ============================================================ 15. CLOCK
// 18x18. Twelve ticks, four of them bold. The hands are drawn live, because
// on this floor it is always later than you think.

const CLOCK: Asset = (() => {
  const grid = disc(18, "R", "F").map((r) => r.split(""));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const x = Math.round(8.5 + Math.cos(a) * 6.2);
    const y = Math.round(8.5 + Math.sin(a) * 6.2);
    grid[y][x] = i % 3 === 0 ? "K" : "k";
  }
  // a highlight along the top left of the bezel, so it reads as glass
  for (const [x, y] of [[6, 1], [7, 1], [8, 1], [3, 3], [2, 5]] as const) grid[y][x] = "G";
  return {
    rows: grid.map((r) => r.join("")),
    pal: { ...T, R: "#454e6b", G: "#79839e", F: "#12162a", K: "#c9cee0", k: "#616b85" },
  };
})();

// ======================================================= 16. DESK LAMP
const LAMP: Asset = {
  rows: [
    "..HHHHH...",
    ".HHGGGHH..",
    ".HGGGGGH..",
    "..HHHHH...",
    ".....A....",
    "......A...",
    ".......A..",
    ".......A..",
    "........A.",
    "...BBBBBBB",
    "..BBBBBBBB",
    "..ssssssss",
  ],
  pal: { ...T, H: "#4a5266", G: "#ffd166", A: "#6b7490", B: "#39405c", s: "rgba(0,0,0,0.35)" },
};

// ========================================================= 17. RED PHONE
const PHONE: Asset = {
  rows: [
    ".HHHHHHHH...",
    "HHhhhhhhHH..",
    ".RRRRRRRR.c.",
    "RRRRRRRRRRc.",
    "RrrrrrrrrRcc",
    "RRRRRRRRRR..",
    ".dddddddd...",
  ],
  pal: { ...T, H: "#e05555", h: "#8f2f2f", R: "#c94444", r: "#a83636", c: "#7d879e", d: "rgba(0,0,0,0.35)" },
};

// ========================================================== 18. PAPERS
const PAPERS: Asset = {
  rows: [
    "..WWWWWWWW..",
    ".WWWWWWWWWW.",
    ".WkkkkkkkWW.",
    "WWWWWWWWWWWW",
    "WkkkkkkkkkWW",
    "WWWWWWWWWWWW",
    ".dddddddddd.",
  ],
  pal: { ...T, W: "#e6e6f0", k: "#9aa2b8", d: "rgba(0,0,0,0.35)" },
};

// ==================================================== 19. FILING CABINET
const FILING: Asset = {
  rows: [
    "CCCCCCCCCCCCCCCC",
    "CccccccccccccccC",
    "CcDDDDDDDDDDDDcC",
    "CcDLLLLDDDDDDDcC",
    "CcDDDDhhhhDDDDcC",
    "CcDDDDDDDDDDDDcC",
    "CccccccccccccccC",
    "CcDDDDDDDDDDDDcC",
    "CcDLLLLDDDDDDDcC",
    "CcDDDDhhhhDDDDcC",
    "CcDDDDDDDDDDDDcC",
    "CccccccccccccccC",
    "CcDDDDDDDDDDDDcC",
    "CcDLLLLDDDDDDDcC",
    "CcDDDDhhhhDDDDcC",
    "CcDDDDDDDDDDDDcC",
    "CccccccccccccccC",
    "CcDDDDDDDDDDDDcC",
    "CcDLLLLDDDDDDDcC",
    "CcDDDDhhhhDDDDcC",
    "CcDDDDDDDDDDDDcC",
    "CCCCCCCCCCCCCCCC",
    ".kk..........kk.",
    ".ssssssssssssss.",
  ],
  pal: { ...T, C: "#454e6b", c: "#2e344a", D: "#39405c", L: "#c9cee0", h: "#8b93ad", k: "#1b1f2c", s: "rgba(0,0,0,0.35)" },
};

// =========================================================== 20. BOXES
const BOXES: Asset = {
  rows: [
    "...BBBBBBBBB....",
    "..BbbbbTbbbbB...",
    "..BbbbbTbbbbB...",
    "..BBBBBTBBBBB...",
    ".BBBBBBBBBBBBBB.",
    ".BbbbbbbTbbbbbB.",
    ".BbbbbbbTbbbbbB.",
    ".BbbbbbbTbbbbbB.",
    ".BBBBBBBTBBBBBB.",
    ".BbbbbbbbbbbbbB.",
    ".BBBBBBBBBBBBBB.",
    ".ssssssssssssss.",
  ],
  pal: { ...T, B: "#9a6f45", b: "#7d5936", T: "#c9b48a", s: "rgba(0,0,0,0.35)" },
};

// ============================================================ 21. TRASH
const TRASH: Asset = {
  rows: [
    "...WW.....",
    "..WWWW.W..",
    ".W.WW.WWW.",
    "TTTTTTTTTT",
    "TttttttttT",
    ".TtTtTtTt.",
    ".TtTtTtTt.",
    ".TtTtTtTt.",
    "..TtTtTt..",
    "..TTTTTT..",
    "..ssssss..",
  ],
  pal: { ...T, T: "#4a5266", t: "#2b3149", W: "#e6e6f0", s: "rgba(0,0,0,0.35)" },
};

// ======================================================= 22. WHITEBOARD
// 34x24. A burndown chart that has stopped burning down.

const WHITEBOARD: Asset = {
  rows: [
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    "FwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwbbbbbbwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwAwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwAwrwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwAwwrrwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwAwwwwrwwwwwwwwwwwwwwwwrrrrwwwwwF",
    "FwAwwwwwrrwwwwwwwwwwwwwrwwwwrwwwwF",
    "FwAwwwwwwwrrwwwwwwwwwwwrwwwwrwwwwF",
    "FwAwwwwwwwwwrwwwwwwwwwwrwwwwrwwwwF",
    "FwAwwwwwwwwwwrrrrwwwwwwrrrrrrwwwwF",
    "FwAwwwwwwwwwwwwwwrwwwwwwwwwwwwwwwF",
    "FwAwwwwwwwwwwwwwwwrrrrrrrrrrwwwwwF",
    "FwAwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwAAAAAAAAAAAAAAAAAAAAAAAAwwwwwwwF",
    "FwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwwbbbwwwbbbbwwwbbwwwwwbbbbbwwwwwF",
    "FwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FwwbbbbbbwwwbbbwwwwbbbbbbbbwwwwwwF",
    "FwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwF",
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    ".TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT.",
    "..RR...GG.................BB......",
  ],
  pal: {
    ...T,
    F: "#3a4058", w: "#d8dbe4", b: "#7d879e", A: "#3c4560",
    r: "#d95c5c", T: "#4a5266", R: "#d95c5c", G: "#6ee787", B: "#4f8ad9",
  },
};

// ====================================================== 23. NOTICE BOARD
const CORKBOARD: Asset = {
  rows: [
    "FFFFFFFFFFFFFFFFFFFFFFFF",
    "FccccccccccccccccccccccF",
    "FcYYYYYYcccccWWWWWWWWccF",
    "FcYYYYYYcccccWWWWWWWWccF",
    "FcYYYYYYcccccWkkkkkkWccF",
    "FcYYYYYYcccccWWWWWWWWccF",
    "FcYYYYYYcccccWkkkkkWWccF",
    "FccpccccccccccWWWWWWWccF",
    "FccccccccccccccccpccccpF",
    "FcccWWWWWWWccccccccccccF",
    "FcccWkkkkkWcccGGGGGGGccF",
    "FcccWWWWWWWcccGGGGGGGccF",
    "FcccWkkkWWWcccGkkkkkGccF",
    "FcccWWWWWWWcccGGGGGGGccF",
    "FccccpcccccccccccpcccccF",
    "FccccccccccccccccccccccF",
    "FFFFFFFFFFFFFFFFFFFFFFFF",
  ],
  pal: { ...T, F: "#4a3a2a", c: "#8a6a45", Y: "#e8d06a", W: "#e6e6f0", G: "#8fd9a0", k: "#6b7490", p: "#d95c5c" },
};

// =========================================================== 24. POSTER
// 22x24. A sun setting behind two mountains, which is the closest this
// office gets to going outside.

const POSTER: Asset = {
  rows: [
    "FFFFFFFFFFFFFFFFFFFFFF",
    "FmmmmmmmmmmmmmmmmmmmmF",
    "FmssssssssssssssssssmF",
    "FmssssssssssssssssssmF",
    "FmsssssssOOOOsssssssmF",
    "FmssssssOOOOOOssssssmF",
    "FmoooooOOOOOOOOooooomF",
    "FmoooooOOOOOOOOooooomF",
    "FmooooooOOOOOOoooooomF",
    "FmuuuuuuuOOOOuuuuuuumF",
    "FmuuuuuuuuuuuuuuuuuumF",
    "FmuuuuuuuuuKuuuuuuuumF",
    "FmuuuuuuuuKKKuuuuuuumF",
    "FmuuuuKuuKKKKKuuuuuumF",
    "FmuuuKKKKKKkKKKKuuuumF",
    "FmuuKKKKKKkkkKKKKKuumF",
    "FmuKKKKKKKkkkkkKKKKKmF",
    "FmKKKKKKKKkkkkkkKKKKmF",
    "FmmmmmmmmmmmmmmmmmmmmF",
    "FmmAAAAAAAAAAAAAAAAmmF",
    "FmmmmmmmmmmmmmmmmmmmmF",
    "FmmmmaaaaaaaaaaaammmmF",
    "FmmmmmmmmmmmmmmmmmmmmF",
    "FFFFFFFFFFFFFFFFFFFFFF",
  ],
  pal: {
    ...T,
    F: "#3a2f4e",
    m: "#e8e2d0", // mat
    s: "#8e5a86", // high sky
    o: "#e08a5a", // sky at the sun line
    O: "#ffe6a8", // sun
    u: "#c25a4a", // low sky
    K: "#3a2a44", // mountain
    k: "#6b4a6b", // the lit face of the near ridge
    A: "#c25a3a", // headline bar
    a: "#8a7ba3", // subtitle bar
  },
};

// ========================================================= 28. COAT RACK
const COAT_RACK: Asset = {
  rows: [
    "..k..kk..k..",
    "...kkkkkk...",
    ".....kk.....",
    "..CC.kk.DD..",
    ".CCCCkkDDDD.",
    ".CCCCkkDDDD.",
    ".CCCCkkDDDD.",
    ".CCCCkkDDDD.",
    "..CCCkkDDD..",
    "..CCCkkDDD..",
    "...C.kk.D...",
    ".....kk.....",
    ".....kk.....",
    ".....kk.....",
    "....kkkk....",
    "..kk....kk..",
    ".kk......kk.",
    "..ssssssss..",
  ],
  pal: { ...T, k: "#4a5266", C: "#3f5a8a", D: "#6b4a4a", s: "rgba(0,0,0,0.35)" },
};

// ====================================================== 29. WALL DETAILS
const VENT: Asset = {
  rows: [
    "FFFFFFFFFFFFFF",
    "FvvvvvvvvvvvvF",
    "FFFFFFFFFFFFFF",
    "FvvvvvvvvvvvvF",
    "FFFFFFFFFFFFFF",
    "FvvvvvvvvvvvvF",
    "FFFFFFFFFFFFFF",
  ],
  pal: { ...T, F: "#39405c", v: "#171b28" },
};

const EXIT_SIGN: Asset = {
  rows: [
    "..kk..kk..",
    "GGGGGGGGGG",
    "GgGgGgGgGG",
    "GGGGGGGGGG",
  ],
  pal: { ...T, k: "#4a5266", G: "#2f7a4a", g: "#9bf0b4" },
};

const FIRE_EXT: Asset = {
  rows: [
    "..kk..",
    ".RRRR.",
    "RRRRRR",
    "RrrrrR",
    "RRRRRR",
    "RrrrrR",
    "RRRRRR",
    "RrrrrR",
    "RRRRRR",
    ".dddd.",
  ],
  pal: { ...T, k: "#8892a6", R: "#c94444", r: "#a83636", d: "#3a2020" },
};

// =============================================================== EXPORTS

export const ART = {
  desk: DESK,
  bossDesk: BOSS_DESK,
  chair: CHAIR,
  monitor: MONITOR,
  keyboard: KEYBOARD,
  mouse: MOUSE,
  mousepad: MOUSEPAD,
  mug: MUG,
  mugEmpty: MUG_EMPTY,
  cupSaucer: CUP_SAUCER,
  plant: PLANT,
  succulent: SUCCULENT,
  duck: DUCK,
  books: BOOKS,
  rack: RACK,
  printer: PRINTER,
  cooler: COOLER,
  cat: CAT,
  catLoaf: CAT_LOAF,
  pizza: PIZZA,
  tray: TRAY,
  clock: CLOCK,
  lamp: LAMP,
  phone: PHONE,
  papers: PAPERS,
  filing: FILING,
  boxes: BOXES,
  trash: TRASH,
  whiteboard: WHITEBOARD,
  corkboard: CORKBOARD,
  poster: POSTER,
  coatRack: COAT_RACK,
  vent: VENT,
  exitSign: EXIT_SIGN,
  fireExt: FIRE_EXT,
} satisfies Record<string, Asset>;

export type ArtName = keyof typeof ART;
