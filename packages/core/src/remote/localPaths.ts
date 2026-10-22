/**
 * Paths in an automation's prompt that name another computer's home folder (written on the primary of a device group,
 * run on a secondary that stands in for it): the same place under this computer's home.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const HOME = /(?<![\w./~-])\/(?:Users|home)\/[^/\s"'`<>()]+(?=\/)/g;

export function localizePaths(text: string, home = homedir()): string {
  return text.replace(HOME, (other) => (other === home || existsSync(other) ? other : home));
}

/** Folders under this computer's home the text names that aren't here (a file that isn't there yet is fine). */
export function missingFolders(text: string, home = homedir()): string[] {
  const missing = new Set<string>();
  const under = new RegExp(`(?<![\\w./~-])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'\`<>()]+`, "g");
  for (const [raw] of localizePaths(text, home).matchAll(under)) {
    const path = raw.replace(/[.,;:!?]+$/, "");
    if (existsSync(path)) continue;
    const folder = path.endsWith("/") ? path.slice(0, -1) : dirname(path);
    if (folder !== home && !existsSync(folder)) missing.add(folder);
  }
  return [...missing];
}
