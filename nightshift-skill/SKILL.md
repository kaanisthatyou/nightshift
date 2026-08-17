---
name: nightshift
description: "Use when work should be pushed down to cheap or free models instead of being done here — batches of small mechanical subtasks (renaming, rewriting, translating, summarising, generating variants, extracting fields, drafting boilerplate), or when the user says nightshift / delege et / ucuz modele ver / floor'a at. Also use to check what the floor is doing, review finished work, or run a multi-step pipeline across desks. NIGHTSHIFT is a local pixel office at http://localhost:20200 backed by an OmniRoute gateway."
---

# NIGHTSHIFT — you are the boss

There is a floor of workers at `http://localhost:20200`. Each desk is an agent bound to a
model served through OmniRoute (`http://localhost:20128/v1`). You dispatch orders over HTTP;
the user watches your avatar walk to the desk and say the prompt.

You do the thinking. The floor does the volume.

## Before anything

```bash
curl -s localhost:20200/api/health
```

- connection refused → the floor is not running. Tell the user to run `npm start` in their
  nightshift checkout. Do not fake it.
- `gateway.online: false` → OmniRoute is down. Work still "runs" but every output is a
  **ghost**: `"ghost": true`, body starts with `GHOST OUTPUT`. **Never use ghost output as
  if it were real.** Say the gateway is down and offer to start it (`omniroute`).

## Staffing

```bash
curl -s localhost:20200/api/state | jq '.state.workers[] | {id,name,role,temper,model,state}'
curl -s "localhost:20200/api/models" | jq '.models[] | select(.free) | .id' | head -20
curl -s localhost:20200/api/workers -H 'content-type: application/json' -d '{"model":"<model-id>"}'
```

8 desks max. Prefer free models for grunt work; only put a paid model on a desk when the
task genuinely needs the quality, and say so out loud — it lands on the payroll.

Two things the model board will tell you, and you must repeat honestly:
- `"unpriced": true` means OmniRoute reported **no price**, not that it is free. Never call
  an unpriced model free.
- A model can be listed and still refuse to serve. The floor retries such a task once on
  `auto` and stamps the result with `fallbackFrom`. If a task you read back has
  `fallbackFrom` set, the desk's model did **not** do that work — say which one did.

## Loadouts — hiring a crew, not a model

A desk can carry a **role** (what it knows) and a **temper** (how it answers). Together they
become that desk's system prompt, so every task it takes is answered in character. This is
the cheapest quality win available: a `luau` desk writes better Luau than a bare model does.

```bash
curl -s localhost:20200/api/presets | jq '.presets[] | {id, name, roles: [.roles[].key]}'
```

Presets: `roblox`, `webapp`, `content`, `research`, `data`, `localize`, `venture`, `general`.

```bash
# the core loadout walks in together
curl -s localhost:20200/api/presets/roblox/hire -H 'content-type: application/json' -d '{}'

# clear the floor first when switching project types
curl -s localhost:20200/api/presets/roblox/hire -H 'content-type: application/json' -d '{"replace":true}'

# one more from the bench (this is what "+ add another" does in the window)
curl -s localhost:20200/api/workers -H 'content-type: application/json'   -d '{"presetId":"roblox","roleKey":"toolscout"}'

# swap a head without moving the desk
curl -s -X PATCH localhost:20200/api/workers/<id> -H 'content-type: application/json'   -d '{"temper":"paranoid"}'
```

Tempers: `steady`, `perfectionist`, `speedrunner`, `contrarian`, `pedant`, `showman`,
`minimalist`, `paranoid`. One is picked at random when you do not name one. Hiring the same
role twice is deliberate — two heads on one role is how you get two real options.

## Giving an order

```bash
curl -s localhost:20200/api/orders -H 'content-type: application/json' -d '{
  "text": "<the full self-contained prompt>",
  "workerId": "<optional desk>",
  "wait": true, "waitMs": 120000
}'
```

Returns the task with `output`, `tokensIn/Out`, `costUsd`, `latencyMs`, `decision`
(which provider actually served it) and `ghost`.

For several independent chunks, fire them with `"wait": false`, collect the ids, then read
each back with `GET /api/tasks/<id>` — they run in parallel across desks (default 4 at once).

## What to delegate

Good: mechanical, self-contained, cheap to verify. Rewrites, translations, N variants of
something, extracting structured fields out of text you paste in, boilerplate drafts,
naming, test data, summarising a chunk you hand over in the prompt.

Bad: anything needing the repo in context, anything where a wrong answer is expensive and
hard to spot, anything the user asked *you* specifically to reason about, secrets.

Every order must be self-contained — the desks cannot read files, run commands, or see this
conversation. Paste what they need into the prompt.

## Reviewing

Read what comes back before you use it. Then close the loop, because the floor tracks morale
and the user is watching:

```bash
curl -s -X POST localhost:20200/api/tasks/<id>/approve
curl -s -X POST localhost:20200/api/tasks/<id>/reject -H 'content-type: application/json' \
  -d '{"note":"what exactly is wrong"}'      # re-runs with your note attached
```

If output is unusable twice, take the task back and do it yourself rather than burning turns.

## Pipelines

```bash
curl -s localhost:20200/api/jobs -H 'content-type: application/json' -d '{
  "title": "changelog run",
  "steps": [
    {"title":"draft","prompt":"turn these commits into a changelog:\n<commits>"},
    {"title":"tighten","prompt":"cut this to 8 bullets, keep the facts:\n\n{{input}}"},
    {"title":"tr","prompt":"translate to turkish, keep the tech terms english:\n\n{{input}}"}
  ]
}'
```

`{{input}}` is the previous step's output. Steps hand off automatically; poll
`GET /api/jobs/<id>`.

## One list, every desk

When you have N of the same small job (rewrite these 20 lines, classify these 30 rows), do
not fire 20 orders. Send one batch — the floor splits it across free desks and retries
failures on a *different* desk:

```bash
curl -s localhost:20200/api/batch -H 'content-type: application/json' -d '{
  "title": "commit messages",
  "template": "Rewrite this commit message in imperative mood, one line:\n{{item}}",
  "items": ["fixed the thing", "more fixes", "wip"],
  "retries": 1
}'
```

Poll `GET /api/jobs/<id>` for progress; each item is a normal task you can read back.

## The whiteboard — planning before working

When the ask is bigger than one desk, do not hand-write six orders. Put the idea on the
whiteboard, let it be cut into steps, fix the steps, then send the whole thing down as one job.

```bash
# draft only - nothing runs
curl -s localhost:20200/api/plans -H 'content-type: application/json' -d '{
  "idea": "<the whole messy idea>",
  "presetId": "roblox",
  "stepCount": 5
}' | jq '.plan | {id, title, summary, steps: [.steps[] | {id,title,roleKey}]}'
```

The draft is a starting position, not an instruction. Read it, and if a step is vague or
wrong, fix it before it costs anything:

```bash
curl -s -X PATCH localhost:20200/api/plans/<planId> -H 'content-type: application/json'   -d '{"steps":[ ... the full edited list, keeping each step id ... ]}'

# one step turns out to be three
curl -s localhost:20200/api/plans/<planId>/expand -H 'content-type: application/json'   -d '{"stepId":"<stepId>","count":3}'

# off the board and onto the floor
curl -s localhost:20200/api/plans/<planId>/run -H 'content-type: application/json'   -d '{"mode":"chain"}'
```

`chain` makes each step wait for the one above it, with `{{input}}` receiving its output —
one failure stops the rest. `split` sends every step out at once across free desks, and
nothing feeds anything. Steps with `"enabled": false` stay on the board.

Steps route by `roleKey` to a desk holding that role, or by `workerId` to a pinned desk;
with neither, they go to whoever is free. A step whose role nobody holds still runs — it
just runs on a generalist, so hire the role first if it matters.

Planning itself costs tokens and lands on the same ledger. It runs on
`settings.plannerModel` (`POST /api/settings {"plannerModel":"..."}`) — worth a smarter
model than the desks, since everything downstream inherits its judgement.

Poll `GET /api/plans/<planId>` for the plan plus its tasks.

## The toolbox — when a desk needs more than words

Desks can call MCP tools. `GET /api/mcp` lists the servers the floor has open and every
tool on them; hand a server to a desk with
`PATCH /api/workers/<id> {"mcpIds":["<id or name>"]}`, and narrow it to specific tools with
`{"mcpTools":["server.tool"]}` when the desk keeps reaching for the wrong one.

The desk then runs its own tool loop (up to `settings.mcpMaxRounds`) and the calls land on
the task: `GET /api/tasks/<id>` returns `toolCalls[]` with the server, arguments, result and
duration. Read those before you trust the answer — a desk that never called the tool it was
given usually answered from imagination.

Do not hand a toolbox to every desk by default. A cheap model with twenty-six schemas in
front of it picks badly; give one desk the one server it needs for that job.

## Picking a model honestly

Do not guess which free model is better — run them against each other:

```bash
curl -s localhost:20200/api/arena -H 'content-type: application/json' \
  -d '{"text":"<the prompt>", "workerIds":["w_1","w_2","w_3"]}'   # omit workerIds for every desk
curl -s localhost:20200/api/arena/<arenaId>                        # outputs, latency, tokens
curl -s -X POST localhost:20200/api/arena/<arenaId>/winner -d '{"taskId":"t_..."}' \
  -H 'content-type: application/json'
```

Report *why* the winner won (faster, shorter, actually followed the format), not just that
it did.

## Talking to the room

`POST /api/boss/say {"text":"...", "workerId":"..."}` makes the avatar speak without
creating work. Use it sparingly — status narration, a nudge before a big pipeline.

## Reporting back

Tell the user which desk did what, whether it was free or cost something, and what you
changed in the output. Attribute honestly: "GLM 4.7 drafted this, I fixed the two wrong
imports" beats a silent copy-paste.
