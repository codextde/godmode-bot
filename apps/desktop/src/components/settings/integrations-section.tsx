import { Boxes, Plug, Server, Wrench } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { IntegrationsOverview } from "@/components/integrations/integrations-overview";
import { useEasyMode } from "@/lib/mode";
import { FeatureSection } from "./feature-section";

export function IntegrationsSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  return (
    <FeatureSection
      feature="integrations"
      settings={settings}
      title={easy ? "Connected apps" : "Integrations"}
      summary="Give agents apps, APIs and MCP servers beyond the websites they already sign in to with your saved logins."
      icon={<Plug />}
      points={[
        { icon: <Boxes />, text: "Gmail, Slack, Notion and more through Composio" },
        { icon: <Wrench />, text: "Any API with a key, without agents seeing it" },
        { icon: <Server />, text: "Your own MCP servers" },
      ]}
    >
      <IntegrationsOverview />
    </FeatureSection>
  );
}
