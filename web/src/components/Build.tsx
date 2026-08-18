// The BUILD panel: the folder the floor is working in, what is in it, and what
// the desks have actually put there this shift.
//
// Everything else in the rail describes the office. This one describes your
// disk, which is the only reason build mode is worth having - a desk that says
// it wrote a file and a file that exists are different claims, and this panel
// only ever shows the second one.

import { useCallback, useEffect, useState } from "react";
import { api, post, useFloor } from "../store.ts";

interface TreeResult {
  workspace: string;
  git: boolean;
  entries: string[];
  changed: string[];
}

/** `M  src/app.ts` -> the letter and the path, so the list can colour itself. */
function splitStatus(line: string): { mark: string; path: string } {
  const m = line.match(/^(\S+)\s+(.*)$/);
  return m ? { mark: m[1], path: m[2] } : { mark: "?", path: line };
}

export default function Build() {
  const state = useFloor((s) => s.state);
  const log = useFloor((s) => s.log);
  const root = state?.settings.workspaceRoot ?? null;

  const [draftPath, setDraftPath] = useState(root ?? "");
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setDraftPath(root ?? ""), [root]);

  const refresh = useCallback(async () => {
    if (!root) {
      setTree(null);
      return;
    }
    try {
      setTree(await api<TreeResult>(`/workspace/tree?path=${encodeURIComponent(root)}`));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // a desk writing a file is the one event that makes this panel stale
  const writes = log.filter((e) => e.type === "file.write").length;
  useEffect(() => {
    if (!root) return;
    const h = setTimeout(() => void refresh(), 400);
    return () => clearTimeout(h);
  }, [writes, root, refresh]);

  async function openFolder() {
    const p = draftPath.trim();
    setBusy(true);
    setErr(null);
    try {
      await post("/workspace", { path: p });
      setOpen(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function show(path: string) {
    if (open?.path === path) return setOpen(null);
    try {
      const r = await api<{ path: string; content: string }>(
        `/workspace/file?root=${encodeURIComponent(root ?? "")}&path=${encodeURIComponent(path)}`,
      );
      setOpen({ path, content: r.content });
    } catch (e: any) {
      setErr(e.message);
    }
  }

  // every file any desk has touched this shift, newest first
  const touched = new Map<string, { by: string; ts: number }>();
  for (const e of log) {
    if (e.type !== "file.write" || !e.data?.path) continue;
    const w = state?.workers.find((x) => x.id === e.workerId);
    touched.set(String(e.data.path), { by: w?.name ?? "?", ts: e.ts });
  }
  const shift = [...touched.entries()].sort((a, b) => b[1].ts - a[1].ts);

  const settings = state?.settings;

  return (
    <>
      <div className="card">
        <h4>the working folder</h4>
        <div className="sub" style={{ marginBottom: 6 }}>
          desks with a folder get real tools: list, read, write, edit
          {settings?.shellEnabled !== false ? ", run" : ""} and finish. nothing outside it is reachable.
        </div>
        <div className="row" style={{ marginBottom: 6 }}>
          <input
            className="grow"
            value={draftPath}
            spellCheck={false}
            placeholder="C:\\Users\\you\\Desktop\\the-thing  ·  or ~/code/the-thing"
            onChange={(e) => setDraftPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void openFolder();
            }}
          />
          <button className="btn primary mini" disabled={busy} onClick={() => void openFolder()}>
            {busy ? "..." : root === draftPath.trim() ? "reopen" : "open"}
          </button>
        </div>
        {root && (
          <div className="row wrap">
            <span className="chip ok ell" style={{ maxWidth: "100%" }} title={root}>
              {root}
            </span>
            {tree?.git ? (
              <span className="chip">under git · everything is undoable</span>
            ) : (
              <span className="chip bad">no git here · writes are not undoable</span>
            )}
            <span className="chip">{tree?.entries.length ?? 0} entries</span>
            <span className="grow" />
            <button className="btn mini ghost" onClick={() => void refresh()}>
              refresh
            </button>
            <button
              className="btn mini ghost"
              onClick={() => {
                setDraftPath("");
                void post("/workspace", { path: "" });
              }}
            >
              close
            </button>
          </div>
        )}
        {err && <div className="warn" style={{ marginTop: 6 }}>{err}</div>}
        {!root && (
          <div className="hint" style={{ marginTop: 6 }}>
            it will be created if it is not there, and put under git before anything is written. the folder is
            remembered between shifts, and the order bar switches to BUILD once one is open.
          </div>
        )}
      </div>

      {root && shift.length > 0 && (
        <div className="card">
          <h4>written this shift</h4>
          <div className="sub" style={{ marginBottom: 6 }}>
            {shift.length} file{shift.length === 1 ? "" : "s"} the floor actually put on disk
          </div>
          {shift.slice(0, 40).map(([p, meta]) => (
            <div key={p} className="ws-row" onClick={() => void show(p)}>
              <span className="ws-mark new">+</span>
              <span className="ell grow" title={p}>{p}</span>
              <span className="sub">{meta.by}</span>
            </div>
          ))}
        </div>
      )}

      {root && (tree?.changed.length ?? 0) > 0 && (
        <div className="card">
          <h4>changed since the shift began</h4>
          <div className="sub" style={{ marginBottom: 6 }}>git says this is what is different</div>
          {tree!.changed.slice(0, 60).map((line) => {
            const { mark, path } = splitStatus(line);
            return (
              <div key={line} className="ws-row" onClick={() => void show(path)}>
                <span className={`ws-mark ${mark.includes("?") ? "new" : "edit"}`}>{mark}</span>
                <span className="ell grow" title={path}>{path}</span>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="card">
          <h4 className="ell" title={open.path}>{open.path}</h4>
          <div className="mono-out" style={{ maxHeight: 320 }}>{open.content || "(empty file)"}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn mini ghost" onClick={() => setOpen(null)}>close</button>
            <span className="grow" />
            <button className="btn mini" onClick={() => void navigator.clipboard.writeText(open.content)}>
              copy
            </button>
          </div>
        </div>
      )}

      {root && (
        <div className="card">
          <h4>what is in there</h4>
          {!tree?.entries.length && <div className="sub">empty - nothing has been built yet</div>}
          {tree?.entries.slice(0, 200).map((line) => {
            const [p] = line.split(/\s{2,}/);
            const dir = p.endsWith("/");
            const depth = (p.match(/\//g) ?? []).length - (dir ? 1 : 0);
            return (
              <div
                key={line}
                className={`ws-row ${dir ? "dir" : ""}`}
                style={{ paddingLeft: 4 + depth * 10 }}
                onClick={() => !dir && void show(p)}
              >
                <span className="ell grow" title={p}>{p.split("/").filter(Boolean).pop()}{dir ? "/" : ""}</span>
                <span className="sub">{line.split(/\s{2,}/)[1] ?? ""}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <h4>how hard the desks may work</h4>
        <div className="form-line">
          <span className="k">rounds</span>
          <input
            type="number"
            min={6}
            max={80}
            value={settings?.buildMaxRounds ?? 28}
            onChange={(e) => void post("/settings", { buildMaxRounds: Number(e.target.value) })}
            style={{ width: 64 }}
          />
          <span className="sub">tool calls one desk gets before it has to stop</span>
        </div>
        <div className="form-line">
          <span className="k">repairs</span>
          <input
            type="number"
            min={0}
            max={6}
            value={settings?.repairRounds ?? 2}
            onChange={(e) => void post("/settings", { repairRounds: Number(e.target.value) })}
            style={{ width: 64 }}
          />
          <span className="sub">times a failing check is handed back to fix</span>
        </div>
        <div className="form-line">
          <span className="k">shell</span>
          <span className="seg">
            <button
              className={settings?.shellEnabled !== false ? "on" : ""}
              onClick={() => void post("/settings", { shellEnabled: true })}
            >
              allowlisted
            </button>
            <button
              className={settings?.shellEnabled === false ? "on" : ""}
              onClick={() => void post("/settings", { shellEnabled: false })}
            >
              files only
            </button>
          </span>
        </div>
        <div className="hint">
          the allowlist is build tooling only - npm, node, python, pytest, tsc, git and friends. pipes, redirects
          and subshells are refused outright, and the cwd never leaves the folder.
        </div>
      </div>
    </>
  );
}
