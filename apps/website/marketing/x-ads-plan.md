# X Ads launch plan — Godmode

Ads account: https://ads.x.com/manager/18ce55kuefv/campaigns · Landing page: https://usegodmode.com

Goal: start 7-day free trials of Godmode Pro ($39/month, or $348/year = $29/month) — and sell the 100 Founder
Lifetime licenses ($499 once) — to founders, operators and tech-savvy professionals with budget. Optimise for
**purchases** (a started trial fires Purchase with the plan's value), not clicks. Every campaign starts **paused** until the pixel is verified
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
