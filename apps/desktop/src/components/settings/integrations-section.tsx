import { Boxes, Plug, Server, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { IntegrationsOverview } from "@/components/integrations/integrations-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function IntegrationsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="integrations"
      settings={settings}
      title={easy ? t("integrations.titleEasy") : t("integrations.title")}
      summary={t("integrations.summary")}
      icon={<Plug />}
      points={[
        { icon: <Boxes />, text: t("integrations.pointComposio") },
        { icon: <Wrench />, text: t("integrations.pointApi") },
        { icon: <Server />, text: t("integrations.pointMcp") },
      ]}
    >
      <IntegrationsOverview />
    </FeatureSection>
  );
}
