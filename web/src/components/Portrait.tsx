// The same sprite that sits at the desk, stapled to their file.
import { useEffect, useMemo, useRef, useState } from "react";
import { makeWorkerSkin, type WorkerSkin } from "../pixel/sprites.ts";
import type { Worker } from "../../../shared/types.ts";

const cache = new Map<number, WorkerSkin>();
function skinFor(seed: number): WorkerSkin {
  let s = cache.get(seed);
  if (!s) {
    s = makeWorkerSkin(seed);
    cache.set(seed, s);
  }
  return s;
}

export default function Portrait({ worker, size = 4 }: { worker: Worker; size?: number }) {
  const skin = useMemo(() => skinFor(worker.seed), [worker.seed]);
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);

  // only the ones actually working need to animate
  useEffect(() => {
    if (worker.state !== "typing") return;
    const t = setInterval(() => setTick((n) => n + 1), 240);
    return () => clearInterval(t);
  }, [worker.state]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const src =
      worker.state === "typing" ? (tick % 2 ? skin.type2 : skin.type1)
      : worker.state === "burnt" ? skin.slump
      : worker.state === "coffee" ? skin.sip
      : worker.state === "asleep" ? skin.sleep
      : skin.idle;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0);
  }, [skin, worker.state, tick]);

  return (
    <div className={`portrait state-${worker.state}`} style={{ width: 12 * size, height: 14 * size }}>
      <canvas ref={ref} width={12} height={14} style={{ width: 12 * size, height: 14 * size }} />
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
    </div>
  );
}
