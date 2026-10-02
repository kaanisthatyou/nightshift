# Changelog

What changed for someone running the floor. The commits say why.

## 0.5.0 — unreleased

The floor stops needing a gateway, outgrows eight desks, and builds in waves.

### The router — no gateway any more

- **The floor calls providers itself.** NVIDIA NIM, Groq, Gemini, OpenRouter, Cerebras,
  Mistral, DeepSeek, OpenAI, Ollama, LM Studio, or any OpenAI-compatible `/v1` server.
  OmniRoute is no longer needed, or used.
- **Every API key is a lane** with its own requests-a-minute clock, in-flight cap and rest
  timer after a `429`. Two NIM keys are two budgets, and the floor uses both.
- **A conversation outlives its quota.** Every round of a desk's work is its own request, so
  when a key is refused mid-task the same conversation carries on at the next key, then the
  next model on the route. A desk only waits when every lane that could serve it is resting.
- **Routes** are ordered pools of models (`route:<id>`); `auto` is the one everybody spills onto.
- A task records the lane that served it (`via nim#2 z-ai/glm-5.3`) and its `hops`.
- A desk pinned to one model spills onto `auto` when every key for that model is resting
  for longer than a short wait; `routerFallback: false` keeps it on its own model instead.
- **Keys** go in under mains ▸ providers, through `POST /api/providers/keys`, from
  `NVIDIA_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` and friends, or from
  `~/.nightshift/keys.txt`. They are stored in `~/.nightshift/providers.json` and never sent
  to the window.
- **Thinking is capped**: `settings.reasoning` (`low` by default) for the floor, and per desk.
- The mains tab is rebuilt around it: providers with their live lanes, routes, house rules,
  the model board.

### The office — rooms, not a desk limit

- Up to eight rooms of up to eight desks, each with a name and a theme (`night shift`, `loft`,
  `lab`, `greenhouse`, `arcade`), joined by hallways. Five layouts to start from: `garage` (4),
  `floor13` (8, the default), `studio` (12), `agency` (20), `campus` (32).
- `GET` / `POST /api/office`, and an office editor under mains. Rebuilding never fires anyone:
  an office smaller than the crew is refused.

### Build mode — waves, a stack and a contract

- **Build plans run in waves**: the foundation first, then every feature at once, then
  assembly. A wave goes out when the whole wave before it has landed.
- **The floor lays the stack down** (`react-vite`, `vanilla-vite`, `node-api`, `static`) and
  runs `npm install` once, before any desk starts.
- **The planner writes a contract** — tokens, every file's exports and props, data shapes,
  content — that every desk receives with the team's file map. Read and edit it as
  `plan.contract`.
- The plan is drafted as a stream, so a slow model shows progress, and a plan cut off
  mid-write keeps every step it finished.
- A build order typed into the window is planned for the whole team when the ask is big
  enough, instead of always going to one desk. Pinning it to a desk still means one desk.
- **Desks catch their own mistakes**: every write is parsed on the spot (esbuild), a desk
  that says it is done gets its own files type-checked, `edit_file` forgives indentation, and
  a positioned element with nothing to hold it gets a layout warning.
- New tool `search_files`; `read_file` takes `from` / `to`.
- `run` refuses dev servers and watchers, and an absolute path is refused instead of being
  quietly re-rooted inside the folder.
- Long conversations are compacted, and a failed step no longer sinks a wave plan — the final
  check and the fixer desk run anyway.

### Breaking

- `--gateway`, `OMNIROUTE_URL` and `OMNIROUTE_KEY` are gone, and so are `POST /api/gateway`,
  `GET /api/combos` and `POST /api/combos/use`. Desks sitting on gateway ids (`auto/...`,
  `oc/...`) are moved to `auto` on boot.
- `POST /api/office` now rebuilds the office. Happenings live at `POST /api/happening`; a body
  with only `{kind}` still reaches them through the old path.
- `npm run keys` posts to the running floor instead of to OmniRoute.
- Build plans default to `waves` instead of `chain`, and `maxParallel` defaults to 32 (up to 64).

### Also

- The window drops most of its pixel skin — the CRT overlay, the pixel cursor, the hard
  shadows. The office itself keeps every pixel.

## 0.4.0 — 2026-08-18

- **Build mode.** Point the floor at a folder and a desk gets `list_files`, `read_file`,
  `write_file`, `edit_file`, `run` and `finish` inside it, and nowhere else.
- A desk that says it is done gets the check run, and a failure goes back into the same
  conversation to repair. A build desk that wrote no files fails.
- Build plans divide a filesystem: every step owns its files, and a plan with a check gets a
  fixer desk when the whole job lands and the check is red.
- `POST /api/build`, the workspace routes, a build tab, and a task sheet that shows the disk.
- `npm run check:jail` — the jail tested without a model in the loop.

## 0.3.2 — 2026-08-18

- The crew lives in `~/.nightshift/`, not next to the code, so it survives an update.
  `NIGHTSHIFT_DATA` points it elsewhere.
- A body mangled by a shell's quoting gets an error that says so.

## 0.3.1 — 2026-08-18

- A whiteboard plan with no `{{input}}` goes out to the whole floor at once instead of
  running as a relay.

## 0.3.0 — 2026-08-18

- **A rate limit is a clock, not a failure**: a `429` sends the desk for a coffee exactly as
  long as the provider asked, and the task keeps its retries.
- The whole floor works at once.
- The router panel, and routers at the top of the model picker.

## 0.2.2 — 2026-08-18

- The model picker is grouped by provider and no longer cuts ids in half.

## 0.2.1 — 2026-08-18

- The model board is searchable.
- Native widgets stop coming up white-on-white.

## 0.2.0 — 2026-08-17

- **Crew loadouts** with real personas and tempers, the **whiteboard** that cuts an idea
  into steps, and an **MCP toolbox** a desk can be handed.
- `--update`, `--version`, and a quiet check for a newer release.
- `START NIGHTSHIFT.bat` for people who never open a terminal.

## 0.1.0 — 2026-08-04

- The floor: a pixel office where every desk is an agent on a real model, with batches,
  pipelines and an A/B arena underneath.
- Published as `@kaandrick/nightshift`.
