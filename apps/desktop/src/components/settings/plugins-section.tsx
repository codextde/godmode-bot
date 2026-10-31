import { GitBranch, Puzzle, ShieldCheck, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function PluginsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const title = easy ? t("plugins.titleEasy") : t("plugins.title");
  return (
    <FeatureSection
      feature="plugins"
      settings={settings}
      title={title}
      summary={t("plugins.summary")}
      icon={<Puzzle />}
      offNote={t("plugins.offNote")}
      points={[
        { icon: <GitBranch />, text: t("plugins.pointGit") },
        { icon: <Sparkles />, text: t("plugins.pointHooks") },
        { icon: <ShieldCheck />, text: t("plugins.pointChecked") },
      ]}
    >
      <FeaturePageLink to="/plugins" icon={<Puzzle />} title={t("feature.open", { title })} description={t("plugins.linkDescription")} />
    </FeatureSection>
  );
}
