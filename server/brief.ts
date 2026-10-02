// What a desk is told before it touches anything. Everything a cheap model gets
// wrong on a team build - rewriting config, inventing an export name, writing
// one giant file, answering in prose, stopping at a stub - is cheaper to prevent
// here, in words, than to repair later from a failing build. This is the file to
// edit when desks misbehave.
import { store } from "./store.ts";
import { stack } from "./templates.ts";
import type { Plan, Task } from "../shared/types.ts";

/** The whole team's file map, so a desk knows what exists, what is coming and who writes it. */
function teamMap(plan: Plan, t: Task): string {
  const rows: string[] = [];
  for (const step of plan.steps) {
    if (!step.enabled) continue;
    const task = store.task(step.taskId);
    const who = task?.workerId ? store.worker(task.workerId)?.name : null;
    const state =
      task?.id === t.id
        ? "YOU"
        : task?.stage === "review" || task?.stage === "done"
          ? "done - on disk"
          : task?.stage === "running"
            ? "being written now"
            : task?.stage === "failed"
              ? "failed - may be missing"
              : `wave ${step.wave ?? 1}, not started`;
    rows.push(`- [${state}] ${step.title}${who ? ` (${who})` : ""}: ${step.claims.join(", ") || "(no files)"}`);
  }
  return rows.join("\n");
}

/** The system prompt for a desk working inside a folder. */
export function buildBriefing(t: Task, checkCommand: string | null): string {
  const plan = t.planId ? store.plan(t.planId) : undefined;
  const s = stack(plan?.stack ?? null);
  const solo = !t.claims.length || t.claims.includes("**");
  const parts: string[] = [];

  parts.push(
    "You are a senior software engineer working inside a real project folder through tools. " +
      (solo
        ? "You own the whole folder."
        : "You are one engineer on a team: other engineers are writing other files of this same project at this very moment."),
  );

  if (plan) {
    parts.push(`# The project\n${plan.title}\n${plan.idea.slice(0, 1200)}`);
    if (plan.summary) parts.push(`# Approach\n${plan.summary}`);
    if (s) parts.push(`# ${s.name}\n${s.guide}`);
    if (plan.contract) {
      parts.push(
        "# Shared contract - every engineer follows this exactly\n" +
          "File paths, export names, prop types and data shapes below are agreements. Import teammates' files by exactly " +
          "these paths and names even if the file does not exist yet - it will. Implement your own files to exactly " +
          "these signatures.\n\n" +
          plan.contract,
      );
    }
    if (!solo) parts.push(`# Who writes what\n${teamMap(plan, t)}`);
  }

  parts.push(
    [
      "# How you work",
      solo
        ? "- You may write any file in the folder."
        : `- You own exactly these files: ${t.claims.join(", ")}. Writes anywhere else are refused. Everything else belongs to a teammate.`,
      "- Orient fast. Read only what you need: files you import from, and your own files if they already exist. Do not explore the whole tree.",
      "- Deliver with write_file. Code in your reply text is thrown away. Write each file whole and final - no '...', no TODO, no placeholder, no stub that a later step will fill in.",
      "- Be efficient: when you know what to write, write several files in one reply (several write_file calls at once).",
      "- Keep files focused: one component or module per file, roughly under 250 lines. If a file would be longer, split it into files you own.",
      "- After each write the floor parses the file and tells you about syntax errors. Fix them immediately with edit_file.",
      checkCommand
        ? `- When you call finish, the floor type-checks your files (${checkCommand}). If it reports errors in your files, fix them and call finish again.`
        : "- Before finishing, re-read anything you are unsure of.",
      "- Do not change config, package.json or files you do not own, and do not install packages unless your task says so.",
      "- Do not run dev servers. Do not write README or notes files unless asked.",
      "- When your files are complete, call finish with two lines: what you built, and any contract detail a teammate should know.",
    ].join("\n"),
  );

  return parts.join("\n\n");
}

/** Said to a desk when its type check fails on finish. */
export function repairNote(report: string): string {
  return (
    `The type check found problems. This is not done yet.\n\n${report}\n\n` +
    "Fix the cause in your own files (read the line first, then edit_file), and call finish again."
  );
}

/** A reply that ended at the token limit, most likely in the middle of a file. */
export const CUT_OFF_NOTE =
  "Your last reply hit the output limit and was cut off, so the tool call it was writing did not arrive whole. " +
  "Write smaller: split that file into two files you own, or write it in two steps (write_file with the first half, " +
  "then edit_file to append the rest).";
