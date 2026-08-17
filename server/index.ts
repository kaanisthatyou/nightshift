// NIGHTSHIFT floor server: state, gateway, sockets.
import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { api } from "./routes.ts";
import { store } from "./store.ts";
import { gateway, startEngine } from "./engine.ts";
import { mcp } from "./mcp.ts";
import { startNightLife } from "./nightlife.ts";
import type { FloorEvent, ServerMessage } from "../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 20200);

store.load();
mcp.load();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", api);

const dist = path.resolve(__dirname, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const clients = new Set<WebSocket>();
function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}

wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { type: "hello", state: store.state, models: gateway.models });
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

// State goes out on a leash; events go out immediately.
let statePending = false;
store.on("state", () => {
  if (statePending) return;
  statePending = true;
  setTimeout(() => {
    statePending = false;
    broadcast({ type: "state", state: store.state });
  }, 120);
});
store.on("event", (event: FloorEvent) => broadcast({ type: "event", event }));

server.listen(PORT, async () => {
  console.log(`\n  NIGHTSHIFT floor listening on http://localhost:${PORT}`);
  store.state.gateway = await gateway.refresh();
  if (store.state.gateway.online) {
    console.log(`  gateway: ${gateway.config.baseUrl} - ${gateway.models.length} models (${gateway.models.filter((m) => m.free).length} free)`);
    broadcast({ type: "models", models: gateway.models });
  } else {
    console.log(`  gateway: offline (${store.state.gateway.error}) - running in ghost mode`);
  }
  store.touch();
  startEngine();
  startNightLife();

  // MCP servers come up after the floor does - a slow one must not hold the port
  if (mcp.configs.length) {
    void mcp.openAll().then(() => {
      const up = mcp.statuses().filter((s) => s.online);
      const tools = up.reduce((n, s) => n + s.toolCount, 0);
      console.log(`  toolbox: ${up.length}/${mcp.configs.length} servers, ${tools} tools`);
      for (const s of mcp.statuses()) {
        if (!s.online && s.enabled) console.log(`    ${s.name}: ${s.error ?? "offline"}`);
      }
    });
  }
});

// stdio servers are our children - do not leave them running
const shutdown = () => { mcp.closeAll(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
