// Drive one benchmark build through the floor's API and report as it goes.
//   node tools/bench.mjs <folder> [--model=nim/z-ai/glm-5.3] [--planner=<model>] [--desks=8]
//                                 [--port=20210] [--plan-only] [--resume]
// BRIEF=... replaces the portfolio brief. What it measured is in docs/benchmark.md.
//
// It fires the whole crew, rebuilds the office and changes the floor's models,
// so point it at a floor of its own: NIGHTSHIFT_DATA=<somewhere else> and another --port.
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const folder = args.find((a) => !a.startsWith("--"));
const port = opt("port", "20210");
const model = opt("model", "nim/z-ai/glm-5.3");
const desks = Number(opt("desks", "8"));
const base = `http://localhost:${port}/api`;

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

const BRIEF = process.env.BRIEF || `Build a portfolio website for a product designer. One page: hero, selected work (case studies), about, experience, skills, testimonials and contact. It should look premium and modern, work well on mobile, and feel like a real designer's site.`;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);

const resume = args.includes("--resume");
if (!resume) {
  const { state } = await call("GET", "/state");
  for (const w of state.workers) await call("DELETE", `/workers/${w.id}`);
  await call("POST", "/office", { layout: desks > 8 ? "agency" : "floor13" });
  const roles = ["frontend", "design", "frontend", "frontend", "design", "frontend", "frontend", "design", "frontend", "frontend", "frontend", "frontend"];
  await call("POST", "/presets/webapp/hire", { roleKeys: roles.slice(0, desks), model, temper: "perfectionist" });
  await call("POST", "/settings", { plannerModel: opt("planner", model), defaultModel: model, reasoning: "low" });
  log(`crew: ${desks} desks on ${model}`);
  // drafting outlives fetch's header timeout on a slow model: fire it and watch the board
  call("POST", "/plans", { idea: BRIEF, workspace: folder, presetId: "webapp" }).catch(() => {});
}
const since = resume ? 0 : Date.now() - 2000;
let plan;
for (;;) {
  const { plans } = await call("GET", "/plans");
  plan = plans.filter((p) => p.createdAt >= since && p.status === "draft" && p.kind === "build").at(-1);
  if (plan) break;
  await new Promise((r) => setTimeout(r, 10000));
}
log(`planning took ${((plan.createdAt - t0) / 1000).toFixed(0)}s`);
log(`plan drafted: ${plan.title} - stack ${plan.stack} - ${plan.steps.length} steps - verify ${plan.verify}`);
for (const s of plan.steps) log(`  w${s.wave} ${s.title} -> ${s.claims.join(", ")}`);
console.log("\n--- contract ---\n" + (plan.contract ?? "(none)") + "\n---\n");
if (args.includes("--plan-only")) process.exit(0);

await call("POST", `/plans/${plan.id}/run`, {});
log("plan running");

let lastLine = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 15000));
  const { plan: p, tasks } = await call("GET", `/plans/${plan.id}`);
  const line = tasks
    .map((t) => `${t.stage[0]}${t.files?.length ?? 0}`)
    .join(" ");
  const fixer = (await call("GET", "/tasks")).tasks.filter((t) => t.planId === plan.id && t.title.startsWith("fix:"));
  const fx = fixer.map((f) => `fix:${f.stage}`).join(" ");
  const summary = `${p.status} | ${line} ${fx}`;
  if (summary !== lastLine) {
    log(summary);
    lastLine = summary;
  }
  const allSettled = tasks.every((t) => ["review", "done", "failed"].includes(t.stage));
  const fixerOpen = fixer.some((f) => !["review", "done", "failed"].includes(f.stage));
  if (p.status !== "running" && allSettled && !fixerOpen) {
    const { log: events } = await call("GET", "/log");
    const final = events.filter((e) => e.type === "verify" && e.data?.planId === plan.id).at(-1);
    if (p.status === "failed" && !fixer.length) {
      // the fixer is dispatched right after the check - give it a moment to appear
      await new Promise((r) => setTimeout(r, 5000));
      const again = (await call("GET", "/tasks")).tasks.filter((t) => t.planId === plan.id && t.title.startsWith("fix:"));
      if (again.length) continue;
    }
    log(`finished: plan ${p.status}; last check: ${final ? `${final.text}` : "none"}`);
    for (const t of [...tasks, ...fixer]) {
      log(`  ${t.stage.padEnd(7)} ${t.title} - ${Math.round((t.latencyMs ?? 0) / 1000)}s, ${t.tokensOut} tok out, ${t.toolCalls?.length ?? 0} tools, ${t.decision ?? ""}${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`);
    }
    break;
  }
}
