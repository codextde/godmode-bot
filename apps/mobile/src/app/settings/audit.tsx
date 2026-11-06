import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AuditEntry } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { Group, PickerRow, Tile, type Option } from "@/components/form";
import { ago } from "@/components/status-rows";
import { EmptyState, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { adminApi, ak } from "@/lib/admin";
import { useAgents } from "@/lib/hooks";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, radius, space, useColors } from "@/lib/theme";

const COMMON = ["credential.fill", "credential.reveal", "totp.fill", "totp.reveal", "card.fill", "card.purchase_request", "card.reveal", "vault.unlock", "vault.lock", "vault.passphrase", "backup.export", "backup.import"];

/** The audit log, like the desktop's: every secret use and security event, newest first, filtered by action. */
export default function Audit() {
  const { t } = useTranslation("admin");
  const [action, setAction] = useState("all");
  const query = useQuery({ queryKey: ak.audit(action), queryFn: () => adminApi.security.audit(action === "all" ? undefined : action) });
  const pull = usePullRefresh(query.refetch);
  const { byId } = useAgents();
  const phones = useQuery({ queryKey: ak.phones, queryFn: () => adminApi.phones.status() });
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const [id, a] of byId) out.set(`agent:${id}`, a.name);
    for (const d of phones.data?.devices ?? []) out.set(`device:${d.id}`, d.name);
    return out;
  }, [byId, phones.data]);
  const [open, setOpen] = useState<string | null>(null);

  const options = useMemo<Option<string>[]>(() => {
    const seen = new Set([...COMMON, ...(query.data ?? []).map((e) => e.action)]);
    return [{ value: "all", label: t("security.audit.all") }, ...[...seen].sort().map((a) => ({ value: a, label: a }))];
  }, [query.data, t]);

  return (
    <>
      <Stack.Screen options={{ title: t("security.audit.title"), headerLargeTitleEnabled: false }} />
      <FullAccessGate skeleton={<SkeletonRows count={8} avatar={30} />}>
        <AdminQueryState query={query} errorTitle={t("security.audit.loadFailed")} skeleton={<SkeletonRows count={8} avatar={30} />}>
          {(entries) => (
            <FlatList
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={styles.content}
              data={entries}
              keyExtractor={(e) => e.id}
              refreshing={pull.refreshing}
              onRefresh={pull.onRefresh}
              ListHeaderComponent={
                <View style={{ marginBottom: space.lg }}>
                  <Group>
                    <PickerRow icon="filter" title={t("security.audit.filter")} value={action} options={options} onChange={setAction} />
                  </Group>
                </View>
              }
              ListEmptyComponent={<EmptyState icon="list" title={action === "all" ? t("security.audit.empty") : t("security.audit.noMatch", { action })} />}
              renderItem={({ item, index }) => (
                <EntryRow entry={item} names={names} first={index === 0} last={index === entries.length - 1} open={open === item.id} onToggle={() => setOpen((o) => (o === item.id ? null : item.id))} />
              )}
            />
          )}
        </AdminQueryState>
      </FullAccessGate>
    </>
  );
}

function actor(entry: AuditEntry, names: Map<string, string>, t: (key: "security.audit.you" | "security.audit.system" | "security.audit.app") => string): string {
  if (entry.actor === "user") return t("security.audit.you");
  if (entry.actor === "system") return t("security.audit.system");
  if (names.has(entry.actor)) return names.get(entry.actor)!;
  if (entry.actor.startsWith("connector:")) return typeof entry.details.app === "string" ? entry.details.app : t("security.audit.app");
  return entry.actor;
}

function EntryRow({ entry, names, first, last, open, onToggle }: { entry: AuditEntry; names: Map<string, string>; first: boolean; last: boolean; open: boolean; onToggle: () => void }) {
  const c = useColors();
  const { t } = useTranslation("admin");
  const tint = entry.action.includes("reveal") ? c.warning : entry.action.includes("delete") || entry.action.includes("fail") ? c.danger : undefined;
  const details = Object.keys(entry.details ?? {}).length ? JSON.stringify(entry.details, null, 2) : null;
  return (
    <View style={[{ backgroundColor: c.surface, borderColor: c.border }, styles.card, first && styles.top, last && styles.bottom]}>
      {!first ? <Hairline inset={space.lg} /> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!details}
        onPress={() => {
          tap();
          onToggle();
        }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
      >
        <Tile icon={entry.actor.startsWith("agent:") ? "agents" : entry.actor.startsWith("device:") ? "phone" : entry.actor === "user" ? "user" : "cpu"} tint={tint} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" numberOfLines={1} style={{ fontWeight: "500", fontFamily: fonts.mono, fontSize: 13 }} color={tint ?? c.text}>
            {entry.action}
          </T>
          <T variant="footnote" muted numberOfLines={1}>
            {[actor(entry, names, t), entry.target].filter(Boolean).join(" · ")}
          </T>
        </View>
        <T variant="caption" muted>
          {ago(entry.ts)}
        </T>
      </Pressable>
      {open && details ? (
        <T variant="mono" muted style={styles.details} selectable>
          {details}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
  },
  card: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  top: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  bottom: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  details: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    fontSize: 11,
  },
});
