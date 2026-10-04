"use server";

/**
 * Server actions of the setup wizard. The claim needs the setup code; every later step needs a signed-in owner and
 * works only while setup is unfinished (afterwards the same settings live in the admin area).
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission, requestMeta, setSessionCookie, type SessionContext } from "@/lib/session";
import { setBillingEnabled } from "@/server/billing/entitlements";
import { listPlans, setPlanPrice } from "@/server/billing/plans";
import { checkStripeKey, ensureWebhook, syncPlanToStripe } from "@/server/billing/stripe";
import { AppError, badRequest, conflict } from "@/server/errors";
import { testMail } from "@/server/mail";
import { getSettings, normalizeDomains, SETTINGS_SCHEMAS, updateSettings, type EmailSettings } from "@/server/settings";
import { claimSetup, finishSetup, isSetupComplete, markSetupStep, publicUrlCheck } from "@/server/setup";
import { createInvites } from "@/server/users/invites";
import { currencyDigits, inputToMinor } from "./_lib/money";

/** Steps 2–6: a signed-in owner, and setup not finished yet. */
async function wizardOwner(): Promise<SessionContext> {
  const ctx = await checkPermission("owner");
  if (await isSetupComplete()) throw conflict("Setup is already finished. Change this in the admin area under Settings.", "setup_done");
  return ctx;
}

/** A zod error whose field names are the form's. */
function fieldError(field: string, message: string): z.ZodError {
  return new z.ZodError([{ code: "custom", path: [field], message, input: undefined }]);
}

/* ------------------------------------------------------------------ */
/* Step 1: claim                                                        */
/* ------------------------------------------------------------------ */

const claimSchema = z.object({
  code: z.string({ error: "Enter the setup code." }).trim().min(1, "Enter the setup code.").max(40, "That setup code is too long."),
  email: z.string({ error: "Enter your e-mail address." }).trim().min(1, "Enter your e-mail address.").max(254, "Enter a valid e-mail address."),
  name: z.string({ error: "Enter your name." }).trim().min(1, "Enter your name.").max(80, "Keep your name under 80 characters."),
});

/** Creates the first owner with the setup code, signs them in and opens step 2. */
export async function claimAction(input: { code: string; email: string; name: string }): Promise<ActionResult> {
  return runAction(async () => {
    // The session cookie and every link belong to the configured address; claiming anywhere else would lock the owner out.
    const check = publicUrlCheck(await headers());
    if (!check.ok) throw badRequest(`Open this page at ${check.publicUrl} to claim this cloud. Sign-in only works at that address.`, "wrong_address");
    const value = claimSchema.parse(input);
    const { sessionToken, expires } = await claimSetup(value, await requestMeta());
    await setSessionCookie(sessionToken, expires);
    redirect("/setup?step=cloud");
  });
}

/* ------------------------------------------------------------------ */
/* Step 2: your cloud                                                   */
/* ------------------------------------------------------------------ */

export interface CloudInput {
  appName: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
  imprintUrl: string;
}

const cloudSchema = z.object({
  appName: z.string().catch(""),
  supportEmail: z.string().catch(""),
  termsUrl: z.string().catch(""),
  privacyUrl: z.string().catch(""),
  imprintUrl: z.string().catch(""),
});

export async function saveCloudAction(input: CloudInput): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    await updateSettings("general", cloudSchema.parse(input), ctx);
  });
}

/* ------------------------------------------------------------------ */
/* Step 3: e-mail                                                       */
/* ------------------------------------------------------------------ */

export interface SmtpInput {
  host: string;
  port: number;
  security: EmailSettings["security"];
  username: string;
  /** Empty keeps a password stored earlier. */
  password: string;
  fromName: string;
  fromEmail: string;
}

function smtpSettings(input: SmtpInput): EmailSettings {
  const value = SETTINGS_SCHEMAS.email.parse({
    transport: "smtp",
    host: input?.host,
    port: input?.port,
    security: input?.security,
    username: input?.username,
    password: input?.password ?? "",
    fromName: input?.fromName,
    fromEmail: input?.fromEmail,
    replyTo: "",
  });
  if (!value.host) throw fieldError("host", "Enter the SMTP server.");
  if (!value.fromEmail) throw fieldError("fromEmail", "Enter the address e-mails are sent from.");
  return value;
}

/** Sends a test e-mail to the owner with the settings in the form. Stores nothing. */
export async function testEmailAction(input: SmtpInput): Promise<ActionResult<{ to: string }>> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    const result = await testMail(smtpSettings(input), ctx.user.email);
    if (!result.ok) throw new AppError(`Could not send the test e-mail: ${result.error}`, "mail_failed", 502);
    return { to: ctx.user.email };
  });
}

/** Stores the SMTP settings, but only after a test e-mail went out with them: a typo here would lock everyone out. */
export async function saveEmailAction(input: SmtpInput): Promise<ActionResult<{ to: string }>> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    const settings = smtpSettings(input);
    const result = await testMail(settings, ctx.user.email);
    if (!result.ok) throw new AppError(`Could not send a test e-mail with these settings, so nothing was saved: ${result.error}`, "mail_failed", 502);
    await updateSettings("email", settings, ctx);
    await markSetupStep("email", ctx);
    return { to: ctx.user.email };
  });
}

/* ------------------------------------------------------------------ */
/* Step 4: access                                                       */
/* ------------------------------------------------------------------ */

export interface AccessInput {
  mode: "invite" | "domains" | "open";
  /** Domains separated by commas, spaces or new lines. */
  domains: string;
  sessionDays: number;
}

const accessSchema = z.object({
  mode: z.enum(["invite", "domains", "open"], { error: "Choose who can sign in." }),
  domains: z.string().max(20_000, "Keep the list under 200 domains.").catch(""),
  sessionDays: z.number({ error: "Enter a whole number from 1 to 400." }),
});

async function saveAccess(input: AccessInput, ctx: SessionContext): Promise<void> {
  const value = accessSchema.parse(input);
  const domains = normalizeDomains(value.domains.split(/[\s,;]+/));
  if (value.mode === "domains" && domains.length === 0) throw fieldError("domains", "Enter at least one domain, like example.com.");
  try {
    await updateSettings(
      "auth",
      { inviteOnly: value.mode === "invite", allowedDomains: value.mode === "open" ? [] : domains, sessionDays: value.sessionDays },
      ctx,
    );
  } catch (err) {
    // The settings schema names the field `allowedDomains` (with an index); the form has one `domains` field.
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      const field = String(issue?.path[0]) === "allowedDomains" ? "domains" : String(issue?.path[0] ?? "form");
      throw fieldError(field, issue?.message ?? "Check this value.");
    }
    throw err;
  }
}

/** Saves who can sign in. `done` marks the step finished (the "Continue" button). */
export async function saveAccessAction(input: AccessInput, done: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    await saveAccess(input, ctx);
    if (done) await markSetupStep("access", ctx);
  });
}

export interface InviteOutcome {
  created: { email: string; url: string; emailed: boolean }[];
  skipped: { email: string; reason: string }[];
}

/** Saves the access rules first (invitations are checked against them), then invites the addresses. */
export async function inviteTeammatesAction(input: { access: AccessInput; emails: string; roleId: string }): Promise<ActionResult<InviteOutcome>> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    const emails = z.string().max(20_000, "Invite at most 100 people at once.").catch("").parse(input?.emails);
    const roleId = z.string({ error: "Choose a role." }).min(1, "Choose a role.").max(100).parse(input?.roleId);
    if (!emails.trim()) throw fieldError("emails", "Enter at least one e-mail address.");
    await saveAccess(input?.access, ctx);
    const { created, skipped } = await createInvites([emails], roleId, ctx);
    return { created: created.map((c) => ({ email: c.invite.email, url: c.url, emailed: c.emailed })), skipped };
  });
}

/* ------------------------------------------------------------------ */
/* Step 5: billing                                                      */
/* ------------------------------------------------------------------ */

/** Checks the secret key with Stripe and stores it. Nothing is charged until "Start charging now" is on. */
export async function connectStripeAction(secretKey: string): Promise<ActionResult<{ accountName: string; livemode: boolean }>> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    const { key } = z
      .object({ key: z.string({ error: "Enter the secret key." }).trim().min(1, "Enter the secret key.").max(500, "That key is too long.") })
      .parse({ key: secretKey });
    const result = await checkStripeKey(key);
    if (!result.ok) throw badRequest(result.error, "stripe_key");
    // The account's own currency is the natural default for the first prices.
    await updateSettings("billing", { stripeSecretKey: key, ...(result.defaultCurrency ? { currency: result.defaultCurrency } : {}) }, ctx);
    return { accountName: result.accountName, livemode: result.livemode };
  });
}

export interface StripeSetupInput {
  currency: string;
  /** Amounts as typed ("10.00"); an empty one leaves that price as it is. */
  prices: { planId: string; month: string; year: string }[];
}

export interface StripeSetupOutcome {
  /** Null when the webhook is in place; otherwise why it has to be added by hand. */
  webhookProblem: string | null;
}

const stripeSetupSchema = z.object({
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, "Enter a three-letter currency code like usd or eur."),
  prices: z.array(z.object({ planId: z.string().max(100), month: z.string().max(20), year: z.string().max(20) })).max(50),
});

/** Stores the prices, then creates the webhook and one Stripe product with its prices per paid plan. */
export async function createInStripeAction(input: StripeSetupInput): Promise<ActionResult<StripeSetupOutcome>> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    const value = stripeSetupSchema.parse(input);
    if (currencyDigits(value.currency) === null) throw fieldError("currency", "Enter a three-letter currency code like usd or eur.");
    const paid = (await listPlans()).filter((p) => !p.isFree);
    const amounts: { planId: string; interval: "month" | "year"; amount: number }[] = [];
    for (const row of value.prices) {
      if (!paid.some((p) => p.id === row.planId)) throw badRequest("One of these plans no longer exists. Reload the page.");
      for (const interval of ["month", "year"] as const) {
        const typed = row[interval].trim();
        if (!typed) continue;
        const amount = inputToMinor(typed, value.currency);
        if (amount === null || amount < 1) throw fieldError(`${row.planId}.${interval}`, "Enter an amount like 10.00.");
        amounts.push({ planId: row.planId, interval, amount });
      }
    }
    await updateSettings("billing", { currency: value.currency }, ctx);
    for (const a of amounts) await setPlanPrice(a.planId, { interval: a.interval, amount: a.amount, currency: value.currency }, ctx);
    const webhook = await ensureWebhook(ctx);
    for (const plan of paid) await syncPlanToStripe(plan.id, ctx);
    await markSetupStep("billing", ctx);
    return { webhookProblem: webhook.ok ? null : webhook.error };
  });
}

/** The "Start charging now" switch. Off: every account keeps everything. */
export async function setChargingAction(enabled: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await wizardOwner();
    if (enabled && !(await getSettings("billing")).stripeSecretKeySet) throw badRequest("Connect Stripe before turning billing on.");
    await setBillingEnabled(enabled === true, ctx);
  });
}

/* ------------------------------------------------------------------ */
/* Step 6: done                                                         */
/* ------------------------------------------------------------------ */

/** Ends the wizard and opens the dashboard. */
export async function finishSetupAction(): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("owner");
    await finishSetup(ctx);
    redirect("/");
  });
}
