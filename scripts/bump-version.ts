#!/usr/bin/env bun
// Sets the version everywhere a release reads it: bun scripts/bump-version.ts 0.2.4
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/bump-version.ts <version>, e.g. 0.2.4");
  process.exit(1);
}

const places: [file: string, pattern: RegExp][] = [
  ["package.json", /("version": ")[^"]+/],
  ["apps/desktop/package.json", /("version": ")[^"]+/],
  ["packages/core/package.json", /("version": ")[^"]+/],
  ["apps/cloud/package.json", /("version": ")[^"]+/],
  ["apps/website/package.json", /("version": ")[^"]+/],
  ["packages/core/src/config.ts", /(export const VERSION = ")[^"]+/],
  ["apps/desktop/src-tauri/Cargo.toml", /(^version = ")[^"]+/m],
  ["apps/desktop/src-tauri/Cargo.lock", /(name = "godmode-bot"\r?\nversion = ")[^"]+/],
  [".github/ISSUE_TEMPLATE/bug_report.yml", /(placeholder: ")\d+\.\d+\.\d+[^"]*/],
];

for (const [file, pattern] of places) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) {
    console.error(`${file}: no version found`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(pattern, `$1${version}`));
}

console.log(`Version set to ${version} in ${places.length} files.`);
console.log(`Commit and push to main, then: git tag -a v${version} -m "Godmode Bot v${version}" && git push origin v${version}`);
