// The whiteboard. An idea goes up, and comes down as steps a desk can actually do.
//
// Planning does not run through the floor - no desk animates, nobody gets a task.
// It is one streamed call to the model router that returns JSON.

import fs from "node:fs";
import path from "node:path";
import { dispatch, gateway, releaseWaves, wake } from "./engine.ts";
import { store, blankStep } from "./store.ts";
import { PRESETS, preset, roleSpec } from "../shared/presets.ts";
import { install, openWorkspace, tree } from "./workspace.ts";
import { scaffold, stack, stackMenu } from "./templates.ts";
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
 * the steps have to divide a filesystem, run in waves, and agree on every name
 * that crosses a file boundary - because the desks cannot talk to each other,
 * the contract written here is the only conversation they get.
 */
function buildDraftPrompt(idea: string, root: string, presetId: string | null, count: number, hasProject: boolean): string {
  return [
    `You are the tech lead of a team of ${count} AI engineers. Turn the request below into a build plan they can`,
    `execute in parallel inside the project folder ${root}.`,
    "",
    "# The folder right now",
    survey(root),
    "",
    "# Request",
    idea,
    "",
    "# Stacks the floor sets up before anyone starts (config written, dependencies installed)",
    stackMenu(),
    hasProject
      ? 'The folder already has a project. Use "stack": "none" and plan against what is there.'
      : "Pick the stack the request calls for. For any website, landing page, portfolio, dashboard or web app choose\n" +
        "react-vite unless the user explicitly asked for something else. Never downgrade a web product to static.",
    "",
    "# How the team works",
    "- Each engineer is a capable but literal AI model with file tools. It sees the request, your summary, your",
    "  contract, the file map and its own step prompt. It cannot see teammates' work in progress or talk to them.",
    "- Steps run in waves. Every step in a wave works at the same time; the next wave starts when the whole wave",
    "  before it has landed.",
    "  - Wave 1: the foundation others import - global CSS with the design tokens (src/index.css), shared types,",
    "    the content/data file, small reusable UI primitives. Keep wave 1 to 1-2 steps: everyone waits for it.",
    "  - Wave 2: the features, all at once - one step per page section, page or feature module. Most steps go here.",
    "  - Wave 3 (only if needed): assembly that needs wave 2 on disk - App.tsx composing the sections, routing,",
    "    navigation wiring. One step.",
    "- Each step owns 1-4 files, listed exactly in `files`. No file is owned by two steps. Config already exists",
    "  (package.json, vite.config.ts, tsconfig.json, src/main.tsx); only claim index.html or src/index.css if the",
    "  step really changes them (index.html for <title>, meta and Google Fonts links).",
    `- Use as many steps as the work deserves, up to ${count}. A polished portfolio or landing page is typically 6-9.`,
    "- Scope it like a finished product a studio would ship, not a demo. No step is 'review', 'test' or 'docs'.",
    "",
    "# The contract - the most important thing you write",
    "Compact markdown that settles everything two engineers could otherwise disagree on:",
    "1. Visual direction in one sentence with a concrete aesthetic (e.g. 'editorial, Swiss grid, warm off-white,",
    "   one vermilion accent'). Exact palette as hex values WITH the Tailwind v4 @theme token names that wave 1",
    "   defines (--color-ink: #111114 -> classes bg-ink, text-ink). Font families (Google Fonts) and the token names",
    "   (--font-display, --font-sans), type scale for h1/h2/body, radius, section spacing (py-20 md:py-28 is a good",
    "   default; whichever you pick, exactly one component owns it).",
    "2. Every file in the plan: path, exports (exact names; say default or named), props with TypeScript types,",
    "   one line on what it renders.",
    "3. Shared data as TypeScript interfaces, and which file exports which constant.",
    "4. Page structure: section order and the section ids the navigation links to.",
    "5. The content: names, roles, tagline, and specific believable facts to use everywhere (companies, years,",
    "   metrics, project names) - invent them if the request does not give them, and keep them consistent.",
    "6. Visuals: there are no image files. For every place a picture would go (project thumbnails, portrait, product",
    "   shots) say what illustration is built in JSX - e.g. a browser frame with a miniature dashboard in the",
    "   project's colour - and which component draws it. Plan the page's rhythm too: which sections sit on a tinted",
    "   or dark band, and which use an asymmetric or bento layout, so the page does not repeat one centred column.",
    "",
    "# Each step prompt",
    "Say concretely what to build in its files: layout at mobile and desktop, the elements, interactions, states,",
    "animation, and the details that make it excellent - not 'a hero section'. Every desk already receives the",
    "whole contract, so never restate it: no palette, no prop types, no content facts, no file map - refer to them",
    "by name ('the Project interface', 'the dark band'). 3-6 dense sentences, no filler. The plan is written by a",
    "slow model and everyone waits for it: every sentence that repeats the contract is time nobody gets back.",
    "",
    "# Roster (roleKey values)",
    rosterFor(presetId),
    "",
    "Return ONLY this JSON, nothing before or after it:",
    '{"title":"short name","stack":"react-vite","summary":"2-3 sentences: what is being built and how",' +
      '"contract":"the markdown contract as one string (use \\n for newlines)","deps":[],' +
      '"verify":"npm run build","steps":[{"wave":1,"title":"short step name","roleKey":"key from the roster",' +
      '"files":["src/exact/path.tsx"],"prompt":"the step instruction","done":"one observable line that is true when this step is finished"}]}',
  ].join("\n");
}

function expandPrompt(step: PlanStep, plan: Plan, count: number): string {
  return [
    `This is one step out of a plan called "${plan.title}".`,
    plan.summary ? `The plan overall: ${plan.summary}` : "",
    "",
    "Break this single step into smaller steps, each finishable by one small model in one reply.",
    `Give ${count} sub-steps. Keep the same intent - do not widen the scope.`,
    plan.kind === "build" ? "Split its files between the sub-steps; every file of the original goes to exactly one." : "",
    "",
    "Roster:",
    rosterFor(plan.presetId),
    "",
    `Step title: ${step.title}`,
    step.claims.length ? `Step files: ${step.claims.join(", ")}` : "",
    "Step instruction:",
    step.prompt || step.title,
    "",
    "Return exactly this JSON shape:",
    '{"steps":[{"title":"...","prompt":"...","roleKey":"...","files":[],"note":"..."}]}',
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
      const done = String(s?.done ?? "").trim();
      if (done) prompt = `${prompt}\n\n--- THIS STEP IS DONE WHEN ---\n${done}`;
      const roleKey = typeof s?.roleKey === "string" ? s.roleKey.trim() : null;
      const known = roleKey && (roleSpec(presetId, roleKey) || store.state.workers.some((w) => w.role === roleKey));
      const claims = (Array.isArray(s?.files) ? s.files : Array.isArray(s?.claims) ? s.claims : [])
        .map((f: any) => String(f ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^[\\/]+/, ""))
        .filter(Boolean)
        .filter((f: string) => {
          if (taken.has(f)) return false;
          taken.add(f);
          return true;
        });
      const wave = Math.max(1, Math.min(9, Math.floor(Number(s?.wave) || 1)));
      return blankStep({
        title: String(s?.title ?? prompt.split("\n")[0]).slice(0, 70),
        prompt,
        roleKey: known ? roleKey : null,
        note: s?.note ? String(s.note).slice(0, 160) : null,
        claims,
        wave,
      });
    })
    .filter(Boolean) as PlanStep[];
}

/** A contract can come back as a string, a list of lines or an object. Any of them is a contract. */
function coerceContract(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n").trim();
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([k, v]) => `## ${k}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)
      .join("\n\n");
  }
  return "";
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
      note: "drafted offline - no provider was reachable",
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
  // A build plan is sized by the floor: there is no point cutting twelve steps
  // for four desks, and no reason to stop at eight when thirty are sitting there.
  const desks = Math.max(1, store.state.workers.length);
  const count = Math.max(2, Math.min(32, Number(opts.steps) || (opts.workspace ? Math.max(4, Math.min(12, desks)) : 5)));
  const model = opts.model || store.state.settings.plannerModel || store.state.settings.defaultModel;
  const ws = opts.workspace ? openWorkspace(opts.workspace) : null;
  const kind: Plan["kind"] = ws ? "build" : "text";

  store.emitEvent({
    type: "boss.say",
    text: `tahtaya yaziyorum: ${idea.slice(0, 60)}${idea.length > 60 ? "..." : ""}`,
    data: { whiteboard: true },
  });

  if (!gateway.status.online) {
    if (!store.state.settings.ghostMode) throw new Error("no provider online and ghost mode is off");
    const plan = store.addPlan({
      title: opts.title || idea.split("\n")[0].slice(0, 60),
      idea,
      summary: "drafted with no provider online - these steps are a skeleton, not a plan",
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

  const hasProject = Boolean(ws && fs.existsSync(path.join(ws.root, "package.json")));
  const budget = ws ? Math.min(20_000, 3_000 + count * 700) : 2600;

  // streamed, so a slow provider shows progress instead of a frozen board
  let chars = 0;
  let nextShout = 2500;
  const res = await gateway.chat({
    model,
    system: PLANNER_SYSTEM,
    prompt: ws ? buildDraftPrompt(idea, ws.root, presetId, count, hasProject) : draftPrompt(idea, presetId, count),
    temperature: ws ? 0.4 : 0.6,
    maxTokens: budget,
    reasoning: store.state.settings.reasoning ?? "low",
    idleMs: 6 * 60_000,
    signal: AbortSignal.timeout(ws ? 30 * 60_000 : 5 * 60_000),
    onChunk: (s) => {
      chars += s.length;
      if (chars >= nextShout) {
        nextShout += 2500;
        store.emitEvent({ type: "boss.say", text: `tahta: ${Math.round(chars / 1000)}k karakter...`, data: { whiteboard: true } });
      }
    },
  });

  const parsed = extractJson(res.text);
  const steps = coerceSteps(parsed, presetId);
  if (!steps.length) throw new Error("the planner came back with no usable steps");

  const cutOff = res.finishReason === "length" || (res.tokensOut > 0 && res.tokensOut >= budget * 0.97);
  const chained = !ws && steps.some((s) => s.prompt.includes("{{input}}") || s.prompt.includes("{{prev}}"));
  const check = ws ? (opts.verify ?? String(parsed?.verify ?? "").trim()) || null : null;
  let stackId = ws ? String(parsed?.stack ?? "").trim().toLowerCase() : "";
  if (hasProject || !stack(stackId)) stackId = "";

  store.state.ledger.tokensIn += res.tokensIn;
  store.state.ledger.tokensOut += res.tokensOut;
  store.state.ledger.costUsd += res.costUsd ?? 0;

  const plan = store.addPlan({
    title: String(opts.title || parsed?.title || idea.split("\n")[0]).slice(0, 70),
    idea,
    summary: (
      cutOff
        ? `[the planner ran out of room after ${steps.length} steps - these are complete and worth running] ` +
          String(parsed?.summary ?? "")
        : String(parsed?.summary ?? "")
    ).slice(0, 600),
    presetId,
    steps,
    mode: ws ? "waves" : chained ? "chain" : "split",
    status: "draft",
    jobId: null,
    draftedBy: res.decision ?? res.model,
    ghost: false,
    kind,
    workspace: ws?.root ?? null,
    verify: check ?? (stackId ? stack(stackId)!.verify || null : null),
    stack: stackId || null,
    contract: ws ? coerceContract(parsed?.contract).slice(0, 24_000) || null : null,
  });
  plan.deps = Array.isArray(parsed?.deps) ? parsed.deps.map(String).slice(0, 12) : [];
  return { plan, costUsd: res.costUsd ?? 0 };
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
      maxTokens: 3000,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    fresh = coerceSteps(extractJson(res.text), plan.presetId).map((s) => ({ ...s, wave: step.wave ?? 1 }));
    store.state.ledger.tokensIn += res.tokensIn;
    store.state.ledger.tokensOut += res.tokensOut;
    store.state.ledger.costUsd += res.costUsd;
  } else {
    if (!store.state.settings.ghostMode) throw new Error("no provider online and ghost mode is off");
    fresh = Array.from({ length: 2 }, (_, n) =>
      blankStep({
        title: `${step.title} (${n + 1})`,
        prompt: step.prompt,
        roleKey: step.roleKey,
        note: "split offline - edit before sending down",
        wave: step.wave ?? 1,
      }),
    );
  }
  if (!fresh.length) throw new Error("nothing came back to split it into");

  plan.steps.splice(i, 1, ...fresh);
  store.touch();
  return fresh;
}

/**
 * Which desk should take this step. A pin wins, then the role, then anyone.
 * `spread` is for parallel work: waiting behind the one desk that holds a role
 * would make a parallel plan run in single file, so an unclaimed desk beats a queue.
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
    return null; // more steps than desks: whoever frees up first takes it
  }
  if (byRole.length) return byRole[0];
  return null;
}

/**
 * Lay the stack down and install it before the first wave sits down. Doing
 * this once, on the floor, is the difference between eight desks writing
 * components and eight desks each trying to remember how vite is configured.
 */
async function prepare(plan: Plan, jobId: string) {
  const s = stack(plan.stack ?? null);
  const root = plan.workspace;
  if (s && root && s.id !== "static") {
    const deps = plan.deps ?? [];
    const laid = scaffold(root, s, plan.title, deps);
    if (!laid.skipped) {
      store.emitEvent({
        type: "boss.say",
        text: `iskeleti kuruyorum: ${s.name}`,
        data: { planId: plan.id, stack: s.id, files: laid.wrote },
      });
    }
    if (!fs.existsSync(path.join(root, "node_modules"))) {
      store.emitEvent({ type: "shell.run", text: "npm install", data: { planId: plan.id } });
      const res = await install(root);
      store.emitEvent({
        type: "verify",
        text: `npm install ${res.ok ? "ok" : "failed"} (${Math.round(res.ms / 1000)}s)`,
        data: { ok: res.ok, planId: plan.id, preview: res.text.slice(-400) },
      });
      if (!res.ok) {
        store.emitEvent({ type: "system", text: `npm install failed - the desks will see it: ${res.text.slice(-300)}` });
      }
    }
  }
  releaseWaves(jobId);
}

/**
 * Cut the plan into real work. `chain` makes a pipeline where each step feeds
 * the next; `split` throws every step onto the floor at once; `waves` sends the
 * steps out a wave at a time, which is what a build plan does.
 */
export function runPlan(plan: Plan, mode?: Plan["mode"]) {
  const steps = plan.steps.filter((s) => s.enabled && s.prompt.trim());
  if (!steps.length) throw new Error("no enabled steps with a prompt");
  plan.mode = mode ?? plan.mode;
  const build = plan.kind === "build" && Boolean(plan.workspace);
  if (build && plan.mode === "chain") plan.mode = "waves";

  const kind = plan.mode === "split" ? "batch" : plan.mode === "waves" ? "waves" : "pipeline";
  const ids: string[] = [];
  const job = store.addJob(plan.title, ids, kind);

  // desks are handed out wave by wave: a desk busy in wave 1 is free again for wave 2
  const takenByWave = new Map<number, Set<string>>();

  steps.forEach((step, i) => {
    const wave = plan.mode === "waves" ? step.wave ?? 1 : plan.mode === "split" ? 1 : i + 1;
    const taken = takenByWave.get(wave) ?? new Set<string>();
    takenByWave.set(wave, taken);
    const desk = deskFor(step, taken, plan.mode !== "chain");
    if (desk) taken.add(desk.id);
    const task = store.addTask({
      title: step.title,
      prompt: step.prompt,
      system: null,
      workerId: desk?.id ?? null,
      createdBy: "pipeline",
      // a chain releases one step at a time, waves release by wave after the
      // stack is laid, and a split goes out together
      stage: plan.mode === "split" ? "queued" : plan.mode === "chain" && i === 0 ? "queued" : "backlog",
      jobId: job.id,
      stepIndex: i,
      planId: plan.id,
      retriesLeft: 1,
      workspace: build ? plan.workspace : null,
      claims: build ? (step.claims?.length ? step.claims : ["**"]) : [],
      verify: null,
    });
    task.wave = wave;
    step.taskId = task.id;
    ids.push(task.id);
  });

  job.taskIds = ids;
  plan.jobId = job.id;
  plan.status = "running";

  if (plan.mode === "split") {
    for (const w of store.state.workers) wake(w.id);
  } else if (plan.mode === "waves") {
    void prepare(plan, job.id);
  } else {
    dispatch(ids[0], store.task(ids[0])?.workerId ?? null, steps[0].title);
  }

  const waves = new Set(steps.map((s) => s.wave ?? 1)).size;
  store.emitEvent({
    type: "plan.run",
    text: `${plan.title}: ${steps.length} is masalara dagitiliyor`,
    data: { planId: plan.id, jobId: job.id, mode: plan.mode },
  });
  store.emitEvent({
    type: "boss.say",
    text:
      plan.mode === "split"
        ? "hepiniz ayni anda basliyorsunuz."
        : plan.mode === "waves"
          ? `${waves} dalga. once temel, sonra hepiniz birden.`
          : "sirayla. ilk masa baslasin.",
    data: { planId: plan.id },
  });
  store.touch();
  return { job, taskIds: ids };
}
