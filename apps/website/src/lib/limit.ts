import { env } from 'cloudflare:workers';

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };

/** Per-IP rate limit (Workers rate limiting binding). Fails open when the binding is missing (local dev). */
export async function allowed(binding: 'CHECKOUT_LIMIT' | 'TRACK_LIMIT', request: Request): Promise<boolean> {
  const limiter = (env as unknown as Record<string, Limiter | undefined>)[binding];
  if (!limiter) return true;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: ip });
  return success;
}

export const BOTS = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|go-http|facebookexternalhit|scanner/i;
