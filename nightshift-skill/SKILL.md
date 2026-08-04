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
curl -s localhost:20200/api/state | jq '.state.workers[] | {id,name,model,state}'
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
