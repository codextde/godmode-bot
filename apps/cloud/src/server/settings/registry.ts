/**
 * Every DB-backed setting: types, defaults and validation. One row per group in `settings`.
 *
 * Not configurable on purpose:
 * - Logo, accent colour and e-mail body texts: the product is Godmode-branded; `general.appName` and
 *   `email.fromName` cover naming.
 * - Language: English only, like the desktop app.
 * - Protocol safety constants (wrong-code attempts, stream and socket caps, link/pair/connect rate limits): changing
 *   them weakens guarantees the rest of the system relies on.
 */
import { z } from "zod";

export interface GeneralSettings {
  appName: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
  imprintUrl: string;
  /** Shown as a bar in the app and on the sign-in page while not empty. */
  announcement: string;
  announcementTone: "info" | "warning";
}

export interface AuthSettings {
  /** Only invited e-mail addresses (and existing accounts) may sign in. */
  inviteOnly: boolean;
  /** Empty: any domain. Otherwise sign-in and invites need an exact match of the part after "@". */
  allowedDomains: string[];
  /** Role of people who join without an invite (open sign-up). Never owner, never a role with admin.access. */
  defaultRoleKey: string;
  /** Browsers cap cookie lifetime near 400 days. */
  sessionDays: number;
  magicLinkMinutes: number;
  /** The sign-in e-mail also carries an 8-digit code for the browser that asked. */
  codeLogin: boolean;
  inviteDays: number;
}

export interface EmailSettings {
  /** "log": the message (with its link) is printed to the server log. */
  transport: "log" | "smtp";
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username: string;
  /** Secret. */
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
}

export interface BillingSettings {
  enabled: boolean;
  /** Secret. */
  stripeSecretKey: string;
  /** Secret. */
  webhookSecret: string;
  webhookEndpointId: string;
  portalConfigurationId: string;
  /** Default currency of new prices; existing prices keep theirs. */
  currency: string;
  trialDays: number;
  allowPromotionCodes: boolean;
  automaticTax: boolean;
  /** A past_due subscription keeps its plan this long. */
  pastDueGraceDays: number;
  taxBehavior: "inclusive" | "exclusive";
  taxIdCollection: boolean;
  /** Needs `general.termsUrl`. */
  requireTermsConsent: boolean;
  /** Set by checkStripeKey. */
  stripeAccountName: string;
  livemode: boolean | null;
}

export interface RelaySettings {
  /** Master switch for the relay. */
  enabled: boolean;
  browserAccess: boolean;
  phoneGateway: boolean;
  sharing: boolean;
  maxBodyMb: number;
  /** Per computer; 0 = unlimited. */
  requestsPerMinute: number;
}

export interface SecuritySettings {
  /** Sign-in e-mails per address per 15 minutes. */
  loginPerEmail: number;
  /** Sign-in e-mails per IP per 15 minutes. */
  loginPerIp: number;
  /** 0 = keep forever. */
  auditRetentionDays: number;
  /** Take the client address from X-Forwarded-For when the request comes from a proxy on a private network. */
  trustProxy: boolean;
  /** Proxies in front of the app that append to X-Forwarded-For (Traefik alone = 1). */
  trustedProxyHops: number;
}

export interface SetupSettings {
  completedAt: string | null;
  /** keyedHash of the setup code while nobody has claimed the instance. */
  codeHash: string | null;
  emailDone: boolean;
  accessDone: boolean;
  billingDone: boolean;
}

export interface AllSettings {
  general: GeneralSettings;
  auth: AuthSettings;
  email: EmailSettings;
  billing: BillingSettings;
  relay: RelaySettings;
  security: SecuritySettings;
  setup: SetupSettings;
}

export type SettingsGroup = keyof AllSettings;

export const SETTINGS_GROUPS: SettingsGroup[] = ["general", "auth", "email", "billing", "relay", "security", "setup"];

/** Fields stored encrypted, never returned by `getSettings`. */
export const SECRET_FIELDS = {
  general: [],
  auth: [],
  email: ["password"],
  billing: ["stripeSecretKey", "webhookSecret"],
  relay: [],
  security: [],
  setup: [],
} as const satisfies { [K in SettingsGroup]: readonly (keyof AllSettings[K])[] };

export type SecretField<K extends SettingsGroup> = (typeof SECRET_FIELDS)[K][number];

/** What forms see: secret fields are "" and `<field>Set` says whether one is stored. */
export type RedactedSettings<K extends SettingsGroup> = AllSettings[K] & { [F in SecretField<K> as `${F}Set`]: boolean };

/** A patch: an empty secret means "keep the stored one", null means "remove it". */
export type SettingsPatch<K extends SettingsGroup> = {
  [F in keyof AllSettings[K]]?: F extends SecretField<K> ? AllSettings[K][F] | null : AllSettings[K][F];
};

export const SETTINGS_DEFAULTS: AllSettings = {
  general: {
    appName: "Godmode Cloud",
    supportEmail: "",
    termsUrl: "",
    privacyUrl: "",
    imprintUrl: "",
    announcement: "",
    announcementTone: "info",
  },
  auth: {
    inviteOnly: true,
    allowedDomains: [],
    defaultRoleKey: "member",
    sessionDays: 365,
    magicLinkMinutes: 15,
    codeLogin: true,
    inviteDays: 14,
  },
  email: {
    transport: "log",
    host: "",
    port: 587,
    security: "starttls",
    username: "",
    password: "",
    fromName: "",
    fromEmail: "",
    replyTo: "",
  },
  billing: {
    enabled: false,
    stripeSecretKey: "",
    webhookSecret: "",
    webhookEndpointId: "",
    portalConfigurationId: "",
    currency: "usd",
    trialDays: 0,
    allowPromotionCodes: true,
    automaticTax: false,
    pastDueGraceDays: 7,
    taxBehavior: "inclusive",
    taxIdCollection: true,
    requireTermsConsent: false,
    stripeAccountName: "",
    livemode: null,
  },
  relay: {
    enabled: true,
    browserAccess: true,
    phoneGateway: true,
    sharing: true,
    maxBodyMb: 64,
    requestsPerMinute: 1200,
  },
  security: {
    loginPerEmail: 5,
    loginPerIp: 20,
    auditRetentionDays: 365,
    trustProxy: true,
    trustedProxyHops: 1,
  },
  setup: {
    completedAt: null,
    codeHash: null,
    emailDone: false,
    accessDone: false,
    billingDone: false,
  },
};

/** An address the way people type it; the sign-in rules (auth/policy.ts) are stricter. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Lower-case ASCII host name with at least one dot, as compared with the part after "@". */
export const DOMAIN_SHAPE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const int = (min: number, max: number) =>
  z
    .number({ error: `Enter a whole number from ${min} to ${max}.` })
    .int(`Enter a whole number from ${min} to ${max}.`)
    .min(min, `Enter a whole number from ${min} to ${max}.`)
    .max(max, `Enter a whole number from ${min} to ${max}.`);

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`);

const optionalEmail = z
  .string()
  .trim()
  .max(254, "Enter a valid e-mail address.")
  .refine((v) => v === "" || EMAIL_SHAPE.test(v), "Enter a valid e-mail address.");

const optionalUrl = z
  .string()
  .trim()
  .max(500, "Keep this under 500 characters.")
  .refine((v) => v === "" || isWebUrl(v), "Enter a full address starting with https://.");

/** Lower-cased, without "@", de-duplicated; each entry must be a domain. */
export function normalizeDomains(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const domain = raw.trim().toLowerCase().replace(/^@+/, "");
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

const domains = z
  .array(z.string().max(253, "Enter domains like example.com."), { error: "Enter domains like example.com." })
  .max(200, "Keep the list under 200 domains.")
  .transform(normalizeDomains)
  .superRefine((list, ctx) => {
    for (const domain of list) {
      if (!DOMAIN_SHAPE.test(domain)) ctx.addIssue({ code: "custom", message: `"${domain}" is not a domain. Write it like example.com.` });
    }
  });

export const SETTINGS_SCHEMAS: { [K in SettingsGroup]: z.ZodType<AllSettings[K]> } = {
  general: z.object({
    appName: text(60).min(1, "Enter a name."),
    supportEmail: optionalEmail,
    termsUrl: optionalUrl,
    privacyUrl: optionalUrl,
    imprintUrl: optionalUrl,
    announcement: text(280),
    announcementTone: z.enum(["info", "warning"]),
  }),
  auth: z.object({
    inviteOnly: z.boolean(),
    allowedDomains: domains,
    defaultRoleKey: text(40).min(1, "Choose a role."),
    sessionDays: int(1, 400),
    magicLinkMinutes: int(5, 60),
    codeLogin: z.boolean(),
    inviteDays: int(1, 90),
  }),
  email: z.object({
    transport: z.enum(["log", "smtp"]),
    host: text(253),
    port: int(1, 65535),
    security: z.enum(["starttls", "tls", "none"]),
    username: text(254),
    password: z.string().max(1000, "Keep this under 1000 characters."),
    fromName: text(80),
    fromEmail: optionalEmail,
    replyTo: optionalEmail,
  }),
  billing: z.object({
    enabled: z.boolean(),
    stripeSecretKey: z.string().trim().max(500, "Keep this under 500 characters."),
    webhookSecret: z.string().trim().max(500, "Keep this under 500 characters."),
    webhookEndpointId: text(200),
    portalConfigurationId: text(200),
    currency: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z]{3}$/, "Enter a three-letter currency code like usd or eur."),
    trialDays: int(0, 365),
    allowPromotionCodes: z.boolean(),
    automaticTax: z.boolean(),
    pastDueGraceDays: int(0, 60),
    taxBehavior: z.enum(["inclusive", "exclusive"]),
    taxIdCollection: z.boolean(),
    requireTermsConsent: z.boolean(),
    stripeAccountName: text(200),
    livemode: z.boolean().nullable(),
  }),
  relay: z.object({
    enabled: z.boolean(),
    browserAccess: z.boolean(),
    phoneGateway: z.boolean(),
    sharing: z.boolean(),
    maxBodyMb: int(1, 2048),
    requestsPerMinute: int(0, 100_000),
  }),
  security: z.object({
    loginPerEmail: int(1, 100),
    loginPerIp: int(1, 10_000),
    auditRetentionDays: int(0, 3650),
    trustProxy: z.boolean(),
    trustedProxyHops: int(1, 5),
  }),
  setup: z.object({
    completedAt: z.string().nullable(),
    codeHash: z.string().nullable(),
    emailDone: z.boolean(),
    accessDone: z.boolean(),
    billingDone: z.boolean(),
  }),
};
