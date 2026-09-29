/* Scene: "Its own Mac." — a macOS VM spins up beside your desktop, the agent works inside it, your Mac stays untouched.
   1600x1000 stage. GM.scenes.vm(host, tl, t0, opts) -> { root, update(t) } */
(function () {
  const H = String.raw;
  const VM = { x: 680, y: 130, w: 824, h: 770 };
  const BODY = { x: VM.x, y: VM.y + 50 };
  const BR = { x: 40, y: 58, w: 744, h: 548 }; // inner browser, body coords
  const abs = (bx, by) => ({ x: BODY.x + bx, y: BODY.y + by });

  GM.scenes.vm = function (host, tl, t0, opts) {
    const o = Object.assign({ caption: true, loop: true, len: 8, user: true }, opts || {});
    const root = document.createElement("div");
    root.className = "scn scn-vm";
    const rows = [
      ["INV-2026-0931", "Sep 21", "1,890.00", true],
      ["INV-2026-0917", "Sep 14", "1,512.00", true],
      ["INV-2026-0828", "Aug 28", "1,204.00", false],
      ["INV-2026-0904", "Sep 04", "840.00", true],
      ["INV-2026-0819", "Aug 19", "760.00", false],
      ["INV-2026-0730", "Jul 30", "2,015.00", false]
    ];
    root.innerHTML = H`
      <style>
        .scn-vm .uw { left: 96px; top: 400px; width: 524px; height: 500px; }
        .scn-vm .uw .body { background: #171715; padding: 30px 34px; }
        .scn-vm .uw h4 { font-size: 27px; font-weight: 600; letter-spacing: -0.02em; }
        .scn-vm .uw .meta { font-family: var(--mono); font-size: 13px; color: var(--muted); margin-top: 8px; letter-spacing: 0.06em; }
        .scn-vm .li { display: flex; align-items: center; gap: 14px; font-size: 19px; color: #e2ded6; height: 52px; }
        .scn-vm .li .bx { width: 22px; height: 22px; border-radius: 6px; border: 1.5px solid rgba(255,250,240,0.3); display: grid; place-items: center; flex: none; }
        .scn-vm .li.ck .bx { background: var(--fg); border-color: var(--fg); color: #141412; }
        .scn-vm .li.ck .bx .ic { width: 15px; height: 15px; stroke-width: 3; }
        .scn-vm .li.ck span { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(162,158,150,0.6); }
        .scn-vm .ucaret { background: var(--fg); height: 22px; }
        .scn-vm .tile { left: ${VM.x + VM.w / 2 - 160}px; top: ${VM.y + VM.h / 2 - 125}px; width: 320px; height: 250px; border-radius: 24px; background: var(--s1); border: 1px solid var(--line-2);
          box-shadow: 0 30px 80px rgba(0,0,0,0.55); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
        .scn-vm .tile .ti { width: 74px; height: 74px; border-radius: 20px; background: radial-gradient(circle at 30% 25%, #1f3a2e, #0f1a15); border: 1px solid var(--em-line); display: grid; place-items: center; color: var(--em); }
        .scn-vm .tile .ti .ic { width: 36px; height: 36px; stroke-width: 1.6; }
        .scn-vm .tile b { font-size: 23px; font-weight: 600; letter-spacing: -0.02em; margin-top: 6px; }
        .scn-vm .tile .chip { height: 28px; font-size: 13px; }
        .scn-vm .vmw { left: ${VM.x}px; top: ${VM.y}px; width: ${VM.w}px; height: ${VM.h}px; }
        .scn-vm .vmw .tb .mono { font-family: var(--mono); font-size: 12.5px; color: var(--muted); letter-spacing: 0.06em; }
        .scn-vm .stat { position: relative; width: 180px; height: 30px; }
        .scn-vm .stat .chip { position: absolute; right: 0; top: 0; }
        .scn-vm .wall { position: absolute; inset: 0; background:
            radial-gradient(60% 70% at 18% 20%, rgba(47,214,144,0.30), rgba(47,214,144,0) 70%),
            radial-gradient(60% 60% at 85% 85%, rgba(217,160,90,0.22), rgba(217,160,90,0) 70%),
            radial-gradient(90% 90% at 60% 40%, #1b2b27, #0e1412 80%); }
        .scn-vm .mbar { position: absolute; left: 0; right: 0; top: 0; height: 32px; background: rgba(10,12,11,0.55); display: flex; align-items: center; gap: 20px; padding: 0 18px; font-size: 14px; color: #e8e4dc; }
        .scn-vm .mbar b { font-weight: 600; }
        .scn-vm .mbar .r { margin-left: auto; font-family: var(--mono); font-size: 13px; }
        .scn-vm .ib { left: ${BR.x}px; top: ${BR.y}px; width: ${BR.w}px; height: ${BR.h}px; border-radius: 14px; overflow: hidden; background: #f3f2ee; box-shadow: 0 24px 60px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.12); }
        .scn-vm .ib .itb { height: 40px; background: #e6e4de; display: flex; align-items: center; gap: 12px; padding: 0 14px; }
        .scn-vm .ib .itb .traffic i { width: 11px; height: 11px; }
        .scn-vm .ib .itb .u { flex: 1; height: 26px; border-radius: 7px; background: #fff; display: flex; align-items: center; padding: 0 10px; font-family: var(--mono); font-size: 12.5px; color: #4a4e59; }
        .scn-vm .ib .ph { height: 46px; }
        .scn-vm .ib h3 { position: absolute; left: 24px; top: 104px; }
        .scn-vm .srch { position: absolute; left: 24px; top: 152px; width: 300px; height: 44px; border-radius: 10px; border: 1.5px solid #d6d4cd; background: #fff; display: flex; align-items: center; gap: 10px; padding: 0 12px; font-size: 16px; color: #15161a; }
        .scn-vm .srch.focus { border-color: #1b2560; box-shadow: 0 0 0 4px rgba(27,37,96,0.12); }
        .scn-vm .srch .ic { width: 16px; height: 16px; color: #6a6e79; }
        .scn-vm .srch .ph2 { color: #8a8e98; }
        .scn-vm .dla { position: absolute; right: 24px; top: 152px; height: 44px; padding: 0 16px; border-radius: 10px; background: #1b2560; color: #fff; display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
        .scn-vm .dla .ic { width: 16px; height: 16px; }
        .scn-vm .rw { position: absolute; left: 24px; right: 24px; height: 52px; display: flex; align-items: center; font-size: 15.5px; border-top: 1px solid #e4e2dc; background: #fff; padding: 0 16px; color: #15161a; }
        .scn-vm .rw .a { width: 190px; font-family: var(--mono); font-size: 14px; }
        .scn-vm .rw .b { width: 110px; color: #4a4e59; }
        .scn-vm .rw .c { font-weight: 500; }
        .scn-vm .rw .dl { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; background: #eef0fa; color: #1b2560; display: grid; place-items: center; }
        .scn-vm .rw .dl .ic { width: 15px; height: 15px; }
        .scn-vm .rw .hl { position: absolute; inset: 0; border-left: 3px solid var(--em); background: rgba(47,214,144,0.08); opacity: 0; }
        .scn-vm .dock { position: absolute; left: ${(VM.w - 440) / 2}px; top: 636px; width: 440px; height: 70px; border-radius: 22px; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.14); display: flex; align-items: center; justify-content: center; gap: 14px; }
        .scn-vm .dock span { position: relative; width: 50px; height: 50px; border-radius: 13px; display: grid; place-items: center; color: #fff; }
        .scn-vm .dock span .ic { width: 24px; height: 24px; }
        .scn-vm .badge { position: absolute; right: -6px; top: -6px; width: 24px; height: 24px; border-radius: 50%; background: var(--em); color: #05170e; font-size: 13px; font-weight: 700; display: grid; place-items: center; }
        .scn-vm .boot { position: absolute; inset: 0; background: #070707; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; }
        .scn-vm .boot .bl { width: 70px; height: 96px; color: #f4f2ed; }
        .scn-vm .boot .bar { width: 260px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.14); overflow: hidden; }
        .scn-vm .boot .bar i { display: block; width: 100%; height: 100%; background: var(--fg); transform-origin: 0 50%; }
        .scn-vm .boot .bt { font-family: var(--mono); font-size: 14px; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; }
        .scn-vm .fly { position: absolute; left: 0; top: 0; width: 34px; height: 40px; margin: -20px 0 0 -17px; border-radius: 7px; background: #fff; color: #d0573a; display: grid; place-items: center; box-shadow: 0 8px 20px rgba(0,0,0,0.35); }
        .scn-vm .fly .ic { width: 20px; height: 20px; }
      </style>
      <div class="scn-cap mcap">
        <div class="k">Virtual machines</div>
        <h2>Its own <span class="serif">Mac.</span></h2>
        <p>Godmode runs a macOS VM on your device and works inside it. Your Mac stays untouched.</p>
      </div>
      <div class="win uw abs">
        <div class="tb"><div class="traffic color"><i></i><i></i><i></i></div><span class="ttl">Notes</span></div>
        <div class="body">
          <h4>Launch week</h4>
          <div class="meta">YOUR MAC · YOUR WORK</div>
          <div style="height: 18px"></div>
          <div class="li ck"><div class="bx" data-icon="check"></div><span>Final pricing copy</span></div>
          <div class="li ck"><div class="bx" data-icon="check"></div><span>Press kit to design</span></div>
          <div class="li"><div class="bx"></div><span>Rehearse the demo</span></div>
          <div class="li"><div class="bx"></div><span>Thank-you notes for beta users<span class="caret ucaret"></span></span></div>
        </div>
      </div>
      <div class="tag-pill abs utag" style="left: 96px; top: 338px" data-icon="check">Your Mac · untouched</div>
      <div class="cursor human hcur" data-kind="human"><span class="cursor-tag">You</span></div>
      <div class="abs tile"><div class="ti" data-icon="box"></div><b>macOS VM</b><span class="chip mono">READY</span></div>
      <div class="win vmw abs">
        <div class="tb"><div class="traffic color"><i></i><i></i><i></i></div><span class="ttl">Godmode VM</span><span class="mono">macOS · Apple Virtualization</span>
          <div class="right stat"><span class="chip mono s0">BOOTING…</span><span class="chip em s1"><i></i>Agent working</span><span class="chip em s2" data-icon="check">Done</span></div></div>
        <div class="body">
          <div class="wall"></div>
          <div class="mbar"><b>Godmode VM</b><span>File</span><span>Edit</span><span>Window</span><span class="r">9:41</span></div>
          <div class="abs ib">
            <div class="itb"><div class="traffic color"><i></i><i></i><i></i></div><div class="u">billing.acme.example/invoices</div></div>
            <div class="pp" style="top: 40px">
              <div class="ph"><div class="pl">A</div><b>Acme Billing</b><div class="nav"><span>Invoices</span></div></div>
            </div>
            <h3 style="font-size: 28px; font-weight: 600; letter-spacing: -0.025em; color: #15161a; top: 100px">Invoices</h3>
            <div class="srch" data-icon="search"><span class="q"></span><span class="ph2">Search invoices</span></div>
            <div class="dla" data-icon="download">Download all</div>
            ${rows
              .map(
                (r, i) =>
                  `<div class="rw rw${i}" style="top:${214 + i * 52}px"><div class="hl"></div><span class="a">${r[0]}</span><span class="b">${r[1]}</span><span class="c">EUR ${r[2]}</span><span class="dl" data-icon="download"></span></div>`
              )
              .join("")}
          </div>
          <div class="dock">
            <span style="background:#3b7ef6" data-icon="globe"></span><span style="background:#2c2b27" data-icon="folder"></span><span style="background:#d9854a" data-icon="mail"></span>
            <span style="background:#6f55e6" data-icon="calendar"></span><span style="background:#1f7a4d" data-icon="table"></span><span class="dlicon" style="background:#4a4944" data-icon="download"><em class="badge">3</em></span>
          </div>
          <div class="boot"><div class="bl" data-logo="bolt"></div><div class="bar"><i></i></div><div class="bt">Starting macOS VM</div></div>
        </div>
      </div>
      <div class="fly f0" data-icon="file"></div><div class="fly f1" data-icon="file"></div><div class="fly f2" data-icon="file"></div>
      <div class="cursor agent acur" data-kind="agent"><span class="cursor-tag">Godmode</span></div>
      <div class="ripple arip"></div>`;
    host.appendChild(root);
    GM.hydrate(root);
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    if (!o.caption) q(".mcap").style.display = "none";
    if (!o.user) ["uw", "utag", "hcur"].forEach((c) => (q("." + c).style.display = "none"));

    const T = (x) => t0 + x;
    const vmw = q(".vmw"), tile = q(".tile"), boot = q(".boot"), bar = q(".boot .bar i");
    const ib = q(".ib"), wall = q(".wall"), mbar = q(".mbar"), dock = q(".dock");
    const s0 = q(".s0"), s1 = q(".s1"), s2 = q(".s2");
    const acur = q(".acur"), arip = q(".arip"), hcur = q(".hcur");
    const flies = qa(".fly"), badge = q(".badge"), dlicon = q(".dlicon");
    const L = o.len;
    const sc = 320 / VM.w;

    gsap.set([s1, s2, badge], { opacity: 0 });
    gsap.set(flies, { opacity: 0 });
    // launch
    tl.fromTo(tile, { scale: 1 }, { scale: 0.95, duration: 0.1, ease: "power2.in" }, T(0.45));
    tl.fromTo(vmw, { opacity: 0, scale: sc, borderRadius: 24 }, { opacity: 1, scale: 1, borderRadius: 18, duration: 0.85, ease: "expo.out" }, T(0.58));
    tl.fromTo(tile, { opacity: 1 }, { opacity: 0, duration: 0.25, immediateRender: false }, T(0.58));
    tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: 0.95, ease: "power1.inOut" }, T(1.4));
    tl.fromTo(q(".boot .bl"), { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.5, ease: "expo.out" }, T(1.05));
    tl.fromTo(boot, { opacity: 1 }, { opacity: 0, duration: 0.4, ease: "power2.inOut" }, T(2.4));
    tl.fromTo([wall, mbar], { opacity: 0 }, { opacity: 1, duration: 0.5 }, T(2.3));
    tl.fromTo(dock, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, T(2.5));
    tl.fromTo(ib, { opacity: 0, scale: 0.92, y: 20 }, { opacity: 1, scale: 1, y: 0, duration: 0.7, ease: "expo.out" }, T(2.6));
    tl.to(s0, { opacity: 0, duration: 0.2 }, T(2.45));
    tl.fromTo(s1, { opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, T(2.5));
    tl.to(s1, { opacity: 0, duration: 0.2 }, T(6.2));
    tl.fromTo(s2, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)", immediateRender: false }, T(6.25));

    // agent cursor (abs coords)
    const srch = abs(BR.x + 24 + 150, BR.y + 152 + 22);
    const dla = abs(BR.x + BR.w - 24 - 70, BR.y + 152 + 22);
    const P = new GM.Path(abs(BR.x + 520, BR.y + 470).x, abs(BR.x + 520, BR.y + 470).y);
    P.to(srch.x - 60, srch.y - 2, 3.1, 0.5, "power3.inOut");
    P.to(dla.x - 30, dla.y - 2, 4.45, 0.55, "power3.inOut");
    P.to(abs(BR.x + 520, BR.y + 470).x, abs(BR.x + 520, BR.y + 470).y, 5.4, 0.7, "power2.inOut");
    tl.fromTo(acur, { opacity: 0 }, { opacity: 1, duration: 0.3 }, T(2.95));
    tl.to(acur, { opacity: 0, duration: 0.3 }, T(6.35));
    [[srch.x - 58, srch.y, 3.62], [dla.x - 28, dla.y, 5.02]].forEach(([x, y, at]) => {
      tl.fromTo(arip, { x: x, y: y, scale: 0.3, opacity: 0.9 }, { x: x, y: y, scale: 1.6, opacity: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, T(at));
      tl.fromTo(acur.querySelector("svg"), { scale: 1 }, { scale: 0.82, duration: 0.08, transformOrigin: "10% 10%", immediateRender: false }, T(at - 0.02));
      tl.to(acur.querySelector("svg"), { scale: 1, duration: 0.22, ease: "back.out(3)" }, T(at + 0.06));
    });
    tl.fromTo(q(".dla"), { scale: 1 }, { scale: 0.95, duration: 0.08, immediateRender: false }, T(5.0));
    tl.to(q(".dla"), { scale: 1, duration: 0.25, ease: "back.out(3)" }, T(5.08));
    // filter rows: keep September
    const keep = [0, 1, 3];
    rows.forEach((r, i) => {
      const el = q(".rw" + i);
      if (r[3]) {
        const to = keep.indexOf(i);
        tl.fromTo(el, { y: 0 }, { y: (to - i) * 52, duration: 0.55, ease: "expo.inOut", immediateRender: false }, T(4.2));
        tl.fromTo(el.querySelector(".hl"), { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, T(4.5 + to * 0.08));
      } else {
        tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: 0.3, immediateRender: false }, T(4.1));
      }
    });
    // files fly to the dock
    const dockPt = abs((VM.w - 440) / 2 + 440 / 2 + 2.5 * 64, 636 + 35);
    flies.forEach((f, i) => {
      const s = 5.15 + i * 0.1;
      tl.fromTo(f, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.15, immediateRender: false }, T(s));
      tl.fromTo(f, { x: dla.x }, { x: dockPt.x, duration: 0.6, ease: "power1.inOut", immediateRender: false }, T(s));
      tl.fromTo(f, { y: dla.y }, { y: dockPt.y, duration: 0.6, ease: "back.in(1.4)", immediateRender: false }, T(s));
      tl.to(f, { opacity: 0, scale: 0.5, duration: 0.12 }, T(s + 0.55));
    });
    tl.fromTo(dlicon, { y: 0 }, { y: -16, duration: 0.18, ease: "power2.out", immediateRender: false }, T(5.78));
    tl.to(dlicon, { y: 0, duration: 0.45, ease: "bounce.out" }, T(5.96));
    tl.fromTo(badge, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2.5)", immediateRender: false }, T(5.85));

    if (o.loop) {
      tl.to(vmw, { opacity: 0, scale: sc, borderRadius: 24, duration: 0.75, ease: "expo.inOut" }, T(L - 1.45));
      tl.to(tile, { opacity: 1, scale: 1, duration: 0.35 }, T(L - 1.0));
      // reset VM internals while hidden
      const rT = T(L - 0.6);
      tl.set([boot, s0], { opacity: 1 }, rT);
      tl.set([wall, mbar, dock, ib, s1, s2, badge], { opacity: 0 }, rT);
      rows.forEach((r, i) => {
        tl.set(q(".rw" + i), { y: 0, opacity: 1 }, rT);
        tl.set(q(".rw" + i + " .hl"), { opacity: 0 }, rT);
      });
      tl.set(bar, { scaleX: 0 }, rT);
    }

    const qEl = q(".srch .q"), ph2 = q(".srch .ph2"), srchEl = q(".srch"), ucaret = q(".ucaret");
    const QUERY = "September";
    const qS = GM.typeSchedule(QUERY, 3.7, 20, 3);
    const hp = new GM.Path(460, 780);
    hp.to(452, 772, 1.0, 2.2, "sine.inOut").to(466, 786, 3.6, 2.2, "sine.inOut").to(460, 780, 6.0, 1.8, "sine.inOut");
    function update(t) {
      const lt = t - t0;
      const reset = o.loop && lt >= L - 0.6;
      const s = reset ? "" : GM.typedAt(qS, QUERY, lt);
      qEl.textContent = s;
      ph2.style.display = s ? "none" : "inline";
      srchEl.classList.toggle("focus", !reset && lt >= 3.6 && lt < 4.5);
      P.apply(acur, lt);
      hp.apply(hcur, lt);
      ucaret.style.opacity = GM.blinkOn(lt, 1.06) ? 1 : 0;
    }
    return { root: root, update: update };
  };
})();
