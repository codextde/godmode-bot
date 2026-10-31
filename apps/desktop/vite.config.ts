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

function jsxTags(src: string, names: string[]): string[] {
  const tags: string[] = [];
  for (const m of src.matchAll(new RegExp(`<(?:${names.join("|")})\\b`, "g"))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(src.slice(m.index, i));
  }
  return tags;
}

/** A literal attribute stays as it is; `{t("key")}` becomes "@key", translated in the app. */
const attr = (tag: string, names: string[]) =>
  [...tag.matchAll(new RegExp(`\\s(?:${names.join("|")})=(?:"([^"]+)"|\\{t\\("([\\w.:-]+)"[,)])`, "g"))].map((m) => m[1] ?? `@${m[2]}`);

function settingsSearch(): Plugin {
  const id = "virtual:settings-search";
  const resolved = `\0${id}`;
  const dir = path.resolve(__dirname, "src/components/settings");
  const page = path.resolve(__dirname, "src/pages/settings/settings-page.tsx");
  return {
    name: "godmode-settings-search",
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null;
      const read = (file: string) => {
        this.addWatchFile(file);
        return readFileSync(file, "utf8");
      };
      const scan = (name: string, seen: Set<string>, out: { labels: string[]; text: string[] }) => {
        const file = path.join(dir, `${name}.tsx`);
        if (seen.has(name) || name === "settings-kit" || !existsSync(file)) return out;
        seen.add(name);
        const src = read(file);
        for (const tag of jsxTags(src, ["SettingRow", "SettingsGroup", "SectionHeading"])) out.labels.push(...attr(tag, ["label", "title"]));
        for (const tag of jsxTags(src, ["SettingRow", "SettingsGroup", "SectionHeading", "FeatureSection"])) out.text.push(...attr(tag, ["description", "summary", "title"]));
        for (const m of src.matchAll(/from "(?:\.\/|@\/components\/settings\/)([\w-]+)"/g)) scan(m[1], seen, out);
        return out;
      };
      const pageSrc = read(page);
      const files = new Map([...pageSrc.matchAll(/import \{ (\w+) \} from "@\/components\/settings\/([\w-]+)"/g)].map((m) => [m[1], m[2]] as const));
      const index: Record<string, { labels: string[]; text: string[] }> = {};
      for (const [, section, component] of pageSrc.matchAll(/"?([\w-]+)"?: \(\) => <(\w+)/g)) {
        const file = files.get(component);
        if (!file) continue;
        const { labels, text } = scan(file, new Set(), { labels: [], text: [] });
        index[section] = { labels: [...new Set(labels)], text: [...new Set(text)] };
      }
      return `export default ${JSON.stringify(index)};`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), devToken(), settingsSearch()],
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
