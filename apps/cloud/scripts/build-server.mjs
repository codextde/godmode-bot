/**
 * Bundles the custom server (server/main.ts) into dist/server.mjs. Dependencies stay external (node_modules), the
 * workspace's TypeScript sources are bundled in.
 *
 * Code under src/server and server/ runs in this bundle in plain Node, where `next/…` subpaths and React do not
 * resolve (tsx hides that in development). The build fails when anything bundled imports them, except main.ts's own
 * `import next from "next"`.
 */
import path from "node:path";
import { build } from "esbuild";

const app = path.resolve(import.meta.dirname, "..");
const root = path.resolve(app, "../..");
const entry = "server/main.ts";

const result = await build({
  absWorkingDir: app,
  entryPoints: [entry],
  outfile: path.join(app, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  tsconfig: path.join(app, "tsconfig.json"),
  alias: { "@godmode/shared": path.join(root, "packages/shared/src/index.ts") },
  metafile: true,
  logLevel: "warning",
});

const FORBIDDEN = /^(next\/|react($|\/)|react-dom($|\/)|server-only$|client-only$)/;
const problems = [];
for (const [file, input] of Object.entries(result.metafile.inputs)) {
  for (const imported of input.imports) {
    if (!imported.external) continue;
    const allowed = file === entry && imported.path === "next";
    if (!allowed && (FORBIDDEN.test(imported.path) || imported.path === "next")) problems.push(`${file} imports "${imported.path}"`);
  }
}
if (problems.length) {
  console.error("build-server: the custom server bundle must not import Next or React modules:");
  for (const line of problems) console.error(`  ${line}`);
  console.error("Move that code to src/lib or src/app (see .omc/plans/cloud-spec-amendments.md, A.2).");
  process.exit(1);
}
const size = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`build-server: dist/server.mjs (${Math.round(size / 1024)} kB)`);
