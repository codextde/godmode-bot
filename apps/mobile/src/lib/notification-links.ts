import type { Href } from "expo-router";

/** The desktop's settings sections, as the phone's screens. */
const SETTINGS: Record<string, Href> = {
  // The only notices that point at General are about sleeping with the lid closed, which sits under Computer here.
  general: "/settings/computer",
  ai: "/settings/ai",
  accounts: "/settings/accounts",
  instructions: "/settings/instructions",
  browser: "/settings/browser",
  computer: "/settings/computer",
  voice: "/settings/voice",
  memory: "/settings/memory",
  review: "/settings/review",
  activity: "/activity",
  artifacts: "/artifacts",
  integrations: "/settings/integrations",
  plugins: "/settings/plugins",
  messaging: "/settings/messaging",
  calls: "/settings/calls",
  cards: "/settings/vault/cards",
  vms: "/settings/vms",
  ssh: "/settings/ssh",
  "ssh-keys": "/settings/vault/ssh-keys",
  android: "/settings/android",
  files: "/settings/files",
  "api-keys": "/settings/vault/api-keys",
  security: "/settings/security",
  backup: "/settings/backup",
  phone: "/settings/phones",
  devices: "/settings/devices",
  connect: "/settings/connected-apps",
  cloud: "/settings/cloud",
  license: "/settings/license",
  billing: "/settings/license",
  system: "/settings/health",
  cleanup: "/settings/cleanup",
  logs: "/settings/logs",
  about: "/settings/about",
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const param = (query: string, key: string) => {
  const value = new RegExp(`(?:^|&)${key}=([^&]+)`).exec(query)?.[1];
  return value === undefined ? undefined : decode(value);
};

/**
 * Where a notification's desktop link leads on the phone ("/chat/…", "/tasks?task=…", "/settings/license"); null when
 * there is no such screen. `full`: this phone has full access, so a plugin opens itself and not only the list.
 */
export function notificationRoute(link: string | null, full = false): Href | null {
  if (!link) return null;
  const [path = "", query = ""] = link.split("?");
  const [, section, raw, sub] = path.split("/");
  const id = raw ? decode(raw) : undefined;
  const task = param(query, "task");
  const call = param(query, "call");
  switch (section) {
    case "chat":
      return id ? { pathname: "/chat/[id]", params: { id } } : null;
    case "agents":
      if (!id) return null;
      return sub === "memory" ? { pathname: "/memory/[id]", params: { id } } : { pathname: "/agent/[id]", params: { id } };
    case "tasks":
      return task ? { pathname: "/task/[id]", params: { id: task } } : null;
    case "my-tasks":
      return task ? { pathname: "/human-task/[id]", params: { id: task } } : "/my-tasks";
    case "calls":
      return call ? { pathname: "/call/[id]", params: { id: call } } : "/calls";
    case "automations":
      return "/automations";
    case "artifacts":
      return id ? { pathname: "/artifact/[id]", params: { id } } : null;
    case "settings":
      return id && SETTINGS[id] ? SETTINGS[id] : "/settings";
    case "integrations":
      return param(query, "tab") === "api-keys" ? SETTINGS["api-keys"]! : SETTINGS.integrations!;
    case "messaging": {
      const connection = param(query, "connection");
      return connection ? { pathname: "/settings/messaging-bot", params: { id: connection } } : SETTINGS.messaging!;
    }
    case "plugins": {
      const plugin = param(query, "plugin");
      if (!plugin || !full) return SETTINGS.plugins!;
      return { pathname: param(query, "tab") === "code" ? "/settings/plugin-code" : "/settings/plugin", params: { id: plugin } };
    }
    default:
      return null;
  }
}
