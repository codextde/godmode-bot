// Agent characters: eyes that follow the pointer, the crew picker, and the expressions + studio demos.
// All character markup is rendered at build time; this only flips attributes and CSS variables.
import { track } from './analytics';

export function initCharacters(reduced: boolean) {
  followPointer(reduced);
  pauseOffscreen();
  initMascot();
  initCrew(reduced);
  initExpressions(reduced);
  initStudio();
}

/** [data-follow] characters look toward the pointer (±4 viewBox units), rAF-throttled. */
function followPointer(reduced: boolean) {
  if (reduced || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const all = [...document.querySelectorAll<HTMLElement>('[data-follow]')];
  if (!all.length) return;
  const visible = new Set<HTMLElement>();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      if (e.isIntersecting) visible.add(el);
      else visible.delete(el);
    }
  });
  all.forEach((el) => io.observe(el));

  let x = 0;
  let y = 0;
  let raf = 0;
  const update = () => {
    raf = 0;
    for (const el of visible) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      // Full glance once the pointer is a couple of character-widths away.
      const k = (Math.min(1, dist / (r.width * 2.5)) * 4) / dist;
      el.style.setProperty('--gm-look-x', (dx * k).toFixed(2));
      el.style.setProperty('--gm-look-y', (dy * k * 0.8).toFixed(2));
    }
  };
  addEventListener(
    'pointermove',
    (e) => {
      x = e.clientX;
      y = e.clientY;
      raf ||= requestAnimationFrame(update);
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    for (const el of all) {
      el.style.removeProperty('--gm-look-x');
      el.style.removeProperty('--gm-look-y');
    }
  });
}

/** Characters scrolled out of view stop breathing and blinking. */
function pauseOffscreen() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('is-off', !e.isIntersecting);
  });
  document.querySelectorAll('.gm-char-wrap').forEach((el) => io.observe(el));
}

/** The hero mascot hops when poked. */
function initMascot() {
  const mascot = document.querySelector<HTMLElement>('[data-mascot]');
  let timer: number | undefined;
  mascot?.addEventListener('click', () => {
    mascot.classList.add('is-happy');
    clearTimeout(timer);
    timer = window.setTimeout(() => mascot.classList.remove('is-happy'), 1700);
    track('click', 'mascot');
  });
}

/** Crew lineup: each agent introduces itself and reports a finished job; cycles until someone picks. */
function initCrew(reduced: boolean) {
  const root = document.querySelector<HTMLElement>('[data-crew]');
  if (!root) return;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  let auto: number | undefined;
  let userPicked = false;
  let started = false;

  const select = (i: number, byUser = false) => {
    started = true;
    if (byUser) {
      userPicked = true;
      track('click', `crew:${tabs[i].dataset.key}`);
    }
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
    });
    panels.forEach((p, j) => {
      p.hidden = i !== j;
      p.classList.remove('is-in', 'is-live');
    });
    const panel = panels[i];
    void panel.offsetWidth; // restart the message animations
    panel.classList.add('is-in', 'is-live');
    clearTimeout(auto);
    if (!userPicked && !reduced) auto = window.setTimeout(() => select((i + 1) % tabs.length), 7000);
  };

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i, true));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (i + d + tabs.length) % tabs.length;
      tabs[n].focus();
      select(n, true);
    });
  });

  // Start when the section scrolls in (unless someone already picked); pause the auto-advance while it's out of view.
  new IntersectionObserver(
    (entries) => {
      const inView = entries.some((e) => e.isIntersecting);
      if (inView && !started) {
        select(0);
      } else if (!inView) {
        clearTimeout(auto);
      } else if (!userPicked) {
        select(tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
      }
    },
    { threshold: 0.3 },
  ).observe(root);
}

/** One character cycling through every state it can show; the chips pick a state. */
function initExpressions(reduced: boolean) {
  const root = document.querySelector<HTMLElement>('[data-expressions]');
  if (!root) return;
  const states = [...root.querySelectorAll<HTMLElement>('[data-mood-state]')];
  const labels = [...root.querySelectorAll<HTMLElement>('[data-mood-label]')];
  const picks = [...root.querySelectorAll<HTMLButtonElement>('[data-mood-pick]')];
  let i = 0;
  let timer: number | undefined;
  let inView = false;

  const show = (n: number) => {
    i = n;
    states.forEach((s, j) => s.toggleAttribute('data-active', j === n));
    labels.forEach((l, j) => (l.hidden = j !== n));
    picks.forEach((p, j) => p.setAttribute('aria-pressed', String(j === n)));
  };
  const loop = () => {
    clearTimeout(timer);
    if (reduced || !inView) return;
    timer = window.setTimeout(() => {
      show((i + 1) % states.length);
      loop();
    }, 2600);
  };
  picks.forEach((p, j) =>
    p.addEventListener('click', () => {
      show(j);
      loop(); // keep cycling from the picked state
    }),
  );
  new IntersectionObserver((entries) => {
    inView = entries.some((e) => e.isIntersecting);
    if (inView) loop();
    else clearTimeout(timer);
  }).observe(root);
}

/** Name it, flip through looks, try personalities — the greeting updates live. */
function initStudio() {
  const root = document.querySelector<HTMLElement>('[data-studio]');
  if (!root) return;
  const name = root.querySelector<HTMLInputElement>('[data-studio-name]')!;
  const greeting = root.querySelector<HTMLElement>('[data-studio-greeting]')!;
  const label = root.querySelector<HTMLElement>('[data-studio-label]')!;
  const looks = [...root.querySelectorAll<HTMLElement>('[data-look]')];
  const personalities = [...root.querySelectorAll<HTMLButtonElement>('[data-personality]')];
  let line = personalities[0]?.dataset.line ?? '';
  let look = 0;

  const render = () => {
    greeting.textContent = line.replaceAll('{name}', name.value.trim() || 'Your agent');
  };
  name.addEventListener('input', render);
  personalities.forEach((p) =>
    p.addEventListener('click', () => {
      personalities.forEach((q) => q.setAttribute('aria-pressed', String(q === p)));
      line = p.dataset.line ?? '';
      render();
    }),
  );
  root.querySelector('[data-studio-shuffle]')?.addEventListener('click', () => {
    look = (look + 1) % looks.length;
    looks.forEach((l, j) => l.toggleAttribute('data-active', j === look));
    label.textContent = looks[look].dataset.label ?? '';
    track('click', 'studio_shuffle');
  });
}
