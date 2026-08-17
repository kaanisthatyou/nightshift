// The whiteboard. An idea goes up, and comes down as steps a desk can actually do.
//
// Planning does not run through the floor - no desk animates, nobody gets a task.
// It is one call to the gateway that returns JSON, which is why it uses
// gateway.complete() rather than the streaming chat the workers use.

import { dispatch, gateway, wake } from "./engine.ts";
import { store, blankStep } from "./store.ts";
import { PRESETS, preset, roleSpec } from "../shared/presets.ts";
import type { Plan, PlanStep, Worker } from "../shared/types.ts";

const PLANNER_SYSTEM =
  "You are the night shift planner. You do not do the work - you cut it into pieces other desks can do. " +
  "You answer with JSON and nothing else: no prose, no markdown fence, no explanation.";

/** Models sometimes wrap JSON in a fence, or in an apology. Dig it out. */
export function extractJson(raw: string): any {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the planner did not return JSON");
  return JSON.parse(body.slice(start, end + 1));
}

function rosterFor(presetId: string | null): string {
  const p = preset(presetId);
  const lines: string[] = [];
  const seen = new Set<string>();

  // whoever is actually sitting on the floor comes first - those are real desks
  for (const w of store.state.workers) {
    if (!w.role || seen.has(w.role)) continue;
    seen.add(w.role);
    lines.push(`- ${w.role}: ${w.title} (${w.name}, at a desk right now)`);
  }
  for (const r of p?.roles ?? []) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    lines.push(`- ${r.key}: ${r.title} - ${r.blurb}`);
  }
  if (!lines.length) lines.push("- hand: generalist, will take anything");
  return lines.join("\n");
}

function draftPrompt(idea: string, presetId: string | null, count: number): string {
  const p = preset(presetId);
  return [
    p ? `The floor is set up as: ${p.name} - ${p.tagline}.` : "",
    "Cut the idea below into work items for a floor of small, cheap AI models.",
    "",
    "Rules:",
    `- ${count} steps. Fewer only if the idea genuinely does not need that many.`,
    "- Each step must be finishable by one model in one reply. No tools, no internet, no file access.",
    "- Each step's prompt must stand on its own: restate whatever context it needs, and say exactly what to output.",
    "- Order them so that later steps can build on earlier ones. Write {{input}} where a step should receive the previous step's output.",
    "- Assign each step a roleKey from the roster. Use the key exactly as written.",
    "- No step may be 'review the plan' or 'coordinate' - every step produces a real artefact.",
    "",
    "Roster:",
    rosterFor(presetId),
    "",
    "Idea:",
    idea,
    "",
    'Return exactly this JSON shape:',
    '{"title":"short name for the whole thing","summary":"one sentence on the approach",' +
      '"steps":[{"title":"short step name","prompt":"the full self-contained instruction","roleKey":"key from the roster","note":"why this step exists, one short line"}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function expandPrompt(step: PlanStep, plan: Plan, count: number): string {
  return [
    `This is one step out of a plan called "${plan.title}".`,
    plan.summary ? `The plan overall: ${plan.summary}` : "",
    "",
    "Break this single step into smaller steps, each finishable by one small model in one reply.",
    `Give ${count} sub-steps. Keep the same intent - do not widen the scope.`,
    "",
    "Roster:",
    rosterFor(plan.presetId),
    "",
    `Step title: ${step.title}`,
    "Step instruction:",
    step.prompt || step.title,
    "",
    'Return exactly this JSON shape:',
    '{"steps":[{"title":"...","prompt":"...","roleKey":"...","note":"..."}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function coerceSteps(raw: any, presetId: string | null): PlanStep[] {
  const list = Array.isArray(raw?.steps) ? raw.steps : [];
  return list
    .map((s: any) => {
      const prompt = String(s?.prompt ?? "").trim();
      if (!prompt) return null;
      const roleKey = typeof s?.roleKey === "string" ? s.roleKey.trim() : null;
      // a key the model invented is worse than no key at all - it would route nowhere
      const known = roleKey && (roleSpec(presetId, roleKey) || store.state.workers.some((w) => w.role === roleKey));
      return blankStep({
        title: String(s?.title ?? prompt.split("\n")[0]).slice(0, 70),
        prompt,
        roleKey: known ? roleKey : null,
        note: s?.note ? String(s.note).slice(0, 160) : null,
      });
    })
    .filter(Boolean) as PlanStep[];
}

/** What the whiteboard says when there is nothing on the other end of the wire. */
function ghostSteps(idea: string, presetId: string | null): PlanStep[] {
  const roles = (preset(presetId)?.roles ?? PRESETS.at(-1)!.roles).filter((r) => r.core).slice(0, 4);
  const head = idea.split("\n")[0].slice(0, 60);
  return roles.map((r, i) =>
    blankStep({
      title: `${r.title}: ${head}`,
      prompt:
        `${r.blurb} for: ${idea}\n\n` +
        (i > 0 ? "Build on what the previous desk sent:\n{{input}}\n\n" : "") +
        "(This step was written by the offline whiteboard, not by a model. Edit it before sending it down.)",
      roleKey: r.key,
      note: "drafted offline - the gateway was not reachable",
    }),
  );
}

export interface DraftResult {
  plan: Plan;
  costUsd: number;
}

/** Idea in, plan on the board. Nothing is dispatched. */
export async function draftPlan(opts: {
  idea: string;
  presetId?: string | null;
  title?: string | null;
  steps?: number;
  model?: string | null;
}): Promise<DraftResult> {
  const idea = opts.idea.trim();
  const presetId = opts.presetId ?? null;
  const count = Math.max(2, Math.min(10, Number(opts.steps) || 5));
  const model = opts.model || store.state.settings.plannerModel || store.state.settings.defaultModel;

  store.emitEvent({
    type: "boss.say",
    text: `tahtaya yaziyorum: ${idea.slice(0, 60)}${idea.length > 60 ? "..." : ""}`,
    data: { whiteboard: true },
  });

  if (!gateway.status.online) {
    if (!store.state.settings.ghostMode) throw new Error("gateway offline and ghost mode is off");
    const plan = store.addPlan({
      title: opts.title || idea.split("\n")[0].slice(0, 60),
      idea,
      summary: "drafted with the gateway down - these steps are a skeleton, not a plan",
      presetId,
      steps: ghostSteps(idea, presetId),
      mode: "chain",
      status: "draft",
      jobId: null,
      draftedBy: "ghost",
      ghost: true,
    });
    return { plan, costUsd: 0 };
  }

  const res = await gateway.complete({
    model,
    system: PLANNER_SYSTEM,
    prompt: draftPrompt(idea, presetId, count),
    temperature: 0.6,
    maxTokens: 2600,
    signal: AbortSignal.timeout(120_000),
  });

  const parsed = extractJson(res.text);
  const steps = coerceSteps(parsed, presetId);
  if (!steps.length) throw new Error("the planner came back with no usable steps");

  // planning is real spend - it belongs in the same ledger as everything else
  store.state.ledger.tokensIn += res.tokensIn;
  store.state.ledger.tokensOut += res.tokensOut;
  store.state.ledger.costUsd += res.costUsd;

  const plan = store.addPlan({
    title: String(opts.title || parsed?.title || idea.split("\n")[0]).slice(0, 70),
    idea,
    summary: String(parsed?.summary ?? "").slice(0, 300),
    presetId,
    steps,
    mode: "chain",
    status: "draft",
    jobId: null,
    draftedBy: res.model,
    ghost: false,
  });
  return { plan, costUsd: res.costUsd };
}

/** One step becomes several. The rest of the plan stays where it is. */
export async function expandStep(plan: Plan, stepId: string, count = 3): Promise<PlanStep[]> {
  const i = plan.steps.findIndex((s) => s.id === stepId);
  if (i < 0) throw new Error("no such step");
  const step = plan.steps[i];

  let fresh: PlanStep[];
  if (gateway.status.online) {
    const res = await gateway.complete({
      model: store.state.settings.plannerModel || store.state.settings.defaultModel,
      system: PLANNER_SYSTEM,
      prompt: expandPrompt(step, plan, Math.max(2, Math.min(6, count))),
      temperature: 0.6,
      maxTokens: 1800,
      signal: AbortSignal.timeout(90_000),
    });
    fresh = coerceSteps(extractJson(res.text), plan.presetId);
    store.state.ledger.tokensIn += res.tokensIn;
    store.state.ledger.tokensOut += res.tokensOut;
    store.state.ledger.costUsd += res.costUsd;
  } else {
    if (!store.state.settings.ghostMode) throw new Error("gateway offline and ghost mode is off");
    fresh = Array.from({ length: 2 }, (_, n) =>
      blankStep({
        title: `${step.title} (${n + 1})`,
        prompt: step.prompt,
        roleKey: step.roleKey,
        note: "split offline - edit before sending down",
      }),
    );
  }
  if (!fresh.length) throw new Error("nothing came back to split it into");

  // the step it came from is replaced by its own pieces
  plan.steps.splice(i, 1, ...fresh);
  store.touch();
  return fresh;
}

/** Which desk should take this step. roleKey first, then anyone free. */
export function deskFor(step: PlanStep, taken: Set<string>): Worker | null {
  if (step.workerId) {
    const pinned = store.worker(step.workerId);
    if (pinned) return pinned;
  }
  const byRole = store.state.workers.filter((w) => step.roleKey && w.role === step.roleKey);
  const fresh = byRole.find((w) => !taken.has(w.id));
  if (fresh) return fresh;
  if (byRole.length) return byRole[0]; // the specialist is worth a queue
  return null;
}

/**
 * Cut the plan into real work. `chain` makes a pipeline where each step feeds
 * the next; `split` throws every step onto the floor at once.
 */
export function runPlan(plan: Plan, mode?: Plan["mode"]) {
  const steps = plan.steps.filter((s) => s.enabled && s.prompt.trim());
  if (!steps.length) throw new Error("no enabled steps with a prompt");
  plan.mode = mode ?? plan.mode;

  const kind = plan.mode === "split" ? "batch" : "pipeline";
  const ids: string[] = [];
  const job = store.addJob(plan.title, ids, kind);
  const taken = new Set<string>();

  steps.forEach((step, i) => {
    const desk = deskFor(step, taken);
    if (desk) taken.add(desk.id);
    const task = store.addTask({
      title: step.title,
      prompt: step.prompt,
      system: null, // the desk answers as itself - that is the point of hiring a role
      workerId: desk?.id ?? null,
      createdBy: "pipeline",
      // a chain releases one step at a time; a split goes out together
      stage: plan.mode === "split" ? "queued" : i === 0 ? "queued" : "backlog",
      jobId: job.id,
      stepIndex: i,
      planId: plan.id,
      retriesLeft: 1,
    });
    step.taskId = task.id;
    ids.push(task.id);
  });

  job.taskIds = ids;
  plan.jobId = job.id;
  plan.status = "running";

  if (plan.mode === "split") {
    // a bell wakes the whole floor
    for (const w of store.state.workers) wake(w.id);
  } else {
    // the boss walks the first order over himself; the rest follow the chain
    dispatch(ids[0], store.task(ids[0])?.workerId ?? null, steps[0].title);
  }

  store.emitEvent({
    type: "plan.run",
    text: `${plan.title}: ${steps.length} is masalara dagitiliyor`,
    data: { planId: plan.id, jobId: job.id, mode: plan.mode },
  });
  store.emitEvent({
    type: "boss.say",
    text: plan.mode === "split" ? "hepiniz ayni anda basliyorsunuz." : "sirayla. ilk masa baslasin.",
    data: { planId: plan.id },
  });
  store.touch();
  return { job, taskIds: ids };
}
