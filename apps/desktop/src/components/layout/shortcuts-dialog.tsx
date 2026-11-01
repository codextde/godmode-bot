import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/common";
import { altKey, modKey } from "@/lib/desktop";
import { THEME_SHORTCUT } from "@/components/layout/theme-toggle";
import { useUi } from "@/stores/ui";

/** "G then T" style jumps: the second key, where it goes, and what it's called. */
export const GO_TO = [
  { key: "c", to: "/", label: "nav.chat" },
  { key: "t", to: "/tasks", label: "nav.tasks" },
  { key: "m", to: "/inbox?view=board", label: "shortcuts.goTo.todoBoard" },
  { key: "a", to: "/agents", label: "nav.agents" },
  { key: "u", to: "/automations", label: "nav.automations" },
  { key: "i", to: "/inbox", label: "nav.inbox" },
  { key: "y", to: "/settings/activity", label: "nav.activity" },
  { key: "l", to: "/vault/logins", label: "nav.passwords" },
  { key: "s", to: "/settings/general", label: "nav.settings" },
] as const;

const GROUPS = [
  {
    id: "everywhere",
    rows: [
      { keys: [`${modKey}K`], what: "shortcuts.rows.search" },
      { keys: [`${modKey}N`], what: "shortcuts.rows.newChat" },
      { keys: ["⇧", `${modKey}N`], what: "shortcuts.rows.newPrivateChat" },
      { keys: [`${modKey}B`], what: "shortcuts.rows.toggleSidebar" },
      { keys: [`${modKey}1–9`], what: "shortcuts.rows.openChat" },
      { keys: [`${altKey}${modKey}1–9`], what: "shortcuts.rows.switchWorkspace" },
      { keys: [`${altKey}${modKey}0`], what: "shortcuts.rows.allWorkspaces" },
      { keys: [`${modKey},`], what: "shortcuts.rows.settings" },
      { keys: [THEME_SHORTCUT], what: "shortcuts.rows.theme" },
      { keys: ["?"], what: "shortcuts.rows.thisList" },
    ],
  },
  {
    id: "goTo",
    rows: GO_TO.map((g) => ({ keys: ["G", g.key.toUpperCase()], what: g.label })),
  },
  {
    id: "chat",
    rows: [
      { keys: ["↵"], what: "shortcuts.rows.send" },
      { keys: ["⇧", "↵"], what: "shortcuts.rows.newLine" },
      { keys: ["/"], what: "shortcuts.rows.commands" },
      { keys: ["↑"], what: "shortcuts.rows.editLast" },
      { keys: [`${modKey}L`], what: "shortcuts.rows.quote" },
      { keys: ["Esc"], what: "shortcuts.rows.stopDictation" },
    ],
  },
  {
    id: "lists",
    rows: [
      { keys: ["C"], what: "shortcuts.rows.newTicket" },
      { keys: ["/"], what: "shortcuts.rows.searchList" },
    ],
  },
] as const;

/** Every keyboard shortcut on one page: `?` anywhere outside a text field, or "Keyboard shortcuts" in search. */
export function ShortcutsDialog() {
  const { t } = useTranslation("layout");
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto calm-motion:data-[state=closed]:animate-none calm-motion:data-[state=open]:animate-none sm:max-w-xl" overlayClassName="calm-motion:data-[state=closed]:animate-none calm-motion:data-[state=open]:animate-none">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`keys-${g.id}`}>
              <h3 id={`keys-${g.id}`} className="eyebrow mb-2">
                {t(`shortcuts.groups.${g.id}`)}
              </h3>
              <dl className="space-y-1.5">
                {g.rows.map((r) => (
                  <div key={r.what} className="flex items-center justify-between gap-3 text-[13px]">
                    <dt className="min-w-0 text-foreground/85">{t(r.what, { key: modKey })}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k, i) => (
                        <Fragment key={i}>
                          {i > 0 && g.id === "goTo" && <span className="text-[11px] text-muted-foreground">{t("shortcuts.then")}</span>}
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
