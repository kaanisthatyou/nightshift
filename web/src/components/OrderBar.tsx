import { useEffect, useRef, useState } from "react";
import { post, useFloor } from "../store.ts";

const PLACEHOLDERS = [
  "tell a desk what to do...",
  "summarise this changelog in 5 bullets",
  "write 10 commit messages for a refactor",
  "translate these strings to turkish",
  "name 20 fake employees for a pixel office",
];

export default function OrderBar() {
  const state = useFloor((s) => s.state);
  const selected = useFloor((s) => s.selected);
  const select = useFloor((s) => s.select);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [ph] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const workers = state?.workers ?? [];

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await post("/orders", { text: t, workerId: selected || undefined, wait: false });
      setText("");
    } catch (err: any) {
      alert(`the order bounced: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="orderbar">
      <select value={selected ?? ""} onChange={(e) => select(e.target.value || null)}>
        <option value="">▸ whoever is free</option>
        {workers.map((w) => (
          <option key={w.id} value={w.id}>
            desk {w.desk + 1} · {w.name} · {w.model.split("/").pop()}
          </option>
        ))}
      </select>
      <input
        ref={inputRef}
        value={text}
        placeholder={workers.length ? ph : "hire someone first (roster ▸ hire)"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
        }}
      />
      <button className="btn primary" onClick={() => void send()} disabled={sending || !text.trim()}>
        {sending ? "walking..." : "give order"}
      </button>
    </div>
  );
}
