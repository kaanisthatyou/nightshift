// Bulk-load provider API keys into the floor.
//
//   node tools/import-keys.mjs [keysFile] [--dry-run]
//
// The floor has to be running. Each line is a key, optionally with the provider
// named in front (`groq = gsk_...`); a bare key is matched to its provider by its
// prefix (nvapi-, gsk_, AIza, sk-or-, csk-...). Keys are never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FILE = args.find((a) => !a.startsWith("--")) || path.join(os.homedir(), ".nightshift", "keys.txt");
const FLOOR = process.env.NIGHTSHIFT_URL || `http://localhost:${process.env.PORT || 20200}`;

if (!fs.existsSync(FILE)) {
  console.error(`\n  no keys file at ${FILE}\n  pass a path: npm run keys -- ./my-keys.txt\n`);
  process.exit(1);
}
const text = fs.readFileSync(FILE, "utf8");
const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)(#|\/\/).*$/, "").trim()).filter(Boolean);
console.log(`\n  ${lines.length} key lines in ${FILE}`);
if (DRY) {
  for (const l of lines) {
    const key = l.split(/[=:\s|]+/).filter(Boolean).at(l.match(/^[a-z-]+\s*[=:]/i) ? 1 : 0) ?? "";
    console.log(`   ${l.match(/^[a-z-]+\s*[=:]/i)?.[0] ?? "(by prefix)"} ${key.slice(0, 4)}…${key.slice(-3)}`);
  }
  console.log("\n  dry run - nothing sent\n");
  process.exit(0);
}

try {
  const res = await fetch(`${FLOOR}/api/providers/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? res.statusText);
  for (const a of body.added) console.log(`   + ${a.provider}: ${a.count} key${a.count === 1 ? "" : "s"}`);
  if (!body.added.length) console.log("   nothing new");
  if (body.skipped) console.log(`   ${body.skipped} lines not recognised - write them as "provider = key"`);
  for (const p of body.gateway.providers) {
    console.log(`   ${p.online ? "up  " : "down"} ${p.id.padEnd(11)} ${p.keyCount} keys, ${p.modelCount} models${p.error ? ` - ${p.error}` : ""}`);
  }
  console.log("");
} catch (err) {
  console.error(`\n  could not reach the floor at ${FLOOR}: ${err.message}\n  start it with: npm start\n`);
  process.exit(1);
}
