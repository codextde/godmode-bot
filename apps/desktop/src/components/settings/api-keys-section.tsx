import { useNavigate } from "react-router";
import { ApiKeysTab } from "@/components/integrations/api-keys-tab";
import { SectionHeading } from "./settings-kit";

export function ApiKeysSection() {
  const navigate = useNavigate();
  return (
    <div className="space-y-5">
      <SectionHeading title="API keys" description="Keys Godmode itself uses: Claude or GLM on an API account, voice, CAPTCHA solving and browser sync." />
      <ApiKeysTab onOpenComposio={() => navigate("/settings/integrations")} onOpenTools={() => navigate("/settings/integrations?tab=tools")} />
    </div>
  );
}
