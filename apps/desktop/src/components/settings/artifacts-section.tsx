import { AppWindow, History, LayoutDashboard, PanelRight } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { ArtifactsOverview } from "@/components/artifacts/artifacts-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function ArtifactsSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="artifacts"
      settings={settings}
      title={easy ? "Dashboards & apps" : "Artifacts"}
      summary="Agents build dashboards and small apps you open right in Godmode, and change them when you ask in plain words."
      icon={<AppWindow />}
      points={[
        { icon: <LayoutDashboard />, text: "Dashboards, trackers, planners and calculators" },
        { icon: <PanelRight />, text: "Opens next to the chat it was built in" },
        { icon: <History />, text: "Every change is a version you can go back to" },
      ]}
    >
      <ArtifactsOverview />
    </FeatureSection>
  );
}
