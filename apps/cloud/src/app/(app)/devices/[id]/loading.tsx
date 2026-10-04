import {
  ChartSkeleton,
  FormSkeleton,
  PageHeaderSkeleton,
  SkeletonRegion,
} from "@/components/skeletons";

export default function Loading() {
  return (
    <SkeletonRegion>
      <PageHeaderSkeleton action />
      <div className="px-5 pb-10 @2xl:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <FormSkeleton rows={5} footer={false} />
          <ChartSkeleton />
          <FormSkeleton rows={2} footer={false} />
        </div>
      </div>
    </SkeletonRegion>
  );
}
