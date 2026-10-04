import { FormSkeleton, SkeletonRegion } from "@/components/skeletons";

/** Inside the settings frame: only the group's cards are replaced. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <div className="flex flex-col gap-5">
        <FormSkeleton rows={4} footer={false} />
        <FormSkeleton rows={2} />
      </div>
    </SkeletonRegion>
  );
}
