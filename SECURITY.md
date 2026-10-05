# Security Policy

Godmode Bot stores website credentials and 2FA secrets and lets an AI act on your behalf. We take that seriously.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/codextde/godmode-bot/security/advisories/new).
We aim to acknowledge reports within 72 hours and to ship a fix for critical issues within 14 days.

## Security model (summary)

- **Local-first**: everything runs on your device; the core API binds to `127.0.0.1` by default. Nothing leaves your
  computer unless you link it to a cloud (Godmode Cloud, below).
- **Godmode Cloud (optional)**: a computer linked to a Godmode Cloud account keeps one outbound WebSocket to it, and
  the cloud relays signed-in browsers (`/d/<computer>/`) and paired phones (`/gw/<computer>/`) through it. The cloud
  terminates HTTPS, so it can see everything relayed. The admin area has no way to open someone else's computer.
  Whoever operates the cloud (server, database, sign-in e-mail) is trusted and technically can. Only the owner of a
  computer and the people the owner shares it with can open it. The computer stores only its link secret (file, mode
  0600); the cloud stores its hash. The computer decides what the cloud may do (browser access, phone access, and
  unlocking the vault, revealing secrets and backups, which is off by default); dashboard sign-in, phone pairing,
  cloud link management and vault setup are never served to a relayed request, and every route is classified, so new
  ones are refused until someone decides. Relayed responses can't set cookies or run as pages on the cloud's origin,
  the cloud never forwards its own session cookie, and phones keep authenticating with their own key, checked by the
  computer. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#godmode-cloud).
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
- **Connected apps** (Settings → Claude Code & MCP): Claude Code and other MCP clients reach Godmode with a key of
  their own (`gmc_…`, stored as a SHA-256 hash, shown once). The key opens the management tools of the MCP gateway and
  nothing else: no vault tools, no browser, no settings, no dashboard API. Even a look-only key sees which logins
  exist (names, domains, usernames — never a password or a code) and the prompts and results of runs and tasks. Calls
  run as the built-in agent with the limits below, keys are either full or look-only, changes and refused calls are
  audited as `connector.call`, and keys are left out of backups. Phones and Godmode Cloud can't create or remove keys. A full key can create agents and automations that
  later act with your saved logins, so it deserves the same care as the app itself.
- **No privilege escalation through agents**: agents that create or edit agents cannot grant reveal access, change
  workspaces, browser profiles or out-of-scope integrations. A task an agent hands to a reveal-mode agent runs
  without raw secrets unless the caller reads raw secrets itself and the target is global or in the caller's workspace
  (logins are still filled into pages), and that chat stays fill-only; scheduling such an agent, putting tasks on the
  board for it or changing its settings stays with you. The task can still write to that agent's memory and files.
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
- **Mods are code you switch on**: a mod runs inside Claude Code in every turn of the agents it is for and can reach
  whatever its code asks for, so only you switch one on — and the switch counts for the code you saw: if it changed
  meanwhile, Godmode asks you to read it again. Claude Code's validator checks every change; the mod's page lists what
  it hooks and what it reaches outside the conversation (files, programs, the network, environment variables). A mod an
  agent wrote arrives switched off and marked for review, an agent can only save over its own drafts — never a mod you
  made, added or have had on — and a backup brings mods back switched off. Godmode keeps a mod's files in its database
  and gives every run a copy of its own, so what one run does to its mods reaches no other run. Secret options are
  sealed in the vault; a run that loads the mod is handed them, where an agent with full access to your computer could
  read them — use a key made for the mod. The gallery's guardrails (*Protect files*, *Command guard*, *Secret
  scrubber*) match patterns in tool calls and output: they catch mistakes and the obvious cases, not an agent that is
  set on getting around them (a run with full permissions can rewrite its own copy of a guard) — isolation is what VMs
  and permissions are for.
- **SSH servers are assigned by you**: an agent only reaches the servers you give its chat or the agent itself — agents
  can't assign servers to themselves or others, and delegated work doesn't inherit a chat's servers. Godmode signs in
  with the password or key sealed in the vault; they are never part of the prompt, and tool results mask them (the
  password, the passphrase and every line of the key). The server's host key is pinned on the first connection and a
  different key is refused. Uploads and downloads only use the folders of the run on your computer and never write
  into `.git` or `.claude` folders. First use per run and every sudo password entry are audited (`ssh.use`, `ssh.sudo`).
- **What an agent can do on a server**: whatever that account may do. It runs commands in the account's own shell, so
  a determined (or prompt-injected) agent can change what runs when Godmode enters the sudo password there and capture
  it — saving a sudo password is best effort, like typing logins into a VM. Give agents an account with only the rights
  the work needs, and prefer narrow `NOPASSWD` sudo rules to a saved sudo password.

- **Runners are paired, not discovered**: a runner (another computer that works for your Godmode) only accepts a
  computer that completed a pairing handshake with its one-time code (10 minutes, single use) and whose key it pinned
  then; Godmode only talks to the runner key it pinned. The link is end-to-end encrypted and authenticated on its own
  (X25519 with ephemeral and static keys, HKDF-SHA256, AES-256-GCM per direction, numbered frames), so it is safe on a
  LAN or over Tailscale without TLS. The runner's own API stays on loopback; from the network it answers only the link.
  The pairing code that an install command delivers is sealed with a token that exists only in that command line.
- **What a paired Godmode can do on a runner**: everything its owner can — it copies your setup there, including the
  vault's data key (so logins and 2FA codes work there; they stay encrypted at rest and are filled like here), starts
  chats, and its "Fix with Claude" chat runs shell commands on the runner (audited as `runner.exec`). Treat a runner like
  your own computer: pair only machines you control, and remove a runner (Runners → Remove) to make it forget this
  computer. Agents on a runner can't change its setup, automations or the task board — those are copies.

## Important caveats

- Agents run Claude Code in **bypass-permissions mode** by default so they can work without interruption. They can run
  commands on your machine as your user. Fill mode keeps secrets out of the model's context and blocks prompt-injection
  paths, but it is **not a sandbox against a deliberately malicious model with shell access** (which could, for example,
  read files your user can read or attach to the browser's debugging port). Only give agents tasks and credentials you
  would give a trusted coworker, and run Godmode in a VM or container for sensitive environments.
- **macOS VMs for agents**: an agent assigned a VM (per agent, chat or workspace) does all of its work inside an
  isolated macOS guest — shell, files, apps (Cua Driver runs in the guest) and the web (Google Chrome and browser-use run
  in the guest; no browser starts on your Mac). Its runs never get this Mac's screen, windows or tabs, even one you
  shared in the chat. With *Settings → Virtual machines → Keep agents with a VM off this Mac* (default), its runs also
  turn off Claude Code's Bash tool, don't bypass permissions (so Claude Code's own file tools — which still run on the
  host — only reach the agent's repository, the chat's folder and the VM's shared folder), load no Claude Code settings
  files and can't write any (no hooks), and can't hand work to, change, delete or schedule agents that work on the host
  (delegated work runs in the same VM). Work meant for a VM never falls back to the host. The VM shares nothing else
  with the host: no clipboard, the shared folder is the only mount, and a firewall rule inside each guest lets only this
  Mac reach its SSH and Screen Sharing (the Cirrus Labs images use the well-known login `admin` / `admin`, so other VMs
  must not). Logins and 2FA codes only go into a VM when you allow it (*Logins and 2FA codes*, off by default): then
  fills reach the guest's Chrome over an SSH port forward (still bound to the login's site); your OpenAI key (browser-use's LLM tools)
  never goes into a VM. Claude Code itself, the Godmode gateway and your Claude login stay on the host, so a VM strongly
  contains the agent's work but is not a boundary against a deliberately malicious model that can still use the tools
  Godmode gives it — the agent's shell shares the guest with its browser (it could read what a fill typed into a page
  there, as with Bash on the host), and a VM's `admin` can change its own firewall. Inside its VM an agent also decides
  macOS privacy permissions (Accessibility, Screen Recording, Automation, …) for the software there: the `permissions`
  tool writes the guest's own privacy database, which the guest's `admin` could do from the shell anyway (the images run
  with System Integrity Protection off). What an agent grants or revokes with the tool — and what it tried to — is in
  the audit log (`vm.permission.*`); none of it reaches this Mac's permissions.
- Backups (`*.godmode-backup`) are encrypted with the backup passphrase you choose; secrets inside remain encrypted
  with your vault key. Only import backups you created.
