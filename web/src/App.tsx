import { useEffect } from "react";
import TopBar from "./components/TopBar.tsx";
import FloorCanvas from "./components/FloorCanvas.tsx";
import OrderBar from "./components/OrderBar.tsx";
import Rail from "./components/Rail.tsx";
import Ticker from "./components/Ticker.tsx";
import TaskModal from "./components/TaskModal.tsx";
import Whiteboard from "./components/Whiteboard.tsx";
import { onFloorEvent, useFloor } from "./store.ts";

export default function App() {
  const setTab = useFloor((s) => s.setTab);
  const openTaskPanel = useFloor((s) => s.openTaskPanel);
  const openWhiteboard = useFloor((s) => s.openWhiteboard);

  // work landing in the tray should pull your eye to the board
  useEffect(() => {
    return onFloorEvent((e) => {
      if (e.type === "worker.fail") setTab("board");
    });
  }, [setTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the task sheet sits on top of the board, so it closes first
      if (useFloor.getState().openTask) openTaskPanel(null);
      else openWhiteboard(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTaskPanel, openWhiteboard]);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <div className="floor-wrap">
          <FloorCanvas />
          <OrderBar />
        </div>
        <Rail />
      </div>
      <Ticker />
      <Whiteboard />
      <TaskModal />
    </div>
  );
}
