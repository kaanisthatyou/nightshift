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
          {t.workspace && (
            <span className="chip ell" style={{ maxWidth: 220 }} title={t.workspace}>
              in {t.workspace.split(/[\\/]/).pop()}
            </span>
          )}
        </div>

        {t.workspace && (
          <>
            <div className="sub" style={{ marginBottom: 4 }}>
              what landed on disk {t.files.length ? "" : "· nothing yet"}
            </div>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              {t.claims.length > 0 && t.claims[0] !== "**" && (
                <span className="chip" title="the only files this desk was allowed to touch">
                  owns {t.claims.join(", ")}
                </span>
              )}
              {t.files.map((f) => (
                <span key={f.path} className="chip ok" title={`${f.action} · ${f.bytes} bytes`}>
                  {f.action === "edit" ? "~" : "+"} {f.path}
                </span>
              ))}
            </div>
          </>
        )}

        {t.verifyRuns.length > 0 && (
          <>
            <div className="sub" style={{ marginBottom: 4 }}>
              the check · ran {t.verifyRuns.length}×
            </div>
            <div className="row wrap" style={{ marginBottom: 4 }}>
              <span className={`chip ${t.verifyRuns.at(-1)!.ok ? "ok" : "bad"}`}>
                $ {t.verifyRuns.at(-1)!.command} → {t.verifyRuns.at(-1)!.ok ? "passed" : "failed"}
              </span>
            </div>
            <div className="mono-out" style={{ maxHeight: 160, marginBottom: 10 }}>
              {t.verifyRuns.at(-1)!.output}
            </div>
          </>
        )}

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
