// The planner's JSON reader, exercised on the shapes cheap models actually send.
import { extractJson } from "../server/planner.ts";

const cases: [string, string][] = [
  ["plain", '{"a":1}'],
  ["fenced", "```json\n{\"a\":1}\n```"],
  ["trailing comma", '{"a":1,}'],
  ["comments + commas", '{\n // note\n "a":1,\n "b":[1,2,],\n}'],
  ["url survives the strip", '{"url":"http://x.dev/y","a":1,}'],
  ["prose around it", 'Sure!\n{"a":1}\nhope that helps.'],
  // The shapes a cut-off plan arrives in. At the ~8 tokens a second the free
  // models manage, a build plan is the longest thing anything here writes, so
  // being truncated is routine - and the finished steps are worth keeping.
  ["cut mid-string", '{"title":"kanban","steps":[{"title":"api","prompt":"a"},{"title":"ui","prompt":"write the rou'],
  ["cut after a step", '{"title":"kanban","steps":[{"title":"api","prompt":"a"},{"title":"ui","prompt":"b"},'],
  ["cut mid-key", '{"title":"kanban","steps":[{"title":"api","prompt":"a"}],"ver'],
];

let bad = 0;
for (const [name, raw] of cases) {
  try { console.log("  ok  ", name, "->", JSON.stringify(extractJson(raw))); }
  catch (e: any) { bad++; console.log("  FAIL", name, "->", e.message); }
}
console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
