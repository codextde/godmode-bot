"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** The body of the error.tsx files of the signed-out pages. */
export function AuthRouteError({
  error,
  retry,
  title = "Could not load this page",
  home = { href: "/login", label: "Back to sign in" },
}: {
  error: Error & { digest?: string };
  retry: () => void;
  /** Starts with "Could not …". */
  title?: string;
  home?: { href: string; label: string };
}) {
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AuthShell
      mascot="error"
      title={title}
      description={
        <>
          Something went wrong on our side. Try again in a moment.
          {error.digest && <span className="mt-2 block font-mono text-[11px] tabular-nums">Reference {error.digest}</span>}
        </>
      }
      footer={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => startTransition(() => retry())} disabled={pending}>
            {pending ? <Spinner aria-hidden aria-label={undefined} role={undefined} /> : <RotateCw />}
            {pending ? "Trying again…" : "Try again"}
          </Button>
          <Button variant="outline" asChild>
            <Link href={home.href}>{home.label}</Link>
          </Button>
        </div>
      }
    />
  );
}
