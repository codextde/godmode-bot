// A quiet field of dots behind the hero. A slow wave of light rolls through it, the dots near the
// cursor wake up, and a few "agents" (emerald dots) wander the grid doing their work.

export function initDotField(canvas: HTMLCanvasElement, reduced: boolean) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const GAP = 22;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let mx = -9999;
  let my = -9999;
  let visible = true;
  let raf = 0;

  type Agent = { c: number; r: number; tc: number; tr: number; t: number };
  let agents: Agent[] = [];

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / GAP) + 1;
    rows = Math.ceil(h / GAP) + 1;
    agents = Array.from({ length: Math.max(3, Math.round(cols / 12)) }, () => {
      const c = Math.floor(Math.random() * cols);
      const r = Math.floor(Math.random() * rows);
      return { c, r, tc: c, tr: r, t: 1 };
    });
    if (reduced) draw(0);
  };

  const draw = (time: number) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const wave = (time / 1000) * 0.35;
    for (let r = 0; r < rows; r++) {
      const y = r * GAP;
      for (let c = 0; c < cols; c++) {
        const x = c * GAP;
        // Fade toward the edges and the bottom so the field melts into the page.
        const edge = 1 - Math.min(1, Math.abs(x - cx) / (w * 0.62));
        const fall = 1 - Math.min(1, y / (h * 0.95));
        let a = 0.05 + 0.1 * edge * fall;
        // Rolling diagonal wave.
        const d = Math.sin((x + y) * 0.006 - wave * 2.2);
        a += Math.max(0, d) ** 6 * 0.18 * edge * fall;
        // Cursor proximity.
        const dx = x - mx;
        const dy = y - my;
        const dist2 = dx * dx + dy * dy;
        let size = 1;
        if (dist2 < 160 * 160) {
          const k = 1 - Math.sqrt(dist2) / 160;
          a += k * 0.55;
          size += k * 0.9;
        }
        ctx.fillStyle = `rgba(244,242,237,${a.toFixed(3)})`;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
    // Agents glide from dot to dot, leaving a soft emerald glow.
    for (const ag of agents) {
      if (!reduced) {
        ag.t += 0.012;
        if (ag.t >= 1) {
          ag.c = ag.tc;
          ag.r = ag.tr;
          const horizontal = Math.random() > 0.5;
          const step = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.floor(Math.random() * 4));
          ag.tc = Math.max(0, Math.min(cols - 1, ag.c + (horizontal ? step : 0)));
          ag.tr = Math.max(0, Math.min(rows - 1, ag.r + (horizontal ? 0 : step)));
          ag.t = 0;
        }
      }
      const e = ag.t < 0.5 ? 4 * ag.t ** 3 : 1 - (-2 * ag.t + 2) ** 3 / 2;
      const x = (ag.c + (ag.tc - ag.c) * e) * GAP;
      const y = (ag.r + (ag.tr - ag.r) * e) * GAP;
      const fall = 1 - Math.min(1, y / (h * 0.9));
      if (fall <= 0) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 18);
      g.addColorStop(0, `rgba(47,214,144,${0.55 * fall})`);
      g.addColorStop(1, 'rgba(47,214,144,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 18, y - 18, 36, 36);
      ctx.fillStyle = `rgba(122,240,189,${0.95 * fall})`;
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  };

  const loop = (t: number) => {
    raf = 0;
    if (!visible) return;
    draw(t);
    raf = requestAnimationFrame(loop);
  };

  new ResizeObserver(resize).observe(canvas);
  resize();

  if (reduced) return;

  addEventListener(
    'pointermove',
    (e) => {
      const r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
    },
    { passive: true },
  );
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(loop);
  }).observe(canvas);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible && !raf) raf = requestAnimationFrame(loop);
  });
  raf = requestAnimationFrame(loop);
}
