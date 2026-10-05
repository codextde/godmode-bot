"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CopyField } from "@/components/copy-button";
import { Mascot } from "@/components/mascot";
import { Callout, InfoRow } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { finishSetupAction } from "../actions";
import { stepHref, type SetupStepId } from "../_lib/steps";
import { useStepAction } from "./use-step-action";

export interface SummaryRow {
  label: string;
  value: string;
  mono?: boolean;
  /** Something is left to do; the row links to its step. */
  todo?: SetupStepId;
}

/** Step 6: what was set up, how to link the first computer, and the way into the dashboard. */
export function DoneStep({ summary, publicUrl }: { summary: SummaryRow[]; publicUrl: string }) {
  const finish = useStepAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        finish.run(() => finishSetupAction());
      }}
    >
      <div className="mb-6">
        <Mascot mood="happy" size={64} />
      </div>
      <StepHeader eyebrow="All set" title="Your cloud is ready" description="Here is what you set up. Everything can be changed later in the admin area." />
      <div className="flex flex-col gap-5">
        <StepCard className="py-2 sm:py-3">
          <div className="divide-y">
            {summary.map((row) => (
              <InfoRow key={row.label} label={row.label} mono={row.mono}>
                {row.todo ? (
                  <Link href={stepHref(row.todo)} className="font-medium underline-offset-4 hover:underline">
                    {row.value}
                  </Link>
                ) : (
                  row.value
                )}
              </InfoRow>
            ))}
          </div>
        </StepCard>
        <StepCard>
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Link your first computer</h2>
          <ol className="mt-4 space-y-3 text-sm">
            {[
              <>
                On the computer, open <strong>Godmode → Settings → Cloud</strong> and choose <strong>Connect to Godmode Cloud</strong>.
              </>,
              <>
                Enter this cloud's address:
                <CopyField value={publicUrl} label="Copy the cloud address" className="mt-2" />
              </>,
              <>
                Godmode shows a code. Approve it here, signed in as you, and the computer appears under <strong>Computers</strong>.
              </>,
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span
                  aria-hidden
                  className="grid size-6 shrink-0 place-items-center rounded-md border bg-card font-mono text-[11px] font-medium tabular-nums shadow-card"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 pt-0.5 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">{step}</div>
              </li>
            ))}
          </ol>
        </StepCard>
        {finish.error && <Callout tone="danger" title={finish.error} />}
      </div>
      <StepFooter backHref={stepHref("billing")}>
        <SubmitButton pending={finish.pending} pendingLabel="Opening…" className="max-md:flex-1">
          Open dashboard <ArrowRight />
        </SubmitButton>
      </StepFooter>
    </form>
  );
}
