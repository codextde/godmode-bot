import type { AstroGlobal } from 'astro';
import { href, langOf } from '@/i18n';
import { isLicenseKey } from '@/lib/license';
import { keyFromCookie, setKeyCookie } from '@/lib/signed';

export interface DownloadProps {
  key: string;
  phone: boolean;
  notMac: boolean;
  intel: boolean;
}

/** Request handling shared by /download and /de/download: either a redirect to return, or the props for the view. */
export async function downloadRequest(Astro: AstroGlobal): Promise<Response | DownloadProps> {
  const path = href(langOf(Astro.url), '/download');
  // ?key=GM-… arrives from the welcome page's "send to my computer" link. Move it into a cookie and reload the clean
  // URL before anything renders, so the key never sits in the address bar, history, analytics or the ad pixel.
  if (Astro.url.searchParams.has('key')) {
    await setKeyCookie(Astro.cookies, Astro.url.searchParams.get('key') ?? '', Astro.url.protocol === 'https:');
    const clean = new URLSearchParams(Astro.url.searchParams);
    clean.delete('key');
    Astro.response.headers.set('cache-control', 'no-store');
    return Astro.redirect(clean.size ? `${path}?${clean}` : path, 303);
  }
  const rawKey = ((await keyFromCookie(Astro.cookies)) ?? '').toUpperCase();
  const ua = Astro.request.headers.get('user-agent') ?? '';
  const phone = /iPhone|iPad|iPod|Android/i.test(ua);
  Astro.response.headers.set('cache-control', 'no-store');
  Astro.response.headers.set('referrer-policy', 'same-origin');
  return {
    key: isLicenseKey(rawKey) ? rawKey : '',
    phone,
    notMac: !phone && /Windows|Linux|CrOS/i.test(ua),
    intel: Astro.url.searchParams.get('platform') === 'mac-intel',
  };
}
