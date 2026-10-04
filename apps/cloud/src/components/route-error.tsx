"use client";

import { useEffect, useTransition } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The body of a route's error.tsx (house rule 9):
 *
 *   "use client";
 *   export default function Error(props: { error: Error & { digest?: string }; retry: () => void }) {
 *     return <RouteError {...props} title="Could not load people" />;
 *   }
 */
export function RouteError({
  error,
  retry,
  title = "Could not load this page",
  description = "Something went wrong on our side. Try again in a moment.",
  inPage = true,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  /** Starts with "Could not …". */
  title?: string;
  description?: string;
  /** Wraps the state in PageBody so it lines up with the page header. */
  inPage?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    console.error(error);
  }, [error]);

  const state = (
    <EmptyState
      icon={<CircleAlert />}
      title={title}
      description={
        <>
          {description}
          {error.digest && (
            <span className="mt-2 block font-mono text-[11px] text-muted-foreground/80 tabular-nums">Reference {error.digest}</span>
          )}
        </>
      }
      action={
        <Button variant="outline" onClick={() => startTransition(() => retry())} disabled={pending}>
          {pending ? <Spinner /> : <RotateCw />}
          {pending ? "Trying again…" : "Try again"}
        </Button>
      }
    />
  );
  if (!inPage) return state;
  return <PageBody className="pt-6 @2xl:pt-8">{state}</PageBody>;
}
