import { SetupShell, StepCard } from "@/components/setup-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { SETUP_STEPS } from "./_lib/steps";

/** The wizard frame with a placeholder step while the real one loads. */
export default function Loading() {
  return (
    <SetupShell steps={[...SETUP_STEPS]} current={1}>
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <div aria-hidden>
          <div className="mb-7 space-y-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-9 w-56" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
          <StepCard>
            <div className="flex flex-col gap-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full pointer-coarse:h-11" />
                </div>
              ))}
            </div>
          </StepCard>
          <div className="mt-7 flex justify-end border-t pt-5">
            <Skeleton className="h-9 w-36" />
          </div>
        </div>
      </div>
    </SetupShell>
  );
}
