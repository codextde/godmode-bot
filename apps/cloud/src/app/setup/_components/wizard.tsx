import { headers } from "next/headers";
import { SetupShell } from "@/components/setup-shell";
import type { SessionContext } from "@/lib/session";
import { emailDomain } from "@/server/auth/policy";
import { previewBillingEnable } from "@/server/billing/entitlements";
import { listPlans } from "@/server/billing/plans";
import { config } from "@/server/config";
import { sesHost, SES_REGIONS } from "@/server/mail";
import { listRoles } from "@/server/rbac";
import { getSettings } from "@/server/settings";
import { publicUrlCheck } from "@/server/setup";
import { minorToInput } from "../_lib/money";
import { accessMode, PUBLIC_MAIL_DOMAINS, SETUP_STEPS, type OwnerStepId } from "../_lib/steps";
import { AccessStep } from "./access-step";
import type { AddressCheck } from "./address-notice";
import { BillingStep, type BillingPlanRow } from "./billing-step";
import { ClaimStep } from "./claim-step";
import { CloudStep } from "./cloud-step";
import { DoneStep, type SummaryRow } from "./done-step";
import { EmailStep } from "./email-step";

const STEPS = [...SETUP_STEPS];

/** `publicUrlCheck` plus whether the configured address is this machine. */
export async function addressCheck(): Promise<AddressCheck> {
  const check = publicUrlCheck(await headers());
  let local = false;
  try {
    const host = new URL(check.publicUrl).hostname;
    local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    // An unparsable address is treated like a remote one: the https warning applies.
  }
  return { ...check, local };
}

/** Step 1, shown while nobody has an account. */
export async function ClaimWizard({ appName }: { appName: string }) {
  const check = await addressCheck();
  return (
    <SetupShell
      steps={STEPS}
      current={0}
      appName={appName}
      aside={<p>The setup code was printed in the server log when it started. It is also in setup-code.txt in the data folder.</p>}
    >
      <ClaimStep check={check} />
    </SetupShell>
  );
}

/** Steps 2–6 for the signed-in owner. Each step loads only what it shows. */
export async function OwnerWizard({ step, ctx }: { step: OwnerStepId; ctx: SessionContext }) {
  const general = await getSettings("general");
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <SetupShell
      steps={STEPS}
      current={index}
      appName={general.appName}
      aside={<p>You can leave at any time and come back: open /setup while signed in. Every choice here can be changed later in the admin area.</p>}
    >
      <OwnerStep step={step} ctx={ctx} />
    </SetupShell>
  );
}

async function OwnerStep({ step, ctx }: { step: OwnerStepId; ctx: SessionContext }) {
  switch (step) {
    case "cloud": {
      const [general, check] = await Promise.all([getSettings("general"), addressCheck()]);
      const { appName, supportEmail, termsUrl, privacyUrl, imprintUrl } = general;
      return <CloudStep initial={{ appName, supportEmail, termsUrl, privacyUrl, imprintUrl }} check={check} />;
    }
    case "email": {
      const email = await getSettings("email");
      return (
        <EmailStep
          initial={{ host: email.host, port: email.port, security: email.security, username: email.username, fromName: email.fromName, fromEmail: email.fromEmail }}
          passwordSet={email.passwordSet}
          configured={email.transport === "smtp"}
          regions={SES_REGIONS.map((region) => ({ region, host: sesHost(region) }))}
          ownerEmail={ctx.user.email}
        />
      );
    }
    case "access": {
      const [auth, email, setup, roles] = await Promise.all([getSettings("auth"), getSettings("email"), getSettings("setup"), listRoles()]);
      const ownerDomain = emailDomain(ctx.user.email);
      // Prefill the owner's domain once, and only when it says something about their organisation.
      const prefill = !setup.accessDone && auth.allowedDomains.length === 0 && !PUBLIC_MAIL_DOMAINS.includes(ownerDomain);
      const defaultRole = roles.find((r) => r.key === auth.defaultRoleKey) ?? roles.find((r) => r.key === "member") ?? roles[0];
      return (
        <AccessStep
          initial={{ mode: accessMode(auth), domains: prefill ? ownerDomain : auth.allowedDomains.join(", "), sessionDays: auth.sessionDays }}
          roles={roles.map((r) => ({ id: r.id, name: r.name }))}
          defaultRoleId={defaultRole?.id ?? ""}
          mailInLog={email.transport === "log"}
        />
      );
    }
    case "billing": {
      const [billing, plans, preview] = await Promise.all([getSettings("billing"), listPlans(), previewBillingEnable()]);
      const rows: BillingPlanRow[] = plans
        .filter((p) => !p.isFree)
        .map((p) => {
          const month = p.prices.find((x) => x.interval === "month");
          const year = p.prices.find((x) => x.interval === "year");
          return {
            id: p.id,
            name: p.name,
            month: month ? minorToInput(month.amount, month.currency) : "",
            year: year ? minorToInput(year.amount, year.currency) : "",
            synced: p.stripeProductId !== null && p.prices.length > 0 && p.prices.every((x) => x.stripePriceId !== null),
          };
        });
      return (
        <BillingStep
          connected={billing.stripeSecretKeySet}
          accountName={billing.stripeAccountName}
          livemode={billing.livemode}
          currency={billing.currency}
          plans={rows}
          webhookSet={billing.webhookSecretSet}
          charging={billing.enabled}
          preview={{
            people: preview.people,
            computersOverLimit: preview.computersOverLimit,
            freePlanName: preview.freePlan.name,
            freeDevices: preview.freePlan.limits.maxDevices,
          }}
        />
      );
    }
    case "done": {
      const [general, email, auth, billing] = await Promise.all([getSettings("general"), getSettings("email"), getSettings("auth"), getSettings("billing")]);
      const mode = accessMode(auth);
      const access =
        mode === "invite"
          ? auth.allowedDomains.length
            ? `Only invited people at ${auth.allowedDomains.join(", ")}`
            : "Only invited people"
          : mode === "domains"
            ? `Anyone at ${auth.allowedDomains.join(", ")}`
            : "Anyone with an e-mail address";
      const summary: SummaryRow[] = [
        { label: "Name", value: general.appName },
        { label: "Address", value: config().publicUrl, mono: true },
        email.transport === "smtp"
          ? { label: "E-mail", value: `SMTP via ${email.host}` }
          : { label: "E-mail", value: "Not set up — links go to the server log", todo: "email" },
        { label: "Who can sign in", value: access },
        { label: "Stay signed in for", value: auth.sessionDays === 1 ? "1 day" : `${auth.sessionDays} days` },
        billing.stripeSecretKeySet
          ? { label: "Billing", value: `Stripe (${billing.livemode ? "live" : "test"} mode), charging ${billing.enabled ? "on" : "off"}` }
          : { label: "Billing", value: "Free for everyone", todo: "billing" },
      ];
      return <DoneStep summary={summary} publicUrl={config().publicUrl} />;
    }
  }
}
