import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, AppNotification, MissingLogin, MissingLoginKind, MissingLoginStatus } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { openHumanTask } from "@/components/human-task-row";
import { Icon, type IconName } from "@/components/icon";
import { NotificationRow, openNotificationLink } from "@/components/notification-row";
import { openChat } from "@/components/rows";
import { openTask } from "@/components/task-row";
import { Badge, Card, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { needsYou, type Need } from "@/lib/desktop-parity";
import { shortTime } from "@/lib/format";
import { useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const NEED_ICON: Record<Need["kind"], IconName> = { question: "warning", todo: "person", login: "key", review: "check", blocked: "warning" };

const LOGIN_KIND = {
  missing_credential: { labelKey: "login.kind.missingCredential", tone: "warning" },
  invalid_credential: { labelKey: "login.kind.invalidCredential", tone: "danger" },
  missing_totp: { labelKey: "login.kind.missingTotp", tone: "warning" },
  missing_account: { labelKey: "login.kind.missingAccount", tone: "neutral" },
  other: { labelKey: "login.kind.other", tone: "neutral" },
} as const satisfies Record<MissingLoginKind, { labelKey: string; tone: "warning" | "danger" | "neutral" }>;

/** What agents need from the human (questions, tasks, logins, reviews) and their updates, from every workspace. */
export default function Inbox() {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const { byId: agents } = useAgents();
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const humanTasks = useOpenHumanTasks();
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const tasks = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({}) });
  const notifications = useQuery({ queryKey: qk.notifications, queryFn: api.notifications.list });
  const pull = usePullRefresh(() =>
    Promise.all([questions.refetch(), humanTasks.refetch(), missing.refetch(), tasks.refetch(), notifications.refetch()]),
  );

  const needs = useMemo(
    () =>
      needsYou({
        questions: questions.data ?? [],
        humanTasks: humanTasks.data ?? [],
        missing: [],
        tasks: tasks.data ?? [],
        nameOf: (id) => (id ? (agents.get(id)?.name ?? t("anAgent")) : t("anAgent")),
      }),
    [questions.data, humanTasks.data, tasks.data, agents, t],
  );
  const logins = missing.data ?? [];
  const loading = questions.isLoading && humanTasks.isLoading && missing.isLoading;
  const waiting = needs.length + logins.length;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Title>{t("title")}</Stack.Title>

      <View>
        <SectionTitle title={waiting ? t("attentionCount", { count: waiting }) : t("attention")} />
        {loading ? (
          <Card>
            <SkeletonRows count={3} avatar={30} />
          </Card>
        ) : waiting === 0 ? (
          <Card style={styles.clear}>
            <Icon name="check" size={16} color={c.success} />
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="subhead" style={{ fontWeight: "600" }}>
                {t("allClear")}
              </T>
              <T variant="footnote" muted>
                {t("allClearBody")}
              </T>
            </View>
          </Card>
        ) : (
          <View style={{ gap: space.md }}>
            {needs.length > 0 && (
              <Card>
                {needs.map((n, i) => (
                  <View key={n.id}>
                    {i > 0 && <Hairline inset={space.lg + 30 + space.md} />}
                    <NeedRow need={n} />
                  </View>
                ))}
              </Card>
            )}
            {logins.map((m) => (
              <LoginCard key={m.id} item={m} agent={m.agentId ? agents.get(m.agentId) : undefined} />
            ))}
          </View>
        )}
      </View>

      <Notifications list={notifications.data} loading={notifications.isLoading} error={notifications.isError ? errorText(notifications.error) : null} onRetry={() => void notifications.refetch()} />
    </ScrollView>
  );
}

function NeedRow({ need: n }: { need: Need }) {
  const c = useColors();
  const open = n.question
    ? () => openChat(n.question!.conversationId)
    : n.humanTask
      ? () => openHumanTask(n.humanTask!.id)
      : n.task
        ? () => openTask(n.task!.id)
        : undefined;
  return (
    <Pressable accessibilityRole={open ? "button" : undefined} disabled={!open} onPress={open} style={({ pressed }) => [styles.need, pressed && { backgroundColor: c.sunken }]}>
      <View style={[styles.needIcon, { backgroundColor: n.kind === "review" ? c.brandSoft : c.warningSoft }]}>
        <Icon name={NEED_ICON[n.kind]} size={14} color={n.kind === "review" ? c.brandStrong : c.warning} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={2}>
          {n.title}
        </T>
        {n.detail ? (
          <T variant="footnote" muted numberOfLines={2}>
            {n.detail}
          </T>
        ) : null}
      </View>
      <T variant="caption" color={c.textFaint}>
        {shortTime(n.since)}
      </T>
    </Pressable>
  );
}

/** Removes the request from the open list right away and puts it back if the computer refuses. */
function setLoginStatus(item: MissingLogin, status: MissingLoginStatus) {
  tap();
  void queryClient.cancelQueries({ queryKey: qk.missingLogins });
  const previous = queryClient.getQueryData<MissingLogin[]>(qk.missingLogins);
  queryClient.setQueryData<MissingLogin[]>(qk.missingLogins, (list) => list?.filter((m) => m.id !== item.id));
  api.missingLogins
    .setStatus(item.id, status)
    .catch((err) => {
      if (previous) queryClient.setQueryData(qk.missingLogins, previous);
      Alert.alert(t("inbox:login.updateFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));
    })
    .finally(() => {
      void queryClient.invalidateQueries({ queryKey: qk.missingLogins });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    });
}

function LoginCard({ item, agent }: { item: MissingLogin; agent?: Agent }) {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const kind = LOGIN_KIND[item.kind] ?? LOGIN_KIND.other;
  const kindLabel = t(kind.labelKey);
  return (
    <Card style={[styles.login, { borderColor: kind.tone === "danger" ? c.danger : c.border }]}>
      <Row style={{ gap: space.sm, alignItems: "flex-start" }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
            {item.service || item.url || t("login.unknownService")}
          </T>
          {item.url ? (
            <T variant="caption" muted numberOfLines={1}>
              {item.url}
            </T>
          ) : null}
        </View>
        <Badge label={item.occurrences > 1 ? `${kindLabel} ×${item.occurrences}` : kindLabel} tone={kind.tone} />
      </Row>
      {item.reason ? (
        <T variant="subhead" selectable>
          {item.reason}
        </T>
      ) : null}
      <Row style={{ gap: 6 }}>
        {agent ? <CharacterAvatar agent={agent} size={18} mood="attention" /> : null}
        <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
          {agent ? t("login.reportedBy", { name: agent.name }) : item.agentId ? t("login.reportedByAgent") : t("login.reportedByGodmode")} · {shortTime(item.updatedAt || item.createdAt)}
        </T>
      </Row>
      <T variant="footnote" muted>
        {t("login.addOnComputer")}
      </T>
      <Row style={{ gap: space.sm }}>
        <LoginButton title={t("login.dismiss")} icon="close" onPress={() => setLoginStatus(item, "dismissed")} />
        <LoginButton title={t("login.markResolved")} icon="check" onPress={() => setLoginStatus(item, "resolved")} />
      </Row>
    </Card>
  );
}

function LoginButton({ title, icon, onPress }: { title: string; icon: IconName; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.loginButton, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}>
      <Icon name={icon} size={12} color={c.text} weight="semibold" />
      <T variant="footnote" style={{ fontWeight: "600" }}>
        {title}
      </T>
    </Pressable>
  );
}

function markRead(ids: string[] | "all") {
  void queryClient.cancelQueries({ queryKey: qk.notifications });
  const previous = queryClient.getQueryData<AppNotification[]>(qk.notifications);
  queryClient.setQueryData<AppNotification[]>(qk.notifications, (list) => list?.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, read: true } : n)));
  api.notifications
    .read(ids)
    .then(
      () => {
        void queryClient.invalidateQueries({ queryKey: qk.notifications });
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      },
      (err) => {
        // An older computer refuses this route; the phone keeps them read until the next refresh.
        if (err instanceof ApiError && err.code === "device_forbidden") return;
        if (previous) queryClient.setQueryData(qk.notifications, previous);
        Alert.alert(t("inbox:notifications.markReadFailed"), errorText(err));
        void queryClient.invalidateQueries({ queryKey: qk.notifications });
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      },
    );
}

const PAGE = 15;

function Notifications({ list, loading, error, onRetry }: { list?: AppNotification[]; loading: boolean; error: string | null; onRetry: () => void }) {
  const { t } = useTranslation("inbox");
  const [limit, setLimit] = useState(PAGE);
  const items = list ?? [];
  const unread = items.filter((n) => !n.read).length;
  const open = (n: AppNotification) => {
    if (!n.read) markRead([n.id]);
    openNotificationLink(n.link);
  };
  return (
    <View>
      <SectionTitle
        title={unread ? t("notifications.titleNew", { count: unread }) : t("notifications.title")}
        action={unread ? t("notifications.markAllRead") : undefined}
        onAction={() => {
          tap();
          markRead("all");
        }}
      />
      <Card>
        {loading ? (
          <SkeletonRows count={4} avatar={30} />
        ) : error && !items.length ? (
          <ErrorState title={t("notifications.loadFailed")} error={error} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <T variant="subhead" muted style={{ padding: space.lg }}>
            {t("notifications.empty")}
          </T>
        ) : (
          <>
            {items.slice(0, limit).map((n, i) => (
              <View key={n.id}>
                {i > 0 && <Hairline inset={space.lg + 30 + space.md} />}
                <NotificationRow notification={n} onOpen={() => open(n)} />
              </View>
            ))}
            {items.length > limit ? (
              <>
                <Hairline />
                <Pressable accessibilityRole="button" onPress={() => setLimit((l) => l + PAGE)} style={styles.more}>
                  <T variant="footnote" muted style={{ fontWeight: "600" }}>
                    {t("notifications.showMore", { count: Math.min(PAGE, items.length - limit) })}
                  </T>
                </Pressable>
              </>
            ) : null}
          </>
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.xl,
  },
  clear: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  need: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
  },
  needIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  login: {
    gap: space.md,
    padding: space.lg,
  },
  loginButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  more: {
    alignItems: "center",
    paddingVertical: space.md,
  },
});
