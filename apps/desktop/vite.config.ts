import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const CORE_URL = process.env.GODMODE_CORE_URL ?? "http://127.0.0.1:7777";

/** In dev, hand the core access token to the UI so you don't have to log in. */
function devToken(): string {
  const home = process.env.GODMODE_HOME ?? path.join(homedir(), ".godmode");
  const file = path.join(home, "access-token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  define: {
    __DEV_TOKEN__: JSON.stringify(command === "serve" ? devToken() : ""),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: CORE_URL, changeOrigin: false, ws: true },
      // Automation webhooks, so URLs copied from the dev UI reach the core.
      "/hooks": { target: CORE_URL, changeOrigin: false },
    },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
}));
