import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  build: {
    outDir: "../backend/aonote/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/oauth": "http://127.0.0.1:8000",
      "/mcp": "http://127.0.0.1:8000",
    },
  },
});
