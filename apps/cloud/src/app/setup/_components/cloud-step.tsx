"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { CopyField } from "@/components/copy-button";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { saveCloudAction, type CloudInput } from "../actions";
import { stepHref } from "../_lib/steps";
import { AddressNotice, type AddressCheck } from "./address-notice";
import { useStepAction } from "./use-step-action";

const FIELDS = ["appName", "supportEmail", "termsUrl", "privacyUrl", "imprintUrl"] as const;

/** Step 2: the cloud's name, contact and legal links, and the address it runs at. */
export function CloudStep({ initial, check }: { initial: CloudInput; check: AddressCheck }) {
  const router = useRouter();
  const [value, setValue] = useState<CloudInput>(initial);
  const [saved, setSaved] = useState<CloudInput>(initial);
  const { pending, error, fields, run } = useStepAction(FIELDS);
  const dirty = FIELDS.some((f) => value[f] !== saved[f]);
  const set = (field: keyof CloudInput) => (e: { target: { value: string } }) => setValue((v) => ({ ...v, [field]: e.target.value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(
      () => saveCloudAction(value),
      () => {
        setSaved(value);
        router.push(stepHref("email"));
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <UnsavedGuard when={dirty && !pending} />
      <StepHeader
        eyebrow="Identity"
        title="Your cloud"
        description="The name people see when they sign in and in every e-mail, and where they can reach you."
      />
      <div className="flex flex-col gap-5">
        <StepCard>
          <FormStack>
            <FormField label="Name" error={fields.appName} hint="Shown on the sign-in page, in the browser tab and in e-mails.">
              <Input name="appName" value={value.appName} onChange={set("appName")} maxLength={60} autoComplete="organization" required />
            </FormField>
            <FormField label="Support e-mail" optional error={fields.supportEmail} hint="Shown as “Contact” under pages and e-mails.">
              <Input
                type="email"
                name="supportEmail"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="support@example.com"
                value={value.supportEmail}
                onChange={set("supportEmail")}
              />
            </FormField>
            <FormField label="Terms" optional error={fields.termsUrl}>
              <Input type="url" name="termsUrl" inputMode="url" placeholder="https://example.com/terms" value={value.termsUrl} onChange={set("termsUrl")} />
            </FormField>
            <FormField label="Privacy policy" optional error={fields.privacyUrl}>
              <Input
                type="url"
                name="privacyUrl"
                inputMode="url"
                placeholder="https://example.com/privacy"
                value={value.privacyUrl}
                onChange={set("privacyUrl")}
              />
            </FormField>
            <FormField label="Imprint" optional error={fields.imprintUrl} hint="Legal links appear under the sign-in page, in the sidebar and in e-mails.">
              <Input
                type="url"
                name="imprintUrl"
                inputMode="url"
                placeholder="https://example.com/imprint"
                value={value.imprintUrl}
                onChange={set("imprintUrl")}
              />
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </StepCard>
        <StepCard>
          <div className="space-y-2">
            <p className="text-sm font-medium">Public address</p>
            <CopyField value={check.publicUrl} label="Copy the address" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Where people open this cloud and what you enter in Godmode to link a computer. It comes from{" "}
              <span className="font-mono text-foreground">DOMAIN</span> and cannot be changed here.
            </p>
          </div>
          {(!check.ok || !check.configured || (!check.https && !check.local)) && (
            <div className="mt-4">
              <AddressNotice check={check} />
            </div>
          )}
        </StepCard>
      </div>
      <StepFooter>
        <SubmitButton pending={pending} pendingLabel="Saving…" className="max-md:flex-1">
          Continue <ArrowRight />
        </SubmitButton>
      </StepFooter>
    </form>
  );
}
