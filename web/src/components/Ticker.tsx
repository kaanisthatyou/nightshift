import { useFloor } from "../store.ts";

const NOTES = [
  "coffee machine is out of order since march",
  "the boss never sleeps and neither do you",
  "free models are still models",
  "press / to focus the order bar",
  "click a desk to pick who gets the next order",
  "approve or send work back — they remember",
  "pipelines feed one desk's output into the next",
];

export default function Ticker() {
  const state = useFloor((s) => s.state);
  const models = useFloor((s) => s.models);
  const busy = state?.workers.filter((w) => w.state === "typing" || w.state === "thinking").length ?? 0;
  const queued = state?.tasks.filter((t) => t.stage === "queued").length ?? 0;

  const line = [
    `${state?.workers.length ?? 0} on shift`,
    `${busy} heads down`,
    `${queued} in the queue`,
    `${models.filter((m) => m.free).length} free models on the board`,
    ...NOTES,
  ].join("  ·  ");

  return (
    <div className="ticker">
      <span className="run">
        <b>NIGHTSHIFT</b> · {line} · <b>NIGHTSHIFT</b> · {line}
      </span>
    </div>
  );
}
