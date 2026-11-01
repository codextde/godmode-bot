# Ads plan: Godmode (download-first, since 2026-11-01)

> Every paid ad is paused since 2026-10-10 (EUR ~500 on X, no sale). A new paid test needs Daniel's explicit OK (network,
> hard total cap, kill rule, why it pays back). Organic posts use the same copy. Old card-trial plan below for reference.

## What changed

- The ad no longer sells a card trial. It sells a **free download**: "Godmode for Mac, free for 14 days, no card, no
  sign-up." The app shows the price when the free days end, together with what Godmode already did for the user.
- Landing page: https://usegodmode.com (hero = big "Download for Mac, free" button) or /download for retargeting.
  UTMs on every link: `utm_source=<network>&utm_medium=paid&utm_campaign=dl_<angle>`.
- Conversion event: the download click (`download_mac*` in /api/track and the pixel's Lead/Download event), then
  activation (first_seen in /admin) and paid. Target: cost per download <= $8, download -> paid >= 5% = <= $160 per
  paying customer (payback 4-6 months at $39). Kill an ad after $40 with no download, kill the test after the cap.
- Audience: Mac users who do office work: small-business owners, office and admin staff, assistants, marketers,
  e-commerce sellers, bookkeepers, agencies. Desktop placements first (people download on a Mac), phones only with the
  "send it to my computer" landing.

## Ad copy (download-first)

1. **Stop doing work a computer can do.** Tell Godmode the task in plain words. It opens your browser, signs in, clicks
   through and finishes the job. Free for 14 days on your Mac. No card. [Download free]
2. **ChatGPT tells you how. Godmode does it.** Invoices downloaded and filed, emails answered, the spreadsheet
   updated. Your AI coworker on your Mac. Free for 14 days, no card. [Download for Mac]
3. **Monday's busywork, done before you're up.** "Every Monday at 7, collect last week's invoices and send me the
   totals." That's the whole setup. Free for 14 days. [Try it free]
4. **It logged into 6 supplier portals and filed 23 invoices. I was making coffee.** Godmode, the AI coworker for
   everyone at a computer. Mac, free for 14 days. [Download free]
5. **The coworker who does the copy-paste.** No coding, no IT project. It asks before sending, paying or deleting.
   Free for 14 days, no card. [Download for Mac]

Visuals: real screen recordings (hero.mp4, UGC Studio clips with Maya), the light website hero, before/after cards
("You write" / "You get back"). No dark terminal screenshots, no model names as the hook, no "AI generated" label.

---

# Old plan (card trial, retired 2026-11-01)

Ads account: https://ads.x.com/manager/18ce55kuefv/campaigns · Landing page: https://usegodmode.com

Goal: start 7-day free trials of Godmode Pro ($39/month, or $348/year = $29/month) with founders, operators and
tech-savvy professionals with budget. Optimise for **purchases** (a started trial fires Purchase with value 0; X
optimises on the event count), not clicks. Every campaign starts **paused** until the pixel is verified
and the daily budget is confirmed.

## 1. Tracking (do this first)

1. Ads Manager → Tools → **Events manager** → *Add event source* → X Pixel (install "manually").
   Copy the pixel ID (looks like `o8z3j`).
2. Create four website events on that pixel (Event type in brackets), and copy each event ID (`tw-o8z3j-o8z3k`):
   | Event | Type | Fired when | Env var |
   |---|---|---|---|
   | Purchase | Purchase | success page after a completed checkout or started trial (value + currency + conversion_id) | `PUBLIC_X_EVENT_PURCHASE` |
   | Checkout initiated | Checkout initiated | any "Start free trial" / checkout button | `PUBLIC_X_EVENT_CHECKOUT` |
   | Lead | Lead | playbook email signup | `PUBLIC_X_EVENT_LEAD` |
   | Pricing viewed | Content view | pricing section scrolled into view | `PUBLIC_X_EVENT_PRICING` |
3. Put them in `apps/website/.env` (see `.env.example`), rebuild and deploy (`pnpm --filter @godmode/website deploy`).
4. Accept cookies on the live site, click a checkout button and confirm the events show "Active" in Events manager.
   (The pixel only loads after the visitor clicks **Accept** — GDPR.)
5. Audiences → create **Website visitors (30 days)** and **Purchasers (180 days)** from the pixel.

Attribution is also captured first-party: every ad URL carries UTMs, X appends `twclid`, and both are stored on
the Stripe session and shown per campaign at https://usegodmode.com/admin (sources table).

## 2. Campaign structure

| Campaign | Objective | Daily budget (suggested) | Bid | Status |
|---|---|---|---|---|
| **GM · Prospecting · Conversions** | Website conversions → Purchase | $60 | Autobid | paused |
| **GM · Retargeting · Conversions** | Website conversions → Purchase | $15 | Autobid | paused |
| **GM · Video · Awareness** | Video views (15s) | $25 | Autobid | paused |

Total ~$100/day. Scale the ad group with the lowest cost per purchase by ~20% every 3 days; kill ad groups
with 2× target CPA and no purchase after ~$300 spend. Target CPA to aim for: ≤ $60 per started trial (watch
trial → paid in /admin; at ~50% conversion that is ≤ $120 per paying customer).

### Shared targeting

- **Locations:** United States, United Kingdom, Canada, Australia, Germany, Switzerland, Austria, Netherlands,
  Sweden, Denmark, Norway, Singapore, United Arab Emirates
- **Languages:** English (+ German for DE/AT/CH)
- **Age:** 25–54 · **Platforms:** Desktop + iOS + Android (most clicks come from phones; the trial starts there with
  Apple Pay / Google Pay, and the welcome page sends the download link to the buyer's computer)
- **Exclude:** Purchasers audience

### Prospecting ad groups (one campaign, three ad groups)

1. **Keywords — AI agents & automation**
   `claude code`, `claude opus`, `anthropic`, `openclaw`, `hermes agent`, `grok bot`, `chatgpt agent`, `chatgpt dots`,
   `computer use`, `browser use`, `ai agent`, `ai agents`, `ai employee`, `ai assistant`, `automate`, `automation`,
   `zapier`, `n8n`, `make.com`, `rpa`, `virtual assistant`, `delegate`, `mcp server`
2. **Follower look-alikes — AI builders & founders**
   @AnthropicAI, @claudeai, @OpenAI, @xai, @NousResearch, @openclaw, @levelsio, @swyx, @karpathy, @zapier,
   @n8n_io, @ycombinator, @paulg, @naval, @shl
3. **Interests / conversation topics**
   Startups, Entrepreneurship, Small business, Business software, Technology, Artificial intelligence,
   Productivity, SaaS

### Retargeting

Audience: Website visitors (30 days) minus Purchasers. Creative: `ad-vault-1x1` + the objection-busting copy
(#6, #7 below). Frequency cap: 3 / week.

### Awareness

Audience: prospecting ad group 2 (look-alikes). Creative: `ad-main-16x9` (and the long intro film if you want a
second video). This builds the retargeting pool cheaply.

## 3. Creatives

Rendered in `apps/website/public/media/` (sources in `apps/website/video/`):

| File | Format | Use |
|---|---|---|
| `ad-main-16x9.mp4` | 1920×1080, ~18s | Prospecting + awareness |
| `ad-main-1x1.mp4` | 1080×1080, ~18s | Prospecting (feed) |
| `ad-vault-1x1.mp4` | 1080×1080, ~11s | Retargeting, security angle |
| `ad-vm-9x16.mp4` | 1080×1920, ~14s | Prospecting on mobile |
| `*.jpg` | thumbnails | Video posters / image ads |

Card: **Website card**, headline ≤ 70 chars, CTA "Get it" / "Learn more".

## 4. Ad copy (post text)

Every destination URL: `https://usegodmode.com/?utm_source=x&utm_medium=paid&utm_campaign={campaign}&utm_content={ad}`

1. **Founder story** (`utm_content=founder`)
   > I automated my company with one app.
   > It opens my browser, signs in with my passwords and 2FA, and does the work — in the background, on my Mac.
   > Powered by Claude Opus 5.5. Try it free for 7 days.
   Card headline: *Your next hire isn’t human.*
2. **Hire** (`utm_content=hire`)
   > Your next hire isn’t human.
   > Godmode is an AI coworker that uses your computer like you do. No integrations. No workflows. Just tell it what you need.
   Card headline: *The AI that actually logs in and gets it done*
3. **Login screen** (`utm_content=login`)
   > Most AI stops at the login screen.
   > Godmode signs in with your saved logins and 2FA codes — and finishes the job while you do something else.
   Card headline: *AI that gets past the login screen*
4. **Own Mac** (`utm_content=vm`, pair with `ad-vm-9x16`)
   > An AI with its own Mac.
   > Godmode spins up a macOS VM on your device and does the work in there. Your Mac stays untouched.
   Card headline: *Give your AI its own Mac*
5. **Your machine** (`utm_content=local`)
   > Cloud agents run in someone else’s browser.
   > Godmode runs in yours — with your sessions, your logins, your apps. On your device.
   Card headline: *Everything cloud agents do. On a machine you own.*
6. **Vault** (`utm_content=vault`, retargeting, pair with `ad-vault-1x1`)
   > Give AI your logins. It never sees them.
   > Godmode types passwords and 2FA codes into the page for the agent. Encrypted on your device.
   Card headline: *Fill, don’t reveal.*
7. **Math** (`utm_content=math`, retargeting)
   > A full-time assistant: $76,590 a year (US median).
   > Godmode: $29 a month. Works nights and weekends. Try it free for 7 days.
   Card headline: *7 days free. Then $29/mo, billed yearly.*

Keep claims to what the product does; no invented customer numbers or testimonials.

## 5. Weekly routine

- Monday: check /admin → Sources & campaigns (visitors → checkouts → orders per `utm_campaign`/`utm_content`).
- Compare with X Ads’ conversion columns (Purchase, Checkout initiated). Pause ads with CTR < 0.5% after 5k
  impressions; move budget to the best `utm_content`.
- Refresh creatives every ~2 weeks (new hook in the first 1.5 s).
