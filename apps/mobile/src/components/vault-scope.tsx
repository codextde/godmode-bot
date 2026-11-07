import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { FilterChips } from "./filter-chips";
import { Icon } from "./icon";
import { Badge } from "./ui";
import { inScope, type VaultScope } from "@/lib/vault";
import { scopeLabel, useWorkspace } from "@/lib/workspace";
import { useColors } from "@/lib/theme";

/**
 * A vault list's scope filter, like the desktop's: all, global only or one workspace. Starts on the workspace picked on
 * the phone and follows it when it changes. A computer without workspaces has no scopes: `active` stays false.
 */
export function useVaultScope() {
  const { t } = useTranslation("vault");
  const { id, workspaces, loading } = useWorkspace();
  const [picked, setPicked] = useState<{ home: string | null; scope: VaultScope } | null>(null);
  const wanted = picked?.home === id ? picked.scope : (id ?? "all");
  const known = wanted === "all" || wanted === "global" || loading || workspaces.some((w) => w.id === wanted);
  const scope = known ? wanted : "all";

  const filters = useMemo(
    () => [{ id: "all", label: t("scope.all") }, { id: "global", label: t("scope.globalOnly") }, ...workspaces.map((w) => ({ id: w.id, label: scopeLabel(w) }))],
    [workspaces, t],
  );
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, scopeLabel(w)])), [workspaces]);
  /** The name on a row; null when there is nothing to tell apart. */
  const nameOf = useCallback(
    (workspaceId: string | null): string | null => (names.size ? (workspaceId ? (names.get(workspaceId) ?? t("scope.workspace")) : t("scope.global")) : null),
    [names, t],
  );
  const filter = useCallback(<I extends { workspaceId: string | null }>(items: I[]) => items.filter((item) => inScope(item, scope)), [scope]);

  return { scope, active: !!workspaces.length, filtered: scope !== "all", filters, select: (next: VaultScope) => setPicked({ home: id, scope: next }), nameOf, filter };
}

/** The filter as a row of chips above a list; nothing on a computer without workspaces. */
export function ScopeChips({ state, bleed }: { state: ReturnType<typeof useVaultScope>; bleed?: number }) {
  if (!state.active) return null;
  return <FilterChips filters={state.filters} value={state.scope} onChange={state.select} bleed={bleed} />;
}

/** Where a vault entry is available: one workspace, or global. */
export function ScopeBadge({ name, global }: { name: string | null; global: boolean }) {
  const c = useColors();
  if (!name) return null;
  return (
    <View style={{ maxWidth: 112, flexShrink: 1 }}>
      <Badge label={name} dot={false} icon={<Icon name={global ? "globe" : "layers"} size={10} color={c.textMuted} />} />
    </View>
  );
}
