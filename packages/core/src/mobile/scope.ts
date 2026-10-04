/**
 * What a paired phone may call. The app controls Godmode — chats, tasks, runs, automations and the screens agents work
 * on — but never reaches secrets, backups, settings, integrations or this computer's files, can't change what a chat, a
 * task or an automation is allowed to do, and only controls screens the human shared in a chat and Godmode's VMs.
 */
import { computerView, type ComputerTarget } from "@godmode/shared";
import { all } from "../db";
import { parseJson } from "../util";

const ID = "[^/]+";

const ROUTES: [method: string, path: RegExp][] = [
  ["GET", /^\/api\/bootstrap$/],
  ["GET", /^\/api\/mobile\/me$/],
  ["DELETE", /^\/api\/mobile\/me$/],
  ["GET", /^\/api\/workspaces$/],
  ["GET", /^\/api\/notifications$/],
  ["GET", /^\/api\/missing-logins$/],

  ["GET", /^\/api\/agents$/],
  ["GET", new RegExp(`^/api/agents/${ID}$`)],

  ["GET", /^\/api\/conversations$/],
  ["GET", new RegExp(`^/api/conversations/${ID}$`)],
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/(pause|continue)$`)],
  ["POST", /^\/api\/chat$/],

  ["GET", /^\/api\/tasks$/],
  ["GET", new RegExp(`^/api/tasks/${ID}$`)],
  ["POST", /^\/api\/tasks$/],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`)],

  ["GET", /^\/api\/runs$/],
  ["POST", new RegExp(`^/api/runs/${ID}/cancel$`)],

  ["GET", /^\/api\/routines$/],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/run$`)],

  ["GET", /^\/api\/browser\/profiles$/],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`)],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/input$`)],
  ["POST", /^\/api\/computer\/input$/],

  ["GET", /^\/api\/vms$/],
  ["GET", new RegExp(`^/api/vms/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/vms/${ID}/(start|stop|input)$`)],
];

/** Requests whose JSON body may only carry these fields when a phone sends them. */
const BODIES: [method: string, path: RegExp, keys: string[]][] = [
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`), ["title", "pinned", "archived"]],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`), ["content"]],
  ["POST", /^\/api\/chat$/, ["agentId", "content", "workspaceId"]],
  // A task's repository and branch are picked on the computer: the phone never points an agent at another repository.
  ["POST", /^\/api\/tasks$/, ["workspaceId", "title", "description", "type", "status", "agentId"]],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`), ["title", "description", "status", "agentId", "archived"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`), ["content"]],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`), ["enabled"]],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`), []],
  ["POST", /^\/api\/computer\/input$/, ["view", "event", "frame"]],
  ["POST", new RegExp(`^/api/vms/${ID}/input$`), ["event", "frame"]],
];

export function deviceMayCall(method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  return ROUTES.some(([rm, re]) => rm === m && re.test(path));
}

/** The fields a phone may send to this route; null = no body rules. */
export function deviceBodyKeys(method: string, path: string): string[] | null {
  return BODIES.find(([m, re]) => m === method && re.test(path))?.[2] ?? null;
}

/** A phone may watch and control a screen only while it is shared in a chat. */
export function deviceMayUseView(view: string): boolean {
  for (const row of all<{ computer_target: string }>("SELECT computer_target FROM conversations WHERE computer_target IS NOT NULL")) {
    const target = parseJson<ComputerTarget | null>(row.computer_target, null);
    if (!target) continue;
    if (target.kind === "desktop" ? view.startsWith("display:") : computerView(target) === view) return true;
  }
  return false;
}
