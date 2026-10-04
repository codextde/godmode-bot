"use client";

import type { ComponentProps, ReactNode } from "react";
import { FormActions } from "@/components/form";
import { Callout, SettingRow } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SettingsForm } from "./use-settings-form";

/** "" is not zero: an emptied number field must fail validation instead of saving 0. */
export function toNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

function describe(description: ReactNode, error: string | undefined, id: string): ReactNode {
  if (!description && !error) return undefined;
  return (
    <>
      {description}
      {error && (
        <span id={`${id}-error`} role="alert" className={cn("block text-destructive", description ? "mt-1" : undefined)}>
          {error}
        </span>
      )}
    </>
  );
}

/** A text field under its label (full width, so it works at 360 px). */
export function TextRow({
  id,
  label,
  description,
  error,
  value,
  onChange,
  mono,
  ...input
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
} & Omit<ComponentProps<typeof Input>, "id" | "value" | "onChange">) {
  return (
    <SettingRow label={label} description={describe(description, error, id)} htmlFor={id} stacked>
      <Input
        {...input}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(mono && "font-mono tabular-nums", input.className)}
      />
    </SettingRow>
  );
}

/** A whole number with its unit, beside the label. The value stays text while typing. */
export function NumberRow({
  id,
  label,
  description,
  error,
  value,
  onChange,
  unit,
  min,
  max,
  disabled,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} description={describe(description, error, id)} htmlFor={id} disabled={disabled}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-24 text-right font-mono tabular-nums"
      />
      {unit && <span className="w-14 text-xs text-muted-foreground">{unit}</span>}
    </SettingRow>
  );
}

export function SwitchRow({
  id,
  label,
  description,
  error,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} description={describe(description, error, id)} htmlFor={id} disabled={disabled}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-invalid={error ? true : undefined} />
    </SettingRow>
  );
}

/**
 * The end of a settings form: the form-level error, Discard and Save (disabled until something changed), and the
 * question before leaving with unsaved changes. Sticks to the bottom of the screen on phones.
 */
export function SaveBar<T>({
  form,
  label = "Save",
  pendingLabel = "Saving…",
  alwaysEnabled = false,
}: {
  form: SettingsForm<T>;
  label?: string;
  pendingLabel?: string;
  /** For "Test and save", which is worth running again without a change. */
  alwaysEnabled?: boolean;
}) {
  return (
    <>
      {form.error && <Callout tone="danger" title={form.error} />}
      <FormActions>
        {form.dirty && (
          <Button type="button" variant="ghost" onClick={form.reset} disabled={form.pending}>
            Discard
          </Button>
        )}
        <SubmitButton pending={form.pending} pendingLabel={pendingLabel} disabled={!form.dirty && !alwaysEnabled}>
          {label}
        </SubmitButton>
      </FormActions>
      <UnsavedGuard when={form.dirty} />
    </>
  );
}
