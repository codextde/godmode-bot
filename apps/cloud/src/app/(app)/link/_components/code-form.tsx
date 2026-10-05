"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { FormField } from "@/components/form";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

/** "kqzm7hpd" → "KQZM-7HPD" while typing. */
function format(value: string): string {
  const plain = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return plain.length > 4 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

/** Type the code Godmode shows; the approve page for it opens. */
export function CodeForm({ initial = "", error }: { initial?: string; error?: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(format(initial));
  const [pending, startTransition] = useTransition();
  const complete = value.length === 9;
  // The server's sentence belongs to the code that was sent, not to what is being typed now.
  const shownError = error && value === format(initial) ? error : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    startTransition(() => router.push(`/link?code=${encodeURIComponent(value)}`));
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-3 py-4">
      <FormField label="Code" error={shownError} hint="Eight letters and digits, for example KQZM-7HPD." className="min-w-0 flex-1 basis-56">
        <Input
          value={value}
          onChange={(e) => setValue(format(e.target.value))}
          placeholder="XXXX-XXXX"
          className="font-mono tracking-[0.12em] uppercase tabular-nums placeholder:tracking-[0.12em]"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={9}
          autoFocus
        />
      </FormField>
      {/* Lines up with the input (the hint sits below both). */}
      <div className="flex w-full justify-end @md:mt-7 @md:w-auto">
        <SubmitButton pending={pending} pendingLabel="Looking it up…" disabled={!complete} className="w-full @md:w-auto">
          Continue
          <ArrowRight />
        </SubmitButton>
      </div>
    </form>
  );
}
