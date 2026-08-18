// The planner's JSON reader, exercised on the shapes cheap models actually send.
import { extractJson } from "../server/planner.ts";

const cases: [string, string][] = [
  ["plain", '{"a":1}'],
  ["fenced", "```json\n{\"a\":1}\n```"],
  ["trailing comma", '{"a":1,}'],
  ["comments + commas", '{\n // note\n "a":1,\n "b":[1,2,],\n}'],
  ["url survives the strip", '{"url":"http://x.dev/y","a":1,}'],
  ["prose around it", 'Sure!\n{"a":1}\nhope that helps.'],
];

let bad = 0;
for (const [name, raw] of cases) {
  try { console.log("  ok  ", name, "->", JSON.stringify(extractJson(raw))); }
  catch (e: any) { bad++; console.log("  FAIL", name, "->", e.message); }
}
console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
