import { standaloneDocument, type Artifact, type ArtifactFile } from "@godmode/shared";
import { localTextCopy, servedCopy } from "./agent-files";
import { saveOrShareFile } from "./save-file";

/** A file over this much of pictures, video and sound stays out of the HTML download, like on the computer. */
const MAX_INLINE_BYTES = 60 * 1024 * 1024;

type WithFiles = Pick<Artifact, "filesBase">;

export const artifactFilePath = (artifact: WithFiles, name: string) => `${artifact.filesBase ?? ""}${encodeURIComponent(name)}`;

/** The file on this phone: the share sheet on iOS, a folder the human picks on Android. False when closed. */
export async function saveArtifactFile(artifact: WithFiles, file: ArtifactFile, slot: string): Promise<boolean> {
  return saveOrShareFile(await servedCopy(artifactFilePath(artifact, file.name), file.name, slot), file.mime);
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";

/** The artifact as one HTML file that works on its own. Returns how many of its files didn't fit in, null when closed. */
export async function saveArtifactHtml(artifact: Artifact, html: string, theme: "light" | "dark", slot: string): Promise<number | null> {
  const inline: Record<string, string> = {};
  let room = MAX_INLINE_BYTES;
  let left = 0;
  for (const f of artifact.files) {
    if (!artifact.filesBase || f.size > room || f.kind === "file" || f.kind === "pdf") {
      left++;
      continue;
    }
    try {
      const copy = await servedCopy(artifactFilePath(artifact, f.name), f.name, slot);
      inline[f.name] = `data:${f.mime};base64,${await copy.base64()}`;
      room -= f.size;
    } catch {
      left++;
    }
  }
  const files = artifact.files.length ? { base: null, list: artifact.files, inline } : undefined;
  const page = localTextCopy(slot, `${slug(artifact.title)}.html`, standaloneDocument(html, artifact.data, theme, files));
  return (await saveOrShareFile(page, "text/html")) ? left : null;
}
