// The model dropdown, grouped so that free, unpriced and paid never get confused
// for each other. Shared by the roster, the loadout form and the whiteboard.
import { useFloor } from "../store.ts";

export default function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
