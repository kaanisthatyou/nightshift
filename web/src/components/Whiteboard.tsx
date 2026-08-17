// The whiteboard: an idea goes up, gets cut into steps, gets desks put against
// the steps, and then goes down to the floor as one job.
//
// Everything here is editable before anything runs. The board is the point -
// the model's draft is a starting position, not an instruction.

import { useEffect, useMemo, useRef, useState } from "react";
import { del, patch, post, useFloor } from "../store.ts";
import ModelSelect from "./ModelSelect.tsx";
import type { Plan, PlanStep } from "../../../shared/types.ts";

const uid = () => `s_${Math.random().toString(36).slice(2, 9)}`;

const blank = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: uid(),
  title: "new step",
  prompt: "",
  roleKey: null,
  workerId: null,
  note: null,
  enabled: true,
  taskId: null,
  ...over,
});

/**
 * One control for "who does this": a pinned desk wins, otherwise a role, and
 * failing both the step goes to whoever is free. The value is prefixed so both
 * kinds fit in one select.
 */
function DeskSelect({ step, presetId, onChange }: {
  step: PlanStep;
  presetId: string | null;
  onChange: (patch: Partial<PlanStep>) => void;
}) {
  const state = useFloor((s) => s.state);
  const presets = useFloor((s) => s.presets);
  const workers = state?.workers ?? [];
  const roles = presets.find((p) => p.id === presetId)?.roles ?? [];
  const value = step.workerId ? `w:${step.workerId}` : step.roleKey ? `r:${step.roleKey}` : "";

  return (
    <span className="strip step-who">
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith("w:")) onChange({ workerId: v.slice(2), roleKey: null });
          else if (v.startsWith("r:")) onChange({ roleKey: v.slice(2), workerId: null });
          else onChange({ roleKey: null, workerId: null });
        }}
      >
        <option value="">▸ whoever is free</option>
        {workers.length > 0 && (
          <optgroup label="pin to a desk">
            {workers.map((w) => (
              <option key={w.id} value={`w:${w.id}`}>
                {w.name} · {w.title}
              </option>
            ))}
          </optgroup>
        )}
        {roles.length > 0 && (
          <optgroup label="by role">
            {roles.map((r) => (
              <option key={r.key} value={`r:${r.key}`}>
                {r.title}
              </option>
            ))}
          </optgroup>
        )}
        {/* a role the draft picked that isn't in the current preset still has to show */}
        {step.roleKey && !roles.some((r) => r.key === step.roleKey) && (
          <option value={`r:${step.roleKey}`}>{step.roleKey}</option>
        )}
      </select>
    </span>
  );
}

function StepCard({ index, step, plan, onPatch, onMove, onDrop, onExpand, busy }: {
  index: number;
  step: PlanStep;
  plan: Plan;
  onPatch: (p: Partial<PlanStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onDrop: () => void;
  onExpand: () => void;
  busy: boolean;
}) {
  const state = useFloor((s) => s.state);
  const openTask = useFloor((s) => s.openTaskPanel);
  const task = state?.tasks.find((t) => t.id === step.taskId);
  const live = plan.status !== "draft";

  return (
    <div className={`wb-step ${step.enabled ? "" : "off"} ${task ? `st-${task.stage}` : ""}`}>
      <div className="wb-step-head">
        <span className="wb-no">{String(index + 1).padStart(2, "0")}</span>
        <input
          className="wb-step-title grow"
          value={step.title}
          placeholder="what this step is called"
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <DeskSelect step={step} presetId={plan.presetId} onChange={onPatch} />
        <button className="btn mini ghost" title="move up" disabled={index === 0 || live} onClick={() => onMove(-1)}>
          ▲
        </button>
        <button className="btn mini ghost" title="move down" disabled={live} onClick={() => onMove(1)}>
          ▼
        </button>
        <button className="btn mini ghost danger" title="drop this step" disabled={live} onClick={onDrop}>
          ✕
        </button>
      </div>

      <textarea
        className="wb-step-body"
        value={step.prompt}
        placeholder="the whole instruction, standing on its own. {{input}} pulls in the previous step's output."
        onChange={(e) => onPatch({ prompt: e.target.value })}
      />

      <div className="wb-step-foot">
        <label className="tick" title="untick to leave this one on the board">
          <input type="checkbox" checked={step.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          <i />
          <span>in</span>
        </label>
        {step.prompt.includes("{{input}}") && <span className="chip">↩ takes previous output</span>}
        {step.note && <span className="hint ell grow">{step.note}</span>}
        <span className="grow" />
        {task ? (
          <button className="btn mini" onClick={() => openTask(task.id)}>
            {task.stage} ▸ open
          </button>
        ) : (
          <button className="btn mini" disabled={busy || live} onClick={onExpand} title="break this step into smaller ones">
            split this one
          </button>
        )}
      </div>
    </div>
  );
}

/** The blank board: nothing has been drafted yet. */
function Composer({ onDrafted }: { onDrafted: (id: string) => void }) {
  const presets = useFloor((s) => s.presets);
  const state = useFloor((s) => s.state);
  const seedIdea = useFloor((s) => s.seedIdea);
  const [idea, setIdea] = useState(seedIdea);
  const [presetId, setPresetId] = useState("");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (presetId || !presets.length) return;
    setPresetId(state?.workers.find((w) => w.presetId)?.presetId ?? presets[0].id);
  }, [presets, presetId, state]);

  async function draft() {
    if (!idea.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ plan: Plan }>("/plans", { idea, presetId: presetId || null, stepCount: count });
      onDrafted(r.plan.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function byHand() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ plan: Plan }>("/plans", {
        idea,
        title: idea.split("\n")[0].slice(0, 60) || "untitled plan",
        presetId: presetId || null,
        steps: [{ title: "step 1", prompt: idea }],
      });
      onDrafted(r.plan.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wb-blank">
      <div className="wb-blank-inner">
        <div className="form-title">
          the idea <span className="form-no">nothing runs until you send it down</span>
        </div>
        <textarea
          ref={ref}
          className="wb-idea"
          value={idea}
          placeholder={
            "type the whole thing. messy is fine.\n\n" +
            "e.g. a roblox tycoon where you run a night bakery - i want the core loop, the first three upgrades, " +
            "the ui for the order counter, and something that makes people come back tomorrow"
          }
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void draft();
          }}
        />
        <div className="row wrap" style={{ marginTop: 8 }}>
          <span className="k">floor</span>
          <span className="strip" style={{ minWidth: 170 }}>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">no particular crew</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
          <span className="k">steps</span>
          <span className="desk-dots" style={{ maxWidth: 110 }}>
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
              <i
                key={n}
                className={n <= count ? "taken" : ""}
                onClick={() => setCount(Math.max(2, n))}
                style={{ cursor: "pointer" }}
              />
            ))}
          </span>
          <span className="v">{count} steps</span>
          <span className="grow" />
          <button className="btn" disabled={busy || !idea.trim()} onClick={() => void byHand()}>
            start empty
          </button>
          <button className="btn primary" disabled={busy || !idea.trim()} onClick={() => void draft()}>
            {busy ? "at the board..." : "span it out"}
          </button>
        </div>
        {err && <div className="warn" style={{ marginTop: 8 }}>{err}</div>}
        <div className="hint" style={{ marginTop: 8 }}>
          ctrl/cmd + enter spans it out. the planner runs on the model set under mains ▸ planner.
        </div>
      </div>
    </div>
  );
}

function Board({ plan }: { plan: Plan }) {
  const openWhiteboard = useFloor((s) => s.openWhiteboard);
  const setTab = useFloor((s) => s.setTab);
  const state = useFloor((s) => s.state);
  const [local, setLocal] = useState<Plan>(plan);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dirty = useRef(false);

  // Resync only when the server changes the plan's shape - never mid-keystroke,
  // or the debounced save below would fight whatever is being typed.
  const shape = `${plan.id}:${plan.steps.length}:${plan.status}:${plan.jobId}`;
  useEffect(() => {
    dirty.current = false;
    setLocal(JSON.parse(JSON.stringify(plan)));
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // edits go back to the server on a leash
  useEffect(() => {
    if (!dirty.current || local.status !== "draft") return;
    const h = setTimeout(() => {
      dirty.current = false;
      void patch(`/plans/${local.id}`, {
        title: local.title,
        summary: local.summary,
        mode: local.mode,
        steps: local.steps,
      }).catch(() => {});
    }, 700);
    return () => clearTimeout(h);
  }, [local]);

  const edit = (fn: (p: Plan) => Plan) => {
    dirty.current = true;
    setLocal(fn);
  };
  const patchStep = (id: string, p: Partial<PlanStep>) =>
    edit((cur) => ({ ...cur, steps: cur.steps.map((s) => (s.id === id ? { ...s, ...p } : s)) }));

  const move = (id: string, dir: -1 | 1) =>
    edit((cur) => {
      const i = cur.steps.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.steps.length) return cur;
      const steps = [...cur.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...cur, steps };
    });

  async function expand(stepId: string) {
    setBusy(stepId);
    setErr(null);
    try {
      // save what is on screen first, or the server would split a stale step
      await patch(`/plans/${local.id}`, { steps: local.steps });
      dirty.current = false;
      await post(`/plans/${local.id}/expand`, { stepId, count: 3 });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function sendDown() {
    setBusy("run");
    setErr(null);
    try {
      await patch(`/plans/${local.id}`, {
        title: local.title,
        summary: local.summary,
        mode: local.mode,
        steps: local.steps,
      });
      dirty.current = false;
      await post(`/plans/${local.id}/run`, { mode: local.mode });
      // the floor is the show - get out of its way and watch it from the rail
      openWhiteboard(null);
      setTab("plan");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  const live = local.status !== "draft";
  const enabled = local.steps.filter((s) => s.enabled && s.prompt.trim()).length;
  const tasks = local.steps.map((s) => state?.tasks.find((t) => t.id === s.taskId)).filter(Boolean);
  const back = tasks.filter((t) => t!.stage === "review" || t!.stage === "done").length;

  // a step wanting a role nobody on the floor has is the most common way a plan stalls
  const missing = useMemo(() => {
    const have = new Set((state?.workers ?? []).map((w) => w.role).filter(Boolean));
    return [...new Set(local.steps.filter((s) => s.enabled && s.roleKey && !have.has(s.roleKey)).map((s) => s.roleKey))];
  }, [local.steps, state?.workers]);

  return (
    <>
      <div className="wb-bar">
        <input
          className="wb-title"
          value={local.title}
          onChange={(e) => edit((c) => ({ ...c, title: e.target.value }))}
          disabled={live}
        />
        <span className={`chip ${live ? (local.status === "done" ? "ok" : local.status === "failed" ? "bad" : "") : ""}`}>
          {local.status}
        </span>
        {local.ghost && <span className="chip ghost">ghost draft</span>}
        {local.draftedBy && <span className="chip ell" style={{ maxWidth: 190 }}>drafted by {local.draftedBy}</span>}
        <span className="grow" />
        {live ? (
          <span className="chip">{back}/{tasks.length} back</span>
        ) : (
          <>
            <span className="seg">
              <button className={local.mode === "chain" ? "on" : ""} onClick={() => edit((c) => ({ ...c, mode: "chain" }))}>
                chain
              </button>
              <button className={local.mode === "split" ? "on" : ""} onClick={() => edit((c) => ({ ...c, mode: "split" }))}>
                split
              </button>
            </span>
            <button
              className="btn mini"
              onClick={() => edit((c) => ({ ...c, steps: [...c.steps, blank({ title: `step ${c.steps.length + 1}` })] }))}
            >
              + add another
            </button>
            <button
              className="btn primary"
              disabled={!enabled || busy === "run"}
              title={
                local.mode === "split"
                  ? "every step goes out now, across every free desk"
                  : "one step at a time, each feeding the next"
              }
              onClick={() => void sendDown()}
            >
              {busy === "run"
                ? "handing it out..."
                : `send ${enabled} down ${local.mode === "split" ? "at once" : "in order"}`}
            </button>
          </>
        )}
      </div>

      {local.summary && <div className="wb-summary">{local.summary}</div>}
      {err && <div className="warn" style={{ margin: "0 12px 8px" }}>{err}</div>}
      {!live && missing.length > 0 && (
        <div className="wb-note">
          no desk holds {missing.join(", ")} — those steps go to whoever is free. hire the role in <b>crew</b> to route them properly.
        </div>
      )}
      {local.mode === "chain" && !live && (
        <div className="wb-note dim">
          chain: one desk at a time. each step waits for the one above it and <kbd>{"{{input}}"}</kbd> receives its
          output, so the floor runs at the speed of a single desk. one failure stops the rest.
        </div>
      )}
      {local.mode === "split" && !live && (
        <div className="wb-note dim">
          split: every step leaves at once and a different desk takes each one — the whole floor works in
          parallel. nothing feeds anything, so each prompt has to carry its own context.
        </div>
      )}

      <div className="wb-steps">
        {local.steps.map((s, i) => (
          <StepCard
            key={s.id}
            index={i}
            step={s}
            plan={local}
            busy={busy === s.id}
            onPatch={(p) => patchStep(s.id, p)}
            onMove={(d) => move(s.id, d)}
            onDrop={() => edit((c) => ({ ...c, steps: c.steps.filter((x) => x.id !== s.id) }))}
            onExpand={() => void expand(s.id)}
          />
        ))}
        {!local.steps.length && <div className="empty">nothing on the board. add a step.</div>}

        <div className="wb-foot">
          <span className="hint grow ell">the idea: {local.idea || "(typed straight onto the board)"}</span>
          <button
            className="btn mini danger"
            onClick={() => {
              if (!confirm("wipe this plan off the board?")) return;
              void del(`/plans/${local.id}`);
              openWhiteboard(null);
            }}
          >
            wipe the board
          </button>
        </div>
      </div>
    </>
  );
}

export default function Whiteboard() {
  const whiteboard = useFloor((s) => s.whiteboard);
  const openWhiteboard = useFloor((s) => s.openWhiteboard);
  const state = useFloor((s) => s.state);
  const plans = state?.plans ?? [];
  const plan = plans.find((p) => p.id === whiteboard);

  if (!whiteboard) return null;

  return (
    <div className="wb">
      <div className="wb-head">
        <span className="logo">THE WHITE<b>BOARD</b></span>
        <span className="sub">an idea, cut into work</span>
        <span className="grow" />
        {plans.length > 0 && (
          <span className="strip" style={{ minWidth: 190 }}>
            <select value={plan?.id ?? ""} onChange={(e) => openWhiteboard(e.target.value || "new")}>
              <option value="">▸ new plan</option>
              {plans
                .slice()
                .reverse()
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.status === "draft" ? "○" : p.status === "running" ? "◐" : "●"} {p.title}
                  </option>
                ))}
            </select>
          </span>
        )}
        <span className="k">planner</span>
        <span className="strip" style={{ minWidth: 160 }}>
          <ModelSelect
            value={state?.settings.plannerModel ?? "auto"}
            onChange={(v) => void post("/settings", { plannerModel: v })}
          />
        </span>
        <button className="btn mini" onClick={() => openWhiteboard(null)}>
          close (esc)
        </button>
      </div>

      {plan ? <Board key={plan.id} plan={plan} /> : <Composer onDrafted={(id) => openWhiteboard(id)} />}
    </div>
  );
}
