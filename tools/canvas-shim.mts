// A pocket-sized 2D canvas that runs in Node, so the real FloorScene can be
// rendered to a PNG and the art can be judged instead of imagined. It supports
// exactly the subset scene.ts uses — nothing more, and it is not trying to be
// a browser.

type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA {
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 255];
    if (h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v));
    return [p[0] | 0, p[1] | 0, p[2] | 0, Math.round((p[3] ?? 1) * 255)];
  }
  return [255, 0, 255, 255];
}

interface Grad { kind: "radial"; x: number; y: number; r0: number; r1: number; stops: Array<[number, RGBA]>; addColorStop(o: number, c: string): void }
interface Pattern { kind: "pattern"; img: Canvas }
type Paint = string | Grad | Pattern;

interface State {
  alpha: number;
  comp: string;
  fill: Paint;
  stroke: string;
  lineWidth: number;
  clip: { x: number; y: number; w: number; h: number };
  m: [number, number, number, number, number, number]; // a b c d e f
  font: string;
  baseline: string;
}

/** 3x5 pixel font. Silkscreen it is not, but positions and extents are honest. */
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
  ".": ["...", "...", "...", "...", ".#."], ":": ["...", ".#.", "...", ".#.", "..."],
  "!": [".#.", ".#.", ".#.", "...", ".#."], "/": ["..#", "..#", ".#.", "#..", "#.."],
  "_": ["...", "...", "...", "...", "###"], "+": ["...", ".#.", "###", ".#.", "..."],
};
const ADV = 6; // Silkscreen 8px advances about this much

export class Ctx {
  canvas: Canvas;
  private st: State;
  private stack: State[] = [];
  private path: Array<[number, number]> = [];
  private pathRect: { x: number; y: number; w: number; h: number } | null = null;
  private arcs: Array<{ x: number; y: number; r: number }> = [];

  // properties scene.ts sets but this shim ignores
  shadowColor = "";
  shadowBlur = 0;
  imageSmoothingEnabled = false;

  constructor(canvas: Canvas) {
    this.canvas = canvas;
    this.st = {
      alpha: 1, comp: "source-over", fill: "#000", stroke: "#000", lineWidth: 1,
      clip: { x: 0, y: 0, w: canvas.width, h: canvas.height },
      m: [1, 0, 0, 1, 0, 0], font: "8px", baseline: "alphabetic",
    };
  }

  get fillStyle() { return this.st.fill; }
  set fillStyle(v: Paint) { this.st.fill = v; }
  get strokeStyle() { return this.st.stroke; }
  set strokeStyle(v: string) { this.st.stroke = v; }
  get lineWidth() { return this.st.lineWidth; }
  set lineWidth(v: number) { this.st.lineWidth = v; }
  get globalAlpha() { return this.st.alpha; }
  set globalAlpha(v: number) { this.st.alpha = v; }
  get globalCompositeOperation() { return this.st.comp; }
  set globalCompositeOperation(v: string) { this.st.comp = v; }
  get font() { return this.st.font; }
  set font(v: string) { this.st.font = v; }
  get textBaseline() { return this.st.baseline; }
  set textBaseline(v: string) { this.st.baseline = v; }

  save() { this.stack.push({ ...this.st, clip: { ...this.st.clip }, m: [...this.st.m] as State["m"] }); }
  restore() { const s = this.stack.pop(); if (s) this.st = s; }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.st.m = [a, b, c, d, e, f]; }
  translate(x: number, y: number) {
    const [a, b, c, d, e, f] = this.st.m;
    this.st.m = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
  }
  scale(x: number, y: number) {
    const [a, b, c, d, e, f] = this.st.m;
    this.st.m = [a * x, b * x, c * y, d * y, e, f];
  }
  rotate(r: number) {
    const [a, b, c, d, e, f] = this.st.m;
    const co = Math.cos(r), si = Math.sin(r);
    this.st.m = [a * co + c * si, b * co + d * si, a * -si + c * co, b * -si + d * co, e, f];
  }
  private tp(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.st.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  // ------------------------------------------------------------- pixels

  private put(x: number, y: number, col: RGBA, alpha: number) {
    const cl = this.st.clip;
    if (x < cl.x || y < cl.y || x >= cl.x + cl.w || y >= cl.y + cl.h) return;
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const a = (col[3] / 255) * alpha;
    if (a <= 0) return;
    const i = (y * this.canvas.width + x) * 4;
    const d = this.canvas.data;
    if (this.st.comp === "lighter") {
      d[i] = d[i] + col[0] * a;
      d[i + 1] = d[i + 1] + col[1] * a;
      d[i + 2] = d[i + 2] + col[2] * a;
      d[i + 3] = 255;
      return;
    }
    if (this.st.comp === "multiply") {
      const m0 = (d[i] * col[0]) / 255, m1 = (d[i + 1] * col[1]) / 255, m2 = (d[i + 2] * col[2]) / 255;
      d[i] = d[i] * (1 - a) + m0 * a;
      d[i + 1] = d[i + 1] * (1 - a) + m1 * a;
      d[i + 2] = d[i + 2] * (1 - a) + m2 * a;
      return;
    }
    d[i] = d[i] * (1 - a) + col[0] * a;
    d[i + 1] = d[i + 1] * (1 - a) + col[1] * a;
    d[i + 2] = d[i + 2] * (1 - a) + col[2] * a;
    d[i + 3] = Math.max(d[i + 3], Math.round(a * 255));
  }

  /** resolve the current fill for a device pixel */
  private paintAt(px: number, py: number): RGBA | null {
    const p = this.st.fill;
    if (typeof p === "string") return parseColor(p);
    if (p.kind === "pattern") {
      const w = p.img.width, h = p.img.height;
      const sx = ((px % w) + w) % w, sy = ((py % h) + h) % h;
      const i = (sy * w + sx) * 4;
      return [p.img.data[i], p.img.data[i + 1], p.img.data[i + 2], p.img.data[i + 3]];
    }
    // radial
    const [cx, cy] = this.tp(p.x, p.y);
    const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
    let t = (d - p.r0) / Math.max(0.0001, p.r1 - p.r0);
    t = Math.max(0, Math.min(1, t));
    const st = p.stops;
    if (!st.length) return null;
    let lo = st[0], hi = st[st.length - 1];
    for (let i = 0; i < st.length - 1; i++) {
      if (t >= st[i][0] && t <= st[i + 1][0]) { lo = st[i]; hi = st[i + 1]; break; }
    }
    const span = Math.max(0.0001, hi[0] - lo[0]);
    const k = Math.max(0, Math.min(1, (t - lo[0]) / span));
    return [
      lo[1][0] + (hi[1][0] - lo[1][0]) * k,
      lo[1][1] + (hi[1][1] - lo[1][1]) * k,
      lo[1][2] + (hi[1][2] - lo[1][2]) * k,
      lo[1][3] + (hi[1][3] - lo[1][3]) * k,
    ];
  }

  fillRect(x: number, y: number, w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    const solid = typeof this.st.fill === "string" ? parseColor(this.st.fill) : null;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const [dx, dy] = this.tp(x + xx + 0.5, y + yy + 0.5);
        const px = Math.floor(dx), py = Math.floor(dy);
        const col = solid ?? this.paintAt(px, py);
        if (col) this.put(px, py, col, this.st.alpha);
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const [dx, dy] = this.tp(x + xx + 0.5, y + yy + 0.5);
        const px = Math.floor(dx), py = Math.floor(dy);
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) continue;
        const i = (py * this.canvas.width + px) * 4;
        this.canvas.data[i] = this.canvas.data[i + 1] = this.canvas.data[i + 2] = this.canvas.data[i + 3] = 0;
      }
    }
  }

  // --------------------------------------------------------------- paths

  beginPath() { this.path = []; this.pathRect = null; this.arcs = []; }
  rect(x: number, y: number, w: number, h: number) { this.pathRect = { x, y, w, h }; }
  moveTo(x: number, y: number) { this.path.push([x, y]); }
  lineTo(x: number, y: number) { this.path.push([x, y]); }
  closePath() { }
  arc(x: number, y: number, r: number) { this.arcs.push({ x, y, r }); }

  clip() {
    if (!this.pathRect) return;
    const [x0, y0] = this.tp(this.pathRect.x, this.pathRect.y);
    const [x1, y1] = this.tp(this.pathRect.x + this.pathRect.w, this.pathRect.y + this.pathRect.h);
    const nx = Math.min(x0, x1), ny = Math.min(y0, y1);
    const nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0);
    const c = this.st.clip;
    const rx = Math.max(c.x, nx), ry = Math.max(c.y, ny);
    this.st.clip = {
      x: rx, y: ry,
      w: Math.max(0, Math.min(c.x + c.w, nx + nw) - rx),
      h: Math.max(0, Math.min(c.y + c.h, ny + nh) - ry),
    };
  }

  fill() {
    for (const a of this.arcs) {
      const [cx, cy] = this.tp(a.x, a.y);
      for (let y = Math.floor(cy - a.r - 1); y <= cy + a.r + 1; y++) {
        for (let x = Math.floor(cx - a.r - 1); x <= cx + a.r + 1; x++) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > a.r) continue;
          const col = this.paintAt(x, y);
          if (col) this.put(x, y, col, this.st.alpha);
        }
      }
    }
    if (this.path.length >= 3) {
      const pts = this.path.map(([x, y]) => this.tp(x, y));
      const ys = pts.map((p) => p[1]);
      const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
      for (let y = y0; y <= y1; y++) {
        const xs: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[(i + 1) % pts.length];
          if (ay === by) continue;
          if (y + 0.5 >= Math.min(ay, by) && y + 0.5 < Math.max(ay, by)) {
            xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let x = Math.floor(xs[i]); x < xs[i + 1]; x++) {
            const col = this.paintAt(x, y);
            if (col) this.put(x, y, col, this.st.alpha);
          }
        }
      }
    }
    this.path = []; this.arcs = [];
  }

  private line(x0: number, y0: number, x1: number, y1: number, col: RGBA) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) {
      const x = Math.floor(x0 + ((x1 - x0) * i) / n);
      const y = Math.floor(y0 + ((y1 - y0) * i) / n);
      this.put(x, y, col, this.st.alpha);
    }
  }

  stroke() {
    const col = parseColor(this.st.stroke);
    const pts = this.path.map(([x, y]) => this.tp(x, y));
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], col);
    if (this.pathRect) {
      const r = this.pathRect;
      const [ax, ay] = this.tp(r.x, r.y);
      const [bx, by] = this.tp(r.x + r.w, r.y + r.h);
      this.line(ax, ay, bx, ay, col); this.line(bx, ay, bx, by, col);
      this.line(bx, by, ax, by, col); this.line(ax, by, ax, ay, col);
    }
    this.path = [];
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    const col = parseColor(this.st.stroke);
    const [ax, ay] = this.tp(x, y);
    const [bx, by] = this.tp(x + w, y + h);
    this.line(ax, ay, bx, ay, col); this.line(bx, ay, bx, by, col);
    this.line(bx, by, ax, by, col); this.line(ax, by, ax, ay, col);
  }

  // ---------------------------------------------------------------- text

  measureText(s: string) { return { width: s.length * ADV }; }

  fillText(s: string, x: number, y: number) {
    const col = typeof this.st.fill === "string" ? parseColor(this.st.fill) : [255, 255, 255, 255] as RGBA;
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = F[ch] ?? F[" "];
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (g[gy][gx] !== "#") continue;
          const [dx, dy] = this.tp(cx + gx + 0.5, y + gy + 1.5);
          this.put(Math.floor(dx), Math.floor(dy), col, this.st.alpha);
        }
      }
      cx += ADV;
    }
  }

  // -------------------------------------------------------------- images

  drawImage(src: Canvas, ...a: number[]) {
    if (a.length <= 4) {
      const [dx, dy] = a;
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          const i = (y * src.width + x) * 4;
          const al = src.data[i + 3];
          if (!al) continue;
          const [px, py] = this.tp(dx + x + 0.5, dy + y + 0.5);
          this.put(Math.floor(px), Math.floor(py), [src.data[i], src.data[i + 1], src.data[i + 2], al], this.st.alpha);
        }
      }
      return;
    }
    const [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const ux = sx + Math.floor((x * sw) / dw);
        const uy = sy + Math.floor((y * sh) / dh);
        if (ux < 0 || uy < 0 || ux >= src.width || uy >= src.height) continue;
        const i = (uy * src.width + ux) * 4;
        const al = src.data[i + 3];
        if (!al) continue;
        const [px, py] = this.tp(dx + x + 0.5, dy + y + 0.5);
        this.put(Math.floor(px), Math.floor(py), [src.data[i], src.data[i + 1], src.data[i + 2], al], this.st.alpha);
      }
    }
  }

  createPattern(img: Canvas): Pattern { return { kind: "pattern", img }; }

  createRadialGradient(_x0: number, _y0: number, r0: number, x1: number, y1: number, r1: number): Grad {
    const g: Grad = {
      kind: "radial", x: x1, y: y1, r0, r1, stops: [],
      addColorStop(o: number, c: string) { g.stops.push([o, parseColor(c)]); g.stops.sort((p, q) => p[0] - q[0]); },
    };
    return g;
  }
}

export class Canvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  style: Record<string, string> = {};
  private ctx: Ctx | null = null;
  constructor(w = 300, h = 150) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  getContext() {
    // width/height may have been reassigned since the last call
    if (!this.ctx || this.ctx.canvas !== this) this.ctx = new Ctx(this);
    return this.ctx;
  }
  addEventListener() { }
  removeEventListener() { }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
}

/** resize support: scene.ts assigns canvas.width/height, which must clear it */
export function makeCanvas(w: number, h: number) {
  const c = new Canvas(w, h);
  let _w = w, _h = h;
  return new Proxy(c, {
    set(t, k, v) {
      if (k === "width" || k === "height") {
        if (k === "width") _w = v as number; else _h = v as number;
        t.width = _w; t.height = _h;
        t.data = new Uint8ClampedArray(_w * _h * 4);
        (t as unknown as { ctx: Ctx | null }).ctx = null;
        return true;
      }
      return Reflect.set(t, k, v);
    },
  });
}

/** install the globals scene.ts reaches for */
export function installDom() {
  const clock = { now: 0 };
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`shim: no <${tag}>`);
      return makeCanvas(300, 150);
    },
  };
  g.window = { addEventListener() { }, removeEventListener() { } };
  g.performance = { now: () => clock.now };
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => { };
  return clock;
}
