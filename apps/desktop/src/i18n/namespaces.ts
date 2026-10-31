export const NAMESPACES = ["common", "system", "ui", "layout", "settings", "agents", "chat", "vault", "license", "tasks", "humanTasks", "inbox", "attention", "mods", "integrations", "browser", "files", "vms", "computer", "android", "ssh", "onboarding", "workspaces", "automations", "projects", "runs", "runners", "activity", "aicss", "messaging", "artifacts", "calls", "permissions", "instructions", "devices", "auth", "templates"] as const;

export type Namespace = (typeof NAMESPACES)[number];
