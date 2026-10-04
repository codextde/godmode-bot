"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { isNavigationError } from "@/components/confirm-dialog";
import type { ActionResult } from "@/lib/action";

export interface SettingsForm<T> {
  value: T;
  set: <K extends keyof T>(key: K, next: T[K]) => void;
  /** Error sentence per field, from `ActionResult.fields`. */
  fields: Record<string, string>;
  /** The error when it does not belong to a field on the form. */
  error: string | null;
  pending: boolean;
  dirty: boolean;
  /** `next` saves that value instead of the current one (a change made in the same event). */
  submit: (event?: FormEvent, next?: T) => void;
  reset: () => void;
}

/**
 * One settings form (house rule 6): controlled state, an explicit save through a server action in a transition, field
 * errors inline, a toast on success. `save` returns the stored value in the form's shape, which becomes the new
 * baseline for "changed".
 */
export function useSettingsForm<T extends object>(
  initial: T,
  save: (value: T) => Promise<ActionResult<T>>,
  /** `success: null` when `save` shows its own toast. */
  opts: { success?: string | null } = {},
): SettingsForm<T> {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);

  const set = <K extends keyof T>(key: K, next: T[K]) => {
    setValue((current) => ({ ...current, [key]: next }));
    setFields((current) => {
      if (!(String(key) in current)) return current;
      const rest = { ...current };
      delete rest[String(key)];
      return rest;
    });
  };

  const submit = (event?: FormEvent, next?: T) => {
    event?.preventDefault();
    if (pending) return;
    const current = next ?? value;
    if (next) setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        const result = await save(current);
        if (!result.ok) {
          const names = Object.keys(result.fields ?? {});
          setFields(result.fields ?? {});
          // A message that sits under its field is not repeated above the Save button.
          setError(names.length > 0 && names.every((name) => name in current) ? null : result.error);
          return;
        }
        setFields({});
        setSaved(result.data);
        setValue(result.data);
        if (opts.success !== null) toast.success(opts.success ?? "Saved");
        // The shell reads settings too (name, announcement, the e-mail notice).
        router.refresh();
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError("Could not reach the server. Check your connection and try again.");
      }
    });
  };

  const reset = () => {
    setValue(saved);
    setFields({});
    setError(null);
  };

  return { value, set, fields, error, pending, dirty, submit, reset };
}
