import type { SetupStep } from "@/components/setup-shell";

/** The wizard's steps in order; the id is the `?step=` value. */
export const SETUP_STEPS = [
  { id: "claim", title: "Welcome", hint: "Claim this cloud" },
  { id: "cloud", title: "Your cloud", hint: "Name and address" },
  { id: "email", title: "E-mail", hint: "Sign-in links" },
  { id: "access", title: "Access", hint: "Who can sign in" },
  { id: "billing", title: "Billing", hint: "Stripe", optional: true },
  { id: "done", title: "Done", hint: "Link a computer" },
] as const satisfies readonly SetupStep[];

export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

/** Steps after the claim; they need a signed-in owner. */
export type OwnerStepId = Exclude<SetupStepId, "claim">;

export function stepHref(id: SetupStepId): string {
  return `/setup?step=${id}`;
}

/** The step named by `?step=`, or the first one after the claim. */
export function ownerStep(value: string | string[] | undefined): OwnerStepId {
  const id = Array.isArray(value) ? value[0] : value;
  const found = SETUP_STEPS.find((s) => s.id === id);
  return found && found.id !== "claim" ? found.id : "cloud";
}

/** Mail providers whose domain says nothing about an organisation: never prefilled as the allowed domain. */
export const PUBLIC_MAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "proton.me",
  "protonmail.com",
  "t-online.de",
];

export type AccessMode = "invite" | "domains" | "open";

/** The three choices of the access step, from the stored settings. */
export function accessMode(auth: { inviteOnly: boolean; allowedDomains: string[] }): AccessMode {
  if (auth.inviteOnly) return "invite";
  return auth.allowedDomains.length ? "domains" : "open";
}
