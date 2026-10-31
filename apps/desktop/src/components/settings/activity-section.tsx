import { Activity, Filter, History, ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function ActivitySection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const title = easy ? t("activity.titleEasy") : t("activity.title");
  return (
    <FeatureSection
      feature="activity"
      settings={settings}
      title={title}
      summary={t("activity.summary")}
      icon={<Activity />}
      offNote={t("activity.offNote")}
      points={[
        { icon: <History />, text: t("activity.pointRuns") },
        { icon: <Filter />, text: t("activity.pointFilter") },
        { icon: <ListChecks />, text: t("activity.pointSteps") },
      ]}
    >
      <FeaturePageLink to="/activity" icon={<Activity />} title={t("feature.open", { title })} description={t("activity.linkDescription")} />
    </FeatureSection>
  );
}
