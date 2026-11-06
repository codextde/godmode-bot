import { useTranslation } from "react-i18next";
import { MESSAGING_PROVIDER_LABELS, type MessagingConnection } from "@godmode/shared";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge, type Tone } from "@/components/ui";
import { useMessaging } from "@/lib/integrations";

const TONE: Record<MessagingConnection["status"]["state"], Tone> = { connected: "success", connecting: "warning", error: "danger", off: "neutral" };

/** Bots people use to talk to agents from Telegram, Slack or Teams: connected or not, who waits for access. Set up on the computer. */
export default function Messaging() {
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
        const state = m.status.state;
        const label = state === "off" && m.enabled ? t("messaging.state.waitingForVault") : t(`messaging.state.${state}`);
        const bot = m.bot.username ? `@${m.bot.username}` : m.bot.team || m.bot.name;
        return (
          <ListRow
            icon="chats"
            title={m.name}
            lines={[
              [MESSAGING_PROVIDER_LABELS[m.provider], bot].filter(Boolean).join(" · "),
              state === "error" ? m.status.message : m.pendingUsers ? t("messaging.waiting", { count: m.pendingUsers }) : null,
            ]}
            trailing={<Badge label={label} tone={TONE[state]} live={state === "connecting"} />}
          />
        );
      }}
    />
  );
}
