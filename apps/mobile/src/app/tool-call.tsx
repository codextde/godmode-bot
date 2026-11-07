import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/icon";
import { CopyButton } from "@/components/markdown-parts";
import { EmptyState, ErrorState, LoadingState, Row as Line, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { toolLabel } from "@/lib/format";
import { radius, space, useColors } from "@/lib/theme";
import { fileEditOf, RESULT_PREVIEW, takeToolCall, textChunks, todoItems, toolInputText, type DiffRow } from "@/lib/tool-details";

type Row =
  | { key: string; kind: "label"; label: string; copy: string; copyLabel: string; added?: number; removed?: number }
  | { key: string; kind: "text"; text: string; error?: boolean; first: boolean; last: boolean }
  | { key: string; kind: "diff"; line: DiffRow; first: boolean; last: boolean }
  | { key: string; kind: "todo"; text: string; status: string; first: boolean; last: boolean }
  | { key: string; kind: "toggle"; label: string }
  | { key: string; kind: "loading" }
  | { key: string; kind: "failed"; error: string };

const panel = (key: string, kind: "text", texts: string[], error?: boolean): Row[] =>
  texts.map((text, i) => ({ key: `${key}-${i}`, kind, text, error, first: i === 0, last: i === texts.length - 1 }));

/** One tool call in full: its input, whole output and whole diff. Long output comes from the computer when this opens. */
export default function ToolCallSheet() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { id = "", conversationId = "", messageId = "" } = useLocalSearchParams<{ id: string; conversationId?: string; messageId?: string }>();
  const [given] = useState(() => takeToolCall(id));
  const stored = !!conversationId && !!messageId;
  const whole = useQuery({
    queryKey: ["tool-call", conversationId, messageId, id],
    queryFn: () => api.conversations.toolCall(conversationId, messageId, id),
    enabled: stored && (!given || !!given.resultTruncated),
    retry: 1,
  });
  const block = whole.data ?? given;
  const cut = stored && !!block?.resultTruncated && !whole.data;
  const [full, setFull] = useState(false);

  const rows = useMemo<Row[]>(() => {
    if (!block) return [];
    const out: Row[] = [];
    const edit = fileEditOf(block);
    const result = block.result ?? "";
    if (edit) {
      out.push({
        key: "diff",
        kind: "label",
        label: edit.file.split("/").pop() || t("toolCall.file"),
        copy: edit.rows.map((r) => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "} ${r.text}`).join("\n"),
        copyLabel: t("toolCall.copyDiff"),
        added: edit.added,
        removed: edit.removed,
      });
      edit.rows.forEach((line, i) => out.push({ key: `d-${i}`, kind: "diff", line, first: i === 0, last: i === edit.rows.length - 1 }));
      if (!edit.rows.length) out.push(...panel("d", "text", [t("toolCall.empty")]));
    } else {
      const todos = todoItems(block.input);
      const input = toolInputText(block.input);
      if (todos) todos.forEach((todo, i) => out.push({ key: `t-${i}`, kind: "todo", text: todo.content, status: todo.status, first: i === 0, last: i === todos.length - 1 }));
      else if (input && input !== "{}") {
        out.push({ key: "input", kind: "label", label: t("toolCall.input"), copy: input, copyLabel: t("toolCall.copyInput") });
        out.push(...panel("i", "text", textChunks(input)));
      }
    }
    if (block.result !== undefined && (!edit || block.isError)) {
      const failed = !!block.isError;
      const long = result.length > RESULT_PREVIEW;
      const shown = full || !long ? result : `${result.slice(0, RESULT_PREVIEW)}…`;
      out.push({ key: "result", kind: "label", label: failed ? t("toolCall.error") : t("toolCall.result"), copy: result, copyLabel: failed ? t("toolCall.copyError") : t("toolCall.copyResult") });
      out.push(...panel("r", "text", textChunks(shown || t("toolCall.empty")), failed));
      if (cut) out.push(whole.isError ? { key: "failed", kind: "failed", error: errorText(whole.error) } : { key: "loading", kind: "loading" });
      else if (long) out.push({ key: "toggle", kind: "toggle", label: full ? t("common:actions.showLess") : t("toolCall.showAll", { k: Math.round(result.length / 1000) }) });
    }
    return out;
  }, [block, full, cut, whole.isError, whole.error, t]);

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item }) => {
      switch (item.kind) {
        case "label":
          return <PanelTitle row={item} />;
        case "text":
          return (
            <View style={[styles.panel, { backgroundColor: c.sunken }, item.first && styles.top, item.last && styles.bottom]}>
              <T variant="mono" selectable color={item.error ? c.danger : c.textMuted} style={styles.mono}>
                {item.text}
              </T>
            </View>
          );
        case "diff":
          return <Diff row={item} />;
        case "todo":
          return (
            <View style={[styles.panel, { backgroundColor: c.sunken }, item.first && styles.top, item.last && styles.bottom]}>
              <Line style={{ gap: 8, alignItems: "flex-start" }}>
                <Icon
                  name={item.status === "completed" ? "check" : item.status === "in_progress" ? "play" : "minus"}
                  size={10}
                  color={item.status === "completed" ? c.brandStrong : item.status === "in_progress" ? c.text : c.textFaint}
                  weight="bold"
                  style={{ marginTop: 4 }}
                />
                <T variant="footnote" muted={item.status !== "in_progress"} style={[{ flex: 1 }, item.status === "completed" && { textDecorationLine: "line-through" }]}>
                  {item.text}
                </T>
              </Line>
            </View>
          );
        case "toggle":
          return (
            <Pressable accessibilityRole="button" onPress={() => setFull((f) => !f)} hitSlop={8} style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.6 }]}>
              <T variant="footnote" style={{ fontWeight: "600" }}>
                {item.label}
              </T>
            </Pressable>
          );
        case "loading":
          return (
            <View style={styles.toggle}>
              <ActivityIndicator size="small" color={c.textFaint} />
              <T variant="footnote" muted>
                {t("toolCall.loadingWhole")}
              </T>
            </View>
          );
        default:
          return (
            <Pressable accessibilityRole="button" onPress={() => void whole.refetch()} style={styles.failed}>
              <T variant="footnote" muted>
                {t("toolCall.wholeFailed")}
              </T>
              <T variant="footnote" style={{ fontWeight: "600" }}>
                {t("common:actions.tryAgain")}
              </T>
            </Pressable>
          );
      }
    },
    [c, t, whole],
  );

  if (!block) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        {whole.isError ? <ErrorState title={t("toolCall.loadFailed")} error={errorText(whole.error)} onRetry={() => void whole.refetch()} /> : stored ? <LoadingState /> : <EmptyState icon="warning" title={t("toolCall.gone")} />}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        ListHeaderComponent={<Head step={block} />}
        showsVerticalScrollIndicator
      />
    </View>
  );
}

function Head({ step }: { step: Parameters<typeof toolLabel>[0] & { isError?: boolean } }) {
  const c = useColors();
  const label = toolLabel(step);
  return (
    <View style={styles.head}>
      <View style={[styles.icon, { backgroundColor: c.sunken }]}>
        <Icon name={label.icon} size={15} color={step.isError ? c.warning : c.textMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="headline">{label.title}</T>
        {label.detail ? (
          <T variant="footnote" muted selectable>
            {label.detail}
          </T>
        ) : null}
      </View>
    </View>
  );
}

function PanelTitle({ row }: { row: Extract<Row, { kind: "label" }> }) {
  const c = useColors();
  return (
    <View style={styles.label}>
      <T variant={row.added === undefined ? "eyebrow" : "caption"} muted numberOfLines={1} style={{ flexShrink: 1 }}>
        {row.label}
      </T>
      {row.added !== undefined ? (
        <T variant="caption" color={c.success} style={styles.stat}>
          +{row.added}
        </T>
      ) : null}
      {row.removed !== undefined ? (
        <T variant="caption" color={c.danger} style={styles.stat}>
          -{row.removed}
        </T>
      ) : null}
      <View style={{ flex: 1 }} />
      <CopyButton text={row.copy} label={row.copyLabel} />
    </View>
  );
}

function Diff({ row }: { row: Extract<Row, { kind: "diff" }> }) {
  const c = useColors();
  const { kind, text } = row.line;
  const tint = kind === "add" ? c.successSoft : kind === "del" ? c.dangerSoft : c.sunken;
  return (
    <View style={[styles.line, { backgroundColor: tint }, row.first && styles.top, row.last && styles.bottom]}>
      <T variant="mono" selectable color={kind === "same" || kind === "fold" ? c.textFaint : c.text} style={styles.mono}>
        {kind === "add" ? "+ " : kind === "del" ? "- " : kind === "fold" ? "" : "  "}
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", padding: space.lg },
  content: { paddingHorizontal: space.xl, paddingTop: 28, paddingBottom: 56 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingBottom: space.sm },
  icon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  label: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.lg, paddingBottom: space.sm, paddingHorizontal: 2 },
  stat: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  panel: { paddingHorizontal: 12, paddingVertical: 3 },
  line: { paddingHorizontal: 12, paddingVertical: 1 },
  top: { borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm, paddingTop: 10 },
  bottom: { borderBottomLeftRadius: radius.sm, borderBottomRightRadius: radius.sm, paddingBottom: 10 },
  mono: { fontSize: 12, lineHeight: 17 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.md },
  failed: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, paddingVertical: space.md },
});
