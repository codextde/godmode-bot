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

### Working folders

An agent can have a default folder (`agents.working_directory`) and every conversation can override it
(`conversations.working_directory`, `null` = the agent's default). With a folder, Claude runs with `cwd = <folder>`
and `--add-dir <agent repo>` plus `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, so both the folder's own
CLAUDE.md and the agent's identity/memory load. Resumed turns restate the working directory because the session's
system prompt is a snapshot of its first turn. Folders must exist, be absolute and lie outside the data directory;
only the human sets them (agent-made changes are ignored). The UI picks them via `GET /api/folders?path=` (subfolders on
the core's machine) and `GET /api/folders/recent`.

## Security model

* **Vault**: passphrase → scrypt (N=2^17) → KEK → unwraps a random 256-bit DEK. Every secret column is
  `AES-256-GCM(DEK, value, AAD = "<table>.<column>:<row-id>")`. The DEK only lives in memory, or in the
  OS keychain (`Bun.secrets`) when “remember this device” is on (default on desktop so routines run unattended).
* **Secret use without exposure** (default `secretAccess: "fill"`): agents call `vault_fill_login` /
  `vault_fill_totp`; the core types the value into the page over CDP. The model never sees the password.
  Fills are **site-bound**: the frame that owns the target field must be on one of the login's domains (https, or http
  only when the saved URL is http), and passwords only go into `input[type=password]`.
  `"reveal"` mode lets an agent read raw secrets (needed for API-only tools) and is audited.
* **Grants**: revealing secrets and enabling reveal/remember-device require `X-Godmode-Grant`, obtained from
  `POST /api/vault/grant {passphrase}` (10 min, in memory).
* **Redaction**: every known secret is masked in transcripts, run logs and the UI stream.
* **Audit log**: every secret access (`credential.fill`, `credential.reveal`, `totp.fill`, …) is recorded.
* **API auth**: bearer token (desktop shell / `godmode token`) or HttpOnly SameSite=Strict session cookie
  (dashboard password). Loopback-only by default with Host-header DNS-rebinding protection, CSRF origin check,
  login rate limiting, strict CSP for the dashboard.
* **MCP gateway**: each run gets a random bearer token scoped to that run/agent; expires when the run ends.
  Management tools cannot grant reveal access, move agents between workspaces or attach out-of-scope profiles/MCP
  servers; fill-only agents cannot delegate to reveal-mode agents.
* **Token hand-off**: the desktop shell starts the core with `--token-stdin` and writes the token as the first stdin
  line; the core strips `GODMODE_*` from every child process environment.

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
       [--disallowedTools mcp__browser__browser_extract_content,… when no OpenAI key]
       (prompt is written to stdin)
cwd = agent repo, or the conversation's / agent's folder (then also --add-dir <agent repo>)
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
| `agent_create`, `agent_update`, `agent_delete`, `routine_list`, `routine_create`, `routine_update`, `routine_run`, `routine_delete`, `automation_triggers_list`, `automation_events_list`, `runs_list`, `workspaces_list` | Management tools — only for agents with `canManageAgents` (the built-in *Godmode* agent) |
| `automation_check_result({ met, observation, summary })` | Only in condition-check runs: report whether an automation's condition holds (see Automations) |
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
* On macOS a visible browser never takes focus: it is started in the background through LaunchServices
  (`open -g`, no startup window) and its first window opens behind the active app.
* Agents get browser tools from the **browser-use MCP server** (`uvx --from browser-use==0.13.10 browser-use --mcp`)
  configured via `BROWSER_USE_CONFIG_DIR` → `<data>/browser-use/<profile>/<agent>/config.json` with
  `browser_profile.cdp_url` pointing at that Chromium; downloads land in the agent's `workspace/downloads`.
  LLM-backed browser-use tools (`browser_extract_content`, `retry_with_browser_use_agent`) are only offered when an
  OpenAI key is in the vault (passed via env, never written to disk); otherwise the runner disallows them.
* One profile = one Chromium: runs that share a profile take turns (delegated child runs may use their parent's
  browser while the parent waits).
* **Session import** (“continue where Chrome left off”): the importer uses the same technique as browser-use’s
  `profile-use` — copy the Chrome profile’s cookie store to a temp dir, start the real Chrome binary headless on it
  with CDP, read decrypted cookies via `Storage.getCookies`, inject them into the Godmode profile with
  `Storage.setCookies`. `profile-use` itself is supported for syncing to browser-use Cloud profiles.
* **Live view**: CDP `Page.startScreencast` frames streamed to subscribed UIs; the human can take over
  (click/type) e.g. to solve a CAPTCHA. Chats show a *passive* preview of their agent's browser next to the thread:
  passive subscribers get frames but don't keep an idle browser running.

## Computer use

A chat can **share** something with its agent — `conversations.computer_target` (`ComputerTarget` in
`packages/shared/src/computer.ts`): one app window, one display, the whole desktop or a tab of a Godmode browser.
Agents allowed to use the computer unattended (`agents.computer`, human-only) get the desktop (or one display) for runs
without a share. A run with a target gets a fourth MCP server, `computer` → `POST /mcp/computer` on the gateway with
the run's token; its tools only ever reach that target:

| Tool | |
|---|---|
| `computer({ action, … })` | Claude's computer-use vocabulary: `screenshot`, `left_click` / `right_click` / `double_click` / `triple_click` / `middle_click`, `mouse_move`, `left_click_drag`, `scroll`, `type`, `key` (xdotool-style keys), `hold_key`, `wait`, `cursor_position`, `zoom`. Coordinates are pixels of the latest screenshot; every action returns a fresh one. Desktop shares take `display`; window shares take `element` (from `computer_ui`) and, if allowed in settings, `foreground`. |
| `computer_info` | What is shared (displays with their arrangement, window, tab). |
| `computer_ui` | Window shares: the window's accessibility elements with tokens (click/type by element — works while the window is covered). |
| `computer_windows`, `computer_open_app` | Desktop shares: list / focus windows, open apps. |

Each model screenshot remembers the screen area it shows (`Shot`), so image pixels map back exactly
(`src/computer/geometry.ts`). Engines (`src/computer/engines/`) behind one interface:

* **Window** — [Cua Driver](https://github.com/trycua/cua) (`libs/cua-driver`, MIT), run as `cua-driver mcp --direct`
  (Godmode is its MCP client; `--direct` keeps the TCC grants of the app running Godmode). The pinned build comes from
  PyPI (`cua-driver`, bundles the native binary) via `uvx`, with telemetry and update checks off and its state under
  `<data>/cua-driver`. Its pixel coordinates refer to its last screenshot of the window, so all calls go through one
  queue and that size is tracked. Element tokens that a newer driver snapshot made stale are re-resolved by
  role/label/position. On macOS the native helper backs it up: window capture for the live view, scrolling (through the
  scroll area's accessibility scroll bars — posted wheel events don't reach background windows), and pointer/keyboard
  delivery with `CGEventPostToPid` + `AXPress` when the driver refuses a window it can't match in the accessibility tree.
* **Desktop / display** — the native helper, every monitor: macOS `native/macos/GodmodeComputer.swift` (ScreenCaptureKit,
  global CGEvents; embedded into the compiled core by `scripts/build.ts`, extracted to `<data>/bin`, compiled with
  `swiftc` when running from source), Windows a PowerShell-hosted C# class (`helpers/windowsHelper.ts`: `Screen.AllScreens`,
  `CopyFromScreen`, `SendInput`), Linux/X11 `xrandr` + ImageMagick `import` + `xdotool`. Without one, Cua Driver's
  desktop target covers the primary display. Desktop runs take turns (one mouse); window/tab shares only lock themselves.
* **Tab** — CDP on Godmode's Chromium (`Page.captureScreenshot`, `Input.dispatch*`), background tabs included.

Live view: `computer.subscribe { view }` over the WebSocket (`display:<id>`, `window:<pid>:<windowId>`,
`tab:<profile>:<target>`) streams `computer.frame` events (≈4 fps) while someone watches; agent actions arrive as
`computer.action` (drawn as ripples). Takeover: `POST /api/computer/input` (coordinates of the last frame). Sharing
(`PATCH /api/conversations/:id { computerTarget }`, or `computerTarget` on `POST /api/chat`) validates the target; stopping
revokes a running run's access immediately. Shares and first use per run are audited (`computer.share`,
`computer.unshare`, `computer.control`). Backups never restore shares, unattended access or the Cua Driver command.

## Automations

An automation (internally a *routine*: table `routines`, `/api/routines`, `routine_*` tools, `state/routines.json`)
runs an agent's prompt when its trigger fires (`Routine.trigger`):

| Trigger | Fires when | How |
|---|---|---|
| `schedule` | the cron expression matches | croner job (`scheduler/scheduler.ts`), timezone aware |
| `app` | a connected app emits an event (new email, Slack message, calendar event, Notion update…) | Composio trigger instance per watched account + settings (`POST /api/v3.1/trigger_instances/{slug}/upsert`), delivered over Composio's realtime channel (Pusher, `private-<project>_triggers`, the feed behind the SDK's `triggers.subscribe`) — no public URL needed (`integrations/composioTriggers.ts`, `integrations/pusher.ts`) |
| `condition` | a plain-language condition becomes true ("a competitor changes their pricing") | on the cron schedule (≥ 5 min apart) the agent runs a **check** (`Run.trigger = "check"`, archived per-automation conversation, fresh Claude session, optional cheaper `checkModel`) and reports via `automation_check_result`; the reported observation is fed into the next check to detect changes (`automations/conditions.ts`) |
| `webhook` | something POSTs to `/hooks/<token>` | public route outside `/api` (exempt from the loopback Host check so a tunnel can forward it); the token is stored as a SHA-256 hash (lookup) and sealed with the vault key (shown again in the UI); ≤ 256 KB, 60 calls/min, `Idempotency-Key`/`X-Request-Id` dedupe (`automations/webhooks.ts`) |

Everything that happens is an **event** (`automation_events`, `AutomationEvent`, WS `automation.event`): schedule ticks,
app events, webhook calls, conditions met and manual tests. Events are stored first, deduplicated (Composio message id,
delivery headers) and dispatched (`automations/events.ts`): an idle automation starts one run with every waiting event
(≤ 10); a busy one keeps them pending until its run finishes; at most 50 wait and 20 runs start per automation per
hour (then events wait and the human is notified). The run prompt is the automation's prompt followed by the events
as delimited, **untrusted** data (known secrets masked, size-bounded) with an explicit instruction not to follow
instructions inside them; an optional plain-language `filter` lets the agent skip non-matching events (it answers
`Skipped: …`, and the events are marked skipped). Event statuses follow their run (`pending → running → done | failed
| skipped`); finished events are pruned (newest 200 per automation, at most 30 days). "Run now" runs a schedule, checks a
condition, or sends app/webhook automations a test event (a dry run that never shares a run with real events).
App and webhook automations start a conversation per event by default (named after the event), so untrusted data
doesn't accumulate in one long session. A condition's reported observation becomes the next check's baseline only
once the task handled it — after a failed or skipped task the next check still sees the change.

App trigger instances are kept in sync every 5 minutes and on changes (`syncAppTriggers`): upserted per automation
(re-upserted hourly, and when the API key — possibly another Composio project — changes), disabled when the
automation, its agent or its account goes away or out of the agent's scope, and deleted once nothing references them.
Events are only routed to automations whose trigger instance matches, whose setup is healthy and whose agent may still
use the watched account.

The Godmode agent sets automations up from one sentence ("when X happens, do Y"): `automation_triggers_list` shows the
connected Composio accounts and each app's events with their settings schema; `routine_create` takes the trigger.

## Integrations

* **Custom MCP servers** (stdio/http/sse), scoped global / workspace / agent; env + headers encrypted.
* **Composio** (v3.1 REST, `x-api-key`): browse toolkits, connect accounts via `connected_accounts/link`
  (`user_id` = `global` | `ws_<workspaceId>` | `agent_<agentId>`), and expose them to agents through a Tool Router
  session MCP URL (`POST /api/v3.1/tool_router/session`). Connected accounts can also start automations (app
  triggers, see Automations); an automation may only watch accounts its agent could use.

## Memory

Default: file-based (`MEMORY.md` + `memory/` in the agent repo, committed to git). Optional:
[claude-mem](https://github.com/thedotmack/claude-mem) with `CLAUDE_MEM_DATA_DIR` pointing into the agent repo.
