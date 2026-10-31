import { createHighlighter } from "@tanstack/highlight/core";
import { createThemeCss } from "@tanstack/highlight/theme";
import { githubDarkTheme } from "@tanstack/highlight/themes/github-dark";
import { githubLightTheme } from "@tanstack/highlight/themes/github-light";
import { c } from "@tanstack/highlight/languages/c";
import { clojure } from "@tanstack/highlight/languages/clojure";
import { cpp } from "@tanstack/highlight/languages/cpp";
import { csharp } from "@tanstack/highlight/languages/csharp";
import { css } from "@tanstack/highlight/languages/css";
import { dart } from "@tanstack/highlight/languages/dart";
import { diff } from "@tanstack/highlight/languages/diff";
import { dockerfile } from "@tanstack/highlight/languages/dockerfile";
import { elixir } from "@tanstack/highlight/languages/elixir";
import { erlang } from "@tanstack/highlight/languages/erlang";
import { go } from "@tanstack/highlight/languages/go";
import { graphql } from "@tanstack/highlight/languages/graphql";
import { haskell } from "@tanstack/highlight/languages/haskell";
import { html } from "@tanstack/highlight/languages/html";
import { ini } from "@tanstack/highlight/languages/ini";
import { java } from "@tanstack/highlight/languages/java";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { jsx } from "@tanstack/highlight/languages/jsx";
import { julia } from "@tanstack/highlight/languages/julia";
import { kotlin } from "@tanstack/highlight/languages/kotlin";
import { less } from "@tanstack/highlight/languages/less";
import { lua } from "@tanstack/highlight/languages/lua";
import { makefile } from "@tanstack/highlight/languages/makefile";
import { nix } from "@tanstack/highlight/languages/nix";
import { php } from "@tanstack/highlight/languages/php";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import { powershell } from "@tanstack/highlight/languages/powershell";
import { properties } from "@tanstack/highlight/languages/properties";
import { protobuf } from "@tanstack/highlight/languages/protobuf";
import { python } from "@tanstack/highlight/languages/python";
import { r } from "@tanstack/highlight/languages/r";
import { ruby } from "@tanstack/highlight/languages/ruby";
import { rust } from "@tanstack/highlight/languages/rust";
import { scala } from "@tanstack/highlight/languages/scala";
import { scss } from "@tanstack/highlight/languages/scss";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { svelte } from "@tanstack/highlight/languages/svelte";
import { swift } from "@tanstack/highlight/languages/swift";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";
import { vue } from "@tanstack/highlight/languages/vue";
import { yaml } from "@tanstack/highlight/languages/yaml";

const highlighter = createHighlighter({
  languages: [c, clojure, cpp, csharp, css, dart, diff, dockerfile, elixir, erlang, go, graphql, haskell, html, ini, java, js, json, jsx, julia, kotlin, less, lua, makefile, nix, php, plaintext, powershell, properties, protobuf, python, r, ruby, rust, scala, scss, shell, sql, svelte, swift, toml, ts, tsx, vue, yaml],
});

const BY_EXTENSION: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx", json: "json", jsonc: "json", lock: "plaintext",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "html", svg: "html", vue: "vue", svelte: "svelte",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", gradle: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell", sql: "sql", graphql: "graphql", gql: "graphql",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
  diff: "diff", patch: "diff", proto: "protobuf", dart: "dart", scala: "scala", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", clj: "clojure", r: "r", jl: "julia", nix: "nix", tf: "ini",
};

const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby", procfile: "shell" };

export function languageOf(name: string): string {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1];
  return (ext && BY_EXTENSION[ext]) || "plaintext";
}

export function highlightCode(code: string, lang: string, line: number | null): string {
  return highlighter.highlightToHtml(code, {
    lang,
    lineNumbers: true,
    ...(line ? { decorations: [{ lines: line, className: "gm-code-hit" }] } : {}),
  });
}

export const codeThemeCss = createThemeCss({
  light: githubLightTheme,
  dark: githubDarkTheme,
  lightSelector: ".gm-code-view",
  darkSelector: ".dark .gm-code-view",
  codeBlockSelector: ".gm-code-view pre.th-code",
  lineNumbersSelector: ".gm-code-view .th-code--line-numbers",
});
