import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentQuestion, MissingLogin } from "@godmode/shared";
import { Icon } from "./icon";
import { openChat } from "./rows";
import { Card, EmptyState, ErrorState, Hairline, SkeletonRows, T, tap } from "./ui";
import { RowPressable } from "./row-pressable";
import { api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

export type ClosedStatus = "resolved" | "dismissed";

const QUESTION_STATUS = { resolved: "resolved", dismissed: "withdrawn" } as const;
const PAGE = 25;

export const closedLogins = (status: ClosedStatus) => [...qk.missingLogins, status];
export const closedQuestions = (status: ClosedStatus) => [...qk.questions, status];

/** Resolved and dismissed: what was handled, for reference, newest first; a login request can be opened again. */
export function ClosedList({ status, query }: { status: ClosedStatus; query: string }) {
  const { t } = useTranslation("inbox");
  const logins = useQuery({ queryKey: closedLogins(status), queryFn: () => api.missingLogins.list(status) });
  const questions = useQuery({ queryKey: closedQuestions(status), queryFn: () => api.questions.list(QUESTION_STATUS[status]) });
  const [limit, setLimit] = useState(PAGE);
  const entries = useMemo(
    () =>
      [
        ...(logins.data ?? []).filter((m) => !query || `${m.service} ${m.reason} ${m.url ?? ""}`.toLowerCase().includes(query)).map((item) => ({ kind: "login" as const, item, at: item.updatedAt })),
        ...(questions.data ?? []).filter((q) => !query || q.title.toLowerCase().includes(query)).map((item) => ({ kind: "question" as const, item, at: item.answer?.at ?? item.updatedAt })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [logins.data, questions.data, query],
  );

  if (logins.isLoading && questions.isLoading) {
    return (
      <Card>
        <SkeletonRows count={4} avatar={30} />
      </Card>
    );
  }
  if (logins.isError && !questions.data?.length) return <ErrorState title={t("closed.loadFailed")} error={errorText(logins.error)} onRetry={() => void logins.refetch()} />;
  if (!entries.length) return <EmptyState icon={status === "resolved" ? "checkCircle" : "archive"} title={t(`closed.empty.${status}`)} />;
  const rest = entries.length - limit;
  return (
    <Card>
      {entries.slice(0, limit).map((e, i) => (
        <View key={e.item.id}>
          {i > 0 && <Hairline inset={space.lg} />}
          {e.kind === "login" ? <LoginRow login={e.item} status={status} /> : <QuestionRow question={e.item} />}
        </View>
      ))}
      {rest > 0 ? (
        <>
          <Hairline />
          <Pressable accessibilityRole="button" onPress={() => setLimit((l) => l + PAGE)} style={styles.more}>
            <T variant="footnote" muted style={{ fontWeight: "600" }}>
              {t("notifications.showMore", { count: Math.min(PAGE, rest) })}
            </T>
          </Pressable>
        </>
      ) : null}
    </Card>
  );
}

function LoginRow({ login, status }: { login: MissingLogin; status: ClosedStatus }) {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const { byId } = useAgents();
  const [busy, setBusy] = useState(false);
  const agent = login.agentId ? byId.get(login.agentId) : undefined;

  const reopen = () => {
    tap();
    setBusy(true);
    api.missingLogins
      .setStatus(login.id, "open")
      .then(() => {
        queryClient.setQueryData<MissingLogin[]>(closedLogins(status), (list) => list?.filter((m) => m.id !== login.id));
        void queryClient.invalidateQueries({ queryKey: qk.missingLogins });
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      })
      .catch((err) => Alert.alert(t("login.updateFailed"), errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={1}>
          {login.service || login.url || t("login.unknownService")}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {[login.reason, agent?.name].filter(Boolean).join(" · ")}
        </T>
      </View>
      <T variant="caption" color={c.textFaint}>
        {shortTime(login.updatedAt)}
      </T>
      <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={reopen} style={({ pressed }) => [styles.pill, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}>
        {busy ? <ActivityIndicator size="small" color={c.text} /> : <Icon name="refresh" size={11} color={c.text} />}
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {t("closed.reopen")}
        </T>
      </Pressable>
    </View>
  );
}

function QuestionRow({ question }: { question: AgentQuestion }) {
  const c = useColors();
  const { byId } = useAgents();
  const agent = byId.get(question.agentId);
  return (
    <RowPressable accessibilityRole="button" onPress={() => openChat(question.conversationId)} style={styles.row}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={2}>
          {question.title}
        </T>
        {agent ? (
          <T variant="footnote" muted numberOfLines={1}>
            {agent.name}
          </T>
        ) : null}
      </View>
      <T variant="caption" color={c.textFaint}>
        {shortTime(question.answer?.at ?? question.updatedAt)}
      </T>
    </RowPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.lg },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 12, borderRadius: radius.pill },
  more: { alignItems: "center", paddingVertical: space.md },
});
