import { Skeleton } from "@/components/ui/skeleton";
import { FilesOverview } from "@/components/files/overview";
import { useAgents } from "@/lib/hooks";
import { SectionHeading } from "./settings-kit";

export function FilesSection() {
  const agents = useAgents();
  return (
    <div className="@container space-y-5">
      <SectionHeading
        title="Files"
        description="Look through what your agents keep — their workspace, notes and memory — and clean it up. Deleted files wait 30 days in a bin."
      />
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
