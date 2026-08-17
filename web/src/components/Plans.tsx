// The rail's view of the whiteboard: what has been planned, how far down the
// floor it got, and a way back onto the board.
import { useFloor } from "../store.ts";
import type { Plan } from "../../../shared/types.ts";

function PlanCard({ plan }: { plan: Plan }) {
  const state = useFloor((s) => s.state);
  const openWhiteboard = useFloor((s) => s.openWhiteboard);
  const openTask = useFloor((s) => s.openTaskPanel);

  // steps left unticked never became tasks - they should not count against the plan
  const cutSteps = plan.steps.filter((s) => s.taskId);
  const tasks = cutSteps.map((s) => state?.tasks.find((t) => t.id === s.taskId));
  const landed = tasks.filter((t) => t && (t.stage === "review" || t.stage === "done")).length;
  const cost = tasks.reduce((n, t) => n + (t?.costUsd ?? 0), 0);
  const cut = plan.steps.filter((s) => s.enabled).length;

  return (
    <div className="file job" onClick={() => openWhiteboard(plan.id)}>
      <div className="form-title">
        ▦ {plan.title}
        <span className="form-no">
          {plan.status === "draft" ? `${cut} steps · draft` : `${landed}/${tasks.length} back`}
        </span>
      </div>

      {plan.summary && <div className="hint" style={{ marginBottom: 6 }}>{plan.summary}</div>}

      {plan.status !== "draft" && (
        <div className="progress">
          {tasks.map((t, i) => (
            <i
              key={plan.steps[i].id}
              className={t ? `st-${t.stage}` : ""}
              title={`${plan.steps[i].title}${t ? ` · ${t.stage}` : " · not cut"}`}
              onClick={(e) => {
                e.stopPropagation();
                if (t) openTask(t.id);
              }}
            />
          ))}
        </div>
      )}

      <div className="file-actions">
        <span className={`chip ${plan.status === "done" ? "ok" : plan.status === "failed" ? "bad" : ""}`}>
          {plan.status}
        </span>
        <span className="chip">{plan.mode}</span>
        {plan.ghost && <span className="chip ghost">ghost</span>}
        {cost > 0 && <span className="chip paid">${cost.toFixed(4)}</span>}
        <span className="grow" />
        <button
          className="btn mini"
          onClick={(e) => {
            e.stopPropagation();
            openWhiteboard(plan.id);
          }}
        >
          open board
        </button>
      </div>
    </div>
  );
}

export default function Plans() {
  const state = useFloor((s) => s.state);
  const openWhiteboard = useFloor((s) => s.openWhiteboard);
  const plans = (state?.plans ?? []).slice().reverse();

  return (
    <>
      <button className="btn primary" onClick={() => openWhiteboard("new", "")}>
        + span an idea out
      </button>
      {plans.length ? (
        plans.map((p) => <PlanCard key={p.id} plan={p} />)
      ) : (
        <div className="empty">
          nothing planned yet.
          <br />
          put an idea on the whiteboard and let it get cut into work.
        </div>
      )}
    </>
  );
}
