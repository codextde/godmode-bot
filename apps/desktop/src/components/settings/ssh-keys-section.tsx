import { HardDrive, Key, Plus, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function SshKeysSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const title = t("sshKeys.title");
  return (
    <FeatureSection
      feature="sshKeys"
      settings={settings}
      title={title}
      summary={t("sshKeys.summary")}
      icon={<Key />}
      offNote={t("sshKeys.offNote")}
      points={[
        { icon: <HardDrive />, text: t("sshKeys.pointSee") },
        { icon: <Plus />, text: t("sshKeys.pointCreate") },
        { icon: <Terminal />, text: t("sshKeys.pointAgent") },
      ]}
    >
      <FeaturePageLink to="/vault/ssh-keys" icon={<Key />} title={t("feature.open", { title })} description={t("sshKeys.linkDescription")} />
    </FeatureSection>
  );
}
