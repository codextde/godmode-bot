"use server";

import { ZodError } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { revokeEverySession } from "@/server/auth/sessions";
import { setBillingEnabled } from "@/server/billing/entitlements";
import { checkStripeKey, ensureWebhook } from "@/server/billing/stripe";
import { badRequest } from "@/server/errors";
import { testMail } from "@/server/mail";
import { SETTINGS_PERMISSIONS } from "@/server/rbac/permissions";
import { getSettings, SETTINGS_SCHEMAS, updateSettings, type RedactedSettings } from "@/server/settings";
import type {
  AuthSettings,
  BillingSettings,
  EmailSettings,
  GeneralSettings,
  RelaySettings,
  SecuritySettings,
} from "@/server/settings/registry";

/*
 * Every action checks the group's permission itself and hands the session to `updateSettings`, which checks again.
 * Each one copies the fields it is meant to change by name, so a crafted request cannot slip in others (a secret, the
 * billing switch). Results are the redacted settings: secrets never travel back to the browser.
 */

/** An error on one field, in the shape `runAction` turns into `ActionResult.fields`. */
function fieldError(field: string, message: string): ZodError {
  return new ZodError([{ code: "custom", path: [field], message, input: undefined }]);
}

export async function saveGeneralAction(input: GeneralSettings): Promise<ActionResult<RedactedSettings<"general">>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.general);
    return updateSettings(
      "general",
      {
        appName: input.appName,
        supportEmail: input.supportEmail,
        termsUrl: input.termsUrl,
        privacyUrl: input.privacyUrl,
        imprintUrl: input.imprintUrl,
        announcement: input.announcement,
        announcementTone: input.announcementTone,
      },
      ctx,
    );
  });
}

/** Who can sign in, as the three choices of the form. */
export type AccessMode = "invite" | "domains" | "open";

export type AuthInput = Omit<AuthSettings, "inviteOnly"> & { access: AccessMode };

export async function saveAuthAction(input: AuthInput): Promise<ActionResult<RedactedSettings<"auth">>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.auth);
    if (input.access !== "invite" && input.access !== "domains" && input.access !== "open") {
      throw fieldError("access", "Choose who can sign in.");
    }
    const domains = Array.isArray(input.allowedDomains) ? input.allowedDomains : [];
    if (input.access === "domains" && domains.every((d) => !String(d).trim())) {
      throw fieldError("allowedDomains", "Add at least one domain, or choose another option.");
    }
    return updateSettings(
      "auth",
      {
        inviteOnly: input.access === "invite",
        // "Anyone" means no domain rule; invitations may be limited to domains as well.
        allowedDomains: input.access === "open" ? [] : domains,
        defaultRoleKey: input.defaultRoleKey,
        sessionDays: input.sessionDays,
        magicLinkMinutes: input.magicLinkMinutes,
        codeLogin: input.codeLogin,
        inviteDays: input.inviteDays,
      },
      ctx,
    );
  });
}

/**
 * "Test and save": SMTP settings are stored only after a test message went out with exactly these values in the same
 * submit. An empty password means the stored one. The test goes to the owner who is saving.
 */
export async function saveEmailAction(input: EmailSettings): Promise<ActionResult<{ settings: RedactedSettings<"email">; testedTo: string | null }>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.email);
    const value = SETTINGS_SCHEMAS.email.parse({
      transport: input.transport,
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      password: typeof input.password === "string" ? input.password : "",
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo,
    });
    let testedTo: string | null = null;
    if (value.transport === "smtp") {
      if (!value.host) throw fieldError("host", "Enter the SMTP server.");
      if (!value.fromEmail) throw fieldError("fromEmail", "Enter the address e-mails are sent from.");
      const test = await testMail(value, ctx.user.email);
      if (!test.ok) {
        throw badRequest(`Could not send the test e-mail, so nothing was saved. The mail server answered: ${test.error}`);
      }
      testedTo = ctx.user.email;
    }
    return { settings: await updateSettings("email", value, ctx), testedTo };
  });
}

export type BillingOptionsInput = Pick<
  BillingSettings,
  "currency" | "trialDays" | "allowPromotionCodes" | "automaticTax" | "taxBehavior" | "taxIdCollection" | "requireTermsConsent" | "pastDueGraceDays"
>;

export async function saveBillingOptionsAction(input: BillingOptionsInput): Promise<ActionResult<RedactedSettings<"billing">>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.billing);
    return updateSettings(
      "billing",
      {
        currency: input.currency,
        trialDays: input.trialDays,
        allowPromotionCodes: input.allowPromotionCodes,
        automaticTax: input.automaticTax,
        taxBehavior: input.taxBehavior,
        taxIdCollection: input.taxIdCollection,
        requireTermsConsent: input.requireTermsConsent,
        pastDueGraceDays: input.pastDueGraceDays,
      },
      ctx,
    );
  });
}

/** Stores a Stripe secret key only after Stripe accepted it. */
export async function saveStripeKeyAction(secretKey: string): Promise<ActionResult<{ livemode: boolean; accountName: string; defaultCurrency: string | null }>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.billing);
    const key = typeof secretKey === "string" ? secretKey.trim() : "";
    if (!key) throw fieldError("stripeSecretKey", "Paste the secret key from the Stripe Dashboard.");
    const check = await checkStripeKey(key);
    if (!check.ok) throw fieldError("stripeSecretKey", check.error);
    await updateSettings("billing", { stripeSecretKey: key }, ctx);
    return { livemode: check.livemode, accountName: check.accountName, defaultCurrency: check.defaultCurrency };
  });
}

export type WebhookSetup = { status: "ready"; endpointId: string } | { status: "manual"; reason: string };

/** Creates or repairs the webhook endpoint. When Stripe cannot do it, the page shows how to add it by hand. */
export async function setupWebhookAction(): Promise<ActionResult<WebhookSetup>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.billing);
    const result = await ensureWebhook(ctx);
    return result.ok ? { status: "ready" as const, endpointId: result.endpointId } : { status: "manual" as const, reason: result.error };
  });
}

/** The signing secret of an endpoint that was added in the Stripe Dashboard by hand. */
export async function saveWebhookSecretAction(secret: string): Promise<ActionResult<{ webhookSecretSet: boolean }>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.billing);
    const value = typeof secret === "string" ? secret.trim() : "";
    if (!/^whsec_\S+$/.test(value)) throw fieldError("webhookSecret", "That is not a signing secret. It starts with whsec_.");
    // The endpoint id belongs to an endpoint this cloud created itself; a hand-made one replaces it.
    const saved = await updateSettings("billing", { webhookSecret: value, webhookEndpointId: "" }, ctx);
    return { webhookSecretSet: saved.webhookSecretSet };
  });
}

export async function setBillingEnabledAction(enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.billing);
    await setBillingEnabled(enabled === true, ctx);
    return { enabled: (await getSettings("billing")).enabled };
  });
}

export async function saveRelayAction(input: RelaySettings): Promise<ActionResult<RedactedSettings<"relay">>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.relay);
    return updateSettings(
      "relay",
      {
        enabled: input.enabled,
        browserAccess: input.browserAccess,
        phoneGateway: input.phoneGateway,
        sharing: input.sharing,
        maxBodyMb: input.maxBodyMb,
        requestsPerMinute: input.requestsPerMinute,
      },
      ctx,
    );
  });
}

export async function saveSecurityAction(input: SecuritySettings): Promise<ActionResult<RedactedSettings<"security">>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.security);
    return updateSettings(
      "security",
      {
        loginPerEmail: input.loginPerEmail,
        loginPerIp: input.loginPerIp,
        auditRetentionDays: input.auditRetentionDays,
        trustProxy: input.trustProxy,
        trustedProxyHops: input.trustedProxyHops,
      },
      ctx,
    );
  });
}

/** Ends every sign-in except the one doing this. */
export async function signEveryoneOutAction(): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const ctx = await checkPermission(SETTINGS_PERMISSIONS.security);
    return { count: await revokeEverySession(ctx.session.id, ctx) };
  });
}
