import { useCallback, useState } from "react";
import { motion } from "motion/react";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { DoctorReport } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SubmitButton } from "./auth-layout";
import { DoctorChecklist } from "./doctor-checklist";
import { StepCard, StepFooter, StepHeader } from "./step-kit";

export function SystemStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const onReport = useCallback((r: DoctorReport) => setReport(r), []);
  const missingRequired = report?.dependencies.filter((d) => d.required && !d.ok) ?? [];
  const allGood = !!report && missingRequired.length === 0;

  return (
    <StepCard>
      <StepHeader
        eyebrow="System check"
        title="Let's make sure your machine is ready"
        description="Godmode uses Claude Code as its brain and browser-use for web tasks. Anything missing can usually be installed with one click."
      />
      {report && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "mb-4 flex items-start gap-3 rounded-xl border p-3.5 text-sm",
            allGood ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10",
          )}
          role="status"
        >
          {allGood ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />}
          <p>
            {allGood ? (
              <span className="font-medium">Everything your coworker needs is in place.</span>
            ) : (
              <>
                <span className="font-medium">
                  {missingRequired.length} required {missingRequired.length === 1 ? "item needs" : "items need"} attention.
                </span>{" "}
                <span className="text-muted-foreground">You can continue and fix this later in Settings → System — agents won't run until it's resolved.</span>
              </>
            )}
          </p>
        </motion.div>
      )}
      <DoctorChecklist ids={["claude", "claude-auth", "uv", "browser-use", "chrome", "git"]} onReport={onReport} />
      <StepFooter onBack={onBack}>
        {allGood ? (
          <SubmitButton busy={false} type="button" onClick={onNext} className="w-auto px-6">
            Continue
          </SubmitButton>
        ) : (
          <Button type="button" variant="outline" onClick={onNext}>
            Continue anyway
          </Button>
        )}
      </StepFooter>
    </StepCard>
  );
}
