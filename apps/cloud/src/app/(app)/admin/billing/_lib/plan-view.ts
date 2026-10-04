import type { PlanWithPrices } from "@/server/billing/plans";
import type { BadgeTone } from "@/components/data-display";

/** Where a plan stands in Stripe, for the badge in the list. */
export function stripeState(plan: PlanWithPrices, connected: boolean): { label: string; tone: BadgeTone } {
  if (plan.isFree) return { label: "Not sold", tone: "neutral" };
  if (!connected) return { label: "Stripe not connected", tone: "neutral" };
  if (plan.archived) return { label: plan.stripeProductId ? "Archived in Stripe" : "Archived", tone: "neutral" };
  if (!plan.stripeProductId) return { label: "Not in Stripe", tone: "warning" };
  if (plan.prices.some((p) => p.active && !p.stripePriceId)) return { label: "Needs sync", tone: "warning" };
  return { label: "In Stripe", tone: "positive" };
}

/** "5 computers · 100 GB/month · sharing" */
export function limitsSummary(limits: PlanWithPrices["limits"]): string {
  const parts = [
    limits.maxDevices === null ? "Unlimited computers" : `${limits.maxDevices} ${limits.maxDevices === 1 ? "computer" : "computers"}`,
    limits.relayGbPerMonth === null ? "unlimited traffic" : `${limits.relayGbPerMonth} GB/month`,
  ];
  const access = [limits.browserAccess && "browser", limits.phoneGateway && "phone", limits.sharing && "sharing"].filter(Boolean);
  if (access.length) parts.push(access.join(", "));
  return parts.join(" · ");
}

/** The plan as the form edits it: numbers and amounts stay text while typing. */
export interface PlanFormValue {
  key: string;
  name: string;
  description: string;
  features: string[];
  maxDevices: string;
  unlimitedDevices: boolean;
  relayGb: string;
  unlimitedRelay: boolean;
  browserAccess: boolean;
  phoneGateway: boolean;
  sharing: boolean;
  isPublic: boolean;
  highlighted: boolean;
  isFree: boolean;
  sort: string;
  priceMonth: string;
  priceYear: string;
}

/** A new plan's starting values. Lives here (not in the client module) so server pages can spread it. */
export function emptyPlanForm(): PlanFormValue {
  return {
    key: "",
    name: "",
    description: "",
    features: [],
    maxDevices: "1",
    unlimitedDevices: false,
    relayGb: "10",
    unlimitedRelay: false,
    browserAccess: true,
    phoneGateway: true,
    sharing: false,
    isPublic: true,
    highlighted: false,
    isFree: false,
    sort: "0",
    priceMonth: "",
    priceYear: "",
  };
}
