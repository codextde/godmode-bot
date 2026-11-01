import type { FolderListing } from "@godmode/shared";
import { HttpError, badRequest } from "../util";
import { SshError, shellPath, shellQuote } from "./client";
import { useServer } from "./service";

const LIMIT = 1000;

export function listingScript(path: string | undefined, hidden: boolean): string {
  const target = path ? shellPath(path) : '"$HOME"';
  const globs = hidden ? "* .[!.]* ..?*" : "*";
  return `cd ${target} 2>/dev/null || exit 3
printf 'home:%s\\n' "$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
printf 'path:%s\\n' "$(pwd -P)"
n=0
for d in ${globs}; do
  [ -d "$d" ] || continue
  if [ "$n" -ge ${LIMIT} ]; then echo more; break; fi
  if [ -e "$d/.git" ]; then g=1; else g=0; fi
  printf 'd:%s:%s\\n' "$g" "$d"
  n=$((n + 1))
done`;
}

export function parseListing(stdout: string): FolderListing | null {
  const lines = stdout.split("\n");
  const home = lines.find((l) => l.startsWith("home:"))?.slice(5);
  const path = lines.find((l) => l.startsWith("path:"))?.slice(5);
  if (!home?.startsWith("/") || !path?.startsWith("/")) return null;
  const join = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);
  const entries = lines
    .filter((l) => l.startsWith("d:"))
    .map((l) => ({ git: l[2] === "1", name: l.slice(4) }))
    .filter((e) => e.name && e.name !== "." && e.name !== "..")
    .map((e) => ({ name: e.name, path: join(e.name), git: e.git, blocked: false }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  return { path, parent, home, roots: ["/"], blocked: null, entries, truncated: lines.includes("more") };
}

export async function listServerFolders(id: string, path: string | undefined, hidden: boolean): Promise<FolderListing> {
  const wanted = path?.trim() || undefined;
  if (wanted && (!/^(\/|~$|~\/)/.test(wanted) || /[\0\n]/.test(wanted))) throw badRequest("Use a folder like ~/code or /srv/app.");
  try {
    const res = await useServer(id, (conn) => conn.exec(`sh -c ${shellQuote(listingScript(wanted, hidden))}`, { timeoutMs: 20_000 }));
    if (res.exitCode === 3) throw new HttpError(404, `There is no folder ${wanted} on the server.`, "not_found");
    const listing = parseListing(res.stdout);
    if (!listing) throw new HttpError(502, res.stderr.trim().slice(0, 300) || "The server didn't list its folders.", "ssh_command");
    return listing;
  } catch (err) {
    if (err instanceof SshError) throw new HttpError(502, err.message, `ssh_${err.stage.replace("-", "_")}`);
    throw err;
  }
}

