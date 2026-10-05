"use client";

import { useState, useTransition } from "react";
import { isNavigationError } from "@/components/confirm-dialog";
import type { ActionResult } from "@/lib/action";

/**
 * Runs one of the wizard's server actions in a transition and keeps its outcome: `error` for the form-level Callout,
 * `fields` for inline errors. `shown` lists the fields the form renders; when every reported field is one of them the
 * form-level error stays empty, so a sentence is not shown twice.
 */
export function useStepAction(shown: readonly string[] = []) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const run = <T,>(action: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) => {
    setError(null);
    setFields({});
    startTransition(async () => {
      try {
        const result = await action();
        // An action that redirects never returns.
        if (!result) return;
        if (!result.ok) {
          const reported = Object.keys(result.fields ?? {});
          setFields(result.fields ?? {});
          setError(reported.length > 0 && reported.every((f) => shown.includes(f)) ? null : result.error);
          return;
        }
        onOk?.(result.data);
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError("Could not reach the server. Check your connection and try again.");
      }
    });
  };

  const clear = () => {
    setError(null);
    setFields({});
  };

  return { pending, error, fields, run, clear };
}
