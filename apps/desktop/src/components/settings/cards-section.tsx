import { CreditCard, Gauge, ShieldCheck, UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function CardsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const title = easy ? t("cards.titleEasy") : t("cards.title");
  return (
    <FeatureSection
      feature="cards"
      settings={settings}
      title={title}
      summary={t("cards.summary")}
      icon={<CreditCard />}
      offNote={t("cards.offNote")}
      points={[
        { icon: <Gauge />, text: t("cards.pointLimits") },
        { icon: <UserCheck />, text: t("cards.pointApprove") },
        { icon: <ShieldCheck />, text: t("cards.pointSite") },
      ]}
    >
      <FeaturePageLink to="/vault/cards" icon={<CreditCard />} title={t("feature.open", { title })} description={t("cards.linkDescription")} />
    </FeatureSection>
  );
}
