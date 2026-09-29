/* X ad toolkit: format layouts + beats (hook, caption, framed screenshot with inner camera, scene, Slack card, end card).
   Every beat adds tweens to one paused timeline; per-frame work is collected into ctx.updates (pure functions of t). */
(function () {
  const FMT = {
    "16x9": {
      W: 1920, H: 1080,
      hook: { top: null, l: 150, s: 162, k: 24, gap: 26 },
      cap: { x: 110, y: 84, w: 1700, k: 22, l1: 72, l2: 80, inline: true },
      vis: { x: 110, y: 262, w: 1700, h: 748 },
      shotW: 1142,
      mark: { x: 110, y: 1022, logo: 34, t: 22 },
      by: { right: 110, y: 1027, m: 14, t: 19 },
      end: { logo: 132, name: 126, tag: 46, price: 76, cta: 50, ctaH: 118, meta: 19, url: 30, gaps: [36, 24, 48, 48, 44], urlGap: 26 }
    },
    "1x1": {
      W: 1080, H: 1080,
      hook: { top: null, l: 118, s: 126, k: 21, gap: 22 },
      cap: { x: 70, y: 72, w: 940, k: 20, l1: 64, l2: 70, inline: false },
      vis: { x: 40, y: 292, w: 1000, h: 712 },
      shotW: 960,
      mark: { x: 70, y: 1026, logo: 30, t: 20 },
      by: { right: 70, y: 1030, m: 13, t: 17 },
      end: { logo: 104, name: 90, tag: 34, price: 56, cta: 38, ctaH: 92, meta: 15, url: 25, gaps: [28, 18, 36, 36, 34], urlGap: 20 }
    },
    "9x16": {
      W: 1080, H: 1920,
      hook: { top: null, l: 158, s: 172, k: 26, gap: 30 },
      cap: { x: 80, y: 250, w: 920, k: 22, l1: 80, l2: 88, inline: false },
      vis: { x: 30, y: 690, w: 1020, h: 930 },
      shotW: 1000,
      mark: { center: true, y: 118, logo: 42, t: 27 },
      by: { center: true, y: 1702, m: 15, t: 21 },
      end: { logo: 140, name: 112, tag: 42, price: 68, cta: 46, ctaH: 112, meta: 18, url: 32, gaps: [40, 26, 56, 56, 52], urlGap: 30 }
    }
  };

  function el(tag, cls, html, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  const px = (v) => v + "px";

  function init(fmtName, tl, D) {
    const f = FMT[fmtName];
    const scene = document.getElementById("scene");
    const ctx = { f: f, fmt: fmtName, tl: tl, D: D, scene: scene, updates: [] };
    el("div", "bg-field", "", scene);
    ctx.glow = el("div", "bg-glow", "", scene);
    Object.assign(ctx.glow.style, { left: px(f.W / 2 - f.W * 0.45), top: px(f.H * 0.42 - f.W * 0.45), width: px(f.W * 0.9), height: px(f.W * 0.9) });
    ctx.layer = el("div", "ad-layer", "", scene);
    ctx.top = el("div", "ad-layer", "", scene);
    return ctx;
  }

  // Brand watermark + "Powered by Claude Opus 5.5"
  function mark(ctx, at, out) {
    const f = ctx.f, tl = ctx.tl;
    const m = el("div", "ad-mark", '<div class="logo" data-logo></div><b>Godmode Bot</b>', ctx.top);
    m.querySelector(".logo").style.width = px(f.mark.logo);
    m.querySelector(".logo").style.height = px(f.mark.logo);
    m.querySelector("b").style.fontSize = px(f.mark.t);
    if (f.mark.center) Object.assign(m.style, { left: "0", right: "0", justifyContent: "center", top: px(f.mark.y) });
    else Object.assign(m.style, { left: px(f.mark.x), top: px(f.mark.y) });
    const b = el("div", "ad-by", '<span class="m">POWERED BY</span><span class="claude-dot"></span><span>Claude Opus 5.5</span>', ctx.top);
    b.querySelector(".m").style.fontSize = px(f.by.m);
    b.style.fontSize = px(f.by.t);
    if (f.by.center) Object.assign(b.style, { left: "0", right: "0", justifyContent: "center", top: px(f.by.y) });
    else Object.assign(b.style, { right: px(f.by.right), top: px(f.by.y) });
    GM.hydrate(m);
    tl.fromTo([m, b], { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "power2.out" }, at);
    tl.to([m, b], { opacity: 0, duration: 0.4, ease: "power2.in" }, out);
  }

  // Full-frame hook: big kinetic lines. lines: [{t: "Your next hire", serif: false}, ...]
  function hook(ctx, o) {
    const f = ctx.f, tl = ctx.tl;
    const box = el("div", "ad-hook", "", ctx.layer);
    const h = Object.assign({}, f.hook, o.size || {});
    if (o.kick) {
      const k = el("div", "kick", o.kick, box);
      k.style.fontSize = px(h.k);
      k.style.marginBottom = px(h.gap + 6);
    }
    const lines = o.lines.map((ln) => {
      const d = el("div", "l" + (ln.serif ? " s" : ""), ln.t, box);
      d.style.fontSize = px(ln.serif ? h.s : h.l);
      if (ln.em) d.style.color = "var(--em)";
      return d;
    });
    box.style.top = "0";
    box.style.bottom = "0";
    box.style.justifyContent = "center";
    if (o.offsetY) box.style.paddingBottom = px(o.offsetY);
    const words = [];
    lines.forEach((d) => GM.splitWords(d).forEach((w) => words.push(w)));
    const kick = box.querySelector(".kick");
    tl.fromTo(box, { scale: 1.06 }, { scale: 1, duration: o.out - o.at + 0.4, ease: "power2.out" }, o.at);
    // Legible almost immediately (muted autoplay): words start faint + soft, sharpen within ~0.45s.
    tl.fromTo(words, { opacity: 0.3, y: 22, filter: "blur(9px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, stagger: o.stagger || 0.045, ease: "expo.out" }, o.at);
    if (kick) tl.fromTo(kick, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, o.at + (o.kickAt || 0.7));
    tl.to(kick ? [kick].concat(words) : words, { opacity: 0, y: -26, filter: "blur(14px)", duration: 0.4, stagger: 0.02, ease: "power2.in" }, o.out);
    return box;
  }

  // Caption block (top band / top-left). { k, l1, l2, at, out }
  function caption(ctx, o) {
    const f = ctx.f, tl = ctx.tl, c = f.cap;
    const box = el("div", "ad-cap", "", ctx.layer);
    Object.assign(box.style, { left: px(c.x), top: px(c.y), width: px(c.w) });
    const k = el("div", "k", o.k, box);
    k.style.fontSize = px(c.k);
    const line = el("div", "", "", box);
    line.style.marginTop = px(Math.round(c.k * 0.9));
    line.style.fontSize = px(c.l1);
    const a = el(c.inline ? "span" : "div", "l1", o.l1, line);
    a.style.fontSize = px(c.l1);
    let b = null;
    if (o.l2) {
      if (c.inline) line.appendChild(document.createTextNode(" "));
      b = el(c.inline ? "span" : "div", "l2", o.l2, line);
      b.style.fontSize = px(c.l2);
    }
    if (c.inline) line.style.whiteSpace = "nowrap";
    const words = GM.splitWords(a).concat(b ? GM.splitWords(b) : []);
    tl.fromTo(k, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, o.at);
    tl.fromTo(words, { opacity: 0, y: 26, filter: "blur(12px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6, stagger: 0.045, ease: "expo.out" }, o.at + 0.05);
    if (o.out != null) tl.to([k].concat(words), { opacity: 0, y: -14, filter: "blur(10px)", duration: 0.32, stagger: 0.012, ease: "power2.in" }, o.out);
    return box;
  }

  function visIn(tl, node, at) {
    tl.fromTo(node, { opacity: 0, y: 46, scale: 0.955, filter: "blur(12px)" }, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 0.95, ease: "expo.out" }, at);
  }
  function visOut(tl, node, at) {
    tl.to(node, { opacity: 0, scale: 1.025, filter: "blur(10px)", duration: 0.42, ease: "power2.in" }, at);
  }

  // Real screenshot inside a window frame; camera moves inside the frame. cams: [[cx, cy, s, t, dur, ease], ...] (image coords)
  function shot(ctx, o) {
    const f = ctx.f, tl = ctx.tl, v = f.vis;
    const vpW = o.w || f.shotW;
    const vpH = Math.round(vpW / 1.6);
    const fr = el("div", "ad-frame", '<div class="ftb"><div class="traffic color"><i></i><i></i><i></i></div></div><div class="fvp"><div class="ad-world"></div></div>', ctx.layer);
    Object.assign(fr.style, { width: px(vpW), height: px(vpH + 34), left: px(v.x + (v.w - vpW) / 2), top: px(v.y + (v.h - vpH - 34) / 2 + (o.dy || 0)) });
    const world = fr.querySelector(".ad-world");
    world.style.width = "2000px";
    world.style.height = "1250px";
    const img = el("img", "", null, world);
    img.src = o.src;
    (o.hl || []).forEach((h) => {
      const d = el("div", "ad-hl", "", world);
      Object.assign(d.style, { left: px(h.x), top: px(h.y), width: px(h.w), height: px(h.h) });
      tl.fromTo(d, { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.5, ease: "expo.out" }, h.at);
      tl.to(d, { opacity: 0.55, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: 3 }, h.at + 0.6);
    });
    const cam = new GM.Camera(tl, world, vpW, vpH);
    cam.set(1000, 625, vpW / 2000);
    (o.cams || []).forEach((c) => cam.to(c[0], c[1], c[2], c[3], c[4], c[5]));
    ctx.updates.push((t) => cam.apply(t));
    visIn(tl, fr, o.at);
    if (o.out != null) visOut(tl, fr, o.out);
    return fr;
  }

  // A shared 1600x1000 scene framed by a camera inside the visual area. cams in scene coords.
  function scene(ctx, o) {
    const f = ctx.f, tl = ctx.tl, v = o.vis || f.vis;
    const box = el("div", "ad-vis", '<div class="ad-world"></div>', ctx.layer);
    Object.assign(box.style, { left: px(v.x), top: px(v.y), width: px(v.w), height: px(v.h) });
    const world = box.querySelector(".ad-world");
    world.style.width = "1600px";
    world.style.height = "1000px";
    const sc = GM.scenes[o.name](world, tl, o.t0, Object.assign({ caption: false, loop: false }, o.opts || {}));
    const cam = new GM.Camera(tl, world, v.w, v.h);
    cam.set(o.start[0], o.start[1], o.start[2]);
    (o.cams || []).forEach((c) => cam.to(c[0], c[1], c[2], c[3], c[4], c[5]));
    ctx.updates.push((t) => {
      cam.apply(t);
      sc.update(t);
    });
    visIn(tl, box, o.at);
    if (o.out != null) visOut(tl, box, o.out);
    return box;
  }

  function slack(ctx, o) {
    const tl = ctx.tl;
    const d = el(
      "div",
      "ad-slack",
      '<div class="sh" data-icon="hash">' + o.channel + '<span class="via">SLACK</span></div><div class="sm"><div class="lg" data-logo></div><div><div class="who">Godmode <span class="app">APP</span><span class="tm">' +
        (o.time || "9:02 AM") + "</span></div><p>" + o.text + '</p><div class="files">' +
        (o.files || []).map((x) => '<span data-icon="file">' + x + "</span>").join("") + "</div></div></div>",
      ctx.layer
    );
    Object.assign(d.style, { left: px(o.x), top: px(o.y), width: px(o.w || 700) });
    d.querySelector("p").style.width = px((o.w || 700) - 120);
    GM.hydrate(d);
    tl.fromTo(d, { opacity: 0, y: 70, scale: (o.scale || 1) * 0.92, filter: "blur(10px)" }, { opacity: 1, y: 0, scale: o.scale || 1, filter: "blur(0px)", duration: 0.85, ease: "expo.out" }, o.at);
    if (o.out != null) tl.to(d, { opacity: 0, y: 20, filter: "blur(8px)", duration: 0.4, ease: "power2.in" }, o.out);
    return d;
  }

  function end(ctx, o) {
    const f = ctx.f, tl = ctx.tl, e = f.end;
    const box = el(
      "div",
      "ad-end",
      '<div class="logo" data-logo></div><div class="name">Godmode Bot</div>' +
        '<div class="tagl">Your AI coworker that <span class="serif">actually</span> does the work.</div>' +
        '<div class="price"><span>$500 once</span><span class="or">or</span><span>$50<span class="per">/mo</span></span></div>' +
        '<div class="cta">Get Godmode<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>' +
        '<div class="url">godmode.codext.de</div>' +
        '<div class="meta"><span class="claude-dot"></span><span style="color:#d8d4cc">Claude Opus 5.5</span><span>·</span><span>Mac · Windows · Linux</span></div>',
      ctx.layer
    );
    GM.hydrate(box);
    const logo = box.querySelector(".logo"), name = box.querySelector(".name"), tag = box.querySelector(".tagl");
    const price = box.querySelector(".price"), cta = box.querySelector(".cta"), meta = box.querySelector(".meta");
    const url = box.querySelector(".url");
    Object.assign(logo.style, { width: px(e.logo), height: px(e.logo) });
    name.style.fontSize = px(e.name);
    tag.style.fontSize = px(e.tag);
    tag.querySelector(".serif").style.fontSize = px(Math.round(e.tag * 1.12));
    price.style.fontSize = px(e.price);
    Object.assign(cta.style, { fontSize: px(e.cta), height: px(e.ctaH), padding: "0 " + px(Math.round(e.ctaH * 0.55)) });
    Object.assign(cta.querySelector("svg").style, { width: px(e.cta), height: px(e.cta) });
    meta.style.fontSize = px(e.meta);
    [name, tag, price, cta, meta].forEach((n, i) => (n.style.marginTop = px(e.gaps[i])));
    Object.assign(url.style, { fontSize: px(e.url), marginTop: px(e.urlGap) });
    if (o.tagWidth) tag.style.width = px(o.tagWidth);
    const at = o.at;
    tl.fromTo(logo, { opacity: 0, scale: 0.6, filter: "blur(14px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.9, ease: "expo.out" }, at);
    GM.reveal(tl, GM.splitWords(name), at + 0.12, { y: 30, blur: 16, dur: 0.8, stagger: 0.08 });
    GM.reveal(tl, GM.splitWords(tag), at + 0.35, { y: 18, blur: 10, dur: 0.7, stagger: 0.03 });
    tl.fromTo(price, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, at + 0.6);
    tl.fromTo(cta, { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.7, ease: "back.out(2.2)" }, at + 0.8);
    tl.fromTo(url, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, at + 0.95);
    tl.fromTo(meta, { opacity: 0 }, { opacity: 1, duration: 0.6 }, at + 1.05);
    // a gentle "tap me" press + glow on the CTA
    tl.fromTo(cta, { scale: 1 }, { scale: 0.95, duration: 0.12, ease: "power2.in", immediateRender: false }, at + 1.7);
    tl.to(cta, { scale: 1, duration: 0.5, ease: "back.out(3)" }, at + 1.82);
    tl.fromTo(ctx.glow, { opacity: 0.6, scale: 0.9 }, { opacity: 1, scale: 1.08, duration: 1.2, ease: "power2.out", immediateRender: false }, at);
    return box;
  }

  function finish(ctx) {
    const tl = ctx.tl;
    const grain = el("div", "grain", "", ctx.scene);
    grain.setAttribute("data-layout-ignore", "");
    GM.hydrate(ctx.layer);
    GM.markLayered([".ad-frame", ".ad-vis"], [".ad-hl"]);
    GM.driver(tl, ctx.D, (t) => ctx.updates.forEach((u) => u(t)));
  }

  window.GM.ad = { FMT: FMT, init: init, mark: mark, hook: hook, caption: caption, shot: shot, scene: scene, slack: slack, end: end, finish: finish };
})();
