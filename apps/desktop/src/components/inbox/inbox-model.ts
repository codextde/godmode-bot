import type { AttentionItem, AttentionKind, MissingLogin } from "@godmode/shared";
import { humanTaskRef } from "@godmode/shared";
import { plainPreview } from "@/components/human-tasks/human-task-card";

export type InboxSectionId = "question" | "todo" | "review" | "blocked" | "paused" | "problems" | "login" | "access";
export type InboxFilter = "all" | InboxSectionId;

/** The order things are worked through in: what stops an agent right now first, housekeeping last. */
export const INBOX_SECTIONS: readonly { id: InboxSectionId; kinds: readonly AttentionKind[] }[] = [
  { id: "question", kinds: ["question"] },
  { id: "todo", kinds: ["todo"] },
  { id: "review", kinds: ["review"] },
  { id: "blocked", kinds: ["blocked"] },
  { id: "paused", kinds: ["paused"] },
  { id: "problems", kinds: ["failed", "automation"] },
  { id: "login", kinds: ["login"] },
  { id: "access", kinds: ["access"] },
];

export function sectionOf(kind: AttentionKind): InboxSectionId {
  return INBOX_SECTIONS.find((s) => s.kinds.includes(kind))!.id;
}

export const loginIdOf = (item: AttentionItem) => (item.kind === "login" ? item.id.slice("login:".length) : null);

/** The thing itself, not a sentence about it: the ticket's own title, the service of a login. */
export function itemCopy(item: AttentionItem, login?: MissingLogin): { ref?: string; title: string; detail: string } {
  if ((item.kind === "review" || item.kind === "blocked") && item.task) {
    return { ref: `#${item.task.number}`, title: item.task.title, detail: item.kind === "blocked" ? item.detail : "" };
  }
  if (item.kind === "todo" && item.humanTask) return { ref: humanTaskRef(item.humanTask), title: item.humanTask.title, detail: plainPreview(item.humanTask.body) };
  if (item.kind === "question" && item.question) return { title: item.question.title, detail: "" };
  if (item.kind === "login" && login) return { title: login.service || item.title, detail: login.reason };
  return { title: item.title, detail: item.detail };
}

export type InboxAction = "review" | "answer" | "open" | "addLogin" | "updateLogin" | "add2fa" | "continue" | "openChat" | "decide";

export function actionOf(item: AttentionItem, login?: MissingLogin): InboxAction {
  switch (item.kind) {
    case "review":
      return "review";
    case "question":
      return item.question?.kind === "approval" ? "review" : "answer";
    case "todo":
      return item.humanTask?.kind === "approval" ? "review" : item.humanTask?.kind === "decision" ? "answer" : "open";
    case "login":
      return login?.kind === "missing_totp" ? "add2fa" : login?.kind === "invalid_credential" ? "updateLogin" : "addLogin";
    case "paused":
      return "continue";
    case "failed":
      return "openChat";
    case "access":
      return "decide";
    default:
      return "open";
  }
}

export function matchesSearch(item: AttentionItem, query: string, agentName = "", login?: MissingLogin): boolean {
  if (!query) return true;
  const copy = itemCopy(item, login);
  return `${copy.ref ?? ""} ${copy.title} ${copy.detail} ${item.title} ${item.detail} ${agentName}`.toLowerCase().includes(query);
}
