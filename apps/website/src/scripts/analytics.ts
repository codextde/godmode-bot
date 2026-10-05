// First-party, cookieless analytics + attribution + the consent-gated X pixel.

type Tracking = {
  x: string;
  xEvents: { purchase: string; checkout: string; lead: string; pricing: string };
};

declare global {
  interface Window {
    __gm?: boolean;
    __gmTracking?: Tracking;
    twq?: ((...args: unknown[]) => void) & { exe?: unknown; queue?: unknown[]; version?: string };
  }
}

const CONSENT_KEY = 'gm.consent';
const ATTR_KEY = 'gm.attribution';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export type Attribution = Partial<Record<(typeof UTM_KEYS)[number] | 'twclid' | 'referrer' | 'landing', string>>;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function consent(): 'all' | 'necessary' | null {
  const v = safeGet(CONSENT_KEY);
  return v === 'all' || v === 'necessary' ? v : null;
}

/** Attribution from this page's URL; with marketing consent also remembered across visits. */
export function attribution(): Attribution {
  const params = new URLSearchParams(location.search);
  const current: Attribution = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) current[k] = v.slice(0, 120);
  }
  const click = params.get('twclid');
  if (click) current.twclid = click.slice(0, 200);
  if (document.referrer && !document.referrer.startsWith(location.origin)) {
    current.referrer = document.referrer.slice(0, 200);
  }
  current.landing = location.pathname;

  if (consent() !== 'all') return current;
  let stored: Attribution = {};
  try {
    stored = JSON.parse(safeGet(ATTR_KEY) ?? '{}');
  } catch {
    /* ignore */
  }
  // A new campaign visit replaces the remembered one (last-touch); otherwise keep the first.
  const hasCampaign = Boolean(current.utm_source || current.twclid);
  const merged = hasCampaign ? current : { ...current, ...stored };
  safeSet(ATTR_KEY, JSON.stringify(merged));
  return merged;
}

function device() {
  const w = window.innerWidth;
  return w < 640 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';
}

/** Sends an anonymous event to /api/track. Never throws. */
export function track(type: string, label?: string) {
  try {
    const a = attribution();
    const body = JSON.stringify({
      type,
      label,
      path: location.pathname,
      referrer: a.referrer,
      utm_source: a.utm_source,
      utm_medium: a.utm_medium,
      utm_campaign: a.utm_campaign,
      utm_content: a.utm_content,
      click: Boolean(a.twclid),
      device: device(),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    } else {
      void fetch('/api/track', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } });
    }
  } catch {
    /* analytics must never break the page */
  }
}

// X pixel ------------------------------------------------------------------------------------

let pixelLoaded = false;

function loadXPixel() {
  const t = window.__gmTracking;
  if (pixelLoaded || !t?.x || new URLSearchParams(location.search).has('key')) return;
  pixelLoaded = true;
  /* eslint-disable */
  // Official X base code (uwt.js), unminified.
  const twq = function (...args: unknown[]) {
    const self = twq as unknown as { exe?: (...a: unknown[]) => void; queue: unknown[] };
    self.exe ? self.exe(...args) : self.queue.push(args);
  } as Window['twq'] & { queue: unknown[] };
  twq!.version = '1.1';
  twq!.queue = [];
  window.twq = twq;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://static.ads-twitter.com/uwt.js';
  document.head.appendChild(s);
  window.twq!('config', t.x);
}

/** Fires an X conversion event if the visitor accepted marketing cookies. */
export function xEvent(kind: keyof Tracking['xEvents'], params: Record<string, unknown> = {}) {
  const t = window.__gmTracking;
  const id = t?.xEvents?.[kind];
  if (!id || consent() !== 'all') return;
  loadXPixel();
  window.twq?.('event', id, params);
}

export function initConsent() {
  const el = document.getElementById('consent');
  const current = consent();
  if (current === 'all') loadXPixel();
  if (!el) return;
  if (!current) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('consent-in'));
  }
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-consent]');
    if (!btn) return;
    const choice = btn.dataset.consent === 'all' ? 'all' : 'necessary';
    const before = consent();
    safeSet(CONSENT_KEY, choice);
    if (before === 'all' && choice === 'necessary') {
      try {
        localStorage.removeItem(ATTR_KEY);
      } catch {
        /* ignore */
      }
      // The pixel can't be unloaded in place; a reload starts the page without it.
      location.reload();
      return;
    }
    track('consent', choice);
    el.classList.remove('consent-in');
    setTimeout(() => (el.hidden = true), 300);
    if (choice === 'all') {
      loadXPixel();
      attribution();
      window.dispatchEvent(new CustomEvent('gm:consent', { detail: choice }));
    }
  });
  document.querySelectorAll<HTMLElement>('[data-open-consent]').forEach((b) =>
    b.addEventListener('click', () => {
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('consent-in'));
    }),
  );
}
