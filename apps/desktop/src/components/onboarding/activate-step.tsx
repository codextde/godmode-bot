import { format } from "date-fns";
import { CircleCheck, Gift } from "lucide-react";
import type { LicenseState } from "@godmode/shared";
import { ActivatePanel, KeyDivider, LicenseKeyForm } from "@/components/license/activate";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/lib/hooks";
import { SubmitButton } from "./auth-layout";
import { StepCard, StepFooter, StepHeader } from "./step-kit";

const READY: LicenseState["status"][] = ["active", "trial", "past_due", "unverified"];

/** Start the trial or enter a key. Skippable while nothing is refused yet (free week, builds from source). */
export function ActivateStep({ onBack, onDone }: { onBack: () => void; onDone: (state: LicenseState | null) => void }) {
  const { data: state } = useLicense();
  const ready = !!state && !!state.keyHint && READY.includes(state.status) && !state.blocked;
  const skippable = !!state && !state.blocked;
  const freeUntil = state?.enforced && state.status === "grace" && state.graceEndsAt ? new Date(state.graceEndsAt) : null;

  if (freeUntil) {
    return (
      <div>
        <StepHeader
          eyebrow="Godmode Pro"
          title="Your free week starts now."
          description="Every feature, no card needed. When the week is up, add your licence key or start the 14-day free trial."
        />
        <StepCard>
          <div className="flex items-center gap-3 rounded-lg border border-brand/25 bg-brand-soft p-4 text-sm">
            <Gift className="size-5 shrink-0 text-brand-strong" />
            <span>
              Free until <span className="font-medium">{format(freeUntil, "EEEE, MMMM d")}</span>.
            </span>
          </div>

          <KeyDivider className="my-6" />
          <LicenseKeyForm onActivated={(next) => onDone(next)} />

          <StepFooter onBack={onBack}>
            <SubmitButton busy={false} type="button" onClick={() => onDone(state ?? null)} className="w-auto px-6">
              Continue
            </SubmitButton>
          </StepFooter>
        </StepCard>
      </div>
    );
  }

  return (
    <div>
      <StepHeader
        eyebrow="Godmode Pro"
        title="Activate Godmode."
        description={
          state && !state.enforced
            ? "This build of your own is free under the MIT License, so you can skip this. Have a Godmode Pro key? Add it here."
            : "Start your 14-day free trial, or enter the licence key you got after checkout. Every plan has every feature."
        }
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
                Skip for now
              </Button>
            )
          )}
        </StepFooter>
      </StepCard>
    </div>
  );
}
