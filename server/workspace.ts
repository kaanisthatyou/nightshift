// The working folder. This is the half of the floor that touches your disk, so
// everything here is written as a jail first and a toolbox second.
//
// A desk in build mode gets six tools - list, read, write, edit, run, finish -
// and every one of them resolves through `inside()`, which refuses anything
// that lands outside the root. The shell is an allowlist, not a filter: a
// command whose head is not on the list does not run, whatever it looks like.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transform } from "esbuild";
import { store } from "./store.ts";
import type { FileTouch, Task, VerifyResult, Worker } from "../shared/types.ts";

/** Never walked into, never listed, never written. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".turbo", ".venv",
  "venv", "__pycache__", ".cache", "target", ".nightshift",
]);

/** Reading a whole file back at a cheap model is how you burn a context window. */
const READ_CAP = 24_000;
const RUN_OUTPUT_CAP = 8_000;
const RUN_TIMEOUT_MS = 180_000;
const WRITE_CAP = 400_000;
const TREE_CAP = 400;

/**
 * Command heads a desk may run. Enough to install, build, test and commit;
 * nothing that reaches the network or the rest of the disk. `rm`/`del` are
 * absent on purpose - there is no delete tool either, and the workspace is
 * git-initialised so a bad write is recoverable rather than gone.
 */
const ALLOWED_COMMANDS = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "node", "deno",
  "python", "python3", "py", "pip", "pip3", "uv", "uvx", "poetry", "pytest",
  "tsc", "tsx", "vite", "jest", "vitest", "eslint", "prettier", "biome",
  "go", "cargo", "rustc", "make", "gradle", "mvn", "dotnet", "ruby", "bundle",
  "git", "ls", "dir", "cat", "type", "echo", "pwd", "mkdir", "touch", "which", "where",
]);

/** Blocked by name even if something else would have let them through. */
const DENIED_COMMANDS = new Set([
  "rm", "del", "rmdir", "rd", "erase", "format", "mkfs", "dd", "sudo", "su",
  "doas", "curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "telnet",
  "shutdown", "reboot", "reg", "regedit", "powershell", "pwsh", "cmd", "bash",
  "sh", "zsh", "chmod", "chown", "icacls", "takeown", "schtasks", "crontab",
  "kill", "taskkill", "mv", "move", "ren", "rename",
]);

/**
 * Shell punctuation that would let one allowed command smuggle in another.
 * `&&` is deliberately not in here - every segment around it is checked on its
 * own head below, and `cd api && npm run build` is the first thing any desk
 * reaches for. A lone `&` still is: that one backgrounds a process.
 */
const SMUGGLERS = /[;|<>`]|\$\(|(?<!&)&(?!&)|[\n\r]/;

export interface Workspace {
  /** absolute, resolved, and confirmed to be a directory */
  root: string;
  /** whether we managed to put it under git, for the undo story */
  git: boolean;
}

// ---- the jail --------------------------------------------------------

/**
 * A path the desk asked for, resolved under the root - or an error. `..`,
 * absolute paths, drive letters and symlinks that point out all land here.
 */
export function inside(root: string, rel: unknown): string {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  const clean = rel.trim();
  // An absolute path is refused rather than quietly re-rooted. Stripping the
  // leading slash would be safe - it lands inside the folder either way - but
  // it lets a desk write <root>/etc/hosts, report that it edited /etc/hosts,
  // and be believed. A refusal costs one round and the desk corrects itself,
  // because tool errors go back into the same conversation.
  //
  // Checked by shape rather than by platform: a floor on linux must not create
  // a directory called `C:` just because that string is relative there.
  if (/^[\\/]/.test(clean) || /^[a-zA-Z]:/.test(clean) || path.isAbsolute(clean)) {
    throw new Error(`${rel} is an absolute path - give it relative to the working folder`);
  }
  const full = path.resolve(root, clean);
  const back = path.relative(root, full);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(`${rel} is outside the working folder - stay inside it`);
  }
  // a symlink already on disk could point anywhere; follow it before trusting it
  try {
    const real = fs.realpathSync(full);
    const realBack = path.relative(fs.realpathSync(root), real);
    if (realBack.startsWith("..") || path.isAbsolute(realBack)) {
      throw new Error(`${rel} links outside the working folder`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err; // not existing yet is fine - we may be creating it
  }
  const first = back.split(/[\\/]/)[0];
  if (first === ".git") throw new Error("the git directory is off limits");
  return full;
}

/**
 * Ownership. The planner hands each step the files it owns; a desk that
 * reaches for someone else's file is told whose it is instead of overwriting
 * it. A claim of `**` means the whole folder, which is what a lone order gets.
 */
function owns(claims: string[], rel: string): boolean {
  if (!claims.length) return false;
  const target = rel.split(path.sep).join("/");
  return claims.some((raw) => {
    const pattern = String(raw).trim().replace(/^\.\//, "").replace(/^[\\/]+/, "");
    if (!pattern || pattern === "**" || pattern === "*") return true;
    const p = pattern.split(path.sep).join("/");
    if (p === target) return true;
    // a claimed directory covers everything under it
    if (!p.includes("*") && target.startsWith(`${p.replace(/\/$/, "")}/`)) return true;
    const rx = new RegExp(
      `^${p
        .split("**")
        .map((seg) =>
          seg
            .split("*")
            .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"))
        .join(".*")}$`,
    );
    return rx.test(target);
  });
}

// ---- opening a folder ------------------------------------------------

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, timeout: 20_000, stdio: "ignore", windowsHide: true });
}

/**
 * Resolve what the user typed into a real directory, creating it if it is not
 * there yet, and put it under git so nothing a desk does is unrecoverable.
 */
export function openWorkspace(input: string, opts: { create?: boolean } = {}): Workspace {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("a working folder is required");
  const expanded = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ""))
    : raw;
  const root = path.resolve(expanded);

  if (!fs.existsSync(root)) {
    if (opts.create === false) throw new Error(`${root} does not exist`);
    fs.mkdirSync(root, { recursive: true });
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is a file, not a folder`);

  // Refuse the places where a confused desk would do real damage.
  const home = os.homedir();
  const forbidden = [path.parse(root).root, home, path.join(home, "Desktop"), path.join(home, "Documents")];
  if (forbidden.some((f) => path.resolve(f) === root)) {
    throw new Error(`${root} is too broad to hand to the floor - use a project folder inside it`);
  }

  let versioned = fs.existsSync(path.join(root, ".git"));
  if (!versioned) {
    try {
      git(root, ["init", "-q"]);
      git(root, ["add", "-A"]);
      git(root, [
        "-c", "user.email=floor@nightshift", "-c", "user.name=nightshift",
        "commit", "-q", "-m", "nightshift: before the shift", "--allow-empty",
      ]);
      versioned = true;
    } catch {
      versioned = false; // no git on the box, or it refused - the floor still works
    }
  }
  return { root, git: versioned };
}

// ---- what is in there ------------------------------------------------

/** A capped, ignore-aware listing. This is what a desk sees when it looks around. */
export function tree(root: string, sub = ".", cap = TREE_CAP): string[] {
  const start = inside(root, sub === "." || !sub ? "." : sub);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= cap || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (SKIP_DIRS.has(e.name)) {
        out.push(`${rel}/  (skipped)`);
        continue;
      }
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(full, depth + 1);
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* vanished under us */ }
        out.push(`${rel}  ${size}b`);
      }
    }
  };
  if (fs.statSync(start).isDirectory()) walk(start, 0);
  else out.push(path.relative(root, start).split(path.sep).join("/"));
  return out;
}

// ---- the tools themselves --------------------------------------------

export interface NativeTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/**
 * Six tools, deliberately. A free model handed twenty schemas picks the wrong
 * one; handed six with plain names it mostly does the obvious thing.
 */
export function nativeTools(shellOn: boolean): NativeTool[] {
  const list: NativeTool[] = [
    {
      name: "list_files",
      description:
        "List what is in the working folder. Call this first, before you assume anything about what exists.",
      schema: {
        type: "object",
        properties: { dir: { type: "string", description: "subfolder to list, or omit for the whole project" } },
      },
    },
    {
      name: "read_file",
      description:
        "Read a file in the working folder, with line numbers. Read a file before you edit it. " +
        "For a long file, pass from/to to read only the lines you need.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "path relative to the working folder" },
          from: { type: "number", description: "first line to return, 1-based (optional)" },
          to: { type: "number", description: "last line to return (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_files",
      description:
        "Find text across the project: returns matching lines as path:line: text. Use it to find where a name is " +
        "defined or used instead of reading files one by one.",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "plain text to look for (case-insensitive)" },
          dir: { type: "string", description: "limit to this subfolder (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "write_file",
      description:
        "Create a file, or replace one completely, with the content you give. This is how you actually deliver code - " +
        "code printed in your reply is thrown away, only files written with this tool exist. You may call it several " +
        "times in one reply to write several files at once. The result tells you about any syntax error it found.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "path relative to the working folder" },
          content: { type: "string", description: "the complete file, not a fragment and not a diff" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        "Replace one exact piece of text in a file. `find` must appear exactly once, whitespace included. " +
        "Use this for small changes so you do not have to rewrite a large file.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string", description: "the exact text to replace, copied from the file" },
          replace: { type: "string", description: "what to put there instead" },
        },
        required: ["path", "find", "replace"],
      },
    },
  ];
  if (shellOn) {
    list.push({
      name: "run",
      description:
        "Run a command in the working folder and get its output: build, type-check, run the tests, install a package. " +
        "Only build tooling is allowed (npm, npx, node, tsc, python, pytest, git and the like). Commands must exit on " +
        "their own - dev servers and watchers (npm run dev, vite, nodemon) are refused.",
      schema: {
        type: "object",
        properties: { command: { type: "string", description: "the full command line, e.g. `npm install express`" } },
        required: ["command"],
      },
    });
  }
  list.push({
    name: "finish",
    description:
      "Call this when the files you were asked for are written and, if there is a check, it passes. " +
      "Say in one short paragraph what you built and which files you touched.",
    schema: {
      type: "object",
      properties: { summary: { type: "string", description: "what you built, briefly" } },
      required: ["summary"],
    },
  });
  return list;
}

export const NATIVE_NAMES = new Set(nativeTools(true).map((t) => t.name));

export function asOpenAiNative(tools: NativeTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
}

export interface NativeResult {
  text: string;
  ok: boolean;
  /** set when the desk said it was done */
  finished?: boolean;
  touched?: FileTouch;
}

/** One native tool call, against one task's workspace and claims. */
export async function runNative(
  t: Task,
  w: Worker,
  name: string,
  args: Record<string, unknown>,
): Promise<NativeResult> {
  const root = t.workspace;
  if (!root) return { text: "this desk has no working folder", ok: false };

  switch (name) {
    case "list_files": {
      const lines = tree(root, (args.dir as string) || ".");
      return {
        ok: true,
        text: lines.length
          ? `${lines.length} entries under ${path.basename(root)}/\n${lines.join("\n")}`
          : "the folder is empty - nothing has been built yet",
      };
    }

    case "read_file": {
      const full = inside(root, args.path);
      if (!fs.existsSync(full)) return { ok: false, text: `${args.path} does not exist yet` };
      if (fs.statSync(full).isDirectory()) return { ok: false, text: `${args.path} is a folder - use list_files` };
      const all = fs.readFileSync(full, "utf8").split("\n");
      const from = Math.max(1, Math.floor(Number(args.from) || 1));
      const to = Math.min(all.length, Math.floor(Number(args.to) || all.length));
      let used = 0;
      const out: string[] = [];
      let last = from - 1;
      for (let i = from - 1; i < to; i++) {
        const line = `${String(i + 1).padStart(4)} | ${all[i]}`;
        if (used + line.length > READ_CAP) break;
        out.push(line);
        used += line.length + 1;
        last = i + 1;
      }
      const more = last < all.length ? `\n... [${all.length - last} more lines - read_file with from=${last + 1}]` : "";
      return { ok: true, text: `${args.path} (${all.length} lines)\n${out.join("\n")}${more}` };
    }

    case "search_files": {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, text: "query is required" };
      return { ok: true, text: search(root, query, (args.dir as string) || ".") };
    }

    case "write_file": {
      const full = inside(root, args.path);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!owns(t.claims, rel)) return { ok: false, text: notYours(t, rel) };
      const content = String(args.content ?? "");
      if (content.length > WRITE_CAP) return { ok: false, text: "that file is too large to write in one go" };
      const existed = fs.existsSync(full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
      const touched: FileTouch = {
        path: rel,
        action: existed ? "write" : "create",
        bytes: Buffer.byteLength(content),
        ts: Date.now(),
      };
      announce(t, w, touched);
      const problem = await syntaxCheck(rel, content);
      const hints = layoutHints(rel, content);
      return {
        ok: true,
        touched,
        text:
          `${existed ? "rewrote" : "created"} ${rel} (${touched.bytes} bytes, ${content.split("\n").length} lines)` +
          (problem ? `\nSYNTAX ERROR - the file is on disk but will not compile:\n${problem}\nFix it now with edit_file.` : "") +
          (hints ? `\nLAYOUT WARNING - you cannot see the page, so check this before moving on:\n${hints}` : ""),
      };
    }

    case "edit_file": {
      const full = inside(root, args.path);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!owns(t.claims, rel)) return { ok: false, text: notYours(t, rel) };
      if (!fs.existsSync(full)) return { ok: false, text: `${rel} does not exist - use write_file to create it` };
      const before = fs.readFileSync(full, "utf8");
      const find = String(args.find ?? "");
      if (!find) return { ok: false, text: "`find` cannot be empty" };
      const hits = before.split(find).length - 1;
      if (hits === 0) {
        // Models copy code back with the indentation a little off far more often
        // than they get the code itself wrong. Match line by line ignoring leading
        // and trailing space, and if that finds exactly one place, that is the edit.
        const loose = looseReplace(before, find, String(args.replace ?? ""));
        if (loose.count === 1) {
          fs.writeFileSync(full, loose.text, "utf8");
          const touched: FileTouch = { path: rel, action: "edit", bytes: Buffer.byteLength(loose.text), ts: Date.now() };
          announce(t, w, touched);
          const problem = await syntaxCheck(rel, loose.text);
          return {
            ok: true,
            touched,
            text:
              `edited ${rel} (matched ignoring indentation)` +
              (problem ? `\nSYNTAX ERROR after this edit:\n${problem}\nFix it now.` : ""),
          };
        }
        return {
          ok: false,
          text:
            loose.count > 1
              ? `that text (ignoring indentation) appears ${loose.count} times in ${rel} - include more surrounding lines`
              : `that text is not in ${rel}, even ignoring indentation. read_file the lines you want to change and copy ` +
                "them exactly - or, for a large change, write_file the whole file.",
        };
      }
      if (hits > 1) {
        return {
          ok: false,
          text: `that text appears ${hits} times in ${rel} - include more surrounding lines so it is unique`,
        };
      }
      const after = before.replace(find, String(args.replace ?? ""));
      fs.writeFileSync(full, after, "utf8");
      const touched: FileTouch = { path: rel, action: "edit", bytes: Buffer.byteLength(after), ts: Date.now() };
      announce(t, w, touched);
      const problem = await syntaxCheck(rel, after);
      return {
        ok: true,
        touched,
        text: `edited ${rel}` + (problem ? `\nSYNTAX ERROR after this edit:\n${problem}\nFix it now.` : ""),
      };
    }

    case "run": {
      const res = await shell(String(args.command ?? ""), root, w, t);
      return { ok: res.ok, text: res.text };
    }

    case "finish":
      return { ok: true, finished: true, text: String(args.summary ?? "done") };

    default:
      return { ok: false, text: `no such tool: ${name}` };
  }
}

/**
 * Find `find` in `text` comparing whole lines with surrounding whitespace
 * ignored, and replace the matched lines. Blank lines at either end of `find`
 * do not count. Returns how many places matched; the text is only replaced
 * when that is exactly one.
 */
export function looseReplace(text: string, find: string, replace: string): { count: number; text: string } {
  const lines = text.split("\n");
  const want = find.split("\n").map((l) => l.trim());
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length) return { count: 0, text };
  const starts: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  if (starts.length !== 1) return { count: starts.length, text };
  const at = starts[0];
  const next = [...lines.slice(0, at), ...replace.replace(/\n$/, "").split("\n"), ...lines.slice(at + want.length)];
  return { count: 1, text: next.join("\n") };
}

function notYours(t: Task, rel: string): string {
  const mine = t.claims.length ? t.claims.join(", ") : "nothing";
  return `${rel} belongs to another desk on this job. You own: ${mine}. Work only on those, and assume the rest will exist.`;
}

function announce(t: Task, w: Worker, touched: FileTouch) {
  const seen = t.files.findIndex((f) => f.path === touched.path);
  if (seen >= 0) t.files[seen] = touched;
  else t.files.push(touched);
  store.emitEvent({
    type: "file.write",
    workerId: w.id,
    taskId: t.id,
    text: `${touched.action} ${touched.path}`,
    data: { path: touched.path, action: touched.action, bytes: touched.bytes },
  });
  store.touch();
}

/** Plain-text search, capped. Good enough for "where is this defined". */
function search(root: string, query: string, sub: string): string {
  const start = inside(root, sub === "." ? "." : sub);
  const needle = query.toLowerCase();
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (hits.length >= 60 || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= 60) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock|zip|pdf|mp[34])$/i.test(e.name) || e.name === "package-lock.json") continue;
      let body: string;
      try {
        if (fs.statSync(full).size > 400_000) continue;
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      body.split("\n").forEach((line, i) => {
        if (hits.length < 60 && line.toLowerCase().includes(needle)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  };
  if (fs.statSync(start).isDirectory()) walk(start, 0);
  return hits.length ? `${hits.length}${hits.length >= 60 ? "+" : ""} matches\n${hits.join("\n")}` : `no matches for "${query}"`;
}

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".mts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

/**
 * Parse the file the way the bundler will, right after it is written. A cheap
 * model that leaves an unclosed JSX tag finds out in the same round, while the
 * file is still in its head - not twenty minutes later from a failing build.
 */
export async function syntaxCheck(rel: string, content: string): Promise<string | null> {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return null;
    } catch (err: any) {
      return `JSON: ${err?.message ?? err}`;
    }
  }
  const loader = LOADERS[ext];
  if (!loader) return null;
  try {
    await transform(content, { loader, jsx: "automatic", format: "esm", logLevel: "silent" });
    return null;
  } catch (err: any) {
    const errors: any[] = err?.errors ?? [];
    if (!errors.length) return String(err?.message ?? err).slice(0, 400);
    return errors
      .slice(0, 4)
      .map((e) => {
        const loc = e.location;
        const where = `${rel}:${loc?.line ?? "?"}:${loc?.column ?? "?"}`;
        return `${where} ${e.text}${loc?.lineText ? `\n    ${String(loc.lineText).trim().slice(0, 160)}` : ""}`;
      })
      .join("\n");
  }
}

/**
 * Layout mistakes a desk cannot see, because it never sees the page. Kept to
 * the ones that are nearly always bugs, so a warning is worth a round of
 * attention: an absolutely positioned element with nothing positioned to hold
 * it lands against some ancestor far up the page, over someone else's section.
 */
export function layoutHints(rel: string, content: string): string | null {
  if (!/\.(tsx|jsx)$/.test(rel)) return null;
  const classes = (content.match(/className=(?:"[^"]*"|\{`[^`]*`\}|'[^']*')/g) ?? []).join(" ");
  const has = (word: string) => new RegExp(`(^|[\\s"'\`:{])${word}(?=$|[\\s"'\`])`).test(classes);
  const out: string[] = [];
  if (has("absolute") && !has("relative") && !has("fixed") && !has("sticky")) {
    out.push(
      `- ${rel} positions elements with "absolute" but nothing in it is "relative", so they will be placed against ` +
        'an ancestor far up the page and overlap other sections. Put "relative" on the element that should contain them.',
    );
  }
  return out.length ? out.join("\n") : null;
}

/**
 * The type check, narrowed to one desk. Several desks write one project at
 * once, so the project as a whole will not compile until the last of them
 * lands - a whole-project error list would bury a desk in other people's
 * half-written files. What a desk is shown is what is wrong in the files it
 * owns, plus anything a teammate's file says about its exports. A missing
 * module that another desk is still writing is not an error yet.
 */
export async function deskCheck(
  t: Task,
  command: string,
  othersClaim: string[],
): Promise<{ ok: boolean; report: string }> {
  if (!t.workspace) return { ok: true, report: "" };
  const root = t.workspace;
  const res = await shell(command, root);
  if (res.ok) return { ok: true, report: "" };
  const stillComing = (spec: string) => {
    const tail = spec.replace(/^(\.\.?\/)+/, "");
    return othersClaim.some((c) => {
      const base = c.replace(/\.(tsx?|jsx?|css)$/, "");
      return base.endsWith(tail) && !fs.existsSync(path.join(root, c));
    });
  };
  const myNames = t.claims
    .filter((c) => c !== "**")
    .map((c) => path.basename(c).replace(/\.(tsx?|jsx?)$/, ""))
    .filter(Boolean);
  const lines = res.text.split(/\r?\n/);
  const own: string[] = [];
  const about: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (!m) continue;
    const rel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    let msg = m[5];
    // tsc continues a long message on indented lines
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) msg += ` ${lines[++i].trim()}`;
    const missing = msg.match(/Cannot find module '([^']+)'/);
    if (missing && stillComing(missing[1])) continue;
    const line = `${rel}:${m[2]}:${m[3]} ${m[4]} ${msg}`;
    if (owns(t.claims, rel)) own.push(line);
    else if (myNames.some((n) => msg.includes(`/${n}'`) || msg.includes(`/${n}"`))) about.push(line);
  }
  if (!own.length && !about.length) return { ok: true, report: "" };
  const parts: string[] = [];
  if (own.length) parts.push(`Type errors in your files:\n${own.slice(0, 25).join("\n")}`);
  if (about.length) {
    parts.push(
      `A teammate's file cannot use what yours exports:\n${about.slice(0, 10).join("\n")}\n` +
        "Match the export names and props in the contract exactly.",
    );
  }
  return { ok: false, report: parts.join("\n\n") };
}

// ---- the shell -------------------------------------------------------

/** Commands that never exit on their own. */
const SERVERS =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|^\s*(npx\s+)?(vite|nodemon|live-server|http-server|serve)\s*$|^\s*(npx\s+)?vite\s+(dev|serve|preview)\b|\s--watch\b|\btsx\s+watch\b/i;

export interface ShellCheck {
  ok: boolean;
  reason?: string;
  head?: string;
}

/**
 * Is this command allowed. Each `&&`-joined segment is checked on its own
 * head, so `cd api && npm i` cannot hide anything behind the first word.
 */
export function checkCommand(raw: string): ShellCheck {
  const line = String(raw ?? "").trim();
  if (!line) return { ok: false, reason: "empty command" };
  if (SMUGGLERS.test(line)) {
    return {
      ok: false,
      reason: "pipes, redirects, backgrounding and subshells are not allowed - run one command at a time",
    };
  }
  // a server never exits, so the desk would sit on a three-minute timeout for nothing
  if (SERVERS.test(line)) {
    return { ok: false, reason: "servers and watchers never exit - run `npm run build` or the tests instead" };
  }
  const extra = new Set((store.state.settings.shellExtra ?? []).map((s) => s.toLowerCase()));
  for (const segment of line.split("&&")) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { ok: false, reason: "empty command" };
    let head = parts[0].toLowerCase();
    // `cd somewhere && ...` is fine as a prefix; the jail is enforced by cwd anyway
    if (head === "cd") {
      if (parts.length < 2) return { ok: false, reason: "cd needs a folder" };
      continue;
    }
    head = head.replace(/\.(exe|cmd|bat)$/i, "").split(/[\\/]/).pop() ?? head;
    if (DENIED_COMMANDS.has(head)) return { ok: false, reason: `${head} is not allowed on the floor`, head };
    if (!ALLOWED_COMMANDS.has(head) && !extra.has(head)) {
      return { ok: false, reason: `${head} is not on the allowlist`, head };
    }
  }
  return { ok: true };
}

export interface ShellResult {
  ok: boolean;
  code: number | null;
  text: string;
  ms: number;
}

/** Run an allowed command with cwd pinned to the root, capped and on a timer. */
export function shell(command: string, root: string, w?: Worker, t?: Task): Promise<ShellResult> {
  const verdict = checkCommand(command);
  if (!verdict.ok) {
    return Promise.resolve({
      ok: false,
      code: null,
      ms: 0,
      text: `refused: ${verdict.reason}. Allowed: ${[...ALLOWED_COMMANDS].slice(0, 24).join(", ")}, ...`,
    });
  }
  if (w && t) {
    store.emitEvent({
      type: "shell.run", workerId: w.id, taskId: t.id,
      text: command.slice(0, 120), data: { command },
    });
  }

  const started = Date.now();
  // shell:true is what makes `&&` and the PATH shims work; the allowlist above
  // is what makes that safe, together with cwd never leaving the root.
  return new Promise((resolve) => {
    execFile(
      command,
      [],
      { cwd: root, shell: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err: any, stdout: string, stderr: string) => {
        const ms = Date.now() - started;
        let text = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (text.length > RUN_OUTPUT_CAP) {
          // the end of a build log is where the errors are, so keep both ends
          const head = text.slice(0, RUN_OUTPUT_CAP / 2);
          const tail = text.slice(-RUN_OUTPUT_CAP / 2);
          text = `${head}\n... [${text.length - RUN_OUTPUT_CAP} chars cut from the middle] ...\n${tail}`;
        }
        const killed = Boolean(err?.killed);
        const code = killed ? null : typeof err?.code === "number" ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          ms,
          text:
            (killed ? `timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s\n` : "") +
            `exit ${code ?? "killed"} in ${ms}ms\n${text || "(no output)"}`,
        });
      },
    );
  });
}

/** `npm install` for a freshly laid stack. Slow the first time, so it gets its own clock. */
export function install(root: string): Promise<ShellResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "npm install --no-audit --no-fund --loglevel=error",
      [],
      { cwd: root, shell: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err: any, stdout: string, stderr: string) => {
        const text = [stdout, stderr].filter(Boolean).join("\n").trim().slice(-3000);
        resolve({
          ok: !err,
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          ms: Date.now() - started,
          text: text || "(no output)",
        });
      },
    );
  });
}

/** How much of a failing check is kept - and fed back to the desk to repair from. */
const VERIFY_KEEP = 4000;

/** The check that decides whether the work is real. Failure is fed back, not hidden. */
export async function verify(t: Task, w: Worker): Promise<VerifyResult | null> {
  if (!t.workspace || !t.verify) return null;
  const res = await shell(t.verify, t.workspace, w, t);
  // the end of a build log is where the reason is, so a long one is kept by its
  // tail rather than its head - the desk repairs from this exact string
  const out: VerifyResult = {
    command: t.verify,
    ok: res.ok,
    code: res.code,
    output:
      res.text.length > VERIFY_KEEP
        ? `...[${res.text.length - VERIFY_KEEP} earlier chars cut]\n${res.text.slice(-VERIFY_KEEP)}`
        : res.text,
    ms: res.ms,
  };
  t.verifyRuns.push(out);
  // a desk that repaired four times does not need all four logs kept on the
  // task for ever; the last two are what anyone reads
  if (t.verifyRuns.length > 3) t.verifyRuns.splice(0, t.verifyRuns.length - 3);
  store.emitEvent({
    type: "verify",
    workerId: w.id,
    taskId: t.id,
    text: `${t.verify} ${res.ok ? "passed" : "failed"}`,
    data: { ok: res.ok, command: t.verify, ms: res.ms, preview: res.text.slice(0, 300) },
  });
  store.touch();
  return out;
}

/** What changed on disk since the shift started, if git is there to say. */
export function changed(root: string): string[] {
  try {
    const out = String(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, timeout: 10_000, windowsHide: true }),
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export { ALLOWED_COMMANDS };
