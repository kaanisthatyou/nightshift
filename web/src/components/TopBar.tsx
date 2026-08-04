import { useEffect, useState } from "react";
import { useFloor } from "../store.ts";

function shiftClock(startedAt: number) {
  // the shift starts at 22:00 and one real minute is one office minute
  const mins = Math.floor((Date.now() - startedAt) / 60000);
  const h = (22 + Math.floor(mins / 60)) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export default function TopBar() {
  const state = useFloor((s) => s.state);
  const connected = useFloor((s) => s.connected);
  const models = useFloor((s) => s.models);
  const [, tickState] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tickState((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const led = state?.gateway.online ? "led on" : "led";
  const freeCount = models.filter((m) => m.free).length;
  const unpricedCount = models.filter((m) => m.unpriced).length;
  const cost = state?.ledger.costUsd ?? 0;

  return (
    <header className="topbar">
      <span className="logo">
        NIGHT<b>SHIFT</b>
      </span>
      <span className="stat">
        <i className={led} />
        <b>{state?.gateway.online ? "OMNIROUTE UP" : "GATEWAY DOWN"}</b>
      </span>
      <span className="stat free" title="models the gateway reported no price for are counted separately - unpriced is not the same as free">
        MODELS <b>{models.length}</b> / FREE <b>{freeCount}</b>
        {unpricedCount > 0 && <> / UNPRICED <b>{unpricedCount}</b></>}
      </span>
      <span className="spacer" />
      <span className="stat">
        SHIFT <b>{state ? shiftClock(state.ledger.shiftStartedAt) : "--:--"}</b>
      </span>
      <span className="stat">
        DONE <b>{state?.ledger.tasksDone ?? 0}</b> / FAIL <b>{state?.ledger.tasksFailed ?? 0}</b>
      </span>
      <span className="stat">
        TOK <b>{((state?.ledger.tokensIn ?? 0) + (state?.ledger.tokensOut ?? 0)).toLocaleString()}</b>
      </span>
      <span className="stat money" title="only counts models the gateway gave a price for">
        PAYROLL <b>${cost < 0.01 && cost > 0 ? cost.toFixed(5) : cost.toFixed(4)}</b>
      </span>
      {!connected && <span className="chip bad">SOCKET DOWN</span>}
    </header>
  );
}
