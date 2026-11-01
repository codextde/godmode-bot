import { AppWindow, History, LayoutDashboard, PanelRight, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { ArtifactsOverview } from "@/components/artifacts/artifacts-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";
import { ModelSelect } from "./ai-section";
import { SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

export function ArtifactsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const { patch } = useSettingsPatch();
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
      <div className="space-y-6">
        <SettingsGroup title={t("artifacts.speed.title")} icon={<Zap />}>
          <SettingRow label={t("artifacts.speed.builder")} htmlFor="artifact-builder-model" description={t("artifacts.speed.builderDescription")}>
            <ModelSelect
              id="artifact-builder-model"
              allowNone
              noneLabel={t("artifacts.speed.builderOff")}
              value={settings.artifacts.builderModel ?? ""}
              onChange={(builderModel) => patch({ artifacts: { builderModel } })}
            />
          </SettingRow>
        </SettingsGroup>
        <ArtifactsOverview />
      </div>
    </FeatureSection>
  );
}
