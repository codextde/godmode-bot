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
vm/                   macOS VMs (see "macOS virtual machines"): bin/tart.app, tart/ (TART_HOME: vms/<vm-id>
                      disks and gm-image-* templates), downloads/ (image layers while downloading),
                      shared/<vm-id>/ shared folders, logs/<vm-id>.log, ssh/ key
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
* **Secrets in VMs** (`settings.vm.vaultFill`, off by default; turning it on needs a grant): the `vm` tools `fill_login` /
  `fill_totp` type a login or the current 2FA code into the field focused on the VM's screen, key by key over VNC (never
  through the guest clipboard; secrets that aren't plain ASCII are refused). Passwords only go in while macOS secure
  keyboard input is on and not owned by a terminal, checked before and after typing (when focus moved away, the typed characters
  are erased again) with `ioreg` / `ps` run without a shell. Unlike browser fills they can't be bound to a website, and the agent
  controls the VM, so this is best effort against a determined agent — closer to "reveal" than to fill-only.
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
       [--disallowedTools mcp__browser__browser_extract_content,… when no OpenAI key; Bash when the run works in a VM]
       [--add-dir <VM shared folder> when the run works in a VM]
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
| `memory_dream_report({ summary, changes })` | Only in dream runs — and the only tool they get: report what a memory consolidation changed (see Dreaming) |
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

* One managed Chromium per **browser profile** (global default + optional per workspace/agent/chat), launched with
  `--remote-debugging-port=<free port> --user-data-dir=~/.godmode/browser/<id>` on 127.0.0.1.
* A run browses in its chat's profile (`conversations.browser_profile_id`, picked in the composer), else the agent's
  pinned one, else its workspace's default, else the global default. Delegated work for an agent without a pinned
  profile keeps the caller chat's profile; deleting a profile sends its chats back to their default.
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

## macOS virtual machines

Agents can work in isolated macOS VMs instead of on the host (`packages/core/src/vm/`):

* **Backend: [Tart](https://tart.run)** on Apple's Virtualization.framework. Godmode installs a pinned, SHA-256-verified,
  notarized release into `<data>/vm/bin` on demand (`POST /api/vms/install`, or implicitly on the first VM) and runs it
  with `TART_HOME=<data>/vm/tart`, so the user's own `~/.tart` is never touched (`settings.vm.tartPath` overrides the
  binary). Images are the Cirrus Labs OCI images (`ghcr.io/cirruslabs/macos-{tahoe,sequoia}-base`, `…-tahoe-xcode`),
  which ship the Tart guest agent, auto-login as `admin` and passwordless sudo.
* **Images** (`vm/images.ts`): Tart pulls one layer per connection and restarts a layer when the connection drops —
  hours for 27 GB on slow or flaky links. Godmode downloads the layers itself (16 layers in parallel with anonymous
  registry tokens; each resumed with range requests across failures and restarts in `<data>/vm/downloads`, restarted
  when it stalls, verified against its digest), serves them to `tart pull --insecure` from a loopback registry
  (`127.0.0.1`, OCI distribution GET/HEAD with ranges), and keeps the result as the local template VM `gm-image-<hash>`.
  A layer is downloaded once however many images (or repeats within one) need it, and its file is removed once no
  download in flight needs it. Registries that refuse an anonymous pull go through Tart's own pull. A VM is an APFS copy-on-write `tart clone` of the template with a random MAC, so creating and
  resetting take seconds; `DELETE /api/vms/images/:image` removes a template to free space.
* **Records**: table `vms` (name, image, CPU, memory, disk, display, `provisioned_at`, last error/start/use); the Tart
  VM name is the VM id (`vm_…`, validated before any use as a name or path). Disk and shared folder paths derive from
  the id. `agents.vm_id`, `conversations.vm_id` and `workspaces.vm_id` assign VMs; a run uses the chat's, else the
  agent's, else the workspace's (`vm/assignments.ts`). Moving an agent *into* a VM only narrows what it reaches, so
  manager agents may assign VMs (`vm_assign`); taking an assignment away is human-only.
* **Lifecycle** (`vm/service.ts`): starts, stops, suspends, creations, resets and deletes claim the VM (`op` + token)
  and only release their own claim; changes and duplicates check that nothing holds it. Conflicting requests are
  refused; a stop (or delete) takes over a start. Disks are built under `<id>-building` and renamed when complete.
  `tart run <id> --no-graphics --suspendable --no-clipboard --dir=godmode:<shared>` is spawned detached with its output
  in `<data>/vm/logs/<id>.log`; Godmode waits for the guest agent (`tart exec <id> /usr/bin/true`), then sets the guest
  up on every boot (link `~/Godmode` → the virtiofs mount, computer name, Godmode's SSH key, Screen Sharing on, a `pf`
  anchor that lets only this Mac — the VM's gateway — reach SSH and Screen Sharing, no display sleep). Stopping asks
  macOS to shut down (`sync; sudo shutdown -h now` through the guest agent) and only powers the VM off when it doesn't
  (`tart stop` alone pulls the plug). VMs outlive a Godmode restart and are adopted (readiness re-checked on first use).
  `settings.vm.onQuit` suspends (default; macOS guests only), stops or keeps them when Godmode quits;
  `idleStopMinutes` stops unused ones. A suspended VM keeps its hardware (changes are refused). At most two macOS VMs
  run at once (Apple's limit) — a third start answers 409 naming the running ones.
* **Runs** (`runner.ts`): when a run has a VM, `attachVm` boots it if needed (activity "Starting the VM …"; cancelling
  the run stops the wait). Work meant for a VM never falls back to the host: VMs turned off, a missing VM or a VM that
  can't start fail the run with the reason. The MCP config gets the `vm` server (`/mcp/vm`, same run token), the system
  prompt a "macOS virtual machine" section (restated in every resumed turn) and `--add-dir <shared folder>`. With
  `settings.vm.isolateHostShell` (default) the run is kept off the host: `--disallowedTools Bash`, no permission bypass
  (`acceptEdits` + allow-listed MCP tools, so Claude Code's file tools only reach the run's folders) and
  `--setting-sources ""` plus a deny rule for `.claude/**` edits (no hooks from settings files, for this run or later host
  runs), and no unattended access to the host desktop (a screen the human shares in the chat still works). From such a
  run, delegated work for an agent without its own VM runs in the caller's VM, agents it creates work in that VM, and
  it can't change, delete or schedule agents that work on the host. Ending a run aborts its in-flight VM calls.
* **`vm` MCP tools** (`vm/tools.ts`): `shell` (`tart exec <id> /bin/zsh -l -c …`, exit code + stdout/stderr, timeout),
  `read_file` / `write_file` / `edit_file` (through the same channel, content via stdin; non-UTF-8 files are refused
  for edits), `info`, and `screen` — the computer-use action vocabulary (screenshot, clicks, drag, scroll, type, key,
  zoom) over the guest's macOS Screen Sharing on the VM's NAT address (`vm/vnc.ts`: RFB 3.8/3.889 client with Apple
  Remote Desktop authentication, raw 32-bit updates, pointer/key events; `vm/raster.ts`: crop, area-average downscale,
  PNG). Long or non-ASCII text is pasted through the guest clipboard. Screenshots remember their frame, so model
  coordinates map back to framebuffer pixels. (Tart's `--vnc-experimental` server is not used: it listens on every
  network interface.) `fill_login` / `fill_totp` type vault secrets into the focused field (optionally clicking a
  `coordinate` first) when `settings.vm.vaultFill` allows it; a password needs `kCGSSessionSecureInputPID` in the guest's
  `ioreg` (the app that owns it is named in the result and the audit entry). The value is never in a tool result.
* **Human access**: `POST /api/vms/:id/open { what }` opens Screen Sharing (`vnc://admin:admin@<NAT IP>`), Terminal
  (SSH with Godmode's key) or the shared folder in Finder; `GET /api/vms/:id/screenshot` feeds the card preview (never
  boots a VM). Backups carry VM records and assignments, not disks; a restore keeps this Mac's own VM records, and a
  restored VM whose disk is missing shows an error and can be reset.

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

* **Loaded into every chat** (`settings.memory.injectMemory`, default on): a new Claude session gets `MEMORY.md`
  (up to 12,000 characters) in its system prompt, so the agent starts every task already knowing it. Each
  conversation stores a digest of the `MEMORY.md` its session saw (`conversations.memory_digest`, refreshed after each
  of its runs); when another chat, a dream or the human changed it since, the next resumed turn says so.
* **Reflection**: the runtime prompt asks the agent to update `MEMORY.md` at the end of every task
  (`settings.memory.reflectAfterRun`).

### Dreaming (background memory consolidation)

After ChatGPT's "dreaming": on a schedule (`settings.memory.dreaming.cron`, local time, default nightly at 03:00) every
agent reviews what happened since its last dream and rewrites its memory — capturing what nobody explicitly asked it to
remember, merging duplicates, resolving contradictions (newer wins), making dates absolute and rewriting plans that
have passed ("is going to Singapore in July" → "went to Singapore in July 2026"), and pruning what is stale, keeping
`MEMORY.md` compact enough to load into every run. `memory/dreaming.ts` owns it:

* **When**: a 5-minute tick sweeps once per scheduled time; a schedule missed while the computer was off or asleep is
  caught up on the next tick. An agent is due with at least `minNewExchanges` (default 3) new exchanges — finished
  chat, automation, delegated and API runs; checks and dreams don't count — or, without them, when its last dream is
  `refreshDays` (default 7) old and `MEMORY.md` mentions dates. Scheduled dreams only start on idle agents (no run in
  the last 10 minutes; retried on later ticks). "Dream now" (`POST /api/agents/:id/dreams`) starts one right away.
* **How**: a dream is a run with trigger `dream` in the agent's archived `origin = 'dream'` conversation (nobody else
  can post there), with a fresh session, cwd = the agent repo, the dreaming model (`dreaming.model`, default
  `sonnet`), `--tools Read,Write,Edit,Glob,Grep`, and an MCP config with only the Godmode gateway, which lists just
  `memory_dream_report` (other tools are refused). The exchanges since the cursor (`MAX(dreams.source_to)` of
  successful or undone dreams) are handed over as a digest of the already redacted run prompts and answers, grouped by
  conversation, in `workspace/tmp/dreams/<id>.md` (git-ignored, removed afterwards; 120k characters per dream — older
  activity first, the rest waits for the next dream). No transcript, no missing-login detection, no "last active".
* **Exclusive**: a dream owns the agent's memory — the runner starts no other run of the agent while it runs, and it
  waits for the agent's running runs (capped at 20 minutes). A run someone waits for (chat, delegation, API) pauses a
  *scheduled* dream: it is cancelled, rolled back and retried once the agent is idle again.
* **All or nothing, reviewable**: `MEMORY.md` and `memory/**` are snapshotted when the dream starts (`dreams.snapshot`).
  A successful dream stores the changed files before/after (`dreams.files`) with the agent's report (summary and one
  line per change: added, updated, merged, removed, corrected, dated) and commits `Dream: <summary>`; a failed or
  cancelled one is rolled back. `POST /api/dreams/:id/revert` undoes a dream while its files are unchanged since.
  The agent's Memory tab shows the journal with a diff of every dream.
