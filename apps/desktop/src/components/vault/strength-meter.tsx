import { useMemo } from "react";
import { motion } from "motion/react";
import { estimateStrength, type StrengthResult } from "@/lib/password";
import { cn } from "@/lib/utils";

const COLORS = ["bg-destructive", "bg-orange-500", "bg-warning", "bg-emerald-500", "bg-success"];
const TEXT = ["text-destructive", "text-orange-500", "text-warning", "text-emerald-500", "text-success"];

export function useStrength(password: string, userInputs: string[] = []): StrengthResult {
  const key = userInputs.join("\u0000");
  return useMemo(() => estimateStrength(password, userInputs), [password, key]);
}

/** Five-segment strength bar with label, crack-time estimate and the top hint. */
export function StrengthMeter({
  password,
  userInputs,
  showFeedback = true,
  className,
}: {
  password: string;
  userInputs?: string[];
  showFeedback?: boolean;
  className?: string;
}) {
  const s = useStrength(password, userInputs);
  const empty = !password;
  return (
    <div className={cn("space-y-1.5", className)} aria-live="polite">
      <div className="flex gap-1" role="meter" aria-label="Password strength" aria-valuemin={0} aria-valuemax={4} aria-valuenow={empty ? 0 : s.score}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <motion.div
              className={cn("h-full rounded-full", COLORS[s.score])}
              initial={false}
              animate={{ width: !empty && i <= s.score ? "100%" : "0%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30, delay: i * 0.03 }}
            />
          </div>
        ))}
      </div>
      {!empty && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
          <span className={cn("font-medium", TEXT[s.score])}>{s.label}</span>
          <span className="text-muted-foreground">Offline crack time: {s.crackTime}</span>
        </div>
      )}
      {showFeedback && !empty && s.feedback.length > 0 && s.score < 4 && (
        <p className="text-xs text-muted-foreground">{s.feedback[0]}</p>
      )}
    </div>
  );
}
