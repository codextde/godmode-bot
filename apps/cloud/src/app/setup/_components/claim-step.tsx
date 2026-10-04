"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { claimAction } from "../actions";
import { AddressNotice, type AddressCheck } from "./address-notice";
import { useStepAction } from "./use-step-action";

/** Step 1: the setup code plus the owner's e-mail and name. */
export function ClaimStep({ check }: { check: AddressCheck }) {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const { pending, error, fields, run } = useStepAction(["code", "email", "name"]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok) return;
    run(() => claimAction({ code, email, name }));
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepHeader
        eyebrow="Welcome"
        title="Claim this cloud"
        description="You become its owner: the account that can change every setting and invite everyone else. The setup code proves that you run this server."
      />
      <div className="flex flex-col gap-5">
        <AddressNotice check={check} />
        <StepCard>
          <FormStack>
            <FormField
              label="Setup code"
              error={fields.code}
              hint="Printed in the server log at start, and saved as setup-code.txt in the data folder."
            >
              <Input
                name="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={40}
                className="font-mono tracking-wider tabular-nums"
                autoFocus
                required
              />
            </FormField>
            <FormField label="Your e-mail" error={fields.email} hint="You sign in with a link sent to this address. There is no password.">
              <Input
                type="email"
                name="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Your name" error={fields.name}>
              <Input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </StepCard>
      </div>
      <StepFooter>
        <SubmitButton pending={pending} pendingLabel="Claiming…" disabled={!check.ok} className="max-md:flex-1">
          Claim and continue <ArrowRight />
        </SubmitButton>
      </StepFooter>
    </form>
  );
}
