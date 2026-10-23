import { env } from 'cloudflare:workers';

/** While the site runs on Stripe test keys, test-mode purchases count; with live keys only live ones do. */
export const minLivemode = () => (env.STRIPE_SECRET_KEY?.includes('_test_') ? 0 : 1);
