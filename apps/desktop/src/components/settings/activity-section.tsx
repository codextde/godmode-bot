import { Activity, Filter, History, ListChecks } from "lucide-react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { ActivityOverview } from "@/components/activity/activity-overview";
import { RunDetailSheet } from "@/components/runs/run-detail-sheet";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection, featureOn } from "./feature-section";

export function ActivitySection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const [params, setParams] = useSearchParams();
  const run = params.get("run");
  return (
    <>
      <FeatureSection
        feature="activity"
        settings={settings}
        title={easy ? t("activity.titleEasy") : t("activity.title")}
        summary={t("activity.summary")}
        icon={<Activity />}
        offNote={t("activity.offNote")}
        points={[
          { icon: <History />, text: t("activity.pointRuns") },
          { icon: <Filter />, text: t("activity.pointFilter") },
          { icon: <ListChecks />, text: t("activity.pointSteps") },
        ]}
      >
        <ActivityOverview />
      </FeatureSection>
      {!featureOn(settings, "activity") && (
        <RunDetailSheet
          runId={run}
          onOpenChange={(open) => !open && setParams((p) => (p.delete("run"), p), { replace: true })}
        />
      )}
    </>
  );
}
