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
- **Redaction**: known secret values are masked in transcripts, run logs and the UI.
- **Audit log**: every secret access (fill, reveal, export) is recorded with agent and run id.
- **Dashboard mode**: token or password login (scrypt hashed), HttpOnly SameSite=Strict cookies, rate-limited login,
  DNS-rebinding protection, CSRF origin checks and a strict Content-Security-Policy. Use TLS (reverse proxy) when you
  expose the dashboard beyond localhost.
- **Per-run MCP tokens**: the Godmode MCP gateway only accepts short-lived tokens bound to a single agent run.

## Important caveats

- Agents run Claude Code in **bypass-permissions mode** by default so they can work without interruption. They can run
  commands on your machine within the agent's working directory and beyond. Only give agents tasks and credentials you
  would give a trusted coworker, and consider running Godmode in a VM or container for sensitive environments.
- Backups (`*.godmode-backup`) are encrypted with the backup passphrase you choose; secrets inside remain encrypted
  with your vault key.
