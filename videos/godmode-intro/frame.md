# frame.md — Godmode Bot intro (design truth)

Concept angle: the warm, human calm of OpenAI's "dots" film, re-staged in Godmode's own light
"paper" UI — agents are characters on bright panels who report work they already finished,
then the film opens the hood and shows how that work actually happens on your computer.

## Palette — the app's light theme, strict

| Token        | Hex / value                  | Use                                                        |
| ------------ | ---------------------------- | ---------------------------------------------------------- |
| paper        | #faf9f5                      | every scene background (one background, whole film)        |
| paper-2      | #f4f2ed                      | sidebars, secondary panels, deep background vignette tint  |
| sand         | #efebe4                      | chips, inactive fills                                      |
| card         | #ffffff                      | panels, windows, bubbles from agents                       |
| ink          | #1c1c1c                      | headlines, user bubbles, logo tile                         |
| text         | #1a1a1a                      | body                                                       |
| muted        | #6b675f                      | secondary text (darkened from app #75716a for AA on video) |
| line         | rgba(38,32,22,0.12)          | 2px hairlines / window borders                             |
| emerald      | #0eca7b                      | live / active / done states only                           |
| emerald-ink  | #087f4d                      | "Secret hidden" text, check marks, success copy            |
| emerald-soft | rgba(14,202,123,0.12)        | badge fills                                                |
| dream        | #5552c9                      | ONLY the memory / dreaming beat                            |

No dark mode anywhere. No gradients on text. Shadows are warm (rgba(38,32,22,…)), soft and large.
Light canvas texture: faint paper grain + one warm radial "skylight" glow per scene.

## Type

- Display: Instrument Serif (400, roman + italic) — the human voice: scene headlines, 96–160px, tracking -0.02em.
- UI + body: Geist (variable 100–900) — the product voice: app UI, bubbles, labels. Bubbles 38–46px.
- Metadata: Geist Mono — chapter labels ("HOW IT WORKS · 01"), times, domains. 20–24px, tracking 0.14em, uppercase.
- Weight contrast: serif 400 display vs Geist 600 UI titles vs Geist 400 body.

## Components (recreated from apps/desktop, light)

- Window: 22px radius, #fff (sidebar #f4f2ed), 2px line border, shadow `0 50px 100px -40px rgba(38,32,22,.35), 0 2px 8px rgba(38,32,22,.06)`.
- Agent avatar: rounded-square tile (radius 28%), soft tinted fill per agent, emoji glyph centered.
- Agent bubble: #fff card, 28px radius, 2px line, text #1a1a1a. User bubble: ink #1c1c1c, text #faf9f5.
- Step row: 44px icon disc (#f1eee9) + label; done = emerald check. Secret badge: lock + "Secret hidden",
  emerald-ink text on emerald-soft, 2px emerald 35% border, pill.
- Logo: bolt tile (assets/img/logo.svg) — ink tile, paper bolt.

## Motion

- Calm and cinematic: slow drifts (camera 1.5–4% scale over a shot), entrances 0.6–0.9s, `power3.out` /
  `expo.out` for arrivals, `sine.inOut` for ambient, `back.out(1.6)` only for badges/avatars popping.
- Scene handoffs: dip-to-paper (content fades + slight blur/scale out over ~0.5s, next scene rises in).
- Messages arrive with a typing indicator first (3 dots), then the bubble springs up from its avatar.
- Every scene has ambient motion (breathing glow, drifting grain, bobbing avatars).
