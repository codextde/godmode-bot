<div align="center">

<img src="docs/assets/logo.svg" width="112" height="112" alt="Godmode Bot logo" />

# Godmode Bot

### An AI teammate you can trust to get work done.

Godmode Bot gives Claude a real browser, your logins and your 2FA codes — **safely** — so it can finish tasks
end-to-end without interrupting you. Start with one chat, or build a team of persistent agents with their own
memory, routines and history.

[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cf6.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-06b6d4.svg)](#-install)
[![Built with Claude Code](https://img.shields.io/badge/brain-Claude%20Code%20·%20Opus%205.5-d97757.svg)](https://code.claude.com)
[![browser-use](https://img.shields.io/badge/browser-browser--use-111.svg)](https://github.com/browser-use/browser-use)
[![Tauri 2](https://img.shields.io/badge/desktop-Tauri%202-ffc131.svg)](https://tauri.app)

[**Download**](https://github.com/codextde/godmode-bot/releases/latest) ·
[**Quick start**](#-quick-start) ·
[**Features**](#-features) ·
[**Security**](#-security) ·
[**Architecture**](docs/ARCHITECTURE.md)

<br />

<img src="docs/screenshots/chat.png" alt="Godmode logging into a portal with a password and 2FA code from the vault — never shown to the AI — next to a live preview of its browser" width="100%" />

<sub>Godmode logs into a portal: the password and the 2FA code are filled from the vault — the AI never sees them. The live browser preview on the right shows where it is; <b>Take control</b> jumps in anytime.</sub>

</div>

---

## ✨ Why Godmode?

Most AI assistants stop the moment they hit a login screen. Godmode Bot is built around the things a real coworker
needs to be useful:

- **Access** — a managed browser (via [browser-use](https://github.com/browser-use/browser-use)), your Chrome sessions,
  and hundreds of apps through [Composio](https://composio.dev) or any MCP server.
- **Credentials without exposure** — a local, encrypted vault for logins and TOTP 2FA. Passwords and codes are typed
  into the page *for* the agent; the model never sees them.
- **Autonomy** — powered by [Claude Code](https://code.claude.com) (Opus 5.5) in full-bypass mode, so work continues
  without permission prompts.
- **Continuity** — every agent has its own git repository with memory, conversations, logs and state.
- **Judgement** — when a login is missing or broken, agents tell you exactly what they need instead of stalling.

## 🚀 Features

| | |
|---|---|
| 💬 **Chat first** | Start with one conversation with *Godmode*, your main AI coworker. It can answer, act, and create other agents for you. |
| 🤖 **Persistent agents** | Bots with their own instructions, conversations, memory (`MEMORY.md`), routines and history — each in its own git repo. |
| 🌙 **Dreaming** | While you're away, agents review their recent conversations and rewrite their memory: they pick up what they learned (even if nobody said "remember this"), merge duplicates, fix contradictions and update dates ("is going to Singapore in July" → "went to Singapore in July"). Memory loads into every new chat; every dream can be reviewed as a diff and undone. |
| 📁 **Working folders** | Optionally point a chat or an agent at any folder on your machine — it works on the files there and keeps its memory in its own repo. |
| ⚡ **Automations** | Work starts when it happens: on a schedule (“weekdays at 08:00”), when something happens in a connected app (a new email, a Slack message, a calendar event, a Notion update), when a condition you describe comes true (“competitor pricing changes”), or when a webhook is called. Describe it in one sentence and Godmode sets it up. |
| 🤝 **Delegation** | Agents hand tasks to peer agents or spawn short-lived subagents. The Godmode agent can list, check, create and configure all agents. |
| ⌨️ **Slash commands** | Type `/` for every Claude Code command — `/compact`, `/model`, `/effort`, `/clear`… — with argument hints and tab completion. |
| 🌐 **Real browser** | browser-use drives a managed Chromium over CDP. Watch it live right next to the chat and *take control* for CAPTCHAs. |
| 🥷 **Bot-detection hardening** | Sites that block automated browsers see a normal Chrome: no `navigator.webdriver`, and even a headless browser has the user agent and screen of a regular Chrome window. *Run check* (Settings → Browser) shows what bot detection sees, signal by signal. |
| 🖥️ **Computer use** | Share a single window, a display, the entire desktop (every monitor) or a browser tab with an agent — like sharing your screen with ChatGPT. A shared window is controlled **in the background** with [Cua Driver](https://github.com/trycua/cua): your mouse and keyboard stay yours. Watch live and take over anytime. |
| 💻 **macOS VMs** | Give an agent its own Mac: spin up isolated macOS virtual machines (Apple's Virtualization framework, via [Tart](https://tart.run)) with one click and assign them to an agent, a chat or a workspace. The agent works *entirely inside the VM* — commands, files, apps (computer use with Cua Driver) and the web (Google Chrome with browser-use) — and no browser opens on your Mac. Watch the VM's screen next to the chat and take control anytime. Allow it once and agents sign in inside the VM too: Godmode fills your saved logins and 2FA codes for them (best effort — the agent controls the VM, so it's closer to reveal than to fill-only). VMs live on your Mac, keep everything between tasks, suspend when you quit, and can be reset to a clean macOS or duplicated in seconds. |
| 🍪 **Chrome session import** | Continue where Chrome left off — import cookies from your Chrome/Edge/Brave profile (profile-use technique), or sync via browser-use `profile-use`. |
| 🔐 **Vault** | Logins with password generator, per-workspace or global, AES-256-GCM encrypted, fully audited. |
| 📥 **Password import** | Bring logins over from Chrome (and Edge, Brave, Arc), 1Password (.1pux or CSV), Bitwarden, Apple Passwords, Firefox and more — with a preview that updates saved logins instead of duplicating them. |
| 🔢 **2FA / TOTP** | Import Google Authenticator QR codes from screenshots — including multi-account *export* QR codes — or scan with your camera. |
| 📬 **Missing-login inbox** | Agents report missing or broken logins, accounts and 2FA; add them in one click. |
| 🧩 **Integrations** | Composio toolkits (Gmail, Slack, GitHub, Notion…) and custom MCP servers — globally, per workspace, or per agent. |
| 💬 **Messaging** | Talk to your agents from **Slack**, **Telegram** and **Microsoft Teams**. Connect a bot, pick which agents it reaches, and approve who may use it; `/agent`, `/new` and `/stop` work right in the chat, and every chat is also a Godmode conversation. |
| 🗂️ **Workspaces** | Separate clients/projects with their own agents, logins, 2FA, integrations and browser profile, plus shared global ones. Assign any browser profile to a workspace (Browser → profile menu, or in the workspace's settings) and its agents browse with it. |
| 🧬 **Workspace folders & repos** | Attach project folders and git repositories to a workspace — paste `https://github.com/you/app` and Godmode clones it with your git sign-in, keeps it up to date and hands it to every agent in the workspace. |
| 🎙️ **Voice mode** | Dictate and hear replies; hands-free conversation loop (Web Speech, OpenAI or ElevenLabs). |
| 💾 **Backup & restore** | Encrypted `.godmode-backup` archives of your whole setup, including agent repositories. |
| 🩺 **Diagnostic log** | Errors, slow spots and how every run went, with secrets masked. Settings → Logs groups recurring problems and copies an AI-ready report — paste it into Claude to find bugs and speed things up. |
| 🖥️ **Desktop + dashboard** | Native app for macOS, Windows and Linux — or run headless on any device and use the web dashboard. |

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/home.png" alt="Home — start a chat with your AI coworker" /><br /><sub><b>Chat first</b> — hand over a task, pick up where you left off</sub></td>
    <td width="50%"><img src="docs/screenshots/agents.png" alt="Agents" /><br /><sub><b>Agents</b> — persistent coworkers with memory, schedules and tools</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agent-detail.png" alt="Agent detail with routines and memory" /><br /><sub><b>Agent detail</b> — runs, routines, memory (git), history, settings</sub></td>
    <td><img src="docs/screenshots/agent-new.png" alt="Create an agent by describing it" /><br /><sub><b>New agent</b> — describe it in plain words or start from a template</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/routines.png" alt="Routines on a schedule" /><br /><sub><b>Routines</b> — everything your agents do on a schedule, at a glance</sub></td>
    <td><img src="docs/screenshots/folder.png" alt="Pick a working folder for a chat" /><br /><sub><b>Working folders</b> — point a chat or an agent at any folder on your machine</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/commands.png" alt="Claude Code slash commands in the composer" /><br /><sub><b>Slash commands</b> — every Claude Code command, right in the composer</sub></td>
    <td><img src="docs/screenshots/browser.png" alt="Managed browser with live view" /><br /><sub><b>Browser</b> — live view of the agent's Chromium, take over anytime</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/logins.png" alt="Vault logins" /><br /><sub><b>Logins</b> — encrypted, scoped per workspace, filled for agents</sub></td>
    <td><img src="docs/screenshots/vault-2fa.png" alt="2FA codes with QR import" /><br /><sub><b>2FA codes</b> — import Google Authenticator QR screenshots</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/password-import.png" alt="Import passwords from Chrome, 1Password or another password manager" /><br /><sub><b>Password import</b> — Chrome, 1Password, Bitwarden, Apple Passwords and more</sub></td>
    <td><img src="docs/screenshots/password-import-review.png" alt="Review which logins an import adds or updates" /><br /><sub><b>Import review</b> — new, updated and already saved logins at a glance</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/integrations.png" alt="Custom MCP servers and Composio integrations" /><br /><sub><b>Integrations</b> — custom MCP servers and Composio toolkits, scoped per workspace</sub></td>
    <td><img src="docs/screenshots/inbox.png" alt="Missing-login inbox" /><br /><sub><b>Inbox</b> — agents report missing or broken logins</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity.png" alt="Activity across agents" /><br /><sub><b>Activity</b> — every run, its cost, duration and result</sub></td>
    <td><img src="docs/screenshots/settings.png" alt="Security settings" /><br /><sub><b>Security</b> — fill-only secrets, device keychain and auto-lock</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/workspace-sources.png" alt="Folders and git repositories attached to a workspace" /><br /><sub><b>Workspace folders & repos</b> — every agent in the workspace works with them</sub></td>
    <td><img src="docs/screenshots/workspace-add-repo.png" alt="Add a git repository to a workspace" /><br /><sub><b>Add a repository</b> — paste a URL, Godmode clones it and keeps it up to date</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/messaging.png" alt="Slack, Telegram and Teams bots connected to agents" /><br /><sub><b>Messaging</b> — talk to agents from Slack, Telegram and Microsoft Teams</sub></td>
    <td><img src="docs/screenshots/messaging-bot.png" alt="A bot's access requests, agents and who may use it" /><br /><sub><b>Bot settings</b> — approve people, pick agents, see every chat</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/bot-check.png" alt="Bot check of a hardened headless browser: 9 of 10 checks pass" /><br /><sub><b>Bot check</b> — what bot detection sees in the agents' browser</sub></td>
    <td><img src="docs/screenshots/bot-check-off.png" alt="Bot check without hardening: the headless user agent and screen give the browser away" /><br /><sub><b>Without hardening</b> — headless Chrome gives itself away</sub></td>
  </tr>
</table>

## 📦 Install

### Desktop app

Download the latest release for your platform from
[**Releases**](https://github.com/codextde/godmode-bot/releases/latest):

- **macOS** — `.dmg` (Apple Silicon & Intel)
- **Windows** — `.msi` / `.exe`
- **Linux** — `.AppImage` / `.deb` / `.rpm`

The app keeps itself up to date: new versions download in the background, and a **Restart** button appears in the
sidebar once one is ready.

On first launch the onboarding checks your system and installs what's missing with one click:

| Dependency | Why | Install |
|---|---|---|
| [Claude Code CLI](https://code.claude.com) | The agent brain | one click (official installer) — then sign in once with `claude` or add an Anthropic API key |
| [uv](https://docs.astral.sh/uv/) | Runs browser-use (`uvx`) | one click |
| Chrome / Chromium | The managed browser | uses your installed Chrome, or installs Chromium |

### Headless server + web dashboard

Run Godmode on a home server, NAS, VM or Raspberry Pi and connect from any browser:

```bash
curl -fsSL https://raw.githubusercontent.com/codextde/godmode-bot/main/scripts/install.sh | sh
godmode serve --host 0.0.0.0     # prints the dashboard URL
godmode token                    # access token for the first login
godmode password 'a-strong-password'
```

Or with Docker:

```bash
docker compose up -d   # dashboard on http://localhost:7777
```

> Put the dashboard behind TLS (Caddy, Traefik, Tailscale…) when you expose it beyond your machine.

## ⚡ Quick start

1. **Onboarding** — pick a vault passphrase (enable *Remember on this device* so routines run unattended).
2. **Add access** — import your Chrome sessions, import or add logins in **Vault → Logins**, and import 2FA QR codes in
   **Vault → 2FA Codes** (Google Authenticator → *Transfer accounts* → *Export* → screenshot).
3. **Chat** — ask Godmode anything: *“Log into our billing portal and download September's invoice.”*
4. **Create agents** — *“Create an agent that checks our competitors' pricing every Monday and sends me a summary.”*
   Godmode creates the agent, its instructions and its automation.
5. **Automate** — *“When I get an email with an invoice, save the PDF to Drive and log it in my sheet.”* Godmode picks the
   trigger (here: a new Gmail message via Composio), the agent and the steps, and it runs whenever it happens.
6. **Check the inbox** — if an agent couldn't log in, it tells you what's missing.

### Computer use — share a window or your screen

Click **Share** (the screen icon) in the message box and pick what the agent may see and control in this chat:

| Share | How the agent works |
|---|---|
| **A window** | Only that app window, **in the background**: clicks, typing and scrolling go straight to the window's process (accessibility-first via [Cua Driver](https://github.com/trycua/cua)), so your cursor and focus stay where they are — even when the window is covered. |
| **A display / the entire desktop** | The real mouse and keyboard, across every monitor (the agent picks a display per screenshot). |
| **A browser tab** | One tab of Godmode's browser, over CDP, in the background. |

The chat shows a live view of what's shared; **Take control** lets you click and type into it yourself (a window keeps
running in the background). **Stop sharing** takes effect immediately, even mid-run. Agents can also get unattended
desktop access for routines (agent settings → *Computer*). Setup lives in **Settings → Computer**:

- **macOS** asks once for *Accessibility* and *Screen Recording* for Godmode (restart Godmode after granting).
- **Cua Driver** (`cua-driver` from PyPI, MIT) is downloaded with one click via uv. Without it, Godmode's built-in
  macOS helper controls windows on its own.
- **Windows / Linux**: single windows need Cua Driver; the whole desktop uses a built-in PowerShell helper (Windows) or
  `xrandr` + ImageMagick + `xdotool` (Linux/X11), and falls back to Cua Driver's primary display.

### Virtual machines — give an agent its own Mac

Open **Virtual machines** in the sidebar and click **New VM** (first time: **Set up** downloads Godmode's own copy of
[Tart](https://tart.run) — no Homebrew needed). Pick an image — *macOS Tahoe* is a ~27 GB download once (in parallel,
resumable; Settings → Virtual machines lists downloaded images); every further VM from it is ready in seconds — and
assign the VM to an **agent** (agent settings → *Virtual machine*), a **chat**
(the *VM* chip in the message box) or a **workspace**. A run works in its chat's VM, else its agent's, else its
workspace's, and boots it when needed. You can also just ask Godmode: *"Give the iOS agent its own Mac."*

| | |
|---|---|
| **What the agent gets** | A `vm` tool set: `shell` (zsh as `admin`, passwordless sudo, Homebrew), `read_file` / `write_file` / `edit_file`, and `screen` — screenshots, clicks and typing on the VM's display. Plus Godmode's agent *inside* the VM: **Google Chrome with browser-use** for the web and **Cua Driver** for apps and windows. They're installed into the VM the first time an agent needs them (a few minutes, once per VM); no browser, app or shell of these runs opens on your Mac. Claude Code's own Bash tool is turned off for these runs and its file tools only reach the agent's own folders (Settings → Virtual machines → *Keep agents with a VM off this Mac*). |
| **Moving files** | Every VM has a shared folder: `~/Godmode` in the VM is `~/.godmode/vm/shared/<vm>` on your Mac (**Shared folder** opens it in Finder). |
| **Watching & taking over** | A chat that works in a VM shows the VM's screen next to the conversation (full size with one click); **Take control** and the VM card's **Screen** open it in Screen Sharing, **Terminal** opens an SSH session (a firewall in each VM lets only your Mac in). |
| **Keeping & recreating** | Disks are stored under `~/.godmode/vm` and keep everything (installed tools, repos, logins) between tasks and restarts. When Godmode quits, running VMs are suspended and resume where they left off. **Reset** recreates a clean macOS from the image (shared folder and assignments stay), **Duplicate** copies a VM with its whole disk. |

Needs a Mac with Apple silicon. macOS allows **two** macOS VMs to run at the same time; Godmode tells you which one to
stop when a third is needed.

### Good to know

- **macOS — Chrome session import** reads your Chrome profile, which macOS protects: grant Godmode
  *Full Disk Access* (System Settings → Privacy & Security) and retry. Nothing is uploaded — cookies go straight
  into Godmode's own browser profile.
- **browser-use content extraction** (`browser_extract_content`) needs an OpenAI API key (Settings → Integrations →
  API keys). Without one, Godmode hides that tool and agents read pages via page state and screenshots instead.
- **Unsigned builds**: until code signing is configured for releases, macOS may ask you to confirm opening the app
  (right-click → Open) and Windows SmartScreen may warn on first launch.
- **Claude Code sign-in**: agents use your Claude Code login (`claude` → `/login`) or an Anthropic API key stored
  in the vault.

## 🧠 How it works

```
┌──────────── Godmode desktop app (Tauri 2) / web dashboard ────────────┐
│  React 19 · Tailwind v4 · shadcn/ui · aicss components                 │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (token / session)
┌───────────────▼────────────────────────────────────────────────────────┐
│  godmode core (Bun)                                                    │
│  runner · vault · scheduler · agents (git) · MCP gateway · browser ·  │
│  computer use (Cua Driver · native helper)                             │
└───────┬──────────────────────────────┬─────────────────────────────────┘
        │ spawns per turn               │ launches + CDP
┌───────▼──────────────────────┐   ┌────▼─────────────┐
│ claude -p (Opus 5.5, bypass) │   │ managed Chromium │◄── browser-use MCP
│  MCP: godmode · browser ·    │   └──────────────────┘
│   computer · composio · …    │
└──────────────────────────────┘
```

- Each turn runs `claude -p --output-format stream-json` inside the agent's git repository and streams every
  thought, tool call and screenshot to the UI in real time.
- The **Godmode MCP gateway** gives agents vault tools (`vault_fill_login`, `vault_fill_totp`, …), delegation
  (`agent_delegate`), management tools for the main agent, and `report_missing_login`.
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Agent repositories

```
~/.godmode/agents/invoice-collector/
├── CLAUDE.md                 # identity & instructions (generated)
├── MEMORY.md                 # long-term memory the agent maintains
├── memory/                   # notes
├── conversations/<id>.md     # transcripts
├── runs/2026-09-27/<id>.jsonl# raw event logs (secrets redacted)
├── state/agent.json          # config snapshot
└── workspace/                # files the agent produced
```

Every run is committed, so you can see exactly what an agent learned and did — and roll back.

## 🔒 Security

- **Envelope encryption**: scrypt (N=2^17) → key-encryption key → random 256-bit data key → AES-256-GCM per secret,
  bound to its database row.
- **Fill, don't reveal** (default): agents ask Godmode to type a password/2FA code into the page via CDP; the value
  never enters the model's context. *Reveal* mode is opt-in per agent and audited.
- **Site-bound fills**: a login is only ever typed into its own website (https, real password fields) — a phishing or
  prompt-injected lookalike page gets nothing.
- **Re-auth for sensitive actions**: revealing a password or granting an agent reveal access needs your vault passphrase.
- **Redaction** of known secrets in transcripts, logs and the UI · **audit log** of every secret access.
- **Local-first**: API on `127.0.0.1`, per-run MCP tokens, DNS-rebinding & CSRF protection, strict CSP,
  rate-limited logins, HttpOnly/SameSite cookies for the dashboard.
- **Remember this device** keeps the data key in the OS keychain so routines run unattended — disable it to require
  your passphrase after every restart.

> ⚠️ Agents run Claude Code with **bypass permissions** by default. Treat them like a trusted coworker with access to
> your machine; for sensitive work give the agent its own **macOS VM** (see above), or run Godmode in a VM or
> container. See [SECURITY.md](SECURITY.md).

## 🛠️ Development

```bash
pnpm install
pnpm dev          # core (bun --watch, :7777) + UI (vite, :1420)
pnpm dev:app      # full desktop app (tauri dev)
pnpm typecheck && pnpm test
pnpm build:app    # desktop bundles
```

Monorepo: `packages/shared` (types) · `packages/core` (daemon) · `apps/desktop` (UI + Tauri).
See [CONTRIBUTING.md](CONTRIBUTING.md).

## 🗺️ Roadmap

- [x] Chat, persistent agents, routines, delegation, subagents
- [x] Vault (logins with Chrome / 1Password import + TOTP with QR import), Chrome session import, missing-login inbox
- [x] Composio + custom MCP servers, workspaces, voice mode, backup/restore
- [x] Desktop app (macOS/Windows/Linux) + headless web dashboard
- [x] Working folders, Claude Code slash commands, live browser preview in chat, desktop auto-update
- [x] Computer use: share a window (background control via Cua Driver), a display, every monitor or a browser tab
- [x] Automations: schedules, app events (Composio triggers), plain-language conditions and webhooks
- [x] Agents working in a dedicated macOS VM (Tart / Virtualization.framework): shell, files and screen, assigned per agent, chat or workspace
- [ ] Windows / Linux VMs
- [ ] Mobile companion app & push notifications
- [ ] Team mode: shared workspaces and approvals

## 🙏 Credits

[Claude Code](https://code.claude.com) · [browser-use](https://github.com/browser-use/browser-use) · [Cua](https://github.com/trycua/cua) ·
[Composio](https://composio.dev) · [Model Context Protocol](https://modelcontextprotocol.io) ·
[Tauri](https://tauri.app) · [shadcn/ui](https://ui.shadcn.com) · [aicss](https://www.aicss.dev) ·
[claude-mem](https://github.com/thedotmack/claude-mem) · [Tart](https://tart.run) · [Bun](https://bun.sh)

## 📄 License

[MIT](LICENSE) © 2026 Codext GmbH and contributors.
