import { ListSkeleton, PageHeaderSkeleton, SkeletonRegion, StatsSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <SkeletonRegion>
      <PageHeaderSkeleton action />
      <div className="px-5 pb-10 @2xl:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <StatsSkeleton count={4} />
          <ListSkeleton rows={3} columns={4} toolbar={false} />
          <ListSkeleton rows={6} columns={5} />
        </div>
      </div>
    </SkeletonRegion>
  );
}
