/* Scene: "Fill, don't reveal." — vault fills a login + 2FA into the page; the AI context only ever holds [REDACTED].
   Authored on a 1600x1000 stage. GM.scenes.vault(host, tl, t0, opts) -> { root, update(t) } */
(function () {
  const H = String.raw;
  GM.scenes.vault = function (host, tl, t0, opts) {
    const o = Object.assign({ caption: true, loop: true, len: 8 }, opts || {});
    const root = document.createElement("div");
    root.className = "scn scn-vault";
    root.innerHTML = H`
      <style>
        .scn-vault .lw { left: 96px; top: 330px; width: 540px; height: 590px; }
        .scn-vault .pp h3 { font-size: 31px; }
        .scn-vault .pp .lbl { font-size: 15.5px; }
        .scn-vault .pp .fld { height: 56px; font-size: 19px; }
        .scn-vault .pp .dots { font-size: 23px; }
        .scn-vault .pp .vchip { top: 12px; }
        .scn-vault .pp .otp span { width: 58px; height: 62px; font-size: 26px; }
        .scn-vault .pp .btn { height: 54px; font-size: 17px; }
        .scn-vault .lw .body { overflow: hidden; }
        .scn-vault .form { position: absolute; left: 40px; top: 80px; width: 460px; height: 440px; }
        .scn-vault .form .lbl { position: absolute; left: 0; }
        .scn-vault .form .fld, .scn-vault .form .otp, .scn-vault .form .btn { position: absolute; left: 0; width: 460px; }
        .scn-vault .signed { position: absolute; left: 0; right: 0; top: 54px; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
        .scn-vault .signed .ok { width: 76px; height: 76px; border-radius: 50%; background: #e5f4ec; color: #1f7a4d; display: grid; place-items: center; }
        .scn-vault .signed .ok .ic { width: 38px; height: 38px; stroke-width: 2.4; }
        .scn-vault .signed b { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
        .scn-vault .signed span { font-size: 16px; color: #4d515c; }
        .scn-vault .vault { left: 734px; top: 559px; width: 132px; height: 132px; }
        .scn-vault .vault .disc { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 50% 35%, #1f2a24, #121512 70%); border: 1.5px solid var(--em-line); display: grid; place-items: center; color: var(--em); box-shadow: 0 0 60px rgba(47,214,144,0.18); }
        .scn-vault .vault .disc .ic { width: 46px; height: 46px; stroke-width: 1.6; }
        .scn-vault .vault .halo { position: absolute; inset: -18px; border-radius: 50%; border: 1.5px solid rgba(47,214,144,0.35); }
        .scn-vault .vlabel { left: 650px; top: 712px; width: 300px; text-align: center; }
        .scn-vault .vlabel b { display: block; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
        .scn-vault .vlabel span { display: block; font-family: var(--mono); font-size: 13px; letter-spacing: 0.1em; color: var(--muted); margin-top: 6px; text-transform: uppercase; }
        .scn-vault .aw { left: 964px; top: 330px; width: 540px; height: 590px; }
        .scn-vault .aw .body { background: #121210; }
        .scn-vault .arow { position: absolute; left: 28px; right: 28px; height: 52px; display: flex; align-items: center; gap: 14px; font-size: 20px; white-space: nowrap; }
        .scn-vault .redact { height: 38px; font-size: 15.5px; }
        .scn-vault .arow .secret { font-size: 15.5px; padding: 6px 11px 6px 9px; }
        .scn-vault .arow .k { font-family: var(--mono); font-size: 16.5px; color: var(--muted); width: 104px; }
        .scn-vault .arow .secret { margin-left: auto; }
        .scn-vault .arow.intent { font-size: 21px; }
        .scn-vault .arow.intent .gt { font-family: var(--mono); color: var(--em); }
        .scn-vault .arow.done .ic { width: 20px; height: 20px; color: var(--em); stroke-width: 2.4; }
        .scn-vault .sep { position: absolute; left: 30px; right: 30px; height: 1px; background: var(--line); }
        .scn-vault .ctr { position: absolute; left: 28px; right: 28px; bottom: 26px; height: 84px; border-radius: 14px; border: 1px solid var(--line-2); background: #171714; display: flex; align-items: center; padding: 0 20px; }
        .scn-vault .ctr span { font-family: var(--mono); font-size: 14px; letter-spacing: 0.14em; color: var(--muted); }
        .scn-vault .ctr b { margin-left: auto; font-size: 54px; font-weight: 600; color: var(--em); letter-spacing: -0.02em; }
        .scn-vault .blk { left: 897px; top: 607px; width: 36px; height: 36px; }
        .scn-vault .blklbl { left: 855px; top: 652px; width: 120px; text-align: center; font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; color: var(--muted); text-transform: uppercase; }
      </style>
      <div class="scn-cap vcap">
        <div class="k">Vault · Logins &amp; 2FA</div>
        <h2>Fill, don't <span class="serif">reveal.</span></h2>
        <p>Passwords and 2FA codes are typed into the page for the agent. The AI never sees them.</p>
      </div>
      <svg class="abs wires" width="1600" height="1000" viewBox="0 0 1600 1000" style="left:0;top:0;overflow:visible">
        <g fill="none" stroke-linecap="round">
          <path class="w0" d="M734 625 C 690 625, 680 572, 636 572" stroke="#2fd690" stroke-width="2.2" stroke-dasharray="6 8"/>
          <path class="w1" d="M734 625 C 690 625, 680 676, 636 676" stroke="#2fd690" stroke-width="2.2" stroke-dasharray="6 8"/>
          <path class="w2" d="M734 625 C 690 625, 680 783, 636 783" stroke="#2fd690" stroke-width="2.2" stroke-dasharray="6 8"/>
          <path class="wx" d="M866 625 L 964 625" stroke="rgba(255,250,240,0.28)" stroke-width="2" stroke-dasharray="4 7"/>
        </g>
        <circle class="pk0" r="6" fill="#2fd690"/><circle class="pk1" r="6" fill="#2fd690"/><circle class="pk2" r="6" fill="#2fd690"/>
        <circle class="pkx" r="5" fill="#f4f2ed"/>
      </svg>
      <div class="win light lw abs">
        <div class="tb"><div class="traffic color"><i></i><i></i><i></i></div><span class="urlpill" data-icon="lock">billing.acme.example/login</span></div>
        <div class="body">
          <div class="pp">
            <div class="ph"><div class="pl">A</div><b>Acme Billing</b><div class="nav"><span>Support</span></div></div>
            <div class="form">
              <h3>Sign in</h3>
              <div class="lbl" style="top:58px">Email</div>
              <div class="fld f0" style="top:84px"><span class="t-email"></span></div>
              <div class="lbl" style="top:162px">Password</div>
              <div class="fld f1" style="top:188px"><span class="dots t-pass"></span><span class="vchip" data-icon="lock">From vault</span></div>
              <div class="lbl" style="top:266px">2FA code</div>
              <div class="otp" style="top:292px"><span></span><span></span><span></span><span></span><span></span><span></span></div>
              <div class="btn" style="top:382px">Sign in</div>
            </div>
            <div class="signed"><div class="ok" data-icon="check"></div><b>Welcome back</b><span>Signed in to Acme Billing</span></div>
          </div>
        </div>
      </div>
      <div class="abs vault"><div class="halo"></div><div class="disc" data-icon="key"></div></div>
      <div class="abs vlabel"><b>Encrypted vault</b><span>On your device</span></div>
      <svg class="abs blk" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#141412" stroke="rgba(255,250,240,0.45)" stroke-width="2"/><path d="M8 28 28 8" stroke="rgba(255,250,240,0.6)" stroke-width="2.2" stroke-linecap="round"/></svg>
      <div class="abs blklbl">Never sent</div>
      <div class="win aw abs">
        <div class="tb"><span class="chip" data-icon="eyeoff" style="border:0;padding:0;color:#d8d4cc;font-size:15px;font-weight:500">What the AI sees</span><div class="right"><span class="chip"><span class="claude-dot"></span>Claude Opus 5.5</span></div></div>
        <div class="body">
          <div class="arow intent a0" style="top:26px"><span class="gt">›</span><span class="t-intent"></span></div>
          <div class="sep" style="top:94px"></div>
          <div class="arow a1" style="top:116px"><span class="k">email</span><span class="redact" data-icon="lock">REDACTED</span><span class="secret" data-icon="lock">Secret hidden</span></div>
          <div class="arow a2" style="top:184px"><span class="k">password</span><span class="redact" data-icon="lock">REDACTED</span><span class="secret" data-icon="lock">Secret hidden</span></div>
          <div class="arow a3" style="top:252px"><span class="k">2FA code</span><span class="redact" data-icon="lock">REDACTED</span><span class="secret" data-icon="lock">Secret hidden</span></div>
          <div class="sep" style="top:324px"></div>
          <div class="arow done a4" style="top:346px"><span data-icon="check"></span><span>Signed in. It never saw a secret.</span></div>
          <div class="ctr"><span>SECRETS IN AI CONTEXT</span><b>0</b></div>
        </div>
      </div>`;
    host.appendChild(root);
    GM.hydrate(root);
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    if (!o.caption) q(".vcap").style.display = "none";

    const T = (x) => t0 + x;
    const rows = [q(".a0"), q(".a1"), q(".a2"), q(".a3"), q(".a4")];
    const wires = [q(".w0"), q(".w1"), q(".w2")];
    const pk = [q(".pk0"), q(".pk1"), q(".pk2")];
    const pkx = q(".pkx");
    const wx = q(".wx");
    const signed = q(".signed"), form = q(".form"), btn = q(".btn"), vchip = q(".vchip");
    const halo = q(".vault .halo"), disc = q(".vault .disc"), blk = q(".blk");
    const lens = wires.map((w) => w.getTotalLength());
    const lenX = wx.getTotalLength();

    gsap.set(rows, { opacity: 0 });
    gsap.set(signed, { opacity: 0 });
    gsap.set(wires, { opacity: 0.22 });
    gsap.set(pk.concat([pkx]), { opacity: 0 });
    gsap.set(vchip, { opacity: 0 });

    // Fill events: [wire index, start]
    const EV = [0.9, 1.9, 2.95];
    EV.forEach((s, i) => {
      tl.fromTo(wires[i], { opacity: 0.22 }, { opacity: 1, duration: 0.25, ease: "power2.out", immediateRender: false }, T(s));
      tl.to(wires[i], { opacity: 0.5, duration: 0.8, ease: "power2.inOut" }, T(s + 0.7));
      tl.fromTo(disc, { scale: 1 }, { scale: 1.08, duration: 0.14, ease: "power2.out", immediateRender: false }, T(s - 0.05));
      tl.to(disc, { scale: 1, duration: 0.5, ease: "back.out(3)" }, T(s + 0.09));
      tl.fromTo(blk, { scale: 1, rotation: 0 }, { scale: 1.18, rotation: -8, duration: 0.12, ease: "power2.out", immediateRender: false }, T(s + 0.32));
      tl.to(blk, { scale: 1, rotation: 0, duration: 0.45, ease: "elastic.out(1, 0.4)" }, T(s + 0.44));
    });
    // Rows in AI context
    const ROWS = [0.35, 1.3, 2.35, 3.4, 4.75];
    ROWS.forEach((s, i) => {
      tl.fromTo(rows[i], { opacity: 0, x: -14, filter: "blur(6px)" }, { opacity: 1, x: 0, filter: "blur(0px)", duration: 0.55, ease: "expo.out", immediateRender: false }, T(s));
      if (i >= 1 && i <= 3) {
        tl.fromTo(rows[i].querySelector(".redact"), { scaleX: 0.2, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.45, ease: "expo.out", immediateRender: false }, T(s + 0.05));
        tl.fromTo(rows[i].querySelector(".secret"), { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(2.6)", immediateRender: false }, T(s + 0.2));
      }
    });
    tl.fromTo(vchip, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)", immediateRender: false }, T(2.3));
    // Sign in
    tl.fromTo(btn, { scale: 1 }, { scale: 0.97, duration: 0.08, immediateRender: false }, T(4.2));
    tl.to(btn, { scale: 1, duration: 0.25, ease: "back.out(3)" }, T(4.28));
    tl.fromTo(form, { opacity: 1 }, { opacity: 0, duration: 0.3, immediateRender: false }, T(4.45));
    tl.fromTo(signed, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out", immediateRender: false }, T(4.55));
    tl.fromTo(signed.querySelector(".ok"), { scale: 0.5 }, { scale: 1, duration: 0.6, ease: "back.out(2.4)", immediateRender: false }, T(4.6));
    tl.fromTo(q(".ctr b"), { scale: 1 }, { scale: 1.25, duration: 0.18, ease: "power2.out", immediateRender: false }, T(4.95));
    tl.to(q(".ctr b"), { scale: 1, duration: 0.5, ease: "back.out(3)" }, T(5.13));

    if (o.loop) {
      const L = o.len;
      tl.to(rows, { opacity: 0, filter: "blur(6px)", duration: 0.45, ease: "power2.in" }, T(L - 0.85));
      tl.to(signed, { opacity: 0, duration: 0.4 }, T(L - 0.85));
      tl.to(vchip, { opacity: 0, duration: 0.3 }, T(L - 0.85));
      tl.to(form, { opacity: 1, duration: 0.5, ease: "power2.out" }, T(L - 0.5));
      tl.to(wires, { opacity: 0.22, duration: 0.4 }, T(L - 0.8));
    }

    const email = q(".t-email"), pass = q(".t-pass"), otp = qa(".otp span"), intent = q(".t-intent");
    const f0 = q(".f0"), f1 = q(".f1");
    const EMAIL = "finance@codext.example";
    const INTENT = "Sign in to Acme Billing";
    const eS = GM.typeSchedule(EMAIL, 1.2, 60, 4);
    const iS = GM.typeSchedule(INTENT, 0.4, 40, 9);
    function pointOn(path, len, p) {
      const pt = path.getPointAtLength(len * p);
      return pt;
    }
    function update(t) {
      const lt = t - t0;
      const reset = o.loop && lt >= o.len - 0.5;
      intent.textContent = reset ? "" : GM.typedAt(iS, INTENT, lt);
      email.textContent = reset ? "" : GM.typedAt(eS, EMAIL, lt);
      pass.textContent = reset ? "" : "•".repeat(lt < 2.2 ? 0 : Math.min(14, Math.floor((lt - 2.2) / 0.03)));
      const n = reset || lt < 3.25 ? 0 : Math.min(6, Math.floor((lt - 3.25) / 0.06) + 1);
      otp.forEach((s, i) => {
        s.textContent = i < n ? "•" : "";
        s.classList.toggle("f", i < n);
      });
      f0.classList.toggle("focus", !reset && lt >= 1.1 && lt < 1.75);
      f1.classList.toggle("focus", !reset && lt >= 2.1 && lt < 2.75);
      // flowing dashes
      const off = -(lt * 26) % 14;
      wires.forEach((w) => w.setAttribute("stroke-dashoffset", off.toFixed(2)));
      wx.setAttribute("stroke-dashoffset", (-(lt * 12) % 11).toFixed(2));
      // packets travel vault -> field (0.35s), and a probe stops at the block
      EV.forEach((s, i) => {
        const p = (lt - s) / 0.35;
        if (p >= 0 && p <= 1) {
          const e = 1 - Math.pow(1 - p, 3);
          const pt = pointOn(wires[i], lens[i], e);
          pk[i].setAttribute("cx", pt.x);
          pk[i].setAttribute("cy", pt.y);
          pk[i].style.opacity = 1 - Math.max(0, p - 0.8) * 5;
        } else pk[i].style.opacity = 0;
      });
      let px = -1;
      EV.forEach((s) => {
        const p = (lt - s - 0.05) / 0.3;
        if (p >= 0 && p <= 1) px = p;
      });
      if (px >= 0) {
        const e = 1 - Math.pow(1 - px, 3);
        const pt = wx.getPointAtLength(lenX * 0.45 * e);
        pkx.setAttribute("cx", pt.x);
        pkx.setAttribute("cy", pt.y);
        pkx.style.opacity = px < 0.8 ? 0.9 : (1 - px) * 4.5;
      } else pkx.style.opacity = 0;
      // halo breath
      const b = 0.5 + 0.5 * Math.sin(lt * ((2 * Math.PI) / 2.0));
      halo.style.transform = "scale(" + (1 + b * 0.08).toFixed(4) + ")";
      halo.style.opacity = (0.35 + b * 0.4).toFixed(3);
    }
    return { root: root, update: update };
  };
})();
