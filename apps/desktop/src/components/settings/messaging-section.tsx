import { KeyRound, MessageCircle, MessagesSquare, UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { MessagingOverview } from "@/components/messaging/messaging-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function MessagingSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="messaging"
      settings={settings}
      title={easy ? t("messaging.titleEasy") : t("messaging.title")}
      summary={t("messaging.summary")}
      icon={<MessageCircle />}
      points={[
        { icon: <MessagesSquare />, text: t("messaging.pointApps") },
        { icon: <UserCheck />, text: t("messaging.pointPrivate") },
        { icon: <KeyRound />, text: t("messaging.pointTokens") },
      ]}
    >
      <MessagingOverview />
    </FeatureSection>
  );
}
