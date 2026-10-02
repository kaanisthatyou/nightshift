// The mains: where the models come from, how their quotas are pooled, and what
// the office looks like. There is no gateway to connect to - the floor talks to
// every provider itself, one lane per key.
import { useEffect, useMemo, useState } from "react";
import { del, post, useFloor } from "../store.ts";
import ModelSelect from "./ModelSelect.tsx";
import { OFFICE_LAYOUTS, ROOM_THEMES, DESKS_PER_ROOM, MAX_ROOMS, deskCount } from "../../../shared/office.ts";
import { PROVIDER_PRESETS } from "../../../shared/providers.ts";
import type { LaneStatus, ModelInfo, OfficeConfig, ProviderStatus, RoomConfig } from "../../../shared/types.ts";

const NO_ROUTES: import("../../../shared/types.ts").RouteInfo[] = [];

/** Re-render once a second while anything is resting, so the countdowns move. */
function useClock(active: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setT((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [active]);
}

function Lane({ l }: { l: LaneStatus }) {
  const resting = l.coolUntil > Date.now();
  const rpmShare = l.rpm ? Math.min(1, l.lastMinute / l.rpm) : 0;
  return (
    <div className={`lane ${resting ? "resting" : l.inflight ? "busy" : ""}`} title={`${l.served} served, ${l.failed} failed`}>
      <span className="lane-id">{l.id}</span>
      <span className="lane-slots">
        {Array.from({ length: Math.max(l.limit, l.inflight) }, (_, i) => (
          <i key={i} className={i < l.inflight ? "on" : ""} />
        ))}
      </span>
      <span className="lane-rpm" title="requests in the last minute / allowed">
        <b style={{ width: `${Math.round(rpmShare * 100)}%` }} />
      </span>
      <span className="lane-v">
        {resting ? `rest ${Math.ceil((l.coolUntil - Date.now()) / 1000)}s` : l.rpm ? `${l.lastMinute}/${l.rpm}` : `${l.lastMinute}/min`}
      </span>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [rpm, setRpm] = useState(String(p.rpm));
  const [conc, setConc] = useState(String(p.concurrency));
  const [busy, setBusy] = useState(false);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await post("/providers", { id: p.id, rpm: Number(rpm) || 0, concurrency: Number(conc) || 1, ...extra });
      setKey("");
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`prov ${p.online ? "up" : ""} ${p.enabled ? "" : "off"}`}>
      <div className="row" onClick={() => setOpen((v) => !v)} style={{ cursor: "pointer" }}>
        <span className={`bulb ${p.online && p.enabled ? "on" : ""}`} />
        <b className="ell grow">{p.name}</b>
        <span className="sub">{p.keyless ? "local" : `${p.keyCount} key${p.keyCount === 1 ? "" : "s"}`}</span>
        <span className="sub">{p.modelCount} models</span>
      </div>
      {p.error && <div className="hint bad-text ell" title={p.error}>{p.error}</div>}
      {p.lanes.map((l) => <Lane key={l.id} l={l} />)}
      {open && (
        <div className="prov-edit">
          <div className="sub ell" title={p.baseUrl}>{p.baseUrl}</div>
          {!p.keyless && (
            <div className="row">
              <input
                className="grow"
                type="password"
                placeholder="add another key - each key is its own quota"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn mini primary" disabled={busy || !key.trim()} onClick={() => void save({ key })}>
                add
              </button>
            </div>
          )}
          <div className="row">
            <span className="k">rpm/key</span>
            <input style={{ width: 52 }} value={rpm} onChange={(e) => setRpm(e.target.value)} />
            <span className="k">at once/key</span>
            <input style={{ width: 40 }} value={conc} onChange={(e) => setConc(e.target.value)} />
            <button className="btn mini" disabled={busy} onClick={() => void save()}>
              save
            </button>
          </div>
          <div className="row">
            <button className="btn mini" disabled={busy} onClick={() => void save({ enabled: !p.enabled })}>
              {p.enabled ? "switch off" : "switch on"}
            </button>
            <span className="grow" />
            <button
              className="btn mini danger"
              onClick={() => {
                if (confirm(`remove ${p.name} and its keys?`)) void del(`/providers/${p.id}`);
              }}
            >
              remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProvidersPanel() {
  const g = useFloor((s) => s.state?.gateway);
  const [text, setText] = useState("");
  const [custom, setCustom] = useState({ id: "", baseUrl: "", key: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const resting = g?.providers.some((p) => p.lanes.some((l) => l.coolUntil > Date.now())) ?? false;
  useClock(resting);

  async function paste() {
    setBusy(true);
    setNote(null);
    try {
      const r = await post<{ added: { provider: string; count: number }[]; skipped: number }>("/providers/keys", { text });
      setText("");
      const added = r.added.map((a) => `${a.provider} +${a.count}`).join(", ");
      setNote(`${added || "nothing new"}${r.skipped ? ` · ${r.skipped} lines not recognised - use "provider = key"` : ""}`);
    } catch (err: any) {
      setNote(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addCustom() {
    setBusy(true);
    try {
      await post("/providers", { id: custom.id, name: custom.id, baseUrl: custom.baseUrl, key: custom.key, keyless: !custom.key });
      setCustom({ id: "", baseUrl: "", key: "" });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="file mains">
      <div className="form-title">
        providers <span className="form-no">{g?.online ? `${g.modelCount} models` : "none answering"}</span>
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>
        no gateway: the floor calls each provider itself. every key is a lane with its own limit, and a desk's work
        moves to whichever lane is free.
      </div>
      {(g?.providers ?? []).map((p) => <ProviderCard key={p.id} p={p} />)}

      <textarea
        className="keys"
        rows={3}
        placeholder={"paste keys, one per line:\nnvapi-...   gsk_...   AIza...\nor  mistral = xxxx"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <span className="sub grow ell">{note ?? PROVIDER_PRESETS.filter((p) => p.keyPrefix.length).map((p) => p.id).join(" · ")}</span>
        <button className="btn mini primary" disabled={busy || !text.trim()} onClick={() => void paste()}>
          {busy ? "..." : "add keys"}
        </button>
      </div>

      <details style={{ marginTop: 6 }}>
        <summary className="sub">any other OpenAI-compatible server</summary>
        <div className="row">
          <input style={{ width: 70 }} placeholder="id" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
          <input className="grow" placeholder="http://host:port/v1" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
        </div>
        <div className="row">
          <input className="grow" type="password" placeholder="key (blank for local)" value={custom.key} onChange={(e) => setCustom({ ...custom, key: e.target.value })} />
          <button className="btn mini" disabled={busy || !custom.id || !custom.baseUrl} onClick={() => void addCustom()}>
            add
          </button>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {PROVIDER_PRESETS.filter((p) => p.keyless).map((p) => (
            <button key={p.id} className="btn mini" onClick={() => void post("/providers", { id: p.id })} title={p.note}>
              + {p.name}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

function RoutesPanel() {
  const routes = useFloor((s) => s.state?.gateway.routes) ?? NO_ROUTES;
  const fallback = useFloor((s) => s.state?.settings.routerFallback ?? true);
  const [name, setName] = useState("");

  const save = (id: string, models: string[]) => void post("/routes", { id, name: id, models });

  return (
    <div className="file">
      <div className="form-title">
        routes <span className="form-no">quota pools</span>
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>
        a route is models in order of preference. a desk on it gets the first one with a free key - and when that
        quota runs out mid-task, the same conversation carries on with the next.
      </div>
      {routes.map((r) => (
        <div className="route" key={r.id}>
          <div className="row">
            <b className="grow">{r.id === "auto" ? "auto" : `route:${r.id}`}</b>
            {r.id !== "auto" && (
              <button className="btn mini danger" onClick={() => void del(`/routes/${r.id}`)}>
                x
              </button>
            )}
          </div>
          {!r.models.length && <div className="sub">every provider's suggested model</div>}
          {r.models.map((m, i) => (
            <div className="row route-step" key={`${m}-${i}`}>
              <span className="sub">{i + 1}.</span>
              <span className="ell grow" title={m}>{m}</span>
              <button className="btn mini" disabled={i === 0} onClick={() => {
                const next = [...r.models];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                save(r.id, next);
              }}>↑</button>
              <button className="btn mini" onClick={() => save(r.id, r.models.filter((_, j) => j !== i))}>-</button>
            </div>
          ))}
          <div className="strip">
            <ModelSelect value="" onChange={(v) => v && !v.startsWith("route:") && v !== "auto" && save(r.id, [...r.models, v])} />
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input className="grow" placeholder="new route name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn mini" disabled={!name.trim()} onClick={() => { save(name.trim(), []); setName(""); }}>
          add
        </button>
      </div>
      <label className="switch" style={{ marginTop: 6 }}>
        <input type="checkbox" checked={fallback} onChange={(e) => void post("/settings", { routerFallback: e.target.checked })} />
        <i />
        <span className="grow">a desk on one model spills over onto auto when its keys are all resting</span>
      </label>
    </div>
  );
}

function RoomRow({ room, index, onChange, onRemove }: {
  room: RoomConfig;
  index: number;
  onChange: (r: RoomConfig) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className={`room-row theme-${room.theme}`}>
      <span className="room-no">{index + 1}</span>
      <input className="grow" value={room.name} onChange={(e) => onChange({ ...room, name: e.target.value })} />
      <select value={room.theme} onChange={(e) => onChange({ ...room, theme: e.target.value as RoomConfig["theme"] })}>
        {ROOM_THEMES.map((t) => (
          <option key={t.id} value={t.id} title={t.blurb}>{t.name}</option>
        ))}
      </select>
      <span className="desk-dots">
        {Array.from({ length: DESKS_PER_ROOM }, (_, i) => (
          <i key={i} className={i < room.desks ? "taken" : ""} style={{ cursor: "pointer" }} onClick={() => onChange({ ...room, desks: i + 1 })} />
        ))}
      </span>
      {onRemove && <button className="btn mini" onClick={onRemove}>x</button>}
    </div>
  );
}

function OfficePanel() {
  const office = useFloor((s) => s.state?.settings.office);
  const crew = useFloor((s) => s.state?.workers.length ?? 0);
  const [draft, setDraft] = useState<OfficeConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = draft ?? office;
  const total = deskCount(shown);
  const dirty = useMemo(() => draft && JSON.stringify(draft) !== JSON.stringify(office), [draft, office]);

  if (!shown) return null;

  async function apply(body: unknown) {
    setErr(null);
    try {
      await post("/office", body);
      setDraft(null);
    } catch (e: any) {
      try {
        setErr(JSON.parse(e.message).error);
      } catch {
        setErr(e.message);
      }
    }
  }

  const edit = (fn: (o: OfficeConfig) => OfficeConfig) => setDraft(fn(structuredClone(shown)));

  return (
    <div className="file">
      <div className="form-title">
        the office <span className="form-no">{shown.rooms.length} rooms · {total} desks · {crew} hired</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
        {OFFICE_LAYOUTS.map((l) => (
          <button key={l.id} className="btn mini" title={l.blurb} onClick={() => void apply({ layout: l.id })}>
            {l.name} · {deskCount(l.office)}
          </button>
        ))}
      </div>
      <input
        style={{ width: "100%", marginBottom: 4 }}
        value={shown.name}
        onChange={(e) => edit((o) => ({ ...o, name: e.target.value }))}
      />
      {shown.rooms.map((r, i) => (
        <RoomRow
          key={r.id}
          room={r}
          index={i}
          onChange={(next) => edit((o) => ({ ...o, rooms: o.rooms.map((x, j) => (j === i ? next : x)) }))}
          onRemove={shown.rooms.length > 1 ? () => edit((o) => ({ ...o, rooms: o.rooms.filter((_, j) => j !== i) })) : null}
        />
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        <button
          className="btn mini"
          disabled={shown.rooms.length >= MAX_ROOMS}
          onClick={() =>
            edit((o) => ({
              ...o,
              rooms: [
                ...o.rooms,
                {
                  id: `r${Date.now().toString(36)}`,
                  name: `room ${o.rooms.length + 1}`,
                  desks: DESKS_PER_ROOM,
                  theme: ROOM_THEMES[o.rooms.length % ROOM_THEMES.length].id,
                },
              ],
            }))
          }
        >
          + room
        </button>
        <span className="grow sub bad-text">{err}</span>
        {dirty && (
          <>
            <button className="btn mini" onClick={() => setDraft(null)}>undo</button>
            <button className="btn mini primary" onClick={() => void apply({ office: draft })}>rebuild</button>
          </>
        )}
      </div>
    </div>
  );
}

function HouseRules() {
  const state = useFloor((s) => s.state);
  const s = state?.settings;
  return (
    <div className="file">
      <div className="form-title">house rules</div>
      <label className="switch">
        <input type="checkbox" checked={s?.autoAssign ?? true} onChange={(e) => void post("/settings", { autoAssign: e.target.checked })} />
        <i />
        <span className="grow">auto-assign orders to whoever is free</span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={s?.ghostMode ?? true} onChange={(e) => void post("/settings", { ghostMode: e.target.checked })} />
        <i />
        <span className="grow">ghost shift when no provider answers</span>
      </label>
      <div className="form-line" style={{ marginTop: 8 }}>
        <span className="k">planner</span>
        <span className="strip grow" title="the model that drafts plans on the whiteboard">
          <ModelSelect value={s?.plannerModel ?? "auto"} onChange={(v) => void post("/settings", { plannerModel: v })} />
        </span>
      </div>
      <div className="form-line">
        <span className="k">thinking</span>
        <span className="grow seg">
          {(["off", "low", "medium", "high", "default"] as const).map((lvl) => (
            <button
              key={lvl}
              className={`btn mini ${s?.reasoning === lvl ? "primary" : ""}`}
              onClick={() => void post("/settings", { reasoning: lvl })}
              title={lvl === "default" ? "whatever the provider does by default" : `reasoning effort: ${lvl}`}
            >
              {lvl}
            </button>
          ))}
        </span>
      </div>
      <div className="hint">
        on a slow provider a reasoning model at full effort can spend a whole reply thinking. <kbd>low</kbd> is the
        measured sweet spot for build work.
      </div>
      <div className="form-line">
        <span className="k">at once</span>
        <input
          type="number"
          min={1}
          max={64}
          style={{ width: 56 }}
          value={s?.maxParallel ?? 8}
          onChange={(e) => void post("/settings", { maxParallel: Number(e.target.value) })}
        />
        <span className="sub grow">tasks in flight - the lanes keep each key inside its limit</span>
      </div>
    </div>
  );
}

function Catalog() {
  const models = useFloor((s) => s.models);
  const [q, setQ] = useState("");
  const filtered = models.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  return (
    <div className="file catalog">
      <div className="form-title">
        the board <span className="form-no">{models.length} models</span>
      </div>
      <input style={{ width: "100%", marginBottom: 6 }} placeholder="search models" value={q} onChange={(e) => setQ(e.target.value)} />
      {filtered.map((m: ModelInfo) => (
        <div className="row" key={m.id} style={{ marginBottom: 3 }}>
          <span className={`chip ${m.free ? "free" : m.unpriced ? "" : "paid"}`}>
            {m.free ? "free" : m.unpriced ? "no price" : `$${m.promptCost.toFixed(2)}`}
          </span>
          <span className="sub ell grow">{m.id}</span>
          <button className="btn mini" onClick={() => void post("/workers", { model: m.id })}>
            hire
          </button>
        </div>
      ))}
      {!models.length && <div className="empty">no models yet - add a provider key above.</div>}
    </div>
  );
}

export default function Mains() {
  return (
    <>
      <ProvidersPanel />
      <RoutesPanel />
      <OfficePanel />
      <HouseRules />
      <Catalog />
    </>
  );
}
