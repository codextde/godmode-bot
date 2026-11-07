import { router, type Href } from "expo-router";
import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Message } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { useChatTask, useRunRoutine } from "@/lib/chat-source";
import { useColors } from "@/lib/theme";

const CAPTION = { automation: "message.source.automation", delegation: "message.source.delegation", task: "message.source.task", offer: "message.source.offer", handoff: "message.source.handoff" } as const;

/** Above a turn the human didn't write: who it came from. */
export function MessageSource({ message }: { message: Message }) {
  if (message.source === "task") return <TicketSource conversationId={message.conversationId} />;
  if (message.source === "automation") return <AutomationSource runId={message.runId} />;
  return <Plain source={message.source} />;
}

function Plain({ source }: { source: Message["source"] }) {
  const { t } = useTranslation("components");
  return <Caption text={source ? t(CAPTION[source]) : ""} />;
}

function TicketSource({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("components");
  const task = useChatTask(conversationId, true);
  return (
    <Caption
      text={task ? t("message.source.taskN", { n: task.number }) : t("message.source.task")}
      icon="tasks"
      to={task ? { pathname: "/task/[id]", params: { id: task.id } } : undefined}
      hint={t("message.source.openTicket")}
    />
  );
}

function AutomationSource({ runId }: { runId?: string | null }) {
  const { t } = useTranslation("components");
  const routine = useRunRoutine(runId);
  return (
    <Caption
      text={routine ? t("message.source.automationNamed", { name: routine.name }) : t("message.source.automation")}
      icon="workflow"
      to={routine ? { pathname: "/automation/[id]", params: { id: routine.id } } : undefined}
      hint={t("message.source.openAutomation")}
    />
  );
}

function Caption({ text, icon, to, hint }: { text: string; icon?: IconName; to?: Href; hint?: string }) {
  const c = useColors();
  const line = (
    <>
      {icon ? <Icon name={icon} size={12} color={c.textMuted} /> : null}
      <T variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
        {text}
      </T>
      {to ? <Icon name="chevron" size={9} weight="semibold" color={c.textFaint} /> : null}
    </>
  );
  const row = { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4, maxWidth: "85%" } as const;
  if (!to) return <View style={row}>{line}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint={hint}
      hitSlop={8}
      onPress={() => {
        tap();
        router.push(to);
      }}
      style={({ pressed }) => [row, pressed && { opacity: 0.6 }]}
    >
      {line}
    </Pressable>
  );
}
