import { KeyRound, MessageCircle, MessagesSquare, UserCheck } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { MessagingOverview } from "@/components/messaging/messaging-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function MessagingSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="messaging"
      settings={settings}
      title={easy ? "Chat apps" : "Messaging"}
      summary="Talk to your agents from Slack, Telegram and Microsoft Teams. They answer right where you already chat."
      icon={<MessageCircle />}
      points={[
        { icon: <MessagesSquare />, text: "Slack, Telegram and Microsoft Teams" },
        { icon: <UserCheck />, text: "Private: you approve who may write" },
        { icon: <KeyRound />, text: "Bot tokens sealed in your vault" },
      ]}
    >
      <MessagingOverview />
    </FeatureSection>
  );
}
