import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ApiKeysTab } from "@/components/integrations/api-keys-tab";
import { SectionHeading } from "./settings-kit";

export function ApiKeysSection() {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  return (
    <div className="space-y-5">
      <SectionHeading title={t("apiKeys.title")} description={t("apiKeys.description")} />
      <ApiKeysTab onOpenComposio={() => navigate("/settings/integrations")} onOpenTools={() => navigate("/settings/integrations?tab=tools")} />
    </div>
  );
}
