// Render the real FloorScene to a PNG, headless, so pixel art can be reviewed.
//   npx tsx tools/scene-shot.mts <outDir> [seconds]
import fs from "node:fs";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { installDom, makeCanvas, Canvas } from "./canvas-shim.mts";

const clock = installDom();

const { FloorScene, VW, VH } = await import("../web/src/pixel/scene.ts");
const types = await import("../shared/types.ts");
void types;

const outDir = process.argv[2] ?? ".";
fs.mkdirSync(outDir, { recursive: true });

const ZOOM = 3;
const canvas = makeCanvas(VW * ZOOM, VH * ZOOM) as unknown as Canvas;
const scene = new FloorScene(canvas as unknown as HTMLCanvasElement);

const MODELS = [
  "z-ai/glm-4.7", "qwen/qwen3-coder", "deepseek/deepseek-chat", "moonshot/kimi-k2",
  "google/gemma-3-27b", "auto", "mistral/devstral", "nvidia/nemotron",
];
const NAMES = ["ARDA", "NEZIH", "SELIN", "BORA", "EDA", "KEREM", "MELIS", "TUNA"];
const STATES = ["typing", "thinking", "typing", "coffee", "asleep", "burnt", "idle", "typing"] as const;

const workers = Array.from({ length: 7 }, (_, i) => ({
  id: `w_${i}`,
  name: NAMES[i],
  title: "operator",
  model: MODELS[i],
  desk: i,
  seed: 1337 + i * 7919,
  state: STATES[i],
  morale: i === 5 ? 22 : 70,
  currentTaskId: null,
  hiredAt: 0,
  stats: { tasksDone: 3, tasksFailed: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, msTotal: 0, streak: 1 },
  saying: null,
}));

scene.sync({
  workers,
  tasks: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, stage: "review" })),
  jobs: [],
  gateway: { online: true, baseUrl: "", hasKey: false, modelCount: 0, lastCheck: 0, error: null },
  ledger: { costUsd: 0, tokensIn: 0, tokensOut: 0, tasksDone: 0, tasksFailed: 0, shiftStartedAt: 0 },
  settings: { autoAssign: true, ghostMode: false, maxParallel: 4, defaultModel: "auto" },
} as never);

scene.event({ id: "e1", ts: 0, type: "office", data: { kind: "pizza" } } as never);
scene.event({ id: "e2", ts: 0, type: "office", data: { kind: "printer" } } as never);

// drive the loop by hand: no rAF, just step time and draw
const s = scene as unknown as { update(dt: number): void; draw(): void; t: number; last: number; storm: number };
const SECONDS = Number(process.argv[3] ?? 9);
const STEP = 1 / 60;
for (let i = 0; i < SECONDS / STEP; i++) {
  clock.now += STEP * 1000;
  s.t += STEP;
  s.update(STEP);
}
s.storm = 0;   // no lightning in the still, it washes everything out
s.draw();

fs.writeFileSync(path.join(outDir, "scene.png"), encodePNG(canvas.width, canvas.height, canvas.data));

// close-ups, so the small stuff can actually be inspected
function closeUp(file: string, wx: number, wy: number, ww: number, wh: number, zoom: number, warm = 12) {
  const c = makeCanvas(ww * zoom, wh * zoom) as unknown as Canvas;
  const sc = new FloorScene(c as unknown as HTMLCanvasElement);
  const p = sc as unknown as {
    update(dt: number): void; draw(): void; t: number; zoom: number;
    cam: { x: number; y: number }; userMoved: boolean; storm: number; sync(s: unknown): void;
  };
  p.sync({
    workers, tasks: [{ id: "t", stage: "review" }], jobs: [],
    gateway: { online: true, baseUrl: "", hasKey: false, modelCount: 0, lastCheck: 0, error: null },
    ledger: { costUsd: 0, tokensIn: 0, tokensOut: 0, tasksDone: 0, tasksFailed: 0, shiftStartedAt: 0 },
    settings: { autoAssign: true, ghostMode: false, maxParallel: 4, defaultModel: "auto" },
  });
  p.zoom = zoom;
  for (let i = 0; i < warm / STEP; i++) { p.t += STEP; p.update(STEP); }
  p.userMoved = true;
  p.cam = { x: -wx, y: -wy };
  p.storm = 0;
  p.draw();
  fs.writeFileSync(path.join(outDir, file), encodePNG(c.width, c.height, c.data));
}

closeUp("window.png", 128, 1, 120, 60, 6);
closeUp("desk.png", 18, 56, 120, 76, 8);
closeUp("boss.png", 264, 160, 100, 76, 8);

console.log(`wrote scene.png (${canvas.width}x${canvas.height}), window.png, desk.png, boss.png`);
