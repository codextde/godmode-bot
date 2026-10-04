# Godmode Bot — intro film (light mode)

An ~87-second introduction to Godmode Bot, modelled on the pacing and structure of OpenAI's "dots"
launch film: agents as characters who report work they have already finished, you reply, then a look
at how it works and an end card. Everything is shown in the app's light "paper" theme.

| Scene | Time | What happens |
| --- | --- | --- |
| `s1-open` | 0–6s | Bolt tile blooms, "Godmode" lockup, "AI coworkers that do real work on your computer." |
| `s2-team` | 6–17s | "Meet your team." Agent portraits on a wall; the camera pans, then pulls back. |
| `s3-reports` | 17–32s | "You wake up to work already done." Two agent screens report finished work; you reply. |
| `s4-ask` | 32–39.5s | How it works 01: ask in plain words (the composer types and sends). |
| `s5-works` | 39.5–55.5s | 02 a real browser · 03 your logins, never your secrets: steps tick off, the vault fills username, password and 2FA ("Secret hidden"); then the real app's answer ("I never saw them"). |
| `s6-memory` | 55.5–65.5s | 04 it keeps working on its own (real Automations page) · 05 it remembers (real dream journal). |
| `s7-anywhere` | 65.5–76.5s | Reach them anywhere: phone chat + capability tiles. |
| `s8-end` | 76.5–87s | The team converges into the mark; "Godmode Bot — An AI teammate you can trust to get work done." |

## Commands

```bash
npx --yes hyperframes@0.8.123 preview --background   # Studio preview
npx --yes hyperframes@0.8.123 check                  # lint, layout, motion, contrast
npx --yes hyperframes@0.8.123 render --quality delivery -o renders/godmode-intro.mp4
```

## Sources

- `assets/screens/*.png` — real Godmode Bot screenshots, light theme, captured from a sandboxed instance
  seeded with fictional demo data (Acme / Northwind on reserved `.example` domains).
- `assets/fonts/` — Geist, Geist Mono (the app's own fonts) and Instrument Serif; all OFL.
- `assets/img/logo.svg` — from `docs/assets/logo.svg`.
- `assets/audio/soundtrack.m4a` — score and UI sound marks synthesized from oscillators and seeded noise
  by `scripts/make_audio.py` (original, royalty-free). Stems in `assets/audio/stems/`.
- The design truth for colors, type and motion is `frame.md`; the brief is `BRIEF.md`.

Only shipped capabilities are shown (see the repository README). No testimonials, user counts or
customer logos.
