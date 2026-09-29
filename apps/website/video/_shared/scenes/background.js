/* Scene: "Works in the background." — you type in your focused window while Godmode clicks and types in a
   covered window behind it. An x-ray lens shows the agent's work through your window.
   1600x1000 stage. GM.scenes.background(host, tl, t0, opts) -> { root, update(t) } */
(function () {
  const H = String.raw;
  const BACK = { x: 96, y: 330, w: 860, h: 540 };
  const FRONT = { x: 700, y: 452, w: 804, h: 488 };
  const ROWY = (i) => BACK.y + 50 + 70 + i * 64 + 32; // row centre (abs)
  const AMT_X = BACK.x + 24 + 250 + 190 + 60;
  const STS_X = BACK.x + 24 + 250 + 190 + 196 + 64;

  function backWindow(extraClass) {
    const rows = [
      ["Acme Billing", "INV-2026-0931", "1,890.00", "l"],
      ["Northwind Cloud", "NW-44817", "612.00", "l"],
      ["Linecraft Studio", "LC-2026-118", "", "p"],
      ["Parcel Freight", "PF-99102", "", "p"],
      ["Brightdesk", "BD-7731", "", "p"],
      ["Orbit Office", "OO-2026-09", "", "p"]
    ];
    return H`<div class="win bw ${extraClass}">
        <div class="tb"><div class="traffic"><i></i><i></i><i></i></div><span class="ttl">Vendor tracker <small>— Q3 invoices</small></span>
          <div class="right"><span class="chip em"><i></i>Godmode · working</span></div></div>
        <div class="body">
          <div class="trow th"><span class="c1">Vendor</span><span class="c2">Invoice</span><span class="c3">Amount (EUR)</span><span class="c4">Status</span></div>
          ${rows
            .map(
              (r, i) =>
                `<div class="trow r${i}"><span class="c1">${r[0]}</span><span class="c2">${r[1]}</span><span class="c3"><span class="cell${r[2] ? "" : " empty"}"><span class="amt">${r[2]}</span></span></span><span class="c4"><span class="st ${r[3] === "l" ? "done" : ""}"><span class="st-p">Pending</span><span class="st-l">Logged</span></span></span></div>`
            )
            .join("")}
          <div class="tfoot"><span class="cnt">2 of 6 logged</span><span class="sum">Q3 · EUR <b class="tot">2,502.00</b></span></div>
        </div>
      </div>`;
  }

  GM.scenes.background = function (host, tl, t0, opts) {
    const o = Object.assign({ caption: true, loop: true, len: 8 }, opts || {});
    const root = document.createElement("div");
    root.className = "scn scn-bg";
    root.innerHTML = H`
      <style>
        .scn-bg .bw { left: ${BACK.x}px; top: ${BACK.y}px; width: ${BACK.w}px; height: ${BACK.h}px; }
        .scn-bg .bw .body { background: #131311; }
        .scn-bg .trow { position: absolute; left: 24px; right: 24px; height: 64px; display: flex; align-items: center; font-size: 18px; color: #e6e2da; border-top: 1px solid var(--line); white-space: nowrap; }
        .scn-bg .trow.th { top: 20px; height: 50px; border-top: 0; font-family: var(--mono); font-size: 14px; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; }
        ${[0, 1, 2, 3, 4, 5].map((i) => `.scn-bg .trow.r${i} { top: ${70 + i * 64}px; }`).join("\n")}
        .scn-bg .c1 { width: 250px; }
        .scn-bg .c2 { width: 190px; font-family: var(--mono); font-size: 15.5px; color: #bdb9b0; }
        .scn-bg .c3 { width: 196px; }
        .scn-bg .cell { display: inline-flex; align-items: center; height: 40px; min-width: 150px; padding: 0 12px; border-radius: 8px; font-family: var(--mono); font-size: 17px; }
        .scn-bg .cell.empty { border: 1px dashed rgba(255,250,240,0.16); }
        .scn-bg .cell.edit { border: 1.5px solid var(--em); background: rgba(47,214,144,0.08); }
        .scn-bg .st { position: relative; display: inline-block; width: 104px; height: 32px; }
        .scn-bg .st span { position: absolute; inset: 0; display: grid; place-items: center; border-radius: 999px; font-size: 14px; font-weight: 500; }
        .scn-bg .st-p { background: rgba(244,191,79,0.12); color: #f0c46a; border: 1px solid rgba(244,191,79,0.3); }
        .scn-bg .st-l { background: var(--em-soft); color: var(--em); border: 1px solid var(--em-line); opacity: 0; }
        .scn-bg .st.done .st-l { opacity: 1; }
        .scn-bg .st.done .st-p { opacity: 0; }
        .scn-bg .tfoot { position: absolute; left: 24px; right: 24px; top: 460px; height: 50px; display: flex; align-items: center; font-family: var(--mono); font-size: 14px; color: var(--muted); letter-spacing: 0.04em; border-top: 1px solid var(--line); }
        .scn-bg .tfoot .sum { margin-left: auto; }
        .scn-bg .tfoot b { color: var(--fg); font-weight: 500; }
        .scn-bg .fw { left: ${FRONT.x}px; top: ${FRONT.y}px; width: ${FRONT.w}px; height: ${FRONT.h}px; box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 60px 120px rgba(0,0,0,0.75), 0 20px 40px rgba(0,0,0,0.5); }
        .scn-bg .fw .body { background: #171715; padding: 0 30px; }
        .scn-bg .mrow { height: 58px; display: flex; align-items: center; gap: 14px; border-bottom: 1px solid var(--line); font-size: 18px; color: #e6e2da; white-space: nowrap; }
        .scn-bg .mrow .k { color: var(--muted); width: 78px; }
        .scn-bg .mrow .to { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 8px; background: #26241f; font-size: 16px; }
        .scn-bg .mbody { padding-top: 22px; font-size: 20px; line-height: 1.55; color: #ece8e0; white-space: pre-wrap; width: 740px; }
        .scn-bg .mbody .caret { background: var(--fg); }
        .scn-bg .send { position: absolute; right: 30px; bottom: 24px; height: 44px; padding: 0 20px; border-radius: 11px; background: #2d6cf0; color: #fff; display: flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 600; }
        .scn-bg .send .ic { width: 17px; height: 17px; }
        .scn-bg .lens { position: absolute; left: ${BACK.x}px; top: ${BACK.y}px; width: ${BACK.w}px; height: ${BACK.h}px; }
        .scn-bg .lens .win { left: 0; top: 0; box-shadow: none; }
        .scn-bg .lensring { position: absolute; left: 0; top: 0; width: 1px; height: 1px; }
        .scn-bg .lensring i { position: absolute; left: -100px; top: -100px; width: 200px; height: 200px; border-radius: 50%; border: 2px solid var(--em); box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 40px rgba(47,214,144,0.35), inset 0 0 30px rgba(47,214,144,0.12); }
        .scn-bg .lenslbl { position: absolute; left: 0; top: 0; font-family: var(--mono); font-size: 13px; letter-spacing: 0.1em; color: var(--em); white-space: nowrap; }
      </style>
      <div class="scn-cap bcap" style="width: 1000px">
        <div class="k">Computer use · background</div>
        <h2>Works in the <span class="serif">background.</span></h2>
        <p style="width: 760px">Godmode clicks and types in app windows behind yours. Your mouse and keyboard stay yours.</p>
      </div>
      ${backWindow("abs back")}
      <div class="cursor agent acur" data-kind="agent"><span class="cursor-tag">Godmode</span></div>
      <div class="ripple arip"></div>
      <div class="win fw abs">
        <div class="tb"><div class="traffic color"><i></i><i></i><i></i></div><span class="ttl">New Message</span></div>
        <div class="body">
          <div class="mrow"><span class="k">To</span><span class="to">team@codext.example</span></div>
          <div class="mrow"><span class="k">Subject</span><span>Launch notes</span></div>
          <div class="mbody"><span class="mb-base"></span><span class="mb-typed"></span><span class="caret mcaret"></span></div>
          <div class="send" data-icon="send">Send</div>
        </div>
      </div>
      <div class="tag-pill abs ftag" style="left:${FRONT.x + FRONT.w - 250}px; top:${FRONT.y - 62}px" data-icon="user">You · typing in Mail</div>
      <div class="cursor human hcur" data-kind="human"><span class="cursor-tag">You</span></div>
      <div class="lens">${backWindow("lenswin")}</div>
      <div class="lensring"><i></i></div>
      <div class="cursor agent acur2" data-kind="agent"></div>
      <div class="lenslbl">BEHIND YOUR WINDOW</div>`;
    host.appendChild(root);
    GM.hydrate(root);
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    if (!o.caption) q(".bcap").style.display = "none";
    const lensWin = q(".lens .win");
    lensWin.style.left = "0px";
    lensWin.style.top = "0px";

    const BASE = "Hi team,\n\nQuick notes before Thursday: ";
    const TYPED = "the onboarding flow is final and pricing goes live at 9am. Deck coming tonight.";
    q(".mb-base").textContent = BASE;
    const tS = GM.typeSchedule(TYPED, 0.35, 12.5, 21);

    // Agent path (abs coords of the cursor tip)
    const P = new GM.Path(AMT_X - 90, ROWY(2) + 60);
    const ACTS = []; // {t, kind, row}
    let tt = 0.55;
    [2, 3, 4].forEach((r) => {
      P.to(AMT_X - 40, ROWY(r) - 4, tt, 0.42, "power3.inOut");
      ACTS.push({ t: tt + 0.45, kind: "amt", row: r });
      P.to(STS_X - 20, ROWY(r) - 4, tt + 1.05, 0.4, "power3.inOut");
      ACTS.push({ t: tt + 1.5, kind: "st", row: r });
      tt += 1.9;
    });
    P.to(AMT_X - 90, ROWY(2) + 60, o.len - 0.9, 0.7, "power2.inOut");

    const AMTS = { 2: "2,400.00", 3: "318.40", 4: "1,150.00" };
    const TOTALS = ["2,502.00", "4,902.00", "5,220.40", "6,370.40"];
    const aSched = {};
    ACTS.filter((a) => a.kind === "amt").forEach((a) => (aSched[a.row] = GM.typeSchedule(AMTS[a.row], a.t + 0.05, 22, a.row)));

    const acur = q(".acur"), acur2 = q(".acur2"), arip = q(".arip"), hcur = q(".hcur");
    const lens = q(".lens"), ring = q(".lensring"), lbl = q(".lenslbl");
    const typedEl = q(".mb-typed"), mcaret = q(".mcaret");
    gsap.set(hcur, { x: FRONT.x + 560, y: FRONT.y + 330 });

    // Clicks (ripples at abs coords)
    ACTS.forEach((a) => {
      const p = P.at(a.t);
      tl.fromTo(arip, { x: p.x + 3, y: p.y + 3, scale: 0.3, opacity: 0.9 }, { x: p.x + 3, y: p.y + 3, scale: 1.6, opacity: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, t0 + a.t);
      [acur, acur2].forEach((c) => {
        tl.fromTo(c.querySelector("svg"), { scale: 1 }, { scale: 0.82, duration: 0.08, transformOrigin: "10% 10%", immediateRender: false }, t0 + a.t - 0.02);
        tl.to(c.querySelector("svg"), { scale: 1, duration: 0.22, ease: "back.out(3)" }, t0 + a.t + 0.06);
      });
      if (a.kind === "st") {
        qa(`.r${a.row} .st`).forEach((st) => {
          tl.fromTo(st, { scale: 1 }, { scale: 1.12, duration: 0.12, ease: "power2.out", immediateRender: false }, t0 + a.t + 0.02);
          tl.to(st, { scale: 1, duration: 0.4, ease: "back.out(3)" }, t0 + a.t + 0.14);
        });
      }
    });
    if (o.loop) {
      tl.fromTo(typedEl, { opacity: 1 }, { opacity: 0, duration: 0.35, ease: "power2.in", immediateRender: false }, t0 + o.len - 0.75);
      tl.set(typedEl, { opacity: 1 }, t0 + o.len - 0.38);
    }
    // gentle idle drift on the human cursor (they are working, not frozen)
    const hp = new GM.Path(FRONT.x + 560, FRONT.y + 330);
    hp.to(FRONT.x + 540, FRONT.y + 318, 1.2, 1.6, "sine.inOut").to(FRONT.x + 566, FRONT.y + 336, 3.6, 1.8, "sine.inOut").to(FRONT.x + 560, FRONT.y + 330, 6.0, 1.6, "sine.inOut");

    function inside(p) {
      const d = Math.min(p.x - FRONT.x, FRONT.x + FRONT.w - p.x, p.y - FRONT.y, FRONT.y + FRONT.h - p.y);
      return Math.max(0, Math.min(1, d / 36));
    }
    function update(t) {
      const lt = t - t0;
      const reset = o.loop && lt >= o.len - 0.38;
      // human typing
      typedEl.textContent = reset ? "" : GM.typedAt(tS, TYPED, lt);
      mcaret.style.opacity = GM.blinkOn(lt, 1.0) || (lt > 0.35 && lt < 6.9) ? 1 : 0;
      hp.apply(hcur, lt);
      // agent
      const p = P.apply(acur, lt);
      acur2.style.transform = acur.style.transform;
      const k = inside(p);
      const r = 96 * (k < 1 ? 1 - Math.pow(1 - k, 3) : 1);
      lens.style.clipPath = "circle(" + r.toFixed(2) + "px at " + (p.x - BACK.x).toFixed(2) + "px " + (p.y - BACK.y).toFixed(2) + "px)";
      ring.style.transform = "translate(" + p.x.toFixed(2) + "px," + p.y.toFixed(2) + "px) scale(" + (r / 100).toFixed(4) + ")";
      ring.style.opacity = k > 0.02 ? 1 : 0;
      acur2.style.opacity = k > 0.02 ? 1 : 0;
      lbl.style.transform = "translate(" + (p.x - 80).toFixed(2) + "px," + (p.y + r + 14).toFixed(2) + "px)";
      lbl.style.opacity = Math.max(0, (k - 0.6) / 0.4).toFixed(3);
      // table state (both the real window and the lens copy)
      let logged = 2;
      [2, 3, 4].forEach((row) => {
        const amtAct = ACTS.find((a) => a.kind === "amt" && a.row === row);
        const stAct = ACTS.find((a) => a.kind === "st" && a.row === row);
        const txt = reset ? "" : GM.typedAt(aSched[row], AMTS[row], lt);
        const editing = !reset && lt >= amtAct.t && lt < stAct.t - 0.35;
        const done = !reset && lt >= stAct.t + 0.02;
        if (done) logged++;
        qa(`.r${row} .amt`).forEach((el) => (el.textContent = txt));
        qa(`.r${row} .cell`).forEach((el) => {
          el.classList.toggle("empty", txt.length === 0 && !editing);
          el.classList.toggle("edit", editing);
        });
        qa(`.r${row} .st`).forEach((el) => el.classList.toggle("done", done));
      });
      qa(".cnt").forEach((el) => (el.textContent = logged + " of 6 logged"));
      qa(".tot").forEach((el) => (el.textContent = TOTALS[logged - 2]));
    }
    return { root: root, update: update };
  };
})();
