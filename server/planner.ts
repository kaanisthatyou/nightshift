// The whiteboard. An idea goes up, and comes down as steps a desk can actually do.
//
// Planning does not run through the floor - no desk animates, nobody gets a task.
// It is one call to the gateway that returns JSON, which is why it uses
// gateway.complete() rather than the streaming chat the workers use.

import fs from "node:fs";
import path from "node:path";
import { dispatch, gateway, wake } from "./engine.ts";
import { store, blankStep } from "./store.ts";
import { PRESETS, preset, roleSpec } from "../shared/presets.ts";
import { openWorkspace, tree } from "./workspace.ts";
import type { Plan, PlanStep, Worker } from "../shared/types.ts";

const PLANNER_SYSTEM =
  "You are the night shift planner. You do not do the work - you cut it into pieces other desks can do. " +
  "You answer with JSON and nothing else: no prose, no markdown fence, no explanation.";

/**
 * Models sometimes wrap JSON in a fence, or in an apology. Dig it out.
 *
 * Cheap models get it almost right often enough that "almost" is worth
 * handling: a trailing comma before a brace, a // note the model could not
 * resist. Those are repaired rather than thrown away - a plan lost to a stray
 * comma is a whole minute of a free model's day for nothing.
 */
export function extractJson(raw: string): any {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the planner did not return JSON");
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (first) {
    const repaired = slice
      // a // comment, but not the // inside a "http://..." string
      .replace(/(^|[^:"'\\])\/\/[^\n"]*/g, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch {
      // Nothing is wrong with the shape - the model simply stopped mid-word,
      // because a plan is the longest thing a cheap model ever writes here.
      // Six finished steps are worth far more than the exception that throws
      // all six away along with the ten minutes it took to write them.
      const rescued = closeTruncated(repaired);
      if (rescued) return rescued;
      throw first; // say what was actually wrong with what it sent
    }
  }
}

/**
 * Rewind a cut-off answer to the last point where it was structurally whole,
 * and close it there.
 *
 * The floor runs on free models measured at about eight tokens a second, and a
 * build plan is thousands of them in one un-streamed reply, so being cut off is
 * a routine outcome rather than a freak one. Every position where a value had
 * just finished is a candidate ending; we walk them from the back and keep the
 * first that parses, which is the longest salvageable prefix. Returns null when
 * there is genuinely nothing whole in there.
 */
function closeTruncated(slice: string): any | null {
  const open: string[] = [];
  const marks: { pos: number; close: string }[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") open.push("}");
    else if (ch === "[") open.push("]");
    else if (ch === "}" || ch === "]") {
      open.pop();
      // a value just closed here, so everything still open could be closed too
      marks.push({ pos: i + 1, close: [...open].reverse().join("") });
    }
  }

  for (let i = marks.length - 1; i >= 0; i--) {
    const { pos, close } = marks[i];
    try {
      return JSON.parse(slice.slice(0, pos) + close);
    } catch {
      /* that cut was still mid-structure - keep rewinding */
    }
  }
  return null;
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
    "- The desks work at the same time, so prefer steps that do not need each other. Split the idea by subject, " +
      "not into a relay: cut it into parts that a different person could each take right now.",
    "- Only where a step genuinely cannot start without the one before it, write {{input}} in its prompt to " +
      "receive that output - and use it as rarely as the idea allows.",
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

/**
 * What the folder looks like right now, in the few hundred lines a planner
 * can actually use. An empty folder is worth saying out loud - it changes the
 * plan from "extend this" to "start it".
 */
function survey(root: string): string {
  let listing: string[] = [];
  try {
    listing = tree(root, ".", 200);
  } catch {
    listing = [];
  }
  if (!listing.length) return "The folder is empty. Nothing exists yet - the plan has to create the project from nothing.";

  const parts = [`The folder already contains ${listing.length} entries:`, listing.join("\n")];
  // a manifest tells the planner the stack, the scripts and the deps in one read
  for (const name of ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"]) {
    const hit = listing.find((l) => l.split(/\s+/)[0] === name);
    if (!hit) continue;
    try {
      const body = fs.readFileSync(path.join(root, name), "utf8");
      parts.push(`\n${name}:\n${body.slice(0, 1800)}`);
    } catch {
      /* unreadable - the listing is still worth something */
    }
    break;
  }
  return parts.join("\n");
}

/**
 * The build brief. This is a different job from cutting an idea into essays:
 * the steps have to divide a filesystem, and anything crossing a file boundary
 * has to be pinned down here, because the desks cannot talk to each other.
 */
function buildDraftPrompt(idea: string, root: string, presetId: string | null, count: number): string {
  return [
    `The floor is working inside a real project folder: ${root}`,
    "",
    survey(root),
    "",
    "Cut the idea below into steps that WRITE FILES into that folder.",
    "",
    "Each step is done by one small, cheap model that has exactly six tools:",
    "list_files, read_file, write_file, edit_file, run (build tooling only), finish.",
    "",
    "This is a whole floor, not one model. Plan for what the idea actually deserves - the finished thing a",
    "competent team would hand over - and then divide that. Do not shrink the product to fit the desks.",
    "",
    "Rules:",
    `- Use as many steps as the work genuinely needs, up to ${count}. Do not pad a small idea to reach that`,
    "  number, and do not compress a real product into four steps - a step that quietly carries three unrelated",
    "  concerns is one desk doing the whole job badly.",
    "- Scope it like a product, not a demo. Pick the stack the idea actually calls for and say so: a real",
    "  framework, real dependencies, a real dependency manifest. A build tool the desks install is fine - they",
    "  can run npm, pip, cargo and the rest. Do not fall back to a single static file to keep things simple.",
    "- Every step must leave a complete, non-trivial slice behind: real logic, real state, real error handling,",
    "  the styling the thing needs to look finished. No placeholder copy, no 'TODO: implement', no stub that",
    "  returns an empty array, no file that only re-exports another.",
    "- Every step must list, in `files`, the exact paths it owns. Two steps must never claim the same path;",
    "  the floor refuses a write outside a step's own list, so an overlap becomes a blocked desk.",
    "- Between them the steps must cover a project that actually runs: entry point, config, dependency",
    "  manifest, and anything the entry point imports. Nothing may be left 'to be added later'.",
    "- The desks cannot see each other's work while they write. So pin every shared contract in `summary`:",
    "  exact file paths, exported names, function signatures, route paths, data shapes. Then repeat the",
    "  relevant half of that contract inside the prompt of every step that touches it.",
    "- Each step's prompt stands on its own: which files to create, what goes in each, and what it may assume",
    "  already exists. Write it as an instruction to a competent junior, not as a summary.",
    "- Write those prompts tight. Dense instruction, no preamble, no restating the idea back, no encouragement -",
    "  every wasted sentence is a wasted second, and this plan is being written by a slow model. Ambition belongs",
    "  in what you ask for, never in how many words you use to ask.",
    "- Give every step a `done` line: the one observable thing that is true when that step is genuinely",
    "  finished. Write it as something a reader could check, not as a restatement of the title.",
    "- If the folder has no project skeleton yet, the first step creates it - manifest, config, folder layout,",
    "  and the shared types or interfaces the later steps import.",
    "- `verify` is one command that proves the whole thing works when run in that folder, e.g. `npm run build`,",
    "  `npm test`, `node index.js --check`, `pytest -q`, `tsc --noEmit`. It must be real: a command the plan's own",
    "  files make runnable. If nothing sensible can be checked, use an empty string.",
    "- No step may be 'review', 'coordinate' or 'document the plan'. Every step leaves files on disk.",
    "",
    "Roster:",
    rosterFor(presetId),
    "",
    "Idea:",
    idea,
    "",
    "Return exactly this JSON shape:",
    '{"title":"short name for the whole thing",' +
    '"summary":"the approach, and the exact shared contract every step must obey",' +
    '"verify":"the one command that proves it works",' +
    '"steps":[{"title":"short step name","prompt":"the full self-contained instruction",' +
    '"roleKey":"key from the roster","files":["exact/path.ts","another/path.ts"],' +
    '"done":"the observable thing that is true when this step is finished",' +
    '"note":"why this step exists, one short line"}]}',
  ].join("\n");
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

/**
 * The planner's JSON turned into steps the floor can run. Exported for the same
 * reason `extractJson` is: this is where a cheap model's near-miss either gets
 * repaired or quietly loses a step, and that is worth a check.
 */
export function coerceSteps(raw: any, presetId: string | null): PlanStep[] {
  const list = Array.isArray(raw?.steps) ? raw.steps : [];
  const taken = new Set<string>();
  return list
    .map((s: any) => {
      let prompt = String(s?.prompt ?? "").trim();
      if (!prompt) return null;
      // The planner's own bar for the step, handed to the desk that works it.
      // It lives on the prompt rather than on the step because that is where a
      // desk actually reads it - and a desk told what "finished" means stops
      // one file short far less often than one told only what to write.
      const done = String(s?.done ?? "").trim();
      if (done) prompt = `${prompt}\n\n--- THIS STEP IS DONE WHEN ---\n${done}`;
      const roleKey = typeof s?.roleKey === "string" ? s.roleKey.trim() : null;
      // a key the model invented is worse than no key at all - it would route nowhere
      const known = roleKey && (roleSpec(presetId, roleKey) || store.state.workers.some((w) => w.role === roleKey));
      // a planner that names the same file twice would deadlock two desks against
      // each other, so the first claim on a path wins and the rest is dropped
      const claims = (Array.isArray(s?.files) ? s.files : Array.isArray(s?.claims) ? s.claims : [])
        .map((f: any) => String(f ?? "").trim().replace(/^\.\//, "").replace(/^[\\/]+/, ""))
        .filter(Boolean)
        .filter((f: string) => {
          if (taken.has(f)) return false;
          taken.add(f);
          return true;
        });
      return blankStep({
        title: String(s?.title ?? prompt.split("\n")[0]).slice(0, 70),
        prompt,
        roleKey: known ? roleKey : null,
        note: s?.note ? String(s.note).slice(0, 160) : null,
        claims,
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
      claims: [],
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
  /** set to plan against a real folder - this is what makes it a build plan */
  workspace?: string | null;
  /** override the check the planner would have picked itself */
  verify?: string | null;
}): Promise<DraftResult> {
  const idea = opts.idea.trim();
  const presetId = opts.presetId ?? null;
  // A ceiling, not a target. A real project needs more pieces than five, and the
  // old cap of ten was low enough that the planner had to merge unrelated work
  // into one desk to fit - which is how a product arrives as a single file.
  // Padding a small idea to hit a number is the opposite failure, so the brief
  // says "as many as it needs, up to this" rather than "this many".
  // The ceiling is a ceiling: ask for more and you get more. The default is
  // lower than the ceiling on purpose, because the planner emits every step's
  // instruction in one un-streamed reply and the free models this floor runs on
  // manage about eight tokens a second - twelve steps is a twelve-minute wait
  // before a single desk has started. Eight is a real team and a bearable wait.
  const count = Math.max(2, Math.min(24, Number(opts.steps) || (opts.workspace ? 8 : 5)));
  const model = opts.model || store.state.settings.plannerModel || store.state.settings.defaultModel;
  // resolving the folder here means a bad path is an error on the whiteboard,
  // not eight desks discovering it one at a time
  const ws = opts.workspace ? openWorkspace(opts.workspace) : null;
  const kind: Plan["kind"] = ws ? "build" : "text";

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
      kind,
      workspace: ws?.root ?? null,
      verify: opts.verify ?? null,
    });
    return { plan, costUsd: 0 };
  }

  // A build plan carries the shared contract, an instruction per step and the
  // line that says when each step is done, so the budget is per step rather than
  // a flat number: raising the step ceiling without raising this is how a plan
  // comes back cut off inside step nine.
  const budget = ws ? Math.min(12_000, 900 + count * 300) : 2600;

  const res = await gateway.complete({
    model,
    system: PLANNER_SYSTEM,
    prompt: ws ? buildDraftPrompt(idea, ws.root, presetId, count) : draftPrompt(idea, presetId, count),
    temperature: ws ? 0.35 : 0.6,
    maxTokens: budget,
    // The free models this floor exists to use were measured at roughly 8
    // tokens a second, and `complete` does not stream - nothing arrives until
    // the whole plan does. So the wait is set from the budget at a deliberately
    // pessimistic 5/s rather than from a flat number: the old 180s could not
    // have finished a full 4000-token plan either, it just never had to,
    // because the brief used to ask for something much smaller.
    signal: AbortSignal.timeout(ws ? Math.min(1_200_000, 45_000 + budget * 200) : 120_000),
  });

  const parsed = extractJson(res.text);
  const steps = coerceSteps(parsed, presetId);
  if (!steps.length) throw new Error("the planner came back with no usable steps");

  // A model that spent its whole budget was still writing when it was stopped,
  // so `extractJson` will have rewound to the last whole step and the plan is
  // short by however many it never reached. The steps that did arrive are worth
  // running - but silently building two thirds of a product is worse than
  // saying so, and the fix is one number, so the board says both.
  const cutOff = res.tokensOut > 0 && res.tokensOut >= budget * 0.97;

  // A plan whose steps do not feed each other has no reason to queue: the whole
  // floor can take it at once. Only a real {{input}} makes it a chain.
  //
  // A build plan is different. Step one usually writes the manifest everything
  // else installs against, so it goes out in order by default - file ownership
  // makes `split` safe to choose, but it is not the safe default.
  const chained = ws || steps.some((s) => s.prompt.includes("{{input}}") || s.prompt.includes("{{prev}}"));

  // the planner picks the check unless you named one yourself
  const check = ws ? (opts.verify ?? String(parsed?.verify ?? "").trim()) || null : null;

  // planning is real spend - it belongs in the same ledger as everything else
  store.state.ledger.tokensIn += res.tokensIn;
  store.state.ledger.tokensOut += res.tokensOut;
  store.state.ledger.costUsd += res.costUsd;

  const plan = store.addPlan({
    title: String(opts.title || parsed?.title || idea.split("\n")[0]).slice(0, 70),
    idea,
    summary: (
      cutOff
        ? `[the planner ran out of room after ${steps.length} steps - these are complete and worth running; ` +
          `set a faster plannerModel if you want a longer plan] ` +
          String(parsed?.summary ?? "")
        : String(parsed?.summary ?? "")
    ).slice(0, 300),
    presetId,
    steps,
    mode: chained ? "chain" : "split",
    status: "draft",
    jobId: null,
    draftedBy: res.model,
    ghost: false,
    kind,
    workspace: ws?.root ?? null,
    verify: check,
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

/**
 * Which desk should take this step. A pin wins, then the role, then anyone.
 * `spread` is for a split: waiting behind the one desk that holds a role would
 * make a parallel plan run in single file, so an unclaimed desk beats a queue.
 */
export function deskFor(step: PlanStep, taken: Set<string>, spread = false): Worker | null {
  if (step.workerId) {
    const pinned = store.worker(step.workerId);
    if (pinned) return pinned;
  }
  const byRole = store.state.workers.filter((w) => step.roleKey && w.role === step.roleKey);
  const fresh = byRole.find((w) => !taken.has(w.id));
  if (fresh) return fresh;
  if (spread) {
    const free = store.state.workers.find((w) => !taken.has(w.id));
    if (free) return free;
  }
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

  const build = plan.kind === "build" && Boolean(plan.workspace);

  steps.forEach((step, i) => {
    const desk = deskFor(step, taken, plan.mode === "split");
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
      workspace: build ? plan.workspace : null,
      // a step the planner gave no files to would be locked out of the folder
      // entirely, which is worse than letting it work anywhere
      claims: build ? (step.claims?.length ? step.claims : ["**"]) : [],
      // no step carries the plan's check - see settlePlan, which runs it once
      // the whole job has landed and puts a desk on repairing what it finds
      verify: null,
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
