// The model picker. A native select could not do the two things this needs -
// search across 500 model ids, and never open a white browser popup over a 3am
// office - so the list is ours. One provider is one heading, so you read
// "nvidia" once instead of on every row, and the row keeps the part that
// actually differs.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFloor } from "../store.ts";
import type { ModelInfo } from "../../../shared/types.ts";

const AUTO = "auto";
type Tier = "all" | "free" | "unpriced" | "paid";

/**
 * OmniRoute's virtual combos. They are not models and never show up in the
 * catalog, but a desk can sit on one and let the gateway spread its requests -
 * `auto/offline` in particular picks whoever has the most rate-limit headroom
 * left, which is what stops eight desks hammering one provider's quota.
 */
const ROUTERS: { id: string; blurb: string }[] = [
  { id: "auto", blurb: "balanced · sticks to the last good provider" },
  { id: "auto/offline", blurb: "most quota and rate-limit headroom first" },
  { id: "auto/cheap", blurb: "cheapest per token first" },
  { id: "auto/fast", blurb: "lowest latency first" },
  { id: "auto/coding", blurb: "quality-first weights for code" },
  { id: "auto/smart", blurb: "quality-first, explores for better ones" },
];

interface Group {
  key: string;
  models: ModelInfo[];
  free: number;
}

function tierOf(m: ModelInfo) {
  return m.free ? "free" : m.unpriced ? "unpriced" : "paid";
}

function priceOf(m: ModelInfo) {
  if (m.free) return "free";
  if (m.unpriced) return "no price";
  return `$${m.promptCost.toFixed(2)}/M`;
}

const WHY_UNPRICED =
  "the gateway reported no price for this model. unknown is not the same as free - " +
  "add credentials for that provider in omniroute and the price shows up.";

/** `nvidia/openai/gpt-oss-120b` is nvidia's, and the row only has to say the rest. */
function providerOf(m: ModelInfo) {
  const cut = m.id.indexOf("/");
  return cut > 0 ? m.id.slice(0, cut) : m.owned_by || "other";
}
function restOf(m: ModelInfo) {
  const cut = m.id.indexOf("/");
  return cut > 0 ? m.id.slice(cut + 1) : m.id;
}

function matches(m: ModelInfo, terms: string[]) {
  const hay = `${m.id} ${m.label ?? ""} ${m.owned_by ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** One group per provider, free models first inside it, cheapest before dearest. */
function group(models: ModelInfo[], query: string, tier: Tier): Group[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = models
    .filter((m) => tier === "all" || tierOf(m) === tier)
    .filter((m) => !terms.length || matches(m, terms));

  const by = new Map<string, ModelInfo[]>();
  for (const m of hits) {
    const p = providerOf(m);
    const list = by.get(p);
    if (list) list.push(m);
    else by.set(p, [m]);
  }

  const rank = (m: ModelInfo) => (m.free ? 0 : m.unpriced ? 1 : 2);
  return [...by.entries()]
    .map(([key, list]) => ({
      key,
      free: list.filter((m) => m.free).length,
      models: list.sort((a, b) => rank(a) - rank(b) || a.promptCost - b.promptCost || a.id.localeCompare(b.id)),
    }))
    // whoever gives you the most free desks is worth reading first
    .sort((a, b) => b.free - a.free || b.models.length - a.models.length || a.key.localeCompare(b.key));
}

export default function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const models = useFloor((s) => s.models);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<Tier>("all");
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // the rail scrolls and the desk cards sit inside it, so a popup drawn in place
  // would be cut off at the panel edge. it goes to the body and is placed by hand.
  const [at, setAt] = useState({ left: 0, top: 0, fromBottom: 0, width: 0, up: false });

  const groups = useMemo(() => group(models, query, tier), [models, query, tier]);
  // the routers are not in the catalog - they are the gateway's own combos, and
  // they stay at the top whichever tier is being looked at
  const routers = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const known = new Set(models.map((m) => m.id));
    return ROUTERS.filter((r) => !known.has(r.id)).filter(
      (r) => !terms.length || terms.every((t) => `${r.id} ${r.blurb}`.toLowerCase().includes(t)),
    );
  }, [models, query]);
  // one flat list behind the groups, so the arrow keys have somewhere to go
  const flat = useMemo(
    () => [...routers.map((r) => r.id), ...groups.flatMap((g) => g.models.map((m) => m.id))],
    [routers, groups],
  );

  useEffect(() => setCursor(0), [query, tier, open]);

  // measure before paint, then keep up with whatever scrolls underneath it
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      // the rail scrolled its own field away - follow it off the screen and the
      // list would end up floating over the floor on its own
      if (r.bottom < 8 || r.top > window.innerHeight - 8) {
        setOpen(false);
        return;
      }
      // wide enough that a real model id is not cut in half
      const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
      setAt({
        left: Math.min(r.left, window.innerWidth - width - 8),
        top: r.bottom + 2,
        fromBottom: window.innerHeight - r.top + 2,
        width,
        // a desk card near the floor of the rail opens upwards instead
        up: window.innerHeight - r.bottom < 220,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // keep the highlighted row on screen while the arrows walk the list
  useEffect(() => {
    listBox.current?.querySelector<HTMLElement>(".ms-row.on")?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (flat.length ? (c + step + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[cursor]) pick(flat[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the whiteboard closes on Escape too - not while this is open
      setOpen(false);
    }
  };

  const current = models.find((m) => m.id === value);
  const shown = value === AUTO ? "auto (let omniroute pick)" : value;
  // where each row sits in `flat`, so a row knows whether the cursor is on it
  const slot = useMemo(() => new Map(flat.map((id, i) => [id, i])), [flat]);

  return (
    <div className={`ms ${open ? "open" : ""}`} ref={box}>
      <button type="button" className="ms-field" onClick={() => setOpen((v) => !v)} title={shown}>
        <span className="ms-val ell">{shown}</span>
        {current && <span className={`ms-tag ${current.free ? "free" : current.unpriced ? "unpriced" : "paid"}`}>{priceOf(current)}</span>}
        <span className="ms-caret">▾</span>
      </button>

      {open && createPortal(
        <div
          className="ms-pop"
          ref={pop}
          style={{
            left: at.left,
            width: at.width,
            ...(at.up ? { bottom: at.fromBottom } : { top: at.top }),
          }}
        >
          <input
            ref={field}
            className="ms-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={models.length ? `search ${models.length} models...` : "no gateway - nothing to search"}
          />

          <div className="ms-chips">
            {(["all", "free", "unpriced", "paid"] as Tier[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`ms-chip ${t} ${tier === t ? "on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTier(t)}
                title={t === "unpriced" ? WHY_UNPRICED : undefined}
              >
                {t === "unpriced" ? "no price" : t}
              </button>
            ))}
          </div>
          <div className="ms-list" ref={listBox}>
            {routers.length > 0 && (
              <div>
                <div className="ms-head">
                  <span className="ell">routers</span>
                  <span className="ms-count">the gateway picks</span>
                </div>
                {routers.map((r) => {
                  const i = slot.get(r.id) ?? -1;
                  return (
                    <div
                      key={r.id}
                      className={`ms-row ${cursor === i ? "on" : ""} ${value === r.id ? "cur" : ""}`}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(r.id)}
                      title={`${r.id} — ${r.blurb}`}
                    >
                      <span className="ms-name">
                        {r.id}
                        <span className="ms-blurb">{r.blurb}</span>
                      </span>
                      <span className="ms-tag auto">router</span>
                    </div>
                  );
                })}
              </div>
            )}

            {groups.map((g) => (
              <div key={g.key}>
                <div className="ms-head">
                  <span className="ell">{g.key}</span>
                  <span className="ms-count">
                    {g.models.length}
                    {g.free > 0 && <b> · {g.free} free</b>}
                  </span>
                </div>
                {g.models.map((m) => {
                  const i = slot.get(m.id) ?? -1;
                  const tone = tierOf(m);
                  return (
                    <div
                      key={m.id}
                      className={`ms-row ${cursor === i ? "on" : ""} ${value === m.id ? "cur" : ""}`}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(m.id)}
                      title={`${m.id}${m.context ? ` · ${Math.round(m.context / 1000)}k context` : ""}${
                        m.unpriced ? `\n${WHY_UNPRICED}` : ""
                      }`}
                    >
                      <span className="ms-name">{restOf(m)}</span>
                      <span className={`ms-tag ${tone}`} title={m.unpriced ? WHY_UNPRICED : undefined}>
                        {priceOf(m)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}

            {!groups.length && (
              <div className="ms-empty">
                {!models.length
                  ? "connect a gateway and the board fills up"
                  : query
                    ? `nothing matches "${query}"`
                    : `no ${tier === "unpriced" ? "unpriced" : tier} models on the board`}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
