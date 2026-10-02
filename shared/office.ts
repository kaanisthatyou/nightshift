// The shape of the office. A room holds up to eight desks in two rows of four;
// an office is as many rooms as you want, laid out left to right, top to bottom,
// each with its own name and its own look. The desk numbers run through the
// whole office, room after room.
import type { OfficeConfig, RoomConfig, RoomTheme } from "./types.ts";

export const DESKS_PER_ROOM = 8;
export const MAX_ROOMS = 8;
export const MAX_DESKS = DESKS_PER_ROOM * MAX_ROOMS;

export const ROOM_THEMES: { id: RoomTheme; name: string; blurb: string }[] = [
  { id: "night", name: "night shift", blurb: "blue carpet, rain on the glass, the original floor" },
  { id: "loft", name: "loft", blurb: "warm boards, brick, lamps left on" },
  { id: "lab", name: "lab", blurb: "cold tile, white light, humming racks" },
  { id: "garden", name: "greenhouse", blurb: "moss carpet, plants on every sill" },
  { id: "arcade", name: "arcade", blurb: "purple dark, neon, somebody's high score" },
];

export interface OfficeLayout {
  id: string;
  name: string;
  blurb: string;
  office: OfficeConfig;
}

const room = (id: string, name: string, desks: number, theme: RoomTheme): RoomConfig => ({ id, name, desks, theme });

export const OFFICE_LAYOUTS: OfficeLayout[] = [
  {
    id: "garage",
    name: "garage",
    blurb: "four desks and a dream",
    office: { name: "the garage", rooms: [room("r1", "garage", 4, "loft")] },
  },
  {
    id: "floor13",
    name: "floor 13",
    blurb: "the original: one room, eight desks",
    office: { name: "floor 13", rooms: [room("r1", "floor 13", 8, "night")] },
  },
  {
    id: "studio",
    name: "studio",
    blurb: "design loft next to an engineering pit - 12 desks",
    office: {
      name: "the studio",
      rooms: [room("r1", "design loft", 4, "loft"), room("r2", "engineering", 8, "night")],
    },
  },
  {
    id: "agency",
    name: "agency",
    blurb: "three teams, three rooms - 20 desks",
    office: {
      name: "the agency",
      rooms: [room("r1", "frontend", 8, "night"), room("r2", "backend", 8, "lab"), room("r3", "design", 4, "garden")],
    },
  },
  {
    id: "campus",
    name: "campus",
    blurb: "a whole building at night - 32 desks",
    office: {
      name: "campus",
      rooms: [
        room("r1", "north wing", 8, "night"),
        room("r2", "lab", 8, "lab"),
        room("r3", "greenhouse", 8, "garden"),
        room("r4", "arcade", 8, "arcade"),
      ],
    },
  },
];

export const DEFAULT_OFFICE: OfficeConfig = OFFICE_LAYOUTS[1].office;

export function deskCount(office: OfficeConfig | null | undefined): number {
  return (office?.rooms ?? []).reduce((n, r) => n + r.desks, 0);
}

/** Which room a global desk index sits in, and where inside that room. */
export function deskInRoom(office: OfficeConfig, desk: number): { room: number; slot: number } | null {
  let base = 0;
  for (let i = 0; i < office.rooms.length; i++) {
    const n = office.rooms[i].desks;
    if (desk < base + n) return { room: i, slot: desk - base };
    base += n;
  }
  return null;
}

/** Anything the window or an API caller sends, made into an office that can be drawn. */
export function normaliseOffice(raw: any): OfficeConfig {
  const themes = new Set(ROOM_THEMES.map((t) => t.id));
  const rooms: RoomConfig[] = (Array.isArray(raw?.rooms) ? raw.rooms : [])
    .slice(0, MAX_ROOMS)
    .map((r: any, i: number) => ({
      id: String(r?.id ?? `r${i + 1}`).slice(0, 24),
      name: String(r?.name ?? `room ${i + 1}`).slice(0, 24),
      desks: Math.max(1, Math.min(DESKS_PER_ROOM, Math.floor(Number(r?.desks) || DESKS_PER_ROOM))),
      theme: themes.has(r?.theme) ? r.theme : "night",
    }));
  if (!rooms.length) return structuredClone(DEFAULT_OFFICE);
  return { name: String(raw?.name ?? "office").slice(0, 40), rooms };
}
