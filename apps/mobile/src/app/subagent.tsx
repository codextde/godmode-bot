import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { MessageBlock } from "@godmode/shared";
import { Markdown } from "@/components/markdown";
import { duration, Elapsed, SubagentAvatar, Thinking, ThinkingStep, ToolStep, useSubagentView, type ParentAgent } from "@/components/message";
import { EmptyState, ErrorState, LoadingState, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { useAgents } from "@/lib/hooks";
import { useChatRun, useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;

/** The subagent's call and its work, in the answer being written first, then the stored ones from the newest. */
function findSubagent(sources: { blocks: MessageBlock[]; live: boolean }[], id: string) {
  for (const { blocks, live } of sources) {
    const block = blocks.find((b): b is ToolUse => b.type === "tool_use" && b.id === id);
    if (block) return { block, children: blocks.filter((b) => "parentToolUseId" in b && b.parentToolUseId === id), live };
  }
  return null;
}

/** Everything a subagent did: each thought, step and note in order, then its report. */
export default function SubagentSheet() {
  const c = useColors();
  const { t } = useTranslation("components");
  const { conversationId = "", id = "" } = useLocalSearchParams<{ conversationId: string; id: string }>();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), enabled: !!conversationId });
  const draft = useLive((s) => s.drafts[conversationId]);
  const run = useChatRun(conversationId);
  const { byId } = useAgents();
  const agent = byId.get(conversation.data?.agentId ?? "");
  const found = useMemo(() => {
    const stored = [...(conversation.data?.messages ?? [])].reverse().map((m) => ({ blocks: m.blocks, live: !!run && m.runId === run.id }));
    return findSubagent([...(draft ? [{ blocks: draft.blocks, live: true }] : []), ...stored], id);
  }, [conversation.data?.messages, draft, run, id]);

  if (!found) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {conversation.isLoading ? (
          <LoadingState />
        ) : conversation.isError ? (
          <ErrorState title={t("subagentSheet.loadFailed")} error={errorText(conversation.error)} onRetry={() => void conversation.refetch()} />
        ) : (
          <EmptyState icon="subagent" title={t("subagentSheet.gone")} style={{ margin: space.xl }} />
        )}
      </View>
    );
  }
  return <Transcript block={found.block} childBlocks={found.children} streaming={found.live} agent={agent} />;
}

function Transcript({ block, childBlocks, streaming, agent }: { block: ToolUse; childBlocks: MessageBlock[]; streaming: boolean; agent?: ParentAgent }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const view = useSubagentView(block, childBlocks, streaming);
  const { task, background, running, failed, phase } = view;
  const meta = [background ? t("message.helper.background") : t("message.helper.helper"), view.type, ...view.stats].filter(Boolean).join(" · ");
  const steps = childBlocks.filter((b) => b.type === "tool_use" || b.type === "thinking" || (b.type === "text" && b.text.trim()));

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <SubagentAvatar agent={agent} phase={phase} size={44} seed={block.id} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={2}>
            {view.title}
          </T>
          <T variant="footnote" muted numberOfLines={2}>
            {meta}
          </T>
        </View>
        {running && task?.startedAt ? (
          <Elapsed since={task.startedAt} />
        ) : task?.durationMs ? (
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {duration(task.durationMs)}
          </T>
        ) : null}
      </View>
      {running || failed ? (
        <T variant="footnote" color={failed ? c.danger : c.textMuted} numberOfLines={3}>
          {view.status}
        </T>
      ) : null}
      {steps.length ? (
        <View style={[styles.steps, { borderLeftColor: c.border }]}>
          {steps.map((b, i) =>
            b.type === "tool_use" ? (
              <ToolStep key={b.id ?? i} step={b} />
            ) : b.type === "thinking" ? (
              <ThinkingStep key={i} text={b.text} />
            ) : b.type === "text" ? (
              <Markdown key={i} text={b.text} />
            ) : null,
          )}
        </View>
      ) : running ? (
        <Thinking />
      ) : null}
      {view.result ? (
        <View style={[styles.report, { backgroundColor: c.surface, borderColor: c.border }]}>
          <T variant="eyebrow" muted>
            {background ? t("message.helper.report") : t("message.helper.result")}
          </T>
          <Markdown text={view.result} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 56, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  steps: { gap: 14, paddingLeft: space.md, borderLeftWidth: 2 },
  report: {
    gap: 8,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
