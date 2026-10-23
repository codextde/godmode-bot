import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const CORE_URL = process.env.GODMODE_CORE_URL ?? "http://127.0.0.1:7777";

function readDevToken(): string {
  const home = process.env.GODMODE_HOME ?? path.join(homedir(), ".godmode");
  const file = path.join(home, "access-token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

/**
 * In dev, hand the core access token to the UI so you don't have to log in. Read on every page load, not when Vite
 * starts: on the first `pnpm dev` the core writes the token file a moment after Vite has read its config.
 */
function devToken(): Plugin {
  return {
    name: "godmode-dev-token",
    apply: "serve",
    transformIndexHtml: () => [
      { tag: "script", children: `window.__DEV_TOKEN__ = ${JSON.stringify(readDevToken()).replace(/</g, "\\u003c")};`, injectTo: "head-prepend" },
    ],
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), devToken()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
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
