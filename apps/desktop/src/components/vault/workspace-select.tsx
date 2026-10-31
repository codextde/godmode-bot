import { Globe2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export const GLOBAL_SCOPE = "__global__";

/** Pick "Global" or a workspace. `value` null = global. */
export function WorkspaceSelect({
  value,
  onChange,
  className,
  id,
  disabled,
}: {
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  className?: string;
  id?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("vault");
  const { data: workspaces = [] } = useWorkspaces();
  const current = value ? workspaces.find((w) => w.id === value) : null;
  return (
    <Select value={value ?? GLOBAL_SCOPE} onValueChange={(v) => onChange(v === GLOBAL_SCOPE ? null : v)} disabled={disabled}>
      <SelectTrigger id={id} className={cn("w-full", className)}>
        {/* Compact trigger label; the list items carry the longer hints. */}
        <SelectValue>
          {current ? (
            <>
              <span className="w-4 text-center">{current.icon || "🗂️"}</span> {current.name}
            </>
          ) : value ? (
            t("scope.workspace")
          ) : (
            <>
              <Globe2 className="size-4" /> {t("scope.global")}
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={GLOBAL_SCOPE}>
          <Globe2 className="size-4" /> {t("scope.global")} <span className="text-muted-foreground">{t("scope.everyWorkspace")}</span>
        </SelectItem>
        {workspaces.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{t("scope.workspaces")}</SelectLabel>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  <span className="w-4 text-center">{w.icon || "🗂️"}</span> {w.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/** Scope filter used in list toolbars: all / global / workspace. */
export function ScopeFilterSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { t } = useTranslation("vault");
  const { data: workspaces = [] } = useWorkspaces();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("w-44", className)} aria-label={t("scope.filter")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t("scope.all")}</SelectItem>
        <SelectItem value="global">{t("scope.globalOnly")}</SelectItem>
        {workspaces.length > 0 && <SelectSeparator />}
        {workspaces.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            <span className="w-4 text-center">{w.icon || "🗂️"}</span> {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
