/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_X_PIXEL_ID?: string;
  readonly PUBLIC_X_EVENT_PURCHASE?: string;
  readonly PUBLIC_X_EVENT_CHECKOUT?: string;
  readonly PUBLIC_X_EVENT_LEAD?: string;
  readonly PUBLIC_X_EVENT_PRICING?: string;
  readonly PUBLIC_CF_BEACON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
    GITHUB_TOKEN?: string;
    STRIPE_AUTOMATIC_TAX?: string;
    STRIPE_MANAGED_PAYMENTS?: string;
    STRIPE_REQUIRE_TOS?: string;
    STRIPE_COLLECT_PROMOTIONS?: string;
  }
}
