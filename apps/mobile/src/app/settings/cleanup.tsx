import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type CleanupId, type CleanupItem, type CleanupReport, type CleanupRun, type OptimizeReport, type OptimizeRun, type StorageArea } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, SwitchRow } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { FormSkeleton, QueryState } from "@/components/settings-state";
import { Button, Card, Row, Skeleton, T, tap, toneColors, type Tone } from "@/components/ui";
import { errorText } from "@/lib/api";
import { dateLocale, intlLocale, t as translate } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";

const AREA_TONE: Record<StorageArea, Tone> = { agents: "sky", browser: "amber", vms: "violet", repos: "rose", database: "emerald", other: "neutral" };

const ICONS: Record<CleanupId, IconName> = {
  "temp-files": "clock",
  "browser-cache": "globe",
  "task-worktrees": "branch",
  "task-clones": "copy",
  database: "layers",
  "old-logs": "scroll",
  "vm-downloads": "vm",
  trash: "trash",
  "vm-images": "vm",
  "agent-scratch": "folder",
  "agent-run-logs": "doc",
  "agent-history": "archive",
  "deleted-files": "trash",
  "chat-pictures": "photo",
  "build-folders": "package",
};

const LARGE_CHAT = 250_000;

const cleanable = (i: CleanupItem) => i.count > 0 && !i.blocked;
/** The phone cleans what Godmode removes by itself too; the rest needs a look on the computer. */
const phoneMay = (i: CleanupItem) => i.recommended && cleanable(i);

function cleanupResult(run: CleanupRun) {
  const failed = run.results.filter((r) => !r.ok);
  const done = run.results.filter((r) => r.ok && r.removed);
  const title = run.freedBytes ? translate("settings:cleanup.freed", { size: formatBytes(run.freedBytes) }) : translate("settings:cleanup.allClean");
  const lines = [done.length ? done.map((r) => r.name).join(" · ") : translate("settings:cleanup.nothingLeft"), ...failed.map((r) => translate("settings:cleanup.partial", { name: r.name }))];
  Alert.alert(title, lines.join("\n"));
}

function optimizeResult(run: OptimizeRun, dreaming: boolean) {
  const dreams = run.dreams.started.length;
  Alert.alert(
    run.cleanup.freedBytes ? translate("settings:cleanup.optimize.doneFreed", { size: formatBytes(run.cleanup.freedBytes) }) : translate("settings:cleanup.optimize.done"),
    dreams ? translate("settings:cleanup.optimize.dreamsStarted", { count: dreams }) : dreaming ? translate("settings:cleanup.optimize.memoryCurrent") : undefined,
  );
}

/** What Godmode's data takes, what can go, and Optimize: compact chats and lean memory. */
export default function Cleanup() {
  const { t } = useTranslation(["settings", "common"]);
  const report = useQuery({ queryKey: sq.cleanup, queryFn: () => settingsApi.cleanup.report(), staleTime: 60_000 });
  const optimize = useQuery({ queryKey: sq.optimize, queryFn: settingsApi.optimize.report, staleTime: 60_000 });
  const settings = useSettings();
  const [scanning, setScanning] = useState(false);
  const rescan = async () => {
    setScanning(true);
    try {
      const [fresh] = await Promise.all([settingsApi.cleanup.report(true), optimize.refetch()]);
      queryClient.setQueryData(sq.cleanup, fresh);
    } catch (err) {
      Alert.alert(t("cleanup.scanFailed"), errorText(err));
    } finally {
      setScanning(false);
    }
  };
  const maintenance = settings.data?.maintenance;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={scanning} onRefresh={() => void rescan()} />}
    >
      <Stack.Screen options={{ title: t("cleanup.title") }} />
      <CloseButton />
      <QueryState query={report} icon="broom" errorTitle={t("cleanup.scanFailed")} skeleton={<CleanupSkeleton />}>
        {(data) => (
          <>
            <Storage report={data} />
            <Items report={data} busy={scanning} />
            {optimize.data ? <Optimize report={optimize.data} /> : null}
            {maintenance ? (
              <Group title={t("cleanup.auto.title")} footer={t("cleanup.auto.footer")}>
                <SwitchRow icon="broom" title={t("cleanup.auto.label")} value={maintenance.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
              </Group>
            ) : null}
          </>
        )}
      </QueryState>
    </ScrollView>
  );
}

function Storage({ report }: { report: CleanupReport }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const used = report.storage.reduce((n, s) => n + s.bytes, 0);
  const reclaim = report.items.filter(phoneMay).reduce((n, i) => n + i.bytes, 0);
  const last = report.lastRun;
  const areas = report.storage.filter((s) => s.bytes > 0);
  return (
    <Card style={styles.storage}>
      <T variant="eyebrow" muted>
        {t("cleanup.storage.title")}
      </T>
      <Row style={{ gap: space.sm, alignItems: "baseline" }}>
        <T variant="title" style={{ fontVariant: ["tabular-nums"] }}>
          {formatBytes(used)}
        </T>
        <T variant="footnote" muted>
          {t("cleanup.storage.used")}
        </T>
      </Row>
      {areas.length ? (
        <View style={styles.bar} accessibilityRole="image" accessibilityLabel={t("cleanup.storage.byArea")}>
          {areas.map((s) => (
            <View key={s.area} style={{ flex: Math.max(s.bytes / Math.max(used, 1), 0.015), backgroundColor: toneColors(c, AREA_TONE[s.area]).dot }} />
          ))}
        </View>
      ) : null}
      <View style={styles.legend}>
        {areas.map((s) => (
          <Row key={s.area} style={{ gap: 6 }}>
            <View style={[styles.swatch, { backgroundColor: toneColors(c, AREA_TONE[s.area]).dot }]} />
            <T variant="caption" muted>
              {s.name} · {formatBytes(s.bytes)}
            </T>
          </Row>
        ))}
      </View>
      <View style={{ gap: 2 }}>
        <T variant="footnote" color={reclaim ? c.text : c.textMuted} style={{ fontWeight: reclaim ? "600" : "400" }}>
          {reclaim ? t("cleanup.storage.reclaim", { size: formatBytes(reclaim) }) : t("cleanup.storage.nothing")}
        </T>
        <T variant="caption" muted>
          {[
            report.disk ? t("cleanup.storage.disk", { free: formatBytes(report.disk.freeBytes), total: formatBytes(report.disk.totalBytes) }) : null,
            t("cleanup.storage.checked", { time: formatDistanceToNow(new Date(report.checkedAt), { addSuffix: true, locale: dateLocale() }) }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </T>
        {last ? (
          <T variant="caption" muted>
            {t(last.automatic ? "cleanup.storage.lastAuto" : "cleanup.storage.last", {
              time: formatDistanceToNow(new Date(last.finishedAt), { addSuffix: true, locale: dateLocale() }),
              size: formatBytes(last.freedBytes),
            })}
          </T>
        ) : null}
      </View>
    </Card>
  );
}

function Items({ report, busy }: { report: CleanupReport; busy: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const listed = (i: CleanupItem) => i.count > 0 || i.entries.some((e) => e.kept);
  const items = report.items.filter(listed);
  const clean = report.items.filter((i) => !listed(i));
  const [picked, setPicked] = useState<Set<CleanupId> | null>(null);
  const selected = new Set([...(picked ?? report.items.filter(phoneMay).map((i) => i.id))].filter((id) => report.items.some((i) => i.id === id && phoneMay(i))));
  const total = items.filter((i) => selected.has(i.id)).reduce((n, i) => n + i.bytes, 0);
  const run = useMutation({
    mutationFn: (ids: CleanupId[]) => settingsApi.cleanup.run(ids),
    onSuccess: (result) => {
      cleanupResult(result);
      setPicked(null);
      void queryClient.invalidateQueries({ queryKey: sq.cleanup });
      void queryClient.invalidateQueries({ queryKey: sq.optimize });
    },
    onError: (err) => Alert.alert(t("cleanup.error"), errorText(err)),
  });
  const toggle = (id: CleanupId) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <View style={{ gap: space.md }}>
      <Group title={t("cleanup.items.title")} footer={items.some((i) => !i.recommended) ? t("cleanup.items.footer") : undefined}>
        {items.length === 0 ? (
          <Row style={styles.allClean}>
            <Icon name="checkCircle" size={20} color={c.success} />
            <View style={{ flex: 1 }}>
              <T variant="callout" style={{ fontWeight: "500" }}>
                {t("cleanup.items.emptyTitle")}
              </T>
              <T variant="footnote" muted>
                {t("cleanup.items.emptyBody")}
              </T>
            </View>
          </Row>
        ) : (
          items.map((item) => (
            <ItemRow key={item.id} item={item} selected={selected.has(item.id)} busy={run.isPending && selected.has(item.id)} onToggle={() => toggle(item.id)} />
          ))
        )}
      </Group>
      {items.length && clean.length ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
          {t("cleanup.items.alreadyClean", { names: clean.map((i) => i.name).join(" · ") })}
        </T>
      ) : null}
      {items.some(phoneMay) ? (
        <Button
          title={run.isPending ? t("cleanup.items.cleaning") : total ? t("cleanup.items.free", { size: formatBytes(total) }) : t("cleanup.items.title")}
          icon="broom"
          loading={run.isPending}
          disabled={!selected.size || busy}
          onPress={() => run.mutate([...selected])}
        />
      ) : null}
    </View>
  );
}

function ItemRow({ item, selected, busy, onToggle }: { item: CleanupItem; selected: boolean; busy: boolean; onToggle: () => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const may = phoneMay(item);
  const kept = item.entries.filter((e) => e.kept).length;
  const amount = [item.count > 0 ? t("cleanup.items.count", { count: item.count }) : null, kept ? t("cleanup.items.kept", { count: kept }) : null].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !may }}
      disabled={!may}
      onPress={() => {
        tap();
        onToggle();
      }}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.check}>
        {busy ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : may ? (
          selected ? (
            <Icon name="checkCircle" size={20} color={c.brandStrong} />
          ) : (
            <View style={[styles.circle, { borderColor: c.textFaint }]} />
          )
        ) : (
          <Icon name={ICONS[item.id]} size={16} color={c.textFaint} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" style={{ fontWeight: "500" }} color={may ? c.text : c.textMuted}>
          {item.name}
        </T>
        <T variant="footnote" muted numberOfLines={3}>
          {item.detail}
        </T>
        {item.blocked ? (
          <T variant="footnote" color={c.warning}>
            {item.blocked}
          </T>
        ) : !item.recommended && item.count > 0 ? (
          <T variant="footnote" muted>
            {t("phone.onComputer")}
          </T>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 1 }}>
        <T variant="subhead" style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {item.count ? formatBytes(item.bytes) : t("cleanup.items.nothingToRemove")}
        </T>
        {amount ? (
          <T variant="caption" muted>
            {amount}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

function Optimize({ report }: { report: OptimizeReport }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const run = useMutation({
    mutationFn: settingsApi.optimize.run,
    onSuccess: (result) => {
      optimizeResult(result, report.memory.dreaming);
      void queryClient.invalidateQueries({ queryKey: sq.optimize });
      void queryClient.invalidateQueries({ queryKey: sq.cleanup });
    },
    onError: (err) => Alert.alert(t("cleanup.optimize.error"), errorText(err)),
  });
  const { share, over } = report.context;
  const { agents, target, dreaming, nextDreamAt } = report.memory;
  const overLimit = agents.filter((a) => a.chars > target).length;
  const dreamingNow = agents.filter((a) => a.dreaming).length;
  const chars = target.toLocaleString(intlLocale());
  const lines: { text: string; warn: boolean }[] = [
    over ? { text: t("cleanup.optimize.over", { count: over, tokens: `${LARGE_CHAT / 1000}k` }), warn: true } : { text: t("cleanup.optimize.within"), warn: false },
    overLimit ? { text: t("cleanup.optimize.overLimit", { count: overLimit, chars }), warn: true } : { text: t("cleanup.optimize.withinLimit", { chars }), warn: false },
    dreamingNow
      ? { text: t("cleanup.optimize.dreamingNow", { count: dreamingNow }), warn: false }
      : dreaming && nextDreamAt
        ? { text: t("cleanup.optimize.nextDream", { time: formatDistanceToNow(new Date(nextDreamAt), { addSuffix: true, locale: dateLocale() }) }), warn: false }
        : { text: t("cleanup.optimize.dreamingOff"), warn: true },
  ];
  const compress = !report.automatic.compress ? t("cleanup.optimize.compressOff") : share === null ? t("cleanup.optimize.compressFull") : t("cleanup.optimize.compress", { pct: share });
  return (
    <View style={{ gap: space.md }}>
      <Group title={t("cleanup.optimize.title")} footer={compress}>
        {lines.map((l) => (
          <Row key={l.text} style={styles.line}>
            <Icon name={l.warn ? "warning" : "checkCircle"} size={16} color={l.warn ? c.warning : c.success} />
            <T variant="subhead" style={{ flex: 1 }}>
              {l.text}
            </T>
          </Row>
        ))}
      </Group>
      <Button
        title={run.isPending ? t("cleanup.optimize.running") : t("cleanup.optimize.now")}
        icon="sparkles"
        variant="outline"
        loading={run.isPending}
        onPress={() => run.mutate()}
      />
    </View>
  );
}

function CleanupSkeleton() {
  return (
    <View style={{ gap: space.xl }}>
      <Card style={styles.storage}>
        <Skeleton width="30%" height={11} />
        <Skeleton width="45%" height={26} />
        <Skeleton width="100%" height={8} />
        <Skeleton width="70%" height={11} />
      </Card>
      <FormSkeleton groups={1} rows={4} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  storage: {
    padding: space.lg,
    gap: space.md,
  },
  bar: {
    flexDirection: "row",
    height: 8,
    gap: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: space.md,
    rowGap: 4,
  },
  swatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  allClean: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  item: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  check: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  circle: {
    width: 19,
    height: 19,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  line: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
