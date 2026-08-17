#!/usr/bin/env node
// One command to open the floor, on any OS.
//
//   npx @kaandrick/nightshift            build if needed, start, open the window
//   npx @kaandrick/nightshift --no-open  don't touch the browser
//   npx @kaandrick/nightshift --port 8080
//   npx @kaandrick/nightshift@latest     the newest one, past the npx cache
//
// It never installs OmniRoute for you and never pretends a gateway is up.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = require("../package.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag("--help") || flag("-h")) {
  console.log(`
  nightshift — a pixel office where cheap models work the night shift

    nightshift                start the floor and open the window
    nightshift --no-open      don't open a browser
    nightshift --port <n>     serve on another port (default 20200)
    nightshift --gateway <u>  OmniRoute base URL (default http://localhost:20128/v1)
    nightshift --no-build     skip the build check
    nightshift --update       install the newest version from npm
    nightshift --version      print the version and leave
    nightshift --no-update-check
                              don't ask npm whether a newer one exists
`);
  process.exit(0);
}

if (flag("--version") || flag("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

// ---- node ------------------------------------------------------------

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `\n  nightshift needs node 22.6 or newer (the server runs as TypeScript).` +
      `\n  you are on ${process.versions.node}.\n`,
  );
  process.exit(1);
}

const say = (s) => console.log(`  ${s}`);

// ---- npm --------------------------------------------------------------

// npm is a .cmd on windows, which node will only spawn through a shell — and a
// shell plus an args array is what DEP0190 warns about. One command string, no
// args array, no warning, same behaviour everywhere.
const npm = (cmd) => {
  const res = spawnSync(`npm ${cmd}`, { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`\n  \`npm ${cmd}\` failed. run it in ${root} to see why.\n`);
    process.exit(1);
  }
};

// ---- staying current --------------------------------------------------

/**
 * What npm currently calls latest, or null if the registry is not reachable.
 * `force` is for `--update`, where you asked for it — the opt-out only silences
 * the check that runs behind your back on boot.
 */
async function latestVersion({ force = false } = {}) {
  if (!force && (flag("--no-update-check") || process.env.NIGHTSHIFT_NO_UPDATE_CHECK)) return null;
  // an own AbortController rather than AbortSignal.timeout, so the timer can be
  // cleared and unref'd instead of sitting there holding the loop open
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  timer.unref?.();
  try {
    // the /latest endpoint answers 406 to the abbreviated-packument accept
    // header, so this asks for it plain — it is one small document either way
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: ac.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null; // offline is not an error here, it just means no news
  } finally {
    clearTimeout(timer);
  }
}

/** Release order only — a prerelease tag is ignored, which is what we want here. */
function isNewer(a, b) {
  const parts = (v) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y, z] = parts(a);
  const [p, q, r] = parts(b);
  return x !== p ? x > p : y !== q ? y > q : z > r;
}

async function update() {
  const latest = await latestVersion({ force: true });
  if (latest && !isNewer(latest, pkg.version)) {
    say(`already on ${pkg.version} — nothing newer on npm.`);
    return;
  }
  say(latest ? `updating ${pkg.version} -> ${latest}...` : `npm registry unreachable — asking for @latest anyway...`);
  npm(`install -g ${pkg.name}@latest`);
  say(`done. running it through npx instead? then it is:  npx ${pkg.name}@latest`);
}

// ---- the floor --------------------------------------------------------

async function startFloor() {
  // the window has to exist before we can serve it
  if (!flag("--no-build") && !fs.existsSync(path.join(root, "dist", "index.html"))) {
    if (!fs.existsSync(path.join(root, "node_modules", "vite"))) {
      say("installing dependencies (first run only)...");
      npm("install --no-audit --no-fund");
    }
    say("building the window (first run only)...");
    npm("run build");
  }

  const gatewayUrl = value("--gateway", process.env.OMNIROUTE_URL || "http://localhost:20128/v1");

  // two network calls on a short leash, so they run side by side
  const [probe, latest] = await Promise.all([
    fetch(`${gatewayUrl.replace(/\/$/, "")}/models`, {
      headers: process.env.OMNIROUTE_KEY ? { authorization: `Bearer ${process.env.OMNIROUTE_KEY}` } : {},
      signal: AbortSignal.timeout(4000),
    }).catch(() => null),
    latestVersion(),
  ]);

  if (probe?.ok) {
    const body = await probe.json().catch(() => null);
    const n = Array.isArray(body?.data) ? body.data.length : 0;
    say(`gateway up at ${gatewayUrl}${n ? ` — ${n} models` : ""}`);
  } else {
    say(`no gateway at ${gatewayUrl}.`);
    say(`the floor still runs, but every output is marked GHOST — nothing reaches a model.`);
    say(`start one with:  npm install -g omniroute && omniroute`);
  }

  if (latest && isNewer(latest, pkg.version)) {
    say(`update: ${pkg.version} -> ${latest}  —  npx ${pkg.name}@latest  (or nightshift --update)`);
  }

  const port = value("--port", process.env.PORT || "20200");
  const url = `http://localhost:${port}`;

  const child = spawn(process.execPath, [require.resolve("tsx/cli"), path.join(root, "server", "index.ts")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), OMNIROUTE_URL: gatewayUrl },
  });

  const stop = () => {
    child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));

  // wait for the floor to answer, then open the window
  if (!flag("--no-open")) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
      if (!ok) continue;
      const opener =
        process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
      spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
      say(`window open at ${url}  —  ctrl+c to close the floor`);
      break;
    }
  }
}

// A fetch parks a keep-alive socket for a few seconds, and calling process.exit()
// on top of one trips a libuv assertion on windows. `update()` therefore ends by
// running out of work rather than by exiting.
if (flag("--update")) await update();
else await startFloor();
