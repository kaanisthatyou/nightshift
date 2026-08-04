// Same prompt, several desks, one winner. The only fair way to pick a model.
import { useState } from "react";
import { post, useFloor } from "../store.ts";
import Portrait from "./Portrait.tsx";
import type { Task } from "../../../shared/types.ts";

const fmtMs = (ms: number) => (ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export default function Arena() {
  const state = useFloor((s) => s.state);
  const streams = useFloor((s) => s.streams);
  const openTask = useFloor((s) => s.openTaskPanel);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workers = state?.workers ?? [];
  const bout: Task[] = (state?.tasks ?? []).filter((t) => t.arenaId && t.arenaId === arenaId);
  const past = [...new Set((state?.tasks ?? []).filter((t) => t.arenaId).map((t) => t.arenaId!))].reverse();

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  async function run() {
    const t = text.trim();
    const picked = chosen.length ? chosen : workers.map((w) => w.id);
    if (!t || picked.length < 2 || busy) return;
    setBusy(true);
    try {
      const r = await post<{ arenaId: string }>("/arena", { text: t, workerIds: picked });
      setArenaId(r.arenaId);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  const fastest = bout.filter((t) => t.latencyMs > 0).sort((a, b) => a.latencyMs - b.latencyMs)[0];
  const shortest = bout.filter((t) => t.output).sort((a, b) => a.output.length - b.output.length)[0];

  return (
    <>
      <div className="file">
        <div className="form-title">
          the arena <span className="form-no">same prompt, {chosen.length || workers.length} desks</span>
        </div>
        <textarea
          style={{ width: "100%", height: 64, marginBottom: 6 }}
          placeholder="one prompt. every desk answers it. you pick the winner."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="contenders">
          {workers.map((w) => {
            const on = chosen.includes(w.id) || (!chosen.length && true);
            return (
              <button
                key={w.id}
                className={`contender ${chosen.includes(w.id) ? "on" : chosen.length ? "off" : "on"}`}
                onClick={() => toggle(w.id)}
                title={`${w.name} · ${w.model}`}
              >
                <Portrait worker={w} size={3} />
                <span className="ell">{w.name.split(" ")[0]}</span>
                <span className="sub ell">{(w.model.split("/").pop() ?? "").slice(0, 11)}</span>
                {(w.stats.wins ?? 0) > 0 && <span className="wins">★{w.stats.wins}</span>}
                {!on && <span />}
              </button>
            );
          })}
        </div>
        <div className="file-actions">
          <span className="hint grow">
            {workers.length < 2 ? "you need at least two desks" : "click portraits to narrow the field"}
          </span>
          <button className="btn primary mini" disabled={busy || workers.length < 2 || !text.trim()} onClick={() => void run()}>
            {busy ? "sending..." : "ring the bell"}
          </button>
        </div>
      </div>

      {bout.length > 0 && (
        <div className="file">
          <div className="form-title">
            round <span className="form-no">{bout.filter((t) => t.stage === "review" || t.stage === "done").length}/{bout.length} back</span>
          </div>
          <div className="hint" style={{ marginBottom: 6 }}>
            fastest and shortest are marked automatically. the winner is your call.
          </div>
        </div>
      )}

      {bout.map((t) => {
        const w = state?.workers.find((x) => x.id === t.workerId);
        const live = t.stage === "running" ? streams[t.id] ?? "" : "";
        const body = live || t.output || t.error || "";
        return (
          <div className={`file bout ${t.wonArena ? "won" : ""}`} key={t.id}>
            <div className="file-head">
              {w && <Portrait worker={w} size={3} />}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="name ell">{w?.name ?? "gone"}</div>
                <div className="sub ell">{t.model}</div>
                <div className="row wrap" style={{ marginTop: 4 }}>
                  {t.latencyMs > 0 && (
                    <span className={`chip ${fastest?.id === t.id ? "ok" : ""}`}>
                      {fmtMs(t.latencyMs)}{fastest?.id === t.id ? " fastest" : ""}
                    </span>
                  )}
                  {t.tokensOut > 0 && (
                    <span className={`chip ${shortest?.id === t.id ? "free" : ""}`}>
                      {t.tokensOut} out{shortest?.id === t.id ? " shortest" : ""}
                    </span>
                  )}
                  {t.ghost && <span className="chip ghost">ghost</span>}
                  {t.fallbackFrom && <span className="chip bad">fell back</span>}
                </div>
              </div>
              {t.wonArena && <span className="stamp state-delivering">winner</span>}
            </div>
            <div className={`mono-out ${live ? "live" : ""}`} style={{ maxHeight: 130 }} onClick={() => openTask(t.id)}>
              {body || (t.stage === "queued" ? "waiting for a free desk..." : "thinking...")}
            </div>
            <div className="file-actions">
              <button className="btn mini" onClick={() => openTask(t.id)}>
                read it all
              </button>
              <span className="grow" />
              <button
                className="btn primary mini"
                disabled={!t.output || t.stage === "running"}
                onClick={() => void post(`/arena/${t.arenaId}/winner`, { taskId: t.id })}
              >
                this one wins
              </button>
            </div>
          </div>
        );
      })}

      {!bout.length && past.length > 0 && (
        <div className="file">
          <div className="form-title">past rounds</div>
          {past.slice(0, 6).map((a) => {
            const ts = (state?.tasks ?? []).filter((t) => t.arenaId === a);
            const won = ts.find((t) => t.wonArena);
            return (
              <div className="row" key={a} style={{ marginBottom: 4 }}>
                <span className="sub ell grow">{ts[0]?.title.replace("arena · ", "")}</span>
                {won ? <span className="chip ok ell" style={{ maxWidth: 110 }}>{(won.model ?? "").split("/").pop()}</span> : <span className="chip">no call</span>}
                <button className="btn mini" onClick={() => setArenaId(a)}>
                  open
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
