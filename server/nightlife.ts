// Nobody just works for eight hours. Things happen on a floor at 3am.
import { store } from "./store.ts";
import { pick } from "./flavor.ts";
import type { Worker } from "../shared/types.ts";

/** Speak without disturbing what someone is doing. */
function speak(w: Worker, text: string) {
  w.saying = text;
  store.emitEvent({ type: "worker.say", workerId: w.id, text });
  store.touch();
}

const idle = () => store.state.workers.filter((w) => w.state === "idle");
const busy = () => store.state.workers.filter((w) => w.state === "typing" || w.state === "thinking");

interface Happening {
  kind: string;
  weight: number;
  cooldownMs: number;
  can: () => boolean;
  run: () => void;
}

const lastFired = new Map<string, number>();

const PIZZA_LINES = [
  "pizza geldi!", "kim siparis verdi ya", "bir dilim bana", "bu saatte pizza, efsane",
];
const GOSSIP_OPENERS = [
  "duydun mu, ust katta biri kovulmus",
  "bu patron hic uyumuyor mu",
  "yine mi ayni prompt",
  "modelim bugun cok yavas",
  "klimayi tamir edecekler miymis",
  "gecen gece sunucu yandi diyorlar",
];
const GOSSIP_REPLIES = [
  "bana ne anlatiyorsun, isim var",
  "ben duymadim ama mantikli",
  "sus, duyacak",
  "her gece ayni muhabbet",
  "sen de mi oyle dusunuyorsun",
  "bir dahakine kahve senden",
];
const CAT_LINES = [
  "kedi yine klavyeye oturdu", "cik oradan", "en azindan biri mutlu", "mirnav",
];
const PRINTER_LINES = [
  "yazici yine sikisti", "bu yaziciyi kim aldi", "kagit bitmis", "yazici bize dusman",
];
const SLEEPY_LINES = ["bir dakika gozumu kapatiyorum...", "sadece dinleniyorum", "zzz"];

const HAPPENINGS: Happening[] = [
  {
    kind: "pizza",
    weight: 2,
    cooldownMs: 12 * 60_000,
    can: () => store.state.workers.length >= 2,
    run: () => {
      store.emitEvent({ type: "office", text: "pizza geldi", data: { kind: "pizza" } });
      for (const w of store.state.workers) store.nudgeMorale(w.id, +10);
      const crowd = idle();
      crowd.slice(0, 2).forEach((w, i) => setTimeout(() => speak(w, PIZZA_LINES[i % PIZZA_LINES.length]), i * 1400));
      store.touch();
    },
  },
  {
    kind: "gossip",
    weight: 5,
    cooldownMs: 70_000,
    can: () => idle().length >= 2,
    run: () => {
      const crowd = idle();
      const a = pick(crowd);
      const b = pick(crowd.filter((w) => w.id !== a.id));
      if (!b) return;
      store.emitEvent({ type: "office", text: "dedikodu", data: { kind: "gossip", from: a.desk, to: b.desk } });
      speak(a, pick(GOSSIP_OPENERS));
      setTimeout(() => {
        const still = store.worker(b.id);
        if (still && still.state === "idle") speak(still, pick(GOSSIP_REPLIES));
      }, 2600);
    },
  },
  {
    kind: "cat",
    weight: 4,
    cooldownMs: 90_000,
    can: () => store.state.workers.length > 0,
    run: () => {
      const w = pick(store.state.workers);
      store.emitEvent({ type: "office", text: "kedi dolaniyor", data: { kind: "cat", desk: w.desk } });
      setTimeout(() => speak(w, pick(CAT_LINES)), 2600);
    },
  },
  {
    kind: "printer",
    weight: 3,
    cooldownMs: 150_000,
    can: () => store.state.workers.length > 0,
    run: () => {
      store.emitEvent({ type: "office", text: "yazici sikisti", data: { kind: "printer" } });
      const crowd = idle();
      if (crowd.length) speak(pick(crowd), pick(PRINTER_LINES));
    },
  },
  {
    kind: "flicker",
    weight: 3,
    cooldownMs: 100_000,
    can: () => true,
    run: () => {
      store.emitEvent({ type: "office", text: "isiklar titredi", data: { kind: "flicker" } });
      const crowd = idle();
      if (crowd.length && Math.random() < 0.5) speak(pick(crowd), "elektrik yine oynadi");
    },
  },
  {
    kind: "sleepy",
    weight: 3,
    cooldownMs: 120_000,
    can: () => idle().length >= 2 && busy().length === 0,
    run: () => {
      const w = pick(idle());
      store.setWorkerState(w.id, "asleep", pick(SLEEPY_LINES));
      store.emitEvent({ type: "office", text: `${w.name} uyuyakaldi`, workerId: w.id, data: { kind: "sleep" } });
    },
  },
];

/** Earned titles. Promotions are the only raise on this floor. */
const LADDER = ["intern", "unpaid intern", "temp", "grunt", "junior", "operator", "specialist", "senior hand", "floor legend"];

function checkCareers() {
  for (const w of store.state.workers) {
    // promotion: consistently good work and decent morale
    const rank = LADDER.indexOf(w.title);
    const earned = Math.floor(w.stats.tasksDone / 5);
    if (rank >= 0 && earned > 0 && rank + earned < LADDER.length && w.morale >= 70) {
      const next = LADDER[Math.min(LADDER.length - 1, rank + 1)];
      if (next !== w.title && w.stats.tasksDone % 5 === 0) {
        w.title = next;
        store.emitEvent({
          type: "office",
          workerId: w.id,
          text: `${w.name} terfi etti: ${next}`,
          data: { kind: "promotion", desk: w.desk },
        });
        speak(w, "sonunda. zam ne zaman?");
        store.nudgeMorale(w.id, +10);
      }
    }
    // people do leave
    if (w.morale <= 0 && w.state === "idle") {
      store.emitEvent({
        type: "office",
        workerId: w.id,
        text: `${w.name} isi birakti`,
        data: { kind: "quit", desk: w.desk },
      });
      store.fire(w.id);
    } else if (w.morale > 0 && w.morale <= 18 && Math.random() < 0.25) {
      speak(w, pick(["boyle giderse birakirim.", "bana biraz saygi.", "cok yoruldum patron."]));
    }
  }
  store.touch();
}

/** Let the boss cause something on purpose (the pizza button). */
export function fireHappening(kind: string): boolean {
  const h = HAPPENINGS.find((x) => x.kind === kind);
  if (!h || !h.can()) return false;
  lastFired.set(h.kind, Date.now());
  h.run();
  return true;
}

export const happeningKinds = () => HAPPENINGS.map((h) => h.kind);

export function startNightLife() {
  // something happens every now and then, never twice in a row too fast
  setInterval(() => {
    const options = HAPPENINGS.filter(
      (h) => h.can() && Date.now() - (lastFired.get(h.kind) ?? 0) > h.cooldownMs,
    );
    if (!options.length) return;
    if (Math.random() > 0.4) return;
    const total = options.reduce((s, h) => s + h.weight, 0);
    let roll = Math.random() * total;
    for (const h of options) {
      roll -= h.weight;
      if (roll <= 0) {
        lastFired.set(h.kind, Date.now());
        h.run();
        break;
      }
    }
  }, 20_000);

  setInterval(checkCareers, 15_000);

  // the 04:00 status report nobody asked for
  setInterval(() => {
    const l = store.state.ledger;
    if (!l.tasksDone && !l.tasksFailed) return;
    store.emitEvent({
      type: "office",
      text: `vardiya raporu: ${l.tasksDone} is bitti, ${l.tasksFailed} yandi, ${(l.tokensIn + l.tokensOut).toLocaleString()} token, $${l.costUsd.toFixed(4)}`,
      data: { kind: "report" },
    });
  }, 10 * 60_000);
}
