import Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { PRICING, type Plan } from '@/config/site';

let client: Stripe | undefined;

/** Stripe client for Workers: fetch-based HTTP and SubtleCrypto for webhook signatures. */
export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    appInfo: { name: 'godmode-website' },
  });
  return client;
}

export const cryptoProvider = Stripe.createSubtleCryptoProvider();

const priceCache = new Map<string, string>();

/** Resolves a plan's price by lookup key (set up by scripts/stripe-setup.mjs), cached per isolate. */
export async function priceFor(plan: Plan): Promise<string> {
  const key = PRICING.plans[plan].lookupKey;
  const cached = priceCache.get(key);
  if (cached) return cached;
  const prices = await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) throw new Error(`No active Stripe price with lookup key "${key}" — run \`pnpm stripe:setup\``);
  priceCache.set(key, price.id);
  return price.id;
}

export const flag = (v: string | undefined) => v === 'true' || v === '1';
