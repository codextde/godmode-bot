/* Ad: "Your next hire isn't human." — hook, intro, 3 capability beats, end card. 18s, 16x9 or 1x1. */
(function () {
  GM.buildAdMain = function (fmt) {
    const D = 18;
    const tl = gsap.timeline({ paused: true });
    const ctx = GM.ad.init(fmt, tl, D);
    const sq = fmt === "1x1";
    const S = (n) => "assets/screens/" + n + ".png";

    GM.ad.hook(ctx, { at: 0.0, out: 1.95, kick: "Godmode Bot · AI coworker", kickAt: 0.75, lines: [{ t: "Your next hire" }, { t: "isn’t human.", serif: true }] });
    GM.ad.mark(ctx, 2.15, 14.95);

    // Intro
    GM.ad.caption(ctx, { at: 2.2, out: 4.4, k: "Meet Godmode Bot", l1: "An AI coworker", l2: "that uses your computer like you do." });
    const s0 = (sq ? 960 : 1142) / 2000;
    GM.ad.shot(ctx, { src: S("home"), at: 2.3, out: 4.45, cams: [[1180, 520, s0 * 1.32, 2.5, 2.4, "power2.inOut"]] });

    // Beat 1 — vault
    GM.ad.caption(ctx, { at: 4.65, out: 8.2, k: "01 · Logins & 2FA", l1: "Logs in for you.", l2: "Never sees your passwords." });
    GM.ad.shot(ctx, {
      src: S("chat"), at: 4.7, out: 8.25,
      cams: [[990, 820, sq ? 0.98 : 1.165, 5.25, 1.3, "power4.inOut"], [1060, 815, sq ? 1.02 : 1.2, 6.55, 1.6, "sine.inOut"]],
      hl: [{ x: 1250, y: 660, w: 166, h: 320, at: 6.2 }]
    });

    // Beat 2 — VM / background (reuses the feature scene)
    GM.ad.caption(ctx, { at: 8.45, out: 11.95, k: "02 · Computer use", l1: "Works in the background —", l2: "or in its own Mac." });
    GM.ad.scene(ctx, {
      name: "vm", t0: 6.25, at: 8.5, out: 12.0, opts: { user: !sq },
      start: sq ? [1092, 516, 0.86] : [800, 515, 0.9],
      cams: sq ? [[1092, 522, 0.9, 8.8, 3.1, "sine.inOut"]] : [[1000, 520, 0.98, 8.8, 3.1, "sine.inOut"]]
    });

    // Beat 3 — routines + Slack
    GM.ad.caption(ctx, { at: 12.2, out: 15.0, k: "03 · Routines & Slack", l1: "Runs on a schedule.", l2: "Reports back in Slack." });
    GM.ad.shot(ctx, { src: S("routines"), at: 12.25, out: 15.05, cams: [[1150, 760, s0 * 1.28, 12.5, 2.4, "power2.inOut"]] });
    GM.ad.slack(ctx, sq
      ? { at: 13.25, out: 15.0, x: 250, y: 610, w: 720, channel: "finance", text: "Monthly invoice collection finished: 3 new invoices from Acme Billing, EUR 4,242.00.", files: ["INV-0931.pdf", "INV-0917.pdf"] }
      : { at: 13.25, out: 15.0, x: 1060, y: 560, w: 720, channel: "finance", text: "Monthly invoice collection finished: 3 new invoices from Acme Billing, EUR 4,242.00.", files: ["INV-0931.pdf", "INV-0917.pdf", "INV-0904.pdf"] });

    GM.ad.end(ctx, { at: 15.3 });
    GM.ad.finish(ctx);
    return tl;
  };
})();
