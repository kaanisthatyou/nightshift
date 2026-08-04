// The floor, drawn one pixel at a time.
// The room is a fixed 360x240 patch of world; the camera decides how much of the
// office around it you see. Everything renders into a virtual-pixel buffer, then
// gets blown up with smoothing off so it stays honest pixels.
import type { FloorEvent, FloorState, Worker } from "../../../shared/types.ts";
import {
  PROPS, makeBossSkin, makeWorkerSkin,
  MONITOR_SCREEN, RACK_LEDS, RACK_PLATE, TRAY_PLATE, COOLER_WATER,
  type BossSkin, type WorkerSkin,
} from "./sprites.ts";

/** the room the desks live in, in world pixels */
export const VW = 360;
export const VH = 240;

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 8;
/** how far past the room edge the camera may wander */
const PAN_MARGIN = 90;

const DESK_X = [46, 122, 198, 274];
const ROW_Y = [94, 166]; // desk surface line
const LANES = [14, 84, 160, 236, 312];
const CORRIDOR = 212;
const BOSS_HOME = { x: 318, y: 226 };
const TRAY = { x: 26, y: 212 };

// where every piece of furniture stands. One list, so nothing quietly overlaps.
const RACK_AT = { x: 3, y: 60 };
const PRINTER_AT = { x: 2, y: 108 };
const COOLER_AT = { x: 344, y: 58 };
const BOSS_DESK_AT = { x: 296, y: 192 };

/** the three windows, and the mullions that quarter each one */
const WINDOWS = [
  { x: 30, y: 6, w: 74, h: 30 },
  { x: 140, y: 6, w: 74, h: 30 },
  { x: 250, y: 6, w: 74, h: 30 },
];

/** desk clutter, one per worker, picked from their seed */
const CLUTTER = ["books", "succulent", "papers", "duck"] as const;

export interface DeskPos { cx: number; dy: number; row: number; col: number }

export function deskPos(i: number): DeskPos {
  const row = Math.floor(i / 4);
  const col = i % 4;
  return { cx: DESK_X[col], dy: ROW_Y[Math.min(row, 1)], row, col };
}

/** cheap deterministic noise — same pixel gets the same value every frame */
function hash(n: number) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Bubble {
  text: string;
  until: number;
  kind: "worker" | "boss";
  x: number;
  y: number;
  follow?: "boss" | number; // desk index
}

interface Paper { x: number; y: number; tx: number; ty: number; t: number; ok: boolean }
interface Puff { x: number; y: number; life: number; max: number; color: string; vx: number; vy: number }

/** a bead of water on the glass. It clings, then it runs. */
interface Bead {
  x: number;
  y: number;
  bottom: number; // the pane's lower edge — where it pools and dies
  v: number;
  tail: number;
  hold: number;
  big: boolean;
}

interface Agent {
  worker: Worker;
  skin: WorkerSkin;
  screen: number;   // 0..1 activity
  glow: number;
  flash: number;
  bob: number;
  blink: number;    // seconds until the next blink
  clutter: (typeof CLUTTER)[number];
}

type WalkTarget = { x: number; y: number; then?: () => void };

export class FloorScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private b: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private raf = 0;
  private last = 0;
  private t = 0;

  /** camera: zoom is an integer, cam is the world->buffer offset */
  private zoom = 3;
  private cam = { x: 0, y: 0 };
  private view = { bw: VW, bh: VH };
  private userMoved = false;
  private drag: { on: boolean; sx: number; sy: number; cx: number; cy: number; moved: number } = {
    on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: 0,
  };
  private mouse = { x: -999, y: -999, over: null as number | null, onBoss: false };
  private floorPattern: CanvasPattern | null = null;
  onZoom: ((z: number) => void) | null = null;

  private agents = new Map<string, Agent>();
  private bubbles: Bubble[] = [];
  private papers: Paper[] = [];
  private puffs: Puff[] = [];
  private boss = { x: BOSS_HOME.x, y: BOSS_HOME.y, dir: -1, walking: false, frame: 0, talk: 0 };
  private queue: WalkTarget[] = [];
  private homeAt = 0;
  private bossSkin: BossSkin;
  private state: FloorState | null = null;
  private trayCount = 0;
  private lightsOut = false;
  private shake = 0;

  // night life
  private pizzaUntil = 0;
  private flicker = 0;
  private printerUntil = 0;
  private cat = { x: 176, y: 214, tx: 176, ty: 214, sitUntil: 0, tail: 0 };
  private confetti: Puff[] = [];

  // weather
  private beads: Bead[] = [];
  private storm = 0;      // lightning, 0..1, decays
  private stormNext = 20; // seconds until the sky considers it again

  selected: string | null = null;
  onSelect: ((workerId: string | null) => void) | null = null;
  /** double-click a desk: open what it is working on */
  onDeskOpen: ((workerId: string) => void) | null = null;
  /** click the IN tray: go read the finished work */
  onTray: (() => void) | null = null;
  /** click an empty desk: go hire someone for it */
  onEmptyDesk: ((desk: number) => void) | null = null;
  /** poke the boss */
  onBossPoke: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.buf = document.createElement("canvas");
    this.buf.width = VW;
    this.buf.height = VH;
    this.b = this.buf.getContext("2d")!;
    this.bossSkin = makeBossSkin();
    this.bg = this.paintBackground();
    this.floorPattern = this.b.createPattern(this.paintFloorTile(), "repeat");
    this.seedRain();

    canvas.addEventListener("mousedown", this.onDown);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("mouseleave", this.onLeave);
    canvas.addEventListener("contextmenu", this.onContext);
    canvas.addEventListener("dblclick", this.onDouble);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("mousedown", this.onDown);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("mouseleave", this.onLeave);
    this.canvas.removeEventListener("contextmenu", this.onContext);
    this.canvas.removeEventListener("dblclick", this.onDouble);
  }

  // ---- camera + input -------------------------------------------------

  /** screen (client) coords -> world coords */
  private toWorld(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * this.view.bw;
    const py = ((clientY - rect.top) / rect.height) * this.view.bh;
    return { x: px - this.cam.x, y: py - this.cam.y };
  }

  private deskAt(wx: number, wy: number): { id: string; desk: number } | null {
    for (const [id, a] of this.agents) {
      const p = deskPos(a.worker.desk);
      if (wx > p.cx - 20 && wx < p.cx + 20 && wy > p.dy - 32 && wy < p.dy + 20) return { id, desk: a.worker.desk };
    }
    return null;
  }

  private emptyDeskAt(wx: number, wy: number): number | null {
    const taken = new Set([...this.agents.values()].map((a) => a.worker.desk));
    for (let i = 0; i < 8; i++) {
      if (taken.has(i)) continue;
      const p = deskPos(i);
      if (wx > p.cx - 20 && wx < p.cx + 20 && wy > p.dy - 32 && wy < p.dy + 20) return i;
    }
    return null;
  }

  private onContext = (ev: MouseEvent) => ev.preventDefault();
  private onLeave = () => {
    this.mouse.over = null;
    this.mouse.onBoss = false;
  };

  private onDown = (ev: MouseEvent) => {
    this.drag = { on: true, sx: ev.clientX, sy: ev.clientY, cx: this.cam.x, cy: this.cam.y, moved: 0 };
  };

  private onMove = (ev: MouseEvent) => {
    const w = this.toWorld(ev.clientX, ev.clientY);
    this.mouse.x = w.x;
    this.mouse.y = w.y;
    const hit = this.deskAt(w.x, w.y);
    this.mouse.over = hit ? hit.desk : this.emptyDeskAt(w.x, w.y);
    this.mouse.onBoss = Math.abs(w.x - this.boss.x) < 8 && w.y - this.boss.y > -22 && w.y - this.boss.y < 4;

    if (this.drag.on) {
      const dx = ev.clientX - this.drag.sx;
      const dy = ev.clientY - this.drag.sy;
      this.drag.moved = Math.max(this.drag.moved, Math.abs(dx) + Math.abs(dy));
      if (this.drag.moved > 3) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = this.view.bw / rect.width;
        const sy = this.view.bh / rect.height;
        this.cam.x = this.drag.cx + dx * sx;
        this.cam.y = this.drag.cy + dy * sy;
        this.userMoved = true;
        this.clampCam();
      }
    }
    this.canvas.style.cursor = this.drag.on && this.drag.moved > 3
      ? "grabbing"
      : this.mouse.over !== null || this.mouse.onBoss
        ? "pointer"
        : "grab";
  };

  private onUp = (ev: MouseEvent) => {
    if (!this.drag.on) return;
    const wasDrag = this.drag.moved > 3;
    this.drag.on = false;
    if (wasDrag) return;

    // a click, not a drag
    const w = this.toWorld(ev.clientX, ev.clientY);
    const hit = this.deskAt(w.x, w.y);
    if (hit) {
      this.selected = hit.id;
      this.onSelect?.(hit.id);
      return;
    }
    if (Math.abs(w.x - TRAY.x) < 22 && Math.abs(w.y - TRAY.y) < 20) {
      this.onTray?.();
      return;
    }
    if (this.mouse.onBoss) {
      this.onBossPoke?.();
      return;
    }
    const empty = this.emptyDeskAt(w.x, w.y);
    if (empty !== null) {
      this.onEmptyDesk?.(empty);
      return;
    }
    this.selected = null;
    this.onSelect?.(null);
  };

  private onDouble = (ev: MouseEvent) => {
    const w = this.toWorld(ev.clientX, ev.clientY);
    const hit = this.deskAt(w.x, w.y);
    if (hit) this.onDeskOpen?.(hit.id);
    else this.fit();
  };

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const dir = ev.deltaY > 0 ? -1 : 1;
    this.zoomBy(dir, ev.clientX, ev.clientY);
  };

  /** zoom one integer step, keeping whatever is under the cursor put */
  zoomBy(dir: number, clientX?: number, clientY?: number) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + dir));
    if (next === this.zoom) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = clientX ?? rect.left + rect.width / 2;
    const cy = clientY ?? rect.top + rect.height / 2;
    const before = this.toWorld(cx, cy);
    this.zoom = next;
    this.measure();
    // put `before` back under the cursor
    const px = ((cx - rect.left) / rect.width) * this.view.bw;
    const py = ((cy - rect.top) / rect.height) * this.view.bh;
    this.cam.x = px - before.x;
    this.cam.y = py - before.y;
    this.userMoved = true;
    this.clampCam();
    this.onZoom?.(this.zoom);
  }

  /** back to "the whole room, centred" */
  fit() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || VW * 3;
    const h = rect.height || VH * 3;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min(w / VW, h / VH))));
    this.measure();
    this.cam.x = (this.view.bw - VW) / 2;
    this.cam.y = (this.view.bh - VH) / 2;
    this.userMoved = false;
    this.onZoom?.(this.zoom);
  }

  getZoom() {
    return this.zoom;
  }

  /** arrow-key panning, in world pixels */
  panBy(dx: number, dy: number) {
    this.cam.x -= dx;
    this.cam.y -= dy;
    this.userMoved = true;
    this.clampCam();
  }

  /** buffer size in world pixels for the current canvas + zoom */
  private measure() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || VW * 3;
    const h = rect.height || VH * 3;
    this.view.bw = Math.max(64, Math.ceil(w / this.zoom));
    this.view.bh = Math.max(64, Math.ceil(h / this.zoom));
    if (this.buf.width !== this.view.bw || this.buf.height !== this.view.bh) {
      this.buf.width = this.view.bw;
      this.buf.height = this.view.bh;
      this.b = this.buf.getContext("2d")!;
      this.floorPattern = this.b.createPattern(this.paintFloorTile(), "repeat");
    }
  }

  private clampCam() {
    const axis = (cam: number, buf: number, room: number) => {
      const lo = buf - room - PAN_MARGIN; // room's right edge can't come further in than this
      const hi = PAN_MARGIN;
      if (lo > hi) return (buf - room) / 2; // viewport dwarfs the room: just centre it
      return Math.max(lo, Math.min(hi, cam));
    };
    this.cam.x = Math.round(axis(this.cam.x, this.view.bw, VW));
    this.cam.y = Math.round(axis(this.cam.y, this.view.bh, VH));
  }

  // ---------------------------------------------------------------- sync

  sync(state: FloorState) {
    this.state = state;
    const seen = new Set<string>();
    for (const w of state.workers) {
      seen.add(w.id);
      const existing = this.agents.get(w.id);
      if (existing) existing.worker = w;
      else this.agents.set(w.id, {
        worker: w,
        skin: makeWorkerSkin(w.seed),
        screen: 0,
        glow: 0,
        flash: 0,
        bob: Math.random() * 6,
        blink: 1 + Math.random() * 4,
        clutter: CLUTTER[(w.seed >>> 3) % CLUTTER.length],
      });
    }
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id);
    this.trayCount = state.tasks.filter((t) => t.stage === "review").length;
    this.lightsOut = !state.gateway.online;
  }

  // ------------------------------------------------------------ director

  event(e: FloorEvent) {
    const agent = e.workerId ? this.agents.get(e.workerId) : undefined;
    const pos = agent ? deskPos(agent.worker.desk) : null;

    switch (e.type) {
      case "boss.order": {
        const text = (e.text ?? "").slice(0, 160);
        if (pos) {
          this.walkTo(pos.cx - 24, pos.dy + 6, () => {
            this.boss.dir = 1;
            this.boss.talk = 2.4;
            this.say(text, "boss", pos.cx - 24, pos.dy - 22, "boss");
          });
        } else {
          this.say(text, "boss", this.boss.x, this.boss.y - 22, "boss");
          this.boss.talk = 2;
        }
        break;
      }
      case "boss.say": {
        this.boss.talk = 2;
        if (pos) this.walkTo(pos.cx - 24, pos.dy + 6, () => this.say(e.text ?? "", "boss", 0, 0, "boss"));
        else this.say(e.text ?? "", "boss", 0, 0, "boss");
        break;
      }
      case "worker.start":
        if (agent && pos) {
          agent.screen = 1;
          agent.glow = 1;
          this.puff(pos.cx, pos.dy - 18, "#35d6ff", 4);
        }
        break;
      case "worker.chunk":
        if (agent) {
          agent.screen = Math.min(1.6, agent.screen + 0.35);
          agent.glow = 1;
        }
        break;
      case "worker.done":
        if (agent && pos) {
          this.say(agent.worker.saying ?? "done.", "worker", pos.cx, pos.dy - 34, agent.worker.desk);
          this.papers.push({ x: pos.cx, y: pos.dy - 6, tx: TRAY.x, ty: TRAY.y - 6, t: 0, ok: true });
          this.puff(pos.cx, pos.dy - 20, "#6ee787", 6);
        }
        break;
      case "worker.fail":
        if (agent && pos) {
          agent.flash = 1;
          this.shake = 0.35;
          this.say(agent.worker.saying ?? "it broke.", "worker", pos.cx, pos.dy - 34, agent.worker.desk);
          this.puff(pos.cx, pos.dy - 20, "#ff5c5c", 8);
        }
        break;
      case "worker.say":
        if (agent && pos) this.say(e.text ?? "", "worker", pos.cx, pos.dy - 34, agent.worker.desk);
        break;
      case "worker.hired":
        if (pos) this.puff(pos.cx, pos.dy - 14, "#ffb454", 10);
        break;
      case "worker.fired":
        if (pos) this.puff(pos.cx, pos.dy - 14, "#8892a6", 12);
        break;
      case "gateway":
        this.shake = 0.25;
        this.flicker = 1.4;
        break;
      case "office": {
        const kind = (e.data?.kind as string) ?? "";
        if (kind === "pizza") {
          this.pizzaUntil = this.t + 50;
          this.puff(180, 210, "#ffb454", 10);
        } else if (kind === "flicker") {
          this.flicker = 1.6;
        } else if (kind === "printer") {
          this.printerUntil = this.t + 18;
          this.puff(12, 110, "#ff5c5c", 6);
        } else if (kind === "cat") {
          const desk = e.data?.desk as number | undefined;
          const p = deskPos(typeof desk === "number" ? desk : 0);
          this.cat.tx = p.cx + 14;
          this.cat.ty = p.dy + 6;
          this.cat.sitUntil = this.t + 30;
        } else if (kind === "promotion" || kind === "quit") {
          const desk = e.data?.desk as number | undefined;
          const p = deskPos(typeof desk === "number" ? desk : 0);
          const color = kind === "promotion" ? "#ffd166" : "#8892a6";
          for (let i = 0; i < 26; i++) {
            this.confetti.push({
              x: p.cx + (Math.random() - 0.5) * 26,
              y: p.dy - 30,
              vx: (Math.random() - 0.5) * 30,
              vy: kind === "promotion" ? -40 - Math.random() * 30 : -6,
              life: 0,
              max: 1.6 + Math.random(),
              color: kind === "promotion" ? (i % 3 ? color : "#6ee787") : color,
            });
          }
          if (kind === "quit") this.shake = 0.4;
        }
        break;
      }
    }
  }

  private say(text: string, kind: "worker" | "boss", x: number, y: number, follow: Bubble["follow"]) {
    if (!text.trim()) return;
    const dur = Math.min(9, 2.4 + text.length / 26);
    this.bubbles = this.bubbles.filter((bb) => bb.follow !== follow);
    this.bubbles.push({ text: text.trim(), until: this.t + dur, kind, x, y, follow });
  }

  private puff(x: number, y: number, color: string, n: number) {
    for (let i = 0; i < n; i++) {
      this.puffs.push({
        x, y,
        vx: (Math.random() - 0.5) * 22,
        vy: -12 - Math.random() * 18,
        life: 0, max: 0.5 + Math.random() * 0.5, color,
      });
    }
  }

  /** Route through the front corridor and a vertical lane. Looks deliberate. */
  private walkTo(x: number, y: number, then?: () => void) {
    const lane = LANES.reduce((best, l) => (Math.abs(l - x) < Math.abs(best - x) ? l : best), LANES[0]);
    this.queue = [
      { x: this.boss.x, y: CORRIDOR },
      { x: lane, y: CORRIDOR },
      { x: lane, y },
      { x, y, then },
    ];
    this.boss.walking = true;
  }

  sendBossHome() {
    this.walkTo(BOSS_HOME.x, BOSS_HOME.y);
  }

  // --------------------------------------------------------------- loop

  start() {
    this.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ the rain
  // Two things are happening on every window and they are not the same thing:
  // the downpour BEHIND the glass, which is fast, straight and slanted by the
  // wind; and the water ON the glass, which clings in beads until one gets
  // heavy enough to break loose and run, taking the beads below it with it.
  // The second one is what makes a window read as wet.

  /** the four panes of a window, as absolute rects */
  private panes(w: (typeof WINDOWS)[number]) {
    const mx = w.x + Math.floor(w.w / 2);
    const my = w.y + Math.floor(w.h / 2);
    return [
      { x: w.x + 1, y: w.y + 1, w: mx - w.x - 2, h: my - w.y - 2 },
      { x: mx + 1, y: w.y + 1, w: w.x + w.w - mx - 2, h: my - w.y - 2 },
      { x: w.x + 1, y: my + 1, w: mx - w.x - 2, h: w.y + w.h - my - 2 },
      { x: mx + 1, y: my + 1, w: w.x + w.w - mx - 2, h: w.y + w.h - my - 2 },
    ];
  }

  private spawnBead(bead?: Bead): Bead {
    const w = WINDOWS[Math.floor(Math.random() * WINDOWS.length)];
    const p = this.panes(w)[Math.floor(Math.random() * 4)];
    const b = bead ?? ({} as Bead);
    b.x = p.x + Math.floor(Math.random() * p.w);
    b.y = p.y + Math.floor(Math.random() * p.h * 0.7);
    b.bottom = p.y + p.h;
    b.v = 0;
    b.tail = 0;
    b.hold = Math.random() * 3;
    b.big = Math.random() < 0.35;
    return b;
  }

  private seedRain() {
    for (let i = 0; i < 54; i++) this.beads.push(this.spawnBead());
  }

  private updateRain(dt: number) {
    for (const d of this.beads) {
      if (d.v === 0) {
        d.hold -= dt;
        d.tail = Math.max(0, d.tail - dt * 12); // the old trail dries
        if (d.hold <= 0) d.v = d.big ? 14 : 7;
        continue;
      }
      d.v += (d.big ? 60 : 34) * dt;   // it picks up every bead it passes
      d.y += d.v * dt;
      d.tail = Math.min(d.big ? 16 : 9, d.tail + d.v * dt * 0.9);
      // glass is not smooth: a runner can snag and stop halfway down
      if (!d.big && Math.random() < dt * 0.9) {
        d.v = 0;
        d.hold = 0.4 + Math.random() * 2;
      }
      if (d.y >= d.bottom) this.spawnBead(d);
    }
  }

  private update(dt: number) {
    // boss walk
    const target = this.queue[0];
    if (target) {
      const dx = target.x - this.boss.x;
      const dy = target.y - this.boss.y;
      const dist = Math.hypot(dx, dy);
      const speed = 140;
      if (dist < 1.5) {
        this.boss.x = target.x;
        this.boss.y = target.y;
        this.queue.shift();
        if (!this.queue.length) {
          this.boss.walking = false;
          this.homeAt = this.t + 6;
        }
        target.then?.();
      } else {
        this.boss.x += (dx / dist) * speed * dt;
        this.boss.y += (dy / dist) * speed * dt;
        if (Math.abs(dx) > 2) this.boss.dir = dx > 0 ? 1 : -1;
        this.boss.frame += dt * 8;
        this.boss.walking = true;
      }
    }
    // when nothing needs shouting at, he drifts back to his own desk
    if (!this.queue.length && this.homeAt && this.t > this.homeAt) {
      this.homeAt = 0;
      if (Math.hypot(this.boss.x - BOSS_HOME.x, this.boss.y - BOSS_HOME.y) > 6) this.sendBossHome();
    }
    if (this.boss.talk > 0) this.boss.talk -= dt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);

    for (const a of this.agents.values()) {
      const st = a.worker.state;
      const decay = st === "typing" ? 0.4 : 1.6;
      a.screen = Math.max(st === "typing" || st === "thinking" ? 0.35 : 0, a.screen - decay * dt);
      a.glow = Math.max(0, a.glow - dt * 0.8);
      a.flash = Math.max(0, a.flash - dt * 1.6);
      a.bob += dt * (st === "typing" ? 9 : 1.6);
      a.blink -= dt;
      if (a.blink < -0.12) a.blink = 1.6 + Math.random() * 4.5;
    }

    for (const p of this.papers) p.t = Math.min(1, p.t + dt * 0.9);
    this.papers = this.papers.filter((p) => p.t < 1);

    for (const p of this.puffs) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 26 * dt;
    }
    this.puffs = this.puffs.filter((p) => p.life < p.max);

    for (const p of this.confetti) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 42 * dt;
    }
    this.confetti = this.confetti.filter((p) => p.life < p.max);

    if (this.flicker > 0) this.flicker = Math.max(0, this.flicker - dt);

    this.updateRain(dt);
    // lightning, rarely, and then the room notices
    this.storm = Math.max(0, this.storm - dt * 3.2);
    this.stormNext -= dt;
    if (this.stormNext <= 0) {
      this.stormNext = 22 + Math.random() * 50;
      this.storm = 1;
    }

    // the cat takes its time
    const cdx = this.cat.tx - this.cat.x;
    const cdy = this.cat.ty - this.cat.y;
    const cd = Math.hypot(cdx, cdy);
    if (cd > 1) {
      const sp = 26;
      this.cat.x += (cdx / cd) * sp * dt;
      this.cat.y += (cdy / cd) * sp * dt;
      this.cat.tail += dt * 6;
    } else {
      this.cat.tail += dt * 1.6;
      if (this.cat.sitUntil && this.t > this.cat.sitUntil) {
        this.cat.sitUntil = 0;
        this.cat.tx = 176;
        this.cat.ty = 214;
      }
    }
    this.bubbles = this.bubbles.filter((bb) => bb.until > this.t);
  }

  // --------------------------------------------------------------- paint

  /** one 32x32 tile of office carpet, used as a repeating pattern */
  private paintFloorTile(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const g = c.getContext("2d")!;
    // carpet tiles laid at alternating nap, which is why they never match
    for (let y = 0; y < 32; y += 16) {
      for (let x = 0; x < 32; x += 16) {
        const alt = ((x / 16 + y / 16) | 0) % 2 === 0;
        g.fillStyle = alt ? "#282e4a" : "#252b45";
        g.fillRect(x, y, 16, 16);
      }
    }
    // the flecks that make it carpet and not lino
    for (let i = 0; i < 170; i++) {
      const x = Math.floor(hash(i * 3 + 1) * 32);
      const y = Math.floor(hash(i * 3 + 2) * 32);
      const k = hash(i * 3 + 3);
      g.fillStyle = k < 0.45 ? "rgba(255,255,255,0.035)" : k < 0.8 ? "rgba(0,0,0,0.09)" : "rgba(120,150,255,0.05)";
      g.fillRect(x, y, 1, 1);
    }
    // tile seams, only just there
    g.fillStyle = "rgba(0,0,0,0.10)";
    g.fillRect(0, 0, 32, 1);
    g.fillRect(0, 16, 32, 1);
    g.fillRect(0, 0, 1, 32);
    g.fillRect(16, 0, 1, 32);
    return c;
  }

  /** the wall band: panel joints, a chair rail, cable trunking, skirting */
  private paintWall(g: CanvasRenderingContext2D, x0: number, w: number) {
    g.fillStyle = "#252c48";
    g.fillRect(x0, 0, w, 52);
    // panel joints every 24px, lit on one side and shaded on the other
    const from = Math.floor(x0 / 24) * 24;
    for (let x = from; x < x0 + w; x += 24) {
      g.fillStyle = "rgba(0,0,0,0.16)";
      g.fillRect(x, 0, 1, 52);
      g.fillStyle = "rgba(255,255,255,0.035)";
      g.fillRect(x + 1, 0, 1, 52);
    }
    // cable trunking runs the length of the room at head height
    g.fillStyle = "#2e3654";
    g.fillRect(x0, 44, w, 4);
    g.fillStyle = "#3b4568";
    g.fillRect(x0, 44, w, 1);
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.fillRect(x0, 47, w, 1);
    // skirting board
    g.fillStyle = "#3d456e";
    g.fillRect(x0, 50, w, 2);
    g.fillStyle = "#1b2036";
    g.fillRect(x0, 52, w, 6);
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(x0, 57, w, 1);
  }

  private paintBackground(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = VW;
    c.height = VH;
    const g = c.getContext("2d")!;

    this.paintWall(g, 0, VW);

    // The kilim somebody brought in years ago and nobody has vacuumed since.
    // Woven properly: fringes, a bordered band top and bottom, and a run of
    // diamond medallions down the field, worn pale where everyone walks.
    const rx = 96, ry = 196, rw = 168, rh = 34;
    g.fillStyle = "#42283a";
    g.fillRect(rx, ry, rw, rh);
    g.fillStyle = "#2a1a26";
    g.fillRect(rx, ry, rw, 1);
    g.fillRect(rx, ry + rh - 1, rw, 1);
    g.fillRect(rx, ry, 1, rh);
    g.fillRect(rx + rw - 1, ry, 1, rh);
    // fringes at both ends
    g.fillStyle = "#b7ab90";
    for (let y = ry + 2; y < ry + rh - 2; y += 3) {
      g.fillRect(rx - 2, y, 2, 1);
      g.fillRect(rx + rw, y, 2, 1);
    }
    // border bands, with a sawtooth running through them
    for (const by of [ry + 2, ry + rh - 6]) {
      g.fillStyle = "#6b2f38";
      g.fillRect(rx + 2, by, rw - 4, 4);
      g.fillStyle = "#d8c9a8";
      for (let x = rx + 3; x < rx + rw - 4; x += 4) {
        g.fillRect(x, by + 2, 1, 1);
        g.fillRect(x + 1, by + 1, 1, 1);
        g.fillRect(x + 2, by + 2, 1, 1);
      }
    }
    // diamond medallions — outlines, not filled discs, and faded almost to
    // nothing so the rug stays furniture instead of becoming the focal point
    const cy = ry + Math.floor(rh / 2);
    const ring = (mx: number, R: number, color: string) => {
      g.fillStyle = color;
      for (let r = -R; r <= R; r++) {
        const hw = R - Math.abs(r);
        g.fillRect(mx - hw, cy + r, 1, 1);
        g.fillRect(mx + hw, cy + r, 1, 1);
      }
    };
    for (let mx = rx + 18; mx < rx + rw - 12; mx += 24) {
      ring(mx, 8, "#8c7f66");
      ring(mx, 5, "#4a5670");
      g.fillStyle = "#8a6a34";
      g.fillRect(mx - 1, cy - 1, 3, 3);
    }
    // the path worn through the middle
    g.fillStyle = "rgba(210,200,180,0.05)";
    g.fillRect(rx + 30, ry + 10, 108, 14);

    // scuffs on the carpet, worst along the walking lanes
    g.fillStyle = "rgba(255,255,255,0.03)";
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(hash(i * 7 + 11) * VW);
      const y = 60 + Math.floor(hash(i * 7 + 13) * (VH - 62));
      g.fillRect(x, y, 2 + Math.floor(hash(i) * 3), 1);
    }
    return c;
  }

  // ------------------------------------------------------------- windows

  private drawWindows() {
    const g = this.b;
    for (let wi = 0; wi < WINDOWS.length; wi++) {
      const W = WINDOWS[wi];
      g.save();
      g.beginPath();
      g.rect(W.x, W.y, W.w, W.h);
      g.clip();

      // --- sky, four bands so the horizon feels lower than the zenith
      const bands = ["#070a18", "#0a0f22", "#101733", "#182147"];
      for (let i = 0; i < 4; i++) {
        g.fillStyle = bands[i];
        g.fillRect(W.x, W.y + Math.floor((W.h * i) / 4), W.w, Math.ceil(W.h / 4) + 1);
      }

      // --- stars, only up where the city glow hasn't washed them out
      for (let i = 0; i < 16; i++) {
        const sx = W.x + 2 + Math.floor(hash(wi * 91 + i) * (W.w - 4));
        const sy = W.y + 1 + Math.floor(hash(wi * 91 + i + 500) * (W.h * 0.55));
        const tw = 0.5 + 0.5 * Math.sin(this.t * 1.8 + i * 2.1);
        g.globalAlpha = 0.15 + tw * 0.55;
        g.fillStyle = "#e8f0ff";
        g.fillRect(sx, sy, 1, 1);
      }
      g.globalAlpha = 1;

      // --- the moon, middle window only, behind cloud
      if (wi === 1) {
        g.save();
        g.globalAlpha = 0.16;
        g.fillStyle = "#8f9bd0";
        g.beginPath(); g.arc(W.x + 56, W.y + 9, 7, 0, Math.PI * 2); g.fill();
        g.restore();
        g.fillStyle = "#eae2c6";
        g.beginPath(); g.arc(W.x + 56, W.y + 9, 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#cfc4a2";
        g.fillRect(W.x + 54, W.y + 8, 2, 1);
        g.fillRect(W.x + 57, W.y + 10, 1, 1);
        // the cloud that keeps crossing it
        const cx = W.x + ((this.t * 3) % (W.w + 40)) - 20;
        g.fillStyle = "rgba(28,36,68,0.8)";
        g.fillRect(cx, W.y + 7, 22, 3);
        g.fillRect(cx + 4, W.y + 5, 14, 3);
        g.fillRect(cx - 3, W.y + 9, 26, 2);
      }

      // --- city glow at the horizon. Without this the towers are invisible:
      // a silhouette needs something bright behind it to be a silhouette.
      const horizon = W.y + W.h;
      for (let i = 0; i < 10; i++) {
        g.globalAlpha = 0.06 + i * 0.022;
        g.fillStyle = i > 6 ? "#6a5a86" : "#3d4a80";
        g.fillRect(W.x, horizon - 20 + i * 2, W.w, 2);
      }
      g.globalAlpha = 1;

      // --- skyline, two layers so the city has depth
      g.fillStyle = "#1b2444";
      for (let i = 0; i < 14; i++) {
        const s = hash(wi * 31 + i);
        const bw = 5 + Math.floor(s * 8);
        const bh = 5 + Math.floor(hash(wi * 31 + i + 90) * 11);
        g.fillRect(W.x + i * 6 - 2, horizon - bh, bw, bh);
      }
      const near: Array<{ x: number; w: number; h: number }> = [];
      g.fillStyle = "#05070f";
      for (let i = 0; i < 9; i++) {
        const s = hash(wi * 57 + i + 7);
        const bw = 7 + Math.floor(s * 8);
        const bh = 9 + Math.floor(hash(wi * 57 + i + 300) * 15);
        const bx = W.x + i * 9 - 3;
        near.push({ x: bx, w: bw, h: bh });
        g.fillRect(bx, horizon - bh, bw, bh);
        // a lit parapet edge, so the near towers have a top
        g.fillStyle = "#141c36";
        g.fillRect(bx, horizon - bh, bw, 1);
        g.fillStyle = "#05070f";
      }
      // lit office windows in the near towers — other people also still here
      for (const bld of near) {
        for (let ly = horizon - bld.h + 2; ly < horizon - 1; ly += 3) {
          for (let lx = bld.x + 1; lx < bld.x + bld.w - 1; lx += 3) {
            const k = hash(lx * 71 + ly * 13);
            if (k > 0.62) continue;
            const on = Math.sin(this.t * 0.35 + lx * 2.7 + ly) > -0.75;
            if (!on) continue;
            g.fillStyle = k < 0.08 ? "#6ee787" : k < 0.2 ? "#fff0c4" : "#ffd166";
            g.globalAlpha = 0.5 + k;
            g.fillRect(lx, ly, 1, 1);
          }
        }
      }
      g.globalAlpha = 1;
      // aircraft warning light on the tallest thing out there
      const tall = near.reduce((a, b) => (b.h > a.h ? b : a), near[0]);
      if (tall && Math.sin(this.t * 2.2 + wi) > 0.55) {
        g.fillStyle = "#ff5c5c";
        g.fillRect(tall.x + (tall.w >> 1), horizon - tall.h - 1, 1, 1);
      }

      // --- the downpour, behind the glass. Three things stop this reading as
      // the row of identical diagonal ticks it used to be: every drop gets its
      // own speed (so nothing marches in step), the slant is a slow gust that
      // sways the whole sheet together, and the faster a drop falls the
      // brighter it is — which is the only depth cue rain has.
      const gust = 0.18 + Math.sin(this.t * 0.35 + wi) * 0.22;
      for (let i = 0; i < 64; i++) {
        const s = hash(wi * 131 + i);
        const s2 = hash(wi * 131 + i + 777);
        const speed = 150 + s * 240;
        const len = 2 + Math.floor(s2 * 6);
        const x = W.x + (Math.floor(s * 9973) % W.w);
        const y = W.y + (((this.t * speed + s2 * 600) % (W.h + len + 8)) - len);
        g.fillStyle = s2 > 0.85 ? "#e8f2ff" : "#b6d6ff";
        g.globalAlpha = 0.22 + ((speed - 150) / 240) * 0.42;
        for (let k = 0; k < len; k++) {
          g.fillRect(Math.round(x - k * gust), Math.round(y + k), 1, 1);
        }
      }
      g.globalAlpha = 1;

      // --- lightning, which is mostly why anyone looks out of a window
      if (this.storm > 0.01) {
        g.globalAlpha = Math.min(0.85, this.storm * this.storm * 1.2);
        g.fillStyle = "#cfe0ff";
        g.fillRect(W.x, W.y, W.w, W.h);
        g.globalAlpha = 1;
      }

      // --- the glass itself: a cold film, misted where the frame is coldest
      g.globalAlpha = 0.055;
      g.fillStyle = "#7fb0e8";
      g.fillRect(W.x, W.y, W.w, W.h);
      g.globalAlpha = 1;
      for (let i = 0; i < 90; i++) {
        const fx = W.x + Math.floor(hash(wi * 211 + i) * W.w);
        const fy = W.y + Math.floor(hash(wi * 211 + i + 40) * W.h);
        const edge = Math.min(fx - W.x, W.x + W.w - fx, fy - W.y, W.y + W.h - fy);
        if (edge > 6) continue;
        g.globalAlpha = 0.06 + (6 - edge) * 0.045;
        g.fillStyle = "#cfe4ff";
        g.fillRect(fx, fy, 1, 1);
      }
      g.globalAlpha = 1;
      // one diagonal reflection band, so the pane reads as glass and not a hole
      g.save();
      g.globalAlpha = 0.05;
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.moveTo(W.x, W.y + 16);
      g.lineTo(W.x + 20, W.y);
      g.lineTo(W.x + 30, W.y);
      g.lineTo(W.x, W.y + 26);
      g.closePath();
      g.fill();
      g.restore();

      // --- water ON the glass: beads, and the tracks the runners leave
      for (const d of this.beads) {
        if (d.x < W.x || d.x >= W.x + W.w || d.y < W.y || d.y > W.y + W.h) continue;
        // the wet track above the bead, drying from the top down
        for (let k = 1; k < d.tail; k++) {
          const ty = d.y - k;
          if (ty < W.y) break;
          g.globalAlpha = 0.42 * (1 - k / d.tail);
          g.fillStyle = "#bcd8ff";
          g.fillRect(Math.round(d.x), Math.round(ty), 1, 1);
        }
        const size = d.big ? 2 : 1;
        g.globalAlpha = d.v > 0 ? 0.9 : 0.62;
        g.fillStyle = "#c3ddff";
        g.fillRect(Math.round(d.x), Math.round(d.y), size, size);
        // every bead is a tiny lens: one bright pixel where it catches the city
        g.globalAlpha = 1;
        g.fillStyle = "#ffffff";
        g.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
        if (d.big) {
          g.globalAlpha = 0.35;
          g.fillStyle = "#7fa8d8";
          g.fillRect(Math.round(d.x), Math.round(d.y) + 2, 2, 1);
        }
      }
      g.globalAlpha = 1;

      g.restore(); // end glass clip

      // --- mullions, quartering the pane
      const mx = W.x + Math.floor(W.w / 2);
      const my = W.y + Math.floor(W.h / 2);
      g.fillStyle = "#39405c";
      g.fillRect(mx - 1, W.y, 2, W.h);
      g.fillRect(W.x, my - 1, W.w, 2);
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(mx - 1, W.y, 1, W.h);
      g.fillRect(W.x, my - 1, W.w, 1);

      // --- frame
      g.fillStyle = "#2b3149";
      g.fillRect(W.x - 2, W.y - 2, W.w + 4, 2);
      g.fillRect(W.x - 2, W.y - 2, 2, W.h + 4);
      g.fillRect(W.x + W.w, W.y - 2, 2, W.h + 4);
      g.fillStyle = "#454e6b";
      g.fillRect(W.x - 2, W.y - 2, W.w + 4, 1);
      // sill, with the water that has run down the glass pooling on it
      g.fillStyle = "#4c5570";
      g.fillRect(W.x - 3, W.y + W.h, W.w + 6, 2);
      g.fillStyle = "#2b3149";
      g.fillRect(W.x - 3, W.y + W.h + 2, W.w + 6, 2);
      g.globalAlpha = 0.35;
      g.fillStyle = "#8fc0ff";
      for (let i = 0; i < 10; i++) {
        const sx = W.x + 3 + Math.floor(hash(wi * 300 + i) * (W.w - 6));
        if (Math.sin(this.t * 3 + i * 2) > 0.3) g.fillRect(sx, W.y + W.h, 1, 1);
      }
      g.globalAlpha = 1;

      // --- the blind, rolled up and left there since the summer
      g.fillStyle = "#3d4463";
      g.fillRect(W.x, W.y, W.w, 3);
      g.fillStyle = "#2a3049";
      g.fillRect(W.x, W.y + 3, W.w, 1);
      g.fillStyle = "#4a5474";
      g.fillRect(W.x, W.y, W.w, 1);
      g.fillStyle = "#6b7490";
      g.fillRect(W.x + 12, W.y + 4, 1, 5);
      g.fillRect(W.x + W.w - 13, W.y + 4, 1, 5);
      g.fillStyle = "#8892a6";
      g.fillRect(W.x + 12, W.y + 9, 1, 1);
      g.fillRect(W.x + W.w - 13, W.y + 9, 1, 1);
    }
  }

  private drawNeon() {
    const g = this.b;
    const online = !this.lightsOut;
    const flicker = online
      ? 0.75 + 0.25 * Math.sin(this.t * 9) * (Math.sin(this.t * 1.7) > 0.9 ? 0 : 1)
      : (Math.sin(this.t * 22) > 0.6 ? 0.5 : 0.12);
    const color = online ? "#ff3d7f" : "#ff5c5c";
    const label = online ? "NIGHTSHIFT" : "GATEWAY DOWN";
    g.save();
    g.globalAlpha = flicker;
    g.font = "8px Silkscreen, monospace";
    g.textBaseline = "top";
    g.shadowColor = color;
    g.shadowBlur = 6;
    g.fillStyle = color;
    const w = g.measureText(label).width;
    const x = Math.round(VW / 2 - w / 2);
    g.fillText(label, x, 40);
    g.restore();
    // the tube's own reflection on the wall below it
    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = flicker * 0.10;
    g.fillStyle = color;
    g.fillRect(x - 6, 38, w + 12, 12);
    g.restore();
  }

  /** Wall clock. It is always later than you think. */
  private drawClock() {
    const g = this.b;
    const ox = 114, oy = 6;
    g.drawImage(PROPS.clock, ox, oy);
    const cx = ox + 9, cy = oy + 9;
    const d = new Date();
    const hAng = (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    const mAng = (d.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2;
    const sAng = (d.getSeconds() / 60) * Math.PI * 2 - Math.PI / 2;
    g.lineWidth = 1;
    g.strokeStyle = "#c9cee0";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(hAng) * 4, cy + Math.sin(hAng) * 4); g.stroke();
    g.strokeStyle = "#e6e6f0";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(mAng) * 6, cy + Math.sin(mAng) * 6); g.stroke();
    g.strokeStyle = "#ff3d7f";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(sAng) * 6, cy + Math.sin(sAng) * 6); g.stroke();
    g.fillStyle = "#ffb454";
    g.fillRect(cx, cy, 1, 1);
  }

  /** everything bolted to the wall or standing against it */
  private drawFixtures() {
    const g = this.b;
    g.drawImage(PROPS.corkboard, 3, 8);
    g.drawImage(PROPS.vent, 7, 32);
    g.drawImage(PROPS.exitSign, 110, 30);
    g.drawImage(PROPS.whiteboard, 215, 4);
    g.drawImage(PROPS.fireExt, 228, 32);
    g.drawImage(PROPS.poster, 330, 4);
    // the exit sign is the only light in the room that never goes out
    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 0.16 + Math.sin(this.t * 2) * 0.02;
    g.fillStyle = "#6ee787";
    g.fillRect(108, 28, 14, 10);
    g.restore();
  }

  /** the service column down the left wall, and the right-hand storage run */
  private drawServiceColumn() {
    const g = this.b;

    // --- the rack. Eight blades, and the LEDs mean something: each pair is a
    // desk, green when it is working, amber when it is thinking, dark when
    // nobody is sitting there.
    g.drawImage(PROPS.rack, RACK_AT.x, RACK_AT.y);
    const byDesk = new Map<number, Agent>();
    for (const a of this.agents.values()) byDesk.set(a.worker.desk, a);
    const jam = this.t < this.printerUntil;
    RACK_LEDS.forEach((led, i) => {
      const desk = i >> 1;
      const a = byDesk.get(desk);
      const st = a?.worker.state;
      let col = "#12161f";
      if (this.lightsOut || jam) col = Math.sin(this.t * 8 + i) > 0 ? "#ff5c5c" : "#3a1414";
      else if (!a) col = "#161a24";
      else if (st === "typing") col = Math.sin(this.t * 14 + i * 2.3) > -0.2 ? "#6ee787" : "#1e4a2c";
      else if (st === "thinking") col = Math.sin(this.t * 5 + i) > 0 ? "#ffb454" : "#4a3414";
      else col = Math.sin(this.t * 1.2 + i * 1.7) > 0.6 ? "#35d6ff" : "#16303c";
      g.fillStyle = col;
      g.fillRect(RACK_AT.x + led.x, RACK_AT.y + led.y, 1, 1);
    });
    // the label somebody printed once and never updated
    g.font = "8px Silkscreen, monospace";
    g.textBaseline = "top";
    g.fillStyle = "#1b1405";
    g.fillText("OMNI", RACK_AT.x + RACK_PLATE.x + 1, RACK_AT.y + RACK_PLATE.y - 4);

    // --- printer
    g.drawImage(PROPS.printer, PRINTER_AT.x, PRINTER_AT.y);
    if (jam) {
      // a sheet, half fed, going nowhere
      const jitter = Math.sin(this.t * 30) > 0 ? 1 : 0;
      g.fillStyle = "#e6e6f0";
      g.fillRect(PRINTER_AT.x + 2, PRINTER_AT.y + 9 + jitter, 16, 2);
      g.fillStyle = "#ff5c5c";
      if (Math.sin(this.t * 6) > 0) g.fillRect(PRINTER_AT.x + 4, PRINTER_AT.y + 5, 1, 1);
      if (Math.sin(this.t * 5) > 0) {
        g.fillStyle = "#ff5c5c";
        g.fillText("!", PRINTER_AT.x + 22, PRINTER_AT.y + 2);
      }
    }

    g.drawImage(PROPS.trash, 4, 130);
    g.drawImage(PROPS.plant, 2, 168);

    // --- right-hand run
    g.drawImage(PROPS.cooler, COOLER_AT.x, COOLER_AT.y);
    // three bubbles climbing the bottle, because the cooler is never quiet
    for (let i = 0; i < 3; i++) {
      const by = COOLER_WATER.h - ((this.t * 6 + i * 3.3) % (COOLER_WATER.h + 1));
      g.globalAlpha = 0.5 + 0.4 * Math.sin(this.t * 3 + i);
      g.fillStyle = "#d8f6ff";
      g.fillRect(COOLER_AT.x + COOLER_WATER.x + 2 + i * 3, COOLER_AT.y + COOLER_WATER.y + Math.round(by), 1, 1);
    }
    g.globalAlpha = 1;
    g.drawImage(PROPS.filing, 338, 86);
    g.drawImage(PROPS.boxes, 340, 114);
    g.drawImage(PROPS.coatRack, 342, 130);
    g.drawImage(PROPS.plant, 344, 152);
  }

  /** the boss's corner: desk, phone, cold coffee, the lamp he leaves on */
  private drawBossDesk() {
    const g = this.b;
    const { x, y } = BOSS_DESK_AT;
    g.drawImage(PROPS.bossDesk, x, y);
    g.drawImage(PROPS.phone, x + 4, y - 4);
    g.drawImage(PROPS.cupSaucer, x + 21, y - 5);
    g.drawImage(PROPS.papers, x + 31, y - 4);
    g.drawImage(PROPS.lamp, x + 44, y - 9);
    // the lamp is on, and it is the warmest thing in the room
    g.save();
    g.globalCompositeOperation = "lighter";
    const grad = g.createRadialGradient(x + 47, y - 8, 1, x + 47, y - 8, 19);
    grad.addColorStop(0, "rgba(255,196,90,0.15)");
    grad.addColorStop(1, "rgba(255,196,90,0)");
    g.fillStyle = grad;
    g.fillRect(x + 28, y - 27, 38, 38);
    g.restore();
    // steam off the coffee he has not touched
    for (let i = 0; i < 2; i++) {
      const sy = y - 6 - ((this.t * 7 + i * 5) % 11);
      g.globalAlpha = Math.max(0, 0.35 - (y - 6 - sy) / 30);
      g.fillStyle = "#e6e6f0";
      g.fillRect(x + 24 + (i % 2), Math.round(sy), 1, 1);
    }
    g.globalAlpha = 1;
  }

  private drawDesk(cx: number, dy: number, a: Agent | null) {
    const g = this.b;
    const glow = a ? a.glow : 0;
    const active = a && (a.worker.state === "typing" || a.worker.state === "thinking");

    // --- chair, behind everything
    g.drawImage(PROPS.chair, cx - 8, dy - 30);

    // --- the person
    if (a) {
      const st = a.worker.state;
      const bob = st === "typing" ? Math.round(Math.sin(a.bob) * 1) : Math.round(Math.sin(a.bob * 0.6) * 0.6);
      let sprite = a.skin.idle;
      if (st === "typing") sprite = Math.floor(a.bob * 0.9) % 2 === 0 ? a.skin.type1 : a.skin.type2;
      else if (st === "burnt") sprite = a.skin.slump;
      else if (st === "asleep") sprite = a.skin.sleep;
      else if (st === "coffee") sprite = a.skin.sip;
      else if (a.blink < 0) sprite = a.skin.blink;
      g.drawImage(sprite, cx - 6, dy - 28 + bob);
    }

    // --- desk
    g.drawImage(PROPS.desk, cx - 19, dy);

    // --- monitor, then what is on the screen
    const mx = cx - 12, my = dy - 15;
    g.drawImage(PROPS.monitor, mx, my);
    const sx = mx + MONITOR_SCREEN.x;
    const sy = my + MONITOR_SCREEN.y;
    if (a) {
      g.save();
      g.beginPath();
      g.rect(sx, sy, MONITOR_SCREEN.w, MONITOR_SCREEN.h);
      g.clip();
      // code lines scrolling at the speed of the token stream
      const speed = 6 + a.screen * 34;
      for (let i = 0; i < 7; i++) {
        const off = (this.t * speed + i * 9) % (MONITOR_SCREEN.h + 2);
        const y = sy + MONITOR_SCREEN.h - off;
        const len = 3 + ((i * 5 + Math.floor((this.t * speed) / 4)) % 14);
        const indent = (i % 3) * 2;
        g.fillStyle = a.worker.state === "burnt" ? "#ff5c5c" : i % 4 === 0 ? "#6ee787" : i % 4 === 1 ? "#ffb454" : "#35d6ff";
        g.globalAlpha = 0.35 + a.screen * 0.5;
        g.fillRect(sx + 1 + indent, Math.round(y), Math.min(len, MONITOR_SCREEN.w - 3 - indent), 1);
      }
      g.globalAlpha = 1;
      // caret
      if (Math.sin(this.t * 6) > 0) {
        g.fillStyle = "#e6e6f0";
        g.fillRect(sx + 1, sy + MONITOR_SCREEN.h - 2, 2, 1);
      }
      // scrollbar, pinned to the bottom like a real log
      g.fillStyle = "rgba(120,140,180,0.35)";
      g.fillRect(sx + MONITOR_SCREEN.w - 1, sy + MONITOR_SCREEN.h - 4, 1, 4);
      g.restore();

      // screen light spilling back onto the face and the desk
      if (glow > 0.02 || active) {
        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.10 + glow * 0.14;
        g.fillStyle = "#35d6ff";
        g.fillRect(cx - 7, dy - 26, 14, 10);
        g.globalAlpha = 0.05 + glow * 0.06;
        g.fillRect(cx - 16, dy, 32, 3);
        g.restore();
      }
      if (a.flash > 0) {
        g.save();
        g.globalAlpha = a.flash * 0.5;
        g.fillStyle = "#ff5c5c";
        g.fillRect(cx - 20, dy - 30, 40, 34);
        g.restore();
      }
    }

    // --- what is on the desk. Further back sits higher; that is the depth cue.
    if (a) {
      const cl = PROPS[a.clutter];
      g.drawImage(cl, cx - 19, dy + 1 - cl.height);
      g.drawImage(PROPS.mug, cx + 12, dy - 7);
      if (a.worker.morale < 40) g.drawImage(PROPS.mugEmpty, cx + 3, dy - 7);
    }
    g.drawImage(PROPS.keyboard, cx - 12, dy - 1);
    g.drawImage(PROPS.mousepad, cx + 6, dy - 1);
    g.drawImage(PROPS.mouse, cx + 8, dy - 1);

    if (a) {
      // --- state tells, above the head
      if (a.worker.state === "asleep") {
        g.font = "8px Silkscreen, monospace";
        g.fillStyle = "#8892a6";
        g.fillText("z", cx + 7, dy - 32 - Math.sin(this.t * 2) * 2);
      }
      if (a.worker.state === "thinking") {
        // three dots, one at a time, while the model chews on it
        const n = Math.floor(this.t * 3) % 3;
        for (let i = 0; i <= n; i++) {
          g.fillStyle = "#ffb454";
          g.fillRect(cx - 3 + i * 3, dy - 33, 2, 2);
        }
      }
      if (a.worker.state === "coffee") {
        for (let i = 0; i < 3; i++) {
          const yy = dy - 20 - ((this.t * 9 + i * 4) % 10);
          g.globalAlpha = Math.max(0, 0.5 - (dy - 20 - yy) / 24);
          g.fillStyle = "#e6e6f0";
          g.fillRect(cx - 5 + (i % 2), Math.round(yy), 1, 1);
        }
        g.globalAlpha = 1;
      }
      // steam off the mug that is always there
      if (a.worker.state !== "asleep") {
        for (let i = 0; i < 2; i++) {
          const yy = dy - 8 - ((this.t * 5 + i * 4) % 9);
          g.globalAlpha = Math.max(0, 0.28 - (dy - 8 - yy) / 34);
          g.fillStyle = "#e6e6f0";
          g.fillRect(cx + 13 + (i % 2), Math.round(yy), 1, 1);
        }
        g.globalAlpha = 1;
      }

      // --- nameplate, screwed to the front of the desk
      g.font = "8px Silkscreen, monospace";
      g.textBaseline = "top";
      const label = a.worker.name.split(" ")[0].toUpperCase();
      const w = g.measureText(label).width;
      const px = Math.round(cx - w / 2 - 3);
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(px + 1, dy + 8, w + 6, 11);
      g.fillStyle = "#1b2036";
      g.fillRect(px, dy + 7, w + 6, 11);
      g.fillStyle = this.selected === a.worker.id ? "#ffb454" : "#39405c";
      g.fillRect(px, dy + 7, w + 6, 1);
      g.fillRect(px, dy + 7, 1, 11);
      g.fillStyle = this.selected === a.worker.id ? "#ffb454" : "#a8b2ca";
      g.fillText(label, Math.round(cx - w / 2), dy + 9);

      // which model is actually sitting there — clipped so desks never collide
      let model = a.worker.model.split("/").pop() ?? a.worker.model;
      const MAXW = 62;
      if (g.measureText(model).width > MAXW) {
        while (model.length > 3 && g.measureText(`${model}.`).width > MAXW) model = model.slice(0, -1);
        model = `${model}.`;
      }
      const mw = g.measureText(model).width;
      g.globalAlpha = 0.72;
      g.fillStyle = a.worker.model === "auto" ? "#7d879e" : "#35d6ff";
      g.fillText(model, Math.round(cx - mw / 2), dy + 20);
      g.globalAlpha = 1;
    } else {
      g.font = "8px Silkscreen, monospace";
      g.textBaseline = "top";
      g.globalAlpha = 0.55 + Math.sin(this.t * 1.4 + cx) * 0.18;
      g.fillStyle = "#8892a6";
      const label = "vacant";
      const w = g.measureText(label).width;
      g.fillText(label, Math.round(cx - w / 2), dy + 20);
      g.globalAlpha = 1;
    }

    if (a && this.selected === a.worker.id) {
      const dash = Math.floor(this.t * 8) % 2 === 0;
      g.strokeStyle = dash ? "#ffb454" : "#ff3d7f";
      g.lineWidth = 1;
      g.strokeRect(cx - 20.5, dy - 31.5, 41, 51);
    }
  }

  private drawBoss() {
    const g = this.b;
    const { x, y } = this.boss;
    const frame = this.boss.walking
      ? this.bossSkin.walk[Math.floor(this.boss.frame) % 4]
      : this.boss.talk > 0
        ? (Math.floor(this.t * 6) % 2 === 0 ? this.bossSkin.talk : this.bossSkin.point)
        : this.bossSkin.stand;

    // he brings his own lighting
    g.save();
    g.globalCompositeOperation = "lighter";
    const grad = g.createRadialGradient(x, y - 8, 2, x, y - 8, 30);
    grad.addColorStop(0, "rgba(217,119,87,0.16)");
    grad.addColorStop(1, "rgba(217,119,87,0)");
    g.fillStyle = grad;
    g.fillRect(x - 32, y - 40, 64, 64);
    g.restore();

    // shadow
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(Math.round(x) - 5, Math.round(y) + 1, 10, 2);
    g.fillRect(Math.round(x) - 3, Math.round(y) + 3, 6, 1);
    g.save();
    g.translate(Math.round(x), Math.round(y) - 18);
    if (this.boss.dir < 0) { g.scale(-1, 1); g.drawImage(frame, -6, 0); }
    else g.drawImage(frame, -6, 0);
    g.restore();
  }

  private drawTray() {
    const g = this.b;
    g.drawImage(PROPS.tray, TRAY.x - 11, TRAY.y - 8);
    const stack = Math.min(8, this.trayCount);
    for (let i = 0; i < stack; i++) {
      g.fillStyle = i % 2 ? "#e6e6f0" : "#cfd3e2";
      g.fillRect(TRAY.x - 9, TRAY.y - 10 - i * 2, 18, 2);
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(TRAY.x - 9, TRAY.y - 9 - i * 2, 18, 1);
    }
    g.font = "8px Silkscreen, monospace";
    g.textBaseline = "top";
    g.fillStyle = "#1b1405";
    g.fillText("IN", TRAY.x - 11 + TRAY_PLATE.x, TRAY.y - 8 + TRAY_PLATE.y - 4);
    if (this.trayCount) {
      g.fillStyle = "#ffb454";
      g.fillText(String(this.trayCount), TRAY.x + 14, TRAY.y - 14);
    }
  }

  private drawBubble(bb: Bubble, taken: { x: number; y: number; w: number; h: number }[]) {
    const g = this.b;
    let x = bb.x, y = bb.y;
    if (bb.follow === "boss") { x = this.boss.x; y = this.boss.y - 24; }
    else if (typeof bb.follow === "number") {
      const p = deskPos(bb.follow);
      x = p.cx; y = p.dy - 34;
    }

    g.font = "8px Silkscreen, monospace";
    g.textBaseline = "top";
    const maxW = 118;
    const words = bb.text.replace(/\s+/g, " ").split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; }
      else cur = test;
      if (lines.length >= 4) break;
    }
    if (cur && lines.length < 4) lines.push(cur);
    if (!lines.length) return;
    if (lines.length === 4) lines[3] = lines[3].slice(0, 22) + "...";

    const w = Math.min(maxW, Math.max(...lines.map((l) => g.measureText(l).width))) + 8;
    const h = lines.length * 9 + 7;
    // keep bubbles inside what the camera can actually see
    const viewLeft = -this.cam.x + 2;
    const viewRight = -this.cam.x + this.view.bw - w - 2;
    const viewTop = -this.cam.y + 2;
    let bx = Math.round(x - w / 2);
    let by = Math.round(y - h);
    bx = Math.max(viewLeft, Math.min(viewRight, bx));
    by = Math.max(viewTop, by);

    // two people talking at once shouldn't print over each other
    const hits = (ay: number) =>
      taken.some((r) => bx < r.x + r.w + 2 && bx + w + 2 > r.x && ay < r.y + r.h + 2 && ay + h + 2 > r.y);
    for (let tries = 0; tries < 6 && hits(by); tries++) by = Math.max(2, by - (h + 3));
    taken.push({ x: bx, y: by, w, h });

    const border = bb.kind === "boss" ? "#d97757" : "#4a5266";
    const fill = bb.kind === "boss" ? "#1a1420" : "#12151f";
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.fillRect(bx + 1, by + 2, w, h);
    g.fillStyle = fill;
    g.fillRect(bx, by, w, h);
    g.fillStyle = border;
    g.fillRect(bx, by, w, 1);
    g.fillRect(bx, by + h - 1, w, 1);
    g.fillRect(bx, by, 1, h);
    g.fillRect(bx + w - 1, by, 1, h);
    // tail
    g.fillRect(Math.round(x) - 2, by + h, 4, 2);
    g.fillRect(Math.round(x) - 1, by + h + 2, 2, 2);

    g.fillStyle = bb.kind === "boss" ? "#f2d7c9" : "#c9cee0";
    lines.forEach((l, i) => g.fillText(l, bx + 4, by + 4 + i * 9));
  }

  private draw() {
    this.measure();
    if (!this.userMoved) {
      this.cam.x = Math.round((this.view.bw - VW) / 2);
      this.cam.y = Math.round((this.view.bh - VH) / 2);
    }
    this.clampCam();

    const g = this.b;
    const { bw, bh } = this.view;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);

    // the office keeps going past the room: floor everywhere, wall along the top
    g.save();
    g.translate(this.cam.x, this.cam.y);
    if (this.floorPattern) {
      g.fillStyle = this.floorPattern;
      g.fillRect(-this.cam.x, -this.cam.y, bw, bh);
    }
    const wallTop = -this.cam.y;
    if (wallTop < 58) this.paintWall(g, -this.cam.x, bw);
    // and the room itself sits on top of it
    if (this.bg) g.drawImage(this.bg, 0, 0);

    this.drawWindows();
    this.drawClock();
    this.drawFixtures();
    this.drawNeon();
    this.drawServiceColumn();

    // the cat, and its tail, which is the only part of it that is ever busy
    const sitting = Math.hypot(this.cat.tx - this.cat.x, this.cat.ty - this.cat.y) < 1.5;
    const catImg = sitting && this.cat.sitUntil === 0 ? PROPS.catLoaf : PROPS.cat;
    const cbob = sitting ? Math.round(Math.sin(this.t * 0.8)) : 0;
    g.drawImage(catImg, Math.round(this.cat.x), Math.round(this.cat.y) + cbob);
    g.fillStyle = "#6b5f80";
    g.fillRect(
      Math.round(this.cat.x) + 9,
      Math.round(this.cat.y) + cbob + 4 + Math.round(Math.sin(this.cat.tail) * 2),
      1, 2,
    );

    // pizza on the rug, while it lasts
    if (this.t < this.pizzaUntil) {
      g.drawImage(PROPS.pizza, 170, 200);
      if (Math.sin(this.t * 3) > 0.4) {
        g.fillStyle = "rgba(255,209,102,0.5)";
        g.fillRect(176 + Math.round(Math.sin(this.t * 2) * 2), 196, 1, 2);
      }
    }

    this.drawTray();
    this.drawBossDesk();

    // desks: back row first so the front row overlaps correctly
    const byDesk = new Map<number, Agent>();
    for (const a of this.agents.values()) byDesk.set(a.worker.desk, a);
    for (let i = 0; i < 8; i++) {
      const p = deskPos(i);
      this.drawDesk(p.cx, p.dy, byDesk.get(i) ?? null);
      if (i === 3) this.drawBossIfBehind();
    }

    if (this.boss.y > ROW_Y[0] + 10) this.drawBoss();

    // papers in flight
    for (const p of this.papers) {
      const t = p.t;
      const x = p.x + (p.tx - p.x) * t;
      const y = p.y + (p.ty - p.y) * t - Math.sin(t * Math.PI) * 26;
      g.save();
      g.translate(Math.round(x), Math.round(y));
      g.rotate(t * 6);
      g.fillStyle = "#e6e6f0";
      g.fillRect(-3, -2, 6, 4);
      g.fillStyle = "#8892a6";
      g.fillRect(-2, -1, 4, 1);
      g.restore();
    }

    // confetti (promotions) and whatever a leaver kicks up
    for (const p of this.confetti) {
      const a = 1 - p.life / p.max;
      g.globalAlpha = Math.max(0, a);
      g.fillStyle = p.color;
      g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    }
    g.globalAlpha = 1;

    // puffs
    for (const p of this.puffs) {
      const a = 1 - p.life / p.max;
      g.globalAlpha = a;
      g.fillStyle = p.color;
      const s = a > 0.6 ? 2 : 1;
      g.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    }
    g.globalAlpha = 1;

    // night grade: a cold wash, heavier when the gateway is dead
    g.save();
    g.globalCompositeOperation = "multiply";
    let wash = this.lightsOut ? "#8e90c0" : "#dedaf5";
    if (this.flicker > 0) {
      // mains trouble: the room stutters between dim and dark
      const beat = Math.sin(this.t * 26) > 0 ? 0 : 1;
      wash = beat ? "#4a4d70" : "#a8a8d0";
    }
    g.fillStyle = wash;
    g.fillRect(-this.cam.x, -this.cam.y, bw, bh);
    g.restore();

    // warm pools of light under the monitors, and the dust that lives in them
    g.save();
    g.globalCompositeOperation = "lighter";
    for (const a of this.agents.values()) {
      const p = deskPos(a.worker.desk);
      const strength = 0.05 + (a.worker.state === "typing" ? 0.09 : 0.03) + a.glow * 0.06;
      const grad = g.createRadialGradient(p.cx, p.dy - 8, 2, p.cx, p.dy - 8, 34);
      grad.addColorStop(0, `rgba(90,190,255,${strength})`);
      grad.addColorStop(1, "rgba(90,190,255,0)");
      g.fillStyle = grad;
      g.fillRect(p.cx - 36, p.dy - 44, 72, 72);
      for (let i = 0; i < 4; i++) {
        const seed = a.worker.seed + i * 37;
        const dx = ((hash(seed) * 40) + Math.sin(this.t * 0.4 + i * 2) * 6) - 20;
        const dyy = -30 + ((this.t * 3 + hash(seed + 1) * 40) % 40);
        g.globalAlpha = 0.12;
        g.fillStyle = "#cfe4ff";
        g.fillRect(Math.round(p.cx + dx), Math.round(p.dy + dyy), 1, 1);
        g.globalAlpha = 1;
      }
    }
    g.restore();

    // the lightning reaches inside
    if (this.storm > 0.01) {
      g.save();
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = this.storm * this.storm * 0.35;
      g.fillStyle = "#8fb4ff";
      g.fillRect(-this.cam.x, -this.cam.y, bw, bh);
      g.restore();
    }

    // whichever desk the mouse is over gets a hint outline
    if (this.mouse.over !== null) {
      const p = deskPos(this.mouse.over);
      const occupied = [...this.agents.values()].some((a) => a.worker.desk === this.mouse.over);
      g.strokeStyle = occupied ? "rgba(255,180,84,0.5)" : "rgba(107,116,144,0.5)";
      g.lineWidth = 1;
      g.strokeRect(p.cx - 20.5, p.dy - 31.5, 41, 51);
    }

    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const bb of this.bubbles) this.drawBubble(bb, placed);

    g.restore();

    // present: the buffer already matches the viewport, so it just scales up whole
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const needW = Math.max(1, Math.round(rect.width));
    const needH = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== needW || this.canvas.height !== needH) {
      this.canvas.width = needW;
      this.canvas.height = needH;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const shakeX = this.shake > 0 ? Math.round((Math.random() - 0.5) * 6 * this.shake) : 0;
    const shakeY = this.shake > 0 ? Math.round((Math.random() - 0.5) * 6 * this.shake) : 0;
    ctx.drawImage(this.buf, 0, 0, bw, bh, shakeX, shakeY, bw * this.zoom, bh * this.zoom);
  }

  private drawBossIfBehind() {
    if (this.boss.y <= ROW_Y[0] + 10) this.drawBoss();
  }
}
