import { post, useFloor } from "../store.ts";

export default function TaskModal() {
  const openTask = useFloor((s) => s.openTask);
  const close = useFloor((s) => s.openTaskPanel);
  const state = useFloor((s) => s.state);
  const streams = useFloor((s) => s.streams);
  const t = state?.tasks.find((x) => x.id === openTask);
  if (!t) return null;
  const worker = state?.workers.find((w) => w.id === t.workerId);
  const live = t.stage === "running" ? streams[t.id] ?? "" : "";
  const body = live || t.output || t.error || "(nothing yet)";

  return (
    <div className="modal-back" onClick={() => close(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t.title} <span className="chip">{t.stage}</span>
        </h3>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {worker && <span className="chip">{worker.name} · desk {worker.desk + 1}</span>}
          {t.model && <span className="chip">{t.model}</span>}
          {t.decision && <span className="chip">via {t.decision}</span>}
          {t.ghost && <span className="chip ghost">ghost output · nothing was sent to a model</span>}
          {t.fallbackFrom && (
            <span className="chip bad">{t.fallbackFrom} was not served · omniroute routed this one</span>
          )}
          <span className="chip">{t.tokensIn} in / {t.tokensOut} out</span>
          {t.latencyMs > 0 && <span className="chip">{(t.latencyMs / 1000).toFixed(1)}s</span>}
          <span className="chip paid">${t.costUsd.toFixed(6)}</span>
          <span className="chip">try #{t.attempts}</span>
        </div>

        <div className="sub" style={{ marginBottom: 4 }}>the order</div>
        <div className="mono-out" style={{ maxHeight: 120, marginBottom: 10 }}>{t.sentPrompt || t.prompt}</div>

        <div className="sub" style={{ marginBottom: 4 }}>what came back {live && "· live"}</div>
        <div className={`mono-out ${live ? "live" : ""}`} style={{ maxHeight: 320 }}>{body}</div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn mini" onClick={() => void navigator.clipboard.writeText(t.output)}>
            copy output
          </button>
          <span className="grow" />
          {t.stage === "review" && (
            <>
              <button
                className="btn mini danger"
                onClick={() => {
                  const note = prompt("what's wrong with it?", "yeterince net degil.");
                  if (note) void post(`/tasks/${t.id}/reject`, { note });
                }}
              >
                send back
              </button>
              <button className="btn primary mini" onClick={() => void post(`/tasks/${t.id}/approve`)}>
                approve
              </button>
            </>
          )}
          {(t.stage === "failed" || t.stage === "done") && (
            <button className="btn mini" onClick={() => void post(`/tasks/${t.id}/retry`)}>
              run again
            </button>
          )}
          <button className="btn mini ghost" onClick={() => close(null)}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
