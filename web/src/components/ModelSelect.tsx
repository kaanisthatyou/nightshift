// The model picker. A native select could not do the two things this needs -
// search across 500 model ids, and never open a white browser popup over a 3am
// office - so the list is ours. Grouped so that free, unpriced and paid are
// never mistaken for each other.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFloor } from "../store.ts";
import type { ModelInfo } from "../../../shared/types.ts";

const AUTO = "auto";

/** free -> no price -> paid, and inside a tier the provider prefix keeps its own. */
interface Group {
  key: string;
  label: string;
  tone: "free" | "unpriced" | "paid";
  models: ModelInfo[];
}

function priceOf(m: ModelInfo) {
  if (m.free) return "free";
  if (m.unpriced) return "no price";
  return `$${m.promptCost.toFixed(2)}/M`;
}

/** Match on the whole id, and on the last segment, so "gpt-oss" finds it too. */
function matches(m: ModelInfo, terms: string[]) {
  const hay = `${m.id} ${m.label ?? ""} ${m.owned_by ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function group(models: ModelInfo[], query: string): Group[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = terms.length ? models.filter((m) => matches(m, terms)) : models;

  const tiers: Group[] = [
    { key: "free", label: "free", tone: "free", models: hits.filter((m) => m.free) },
    { key: "unpriced", label: "no price reported", tone: "unpriced", models: hits.filter((m) => m.unpriced) },
    { key: "paid", label: "paid", tone: "paid", models: hits.filter((m) => !m.free && !m.unpriced) },
  ];
  return tiers.filter((t) => t.models.length);
}

export default function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const models = useFloor((s) => s.models);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // the rail scrolls and the desk cards sit inside it, so a popup drawn in place
  // would be cut off at the panel edge. it goes to the body and is placed by hand.
  const [at, setAt] = useState({ left: 0, top: 0, fromBottom: 0, width: 0, up: false });

  const groups = useMemo(() => group(models, query), [models, query]);
  // one flat list behind the groups, so the arrow keys have somewhere to go
  const flat = useMemo(() => [AUTO, ...groups.flatMap((g) => g.models.map((m) => m.id))], [groups]);

  useEffect(() => setCursor(0), [query, open]);

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
      const width = Math.max(r.width, 260);
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
          <div className="ms-list" ref={listBox}>
            <div
              className={`ms-row ${cursor === 0 ? "on" : ""} ${value === AUTO ? "cur" : ""}`}
              onMouseEnter={() => setCursor(0)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(AUTO)}
            >
              <span className="ell">auto (let omniroute pick)</span>
              <span className="ms-tag auto">router</span>
            </div>

            {groups.map((g) => (
              <div key={g.key}>
                <div className={`ms-head ${g.tone}`}>
                  {g.label} <b>{g.models.length}</b>
                </div>
                {g.models.map((m) => {
                  const i = slot.get(m.id) ?? -1;
                  return (
                    <div
                      key={m.id}
                      className={`ms-row ${cursor === i ? "on" : ""} ${value === m.id ? "cur" : ""}`}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(m.id)}
                      title={m.context ? `${m.id} · ${Math.round(m.context / 1000)}k context` : m.id}
                    >
                      <span className="ell">{m.id}</span>
                      <span className={`ms-tag ${g.tone}`}>{priceOf(m)}</span>
                    </div>
                  );
                })}
              </div>
            ))}

            {!groups.length && (
              <div className="ms-empty">
                {models.length ? `nothing matches "${query}"` : "connect a gateway and the board fills up"}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
