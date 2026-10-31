import { CreditCard, Gauge, ShieldCheck, UserCheck } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function CardsSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  const title = easy ? "Payment cards" : "Cards";
  return (
    <FeatureSection
      feature="cards"
      settings={settings}
      title={title}
      summary="Let agents pay with a saved card: Godmode types it into the checkout, the AI never sees the number."
      icon={<CreditCard />}
      offNote="Agents can't pay with a card while it's off. Your saved cards stay in the vault."
      points={[
        { icon: <Gauge />, text: "Limits per purchase and per month" },
        { icon: <UserCheck />, text: "You approve anything above your threshold" },
        { icon: <ShieldCheck />, text: "Bound to the site of the checkout page" },
      ]}
    >
      <FeaturePageLink to="/vault/cards" icon={<CreditCard />} title={`Open ${title}`} description="Add cards, set limits and see every purchase." />
    </FeatureSection>
  );
}
