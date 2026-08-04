<div align="center">

# NIGHTSHIFT

**A pixel office where cheap models work the night shift and you are the boss.**

![the floor](docs/scene.png)

[![ci](https://github.com/kaanisthatyou/nightshift/actions/workflows/ci.yml/badge.svg)](https://github.com/kaanisthatyou/nightshift/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kaandrick/nightshift?color=ff5fa2&label=npm)](https://www.npmjs.com/package/@kaandrick/nightshift)
[![license: MIT](https://img.shields.io/badge/license-MIT-ff5fa2)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.6-4fd1c5)](https://nodejs.org)

</div>

Every desk on the floor is an agent backed by a real model served through an
[OmniRoute](https://www.npmjs.com/package/omniroute) gateway. Give an order and the boss
avatar physically walks to that desk, says the prompt in a speech bubble, and the worker
starts typing. **The monitor scrolls at the speed of the token stream** — what you are
watching is the actual response coming in. Finished work flies into the IN tray and waits
for you to approve it or throw it back.

It is a real tool wearing a costume: a local model gateway, a job queue, batching,
pipelines, and an A/B arena — with a window you can leave open on a second monitor and
actually enjoy looking at.

Claude Code drives the same floor over HTTP, so the heavy thinking happens in Claude while
the small, boring, repetitive work gets pushed down to free models.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Claude Code (orchestrator)  ── POST /api/orders ──┐         │
  │  You (the window)            ── click a desk ──────┤         │
  └────────────────────────────────────────────────────┼─────────┘
                                                       ▼
                                        NIGHTSHIFT floor server :20200
                                                       │
                                          OpenAI-compatible /v1
                                                       ▼
                                             OmniRoute :20128
                                     290+ providers · 500+ models · 90+ free
```

---

## Requirements

| | |
|---|---|
| **Node** | 22.6 or newer. The server runs as TypeScript, straight from source. |
| **OS** | Linux, macOS, Windows. Nothing platform-specific, no launcher scripts. |
| **A gateway** | Optional to *start*, required to reach a model. Anything OpenAI-compatible at a `/v1` base URL works; [OmniRoute](https://www.npmjs.com/package/omniroute) is what it is built and tested against. |
| **Provider keys** | None needed to try it. A bare OmniRoute serves ~115 models with no credentials at all. |
| **Network at runtime** | None. The pixel font is embedded and every sprite is drawn in code, so the window renders with the cable unplugged. |

## Run it

```bash
npx @kaandrick/nightshift
```

That is the whole thing — it builds the window on first run, tells you whether it found a
gateway, serves on **http://localhost:20200** and opens it. `Ctrl+C` closes the floor.

Or from source, which is what you want if you intend to change anything:

```bash
git clone https://github.com/kaanisthatyou/nightshift
cd nightshift
npm install
npm start
```

Either way the same flags apply:

```bash
npm start -- --port 8080          # somewhere else
npm start -- --no-open            # don't touch the browser
npm start -- --gateway http://box.local:20128/v1
```

Working on it instead of using it:

```bash
npm run dev          # floor :20200 + vite :5180 with HMR, open http://localhost:5180
```

### Plug in a gateway

```bash
npm install -g omniroute
omniroute            # dashboard + gateway on http://localhost:20128
```

Then in NIGHTSHIFT open the **gateway** tab, paste `http://localhost:20128/v1` and — only if
your instance requires one — the API key from its dashboard → Endpoints. Hit connect and the
model board fills up.

Environment variables work too (see `.env.example`):

```bash
OMNIROUTE_URL=http://localhost:20128/v1 OMNIROUTE_KEY=sk-... npm start
```

Have a pile of provider keys to load into OmniRoute? `cp keys.example.txt ~/.omniroute/keys.txt`,
fill it in, then `npm run keys` (`npm run keys -- --dry-run` first if you want to see the
parse without sending anything). NIGHTSHIFT never stores a provider key itself — it only ever
talks to the gateway.

---

## The floor

<img src="docs/desk.png" width="49%" alt="two desks, name plate and model label"> <img src="docs/boss.png" width="49%" alt="the boss corner and the IN tray">

| thing | what it means |
|---|---|
| desk | one agent, one model, one seat (8 desks max) |
| name / cyan label | who they are and which model is sitting there |
| monitor scroll speed | live token stream from that model |
| speech bubble | boss orders and worker replies, as they happen |
| morale bar | up when you approve, down when you reject or it fails |
| IN tray | finished work waiting for review |
| payroll | real cost, computed from the gateway's pricing |
| neon sign | pink = gateway up, red flicker = gateway down |

Click a desk to select it, `/` focuses the order bar, `Esc` closes a task. Three desks are
already staffed on first boot so there is something to give an order to.

### Two rules the product will not break

**Unpriced is not free.** A gateway only reports pricing for providers it has credentials
for. Models it gives no price for are tagged **`no price`**, never `free` — unknown is not
the same as free. Only a known price, or a real per-response cost header, moves the payroll
figure.

**Nothing is invented behind your back.** Some catalog entries are listed but answer
`401 not supported`. When that happens the desk does not silently die and does not silently
swap either: the task is retried once on the gateway's own `auto` router and the result is
stamped **`fell back from <model>`** in the board and in the task detail, so you always know
who actually did the work.

And with no gateway reachable at all, the floor still runs — but every output is marked
`GHOST OUTPUT` and tagged `ghost` in the API. Nothing is sent anywhere and nothing is made
up. Turn it off in gateway → house rules.

## Batches, pipelines, arena

Three ways to move volume, all in the board tab and all on the API:

- **Batch** — one template, a list of items, split across whichever desks are free, with
  retries landing on a *different* desk than the one that failed.
- **Pipeline** — steps that feed each other. `{{input}}` is replaced with the previous
  step's output. Draft on a free model, polish on a better one, translate on a third.
- **Arena** — the same prompt to several desks at once, side by side, and you pick the
  winner. It is recorded on that desk. Stop guessing which free model is better.

## Claude Code as the boss

The whole floor is drivable over HTTP:

```bash
# give an order and wait for the answer (this is the one you want)
curl -s localhost:20200/api/orders -H 'content-type: application/json' \
  -d '{"text":"rewrite these 20 commit messages in imperative mood: ...","wait":true}'

# fire and forget, then read it back later
curl -s localhost:20200/api/orders -H 'content-type: application/json' -d '{"text":"...","wait":false}'
curl -s localhost:20200/api/tasks/<id>
```

A Claude Code skill ships in `nightshift-skill/` — the playbook for when to delegate, how to
fan work out across desks, how to run an arena, and how to report back honestly about which
model did what:

```bash
cp -r nightshift-skill ~/.claude/skills/nightshift        # macOS / Linux
```

```powershell
Copy-Item -Recurse nightshift-skill $HOME\.claude\skills\nightshift   # Windows
```

Then just say *"nightshift these"* and hand over a batch.

### API

| method | path | what it does |
|---|---|---|
| GET | `/api/state` | full snapshot: workers, tasks, jobs, ledger, gateway |
| GET | `/api/models?refresh=1` | model board with free/price flags |
| POST | `/api/gateway` | `{baseUrl, apiKey}` — reconnect |
| POST | `/api/workers` | `{model, name?, title?}` — hire |
| PATCH | `/api/workers/:id` | `{model?, name?, state?}` — reassign a desk |
| DELETE | `/api/workers/:id` | fire |
| POST | `/api/orders` | `{text, workerId?, model?, wait?, waitMs?}` — the boss walks over |
| POST | `/api/tasks` | same but without the theatre defaults |
| GET | `/api/tasks/:id` | one task with output, tokens, cost, latency, routing decision |
| POST | `/api/tasks/:id/approve` | morale up, task closed |
| POST | `/api/tasks/:id/reject` | `{note}` — sends it back with your note attached |
| POST | `/api/tasks/:id/retry` | run it again |
| POST | `/api/jobs` | `{title, steps:[{title, prompt}]}` — pipeline |
| POST | `/api/batch` | `{title, template, items[], retries}` — one list split across desks |
| POST | `/api/arena` | `{text, workerIds?}` — same prompt to several desks |
| POST | `/api/arena/:id/winner` | `{taskId}` — your call, recorded on that desk |
| POST | `/api/office` | `{kind}` — make something happen (`pizza`, `gossip`, `cat`, `printer`, `flicker`, `sleepy`) |
| POST | `/api/boss/say` | `{text, workerId?}` — talk to the room |
| WS | `/ws` | every event, live |

---

## Layout

```
bin/nightshift.mjs  the one command: build check, gateway probe, serve, open
server/             floor server: gateway client, scheduler, REST, websocket
  omniroute.ts        streaming OpenAI-compatible client + model/pricing normalising
  engine.ts           who works on what, retries, pipelines, the theatre timing
  store.ts            state + json persistence (data/floor.json)
  routes.ts           the API above
web/src/            the window
  pixel/art.ts        every object on the floor as a char grid, DOM-free on purpose
  pixel/sprites.ts    bakes art.ts to canvases, plus the people
  pixel/scene.ts      the 360x240 renderer: rain, lighting, walking, bubbles
  components/         roster, board, wire, gateway panels
tools/              art review and key import
shared/             types both sides agree on
```

## Drawing the pixel art

<img src="docs/window.png" width="70%" alt="a window sprite, close up">

`art.ts` holds no DOM calls, which lets the art be rendered and looked at without a browser.
Two tools do that:

```bash
npm run art          # every asset on a contact sheet + a room mock, into .art/
npm run shots        # the REAL FloorScene, headless, into docs/
```

`npm run art` fails loudly on the three things that go wrong when you draw with strings: a
row of the wrong length, a character with no palette entry, and an asset that nothing in
`scene.ts` ever draws. Both run in CI — the images in this README are generated by
`npm run shots`, not screenshotted by hand.

More in [CONTRIBUTING.md](CONTRIBUTING.md), including the desk geometry contract every prop
depends on.

## License

MIT — see [LICENSE](LICENSE).

One exception: the Silkscreen typeface is embedded as base64 so the floor works offline. It
is copyright The Silkscreen Project Authors under the SIL Open Font License 1.1 and is not
covered by the MIT license — details in [NOTICE.md](NOTICE.md).
