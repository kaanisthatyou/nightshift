import { useEffect, useRef, useState } from "react";
import { FloorScene } from "../pixel/scene.ts";
import { onFloorEvent, post, useFloor } from "../store.ts";

const POKES = [
  "herkes calisiyor mu?",
  "sessizlik hosuma gitmedi.",
  "vardiya bitmedi.",
  "kahve icen gorursem...",
];

export default function FloorCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FloorScene | null>(null);
  const state = useFloor((s) => s.state);
  const selected = useFloor((s) => s.selected);
  const select = useFloor((s) => s.select);
  const setTab = useFloor((s) => s.setTab);
  const openTaskPanel = useFloor((s) => s.openTaskPanel);
  const [zoom, setZoom] = useState(3);

  useEffect(() => {
    if (!ref.current) return;
    const scene = new FloorScene(ref.current);
    sceneRef.current = scene;

    scene.onSelect = (id) => {
      select(id);
      if (id) setTab("roster");
    };
    scene.onDeskOpen = (id) => {
      const s = useFloor.getState().state;
      const w = s?.workers.find((x) => x.id === id);
      const task =
        s?.tasks.find((t) => t.id === w?.currentTaskId) ??
        [...(s?.tasks ?? [])].reverse().find((t) => t.workerId === id);
      if (task) openTaskPanel(task.id);
      else setTab("roster");
    };
    scene.onTray = () => setTab("board");
    scene.onEmptyDesk = () => setTab("roster");
    scene.onBossPoke = () => {
      void post("/boss/say", { text: POKES[Math.floor(Math.random() * POKES.length)] });
    };
    scene.onZoom = (z) => setZoom(z);

    scene.fit();
    scene.start();
    const off = onFloorEvent((e) => scene.event(e));

    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const step = 28;
      if (e.key === "ArrowLeft") scene.panBy(-step, 0);
      else if (e.key === "ArrowRight") scene.panBy(step, 0);
      else if (e.key === "ArrowUp") scene.panBy(0, -step);
      else if (e.key === "ArrowDown") scene.panBy(0, step);
      else if (e.key === "+" || e.key === "=") scene.zoomBy(1);
      else if (e.key === "-" || e.key === "_") scene.zoomBy(-1);
      else if (e.key === "0") scene.fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      off();
      scene.destroy();
      sceneRef.current = null;
    };
  }, [select, setTab, openTaskPanel]);

  useEffect(() => {
    if (state && sceneRef.current) sceneRef.current.sync(state);
  }, [state]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.selected = selected;
  }, [selected]);

  const workers = state?.workers.length ?? 0;
  const busy = state?.workers.filter((w) => w.state === "typing" || w.state === "thinking").length ?? 0;

  return (
    <div className="stage">
      <canvas ref={ref} className="floor" />
      <div className="crt" />
      <div className="stage-tag">
        FLOOR 13 // {workers} desks staffed // {busy} working
        {state && !state.gateway.online ? " // GHOST SHIFT" : ""}
      </div>
      <div className="camera">
        <button className="btn mini" title="zoom out (-)" onClick={() => sceneRef.current?.zoomBy(-1)}>
          −
        </button>
        <span className="zoom">{zoom}×</span>
        <button className="btn mini" title="zoom in (+)" onClick={() => sceneRef.current?.zoomBy(1)}>
          +
        </button>
        <button className="btn mini" title="fit the room (0 / double-click the floor)" onClick={() => sceneRef.current?.fit()}>
          fit
        </button>
      </div>
      <div className="stage-help">drag to walk the floor · wheel to zoom · click a desk · double-click to read its work</div>
    </div>
  );
}
