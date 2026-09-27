#!/usr/bin/env bun
/**
 * Regenerates every app icon from docs/assets/logo.svg.
 *
 *   bun scripts/icons.ts            (or: pnpm icons)
 *
 * 1. Rasterizes the logo to a 1024px PNG laid out on Apple's icon grid (824px artwork, 100px margin) using
 *    resvg (WASM), which is fetched into a temporary directory so it never becomes a project dependency.
 * 2. Runs `tauri icon` to produce the full desktop set (icns, ico, PNG sizes) in apps/desktop/src-tauri/icons.
 * 3. Renders the tray icons: a white bolt on transparent (macOS template image; 32px + 64px @2x).
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RESVG_VERSION = "2.6.2";
const root = resolve(import.meta.dir, "..");
const logoPath = join(root, "docs/assets/logo.svg");
const iconsDir = join(root, "apps/desktop/src-tauri/icons");

// The logo's rounded square spans 16..496 of its 512 viewBox. Apple's grid wants it at 824/1024 → widen the viewBox.
const APP_ICON_VIEWBOX = (() => {
  const unitsPerPx = 480 / 824;
  const size = 1024 * unitsPerPx;
  const origin = 256 - size / 2;
  return `${origin.toFixed(3)} ${origin.toFixed(3)} ${size.toFixed(3)} ${size.toFixed(3)}`;
})();

// The bolt from the logo (bbox x 158..354, y 92..420) on a square viewBox centred on it.
const TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="78 80 356 356">
  <path d="M283 92 158 288h86l-22 132 132-204h-88l17-124Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="14" stroke-linejoin="round"/>
</svg>`;

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
}

const work = mkdtempSync(join(tmpdir(), "godmode-icons-"));
try {
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "godmode-icons", private: true }));
  run(["bun", "add", "--silent", `@resvg/resvg-wasm@${RESVG_VERSION}`], work);
  const pkg = join(work, "node_modules/@resvg/resvg-wasm");
  const { initWasm, Resvg } = (await import(join(pkg, "index.mjs"))) as {
    initWasm(wasm: Uint8Array): Promise<void>;
    Resvg: new (svg: string, opts: object) => { render(): { asPng(): Uint8Array } };
  };
  await initWasm(readFileSync(join(pkg, "index_bg.wasm")));

  const render = (svg: string, width: number) =>
    new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "rgba(0,0,0,0)" }).render().asPng();

  const logo = readFileSync(logoPath, "utf8").replace(/viewBox="[^"]*"/, `viewBox="${APP_ICON_VIEWBOX}"`);
  const source = join(work, "icon-1024.png");
  writeFileSync(source, render(logo, 1024));

  run(["pnpm", "tauri", "icon", source, "--output", iconsDir], join(root, "apps/desktop"));
  // Desktop-only app: drop the mobile sets `tauri icon` always emits.
  for (const dir of ["android", "ios"]) rmSync(join(iconsDir, dir), { recursive: true, force: true });

  writeFileSync(join(iconsDir, "tray.png"), render(TRAY_SVG, 32));
  writeFileSync(join(iconsDir, "tray@2x.png"), render(TRAY_SVG, 64));

  for (const f of ["icon.icns", "icon.ico", "icon.png", "32x32.png", "128x128.png", "128x128@2x.png", "tray.png", "tray@2x.png"]) {
    if (!existsSync(join(iconsDir, f))) throw new Error(`missing generated icon ${f}`);
  }
  console.log(`icons written to ${iconsDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
