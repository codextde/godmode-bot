# Godmode Bot — Architecture

Godmode Bot is an AI coworker that runs on your machine. It drives **Claude Code CLI** (default model
`claude-opus-5-5`, full bypass mode) as the brain, uses **browser-use** for web automation, and has a secure
**vault** for website logins and **TOTP 2FA** so agents can log in and finish work without interrupting you.

```
┌─────────────────────────────── Desktop app (Tauri 2) ───────────────────────────────┐
│  React 19 + Vite + Tailwind v4 + shadcn/ui  (apps/desktop/src)                      │
│        │  HTTP + WebSocket (Bearer token)                                           │
│        ▼                                                                            │
│  godmode core sidecar (Bun, packages/core)  ──── also runs headless: `godmode serve`│
└─────────────────────────────────────────────────────────────────────────────────────┘
        │ spawns per turn                          │ launches (CDP)
        ▼                                          ▼
  claude -p --output-format stream-json      Chromium (per browser profile)
     --mcp-config {godmode, browser, …}           ▲
        │ MCP (HTTP)            │ MCP (stdio)     │ CDP
        ▼                       ▼                 │
  Godmode MCP gateway      browser-use MCP ───────┘
  (vault fill, TOTP, agents, delegation, missing logins, …)
```

## Repository layout

| Path | What |
|---|---|
| `packages/shared` | Types shared by core and UI: models (`models.ts`), API inputs (`api.ts`), WS events (`events.ts`). **The contract.** |
| `packages/core` | The daemon (Bun + Hono + bun:sqlite). HTTP API under `/api`, WebSocket at `/api/ws`, MCP gateway at `/mcp`. |
| `apps/desktop` | React UI (also served by the core as the web dashboard) + `src-tauri` desktop shell. |
| `docs/` | Docs, logo, screenshots. |

## Data directory (`~/.godmode`, override with `GODMODE_HOME`)

```
godmode.db            SQLite (WAL). Secrets are AES-256-GCM encrypted with the vault DEK.
access-token          0600 — bearer token for server mode / dev
agents/<slug>/        one git repository per agent (see below)
browser/<profile-id>/ Chromium user-data-dirs managed by Godmode
attachments/          chat uploads
backups/              automatic + manual backups (*.godmode-backup)
logs/core.log
```

### Agent repositories

Every agent owns a git repo at `agents/<slug>/` (created with isomorphic-git, auto-committed after every run):

```
CLAUDE.md          generated: identity, instructions, tools, rules (regenerated on agent update)
MEMORY.md          long-term memory the agent maintains itself (facts, preferences, learnings)
memory/            free-form notes the agent may create
state/agent.json   snapshot of agent config (no secrets)
state/routines.json
conversations/<conversation-id>.md    human-readable transcript
runs/YYYY-MM-DD/<run-id>.jsonl        raw stream-json events (secrets redacted)
workspace/         scratch space for files the agent produces (downloads, reports…)
.gitignore         excludes nothing sensitive because nothing sensitive is written here
```

Claude runs with `cwd = agents/<slug>/`, so the agent sees its own memory and files.

## Security model

* **Vault**: passphrase → scrypt (N=2^17) → KEK → unwraps a random 256-bit DEK. Every secret column is
  `AES-256-GCM(DEK, value, AAD = "<table>.<column>:<row-id>")`. The DEK only lives in memory, or in the
  OS keychain (`Bun.secrets`) when “remember this device” is on (default on desktop so routines run unattended).
* **Secret use without exposure** (default `secretAccess: "fill"`): agents call `vault_fill_login` /
  `vault_fill_totp`; the core types the value into the page over CDP. The model never sees the password.
  `"reveal"` mode lets an agent read raw secrets (needed for API-only tools) and is audited.
* **Redaction**: every known secret is masked in transcripts, run logs and the UI stream.
* **Audit log**: every secret access (`credential.fill`, `credential.reveal`, `totp.fill`, …) is recorded.
* **API auth**: bearer token (desktop shell / `godmode token`) or HttpOnly SameSite=Strict session cookie
  (dashboard password). Loopback-only by default with Host-header DNS-rebinding protection, CSRF origin check,
  login rate limiting, strict CSP for the dashboard.
* **MCP gateway**: each run gets a random bearer token scoped to that run/agent; expires when the run ends.

## Runner

For each user message / routine tick / delegation the runner spawns:

```
claude -p --output-format stream-json --verbose --include-partial-messages
       --model <agent.model || settings.runner.model> [--effort <e>]
       --dangerously-skip-permissions          (settings.runner.bypassPermissions)
       --mcp-config <tmp json> --strict-mcp-config
       --append-system-prompt <godmode system prompt>
       [--resume <conversation.claudeSessionId> | --session-id <new uuid>]
       [--max-budget-usd n] [--agents <subagents json>] [--fallback-model m]
       --setting-sources project,local
       <prompt>
cwd = agent repo
```

Stream events are converted into `MessageBlock[]` (text, thinking, tool_use + result) and pushed as
`run.delta` WS events; the final assistant message is stored in SQLite and in the agent repo.
Concurrency is limited by `settings.runner.maxConcurrentRuns` (queue). A per-conversation lock prevents
two concurrent turns in the same conversation.

## Godmode MCP gateway tools (`/mcp`)

| Tool | Purpose |
|---|---|
| `vault_list_logins({ domain? })` | Logins available to this agent (no secrets) |
| `vault_fill_login({ credentialId, field: "username"\|"password", selector? })` | Type a secret into the browser page |
| `vault_fill_totp({ credentialId? , totpId?, selector? })` | Type the current 2FA code into the page |
| `vault_get_login({ credentialId })` | Reveal username/password — only when `secretAccess = "reveal"` |
| `vault_get_totp({ totpId })` | Reveal current code — only in reveal mode |
| `report_missing_login({ service, url, kind, reason })` | Tell the human a login/account/2FA is missing or broken |
| `agents_list()`, `agent_get({id})` | Discover peer agents |
| `agent_delegate({ agentId, task, wait })` | Hand a task to a peer agent (optionally wait for its result) |
| `agent_create`, `agent_update`, `agent_delete`, `routine_create`, `routine_update`, `routine_delete`, `runs_list`, `workspaces_list` | Management tools — only for agents with `canManageAgents` (the built-in *Godmode* agent) |
| `notify_user({ title, body })` | Push a notification to the human |

## HTTP API

All routes are under `/api` and require auth except `/api/health` and `/api/auth/*`.
The typed client in `apps/desktop/src/lib/api.ts` is the canonical list of endpoints and payloads;
core routes must match it exactly. Errors are `{ error, code?, details? }` with a proper status
(400 validation, 401 auth, 403 forbidden, 404 missing, 409 conflict, 423 vault locked).

Scope query param `workspaceId`: `all` (default) | `global` | `<workspace id>`.

## WebSocket (`/api/ws`)

Server → UI events are defined in `packages/shared/src/events.ts`. The UI keeps React Query caches in sync
(`apps/desktop/src/lib/realtime.ts`). Browser live view frames are only sent to subscribed clients.

## Browser

* One managed Chromium per **browser profile** (global default + optional per workspace/agent), launched with
  `--remote-debugging-port=<free port> --user-data-dir=~/.godmode/browser/<id>` on 127.0.0.1.
* Agents get browser tools from the **browser-use MCP server** (`uvx browser-use --mcp`) configured via
  `BROWSER_USE_CONFIG_DIR` → `config.json` with `browser_profile.cdp_url` pointing at that Chromium.
* **Session import** (“continue where Chrome left off”): the importer uses the same technique as browser-use’s
  `profile-use` — copy the Chrome profile’s cookie store to a temp dir, start the real Chrome binary headless on it
  with CDP, read decrypted cookies via `Storage.getCookies`, inject them into the Godmode profile with
  `Storage.setCookies`. `profile-use` itself is supported for syncing to browser-use Cloud profiles.
* **Live view**: CDP `Page.startScreencast` frames streamed to subscribed UIs; the human can take over
  (click/type) e.g. to solve a CAPTCHA.

## Integrations

* **Custom MCP servers** (stdio/http/sse), scoped global / workspace / agent; env + headers encrypted.
* **Composio** (v3.1 REST, `x-api-key`): browse toolkits, connect accounts via `connected_accounts/link`
  (`user_id` = `global` | `ws_<workspaceId>` | `agent_<agentId>`), and expose them to agents through a Tool Router
  session MCP URL (`POST /api/v3.1/tool_router/session`).

## Memory

Default: file-based (`MEMORY.md` + `memory/` in the agent repo, committed to git). Optional:
[claude-mem](https://github.com/thedotmack/claude-mem) with `CLAUDE_MEM_DATA_DIR` pointing into the agent repo.
