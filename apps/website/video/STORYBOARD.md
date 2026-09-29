---
mode: autonomous
message: "Godmode Bot is an AI coworker that actually does the work on your computer — and never sees your secrets."
fps: 30
---

Beat plans per deliverable. Shared system: `_shared/brand.css` (tokens), `_shared/lib.js` (camera, paths,
typing, reveals), `_shared/scenes/*.js` (reusable 1600x1000 scenes), `_shared/ad.js` (X ad beats).
Rebuild everything with `./build.sh` (or `./build.sh <project>`).

## Frame hero — `hero/index.html` (1920x1080, 25s loop)
- blueprint: prompt-type-submit-generate → agent-progress-theater (thread payload) → titlecard-reveal
- 0–4.8 composer typing the task (camera slow push) · 4.6 send · 5.0–6.7 zoom-out reveal (app assembles)
- 6.5–11.6 browser: URL → login (vault fill, "From vault") → 2FA dots; step rows flip with spinners, "Secret hidden"
- 11.65 camera glance at the Secret-hidden rows · 13–14.9 invoices + downloads tray · 14.9 Slack #accounting card
- 16.9 "Done." · 18.6 recede · 19.3–22.6 tagline card · 23.45 reset → 25.0 equals frame 0 (seam PSNR ≈ 42.6 dB)

## Frame feature-vault — `feature-vault` (1600x1000, 8s loop)
- rules: svg-path-draw (dash flow), spring-pop-entrance, discrete-text-sequence
- vault → page wires with packets; probe stops at "Never sent"; AI panel rows show REDACTED; counter stays 0

## Frame feature-background — `feature-background` (1600x1000, 8s loop)
- blueprint: cursor-ui-demo (agent cursor) + depth-of-field idea as an x-ray lens (clip-path circle)
- you type in the focused Mail window; Godmode logs invoices in the covered tracker; lens reveals it behind yours

## Frame feature-vm — `feature-vm` (1600x1000, 8s loop)
- blueprint: device-surface-showcase (stepwise-flow) + card-morph-anchor (tile ↔ window)
- tile → VM window → boot → agent searches/filters/downloads in the VM → files fly to the dock → collapse to tile

## Frame ad-main-16x9 / ad-main-1x1 — (18s)
- blueprint: kinetic-type-beats (hook) · device-surface-showcase (framed real screenshots, inner camera) · titlecard-reveal/cta end card
- 0 hook "Your next hire isn't human." · 2.2 intro (home.png) · 4.65 vault (chat.png, highlight on Secret hidden)
- 8.45 computer use / own Mac (vm scene) · 12.2 routines.png + Slack card · 15.3 end card ($500 once or $50/mo, Get Godmode)

## Frame ad-vault-1x1 — (11s)
- 0 hook "Give AI your logins. It never sees them." · 2.0 vault scene with camera travel login → AI panel → wide · 7.55 end card

## Frame ad-vm-9x16 — (13s)
- 0 hook "An AI with its own Mac." · 2.0 vm scene (tile → boot → work → done) with 3 caption beats · 9.2 end card

## Frame og-image — (1200x630 still, snapshot at 1.9s)
- headline left, chat.png crop right with the Secret-hidden column highlighted
