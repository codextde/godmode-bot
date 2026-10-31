/**
 * Stands in for `npm install <pkg>@<version>`: copies FAKE_NPM_PACKAGES/<pkg>@<version>/ to node_modules/<pkg>/ of the
 * current folder and records the arguments in FAKE_NPM_PACKAGES/calls.jsonl. An unknown package fails like npm does.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.FAKE_NPM_PACKAGES!;
const args = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const spec = args[1] ?? "";
const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const from = join(root, spec);
if (args[0] !== "install" || at <= 0 || !existsSync(from)) {
  process.stderr.write(`npm error 404 Not Found - GET https://registry.npmjs.org/${name}\n`);
  process.exit(1);
}
const to = join(process.cwd(), "node_modules", ...name.split("/"));
mkdirSync(join(to, ".."), { recursive: true });
cpSync(from, to, { recursive: true });
