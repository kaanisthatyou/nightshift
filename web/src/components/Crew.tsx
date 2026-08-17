// Who is on the floor, and how they got there.
//
// A preset is a loadout: pick one, bring the core crew in, then add from the
// bench one desk at a time. Every desk carries a role (what it knows) and a
// temper (how it answers) - together they are the system prompt it works under.

import { useEffect, useMemo, useRef, useState } from "react";
import { del, patch, post, useFloor } from "../store.ts";
import Portrait from "./Portrait.tsx";
import ModelSelect from "./ModelSelect.tsx";
import type { RoleSpec } from "../../../shared/presets.ts";
import type { Worker } from "../../../shared/types.ts";

const fmtCost = (c: number) => (c === 0 ? "$0" : c < 0.001 ? `$${c.toFixed(6)}` : `$${c.toFixed(4)}`);
const fmtMs = (ms: number) => (ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

function Pips({ value }: { value: number }) {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round((value / 100) * cells)));
  const tone = value < 35 ? "low" : value < 65 ? "mid" : "";
  return (
    <span className={`pips ${tone}`}>
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < filled ? "on" : ""} />
      ))}
    </span>
  );
}

function TemperSelect({ value, onChange }: { value: string | null; onChange: (v: string) => void }) {
  const tempers = useFloor((s) => s.tempers);
  return (
    <span className="strip grow">
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {!tempers.length && <option value={value ?? ""}>{value ?? "no head"}</option>}
        {tempers.map((t) => (
          <option key={t.key} value={t.key}>
            {t.name} · {t.blurb}
          </option>
        ))}
      </select>
    </span>
  );
}

function WorkerCard({ w }: { w: Worker }) {
  const selected = useFloor((s) => s.selected);
  const select = useFloor((s) => s.select);
  const state = useFloor((s) => s.state);
  const models = useFloor((s) => s.models);
  const tempers = useFloor((s) => s.tempers);
  const [showHead, setShowHead] = useState(false);
  const [persona, setPersona] = useState(w.persona ?? "");
  const cardRef = useRef<HTMLDivElement>(null);

  // clicking a desk on the floor should bring its file into view
  useEffect(() => {
    if (selected === w.id) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, w.id]);
  // someone else may have swapped the head under us
  useEffect(() => setPersona(w.persona ?? ""), [w.persona]);

  const task = state?.tasks.find((t) => t.id === w.currentTaskId);
  const unknownModel = models.length > 0 && w.model !== "auto" && !models.some((m) => m.id === w.model);
  const avg = w.stats.tasksDone ? Math.round(w.stats.msTotal / w.stats.tasksDone) : 0;
  const temperName = tempers.find((t) => t.key === w.temper)?.name ?? w.temper;

  return (
    <div ref={cardRef} className={`file ${selected === w.id ? "sel" : ""}`} onClick={() => select(w.id)}>
      <div className="file-head">
        <Portrait worker={w} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="name ell">{w.name}</div>
          <div className="sub ell" style={{ marginBottom: 5 }}>
            {w.title} · desk {w.desk + 1}
          </div>
          <div className="strip">
            <ModelSelect value={w.model} onChange={(v) => void patch(`/workers/${w.id}`, { model: v })} />
          </div>
        </div>
        <span className={`stamp state-${w.state}`}>{w.state}</span>
      </div>

      {(w.role || temperName) && (
        <div className="row wrap" style={{ marginBottom: 6 }}>
          {w.role && <span className="chip role">{w.role}</span>}
          {temperName && <span className="chip temper">{temperName}</span>}
          {w.presetId && <span className="chip">{w.presetId}</span>}
        </div>
      )}

      {unknownModel && (
        <div className="warn" title="the gateway does not list this model - it will fail until you pick another or add credentials in omniroute">
          ! not on the board
        </div>
      )}

      <div className="file-row">
        <span className="k">morale</span>
        <Pips value={w.morale} />
        <span className="v">{w.morale}</span>
      </div>

      <div className="file-row stats">
        <span className="ok">✓{w.stats.tasksDone}</span>
        <span className="bad">✗{w.stats.tasksFailed}</span>
        <span className="sep" />
        <span>{(w.stats.tokensIn + w.stats.tokensOut).toLocaleString()} tok</span>
        <span className="sep" />
        <span>{fmtCost(w.stats.costUsd)}</span>
        {avg > 0 && (
          <>
            <span className="sep" />
            <span>{fmtMs(avg)}</span>
          </>
        )}
      </div>

      {task && <div className="now ell">▸ {task.title}</div>}
      {w.saying && <div className="quote ell">{w.saying}</div>}

      {showHead && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginBottom: 6 }}>
          <div className="file-row">
            <span className="k">head</span>
            <TemperSelect value={w.temper} onChange={(v) => void patch(`/workers/${w.id}`, { temper: v })} />
          </div>
          <textarea
            style={{ width: "100%", height: 110, marginBottom: 4 }}
            value={persona}
            placeholder="this desk has no persona - it answers as a plain worker"
            onChange={(e) => setPersona(e.target.value)}
          />
          <div className="row">
            <span className="hint grow">the system prompt every task on this desk runs under</span>
            <button
              className="btn mini"
              disabled={persona === (w.persona ?? "")}
              onClick={() => void patch(`/workers/${w.id}`, { persona })}
            >
              save head
            </button>
          </div>
        </div>
      )}

      <div className="file-actions">
        <button
          className="btn mini"
          onClick={(e) => {
            e.stopPropagation();
            setShowHead((v) => !v);
          }}
        >
          {showHead ? "hide head" : "head"}
        </button>
        <button
          className="btn mini"
          onClick={(e) => {
            e.stopPropagation();
            void patch(`/workers/${w.id}`, { state: w.state === "asleep" ? "idle" : "asleep" });
          }}
        >
          {w.state === "asleep" ? "wake" : "sleep"}
        </button>
        <span className="grow" />
        <button
          className="btn mini danger"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`fire ${w.name}?`)) void del(`/workers/${w.id}`);
          }}
        >
          fire
        </button>
      </div>
    </div>
  );
}

/** The loadout picker: a preset, its core crew, and the bench behind it. */
function Loadout() {
  const state = useFloor((s) => s.state);
  const presets = useFloor((s) => s.presets);
  const models = useFloor((s) => s.models);
  const [presetId, setPresetId] = useState("");
  const [model, setModel] = useState("auto");
  const [bench, setBench] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const workers = state?.workers ?? [];
  const free = 8 - workers.length;
  const p = presets.find((x) => x.id === presetId);

  // whichever loadout the floor already looks like, so the bench opens on the right one
  useEffect(() => {
    if (presetId || !presets.length) return;
    const onFloor = workers.find((w) => w.presetId)?.presetId;
    setPresetId(onFloor ?? presets[0].id);
  }, [presets, presetId, workers]);

  const core = p?.roles.filter((r) => r.core) ?? [];
  const filled = new Set(workers.filter((w) => w.presetId === presetId).map((w) => w.role));

  const cheapest = useMemo(() => models.find((m) => m.free)?.id ?? "auto", [models]);

  async function bringIn(replace: boolean) {
    if (!p || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await post(`/presets/${p.id}/hire`, { replace, model });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addOne(role: RoleSpec) {
    if (!p || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await post("/workers", { presetId: p.id, roleKey: role.key, model });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="file form">
      <div className="form-title">
        loadout <span className="form-no">{workers.length}/8 desks</span>
      </div>

      <label className="form-line">
        <span className="k">crew</span>
        <span className="strip grow">
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {!presets.length && <option value="">loading...</option>}
            {presets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </span>
      </label>

      {p && <div className="hint" style={{ marginBottom: 7 }}>{p.tagline}</div>}

      {core.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 7 }}>
          {core.map((r) => (
            <span key={r.key} className={`chip role ${filled.has(r.key) ? "on" : ""}`} title={r.blurb}>
              {filled.has(r.key) ? "✓ " : ""}
              {r.title}
            </span>
          ))}
        </div>
      )}

      <label className="form-line">
        <span className="k">model</span>
        <span className="strip grow">
          <ModelSelect value={model} onChange={setModel} />
        </span>
      </label>

      <div className="file-actions">
        <button className="btn mini" onClick={() => setModel(cheapest)} title="first free model on the board">
          cheapest hand
        </button>
        <span className="grow" />
        <button className="btn mini" disabled={!p || busy || !workers.length} onClick={() => void bringIn(true)}>
          swap
        </button>
        <button className="btn primary mini" disabled={!p || busy || free <= 0} onClick={() => void bringIn(false)}>
          {free <= 0 ? "floor is full" : busy ? "signing..." : "bring crew in"}
        </button>
      </div>

      {err && <div className="warn" style={{ marginTop: 6 }}>{err}</div>}

      <button className="btn mini ghost" style={{ marginTop: 7, width: "100%" }} onClick={() => setBench((v) => !v)}>
        {bench ? "− close the bench" : "+ add another"}
      </button>

      {bench && p && (
        <div className="bench">
          {p.roles.map((r) => (
            <div className="bench-row" key={r.key}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bench-title ell">
                  {r.title} <span className={`weight ${r.weight}`}>{r.weight}</span>
                </div>
                <div className="hint ell">{r.blurb}</div>
              </div>
              <button className="btn mini" disabled={busy || free <= 0} onClick={() => void addOne(r)}>
                + hire
              </button>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 4 }}>
            hiring the same role twice is fine — they get different heads, so they answer differently.
          </div>
        </div>
      )}
    </div>
  );
}

export default function Crew() {
  const state = useFloor((s) => s.state);

  return (
    <>
      <Loadout />
      <div className="row">
        <button
          className="btn mini"
          disabled={!state?.workers.length}
          title="morale +10 for everyone. it works every time."
          onClick={() => void post("/office", { kind: "pizza" })}
        >
          order pizza
        </button>
        <span className="grow" />
        <button className="btn mini" onClick={() => void post("/workers", { model: "auto" })}>
          + plain hand
        </button>
      </div>
      {state?.workers.length ? (
        state.workers
          .slice()
          .sort((a, b) => a.desk - b.desk)
          .map((w) => <WorkerCard key={w.id} w={w} />)
      ) : (
        <div className="empty">
          the floor is empty.
          <br />
          pick a loadout and bring a crew in.
        </div>
      )}
    </>
  );
}
