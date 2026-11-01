import { useState } from "react";
import { useSearchParams } from "react-router";
import { GitBranch, Puzzle, ShieldCheck, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { PluginsOverview } from "@/components/mods/plugins-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function PluginsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  // A link to one plugin (an agent's draft to review) opens it even while plugins are off.
  const [params] = useSearchParams();
  const [linked] = useState(() => params.has("plugin"));
  return (
    <FeatureSection
      feature="plugins"
      settings={settings}
      title={easy ? t("plugins.titleEasy") : t("plugins.title")}
      summary={t("plugins.summary")}
      icon={<Puzzle />}
      offNote={t("plugins.offNote")}
      showWhileOff={linked}
      points={[
        { icon: <GitBranch />, text: t("plugins.pointGit") },
        { icon: <Sparkles />, text: t("plugins.pointHooks") },
        { icon: <ShieldCheck />, text: t("plugins.pointChecked") },
      ]}
    >
      <PluginsOverview />
    </FeatureSection>
  );
}
