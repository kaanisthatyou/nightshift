import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The floor server owns /api and /ws; vite just serves the window into it.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:20200",
      "/ws": { target: "ws://localhost:20200", ws: true },
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
