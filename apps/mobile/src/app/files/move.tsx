import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { SheetHeader } from "@/components/secret-parts";
import { Card, Hairline, LoadingState, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { fileChanged, filesApi, fk, joinPath, nameOf, parentOf, pinsAmong, refreshFiles, reservedPlace } from "@/lib/agent-files";
import { fonts, radius, space, useColors } from "@/lib/theme";

const ROOTS = ["workspace", "memory"];

/** Another folder for a file or folder of an agent: inside workspace/ or memory/, where the agent's memory names it, it's updated. */
export default function MoveSheet() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const { agent, path } = useLocalSearchParams<{ agent: string; path: string }>();
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (fullAccess === undefined) return <LoadingState />;
  return <MoveForm agent={agent} path={path} />;
}

function MoveForm({ agent, path }: { agent: string; path: string }) {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const [picked, setPicked] = useState(() => (parentOf(path).startsWith("memory") ? "memory" : "workspace"));
  const info = useQuery({ queryKey: fk.inspect(agent, [path]), queryFn: () => filesApi.inspect(agent, [path]), gcTime: 0, staleTime: 0 });
  const pins = pinsAmong(info.data?.[0]?.namedBy ?? []);
  const already = parentOf(path) === picked;

  const move = useMutation({
    mutationFn: () => filesApi.move(agent, path, joinPath(picked, nameOf(path))),
    onSuccess: (moved) => {
      refreshFiles(agent);
      router.back();
      fileChanged({ agentId: agent, moves: [{ from: path, to: moved.path }] });
      if (moved.rewritten.length) Alert.alert(t("move.moved", { name: nameOf(moved.path) }), t("move.pathUpdated", { files: moved.rewritten.join(", ") }));
    },
    onError: (err) => {
      refreshFiles(agent);
      Alert.alert(t("move.failed"), errorText(err));
    },
  });

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <SheetHeader
        title={t("move.title", { name: nameOf(path) })}
        action={pins.length ? t("move.moveAnyway") : t("move.moveHere")}
        ready={!already}
        busy={move.isPending}
        onAction={() => move.mutate()}
      />
      <Card style={{ overflow: "hidden", paddingVertical: space.xs }}>
        {ROOTS.map((root, i) => (
          <View key={root}>
            {i > 0 ? <Hairline inset={space.lg} /> : null}
            <FolderRow name={`${root}/`} depth={0} picked={picked === root} onPick={() => setPicked(root)} />
            <Tree agent={agent} dir={root} depth={1} picked={picked} onPick={setPicked} moving={path} />
          </View>
        ))}
      </Card>
      <T variant="footnote" muted numberOfLines={1} style={[styles.note, { fontFamily: fonts.mono }]}>
        {t("move.to", { dir: picked })}
      </T>
      {pins.length ? (
        <View style={[styles.warn, { backgroundColor: c.warningSoft }]}>
          <Icon name="warning" size={14} color={c.warning} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {t("move.notUpdated")}
            </T>
            <T variant="footnote" muted>
              {t("move.namedIn", { file: nameOf(path), names: pins.slice(0, 2).join(", ") })}
            </T>
            <T variant="footnote" muted>
              {t("move.changeHint")}
            </T>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** The folders inside `dir`, each unfolding its own; the folder being moved and tmp/ or uploads/ can't be picked. */
function Tree({ agent, dir, depth, picked, onPick, moving }: { agent: string; dir: string; depth: number; picked: string; onPick: (dir: string) => void; moving: string }) {
  const c = useColors();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const q = useQuery({ queryKey: fk.list(agent, dir), queryFn: () => filesApi.list(agent, dir) });
  if (q.isLoading) {
    return (
      <View style={{ paddingVertical: space.sm, paddingLeft: space.lg + depth * 18 }}>
        <ActivityIndicator size="small" color={c.textMuted} style={{ alignSelf: "flex-start" }} />
      </View>
    );
  }
  const dirs = (q.data ?? []).filter((e) => e.type === "dir" && !nameOf(e.path).startsWith("."));
  return (
    <>
      {dirs.map((e) => {
        const unfolded = open.has(e.path);
        const disabled = reservedPlace(e.path) || e.path === moving || e.path.startsWith(`${moving}/`);
        return (
          <View key={e.path}>
            <FolderRow
              name={nameOf(e.path)}
              depth={depth}
              picked={picked === e.path}
              disabled={disabled}
              unfolded={unfolded}
              onToggle={() =>
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(e.path)) next.delete(e.path);
                  else next.add(e.path);
                  return next;
                })
              }
              onPick={() => onPick(e.path)}
            />
            {unfolded ? <Tree agent={agent} dir={e.path} depth={depth + 1} picked={picked} onPick={onPick} moving={moving} /> : null}
          </View>
        );
      })}
    </>
  );
}

function FolderRow({
  name,
  depth,
  picked,
  disabled,
  unfolded,
  onToggle,
  onPick,
}: {
  name: string;
  depth: number;
  picked: boolean;
  disabled?: boolean;
  unfolded?: boolean;
  onToggle?: () => void;
  onPick: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("files");
  return (
    <View style={[styles.row, { paddingLeft: space.sm + depth * 18 }, picked && { backgroundColor: c.brandSoft }]}>
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unfolded ? t("move.fold") : t("move.unfold")}
          hitSlop={6}
          onPress={() => {
            tap();
            onToggle();
          }}
          style={styles.toggle}
        >
          <Icon name={unfolded ? "down" : "chevron"} size={11} color={c.textMuted} weight="semibold" />
        </Pressable>
      ) : (
        <View style={styles.toggle} />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: picked, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => {
          tap();
          onPick();
        }}
        style={({ pressed }) => [styles.pick, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Icon name="folder" size={16} color={picked ? c.brandStrong : c.textMuted} />
        <T variant="callout" numberOfLines={1} style={{ flex: 1, fontWeight: picked ? "600" : "400" }}>
          {name}
        </T>
        {picked ? <Icon name="check" size={13} color={c.brandStrong} weight="bold" /> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  note: { paddingHorizontal: space.xs },
  row: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingRight: space.md, marginHorizontal: space.xs, borderRadius: radius.md, borderCurve: "continuous" },
  toggle: { width: 28, height: 36, alignItems: "center", justifyContent: "center" },
  pick: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40 },
  warn: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, borderCurve: "continuous" },
});
