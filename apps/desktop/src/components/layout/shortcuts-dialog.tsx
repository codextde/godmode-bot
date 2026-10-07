import { Fragment, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/common";
import { modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";

/** "G then T" style jumps: the second key, where it goes, and what it's called. */
export const GO_TO: readonly { key: string; to: string; label: string }[] = [
  { key: "c", to: "/", label: "Chat" },
  { key: "t", to: "/tasks", label: "Tasks" },
  { key: "a", to: "/agents", label: "Agents" },
  { key: "u", to: "/automations", label: "Automations" },
  { key: "i", to: "/inbox", label: "Inbox" },
  { key: "y", to: "/activity", label: "Activity" },
  { key: "l", to: "/vault/logins", label: "Logins" },
  { key: "s", to: "/settings/general", label: "Settings" },
];

const GROUPS: { title: string; rows: { keys: ReactNode[]; what: string }[] }[] = [
  {
    title: "Everywhere",
    rows: [
      { keys: [`${modKey}K`], what: "Search chats, tickets, automations, settings — and what waits for you" },
      { keys: [`${modKey}N`], what: "New chat" },
      { keys: [`${modKey}B`], what: "Show or hide the sidebar" },
      { keys: [`${modKey}1–9`], what: "Switch to a workspace (in A–Z order)" },
      { keys: [`${modKey}0`], what: "All workspaces" },
      { keys: [`${modKey},`], what: "Settings" },
      { keys: ["?"], what: "This list" },
    ],
  },
  {
    title: "Go to",
    rows: GO_TO.map((g) => ({ keys: ["G", g.key.toUpperCase()], what: g.label })),
  },
  {
    title: "In a chat",
    rows: [
      { keys: ["↵"], what: "Send" },
      { keys: ["⇧", "↵"], what: "New line" },
      { keys: ["/"], what: "Claude Code commands (/compact, /model, …)" },
      { keys: ["↑"], what: "Edit your last message while it waits in the queue" },
      { keys: ["Esc"], what: "Stop dictation" },
    ],
  },
  {
    title: "Lists",
    rows: [
      { keys: ["C"], what: "New ticket (Tasks)" },
      { keys: ["/"], what: "Search (Agents, Logins, Workspaces)" },
    ],
  },
];

/** Every keyboard shortcut on one page: `?` anywhere outside a text field, or "Keyboard shortcuts" in search. */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press a key outside a text field. “G then T”: press G, then T.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title} aria-labelledby={`keys-${g.title}`}>
              <h3 id={`keys-${g.title}`} className="eyebrow mb-2">
                {g.title}
              </h3>
              <dl className="space-y-1.5">
                {g.rows.map((r) => (
                  <div key={r.what} className="flex items-center justify-between gap-3 text-[13px]">
                    <dt className="min-w-0 text-foreground/85">{r.what}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k, i) => (
                        <Fragment key={i}>
                          {i > 0 && g.title === "Go to" && <span className="text-[11px] text-muted-foreground">then</span>}
                          <Kbd>{k}</Kbd>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
