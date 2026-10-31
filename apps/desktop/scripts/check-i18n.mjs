#!/usr/bin/env node
// Checks the translations: every language has the same keys and placeholders as English.
// `--scan [paths...]` also lists UI text that is still hard-coded in the source (exit 1 with --strict).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = path.join(root, "src/i18n/locales");
const args = process.argv.slice(2);
const PLURAL = /_(zero|one|two|few|many|other)$/;

const flatten = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const placeholders = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)[^}]*\}\}|<(\d+|\w+)\s*\/?>/g)].map((m) => m[1] ?? `<${m[2]}>`).sort().join(",");

let problems = 0;
const fail = (msg) => {
  problems++;
  console.error(`  ${msg}`);
};

const languages = readdirSync(localesDir).filter((d) => statSync(path.join(localesDir, d)).isDirectory());
const base = "en";
for (const file of readdirSync(path.join(localesDir, base)).filter((f) => f.endsWith(".json"))) {
  const load = (lng) => {
    try {
      return flatten(JSON.parse(readFileSync(path.join(localesDir, lng, file), "utf8")));
    } catch (e) {
      fail(`${lng}/${file}: ${e.message}`);
      return null;
    }
  };
  const en = load(base);
  if (!en) continue;
  for (const lng of languages.filter((l) => l !== base)) {
    const other = load(lng);
    if (!other) continue;
    const stem = (k) => k.replace(PLURAL, "");
    const enStems = new Set(Object.keys(en).map(stem));
    const otherStems = new Set(Object.keys(other).map(stem));
    for (const k of enStems) if (!otherStems.has(k)) fail(`${lng}/${file}: missing "${k}"`);
    for (const k of otherStems) if (!enStems.has(k)) fail(`${lng}/${file}: extra "${k}" (not in en)`);
    for (const [k, v] of Object.entries(other)) {
      if (typeof v === "string" && !v.trim()) fail(`${lng}/${file}: empty "${k}"`);
      const enValue = en[k] ?? en[`${stem(k)}_other`] ?? en[stem(k)];
      if (enValue === undefined) continue;
      if (placeholders(enValue) !== placeholders(v)) fail(`${lng}/${file}: placeholders differ in "${k}" (en: ${placeholders(enValue) || "none"}, ${lng}: ${placeholders(v) || "none"})`);
    }
  }
  for (const [k, v] of Object.entries(en)) if (typeof v === "string" && !v.trim()) fail(`en/${file}: empty "${k}"`);
}

if (args.includes("--scan")) {
  const targets = args.filter((a) => !a.startsWith("--"));
  const roots = (targets.length ? targets : ["src"]).map((t) => path.resolve(process.cwd(), t));
  const files = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(path.join(p, f));
    else if (/\.tsx?$/.test(p) && !p.endsWith(".d.ts") && !/^src\/(i18n|components\/ui)\//.test(path.relative(root, p))) files.push(p);
  };
  roots.forEach(walk);
  const looksLikeText = (s) => /^[A-Z][a-z]+/.test(s) || /\b[a-z]{3,}\s+[a-z]{2,}\b/.test(s);
  const ignoreText = /^(Godmode( Bot)?|Claude( Code)?|GitHub|Google|macOS|Windows|Linux|OpenAI|ElevenLabs|Tauri|Chrome|Telegram|Slack|WhatsApp|Discord|Composio|Anthropic|iPhone|Android|SSH|VNC|API|URL|JSON|MCP|OK)$/;
  const patterns = [
    [/>\s*([^<>{}\n]*[A-Za-z]{3,}[^<>{}\n]*?)\s*</g, 1],
    [/\s(?:title|label|placeholder|description|aria-label|summary|hint|tooltip|alt)="([^"]{3,})"/g, 1],
    [/\btoast(?:\.\w+)?\(\s*["'`]([^"'`]{3,})["'`]/g, 1],
    [/\b(?:title|label|description|placeholder|summary|hint|message|blurb|empty|text):\s*["'`]([^"'`]*[a-z]{3,}[^"'`]*)["'`]/g, 1],
  ];
  const report = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const hits = [];
    for (const [re, group] of patterns) {
      for (const m of src.matchAll(re)) {
        const text = m[group].trim();
        if (!text || ignoreText.test(text) || !looksLikeText(text)) continue;
        if (/^(className|import|export|const|return)\b/.test(text) || /[=;]\s*$/.test(text) || /^\W+$/.test(text) || /&&|\|\||=>/.test(text)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        if (/i18n-ignore/.test(lines[line - 1] ?? "") || /i18n-ignore/.test(lines[line - 2] ?? "")) continue;
        hits.push(`${line}: ${text.slice(0, 90)}`);
      }
    }
    if (hits.length) report.push([path.relative(process.cwd(), file), hits]);
  }
  report.sort((a, b) => b[1].length - a[1].length);
  let total = 0;
  for (const [file, hits] of report) {
    total += hits.length;
    console.log(`${file} (${hits.length})`);
    if (args.includes("--verbose")) for (const h of hits) console.log(`    ${h}`);
  }
  console.log(`\n${total} possibly hard-coded strings in ${report.length} files`);
  if (args.includes("--strict") && total) problems += total;
}

if (problems) {
  console.error(`\ni18n check failed: ${problems} problem(s)`);
  process.exit(1);
}
console.log(`i18n check passed (${languages.join(", ")})`);
