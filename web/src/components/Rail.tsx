import { useEffect, useMemo, useRef, useState } from "react";
import { del, patch, post, useFloor, type Tab } from "../store.ts";
import Portrait from "./Portrait.tsx";
import Arena from "./Arena.tsx";
import type { ModelInfo, Task, Worker } from "../../../shared/types.ts";

const fmtCost = (c: number) => (c === 0 ? "$0" : c < 0.001 ? `$${c.toFixed(6)}` : `$${c.toFixed(4)}`);
const fmtMs = (ms: number) => (ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const models = useFloor((s) => s.models);
  const free = models.filter((m) => m.free);
  const unpriced = models.filter((m) => m.unpriced);
  const paid = models.filter((m) => !m.free && !m.unpriced);
  return (
    <select className="grow" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="auto">auto (let omniroute pick)</option>
      {!models.length && <option value={value}>{value}</option>}
      {free.length > 0 && (
        <optgroup label={`free · ${free.length}`}>
          {free.map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </optgroup>
      )}
      {unpriced.length > 0 && (
        <optgroup label={`no price reported · ${unpriced.length}`}>
          {unpriced.map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </optgroup>
      )}
      {paid.length > 0 && (
        <optgroup label={`paid · ${paid.length}`}>
          {paid.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} · ${m.promptCost.toFixed(2)}/M
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

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

function WorkerCard({ w }: { w: Worker }) {
  const selected = useFloor((s) => s.selected);
  const select = useFloor((s) => s.select);
  const state = useFloor((s) => s.state);
  const models = useFloor((s) => s.models);
  const cardRef = useRef<HTMLDivElement>(null);

  // clicking a desk on the floor should bring its file into view
  useEffect(() => {
    if (selected === w.id) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, w.id]);
  const task = state?.tasks.find((t) => t.id === w.currentTaskId);
  const unknownModel = models.length > 0 && w.model !== "auto" && !models.some((m) => m.id === w.model);
  const avg = w.stats.tasksDone ? Math.round(w.stats.msTotal / w.stats.tasksDone) : 0;

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

      <div className="file-actions">
        <button
          className="btn mini"
          onClick={(e) => {
            e.stopPropagation();
            void patch(`/workers/${w.id}`, { state: w.state === "asleep" ? "idle" : "asleep" });
          }}
        >
          {w.state === "asleep" ? "wake" : "send to sleep"}
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

function Roster() {
  const state = useFloor((s) => s.state);
  const models = useFloor((s) => s.models);
  const [hireModel, setHireModel] = useState("auto");
  const full = (state?.workers.length ?? 0) >= 8;

  const suggestion = useMemo(() => {
    const free = models.filter((m) => m.free);
    if (free.length) return free[0].id;
    const unpriced = models.filter((m) => m.unpriced);
    return unpriced.length ? unpriced[0].id : "auto";
  }, [models]);

  return (
    <>
      <div className="file form">
        <div className="form-title">
          staff requisition <span className="form-no">no. {String((state?.workers.length ?? 0) + 1).padStart(3, "0")}</span>
        </div>
        <label className="form-line">
          <span className="k">model</span>
          <span className="strip grow">
            <ModelSelect value={hireModel} onChange={setHireModel} />
          </span>
        </label>
        <label className="form-line">
          <span className="k">desks</span>
          <span className="desk-dots">
            {Array.from({ length: 8 }, (_, i) => (
              <i key={i} className={state?.workers.some((w) => w.desk === i) ? "taken" : ""} />
            ))}
          </span>
          <span className="v">{state?.workers.length ?? 0}/8</span>
        </label>
        <div className="file-actions">
          <button className="btn mini" onClick={() => setHireModel(suggestion)} title="first free model on the board">
            cheapest hand
          </button>
          <button
            className="btn mini"
            disabled={!state?.workers.length}
            title="morale +10 for everyone. it works every time."
            onClick={() => void post("/office", { kind: "pizza" })}
          >
            order pizza
          </button>
          <span className="grow" />
          <button className="btn primary mini" disabled={full} onClick={() => void post("/workers", { model: hireModel })}>
            {full ? "floor is full" : "sign them"}
          </button>
        </div>
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
          sign someone and give them an order.
        </div>
      )}
    </>
  );
}

const STAMP: Record<string, string> = {
  done: "approved",
  review: "pending",
  running: "in work",
  queued: "queued",
  backlog: "filed",
  rejected: "sent back",
  failed: "failed",
};

function TaskRow({ t }: { t: Task }) {
  const open = useFloor((s) => s.openTaskPanel);
  const state = useFloor((s) => s.state);
  const streams = useFloor((s) => s.streams);
  const worker = state?.workers.find((w) => w.id === t.workerId);
  const live = t.stage === "running" ? streams[t.id] ?? "" : "";

  return (
    <div className={`docket st-${t.stage}`} onClick={() => open(t.id)}>
      <div className="docket-head">
        <span className="no">{t.id.replace("t_", "#")}</span>
        <span className="grow ell">{t.title}</span>
      </div>
      <span className={`stamp-big st-${t.stage}`}>{STAMP[t.stage] ?? t.stage}</span>
      <div className="row wrap" style={{ marginBottom: 4 }}>
        {worker && <span className="chip">{worker.name}</span>}
        {t.model && <span className="chip ell" style={{ maxWidth: 150 }}>{t.model.split("/").pop()}</span>}
        {t.ghost && <span className="chip ghost">ghost</span>}
        {t.fallbackFrom && (
          <span className="chip bad" title={`${t.fallbackFrom} was not served, omniroute routed it instead`}>
            fell back from {t.fallbackFrom.split("/").pop()}
          </span>
        )}
        {t.tokensOut > 0 && <span className="chip">{t.tokensOut} out</span>}
        {t.latencyMs > 0 && <span className="chip">{fmtMs(t.latencyMs)}</span>}
        {t.costUsd > 0 && <span className="chip paid">{fmtCost(t.costUsd)}</span>}
      </div>
      {live && <div className="mono-out live" style={{ maxHeight: 70 }}>{live.slice(-320)}</div>}
      {t.stage === "review" && (
        <div className="row" style={{ marginTop: 6 }}>
          <button
            className="btn mini"
            onClick={(e) => {
              e.stopPropagation();
              void post(`/tasks/${t.id}/approve`);
            }}
          >
            approve
          </button>
          <button
            className="btn mini danger"
            onClick={(e) => {
              e.stopPropagation();
              const note = prompt("what's wrong with it?", "cok genel olmus. spesifik ol.");
              if (note) void post(`/tasks/${t.id}/reject`, { note });
            }}
          >
            send back
          </button>
        </div>
      )}
      {t.stage === "failed" && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="sub ell grow">{t.error}</span>
          <button
            className="btn mini"
            onClick={(e) => {
              e.stopPropagation();
              void post(`/tasks/${t.id}/retry`);
            }}
          >
            retry
          </button>
        </div>
      )}
    </div>
  );
}

function PipelineComposer() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<{ title: string; prompt: string }[]>([
    { title: "draft", prompt: "" },
    { title: "polish", prompt: "clean up the draft below. keep it short.\n\n{{input}}" },
  ]);

  async function run() {
    const clean = steps.filter((s) => s.prompt.trim());
    if (!clean.length) return;
    await post("/jobs", { title: title || "untitled pipeline", steps: clean });
    setOpen(false);
  }

  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        + new pipeline
      </button>
    );

  return (
    <div className="file">
      <div className="form-title">pipeline <span className="form-no">one desk feeds the next</span></div>
      <input
        className="grow"
        style={{ width: "100%", marginBottom: 6 }}
        placeholder="pipeline name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {steps.map((s, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          <div className="row" style={{ marginBottom: 3 }}>
            <span className="chip">step {i + 1}</span>
            <input
              className="grow"
              placeholder="step name"
              value={s.title}
              onChange={(e) => setSteps(steps.map((x, j) => (i === j ? { ...x, title: e.target.value } : x)))}
            />
            <button
              className="btn mini danger"
              onClick={() => setSteps(steps.filter((_, j) => j !== i))}
            >
              x
            </button>
          </div>
          <textarea
            style={{ width: "100%", height: 58 }}
            placeholder={i === 0 ? "what should the first desk do?" : "use {{input}} for the previous desk's output"}
            value={s.prompt}
            onChange={(e) => setSteps(steps.map((x, j) => (i === j ? { ...x, prompt: e.target.value } : x)))}
          />
        </div>
      ))}
      <div className="row">
        <button className="btn mini" onClick={() => setSteps([...steps, { title: `step ${steps.length + 1}`, prompt: "{{input}}" }])}>
          + step
        </button>
        <span className="grow" />
        <button className="btn mini ghost" onClick={() => setOpen(false)}>
          cancel
        </button>
        <button className="btn primary mini" onClick={() => void run()}>
          run it
        </button>
      </div>
    </div>
  );
}

function BatchComposer() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("");
  const [items, setItems] = useState("");
  const [retries, setRetries] = useState(1);
  const lines = items.split("\n").map((l) => l.trim()).filter(Boolean);

  async function run() {
    if (!template.trim() || !lines.length) return;
    await post("/batch", { title: title || `batch · ${lines.length} items`, template, items: lines, retries });
    setOpen(false);
    setItems("");
  }

  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        + split a list
      </button>
    );

  return (
    <div className="file">
      <div className="form-title">
        split a list <span className="form-no">{lines.length} items</span>
      </div>
      <input
        style={{ width: "100%", marginBottom: 6 }}
        placeholder="what is this pile?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        style={{ width: "100%", height: 58, marginBottom: 6 }}
        placeholder="the job, once. use {{item}} where each line goes."
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
      />
      <textarea
        style={{ width: "100%", height: 82, marginBottom: 6 }}
        placeholder="one item per line"
        value={items}
        onChange={(e) => setItems(e.target.value)}
      />
      <div className="form-line">
        <span className="k">retries</span>
        <span className="desk-dots grow">
          {[0, 1, 2, 3].map((n) => (
            <i key={n} className={n <= retries ? "taken" : ""} onClick={() => setRetries(n)} style={{ cursor: "pointer" }} />
          ))}
        </span>
        <span className="v">{retries}× on another desk</span>
      </div>
      <div className="file-actions">
        <span className="hint grow">every free desk takes a share</span>
        <button className="btn mini ghost" onClick={() => setOpen(false)}>
          cancel
        </button>
        <button className="btn primary mini" disabled={!template.trim() || !lines.length} onClick={() => void run()}>
          send it down
        </button>
      </div>
    </div>
  );
}

function JobCard({ jobId }: { jobId: string }) {
  const state = useFloor((s) => s.state);
  const open = useFloor((s) => s.openTaskPanel);
  const job = state?.jobs.find((j) => j.id === jobId);
  const tasks = (state?.tasks ?? []).filter((t) => t.jobId === jobId).sort((a, b) => a.stepIndex - b.stepIndex);
  if (!job) return null;
  const back = tasks.filter((t) => t.stage === "review" || t.stage === "done").length;
  const failed = tasks.filter((t) => t.stage === "failed").length;

  const copyAll = () => {
    const text = tasks.map((t) => `--- ${t.title}\n${t.output || t.error || ""}`).join("\n\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="file job">
      <div className="form-title">
        {job.kind === "batch" ? "▤" : "⛓"} {job.title}
        <span className="form-no">
          {back}/{tasks.length} back{failed ? ` · ${failed} failed` : ""}
        </span>
      </div>
      <div className="progress">
        {tasks.map((t) => (
          <i
            key={t.id}
            className={`st-${t.stage}`}
            title={`${t.title} · ${t.stage}`}
            onClick={() => open(t.id)}
          />
        ))}
      </div>
      <div className="file-actions">
        <span className={`chip ${job.stage === "done" ? "ok" : job.stage === "failed" ? "bad" : ""}`}>{job.stage}</span>
        <span className="grow" />
        <button className="btn mini" onClick={copyAll}>
          copy all
        </button>
      </div>
    </div>
  );
}

function Board() {
  const state = useFloor((s) => s.state);
  const tasks = (state?.tasks ?? []).slice().reverse();
  const order: Record<string, number> = { running: 0, review: 1, queued: 2, rejected: 3, failed: 4, backlog: 5, done: 6 };
  const sorted = tasks.sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9));
  const jobs = (state?.jobs ?? []).slice().reverse().slice(0, 4);

  return (
    <>
      <div className="row">
        <PipelineComposer />
        <BatchComposer />
      </div>
      {jobs.map((j) => <JobCard key={j.id} jobId={j.id} />)}
      {sorted.length ? sorted.map((t) => <TaskRow key={t.id} t={t} />) : <div className="empty">no work on the board yet.</div>}
    </>
  );
}

function Wire() {
  const log = useFloor((s) => s.log);
  const state = useFloor((s) => s.state);
  const cls = (type: string) =>
    type.startsWith("boss") ? "boss"
    : type === "office" ? "office"
    : type === "worker.done" ? "ok"
    : type === "worker.fail" ? "bad"
    : type.startsWith("worker") ? "work"
    : "sys";

  const lines = log.filter((e) => e.type !== "worker.chunk").slice(-160);

  return (
    <div className="printout">
      <div className="feed">
        {lines
          .slice()
          .reverse()
          .map((e, i) => {
            const w = state?.workers.find((x) => x.id === e.workerId);
            const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
            const who =
              e.type.startsWith("boss") ? "BOSS" : w ? w.name.split(" ")[0].toUpperCase() : e.type.split(".")[0].toUpperCase();
            return (
              <div key={e.id} className={`ln ${cls(e.type)} ${i % 2 ? "alt" : ""}`}>
                <span className="t">{time}</span>
                <span className="who">{who}</span>
                <span className="msg">{(e.text ?? "").slice(0, 220)}</span>
              </div>
            );
          })}
        {!lines.length && <div className="ln sys"><span className="msg">nothing on the wire yet.</span></div>}
      </div>
    </div>
  );
}

function GatewayPanel() {
  const state = useFloor((s) => s.state);
  const models = useFloor((s) => s.models);
  const [url, setUrl] = useState(state?.gateway.baseUrl ?? "http://localhost:20128/v1");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const g = state?.gateway;

  async function connectGw() {
    setBusy(true);
    try {
      await post("/gateway", { baseUrl: url, apiKey: key });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  const filtered = models.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())).slice(0, 60);

  return (
    <>
      <div className="file mains">
        <div className="form-title">
          omniroute mains
          <span className={`bulb ${g?.online ? "on" : ""}`} />
        </div>
        <div className="gauge">
          <span className="k">line</span>
          <span className="wireline">
            <i className={g?.online ? "live" : ""} />
          </span>
          <span className="v">{g?.online ? "carrying" : "dead"}</span>
        </div>
        <div className="hint" style={{ marginBottom: 6 }}>
          not running yet? <kbd>npm i -g omniroute</kbd> then <kbd>omniroute</kbd>. the key lives in its dashboard
          under endpoints.
        </div>
        <input style={{ width: "100%", marginBottom: 4 }} value={url} onChange={(e) => setUrl(e.target.value)} />
        <input
          style={{ width: "100%", marginBottom: 6 }}
          placeholder={g?.hasKey ? "api key set · type to replace" : "api key (blank works for free pools)"}
          value={key}
          type="password"
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="row">
          <span className="sub grow ell">{g?.error ? g.error : `${g?.modelCount ?? 0} models`}</span>
          <button className="btn mini primary" disabled={busy} onClick={() => void connectGw()}>
            {busy ? "knocking..." : "connect"}
          </button>
        </div>
      </div>

      <div className="file">
        <div className="form-title">house rules</div>
        <label className="switch">
          <input
            type="checkbox"
            checked={state?.settings.autoAssign ?? true}
            onChange={(e) => void post("/settings", { autoAssign: e.target.checked })}
          />
          <i />
          <span className="grow">auto-assign orders to whoever is free</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={state?.settings.ghostMode ?? true}
            onChange={(e) => void post("/settings", { ghostMode: e.target.checked })}
          />
          <i />
          <span className="grow">ghost shift when the gateway is down</span>
        </label>
        <div className="form-line" style={{ marginTop: 8 }}>
          <span className="k">at once</span>
          <span className="desk-dots grow">
            {Array.from({ length: 8 }, (_, i) => (
              <i
                key={i}
                className={i < (state?.settings.maxParallel ?? 4) ? "taken" : ""}
                onClick={() => void post("/settings", { maxParallel: i + 1 })}
                style={{ cursor: "pointer" }}
              />
            ))}
          </span>
          <span className="v">{state?.settings.maxParallel ?? 4}</span>
        </div>
      </div>

      <div className="file catalog">
        <div className="form-title">
          the board <span className="form-no">{models.length} models</span>
        </div>
        <input
          style={{ width: "100%", marginBottom: 6 }}
          placeholder="search models"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {filtered.map((m: ModelInfo) => (
          <div className="row" key={m.id} style={{ marginBottom: 3 }}>
            <span
              className={`chip ${m.free ? "free" : m.unpriced ? "" : "paid"}`}
              title={m.unpriced ? "omniroute reported no price for this model" : undefined}
            >
              {m.free ? "free" : m.unpriced ? "no price" : `$${m.promptCost.toFixed(2)}`}
            </span>
            <span className="sub ell grow">{m.id}</span>
            <button className="btn mini" onClick={() => void post("/workers", { model: m.id })}>
              hire
            </button>
          </div>
        ))}
        {!models.length && <div className="empty">no models yet — connect the gateway.</div>}
      </div>
    </>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "roster", label: "roster" },
  { id: "board", label: "board" },
  { id: "arena", label: "arena" },
  { id: "wire", label: "wire" },
  { id: "gateway", label: "gateway" },
];

export default function Rail() {
  const tab = useFloor((s) => s.tab);
  const setTab = useFloor((s) => s.setTab);
  const state = useFloor((s) => s.state);
  const reviewCount = state?.tasks.filter((t) => t.stage === "review").length ?? 0;

  return (
    <aside className="rail">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "board" && reviewCount > 0 && <span className="dot"> ●{reviewCount}</span>}
            {t.id === "gateway" && !state?.gateway.online && <span className="dot"> ●</span>}
          </button>
        ))}
      </div>
      <div className="rail-body" style={tab === "wire" ? { padding: 6 } : undefined}>
        {tab === "roster" && <Roster />}
        {tab === "board" && <Board />}
        {tab === "arena" && <Arena />}
        {tab === "wire" && <Wire />}
        {tab === "gateway" && <GatewayPanel />}
      </div>
    </aside>
  );
}
