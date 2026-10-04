# Godmode Cloud

Godmode Cloud is an optional, self-hosted service for Godmode. It adds:

- **Accounts** with magic-link sign-in (link or 8-digit code by e-mail), invites, roles and permissions, and sessions
  that last a year on as many devices as you like.
- **An admin dashboard** with a first-run setup wizard. Everything except the address is configured there.
- **Billing** with Stripe subscriptions and plans (optional; without Stripe everyone has everything).
- **A relay.** A Godmode that is linked to an account keeps one outbound connection to the cloud. Through it you open
  that computer's full dashboard in any browser (`https://cloud.example.com/d/<computer>/`), and the phone app reaches
  it through the cloud's gateway, without Tailscale and without opening a port.

Godmode works fully without it. A computer talks to a cloud only after someone links it there.

**Trust.** The cloud relays, and can see, everything done through it: it terminates HTTPS, so chats, files and screens
pass through it in the clear. The admin area has no way to open someone else's computer. Whoever operates the cloud
(server, database, sign-in e-mail) is trusted and technically can. Run it on a server you trust, and link only
computers whose owners trust its operator.

The stack is three services in [`docker-compose.yaml`](docker-compose.yaml):

| Service | What |
|---|---|
| `init` | Runs once per deploy: writes a random database password and app secret into the `secrets` volume the first time, then exits. |
| `db` | PostgreSQL 17. All accounts, settings and the audit log. |
| `cloud` | One Node.js process: the custom server (relay, `/api/health`, the dashboard files under `/ui`) and the Next.js app. It applies database migrations at start. |

The only setting is the address. Passwords are generated, and everything else lives in the admin dashboard.

## Requirements

- A Linux server with Docker, managed by [Coolify](https://coolify.io) or used with plain Docker Compose. The image is
  built on that server: give it at least 2 GB of free memory for the build (4 GB is comfortable).
- A DNS name for the cloud (an A or AAAA record pointing at the server).
- HTTPS for real use. Secure cookies, phones (the app only uses an https gateway) and Stripe webhooks need it.

## Deploy on Coolify

1. Point your DNS name (for example `cloud.example.com`) at the Coolify server.
2. In Coolify open your project and environment, then **+ New** → **Public Repository** (or **Private Repository**
   with the GitHub App or a deploy key). Enter the repository URL and the branch.
3. Set **Build Pack** to **Docker Compose**, **Base Directory** to `/apps/cloud` and **Docker Compose Location** to
   `/docker-compose.yaml`. Continue.
4. In **Domains for cloud** enter your address **with `https://`**: `https://cloud.example.com`. The scheme makes
   Coolify request a Let's Encrypt certificate; no port is needed (the file tells Coolify the app listens on 3000).
   Leave **Domains for init** empty. `db` gets no domain field.
5. Under **Environment Variables** you see `DOMAIN`, empty. **Leave it empty**: the cloud takes its address from the
   Domains field (Coolify passes it on as `SERVICE_URL_CLOUD`). If you fill it anyway it wins, and it must be the same
   address. There is nothing else to add: no passwords, no keys.
6. Click **Deploy**. The first build takes several minutes; later ones are faster.
7. Open the **Logs** of the `cloud` container. The setup banner shows the setup address and code (see
   [First start](#first-start-the-setup-code)).
8. In **Servers → your server → Docker Cleanup**, keep **Delete Unused Volumes** off (see [Backups](#backups)).

Until you enter a domain, Coolify shows a generated address (an `sslip.io` name unless the server has a wildcard
domain). An `sslip.io` address is plain HTTP: fine for a first look, not for real sign-ins, phones or Stripe.

The proxy only sends traffic to a healthy container, so right after a deploy the address answers "No available
server" until the app is up (usually well under a minute).

## Plain Docker Compose

```sh
git clone <this repository> godmode && cd godmode/apps/cloud
cp .env.example .env          # set DOMAIN=cloud.example.com
docker compose up -d --build
docker compose logs -f cloud  # the setup banner
```

- `docker-compose.override.yaml` (loaded automatically, ignored by Coolify) publishes port 3000. `PORT=8080` in `.env`
  publishes another host port instead.
- Put an HTTPS reverse proxy in front and send `cloud.example.com` to that port. WebSockets must pass through; Caddy
  (`cloud.example.com { reverse_proxy 127.0.0.1:3000 }`) and Traefik do that without extra settings.
- For a test without HTTPS write the scheme: `DOMAIN=http://192.168.1.20:3000`. A bare name always means https.
- The cloud reads the client address from `X-Forwarded-For` when the request comes from a proxy on a private network
  (Admin → Settings → Security, one proxy by default). With two proxies in a row (for example Cloudflare in front of
  Traefik) set the proxy count to 2. If the app is reachable without any proxy, turn that setting off.

## First start: the setup code

While nobody has an account, every start prints a banner with the setup address and a new setup code. The code is
also in `/data/setup-code.txt`:

```sh
docker compose exec cloud cat /data/setup-code.txt   # plain compose; on Coolify use the container's Terminal or Logs
```

Open `https://cloud.example.com/setup`, enter the code, your e-mail and your name. You are now the owner and signed in.
Whoever enters the code first becomes the owner, so do this right after the first deploy. The wizard then asks for
the cloud's name, e-mail, who may sign in, and Stripe; e-mail and Stripe can be skipped and set later in the admin
area.

**Lost the session during setup** (another browser, cleared cookies)? The code no longer works once it was used.
Open `/login` and enter your e-mail: until e-mail is set up, every sign-in e-mail (link and code) is printed to the
server log instead of sent. Copy the link from the log and setup continues where you left off. Later, when sending a
sign-in e-mail to an owner fails (for example after SMTP credentials changed), that link is printed to the log too.

## E-mail with Amazon SES

Until you set up e-mail the cloud uses the **log transport**: sign-in links, codes and invites are printed to the
server log, and the sign-in page tells people to ask their administrator. That is fine for setup. Anyone who can read
the logs could sign in as anyone, so set up SMTP before you invite people.

1. In the SES console pick a region (for example `eu-central-1`). Under **Verified identities** create an identity for
   your domain (recommended; add the DKIM records it shows) or for one sender address.
2. New SES accounts are in the sandbox and can only send to verified addresses. Request production access.
3. Under **SMTP settings** choose **Create SMTP credentials**. You get an SMTP user name and an SMTP password. These are
   not your IAM access key and secret, and an IAM secret key does not work as an SMTP password. Copy the password
   right away; SES shows it once.
4. In the cloud open **Admin → Settings → E-mail** (or the e-mail step of the setup wizard). Choose the SES preset and
   your region (host `email-smtp.<region>.amazonaws.com`, port 587 with STARTTLS, or 465 with TLS), enter the SMTP user
   name and password, a from address on the verified domain (for example `cloud@example.com`) and a from name.
5. **Test and save** sends a test message to you. The cloud switches to SMTP only after that test went through.

Any other SMTP service works the same way. Failed sends are recorded in the audit log (`mail.failed`, never with the
link or code) and shown in the System card on the admin overview.

## Stripe

Without Stripe, or with billing turned off, every account is "Unlimited". To sell plans:

1. In the Stripe Dashboard open **Developers → API keys → Create restricted key** and give it:
   - **Write**: Customers, Products, Prices, Checkout Sessions, Customer portal, Subscriptions, Webhook Endpoints
   - **Read**: Invoices

   A full secret key (`sk_…`) works too but can do far more than the cloud needs. If the key may not read the account
   details, the cloud checks it by reading products and shows no account name.
2. Paste the key in the billing step of the setup wizard or in **Admin → Settings → Billing**. The cloud shows the
   account, whether the key is test or live, and the account's currency.
3. Edit the plans in **Admin → Billing** and sync them to Stripe: the cloud creates the products and prices. **Set up
   webhook** (Admin → Settings → Billing) creates the endpoint `https://<your address>/api/stripe/webhook` with the
   events it needs and stores its signing secret; there is nothing to copy. In the setup wizard, **Create in Stripe**
   does both. The webhook needs the cloud's https address.
4. Turn billing on when you are ready (**Start charging now** in the wizard, or Admin → Settings → Billing). A preview
   shows who is affected first.

**Test and live.** A `rk_test_…` key uses Stripe's test mode (test card `4242 4242 4242 4242`). To go live, save a live
key, set up the webhook again and sync each plan again: products, prices and the endpoint are then created in live
mode. Test subscriptions do not carry over.

**Sharing a Stripe account** (for example with the website that sells Godmode licences) is safe: everything the cloud
creates carries the metadata `product: godmode_cloud`, webhook events about other subscriptions are acknowledged and
ignored, and the cloud uses its own webhook endpoint and its own customer-portal configuration (never the account's
default), which only offers Godmode Cloud prices. It creates its own Stripe customer for each cloud account.

Tax (automatic tax, tax ID collection, prices with or without tax) is set in Admin → Settings → Billing; automatic tax
also needs Stripe Tax set up in the Stripe Dashboard.

## Linking a Godmode

1. On the computer open Godmode → **Settings → Cloud** and link it to `https://cloud.example.com`.
2. The browser opens the cloud's approve page. Sign in, check that the code matches the one Godmode shows, and approve.
3. Godmode shows "Linked to <your e-mail>". The computer appears under **Computers** in the cloud; **Open** shows its
   full dashboard, live, at `/d/<computer>/`.

The computer dials out (one WebSocket); there is no port to open. What the cloud may do is decided on the computer:
**Browser access**, **Phone access** and **Allow secrets** (unlocking the vault, passwords and keys, backups; off by
default). Unlink on the computer; removing the computer in the cloud revokes its link. The owner can share a computer
with people who have an account (operator or viewer); they use it under the owner's plan.

## Phones through the gateway

Pair the phone with the computer as before (Godmode → Settings → Phone → Connect a phone). When the computer is linked,
its phone access is on and the cloud has an https address, the pairing code also carries the gateway address
`https://cloud.example.com/gw/<computer>`. Phones paired earlier learn it the next time they reach the computer. The
app tries Tailscale first and the gateway after it, and pairing works through the cloud when the computer has no
Tailscale address.

The phone authenticates with its own key, which the cloud passes through to the computer; the cloud has no phone
accounts. Like all relayed traffic it can see what goes through. The gateway can be turned off for the whole cloud in
Admin → Settings → Relay, and plans can leave it out.

## Backups

Coolify does not schedule database backups for a database inside a Docker Compose application (its scheduled backups
cover standalone database resources only). Back up two things, together:

- the database (`pg_dump`), and
- the `secrets` volume: the database password and the app secret, which encrypts the SMTP password and the Stripe keys
  stored in the database. Keep this file as carefully as the dump, and not only on the same server.

Plain compose, from `apps/cloud` (for example from cron):

```sh
docker compose exec -T db pg_dump -U godmode -d godmode -Fc > "godmode-cloud-$(date +%F).dump"
docker compose exec -T db tar -C /run/godmode-secrets -cf - . > "godmode-cloud-secrets-$(date +%F).tar"
```

On Coolify, run the same commands in the server's terminal with `docker exec` against the `db` container. Its name
starts with `db-` followed by the application's UUID; `docker ps` lists it:

```sh
db=$(docker ps --format '{{.Names}}' | grep '^db-<application uuid>')
docker exec "$db" pg_dump -U godmode -d godmode -Fc > "godmode-cloud-$(date +%F).dump"
docker exec "$db" tar -C /run/godmode-secrets -cf - . > "godmode-cloud-secrets-$(date +%F).tar"
```

Restore onto a fresh install (plain compose, from `apps/cloud`, before the first `up`):

```sh
docker compose run --rm --no-deps -T init sh -c 'tar -C /secrets -xf -' < godmode-cloud-secrets-<date>.tar
docker compose up -d db
docker compose exec -T db pg_restore -U godmode -d godmode --clean --if-exists < godmode-cloud-<date>.dump
docker compose up -d
```

On Coolify the volumes are named `<application uuid>_secrets` and `<application uuid>_pgdata`; restore the secrets with
`docker run --rm -i -v <application uuid>_secrets:/secrets busybox:1.37 tar -C /secrets -xf - < <file>.tar` while the
application is stopped, then deploy and run `pg_restore` with `docker exec -i`.

**Never use "Delete Unused Volumes"** (Coolify's server cleanup) or `docker volume prune` on this server. While the
application is stopped its volumes count as unused and would be deleted. Losing `secrets` while `pgdata` survives
means the app can no longer sign in to its own database and the stored SMTP and Stripe secrets cannot be decrypted;
restore the secrets file to fix it.

## Upgrades

- **Coolify:** **Redeploy** (or turn on automatic deployment on push). Coolify builds the new image, then stops the
  old containers and starts the new ones. Compose applications get no zero-downtime deploys: the cloud is unreachable
  until the new container is healthy, usually well under a minute. Linked computers reconnect on their own, open
  dashboards reconnect, and phones retry.
- **Plain compose:** `git pull && docker compose up -d --build`.
- Database migrations run at start. They only move forward; to go back, restore a backup taken before the upgrade.
- **Redeploy the cloud with every Godmode release.** The cloud serves the dashboard of its own version to every linked
  computer. A computer that runs a different version shows a notice in the dashboard.
- Run one `cloud` container per database. The relay keeps the computers' links in memory, so several replicas would
  not see each other's computers.

## Limits

- **Uploads longer than 60 seconds.** Coolify's Traefik ends any request whose body takes longer than 60 seconds to
  arrive. Large uploads to a computer through the cloud on a slow connection fail; downloads, live views and
  WebSockets are not affected. To raise it, add this to the proxy's command under **Servers → your server → Proxy** and
  restart the proxy:

  ```yaml
  - '--entrypoints.https.transport.respondingTimeouts.readTimeout=10m'
  ```

  The cloud's own limit for request bodies is in Admin → Settings → Relay (64 MB by default); a computer accepts at
  most 256 MB through its link.
- Deploys interrupt open connections (see [Upgrades](#upgrades)).
- The image is built on the deployment server, which needs the memory for it.

## Release step: the default cloud address

`CLOUD_DEFAULT_URL` in [`packages/shared/src/cloud.ts`](../../packages/shared/src/cloud.ts) is empty in this
repository, so Godmode's link dialog asks for the address. Once your cloud is live, set it to the cloud's https
address and ship the next Godmode release: the dialog then offers it directly ("Use a different cloud" for others).
On a single computer, the environment variable `GODMODE_CLOUD_URL` overrides it.

## Legal work before you sell it

This repository does not contain it; the owner has to write and publish:

- **Terms for the hosted service.** What Godmode Cloud is, availability, acceptable use, suspension, liability, how
  subscriptions renew and end (cancellation at the end of the period through the billing portal), and a data
  processing agreement (Art. 28 GDPR) for business customers, because the cloud processes their data on their behalf.
  The licence and the website's terms cover the software, not a hosted service. Link the terms in Admin → Settings →
  General; Admin → Settings → Billing can require people to accept them at checkout.
- **Refund wording** for cloud subscriptions. The website promises refunds for licences; decide what applies to cloud
  plans and say it in the terms and on the site.
- **The privacy policy.** It currently says the apps send nothing to us unless Godmode is linked to Godmode Cloud. A
  cloud you operate needs its own section: accounts and sign-in e-mails, sessions (IP address, browser), the audit
  log, relayed traffic (passes through and is visible to the operator; only daily usage counters are stored), Stripe
  for cloud billing, the e-mail provider (Amazon SES), the hosting provider and retention periods. Link it in Admin →
  Settings → General so it appears in the footer and in every e-mail, together with the imprint and a support address.

## Development

```sh
createdb godmode_cloud_dev && createdb godmode_cloud_test
pnpm --filter @godmode/desktop build:cloud   # the dashboard build the cloud serves under /ui
pnpm --filter @godmode/cloud dev             # custom server + Next in development mode
pnpm --filter @godmode/cloud typecheck       # next typegen + tsc
pnpm --filter @godmode/cloud test            # vitest against postgres://localhost:5432/godmode_cloud_test
```

`apps/cloud/.env.local` (not committed) holds local overrides such as `PORT=3210` and `DATABASE_URL`; open the site as
`http://localhost:<port>`. Production is `pnpm --filter @godmode/cloud build` (`next build` and the custom server
bundle `dist/server.mjs`) and `node dist/server.mjs`.

The image ([`Dockerfile`](Dockerfile), built from the repository root with its own
[`Dockerfile.dockerignore`](Dockerfile.dockerignore)) keeps the workspace layout: production dependencies in
`/repo/node_modules`, the app in `/repo/apps/cloud` and the dashboard build in `/repo/apps/cloud/godmode-ui`. Next's
server output reaches packages such as `pg` through relative links into `/repo/node_modules/.pnpm`; the image build
fails if one of them does not resolve.
