"use client";

import { useEffect, useTransition } from "react";
import { RotateCw } from "lucide-react";
import { Mascot } from "@/components/mascot";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import "./globals.css";

/**
 * Replaces the root layout when it fails itself (so no providers, no theme script, no settings). Applies the stored
 * theme on its own and keeps to plain markup.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    console.error(error);
    try {
      let theme = localStorage.getItem("godmode-theme") ?? "light";
      if (theme === "system") theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
    } catch {
      // Storage unavailable: stay on the light theme.
    }
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Something went wrong</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body>
        <main className="grid min-h-svh place-items-center bg-background px-4 py-12">
          <div className="animate-enter flex max-w-md flex-col items-center text-center">
            <Mascot mood="error" size={76} />
            <h1 className="heading-display mt-6 text-[30px] sm:text-[34px]">Could not load Godmode Cloud</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              Something went wrong on our side. Try again in a moment; if it keeps happening, tell the people who run this
              cloud.
            </p>
            {error.digest && <p className="mt-2 font-mono text-[11px] text-muted-foreground tabular-nums">Reference {error.digest}</p>}
            <Button className="mt-6" onClick={() => startTransition(() => retry())} disabled={pending}>
              {pending ? <Spinner aria-hidden aria-label={undefined} role={undefined} /> : <RotateCw />}
              {pending ? "Trying again…" : "Try again"}
            </Button>
          </div>
        </main>
      </body>
    </html>
  );
}
