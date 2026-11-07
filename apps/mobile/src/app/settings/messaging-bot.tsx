import { formatDistanceToNowStrict } from "date-fns";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  MESSAGING_PROVIDER_LABELS,
  type MessagingAccess,
  type MessagingConnection,
  type MessagingConnectionPatch,
  type MessagingUser,
  type MessagingUserStatus,
} from "@godmode/shared";
import { useLeaveSettings } from "@/components/agent-actions";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { FieldRow, Group, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { accessRows, useAgentChooserRows, botState, credentialRows, Initials } from "@/components/messaging-parts";
import { ListRow } from "@/components/readonly-list";
import { RowMenu, type MenuItem } from "@/components/secret-parts";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, TestResult } from "@/components/tool-form";
import { EmptyState, Skeleton, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { dateLocale, t as tr } from "@/lib/i18n";
import { useMessaging } from "@/lib/integrations";
import {
  botHandle,
  credentialsOf,
  downloadTeamsApp,
  EMPTY_FIELDS,
  messagingAdmin,
  mk,
  refreshMessaging,
  teamsEndpoint,
  updateBot,
  useBotChats,
  useBotUsers,
  type CredentialFields,
} from "@/lib/messaging-admin";
import { queryClient } from "@/lib/query";
import { saveOrShareFile } from "@/lib/save-file";
import { copyPlain, isCancelled } from "@/lib/secrets";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space, useColors } from "@/lib/theme";

const ago = (iso: string | null) => (iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() }) : null);

/** Settings → Messaging → a bot: whether it answers, its agents, who may write, the people and chats, its tokens (full access only). */
export default function MessagingBot() {
  const { t } = useTranslation("messaging");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useMessaging();
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: ["messaging"] }));
  const bot = list.data?.find((b) => b.id === id);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: bot?.name ?? "", headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <AdminQueryState query={list} errorTitle={t("loadFailed")}>
          {(bots) => {
            const b = bots.find((x) => x.id === id);
            return b ? <Bot key={b.id} bot={b} /> : <EmptyState icon="chats" title={t("bot.notFound")} />;
          }}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Bot({ bot: b }: { bot: MessagingConnection }) {
  const leave = useLeaveSettings();
  const { t } = useTranslation(["messaging", "common"]);
  const agents = useAgents();
  const users = useBotUsers(b.id);
  const chats = useBotChats(b.id);
  const platform = MESSAGING_PROVIDER_LABELS[b.provider];
  const state = botState(b);
  const people = users.data ?? [];
  const pending = b.access === "approved" ? people.filter((u) => u.status === "pending") : [];
  const others = people.filter((u) => !pending.includes(u));
  const list = (agents.data ?? []).filter((a) => a.enabled || b.agentIds.includes(a.id));

  const update = async (patch: MessagingConnectionPatch) => {
    const { credentials: _c, publicUrl: _p, ...shown } = patch;
    queryClient.setQueryData<MessagingConnection[]>(["messaging"], (all) => all?.map((x) => (x.id === b.id ? { ...x, ...shown } : x)));
    try {
      await updateBot(b.id, patch);
      return true;
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("bot.failed"), errorText(err));
      return false;
    } finally {
      refreshMessaging();
    }
  };

  const agentRows = useAgentChooserRows({
    agents: list,
    value: b.agentIds,
    defaultId: b.defaultAgentId,
    onChange: (agentIds, defaultAgentId) => {
      if (!agentIds.length) return Alert.alert(t("bot.keepOneAgent"), t("bot.keepOneAgentBody"));
      void update({ agentIds, defaultAgentId });
    },
  });

  const disconnect = () =>
    Alert.alert(t("bot.disconnectTitle", { name: b.name }), t("bot.disconnectBody", { platform }), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("bot.disconnect"),
        style: "destructive",
        onPress: async () => {
          try {
            await messagingAdmin.remove(b.id);
            refreshMessaging();
            router.back();
          } catch (err) {
            Alert.alert(t("bot.disconnectFailed"), errorText(err));
          }
        },
      },
    ]);

  const openIn = b.bot.url ? () => void Linking.openURL(b.bot.url!).catch(() => undefined) : null;

  return (
    <>
      <HeaderActions
        menu={[
          ...(openIn ? [{ icon: "external" as const, title: t("bot.openIn", { platform: b.provider === "teams" ? "Teams" : platform }), onPress: openIn }] : []),
          { icon: "trash", title: t("bot.disconnect"), destructive: true, onPress: disconnect },
        ]}
      />

      <Group>
        <InfoRow
          icon="pulse"
          label={platform}
          detail={[botHandle(b), b.status.state === "error" ? b.status.message : null].filter(Boolean).join("\n") || undefined}
          value={state.label}
          tone={state.tone}
        />
        <SwitchRow icon="power" title={t("bot.answering")} value={b.enabled} onChange={(enabled) => void update({ enabled })} />
        <FieldRow label={t("bot.name")} value={b.name} maxLength={100} onCommit={(name) => name.trim() && name.trim() !== b.name && void update({ name: name.trim() })} />
      </Group>

      {pending.length ? (
        <Group title={t("bot.waiting", { count: pending.length })}>
          {pending.map((u) => (
            <PendingRow key={u.id} bot={b} user={u} />
          ))}
        </Group>
      ) : null}

      <Group title={t("agents.title")}>
        {agents.isLoading ? (
          <View style={styles.loading}>
            <Skeleton height={14} width="60%" />
          </View>
        ) : (
          agentRows
        )}
      </Group>

      <Group title={t("access.title")}>
        {accessRows({ provider: b.provider, team: b.bot.team, value: b.access, onChange: (access: MessagingAccess) => void update({ access }) })}
      </Group>

      {b.provider === "teams" ? <TeamsGroup bot={b} onSave={(publicUrl) => update({ publicUrl })} /> : null}

      <Group title={t("bot.people")}>
        {users.isLoading ? (
          <View style={styles.loading}>
            <Skeleton height={14} width="50%" />
          </View>
        ) : others.length ? (
          others.map((u) => <PersonRow key={u.id} bot={b} user={u} />)
        ) : (
          <EmptyRow text={t("bot.noPeople")} />
        )}
      </Group>

      <Group title={t("bot.chats")}>
        {chats.isLoading ? (
          <View style={styles.loading}>
            <Skeleton height={14} width="50%" />
          </View>
        ) : chats.data?.length ? (
          chats.data.map((chat) => {
            const agent = chat.agentId ? agents.byId.get(chat.agentId) : undefined;
            return (
              <ListRow
                key={chat.id}
                grouped
                icon={chat.kind === "direct" ? "person" : "agents"}
                title={chat.title || (chat.kind === "direct" ? t("bot.directMessage") : t("bot.group"))}
                lines={[[agent ? t("bot.withAgent", { name: agent.name }) : null, ago(chat.lastMessageAt)].filter(Boolean).join(" · ")]}
                onPress={chat.conversationId ? () => leave(() => router.push({ pathname: "/chat/[id]", params: { id: chat.conversationId! } })) : undefined}
              />
            );
          })
        ) : (
          <EmptyRow text={t("bot.noChats")} />
        )}
      </Group>

      <TokensGroup bot={b} />
    </>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <T variant="subhead" muted>
        {text}
      </T>
    </View>
  );
}

async function setUserStatus(bot: MessagingConnection, user: MessagingUser, status: MessagingUserStatus) {
  queryClient.setQueryData<MessagingUser[]>(mk.users(bot.id), (list) => list?.map((u) => (u.id === user.id ? { ...u, status } : u)));
  try {
    await messagingAdmin.setUser(bot.id, user.id, status);
    if (status === "approved") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  } catch (err) {
    Alert.alert(tr("messaging:bot.failed"), errorText(err));
  } finally {
    refreshMessaging();
  }
}

function PendingRow({ bot, user: u }: { bot: MessagingConnection; user: MessagingUser }) {
  const c = useColors();
  const { t } = useTranslation("messaging");
  return (
    <View style={styles.person}>
      <Initials name={u.name} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {u.name}
        </T>
        <SubLine text={[u.username ? `@${u.username}` : null, u.lastSeenAt ? t("bot.wrote", { time: ago(u.lastSeenAt) }) : null].filter(Boolean).join(" · ")} />
      </View>
      <Pill label={t("bot.block")} onPress={() => void setUserStatus(bot, u, "blocked")} />
      <Pill label={t("bot.approve")} color={c.brandStrong} onPress={() => void setUserStatus(bot, u, "approved")} />
    </View>
  );
}

function SubLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <T variant="footnote" muted numberOfLines={1}>
      {text}
    </T>
  );
}

function Pill({ label, color, onPress }: { label: string; color?: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}
    >
      <T variant="footnote" color={color ?? c.text} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

function PersonRow({ bot, user: u }: { bot: MessagingConnection; user: MessagingUser }) {
  const c = useColors();
  const { t } = useTranslation(["messaging", "common"]);
  const blocked = u.status === "blocked";
  const tag = blocked ? t("person.blocked") : u.isOwner ? t("person.you") : u.status === "approved" ? t("person.approved") : bot.access === "anyone" ? t("person.openAccess") : null;

  const setOwner = async (isOwner: boolean) => {
    try {
      await messagingAdmin.setOwner(bot.id, u.id, isOwner);
    } catch (err) {
      Alert.alert(t("bot.failed"), errorText(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: mk.users(bot.id) });
    }
  };
  const forget = () =>
    Alert.alert(t("bot.forgetTitle", { name: u.name }), t("bot.forgetBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("bot.forget"),
        style: "destructive",
        onPress: async () => {
          try {
            await messagingAdmin.removeUser(bot.id, u.id);
          } catch (err) {
            Alert.alert(t("bot.failed"), errorText(err));
          } finally {
            refreshMessaging();
          }
        },
      },
    ]);

  const items: MenuItem[] = [
    ...(u.status !== "approved" ? [{ label: t("bot.approve"), icon: "check" as const, onPress: () => void setUserStatus(bot, u, "approved") }] : []),
    ...(u.status === "approved" ? [{ label: t("bot.takeBack"), icon: "reply" as const, onPress: () => void setUserStatus(bot, u, "pending") }] : []),
    ...(!blocked ? [{ label: t("bot.block"), icon: "octagon" as const, onPress: () => void setUserStatus(bot, u, "blocked") }] : []),
    ...(!blocked ? [{ label: u.isOwner ? t("bot.notMe") : t("bot.isMe"), icon: "personCircle" as const, onPress: () => void setOwner(!u.isOwner) }] : []),
    { label: t("bot.forget"), icon: "trash", destructive: true, onPress: forget },
  ];

  return (
    <View style={styles.person}>
      <Initials name={u.name} muted={blocked} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="callout" numberOfLines={1} color={blocked ? c.textMuted : c.text} style={[{ fontWeight: "500" }, blocked && { textDecorationLine: "line-through" }]}>
          {u.name}
        </T>
        <SubLine text={[u.username ? `@${u.username}` : null, u.lastSeenAt ? t("bot.active", { time: ago(u.lastSeenAt) }) : null].filter(Boolean).join(" · ")} />
      </View>
      {tag ? (
        <T variant="footnote" color={blocked ? c.danger : u.isOwner ? c.brandStrong : c.textMuted} style={{ fontWeight: u.isOwner ? "600" : "400" }}>
          {tag}
        </T>
      ) : null}
      <RowMenu label={t("bot.actionsFor", { name: u.name })} items={items} />
    </View>
  );
}

function TeamsGroup({ bot: b, onSave }: { bot: MessagingConnection; onSave: (publicUrl: string) => Promise<boolean> }) {
  const { t } = useTranslation("messaging");
  const endpoint = teamsEndpoint(b);
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      await saveOrShareFile(await downloadTeamsApp(b), "application/zip");
    } catch (err) {
      Alert.alert(t("bot.teamsAppFailed"), errorText(err));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Group title="Microsoft Teams">
      <FieldRow label={t("connect.publicUrl")} value={b.config.publicUrl ?? ""} placeholder="https://godmode.example.com" keyboardType="url" stacked onCommit={(v) => v.trim() !== (b.config.publicUrl ?? "") && void onSave(v.trim())} />
      {endpoint ? (
        <ListRow grouped icon="link" title={t("bot.endpoint")} lines={[endpoint]} trailing={<Pill label={t("bot.copy")} onPress={() => void copyPlain(endpoint)} />} />
      ) : (
        <InfoRow icon="link" label={t("bot.endpoint")} detail={t("bot.needPublicUrl")} />
      )}
      <ActionRow icon="share" title={t("bot.teamsApp")} busy={downloading} onPress={() => void download()} />
    </Group>
  );
}

/** New tokens for the same bot; the computer checks them before it keeps them. */
function TokensGroup({ bot: b }: { bot: MessagingConnection }) {
  const { t } = useTranslation(["messaging", "common"]);
  const prefilled: CredentialFields = { ...EMPTY_FIELDS, appId: b.config.appId ?? "", tenantId: b.config.tenantId ?? "" };
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<CredentialFields>(prefilled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credentials = credentialsOf(b.provider, fields);

  const close = () => {
    setOpen(false);
    setFields(prefilled);
    setError(null);
  };
  const save = async () => {
    if (!credentials) return Alert.alert(t("connect.fillEveryField"));
    setSaving(true);
    setError(null);
    try {
      await messagingAdmin.update(b.id, { credentials });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      close();
      Alert.alert(t("bot.tokensReplaced"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
      refreshMessaging();
    }
  };

  if (!open) {
    return (
      <Group title={t("connect.tokens")}>
        <ActionRow icon="key" title={t("bot.replaceTokens")} onPress={() => setOpen(true)} />
      </Group>
    );
  }
  return (
    <Group title={t("connect.tokens")}>
      {credentialRows(b.provider, fields, (key, value) => {
        setFields((f) => ({ ...f, [key]: value }));
        setError(null);
      })}
      <ActionRow icon="checkCircle" title={saving ? t("connect.checking") : t("bot.checkAndSave")} busy={saving} onPress={() => void save()} />
      {error && !saving ? <TestResult ok={false} title={t("connect.checkFailed")} body={error} /> : null}
      <ActionRow icon="close" title={t("common:actions.cancel")} onPress={close} />
    </Group>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  loading: {
    paddingHorizontal: space.lg,
    paddingVertical: 18,
  },
  empty: {
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  person: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  pill: {
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
});
