#!/usr/bin/env bun
// The release page's download table and SHA256SUMS, built from the release's assets (GitHub API JSON).
//   bun scripts/release-downloads.ts notes <tag> <assets.json> <body.md>   prints the body with the table on top
//   bun scripts/release-downloads.ts sums <assets.json>                    prints SHA256SUMS
import { readFileSync } from "node:fs";

export type Asset = { name: string; digest?: string | null };

const REPO = "codextde/godmode-bot";
const START = "<!-- downloads -->";
const END = "<!-- /downloads -->";

type Link = [label: string, match: RegExp];
type Row = { arch: string; macos: Link[]; windows: Link[]; linux: Link[]; server: Link[]; docker?: boolean };

const ROWS: Row[] = [
  {
    arch: "ARM64 (Apple silicon)",
    macos: [["DMG", /_aarch64\.dmg$/]],
    windows: [["EXE", /_arm64-setup\.exe$/], ["MSI", /_arm64_en-US\.msi$/]],
    linux: [["AppImage", /_aarch64\.AppImage$/], ["DEB", /_arm64\.deb$/], ["RPM", /\.aarch64\.rpm$/]],
    server: [["macOS", /^godmode-darwin-arm64$/], ["Linux", /^godmode-linux-arm64$/]],
    docker: true,
  },
  {
    arch: "x86-64 (64-bit)",
    macos: [["DMG", /_x64\.dmg$/]],
    windows: [["EXE", /_x64-setup\.exe$/], ["MSI", /_x64_en-US\.msi$/]],
    linux: [["AppImage", /_amd64\.AppImage$/], ["DEB", /_amd64\.deb$/], ["RPM", /\.x86_64\.rpm$/]],
    server: [["macOS", /^godmode-darwin-x64$/], ["Linux", /^godmode-linux-x64$/], ["Windows", /^godmode-windows-x64\.exe$/]],
    docker: true,
  },
  {
    arch: "x86-64 without AVX2",
    macos: [],
    windows: [],
    linux: [],
    server: [["Linux", /^godmode-linux-x64-baseline$/]],
  },
];

const url = (tag: string, name: string) => `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;

function cell(tag: string, assets: Asset[], links: Link[]): string {
  return links
    .map(([label, match]) => {
      const asset = assets.find((a) => match.test(a.name));
      return asset ? `[${label}](${url(tag, asset.name)})` : null;
    })
    .filter(Boolean)
    .join(" · ");
}

export function downloadTable(tag: string, assets: Asset[]): string {
  const version = tag.replace(/^v/, "");
  const docker = `[Image](https://github.com/${REPO}/pkgs/container/godmode-bot)`;
  const rows = ROWS.map((r) => [cell(tag, assets, r.macos), cell(tag, assets, r.windows), cell(tag, assets, r.linux), cell(tag, assets, r.server)])
    .map((cells, i) => (cells.some(Boolean) ? [ROWS[i]!.arch, ...cells, ROWS[i]!.docker ? docker : ""] : null))
    .filter((cells) => cells !== null);
  const lines = [
    START,
    "## Download",
    "",
    "| Architecture | macOS | Windows | Linux | Server | Docker |",
    "|---|---|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    "Not sure? Macs with an M chip (M1 and newer) take **ARM64**, almost every Windows and Linux PC takes **x86-64**. Installed apps update themselves.",
    "",
    `Server: \`curl -fsSL https://usegodmode.com/install.sh | GODMODE_LICENSE=GM-… sh\` or \`docker pull ghcr.io/${REPO}:${version}\`. Checksums: ${
      assets.some((a) => a.name === "SHA256SUMS") ? `[SHA256SUMS](${url(tag, "SHA256SUMS")})` : "SHA256SUMS"
    }.`,
    END,
  ];
  return lines.join("\n");
}

/** The release body with the download table on top, replacing an older one. */
export function withDownloadTable(body: string, tag: string, assets: Asset[]): string {
  const rest = stripDownloadTable(body).trim();
  return `${downloadTable(tag, assets)}\n\n${rest}\n`;
}

export function stripDownloadTable(body: string): string {
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start < 0 || end < start) return body;
  return body.slice(0, start) + body.slice(end + END.length);
}

/** Files a person downloads: no signatures (they are inside latest.json), no checksum files. */
const downloadable = (name: string) => name !== "latest.json" && name !== "SHA256SUMS" && !/\.(sig|sha256)$/.test(name);

export function sha256sums(assets: Asset[]): string {
  const files = assets.filter((a) => downloadable(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  const missing = files.filter((a) => !/^sha256:[0-9a-f]{64}$/.test(a.digest ?? ""));
  if (missing.length) throw new Error(`no sha256 digest for ${missing.map((a) => a.name).join(", ")}`);
  return files.map((a) => `${a.digest!.slice(7)}  ${a.name}\n`).join("");
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const read = (path: string) => readFileSync(path, "utf8");
  if (command === "notes" && args.length === 3) {
    process.stdout.write(withDownloadTable(read(args[2]!), args[0]!, JSON.parse(read(args[1]!))));
  } else if (command === "sums" && args.length === 1) {
    process.stdout.write(sha256sums(JSON.parse(read(args[0]!))));
  } else {
    console.error("usage: release-downloads.ts notes <tag> <assets.json> <body.md> | sums <assets.json>");
    process.exit(2);
  }
}
