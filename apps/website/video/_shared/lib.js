/* Godmode Bot motion helpers — deterministic, seek-safe utilities shared by every composition. */
(function () {
  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8.5 13v1.5M15.5 13v1.5"/>',
    routines: '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4M8 2v4M3 10h5"/><circle cx="16.5" cy="16.5" r="5.5"/><path d="M16.5 14.5v2l1.5 1"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    eyeoff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/>',
    pointer: '<path d="m4 4 7.07 16.97 2.51-7.39 7.39-2.51L4 4z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    wave: '<path d="M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'
  };

  function icon(name, cls) {
    return (
      '<svg class="ic ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || "") +
      "</svg>"
    );
  }

  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]:not([data-hyd])").forEach(function (el) {
      el.setAttribute("data-hyd", "");
      el.insertAdjacentHTML("afterbegin", icon(el.getAttribute("data-icon")));
    });
  }

  const LOGO =
    '<svg class="logo-mark" viewBox="0 0 512 512" fill="none"><rect x="16" y="16" width="480" height="480" rx="112" fill="#1C1C1C"/><rect x="16.5" y="16.5" width="479" height="479" rx="111.5" stroke="#FFFFFF" stroke-opacity="0.10"/><path d="M283 92 158 288h86l-22 132 132-204h-88l17-124Z" fill="#FAF9F5" stroke="#FAF9F5" stroke-width="10" stroke-linejoin="round"/></svg>';
  const BOLT =
    '<svg viewBox="140 80 240 360" fill="none"><path d="M283 92 158 288h86l-22 132 132-204h-88l17-124Z" fill="currentColor" stroke="currentColor" stroke-width="10" stroke-linejoin="round"/></svg>';

  function hydrateLogos(root) {
    (root || document).querySelectorAll("[data-logo]").forEach(function (el) {
      el.innerHTML = el.getAttribute("data-logo") === "bolt" ? BOLT : LOGO;
    });
  }

  const CURSOR_PATH = "M3 2.5 L3 25 L9.2 19.2 L13.4 28.2 L17.6 26.3 L13.5 17.6 L21.6 17.6 Z";
  function cursorSVG(kind) {
    const fill = kind === "agent" ? "#2fd690" : "#f7f5f0";
    const stroke = kind === "agent" ? "#052014" : "#0b0b0a";
    return (
      '<svg viewBox="0 0 30 30"><path d="' +
      CURSOR_PATH +
      '" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    );
  }
  function hydrateCursors(root) {
    (root || document).querySelectorAll(".cursor[data-kind]:not([data-hyd])").forEach(function (el) {
      el.setAttribute("data-hyd", "");
      el.insertAdjacentHTML("afterbegin", cursorSVG(el.getAttribute("data-kind")));
      el.querySelectorAll(".cursor-tag").forEach(function (tg) {
        tg.setAttribute("data-layout-allow-overflow", "");
      });
    });
  }

  // Deterministic PRNG
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Human-feeling keystroke schedule: returns absolute time for each character.
  function typeSchedule(text, t0, cps, seed) {
    const rnd = mulberry32(seed || 7);
    const base = 1 / cps;
    const times = [];
    let t = t0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let d = base * (0.55 + rnd() * 0.9);
      if (ch === " ") d *= 1.25;
      if (",.;:".indexOf(text[i - 1] || "") >= 0) d += base * 3.2;
      t += d;
      times.push(t);
    }
    return times;
  }
  function typedAt(times, text, t) {
    let n = 0;
    while (n < times.length && times[n] <= t) n++;
    return text.slice(0, n);
  }
  function typedCount(times, t) {
    let n = 0;
    while (n < times.length && times[n] <= t) n++;
    return n;
  }

  // One driver tween spanning the composition; fn(t) must be a pure function of t.
  function driver(tl, dur, fn) {
    const d = { t: 0 };
    tl.fromTo(
      d,
      { t: 0 },
      {
        t: dur,
        duration: dur,
        ease: "none",
        onUpdate: function () {
          fn(d.t);
        }
      },
      0
    );
    fn(0);
  }

  function blinkOn(t, period) {
    const p = period || 1.0;
    return t % p < p * 0.56;
  }

  // Virtual camera over a world element. Pose is a pure function of time:
  // the focus point interpolates linearly and the zoom interpolates in log space,
  // so push-ins and pull-backs stay locked on their subject (no swing).
  function Camera(tl, el, W, H) {
    this.tl = tl;
    this.el = el;
    this.W = W;
    this.H = H;
    this.segs = [];
    this.base = null;
    this.last = null;
    el.style.transformOrigin = "0 0";
  }
  Camera.prototype.set = function (cx, cy, s) {
    this.base = { cx: cx, cy: cy, s: s };
    this.last = this.base;
    this.apply(0);
    return this;
  };
  Camera.prototype.to = function (cx, cy, s, at, dur, ease) {
    const to = { cx: cx, cy: cy, s: s };
    this.segs.push({ t0: at, t1: at + Math.max(0.0001, dur), from: this.last, to: to, ease: gsap.parseEase(ease || "expo.inOut") });
    this.last = to;
    return this;
  };
  Camera.prototype.poseAt = function (t) {
    let pose = this.base;
    for (let i = 0; i < this.segs.length; i++) {
      const g = this.segs[i];
      if (t < g.t0) break;
      if (t >= g.t1) {
        pose = g.to;
        continue;
      }
      const p = g.ease((t - g.t0) / (g.t1 - g.t0));
      const ls = Math.log(g.from.s) + (Math.log(g.to.s) - Math.log(g.from.s)) * p;
      pose = { cx: g.from.cx + (g.to.cx - g.from.cx) * p, cy: g.from.cy + (g.to.cy - g.from.cy) * p, s: Math.exp(ls) };
      break;
    }
    return pose;
  };
  Camera.prototype.apply = function (t) {
    const q = this.poseAt(t);
    const x = this.W / 2 - q.cx * q.s;
    const y = this.H / 2 - q.cy * q.s;
    this.el.style.transform = "translate(" + x.toFixed(3) + "px," + y.toFixed(3) + "px) scale(" + q.s.toFixed(5) + ")";
  };


  // Pure-function 2D path (cursor travel). keys: [{t, dur, x, y, ease}] after a start point.
  function Path(x, y) {
    this.base = { x: x, y: y };
    this.segs = [];
    this.last = this.base;
  }
  Path.prototype.to = function (x, y, at, dur, ease) {
    const to = { x: x, y: y };
    this.segs.push({ t0: at, t1: at + Math.max(0.0001, dur), from: this.last, to: to, ease: gsap.parseEase(ease || "power3.inOut") });
    this.last = to;
    return this;
  };
  Path.prototype.at = function (t) {
    let p = this.base;
    for (let i = 0; i < this.segs.length; i++) {
      const g = this.segs[i];
      if (t < g.t0) break;
      if (t >= g.t1) {
        p = g.to;
        continue;
      }
      const k = g.ease((t - g.t0) / (g.t1 - g.t0));
      // slight arc so travel feels hand-driven
      const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y;
      const arc = Math.sin(Math.PI * k) * Math.min(40, Math.hypot(dx, dy) * 0.08);
      const len = Math.hypot(dx, dy) || 1;
      p = { x: g.from.x + dx * k + (-dy / len) * arc, y: g.from.y + dy * k + (dx / len) * arc };
      break;
    }
    return p;
  };
  Path.prototype.apply = function (el, t) {
    const p = this.at(t);
    el.style.transform = "translate(" + p.x.toFixed(2) + "px," + p.y.toFixed(2) + "px)";
    return p;
  };

  // Split an element's text nodes into word spans (.w), keeping existing inline children (e.g. .serif) as single words.
  function splitWords(el) {
    const out = [];
    const nodes = Array.from(el.childNodes);
    el.innerHTML = "";
    nodes.forEach(function (n) {
      if (n.nodeType === 3) {
        n.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) {
            el.appendChild(document.createTextNode(" "));
          } else {
            const s = document.createElement("span");
            s.className = "w";
            s.textContent = part;
            el.appendChild(s);
            out.push(s);
          }
        });
      } else {
        n.classList.add("w");
        el.appendChild(n);
        out.push(n);
      }
    });
    return out;
  }

  // Blur-to-sharp staggered reveal.
  function reveal(tl, targets, at, opts) {
    const o = Object.assign({ y: 26, blur: 14, dur: 0.9, stagger: 0.06, ease: "expo.out", scale: 1 }, opts || {});
    tl.fromTo(
      targets,
      { opacity: 0, y: o.y, filter: "blur(" + o.blur + "px)", scale: o.scale },
      { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, duration: o.dur, stagger: o.stagger, ease: o.ease },
      at
    );
  }
  function conceal(tl, targets, at, opts) {
    const o = Object.assign({ y: -14, blur: 10, dur: 0.55, stagger: 0.03, ease: "power2.in" }, opts || {});
    tl.to(targets, { opacity: 0, y: o.y, filter: "blur(" + o.blur + "px)", duration: o.dur, stagger: o.stagger, ease: o.ease, immediateRender: false }, at);
  }

  // Finite glow pulse on a live-dot ring.
  function livePulse(tl, ring, from, to, period) {
    const p = period || 1.6;
    const n = Math.max(1, Math.floor((to - from) / p));
    for (let i = 0; i < n; i++) {
      tl.fromTo(ring, { scale: 0.6, opacity: 0.7 }, { scale: 2.1, opacity: 0, duration: p * 0.9, ease: "power2.out", immediateRender: i === 0 }, from + i * p);
    }
  }

  // Cursor path helper: moves a cursor element through waypoints [{x,y,t,dur,ease}]
  function cursorPath(tl, el, start, points) {
    let prev = { x: start.x, y: start.y };
    gsap.set(el, { x: prev.x, y: prev.y });
    points.forEach(function (p) {
      tl.fromTo(el, { x: prev.x, y: prev.y }, { x: p.x, y: p.y, duration: p.dur || 0.7, ease: p.ease || "power3.inOut", immediateRender: false }, p.t);
      prev = { x: p.x, y: p.y };
    });
  }
  function click(tl, cursorEl, rippleEl, x, y, at) {
    tl.fromTo(cursorEl.querySelector("svg"), { scale: 1 }, { scale: 0.82, duration: 0.08, ease: "power2.in", transformOrigin: "10% 10%", immediateRender: false }, at);
    tl.to(cursorEl.querySelector("svg"), { scale: 1, duration: 0.22, ease: "back.out(3)" }, at + 0.08);
    if (rippleEl) {
      tl.fromTo(rippleEl, { x: x, y: y, scale: 0.3, opacity: 0.9 }, { x: x, y: y, scale: 1.6, opacity: 0, duration: 0.55, ease: "power2.out", immediateRender: false }, at + 0.02);
    }
  }


  // Camera-driven scenes layer UI on purpose (scrims, cards over pages, HUD over world).
  // Mark those relationships so the layout audit checks what matters (overflow, clipping).
  function markLayered(textRoots, occluders) {
    textRoots.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (root) {
        [root].concat(Array.from(root.querySelectorAll("*"))).forEach(function (el) {
          el.setAttribute("data-layout-allow-overlap", "");
          el.setAttribute("data-layout-allow-occlusion", "");
        });
      });
    });
    occluders.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        el.setAttribute("data-layout-allow-occlusion", "");
      });
    });
  }

  window.GM = {
    icon: icon,
    hydrateIcons: hydrateIcons,
    hydrateLogos: hydrateLogos,
    hydrateCursors: hydrateCursors,
    hydrate: function (root) {
      hydrateIcons(root);
      hydrateLogos(root);
      hydrateCursors(root);
    },
    LOGO: LOGO,
    mulberry32: mulberry32,
    typeSchedule: typeSchedule,
    typedAt: typedAt,
    typedCount: typedCount,
    driver: driver,
    blinkOn: blinkOn,
    Camera: Camera,
    splitWords: splitWords,
    reveal: reveal,
    conceal: conceal,
    livePulse: livePulse,
    cursorPath: cursorPath,
    click: click,
    markLayered: markLayered,
    Path: Path,
    scenes: {}
  };
})();
