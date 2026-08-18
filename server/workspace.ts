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
      description: "Read a file in the working folder. Read a file before you edit it.",
      schema: {
        type: "object",
        properties: { path: { type: "string", description: "path relative to the working folder" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Create a file, or replace one completely, with the content you give. This is how you actually deliver code - " +
        "code printed in your reply is thrown away, only files written with this tool exist.",
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
        "Run a command in the working folder - install a dependency, build, run the tests. " +
        "Only build tooling is allowed (npm, node, python, pytest, tsc, git and the like). Nothing that fetches from the network.",
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
      let body = fs.readFileSync(full, "utf8");
      const clipped = body.length > READ_CAP;
      if (clipped) body = body.slice(0, READ_CAP);
      const numbered = body.split("\n").map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
      return {
        ok: true,
        text: `${args.path}\n${numbered}${clipped ? "\n... [file continues, truncated]" : ""}`,
      };
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
      return {
        ok: true,
        touched,
        text: `${existed ? "rewrote" : "created"} ${rel} (${touched.bytes} bytes, ${content.split("\n").length} lines)`,
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
        return {
          ok: false,
          text: `that exact text is not in ${rel}. read_file it again and copy the text as it actually is.`,
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
      return { ok: true, touched, text: `edited ${rel}` };
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

// ---- the shell -------------------------------------------------------

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
