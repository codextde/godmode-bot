import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MESSAGING_PROVIDER_LABELS, MESSAGING_PROVIDERS, type MessagingConnection, type MessagingProvider } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { BotStateBadge, PlatformLogo } from "@/components/messaging-parts";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { EmptyState, ErrorState, SkeletonRows, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { ik, useMessaging } from "@/lib/integrations";
import { botHandle, refreshMessaging, updateBot } from "@/lib/messaging-admin";
import { queryClient } from "@/lib/query";
import { isCancelled } from "@/lib/secrets";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

/** Bots people use to talk to agents from Telegram, Slack or Teams. A full-access phone connects and manages them like the desktop. */
export default function Messaging() {
  const { fullAccess } = useFullAccess();
  return fullAccess ? <MessagingAdmin /> : <MessagingReadonly />;
}

function MessagingReadonly() {
  const { t } = useTranslation("integrations");
  const list = useMessaging();
  return (
    <ReadonlyList<MessagingConnection>
      title={t("messaging.title")}
      query={list}
      items={list.data ?? []}
      keyOf={(m) => m.id}
      icon="chats"
      emptyTitle={t("messaging.emptyTitle")}
      emptyBody={t("messaging.emptyBody")}
      failedTitle={t("messaging.loadFailed")}
      renderRow={(m) => {
        const bot = m.bot.username ? `@${m.bot.username}` : m.bot.team || m.bot.name;
        return (
          <ListRow
            icon="chats"
            title={m.name}
            lines={[
              [MESSAGING_PROVIDER_LABELS[m.provider], bot].filter(Boolean).join(" · "),
              m.status.state === "error" ? m.status.message : m.pendingUsers ? t("messaging.waiting", { count: m.pendingUsers }) : null,
            ]}
            trailing={<BotStateBadge connection={m} />}
          />
        );
      }}
    />
  );
}

function MessagingAdmin() {
  const { t } = useTranslation(["messaging", "integrations", "vault"]);
  const list = useMessaging();
  const pull = usePullRefresh(list.refetch);
  const bots = list.data ?? [];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("integrations:messaging.title") }} />
      <CloseButton />
      {list.isLoading ? (
        <SkeletonRows count={4} avatar={30} />
      ) : isOutdated(list.error) ? (
        <EmptyState icon="chats" title={t("vault:list.outdatedTitle")} body={t("vault:list.outdatedBody")} />
      ) : list.isError ? (
        <ErrorState title={t("integrations:messaging.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : (
        <View style={{ gap: space.xl }}>
          {bots.length ? (
            <Group title={t("yourBots")}>
              {bots.map((b) => (
                <BotRow key={b.id} bot={b} />
              ))}
            </Group>
          ) : null}
          <Group title={bots.length ? t("addPlatform") : t("platforms")}>
            {MESSAGING_PROVIDERS.map((p) => (
              <ProviderRow key={p} provider={p} bots={bots.filter((b) => b.provider === p)} />
            ))}
          </Group>
        </View>
      )}
    </ScrollView>
  );
}

function ProviderRow({ provider, bots }: { provider: MessagingProvider; bots: MessagingConnection[] }) {
  const { t } = useTranslation("messaging");
  const handle = bots.length === 1 ? botHandle(bots[0]!) : null;
  const status = !bots.length ? t("notConnected") : bots.length === 1 ? (handle ? t("connectedAs", { handle }) : t("state.connected")) : t("botsConnected", { count: bots.length });
  return (
    <LinkRow
      lead={<PlatformLogo provider={provider} />}
      title={MESSAGING_PROVIDER_LABELS[provider]}
      detail={status}
      onPress={() => router.push({ pathname: "/settings/messaging-connect", params: { provider } })}
    />
  );
}

function BotRow({ bot: b }: { bot: MessagingConnection }) {
  const c = useColors();
  const { t } = useTranslation("messaging");
  const handle = botHandle(b);
  const toggle = async (enabled: boolean) => {
    queryClient.setQueryData<MessagingConnection[]>(ik.messaging, (list) => list?.map((x) => (x.id === b.id ? { ...x, enabled } : x)));
    try {
      await updateBot(b.id, { enabled });
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("bot.failed"), errorText(err));
    } finally {
      refreshMessaging();
    }
  };
  return (
    <ListRow
      grouped
      lead={<PlatformLogo provider={b.provider} />}
      title={b.name}
      lines={[
        [MESSAGING_PROVIDER_LABELS[b.provider], handle].filter(Boolean).join(" · "),
        b.status.state === "error" ? b.status.message : b.pendingUsers ? t("waiting", { count: b.pendingUsers }) : null,
      ]}
      trailing={
        <Switch
          accessibilityLabel={t("bot.answeringA11y", { name: b.name })}
          value={b.enabled}
          onValueChange={(next) => {
            tap();
            void toggle(next);
          }}
          trackColor={{ true: c.brand, false: c.sunken }}
        />
      }
      onPress={() => router.push({ pathname: "/settings/messaging-bot", params: { id: b.id } })}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
