import { AuthShell } from "@/components/auth-shell";
import { Skeleton } from "@/components/ui/skeleton";

/** The loading state of a signed-out page: the real frame and card with placeholder lines. */
export function AuthLoading({ rows = 2 }: { rows?: number }) {
  return (
    <AuthShell
      title={<Skeleton className="mx-auto h-9 w-48" />}
      description={<Skeleton className="mx-auto h-4 w-64 max-w-full" />}
    >
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">Loading…</span>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full pointer-coarse:h-11" />
          </div>
        ))}
        <Skeleton aria-hidden className="h-9 w-full pointer-coarse:h-11" />
      </div>
    </AuthShell>
  );
}
