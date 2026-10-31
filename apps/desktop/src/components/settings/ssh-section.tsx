import { KeyRound, Server, SquareTerminal, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function SshSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const title = easy ? t("ssh.titleEasy") : t("ssh.title");
  return (
    <FeatureSection
      feature="ssh"
      settings={settings}
      title={title}
      summary={t("ssh.summary")}
      icon={<Server />}
      points={[
        { icon: <SquareTerminal />, text: t("ssh.pointCommands") },
        { icon: <KeyRound />, text: t("ssh.pointAuth") },
        { icon: <Upload />, text: t("ssh.pointFiles") },
      ]}
    >
      <FeaturePageLink to="/ssh" icon={<Server />} title={t("feature.open", { title })} description={t("ssh.linkDescription")} />
    </FeatureSection>
  );
}
