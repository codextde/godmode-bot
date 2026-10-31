import { Activity, Filter, History, ListChecks } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function ActivitySection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  const title = easy ? "History" : "Activity";
  return (
    <FeatureSection
      feature="activity"
      settings={settings}
      title={title}
      summary="Every run of every agent in one place: what it did, what it cost and where it failed."
      icon={<Activity />}
      offNote="It leaves the sidebar while it's off. Runs are still recorded, and links to a run still open it."
      points={[
        { icon: <History />, text: "Every run, newest first" },
        { icon: <Filter />, text: "Filter by agent, trigger or outcome" },
        { icon: <ListChecks />, text: "Open a run to see each step and its cost" },
      ]}
    >
      <FeaturePageLink to="/activity" icon={<Activity />} title={`Open ${title}`} description="In the sidebar under Work." />
    </FeatureSection>
  );
}
