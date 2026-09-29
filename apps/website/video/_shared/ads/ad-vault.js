/* Ad: "Give AI your logins. It never sees them." — 11s, 1x1. */
(function () {
  GM.buildAdVault = function (fmt) {
    const D = 11;
    const tl = gsap.timeline({ paused: true });
    const ctx = GM.ad.init(fmt, tl, D);
    GM.ad.hook(ctx, { at: 0.0, out: 1.85, kick: "Godmode Bot · Vault & 2FA", kickAt: 0.75, size: { l: 94, s: 108 }, lines: [{ t: "Give AI your logins." }, { t: "It never sees them.", serif: true }] });
    GM.ad.mark(ctx, 2.0, 7.35);
    GM.ad.caption(ctx, { at: 2.05, out: 6.15, k: "Encrypted vault · on your device", l1: "Fills your logins & 2FA.", l2: "The AI never sees them." });
    GM.ad.caption(ctx, { at: 6.3, out: 7.35, k: "Result", l1: "Signed in.", l2: "0 secrets in the AI’s context." });
    GM.ad.scene(ctx, {
      name: "vault", t0: 1.8, at: 2.0, out: 7.4,
      start: [800, 625, 0.66],
      cams: [
        [520, 640, 1.04, 2.55, 0.9, "power4.inOut"],
        [530, 646, 1.07, 3.45, 0.85, "sine.inOut"],
        [1140, 640, 1.12, 4.35, 0.95, "power4.inOut"],
        [1150, 640, 1.15, 5.3, 0.7, "sine.inOut"],
        [800, 628, 0.68, 6.05, 0.95, "power4.inOut"]
      ]
    });
    GM.ad.end(ctx, { at: 7.55 });
    GM.ad.finish(ctx);
    return tl;
  };
})();
