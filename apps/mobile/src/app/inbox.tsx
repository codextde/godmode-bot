import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, AppNotification, MissingLogin, MissingLoginKind, MissingLoginStatus } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { FilterChips } from "@/components/filter-chips";
import { Segmented } from "@/components/form";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { openHumanTask } from "@/components/human-task-row";
import { Icon, type IconName } from "@/components/icon";
import { ClosedList, type ClosedStatus } from "@/components/inbox-closed";
import { NotificationRow, openNotificationLink } from "@/components/notification-row";
import { ChatScope, QuestionCard } from "@/components/question-card";
import { openChat } from "@/components/rows";
import { openTask } from "@/components/task-row";
import { Badge, Button, Card, EmptyState, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import type { Need } from "@/lib/desktop-parity";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { useNeeds } from "@/lib/needs";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const NEED_ICON: Record<Need["kind"], IconName> = {
  question: "warning",
  todo: "person",
  login: "key",
  review: "check",
  blocked: "warning",
  paused: "pause",
  failed: "warning",
  automation: "workflow",
  access: "personCircle",
};

type Section = "question" | "todo" | "review" | "blocked" | "paused" | "problems" | "login" | "access";
type Filter = "all" | Section;

/** The order things are worked through in, like the desktop's Inbox: what stops an agent right now first. */
const SECTIONS: readonly Section[] = ["question", "todo", "review", "blocked", "paused", "problems", "login", "access"];

const sectionOf = (kind: Need["kind"]): Section => (kind === "failed" || kind === "automation" ? "problems" : kind);

const has = (text: string, query: string) => !query || text.toLowerCase().includes(query);

const LOGIN_KIND = {
  missing_credential: { labelKey: "login.kind.missingCredential", tone: "warning" },
  invalid_credential: { labelKey: "login.kind.invalidCredential", tone: "danger" },
  missing_totp: { labelKey: "login.kind.missingTotp", tone: "warning" },
  missing_account: { labelKey: "login.kind.missingAccount", tone: "neutral" },
  other: { labelKey: "login.kind.other", tone: "neutral" },
} as const satisfies Record<MissingLoginKind, { labelKey: string; tone: "warning" | "danger" | "neutral" }>;

/** What agents need from the human (questions, tasks, logins, reviews, runs that stand still or failed) and their updates, from every workspace. */
export default function Inbox() {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const { byId: agents } = useAgents();
  const needs = useNeeds({ logins: false });
  const notifications = useQuery({ queryKey: qk.notifications, queryFn: api.notifications.list });
  const pull = usePullRefresh(() => Promise.all([needs.refetch(), notifications.refetch()]));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<"open" | ClosedStatus>("open");
  const query = search.trim().toLowerCase();

  const agentName = useCallback((id: string | null) => (id ? (agents.get(id)?.name ?? "") : ""), [agents]);
  const searched = useMemo(() => needs.items.filter((n) => has(`${n.title} ${n.detail} ${agentName(n.agentId)}`, query)), [needs.items, query, agentName]);
  const logins = useMemo(
    () => (needs.missing.data ?? []).filter((m) => has(`${m.service} ${m.url ?? ""} ${m.reason} ${agentName(m.agentId)}`, query)),
    [needs.missing.data, query, agentName],
  );
  const counts = useMemo(() => {
    const n = new Map<Section, number>();
    for (const item of searched) n.set(sectionOf(item.kind), (n.get(sectionOf(item.kind)) ?? 0) + 1);
    if (logins.length) n.set("login", logins.length);
    return n;
  }, [searched, logins]);
  const shown = filter === "all" ? searched : searched.filter((n) => sectionOf(n.kind) === filter);
  const shownLogins = filter === "all" || filter === "login" ? logins : [];
  const total = needs.items.length + (needs.missing.data?.length ?? 0);
  const waiting = shown.length + shownLogins.length;
  const narrowed = filter !== "all" || !!query;
  const list = notifications.data;
  const shownNotifications = useMemo(() => (list ?? []).filter((n) => has(`${n.title} ${n.body}`, query)), [list, query]);
  const clearFilters = () => {
    setFilter("all");
    setSearch("");
  };

  return (
    <>
      <Stack.Title>{t("title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("search")} hideWhenScrolling onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <HeaderActions
        menu={[
          ...(list?.length ? [{ icon: "trash" as IconName, title: t("notifications.clear"), destructive: true, onPress: () => confirmClear(list.length) }] : []),
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl {...pull} />}
      >
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "open", label: t("tabs.open") },
            { value: "resolved", label: t("tabs.resolved") },
            { value: "dismissed", label: t("tabs.dismissed") },
          ]}
        />

        {tab !== "open" ? <ClosedList status={tab} query={query} /> : null}

        {tab === "open" && total > 0 && counts.size > 1 ? (
          <FilterChips
            bleed={space.lg}
            value={filter}
            onChange={setFilter}
            filters={[
              { id: "all", label: t("filters.all"), count: searched.length + logins.length },
              ...SECTIONS.filter((s) => counts.has(s) || filter === s).map((s) => ({ id: s, label: t(`filters.${s}`), count: counts.get(s) ?? 0 })),
            ]}
          />
        ) : null}

        {tab === "open" ? <View>
          <SectionTitle title={waiting ? t("attentionCount", { count: waiting }) : t("attention")} />
          {needs.loading ? (
            <Card>
              <SkeletonRows count={3} avatar={30} />
            </Card>
          ) : total === 0 ? (
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
          ) : waiting === 0 ? (
            <EmptyState
              icon="search"
              title={t("noMatch.title")}
              body={t("noMatch.body")}
              action={narrowed ? <Button title={t("noMatch.clear")} variant="secondary" onPress={clearFilters} /> : undefined}
            />
          ) : (
            <View style={{ gap: space.md }}>
              {shown.length > 0 && (
                <Card>
                  {shown.map((n, i) => (
                    <View key={n.id}>
                      {i > 0 && <Hairline inset={space.lg + 30 + space.md} />}
                      <NeedRow need={n} />
                    </View>
                  ))}
                </Card>
              )}
              {shownLogins.map((m) => (
                <LoginCard key={m.id} item={m} agent={m.agentId ? agents.get(m.agentId) : undefined} />
              ))}
            </View>
          )}
        </View> : null}

        {tab === "open" && filter === "all" ? (
          <Notifications
            list={query ? shownNotifications : notifications.data}
            loading={notifications.isLoading}
            error={notifications.isError ? errorText(notifications.error) : null}
            onRetry={() => void notifications.refetch()}
          />
        ) : null}
      </ScrollView>
    </>
  );
}

function NeedRow({ need: n }: { need: Need }) {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const { byId } = useAgents();
  const open = n.question
    ? () => openChat(n.question!.conversationId)
    : n.humanTask
      ? () => openHumanTask(n.humanTask!.id)
      : n.task
        ? () => openTask(n.task!.id)
        : n.kind === "automation" && n.routineId
          ? () => router.push({ pathname: "/automation/[id]", params: { id: n.routineId! } })
          : n.conversationId
            ? () => openChat(n.conversationId!)
            : undefined;
  const tone = n.kind === "review" ? "brand" : n.kind === "failed" || n.kind === "automation" ? "danger" : "warning";
  const tint = tone === "brand" ? { bg: c.brandSoft, fg: c.brandStrong } : tone === "danger" ? { bg: c.dangerSoft, fg: c.danger } : { bg: c.warningSoft, fg: c.warning };
  const question = n.question;
  return (
    <View>
      <Pressable accessibilityRole={open ? "button" : undefined} disabled={!open} onPress={open} style={({ pressed }) => [styles.need, question && styles.asked, pressed && { backgroundColor: c.sunken }]}>
        <View style={[styles.needIcon, { backgroundColor: tint.bg }]}>
          <Icon name={NEED_ICON[n.kind]} size={14} color={tint.fg} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={2}>
            {n.title}
          </T>
          {(n.detail && !question) || n.kind === "access" ? (
            <T variant="footnote" muted numberOfLines={2}>
              {n.kind === "access" ? [n.detail, t("onComputer")].filter(Boolean).join(" · ") : n.detail}
            </T>
          ) : null}
        </View>
        <T variant="caption" color={c.textFaint}>
          {shortTime(n.since)}
        </T>
      </Pressable>
      {question ? (
        <View style={styles.answer}>
          <ChatScope.Provider value={{ conversationId: question.conversationId, agentName: byId.get(question.agentId)?.name ?? t("anAgent"), openQuestionId: question.id }}>
            <QuestionCard inline question={{ ...question, type: "question", askedAt: question.createdAt }} />
          </ChatScope.Provider>
          <Row>
            <StopButton runId={question.runId} agent={byId.get(question.agentId)?.name ?? t("anAgent")} />
          </Row>
        </View>
      ) : n.kind === "paused" && n.conversationId ? (
        <Row style={styles.rowActions}>
          <ContinueButton conversationId={n.conversationId} />
        </Row>
      ) : null}
    </View>
  );
}

/** Stops the run behind a question: the question is withdrawn, like the desktop's Stop. */
function StopButton({ runId, agent }: { runId: string; agent: string }) {
  const c = useColors();
  const { t } = useTranslation(["inbox", "common"]);
  const stop = useMutation({
    mutationFn: () => api.runs.cancel(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.questions });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (err) => Alert.alert(t("stop.failed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const confirm = () => {
    tap();
    Alert.alert(t("stop.title"), t("stop.body", { agent }), [
      { text: t("stop.keep"), style: "cancel" },
      { text: t("stop.confirm"), style: "destructive", onPress: () => stop.mutate() },
    ]);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("stop.label")}
      accessibilityState={{ busy: stop.isPending }}
      disabled={stop.isPending}
      onPress={confirm}
      style={({ pressed }) => [styles.pill, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
    >
      {stop.isPending ? <ActivityIndicator size="small" color={c.text} /> : <Icon name="stop" size={10} color={c.text} />}
      <T variant="footnote" style={{ fontWeight: "600" }}>
        {t("common:actions.stop")}
      </T>
    </Pressable>
  );
}

function ContinueButton({ conversationId }: { conversationId: string }) {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(conversationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: (err) => Alert.alert(t("continueFailed"), errorText(err)),
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: resume.isPending }}
      disabled={resume.isPending}
      onPress={() => {
        tap();
        resume.mutate();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: c.primary, opacity: pressed ? 0.7 : 1 }]}
    >
      {resume.isPending ? <ActivityIndicator size="small" color={c.onPrimary} /> : <Icon name="play" size={10} color={c.onPrimary} />}
      <T variant="footnote" color={c.onPrimary} style={{ fontWeight: "600" }}>
        {t("continue")}
      </T>
    </Pressable>
  );
}

function confirmClear(count: number) {
  Alert.alert(t("inbox:notifications.clearTitle"), t("inbox:notifications.clearBody", { count }), [
    { text: t("common:actions.cancel"), style: "cancel" },
    { text: t("inbox:notifications.clearAll"), style: "destructive", onPress: clearNotifications },
  ]);
}

function clearNotifications() {
  tap();
  void queryClient.cancelQueries({ queryKey: qk.notifications });
  const previous = queryClient.getQueryData<AppNotification[]>(qk.notifications);
  queryClient.setQueryData<AppNotification[]>(qk.notifications, []);
  api.notifications
    .clear()
    .catch((err) => {
      if (previous) queryClient.setQueryData(qk.notifications, previous);
      Alert.alert(t("inbox:notifications.clearFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));
    })
    .finally(() => {
      void queryClient.invalidateQueries({ queryKey: qk.notifications });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    });
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
  const { fullAccess } = useFullAccess();
  const kind = LOGIN_KIND[item.kind] ?? LOGIN_KIND.other;
  // Like the desktop: a missing 2FA code is picked from the vault, anything else gets a login (resolved once saved).
  const act =
    item.kind === "missing_totp"
      ? { title: t("loginActions.add2fa"), icon: "shield" as const, open: () => router.push({ pathname: "/vault/link-totp", params: { id: item.id } }) }
      : {
          title: item.kind === "invalid_credential" ? t("loginActions.updateLogin") : t("loginActions.addLogin"),
          icon: "key" as const,
          open: () => router.push({ pathname: "/vault/login-edit", params: { missingLoginId: item.id } }),
        };
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
      {fullAccess === false ? (
        <T variant="footnote" muted>
          {t("login.addOnComputer")}
        </T>
      ) : null}
      <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
        {fullAccess ? <LoginButton
            title={act.title}
            icon={act.icon}
            primary
            onPress={() => {
              tap();
              act.open();
            }}
          /> : null}
        <LoginButton title={t("login.dismiss")} icon="close" onPress={() => setLoginStatus(item, "dismissed")} />
        <LoginButton title={t("login.markResolved")} icon="check" onPress={() => setLoginStatus(item, "resolved")} />
      </Row>
    </Card>
  );
}

function LoginButton({ title, icon, onPress, primary }: { title: string; icon: IconName; onPress: () => void; primary?: boolean }) {
  const c = useColors();
  const fg = primary ? c.onPrimary : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.loginButton, { backgroundColor: primary ? c.primary : c.sunken, opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} size={12} color={fg} weight="semibold" />
      <T variant="footnote" color={fg} style={{ fontWeight: "600" }}>
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
  asked: {
    alignItems: "center",
    paddingBottom: space.sm,
  },
  answer: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
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
  rowActions: {
    gap: space.sm,
    paddingLeft: space.lg + 30 + space.md,
    paddingBottom: space.md,
    marginTop: -6,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
});
