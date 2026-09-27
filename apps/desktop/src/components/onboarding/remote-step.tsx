import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Globe2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { FormError, SubmitButton } from "./auth-layout";
import { NewSecretFields, StepCard, StepFooter, StepHeader, secretValid } from "./step-kit";

const MIN_PASSWORD = 10;

/** Server mode only: protect the web dashboard with a password (in addition to access tokens). */
export function RemoteStep({
  hasPassword,
  userName,
  onDone,
  onBack,
}: {
  hasPassword: boolean;
  userName: string;
  onDone: (set: boolean) => void;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [changing, setChanging] = useState(!hasPassword);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = secretValid(password, confirm, MIN_PASSWORD);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.setPassword(password);
      await qc.invalidateQueries({ queryKey: qk.settings });
      onDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepHeader
        eyebrow="Remote dashboard"
        title="Protect your dashboard."
        description="Godmode is running as a server. Set a password so you can sign in from a browser without copying access tokens around."
      />
      <StepCard>
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/[0.07] p-3.5 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Anyone with this password controls your agents and their logins.</span> Use a long,
            unique password, and only expose the dashboard through a reverse proxy with TLS.
          </p>
        </div>

        {changing ? (
          <NewSecretFields
            idPrefix="dashboard-password"
            label="Dashboard password"
            value={password}
            confirm={confirm}
            onChange={setPassword}
            onConfirmChange={setConfirm}
            minLength={MIN_PASSWORD}
            userInputs={[userName, "godmode", "dashboard"]}
            autoFocus
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/25 bg-brand-soft p-4 text-sm">
            <span className="flex items-center gap-2">
              <CircleCheck className="size-5 text-brand-strong" /> A dashboard password is already set.
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => setChanging(true)}>
              Change it
            </Button>
          </div>
        )}

        <div className="mt-4">
          <FormError message={error} />
        </div>

        <StepFooter onBack={onBack}>
          {changing ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onDone(hasPassword)}>
                {hasPassword ? "Keep current" : "Skip — use tokens only"}
              </Button>
              <SubmitButton busy={busy} disabled={!valid} className="w-auto px-6">
                <Globe2 /> Set password
              </SubmitButton>
            </>
          ) : (
            <SubmitButton busy={false} type="button" onClick={() => onDone(true)} className="w-auto px-6">
              Continue
            </SubmitButton>
          )}
        </StepFooter>
      </StepCard>
    </form>
  );
}
