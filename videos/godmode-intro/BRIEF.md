---
workflow: general-video
flow: automation
storyboard: no
message: "Godmode Bot gives you AI coworkers that do real work on your computer — with your logins, never your secrets."
destination: website + x-feed
aspect: 1920x1080
language: en
audience: founders, operators and small teams who want an AI that finishes real computer work
length: ~85s
angle: character-led intro modelled on OpenAI's "dots" film — agents as coworkers who already did the work, then how it works
---

## Intent

An introduction film for Godmode Bot, "similar to" OpenAI's dots launch video
(https://x.com/OpenAI/status/2104984504133918973, local copy
~/Downloads/OpenAI_2104984413113393152.mp4): calm, warm, human pacing; agents shown as
characters with names and personalities; big message bubbles where agents report work they
already finished ("I caught the app migration in your notes — I've already mapped out the
changes"); the person replies; agents reach you anywhere (phone); logo end card.

We cannot shoot live action, so the film is motion design built around the real product UI.
It must introduce Godmode Bot, show its features, and explain how it works.

User requirement, verbatim: "always use light mode for the video and screenshots".
Autonomous run — the user asked for a goal to be completed without pausing; every open choice was
decided in-run and is recorded here.

## Assets

- assets/screens/*.png — real Godmode Bot screenshots captured in LIGHT mode from a sandboxed
  instance seeded with fictional demo data (reserved .example domains).
- ../../docs/assets/logo.svg — Godmode bolt logo.
- Geist / Geist Mono (the app's own fonts, OFL) + Instrument Serif for the few editorial lines.

## Customizations

- Light mode everywhere: the app's paper palette (#faf9f5 background, #1c1c1c ink, emerald #0eca7b
  only for live/active states, "Secret hidden" badges).
- Recreated light UI in HTML for animated states screenshots can't show (typing, steps ticking,
  secrets filled, phone messages).
- Structure mirrors the reference: open on the name → meet the team → agents report finished work
  → you reply → how it works → they reach you anywhere → end card.

## Notes

- Honesty: only real, shipped capabilities (see README). No testimonials, user counts or customer
  logos. Fictional companies only (Acme, Northwind on .example).
- Audio: HeyGen signed out; MusicGen weights are non-commercial, so no generated music from it.
  Any music bed/sound marks must be synthesized locally (royalty-free by construction) or omitted.
- Kept separate from the other session's dark-themed suite in apps/website/video/.
