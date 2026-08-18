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
  const openWhiteboard = useFloor((s) => s.openWhiteboard);
  const setTab = useFloor((s) => s.setTab);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // build is only offered once a folder is open - the switch is the folder
  const root = state?.settings.workspaceRoot ?? null;
  const [build, setBuild] = useState(false);
  const building = build && Boolean(root);
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
      if (building) {
        // a build takes minutes, not seconds - the floor reports back through
        // the window rather than through this request
        await post("/build", { text: t, workspace: root, workerId: selected || undefined, wait: false });
      } else {
        await post("/orders", { text: t, workerId: selected || undefined, wait: false });
      }
      setText("");
    } catch (err: any) {
      alert(`the order bounced: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="orderbar">
      <span className="seg" title={root ? `build into ${root}` : "open a folder under build to turn this on"}>
        <button className={!building ? "on" : ""} onClick={() => setBuild(false)}>text</button>
        <button
          className={building ? "on" : ""}
          onClick={() => {
            if (root) setBuild(true);
            else setTab("build");
          }}
        >
          build
        </button>
      </span>
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
        placeholder={
          !workers.length
            ? "hire someone first (roster ▸ hire)"
            : building
              ? `build it in ${root?.split(/[\\/]/).pop()} - files, not a description of files`
              : ph
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
        }}
      />
      <button
        className="btn"
        title="too big for one desk? put it on the whiteboard and cut it up first"
        onClick={() => {
          setTab("plan");
          openWhiteboard("new", text);
        }}
      >
        plan it
      </button>
      <button className="btn primary" onClick={() => void send()} disabled={sending || !text.trim()}>
        {sending ? "walking..." : building ? "build it" : "give order"}
      </button>
    </div>
  );
}
