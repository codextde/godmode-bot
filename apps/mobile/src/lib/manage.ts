import { router } from "expo-router";
import { Alert } from "react-native";
import type {
  Agent,
  AgentBrowserConfig,
  AgentComputerConfig,
  AgentMoveInput,
  AgentMoveResult,
  AgentPlacement,
  ComputerSources,
  Dream,
  FolderListing,
  ProjectMoveInput,
  ScopeMoveCounts,
  ScopeMoveResult,
  WorkspaceClaudeAccounts,
  WorkspaceMoveInput,
} from "@godmode/shared";
import { errorText, request, type AgentPatch, type WorkspacePatch } from "./api";
import { t } from "./i18n";
import { qk, queryClient } from "./query";
import { isCancelled, withGrant } from "./secrets";
import { patchAgent, patchWorkspace } from "./setup";

const enc = encodeURIComponent;
const grantHeader = (grant?: string) => (grant ? { "x-godmode-grant": grant } : undefined);

/** What the desktop's agent form changes beyond the phone's own fields. */
export type AgentSetupPatch = AgentPatch & {
  browser?: AgentBrowserConfig;
  computer?: AgentComputerConfig;
  inheritMcp?: boolean;
  mcpServerIds?: string[];
  workingDirectory?: string | null;
  vmId?: string | null;
  sshServerIds?: string[];
  androidDeviceIds?: string[];
};

export type WorkspaceSetupPatch = WorkspacePatch & { vmId?: string | null; claudeAccounts?: WorkspaceClaudeAccounts | null };

/** Calls a full-access phone makes like the desktop app (agents' places, workspace moves, dream undo, folders). */
export const manageApi = {
  moveAgent: (id: string, input: AgentMoveInput) => request<AgentMoveResult>("POST", `/api/agents/${enc(id)}/move`, input),
  placeAgent: (p: AgentPlacement) => request<Agent>("PATCH", `/api/agents/${enc(p.id)}`, { workspaceId: p.workspaceId, reportsTo: p.reportsTo }),
  moveWorkspace: (id: string, input: WorkspaceMoveInput, grant?: string) => request<ScopeMoveResult>("POST", `/api/workspaces/${enc(id)}/move`, input, 0, grantHeader(grant)),
  moveProject: (id: string, input: ProjectMoveInput, grant?: string) => request<ScopeMoveResult>("POST", `/api/projects/${enc(id)}/move`, input, 0, grantHeader(grant)),
  /** `force`: everything in it goes too (409 without, when it isn't empty). */
  deleteWorkspace: (id: string, force: boolean) => request<{ ok: true }>("DELETE", `/api/workspaces/${enc(id)}${force ? "?force=1" : ""}`, undefined, force ? 60_000 : 0),
  revertDream: (id: string) => request<Dream>("POST", `/api/dreams/${enc(id)}/revert`, {}, 30_000),
  computerSources: () => request<ComputerSources>("GET", "/api/computer/sources"),
  /** Subfolders on the computer; no path = home. */
  folders: (path?: string) => request<FolderListing>("GET", `/api/folders${path ? `?path=${enc(path)}` : ""}`),
  recentFolders: () => request<string[]>("GET", "/api/folders/recent"),
};

export const mk = {
  computerSources: ["computer-sources"],
  folders: (path: string) => ["folders", path],
  recentFolders: ["folders", "recent"],
} as const;

/** The desktop's fields of an agent: shows at once, goes back when the computer refuses. */
export const patchAgentSetup = (id: string, patch: AgentSetupPatch) => patchAgent(id, patch as AgentPatch);

export const patchWorkspaceSetup = (id: string, patch: WorkspaceSetupPatch) => patchWorkspace(id, patch as WorkspacePatch);

function refreshAgents(moved: Agent[] = []) {
  if (moved.length) queryClient.setQueryData<Agent[]>(qk.agents, (list) => list?.map((a) => moved.find((m) => m.id === a.id) ?? a));
  void queryClient.invalidateQueries({ queryKey: qk.agents });
}

async function moveBack(previous: AgentPlacement[]) {
  try {
    // Leads first, so each report finds its lead where it was.
    for (const p of previous) await manageApi.placeAgent(p);
    Alert.alert(t("manage:move.movedBack"));
  } catch (err) {
    Alert.alert(t("manage:move.moveBackFailed"), errorText(err));
  } finally {
    refreshAgents();
  }
}

/**
 * Another workspace and/or another lead, its team along (the desktop's drag and drop). When more agents moved than the
 * one picked, the phone says so and offers to put them back.
 */
export async function moveAgent(agent: Agent, input: AgentMoveInput, done: string): Promise<boolean> {
  try {
    const res = await manageApi.moveAgent(agent.id, input);
    refreshAgents(res.moved);
    const team = res.moved.length - 1;
    if (team > 0) {
      Alert.alert(done, t("manage:move.teamMoved", { count: team }), [
        { text: t("common:actions.undo"), onPress: () => void moveBack(res.previous) },
        { text: t("common:actions.done"), style: "cancel" },
      ]);
    }
    return true;
  } catch (err) {
    Alert.alert(t("manage:move.failed", { name: agent.name }), errorText(err));
    refreshAgents();
    return false;
  }
}

const NOUNS = ["agents", "chats", "tasks", "projects", "sources", "credentials", "totp", "passkeys", "integrations", "browserProfiles", "paymentCards", "goals"] as const;

/** "3 agents, 12 chats and 2 logins came along." */
export function cameAlong(moved: ScopeMoveCounts): string | null {
  const count = (k: (typeof NOUNS)[number]) =>
    k === "integrations" ? (moved.mcpServers ?? 0) + (moved.apiTools ?? 0) + (moved.composioConnections ?? 0) : ((moved as Record<string, number | undefined>)[k] ?? 0);
  const parts = NOUNS.flatMap((k) => (count(k) ? [t(`manage:scope.nouns.${k}`, { count: count(k) })] : []));
  if (!parts.length) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${t("common:words.and")} ${parts[parts.length - 1]}` : parts[0]!;
  return t("manage:scope.cameAlong", { list });
}

/** A project into another workspace or out on its own (`to: null`), or a workspace into another as a project. */
export type ScopeMove = { kind: "project"; id: string; to: string | null; reviewed?: boolean } | { kind: "workspace"; id: string; to: string };

type MoveCall = ScopeMoveResult["undo"];

const send = (call: MoveCall) =>
  withGrant((grant) => ("projectId" in call ? manageApi.moveProject(call.projectId, call.input, grant) : manageApi.moveWorkspace(call.workspaceId, call.input, grant)));

/** Everything a move touches; resolves once the workspaces and agents are current, so a screen opened next finds them. */
async function refreshScopes() {
  for (const key of [qk.bootstrap, qk.tasks, qk.conversations, qk.browserProfiles, ["goals"], qk.artifacts]) void queryClient.invalidateQueries({ queryKey: key });
  await Promise.all([queryClient.invalidateQueries({ queryKey: qk.workspaces }), queryClient.invalidateQueries({ queryKey: qk.agents })]);
}

/**
 * Runs a move like the desktop's workspace page: the passphrase only when the computer wants it, then what came along
 * and an undo. Resolves to the result, null when cancelled, or "review" when the project's context needs reading first.
 */
export async function moveScope(move: ScopeMove, done: string): Promise<ScopeMoveResult | "review" | null> {
  const call: MoveCall =
    move.kind === "project"
      ? { projectId: move.id, input: { workspaceId: move.to, ...(move.reviewed ? { contextReviewed: true } : {}) } }
      : { workspaceId: move.id, input: { workspaceId: move.to } };
  try {
    const res = await send(call);
    await refreshScopes();
    const body = [cameAlong(res.moved), ...res.notes].filter(Boolean).join(" ") || undefined;
    Alert.alert(done, body, [
      { text: t("common:actions.undo"), onPress: () => void undoScope(res.undo) },
      { text: t("common:actions.done"), style: "cancel" },
    ]);
    return res;
  } catch (err) {
    if (isCancelled(err)) return null;
    if (err && typeof err === "object" && "code" in err && err.code === "context_review") return "review";
    Alert.alert(t("manage:scope.moveFailed"), errorText(err));
    void refreshScopes();
    return null;
  }
}

async function undoScope(call: MoveCall) {
  try {
    const res = await send(call);
    await refreshScopes();
    // The screen shown is of what no longer exists: what it was before lives on the other one.
    if (!res.project) router.replace({ pathname: "/settings/workspace/[id]", params: { id: res.workspace.id } });
    else if ("workspaceId" in call) router.replace({ pathname: "/settings/project/[id]", params: { id: res.project.id } });
    Alert.alert(t("manage:move.movedBack"));
  } catch (err) {
    if (!isCancelled(err)) Alert.alert(t("manage:move.moveBackFailed"), errorText(err));
    void refreshScopes();
  }
}

/** The last part of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A path under the home folder as "~/…". */
export function shortPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  return path === h ? "~" : path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path;
}

/** Everyone under `agent`, top-down (who moves along when it changes workspace). */
export function teamOf(agent: Agent, all: Agent[]): Agent[] {
  const out: Agent[] = [];
  const seen = new Set([agent.id]);
  for (let i = -1; i < out.length; i++) {
    const lead = i < 0 ? agent : out[i]!;
    for (const a of all) {
      if (a.reportsTo !== lead.id || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}
