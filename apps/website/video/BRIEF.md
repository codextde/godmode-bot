---
workflow: general-video
flow: automation
storyboard: no
message: "Godmode Bot is an AI coworker that actually does the work on your computer — and never sees your secrets."
destination: website + x-feed
aspect: 1920x1080 (hero, feature loops), 1080x1080 + 1920x1080 + 1080x1920 (X ads), 1200x630 (og)
language: en
audience: founders, operators and teams who want an AI that finishes real computer work
length: hero 25s loop · feature loops 8s · ads 11–18s
angle: product-in-action, premium restraint
---

## Intent

Launch motion suite for Godmode Bot (desktop AI coworker powered by Claude Opus 5.5 via Claude Code).
Premium Apple/Linear/x.ai restraint: warm near-black canvas, precise type, slow confident camera, emerald
for live/active states only, Claude orange only next to "Claude Opus 5.5". The user asked for an autonomous
run ("work autonomously — do not ask"), so every open choice was decided in-run and is recorded below.

Deliverables (projects live in this folder, renders land in `../public/media/`):

- `hero/` → hero.mp4 / hero.webm / hero-poster.jpg|webp — 25s seamless loop, no audio.
- `feature-vm/`, `feature-background/`, `feature-vault/` → 8s feature loops, no audio.
- `ad-main-16x9/`, `ad-main-1x1/`, `ad-vault-1x1/`, `ad-vm-9x16/` → X ads with burned-in captions + thumbnail JPGs.
- `og-image/` → og-image.png (1200x630).

## Assets

- ../../../docs/screenshots/*.png — real app screenshots (2000x1250, dark UI), symlinked as `_shared/screens`.
- ../../../docs/assets/logo.svg — logo (white bolt on #1C1C1C rounded square), copied to `_shared/img/logo.svg`.
- `_shared/fonts/` — Geist, Geist Mono (variable), Instrument Serif (from @fontsource, OFL).

## Customizations

- Recreated Godmode UI in HTML (matches the real app's layout) for animated states the screenshots can't show:
  typed task, step rows flipping to done, "Secret hidden" badges, vault fill, 2FA fill, downloads, Slack post.
- Real screenshots are used inside window frames in the ads (chat.png, routines.png, messaging.png, agents.png).
- Pure-function virtual camera (`_shared/lib.js` → `GM.Camera`): focus-point + log-zoom interpolation.

## Notes

- Honesty: only real capabilities are shown. No testimonials, user counts or customer logos. Fictional portal
  "Acme Billing" at `billing.acme.example` (reserved .example TLD) and the fictional company from the app's own
  screenshots (`codext.example`).
- Audio: the brief allows a music bed only if the skill workflow can legitimately generate/source royalty-free
  audio. HeyGen is signed out, the Gemini/Google keys in the environment were rejected by Lyria, and MusicGen's
  weights are non-commercial — so every deliverable ships silent.
- Ad end cards: "Godmode Bot · $500 once or $50/mo", "Get Godmode" CTA, and the live domain "godmode.codext.de"
  (Geist Mono, warm paper at 70%) under the CTA.
