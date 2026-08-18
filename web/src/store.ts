// One socket, one store. The scene reads it, the panels read it.
import { create } from "zustand";
import type { FloorEvent, FloorState, ModelInfo, ServerMessage } from "../../shared/types.ts";
import type { CrewPreset, Temper } from "../../shared/presets.ts";

export type Tab = "crew" | "plan" | "board" | "build" | "arena" | "wire" | "mains";

interface UI {
  state: FloorState | null;
  models: ModelInfo[];
  log: FloorEvent[];
  connected: boolean;
  selected: string | null;
  tab: Tab;
  openTask: string | null;
  /** "new" opens a blank whiteboard; a plan id opens that plan; null closes it */
  whiteboard: string | null;
  /** text carried over when you send an order to the whiteboard instead of a desk */
  seedIdea: string;
  presets: CrewPreset[];
  tempers: Temper[];
  /** live streamed text per task while a desk is typing */
  streams: Record<string, string>;
  setTab: (t: Tab) => void;
  select: (id: string | null) => void;
  openTaskPanel: (id: string | null) => void;
  openWhiteboard: (id: string | null, idea?: string) => void;
}

export const useFloor = create<UI>((set) => ({
  state: null,
  models: [],
  log: [],
  connected: false,
  selected: null,
  tab: "crew",
  openTask: null,
  whiteboard: null,
  seedIdea: "",
  presets: [],
  tempers: [],
  streams: {},
  setTab: (t) => set({ tab: t }),
  select: (id) => set({ selected: id }),
  openTaskPanel: (id) => set({ openTask: id }),
  openWhiteboard: (id, idea) => set({ whiteboard: id, ...(idea !== undefined ? { seedIdea: idea } : {}) }),
}));

/** The catalog never changes while the server is up, so it is fetched once. */
export async function loadPresets() {
  try {
    const r = await api<{ presets: CrewPreset[]; tempers: Temper[] }>("/presets");
    useFloor.setState({ presets: r.presets ?? [], tempers: r.tempers ?? [] });
  } catch {
    /* the catalog is cosmetic until you use it */
  }
}

type EventHook = (e: FloorEvent) => void;
const hooks: EventHook[] = [];
export function onFloorEvent(fn: EventHook) {
  hooks.push(fn);
  return () => {
    const i = hooks.indexOf(fn);
    if (i >= 0) hooks.splice(i, 1);
  };
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const patch = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

let socket: WebSocket | null = null;
let retry = 0;

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => {
    retry = 0;
    useFloor.setState({ connected: true });
  };
  socket.onclose = () => {
    useFloor.setState({ connected: false });
    retry = Math.min(6, retry + 1);
    setTimeout(connect, 400 * retry);
  };
  socket.onerror = () => socket?.close();
  socket.onmessage = (ev) => {
    const msg: ServerMessage = JSON.parse(ev.data);
    if (msg.type === "hello") {
      useFloor.setState({ state: msg.state, models: msg.models });
      api("/state").then((s: any) => useFloor.setState({ log: s.log ?? [] })).catch(() => {});
      if (!useFloor.getState().presets.length) void loadPresets();
    } else if (msg.type === "state") {
      useFloor.setState({ state: msg.state });
    } else if (msg.type === "models") {
      useFloor.setState({ models: msg.models });
    } else if (msg.type === "event") {
      const e = msg.event;
      useFloor.setState((s) => {
        const log = [...s.log, e].slice(-250);
        if (e.type === "worker.chunk" && e.taskId) {
          const streams = { ...s.streams, [e.taskId]: (s.streams[e.taskId] ?? "") + (e.text ?? "") };
          return { log, streams };
        }
        if (e.type === "worker.start" && e.taskId) {
          return { log, streams: { ...s.streams, [e.taskId]: "" } };
        }
        return { log };
      });
      for (const h of hooks) h(e);
    }
  };
}
