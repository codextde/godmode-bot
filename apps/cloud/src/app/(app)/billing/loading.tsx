import { CardsSkeleton, FormSkeleton, ListSkeleton, PageHeaderSkeleton, SkeletonRegion } from "@/components/skeletons";

export default function Loading() {
  return (
    <SkeletonRegion>
      <PageHeaderSkeleton />
      <div className="px-5 pb-10 @2xl:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <FormSkeleton rows={2} />
          <FormSkeleton rows={1} footer={false} />
          <CardsSkeleton count={2} />
          <ListSkeleton rows={3} toolbar={false} />
        </div>
      </div>
    </SkeletonRegion>
  );
}
