import { AppWindow, History, LayoutDashboard, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { ArtifactsOverview } from "@/components/artifacts/artifacts-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function ArtifactsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="artifacts"
      settings={settings}
      title={easy ? t("artifacts.titleEasy") : t("artifacts.title")}
      summary={t("artifacts.summary")}
      icon={<AppWindow />}
      points={[
        { icon: <LayoutDashboard />, text: t("artifacts.pointKinds") },
        { icon: <PanelRight />, text: t("artifacts.pointPanel") },
        { icon: <History />, text: t("artifacts.pointVersions") },
      ]}
    >
      <ArtifactsOverview />
    </FeatureSection>
  );
}
