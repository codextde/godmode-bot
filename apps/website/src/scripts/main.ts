import { attribution, initConsent, track, xEvent } from './analytics';
import { initDotField } from './dotfield';
import { initCharacters } from './characters';
import { FOUNDING, isPlan, PRICING } from '@/config/site';

window.__gm = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Reveal on scroll -----------------------------------------------------------------------------
const revealIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('is-in');
        revealIO.unobserve(e.target);
      }
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
);
document.querySelectorAll('[data-reveal],[data-words]').forEach((el) => revealIO.observe(el));

// Cursor spotlight on cards ----------------------------------------------------------------------
document.addEventListener(
  'pointermove',
  (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  },
  { passive: true },
);

// Nav: solid after scrolling, highlight the section in view ----------------------------------------
const nav = document.querySelector<HTMLElement>('[data-nav]');
const stickyCta = document.querySelector<HTMLElement>('[data-sticky-cta]');
const hero = document.querySelector<HTMLElement>('[data-hero]');
const pricing = document.getElementById('pricing');
let ticking = false;
function onScroll() {
  ticking = false;
  const y = scrollY;
  nav?.classList.toggle('is-scrolled', y > 12);
  if (stickyCta && hero) {
    const heroBottom = hero.offsetTop + hero.offsetHeight;
    const pricingTop = pricing ? pricing.offsetTop - innerHeight * 0.6 : Infinity;
    const pricingBottom = pricing ? pricing.offsetTop + pricing.offsetHeight : 0;
    const show = y > heroBottom - 120 && !(y > pricingTop && y < pricingBottom);
    stickyCta.classList.toggle('is-shown', show);
  }
}
addEventListener(
  'scroll',
  () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScroll);
    }
  },
  { passive: true },
);
onScroll();

const navLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-nav-link]')];
if (navLinks.length) {
  const sectionIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.id;
        navLinks.forEach((a) => a.classList.toggle('is-active', a.hash === `#${id}`));
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  navLinks.forEach((a) => {
    const target = a.hash && document.querySelector(a.hash);
    if (target) sectionIO.observe(target);
  });
}

// Mobile menu -----------------------------------------------------------------------------------
const menuBtn = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
const menu = document.querySelector<HTMLElement>('[data-menu]');
menuBtn?.addEventListener('click', () => {
  const open = menuBtn.getAttribute('aria-expanded') !== 'true';
  menuBtn.setAttribute('aria-expanded', String(open));
  menu?.classList.toggle('is-open', open);
  document.documentElement.classList.toggle('menu-open', open);
});
menu?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('a')) {
    menuBtn?.setAttribute('aria-expanded', 'false');
    menu.classList.remove('is-open');
    document.documentElement.classList.remove('menu-open');
  }
});

// Hero: the product window starts tilted and settles flat as you scroll ---------------------------
const tilt = document.querySelector<HTMLElement>('[data-tilt]');
if (tilt && !reduced) {
  let raf = 0;
  const update = () => {
    raf = 0;
    const r = tilt.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, 1 - (r.top - innerHeight * 0.15) / (innerHeight * 0.75)));
    tilt.style.setProperty('--t', p.toFixed(3));
  };
  addEventListener('scroll', () => (raf ||= requestAnimationFrame(update)), { passive: true });
  update();
}

// Dot field behind the hero ---------------------------------------------------------------------
const field = document.querySelector<HTMLCanvasElement>('[data-dotfield]');
if (field) initDotField(field, reduced);

// Agent characters (eyes follow the pointer, crew picker, expression + studio demos) ----------------
initCharacters(reduced);

// Videos: play only while visible (saves battery + bandwidth) ----------------------------------
const videoIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) {
        if (v.preload === 'none') v.preload = 'auto';
        void v.play().catch(() => {});
      } else v.pause();
    }
  },
  { threshold: 0.25 },
);
document.querySelectorAll<HTMLVideoElement>('video[data-autoplay]').forEach((v) => {
  // Fade a video in only once it actually plays; until then the poster/screenshot underneath shows.
  v.addEventListener('playing', () => v.classList.add('is-playing'), { once: true });
  if (reduced) {
    v.removeAttribute('autoplay');
    return;
  }
  videoIO.observe(v);
});

// Video modal ----------------------------------------------------------------------------------
const modal = document.querySelector<HTMLDialogElement>('[data-video-modal]');
document.querySelectorAll<HTMLElement>('[data-open-video]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!modal) return;
    modal.showModal();
    const v = modal.querySelector('video');
    if (v) {
      v.currentTime = 0;
      void v.play().catch(() => {});
    }
    track('video_play', b.dataset.openVideo);
  }),
);
modal?.addEventListener('click', (e) => {
  if (e.target === modal || (e.target as HTMLElement).closest('[data-close]')) {
    modal.querySelector('video')?.pause();
    modal.close();
  }
});
modal?.addEventListener('close', () => modal.querySelector('video')?.pause());

// Count-up numbers -------------------------------------------------------------------------------
const fmt = (n: number, decimals = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
function countUp(el: HTMLElement, to: number, duration = 1400) {
  const decimals = Number(el.dataset.decimals ?? 0);
  const prefix = el.dataset.prefix ?? '';
  const suffix = el.dataset.suffix ?? '';
  if (reduced) {
    el.textContent = prefix + fmt(to, decimals) + suffix;
    return;
  }
  const from = Number(el.dataset.from ?? 0);
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = prefix + fmt(from + (to - from) * eased, decimals) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const countIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      countUp(el, Number(el.dataset.count));
      countIO.unobserve(el);
    }
  },
  { threshold: 0.6 },
);
document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => countIO.observe(el));

// Typewriter (used by use-case prompts) ----------------------------------------------------------
async function typeInto(el: HTMLElement, text: string, signal: { cancelled: boolean }) {
  el.textContent = '';
  if (reduced) {
    el.textContent = text;
    return;
  }
  for (let i = 0; i < text.length; i++) {
    if (signal.cancelled) return;
    el.textContent = text.slice(0, i + 1);
    const ch = text[i];
    await new Promise((r) => setTimeout(r, ch === ',' || ch === '.' ? 90 : 14 + Math.random() * 22));
  }
}

// Use-case tabs ------------------------------------------------------------------------------------
document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((root) => {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  let signal = { cancelled: false };
  let auto: number | undefined;
  let userPicked = false;

  const select = (i: number, byUser = false) => {
    if (byUser) {
      userPicked = true;
      track('usecase', tabs[i].dataset.key);
    }
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
    });
    panels.forEach((p, j) => {
      p.hidden = i !== j;
      p.classList.toggle('is-in', i === j);
    });
    signal.cancelled = true;
    signal = { cancelled: false };
    const panel = panels[i];
    const prompt = panel.querySelector<HTMLElement>('[data-type]');
    const steps = [...panel.querySelectorAll<HTMLElement>('[data-step]')];
    steps.forEach((s) => s.classList.remove('is-done'));
    const mySignal = signal;
    void (async () => {
      if (prompt) await typeInto(prompt, prompt.dataset.type ?? '', mySignal);
      for (const s of steps) {
        if (mySignal.cancelled) return;
        await new Promise((r) => setTimeout(r, reduced ? 0 : 520));
        s.classList.add('is-done');
      }
      if (!userPicked && !mySignal.cancelled) {
        auto = window.setTimeout(() => select((i + 1) % tabs.length), 3200);
      }
    })();
  };

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => {
      clearTimeout(auto);
      select(i, true);
    });
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (i + d + tabs.length) % tabs.length;
      tabs[n].focus();
      clearTimeout(auto);
      select(n, true);
    });
  });

  const startIO = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        select(0);
        startIO.disconnect();
      }
    },
    { threshold: 0.35 },
  );
  startIO.observe(root);
});

// ROI calculator ----------------------------------------------------------------------------------
const roi = document.querySelector<HTMLElement>('[data-roi]');
if (roi) {
  const hours = roi.querySelector<HTMLInputElement>('[name="hours"]')!;
  const rate = roi.querySelector<HTMLInputElement>('[name="rate"]')!;
  const out = (k: string) => roi.querySelector<HTMLElement>(`[data-out="${k}"]`)!;
  let tracked = false;
  const paint = (input: HTMLInputElement) => {
    const p = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
    input.style.setProperty('--p', `${p}%`);
  };
  const update = () => {
    const h = Number(hours.value);
    const r = Number(rate.value);
    // Assume Godmode takes over 70% of the repetitive hours you describe — deliberately conservative.
    const savedHoursYear = Math.round(h * 0.7 * 48);
    const savedYear = savedHoursYear * r;
    const yearlyCost = Number(roi.dataset.roiCost) || PRICING.plans.yearly.price;
    const paybackDays = savedYear > 0 ? Math.max(1, Math.ceil(yearlyCost / (savedYear / 365))) : 0;
    out('hours').textContent = String(h);
    out('rate').textContent = `$${r}`;
    out('saved-hours').textContent = fmt(savedHoursYear);
    out('saved').textContent = `$${fmt(savedYear)}`;
    out('payback').textContent = paybackDays <= 1 ? '1 day' : `${paybackDays} days`;
    out('weekly-loss').textContent = `$${fmt(Math.round(h * 0.7 * r))}`;
    paint(hours);
    paint(rate);
  };
  [hours, rate].forEach((i) =>
    i.addEventListener('input', () => {
      update();
      if (!tracked) {
        tracked = true;
        track('roi_calc');
      }
    }),
  );
  update();
}

// Checkout forms: attach attribution, show progress, fire conversion events -----------------------
document.querySelectorAll<HTMLFormElement>('form[data-checkout]').forEach((form) => {
  form.addEventListener('submit', () => {
    const picked = new FormData(form).get('plan');
    const plan = isPlan(picked) ? picked : 'monthly';
    const a = attribution();
    for (const [k, v] of Object.entries(a)) {
      let input = form.querySelector<HTMLInputElement>(`input[name="${k}"]`);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = k;
        form.appendChild(input);
      }
      input.value = v ?? '';
    }
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (btn) {
      btn.dataset.loading = 'true';
      btn.setAttribute('aria-busy', 'true');
    }
    track('checkout_start', `${plan}:${form.dataset.checkout || 'page'}`);
    xEvent('checkout', { value: PRICING.plans[plan].price, currency: PRICING.currency, contents: [{ content_id: plan }] });
  });
});
// Founding 100: live countdown to the real deadline, and seats left once enough are taken.
const countdowns = document.querySelectorAll<HTMLElement>('[data-countdown]');
if (countdowns.length) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tick = () => {
    const ms = Number(countdowns[0].dataset.end) - Date.now();
    if (ms <= 0) {
      countdowns.forEach((el) => el.setAttribute('data-ended', ''));
      return false;
    }
    const s = Math.floor(ms / 1000);
    const parts = { d: String(Math.floor(s / 86400)), h: pad(Math.floor(s / 3600) % 24), m: pad(Math.floor(s / 60) % 60), s: pad(s % 60) };
    countdowns.forEach((el) =>
      el.querySelectorAll<HTMLElement>('[data-cd]').forEach((b) => {
        const v = parts[b.dataset.cd as keyof typeof parts];
        if (b.textContent !== v) b.textContent = v;
      }),
    );
    return true;
  };
  if (tick()) {
    const timer = setInterval(() => {
      if (!tick()) clearInterval(timer);
    }, 1000);
  }
}

const foundingSlots = document.querySelectorAll<HTMLElement>('[data-founding-slot]');
if (foundingSlots.length) {
  const elapsed = (Date.now() - FOUNDING.start) / (FOUNDING.end - FOUNDING.start);
  foundingSlots.forEach((slot) => slot.style.setProperty('--taken', `${Math.max(0, Math.min(100, elapsed * 100))}%`));
  fetch('/api/offer', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((res: unknown) => {
      const data = (res ?? {}) as { seats?: unknown; left?: unknown; open?: unknown };
      foundingSlots.forEach((slot) => {
        const label = slot.querySelector<HTMLElement>('[data-founding-label]');
        if (data.open === false) {
          if (label) label.textContent = 'Founding seats are gone';
          slot.style.setProperty('--taken', '100%');
        } else if (typeof data.left === 'number' && typeof data.seats === 'number') {
          if (label) label.textContent = `${data.left} of ${data.seats} seats left`;
          slot.style.setProperty('--taken', `${Math.min(100, ((data.seats - data.left) / data.seats) * 100)}%`);
        }
      });
    })
    .catch(() => {});
}

// Back/forward cache: reset spinners when the visitor returns from Stripe.
addEventListener('pageshow', (e) => {
  if (e.persisted) document.querySelectorAll<HTMLButtonElement>('[data-loading]').forEach((b) => delete b.dataset.loading);
});

// Lead form -------------------------------------------------------------------------------------
document.querySelectorAll<HTMLFormElement>('form[data-lead]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const a = attribution();
    const status = form.querySelector<HTMLElement>('[data-status]');
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (btn) btn.dataset.loading = 'true';
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          source: form.dataset.lead,
          utm_source: a.utm_source,
          utm_campaign: a.utm_campaign,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      form.classList.add('is-done');
      if (status) status.textContent = 'You’re on the list. Check your inbox soon.';
      track('lead', form.dataset.lead);
      xEvent('lead');
    } catch {
      if (status) status.textContent = 'That didn’t work — please check the address and try again.';
    } finally {
      if (btn) delete btn.dataset.loading;
    }
  });
});

// Generic click tracking + section views ---------------------------------------------------------
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-track]');
  if (el) track('click', el.dataset.track);
});
const viewIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      track('view', el.dataset.trackView);
      if (el.dataset.trackView === 'pricing') xEvent('pricing');
      viewIO.unobserve(el);
    }
  },
  { threshold: 0.35 },
);
document.querySelectorAll<HTMLElement>('[data-track-view]').forEach((el) => viewIO.observe(el));

document.querySelectorAll<HTMLDetailsElement>('details[data-faq]').forEach((d) =>
  d.addEventListener('toggle', () => d.open && track('faq', d.dataset.faq)),
);

// Copy-to-clipboard buttons ------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy ?? '');
      const label = b.querySelector('[data-copy-label]');
      const prev = label?.textContent;
      if (label) label.textContent = 'Copied';
      setTimeout(() => label && prev && (label.textContent = prev), 1600);
    } catch {
      /* ignore */
    }
  }),
);

initConsent();
if (!document.querySelector('[data-no-pageview]')) track('pageview');
