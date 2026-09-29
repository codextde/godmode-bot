# Security Policy

Godmode Bot stores website credentials and 2FA secrets and lets an AI act on your behalf. We take that seriously.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/codextde/godmode-bot/security/advisories/new).
We aim to acknowledge reports within 72 hours and to ship a fix for critical issues within 14 days.

## Security model (summary)

- **Local-first**: everything runs on your device; the core API binds to `127.0.0.1` by default.
- **Vault encryption**: your passphrase is stretched with scrypt (N=2^17) into a key-encryption key that wraps a random
  256-bit data key. Every secret is encrypted with AES-256-GCM and bound to its database row (AAD).
- **Remember this device** stores the data key in the OS keychain (macOS Keychain, Windows Credential Manager,
  libsecret) so scheduled routines can run unattended. Turn it off to require the passphrase after every restart.
- **Secrets never reach the model by default**: agents ask Godmode to *fill* a password or 2FA code into the browser
  page over the Chrome DevTools Protocol; the value is not returned to the model. "Reveal" mode is opt-in per agent.
- **Site-bound fills**: a login is only typed into a page (or iframe) whose host matches the login's domains, over
  https (plain http only when the saved URL is http). Passwords only go into real password fields. A prompt-injected
  lookalike page gets nothing.
- **Re-authentication for sensitive actions**: revealing a password, enabling "reveal" for an agent (or as default) and
  turning on "remember this device" need a short-lived grant confirmed with your vault passphrase — a stolen API token
  alone is not enough.
- **No privilege escalation through agents**: agents that create or edit agents cannot grant reveal access, change
  workspaces, browser profiles or out-of-scope integrations; fill-only agents cannot delegate to reveal-mode agents.
- **Redaction**: known secret values (logins, 2FA, API keys, MCP env/header values) are masked in transcripts, run logs
  and the UI.
- **Audit log**: every secret access (fill, reveal, export) is recorded with agent and run id.
- **Token handling**: the desktop shell hands the core its API token over stdin (never via environment variables or
  files); child processes never inherit Godmode's variables; per-run MCP tokens expire with the run.
- **Dashboard mode**: token or password login (scrypt hashed), HttpOnly SameSite=Strict cookies (Secure behind TLS),
  rate-limited login, DNS-rebinding protection, CSRF origin checks, a strict Content-Security-Policy, WebSocket
  origin checks. Use TLS (reverse proxy) when you expose the dashboard beyond localhost.
- **Backups** are encrypted with a passphrase (scrypt + AES-256-GCM, authenticated header); imports validate paths and
  reset settings that point at programs or endpoints, and disable stdio MCP servers, so a foreign backup can't run code.

- **Computer use is opt-in per chat**: an agent only sees and controls what you share in that chat (one window, one
  display, the whole desktop or one Godmode browser tab), through a per-run MCP server scoped to exactly that target.
  Stopping the share revokes access immediately — also for queued or long-running actions (typing, waits, held keys).
  A shared window is driven in the background and keyboard input only goes to it when it is its app's key window.
  Godmode's own windows and dashboard tabs can't be shared. Unattended desktop access for routines is a human-only
  agent setting; agents without it can't hand work to agents that have it, and backups never restore it. Shares and
  their first use per run are audited (`computer.share`, `computer.unshare`, `computer.control`).

## Important caveats

- Agents run Claude Code in **bypass-permissions mode** by default so they can work without interruption. They can run
  commands on your machine as your user. Fill mode keeps secrets out of the model's context and blocks prompt-injection
  paths, but it is **not a sandbox against a deliberately malicious model with shell access** (which could, for example,
  read files your user can read or attach to the browser's debugging port). Only give agents tasks and credentials you
  would give a trusted coworker, and run Godmode in a VM or container for sensitive environments — dedicated VMs for
  agents are on the roadmap.
- Backups (`*.godmode-backup`) are encrypted with the backup passphrase you choose; secrets inside remain encrypted
  with your vault key. Only import backups you created.
