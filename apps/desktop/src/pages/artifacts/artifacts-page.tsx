import { AppWindow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ArtifactsOverview } from "@/components/artifacts/artifacts-overview";
import { PageBody, PageHeader } from "@/components/common";

export default function ArtifactsPage() {
  const { t } = useTranslation("artifacts");
  return (
    <div className="@container h-full overflow-y-auto">
      <PageHeader icon={<AppWindow />} title={t("overview.title")} description={t("overview.description")} />
      <PageBody>
        <ArtifactsOverview />
      </PageBody>
    </div>
  );
}
