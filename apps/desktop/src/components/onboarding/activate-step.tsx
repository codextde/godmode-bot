import { format } from "date-fns";
import { CircleCheck } from "lucide-react";
import type { LicenseState } from "@godmode/shared";
import { ActivatePanel } from "@/components/license/activate";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/lib/hooks";
import { SubmitButton } from "./auth-layout";
import { StepCard, StepFooter, StepHeader } from "./step-kit";

const READY: LicenseState["status"][] = ["active", "trial", "past_due", "unverified"];

/** Start the trial or enter a key. Skippable while nothing is refused yet (grace, builds from source). */
export function ActivateStep({ onBack, onDone }: { onBack: () => void; onDone: (state: LicenseState | null) => void }) {
  const { data: state } = useLicense();
  const ready = !!state && !!state.keyHint && READY.includes(state.status) && !state.blocked;
  const skippable = !!state && !state.blocked;

  return (
    <div>
      <StepHeader
        eyebrow="Godmode Pro"
        title="Activate Godmode."
        description="Start your 7-day free trial, or enter the licence key you got after checkout. Every plan has every feature."
      />
      <StepCard>
        {ready ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/25 bg-brand-soft p-4 text-sm">
            <span className="flex items-center gap-2">
              <CircleCheck className="size-5 text-brand-strong" />
              {state.status === "trial" && state.trialEndsAt
                ? `Your free trial runs until ${format(new Date(state.trialEndsAt), "MMMM d")}.`
                : "Godmode is activated on this computer."}
            </span>
            <span className="font-mono text-xs text-muted-foreground">…{state.keyHint}</span>
          </div>
        ) : (
          <ActivatePanel source="onboarding" onActivated={(next) => onDone(next)} />
        )}

        <StepFooter onBack={onBack}>
          {ready ? (
            <SubmitButton busy={false} type="button" onClick={() => onDone(state)} className="w-auto px-6">
              Continue
            </SubmitButton>
          ) : (
            skippable && (
              <Button type="button" variant="ghost" onClick={() => onDone(state ?? null)}>
                {state?.status === "grace" && state.graceEndsAt ? `Later — until ${format(new Date(state.graceEndsAt), "MMM d")}` : "Skip for now"}
              </Button>
            )
          )}
        </StepFooter>
      </StepCard>
    </div>
  );
}
