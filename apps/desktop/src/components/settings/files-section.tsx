import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { FilesOverview } from "@/components/files/overview";
import { useAgents } from "@/lib/hooks";
import { SectionHeading } from "./settings-kit";

export function FilesSection() {
  const { t } = useTranslation("settings");
  const agents = useAgents();
  return (
    <div className="@container space-y-5">
      <SectionHeading title={t("files.title")} description={t("files.description")} />
      {agents.isLoading ? (
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : (
        <FilesOverview agents={agents.data ?? []} />
      )}
    </div>
  );
}
