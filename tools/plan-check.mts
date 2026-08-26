// The planner's step reader, exercised on what a plan actually has to survive:
// a `done` line the desk needs to see, two steps reaching for the same file, and
// a roleKey the model invented.
import { coerceSteps } from "../server/planner.ts";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`);
};

// ---- the acceptance line reaches the desk --------------------------------
{
  const [step] = coerceSteps(
    { steps: [{ title: "api", prompt: "Write the routes.", done: "GET /cards returns the seeded list." }] },
    null,
  );
  check("a `done` line lands on the prompt", step.prompt.includes("GET /cards returns the seeded list."));
  check("and is labelled so the desk reads it as the bar", step.prompt.includes("THIS STEP IS DONE WHEN"));
  check("the instruction itself survives", step.prompt.startsWith("Write the routes."));
}

// ---- a step with no `done` is unchanged ----------------------------------
{
  const [step] = coerceSteps({ steps: [{ title: "api", prompt: "Write the routes." }] }, null);
  check("no `done`, no banner", step.prompt === "Write the routes.", JSON.stringify(step.prompt));
}

// ---- two desks must never own one path -----------------------------------
{
  const steps = coerceSteps(
    {
      steps: [
        { title: "one", prompt: "a", files: ["src/app.ts", "src/db.ts"] },
        { title: "two", prompt: "b", files: ["src/db.ts", "src/ui.ts"] },
      ],
    },
    null,
  );
  check("the first claim on a path wins", steps[0].claims.join() === "src/app.ts,src/db.ts", steps[0].claims.join());
  check("the second step loses the overlap", steps[1].claims.join() === "src/ui.ts", steps[1].claims.join());
}

// ---- paths arrive in every shape a model writes them ---------------------
{
  const [step] = coerceSteps({ steps: [{ title: "t", prompt: "p", files: ["./src/a.ts", "/src/b.ts", "  "] }] }, null);
  check("leading ./ and / are stripped, blanks dropped", step.claims.join() === "src/a.ts,src/b.ts", step.claims.join());
}

// ---- an invented role routes nowhere, so it is dropped -------------------
{
  const [step] = coerceSteps({ steps: [{ title: "t", prompt: "p", roleKey: "chief-vibes-officer" }] }, "webapp");
  check("a role nobody has becomes null", step.roleKey === null, String(step.roleKey));
  const [real] = coerceSteps({ steps: [{ title: "t", prompt: "p", roleKey: "frontend" }] }, "webapp");
  check("a real preset role is kept", real.roleKey === "frontend", String(real.roleKey));
}

// ---- a step with no prompt is not a step ---------------------------------
{
  const steps = coerceSteps({ steps: [{ title: "empty" }, { title: "t", prompt: "p" }] }, null);
  check("a promptless step is dropped", steps.length === 1, `${steps.length} kept`);
}

console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
