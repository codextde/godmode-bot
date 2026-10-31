import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkspaceClaudeAccounts } from "@godmode/shared";
import { AccountAvatar, DefaultTag, PlanTag, useClaudeAccounts } from "@/components/settings/claude-accounts-section";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The workspace's own Claude accounts (optional): off = Godmode's default and switching. Shown once there is more than
 * one account to choose from.
 */
export function WorkspaceAccountsField({ value, onChange }: { value: WorkspaceClaudeAccounts | null; onChange: (v: WorkspaceClaudeAccounts | null) => void }) {
  const { t } = useTranslation("workspaces");
  const { data } = useClaudeAccounts();
  const accounts = data?.accounts ?? [];
  if (accounts.length < 2 && !value) return null;
  const globalDefault = accounts.find((a) => a.isDefault) ?? accounts[0];
  const own = !!value;

  const turn = (on: boolean) => {
    if (!on) return onChange(null);
    const id = globalDefault?.id ?? "system";
    onChange({ ids: [id], defaultId: id });
  };
  const toggle = (id: string, on: boolean) => {
    if (!value) return;
    const ids = on ? [...value.ids, id] : value.ids.filter((x) => x !== id);
    if (!ids.length) return;
    onChange({ ids, defaultId: ids.includes(value.defaultId) ? value.defaultId : ids[0]! });
  };
  const makeDefault = (id: string) => {
    if (!value) return;
    onChange({ ids: value.ids.includes(id) ? value.ids : [...value.ids, id], defaultId: id });
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="ws-claude-accounts">
            {t("dialog.claudeAccounts")} <span className="font-normal text-muted-foreground">{t("dialog.optional")}</span>
          </Label>
          <p className="text-xs text-muted-foreground">
            {own ? t("dialog.claudeAccountsOwnHint") : t("dialog.claudeAccountsHint", { email: globalDefault?.email ?? t("dialog.claudeAccountsThisComputer") })}
          </p>
        </div>
        <Switch id="ws-claude-accounts" className="mt-0.5" checked={own} onCheckedChange={turn} />
      </div>
      {value && (
        <div className="divide-y border-t">
          {accounts.map((a) => {
            const included = value.ids.includes(a.id);
            const isDefault = value.defaultId === a.id;
            const only = included && value.ids.length === 1;
            return (
              <div key={a.id} className={cn("group flex items-center gap-3 px-4 py-2.5", !included && "opacity-70")}>
                <Checkbox
                  id={`ws-acc-${a.id}`}
                  checked={included}
                  disabled={only}
                  onCheckedChange={(on) => toggle(a.id, on === true)}
                  aria-label={a.email ?? a.id}
                />
                <label htmlFor={`ws-acc-${a.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                  <AccountAvatar account={a} className="size-7 text-[11px]" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{a.email ?? t("dialog.claudeAccountsThisComputer")}</span>
                      <PlanTag plan={a.plan} />
                    </span>
                    {a.system && <span className="block text-[11px] text-muted-foreground">{t("dialog.claudeAccountsSystem")}</span>}
                  </span>
                </label>
                {isDefault ? (
                  <DefaultTag />
                ) : (
                  <button
                    type="button"
                    onClick={() => makeDefault(a.id)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <Star className="size-3" aria-hidden /> {t("dialog.claudeAccountsMakeDefault")}
                  </button>
                )}
              </div>
            );
          })}
          <p className="px-4 py-2.5 text-[11px] text-muted-foreground">{t("dialog.claudeAccountsFooter")}</p>
        </div>
      )}
    </div>
  );
}
