# Contributing

Issues and PRs are welcome. The project is small and opinionated; this page is the whole
process.

## Getting set up

```bash
git clone https://github.com/kaanisthatyou/nightshift
cd nightshift
npm install
npm run dev          # floor :20200 + vite :5180, open http://localhost:5180
```

You do not need a gateway to work on the UI — with none reachable the floor runs a ghost
shift and every output is stamped `GHOST OUTPUT`.

Before pushing:

```bash
npm run typecheck
npm run art          # validates every sprite, fails loudly
```

Both run in CI, along with a headless render of the real scene.

## Working on the pixel art

`web/src/pixel/art.ts` contains no DOM calls, which is what lets the art be checked and
rendered without a browser. Keep it that way.

```bash
npm run art          # contact sheet of every asset + a room mock, into .art/
npm run shots        # the REAL FloorScene, headless, into docs/
```

`npm run art` fails on the three things that go wrong when you draw with strings: a row of
the wrong length, a character with no palette entry, and an asset that nothing in
`scene.ts` ever draws.

Geometry contract, since every prop depends on it: a desk is drawn at `(cx-19, dy)` and its
first four rows are the top face, so `dy+3` is the surface line. Anything standing on a desk
is positioned so its last row lands there.

Change a sprite, re-run `npm run shots`, **look at the PNG**. Do not guess.

## Two rules that are not style preferences

These are the reason the thing is trustworthy, and a PR that breaks either will be sent
back:

1. **Unpriced is not free.** A bare OmniRoute reports no pricing for providers it has no
   credentials for. Those models are tagged `no price`, never `free`. Only a known price
   (or a real `x-omniroute-response-cost` header) may move the payroll figure.
2. **Nothing is invented behind the user's back.** A model that is listed but refuses to
   serve gets retried once on `auto` and the result is stamped `fell back from <model>` —
   never silently swapped. With no gateway at all, output is marked `GHOST` and flagged
   `ghost: true` in the API.

## Scope

Things that fit: more of the floor (props, events, panels), gateway compatibility with other
OpenAI-compatible routers, better batching and pipelines, accessibility of the non-canvas UI.

Things that do not: a hosted/multi-tenant version, telemetry, a component library, and any
feature that needs the network at render time — the floor is meant to run with the cable
unplugged.
