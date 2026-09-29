/** A repository URL as typed or pasted, normalized to what `git clone` gets. */
export interface ParsedGitUrl {
  url: string;
  /** Repository name, e.g. "godmode-bot". */
  name: string;
  /** Branch named by a web link (`…/tree/<branch>`), else null. */
  branch: string | null;
}

// Bun and browsers both have WHATWG URL; this package compiles without their type libraries.
declare const URL: new (input: string) => {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  pathname: string;
  search: string;
  hash: string;
  toString(): string;
};

const SCP_LIKE =/^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([A-Za-z0-9._~/-]+)$/;
const PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);
const FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

export function isValidBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    !branch.includes("..") &&
    !branch.includes("//")
  );
}

function repoName(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * Accepts https, ssh (`ssh://…` or `git@host:owner/repo`) and git:// URLs. Web links to GitHub, GitLab, Bitbucket and
 * Codeberg repositories (also `…/tree/<branch>`) become clone URLs. Credentials in https URLs are refused: cloning
 * uses this computer's git sign-in (credential helper or SSH key), and URLs end up in prompts and logs.
 */
export function parseGitUrl(input: string): ParsedGitUrl | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "Enter a repository URL." };
  if (/\s/.test(raw) || raw.startsWith("-")) return { error: "That doesn't look like a repository URL." };

  const scp = SCP_LIKE.exec(raw);
  if (scp) {
    const name = repoName(scp[2]!);
    if (!name || name.startsWith(".")) return { error: "The URL doesn't name a repository." };
    return { url: raw, name, branch: null };
  }

  let u: InstanceType<typeof URL>;
  try {
    u = new URL(raw);
  } catch {
    return { error: "Use an https:// or SSH URL, e.g. https://github.com/owner/repo.git" };
  }
  if (!PROTOCOLS.has(u.protocol)) return { error: "Only https://, ssh:// and git@host:owner/repo URLs are supported." };
  if (!u.hostname) return { error: "The URL has no host." };
  const web = u.protocol === "https:" || u.protocol === "http:";
  if (u.password || (web && u.username)) {
    return { error: "Leave passwords and tokens out of the URL — Godmode clones with this computer's git sign-in (credential helper or SSH key)." };
  }

  let path: string;
  try {
    path = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  } catch {
    return { error: "That doesn't look like a repository URL." };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (web && FORGES.has(host)) {
    const segments = path.split("/").filter(Boolean);
    // GitLab nests groups and ends the repository path with "-"; the others are always owner/repo.
    const nested = host === "gitlab.com";
    const cut = nested ? segments.indexOf("-") : 2;
    const repo = cut > 0 ? segments.slice(0, cut) : segments;
    const rest = cut > 0 ? segments.slice(nested ? cut + 1 : cut) : [];
    const branch = (rest[0] === "tree" || rest[0] === "src") && rest.length > 1 && isValidBranch(rest.slice(1).join("/")) ? rest.slice(1).join("/") : null;
    if (repo.length < 2) return { error: "Link to a repository, e.g. https://github.com/owner/repo" };
    const clonePath = `/${repo.join("/").replace(/\.git$/i, "")}.git`;
    return { url: `https://${host}${clonePath}`, name: repoName(clonePath), branch };
  }

  const name = repoName(path);
  if (!name || name.startsWith(".")) return { error: "The URL doesn't name a repository." };
  u.search = "";
  u.hash = "";
  return { url: u.toString().replace(/\/+$/, ""), name, branch: null };
}
