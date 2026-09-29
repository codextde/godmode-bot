/* Ad: "An AI with its own Mac." — 13s, 9x16. */
(function () {
  GM.buildAdVM = function (fmt) {
    const D = 13;
    const tl = gsap.timeline({ paused: true });
    const ctx = GM.ad.init(fmt, tl, D);
    GM.ad.hook(ctx, { at: 0.0, out: 1.9, kick: "Godmode Bot · Virtual machines", kickAt: 0.75, lines: [{ t: "An AI with" }, { t: "its own Mac.", serif: true }] });
    GM.ad.mark(ctx, 2.0, 9.0);
    GM.ad.caption(ctx, { at: 2.05, out: 4.35, k: "Virtual machines", l1: "It spins up a macOS VM", l2: "right on your device." });
    GM.ad.caption(ctx, { at: 4.5, out: 6.85, k: "Agent at work", l1: "It clicks, types and downloads", l2: "inside its own Mac." });
    GM.ad.caption(ctx, { at: 7.0, out: 9.0, k: "Your Mac", l1: "Your Mac stays", l2: "untouched." });
    GM.ad.scene(ctx, {
      name: "vm", t0: 1.8, at: 2.0, out: 9.05, opts: { user: false },
      start: [1092, 515, 1.08],
      cams: [
        [1092, 515, 1.16, 2.3, 1.2, "power3.out"],
        [1092, 520, 1.2, 3.6, 4.6, "sine.inOut"]
      ]
    });
    GM.ad.end(ctx, { at: 9.2, tagWidth: 860 });
    GM.ad.finish(ctx);
    return tl;
  };
})();
