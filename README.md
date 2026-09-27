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

<img src="docs/screenshots/chat.png" alt="Godmode Bot — chatting with the main agent while it works in the browser" width="100%" />

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
| ⏰ **Routines** | Cron schedules with a friendly builder: “weekdays at 08:00”, “1st of every month”… |
| 🤝 **Delegation** | Agents hand tasks to peer agents or spawn short-lived subagents. The Godmode agent can list, check, create and configure all agents. |
| 🌐 **Real browser** | browser-use drives a managed Chromium over CDP. Watch it live and *take over* for CAPTCHAs. |
| 🍪 **Chrome session import** | Continue where Chrome left off — import cookies from your Chrome/Edge/Brave profile (profile-use technique), or sync via browser-use `profile-use`. |
| 🔐 **Vault** | Logins with password generator, per-workspace or global, AES-256-GCM encrypted, fully audited. |
| 🔢 **2FA / TOTP** | Import Google Authenticator QR codes from screenshots — including multi-account *export* QR codes — or scan with your camera. |
| 📬 **Missing-login inbox** | Agents report missing or broken logins, accounts and 2FA; add them in one click. |
| 🧩 **Integrations** | Composio toolkits (Gmail, Slack, GitHub, Notion…) and custom MCP servers — globally, per workspace, or per agent. |
| 🗂️ **Workspaces** | Separate clients/projects with their own agents, logins, 2FA and integrations, plus shared global ones. |
| 🎙️ **Voice mode** | Dictate and hear replies; hands-free conversation loop (Web Speech, OpenAI or ElevenLabs). |
| 💾 **Backup & restore** | Encrypted `.godmode-backup` archives of your whole setup, including agent repositories. |
| 🖥️ **Desktop + dashboard** | Native app for macOS, Windows and Linux — or run headless on any device and use the web dashboard. |

<table>
  <tr>
    <td><img src="docs/screenshots/agents.png" alt="Agents" /></td>
    <td><img src="docs/screenshots/agent-detail.png" alt="Agent detail with routines and memory" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/vault-2fa.png" alt="2FA codes with QR import" /></td>
    <td><img src="docs/screenshots/integrations.png" alt="Composio and MCP integrations" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/browser.png" alt="Managed browser with live view" /></td>
    <td><img src="docs/screenshots/settings.png" alt="Settings" /></td>
  </tr>
</table>

## 📦 Install

### Desktop app

Download the latest release for your platform from
[**Releases**](https://github.com/codextde/godmode-bot/releases/latest):

- **macOS** — `.dmg` (Apple Silicon & Intel)
- **Windows** — `.msi` / `.exe`
- **Linux** — `.AppImage` / `.deb` / `.rpm`

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
2. **Add access** — import your Chrome sessions, add logins in **Vault → Logins**, and import 2FA QR codes in
   **Vault → 2FA Codes** (Google Authenticator → *Transfer accounts* → *Export* → screenshot).
3. **Chat** — ask Godmode anything: *“Log into our billing portal and download September's invoice.”*
4. **Create agents** — *“Create an agent that checks our competitors' pricing every Monday and sends me a summary.”*
   Godmode creates the agent, its instructions and its routine.
5. **Check the inbox** — if an agent couldn't log in, it tells you what's missing.

## 🧠 How it works

```
┌──────────── Godmode desktop app (Tauri 2) / web dashboard ────────────┐
│  React 19 · Tailwind v4 · shadcn/ui · aicss components                 │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (token / session)
┌───────────────▼────────────────────────────────────────────────────────┐
│  godmode core (Bun)                                                    │
│  runner · vault · scheduler · agents (git) · MCP gateway · browser    │
└───────┬──────────────────────────────┬─────────────────────────────────┘
        │ spawns per turn               │ launches + CDP
┌───────▼──────────────────────┐   ┌────▼─────────────┐
│ claude -p (Opus 5.5, bypass) │   │ managed Chromium │◄── browser-use MCP
│  MCP: godmode · browser ·    │   └──────────────────┘
│       composio · your MCPs   │
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
- **Redaction** of known secrets in transcripts, logs and the UI · **audit log** of every secret access.
- **Local-first**: API on `127.0.0.1`, per-run MCP tokens, DNS-rebinding & CSRF protection, strict CSP,
  rate-limited logins, HttpOnly/SameSite cookies for the dashboard.
- **Remember this device** keeps the data key in the OS keychain so routines run unattended — disable it to require
  your passphrase after every restart.

> ⚠️ Agents run Claude Code with **bypass permissions** by default. Treat them like a trusted coworker with access to
> your machine; for sensitive setups run Godmode in a VM or container. See [SECURITY.md](SECURITY.md).

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
- [x] Vault (logins + TOTP with QR import), Chrome session import, missing-login inbox
- [x] Composio + custom MCP servers, workspaces, voice mode, backup/restore
- [x] Desktop app (macOS/Windows/Linux) + headless web dashboard
- [ ] Full computer use: agents working in a dedicated macOS / Windows / Linux VM
- [ ] Mobile companion app & push notifications
- [ ] Team mode: shared workspaces and approvals

## 🙏 Credits

[Claude Code](https://code.claude.com) · [browser-use](https://github.com/browser-use/browser-use) ·
[Composio](https://composio.dev) · [Model Context Protocol](https://modelcontextprotocol.io) ·
[Tauri](https://tauri.app) · [shadcn/ui](https://ui.shadcn.com) · [aicss](https://www.aicss.dev) ·
[claude-mem](https://github.com/thedotmack/claude-mem) · [Bun](https://bun.sh)

## 📄 License

[MIT](LICENSE) © 2026 Codext GmbH and contributors.
