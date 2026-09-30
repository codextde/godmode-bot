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
| `apps/mobile` | Phone app (Expo, iOS + Android). Own toolchain (bun), outside the pnpm workspace; imports `@godmode/shared` from source. |
| `docs/` | Docs, logo, screenshots. |

## Data directory (`~/.godmode`, override with `GODMODE_HOME`)

```
godmode.db            SQLite (WAL). Secrets are AES-256-GCM encrypted with the vault DEK.
access-token          0600 — bearer token for server mode / dev
agents/<slug>/        one git repository per agent (see below)
browser/<profile-id>/ Chromium user-data-dirs managed by Godmode
attachments/          chat uploads
repos/<workspace-id>/ clones of the workspaces' git repositories (removed ones go to repos/.trash/)
backups/              automatic + manual backups (*.godmode-backup)
vm/                   macOS VMs (see "macOS virtual machines"): bin/tart.app, tart/ (TART_HOME: vms/<vm-id>
                      disks and gm-image-* templates), downloads/ (image layers while downloading),
                      shared/<vm-id>/ shared folders, logs/<vm-id>.log, ssh/ key
tasks/<task-id>/      checkout of a coding task's repository (see "Tasks")
logs/godmode.jsonl    diagnostic log (see "Diagnostic log"); godmode.1.jsonl is the previous 2 MB, desktop.log the shell's
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

### Workspace folders and repositories

A workspace can attach folders and git repositories (`workspace_sources`, `Workspace.sources`, set as a whole list with
`sources` on `POST/PATCH /api/workspaces`; `services/workspaceSources.ts`). Every run of an agent in the workspace gets
the usable ones with `--add-dir` (their CLAUDE.md loads too), a "Workspace folders and repositories" section in the
system prompt, and a one-line restatement on resumed turns. Dreams don't get them. Only the human attaches them.

* **Folders** follow the working-folder rules (absolute, existing, outside the data directory). One that goes missing
  shows as `missing` and is skipped by runs with a notice; the workspace can still be saved.
* **Repositories** are cloned with the system `git` into `repos/<workspace-id>/<name>` as soon as they are added, so the
  machine's own git sign-in applies (SSH keys, credential helpers). Accepted URLs: https, `ssh://`, `git@host:owner/repo`
  and `git://`; GitHub/GitLab/Bitbucket/Codeberg web links (also `…/tree/<branch>`) become clone URLs (`parseGitUrl` in
  `@godmode/shared`). Credentials in URLs, local paths and other transports are refused. Nothing waits for a prompt
  (`GIT_TERMINAL_PROMPT=0`, no askpass, SSH in batch mode with `StrictHostKeyChecking=accept-new` unless the user set
  their own SSH command). A clone lands in `<name>.cloning-*` and is only renamed into place when complete.
* **Updates** (`POST /api/workspaces/:id/sources/:sourceId/sync`, which clones a missing one) fetch, then
  `merge --ff-only` only when the tree has no local changes — agents' work is never overwritten; `note` says why a clone
  was left as it was. Before a run, all sources are prepared at once: a missing clone is cloned (the run waits up to
  90 s, then goes on without it while the clone continues), one not updated for 15 minutes is fast-forwarded (20 s,
  retried at most every 15 minutes). Failures are stored on the source (`error`) in words a human can act on; a clone
  whose update failed stays usable.
* **Agents can write into clones, git runs there on the host.** Godmode's git ignores the clone's hooks and fsmonitor
  (`core.hooksPath`, `core.fsmonitor` on the command line), pins the SSH command through the environment, and runs that
  may edit files but not run commands (no permission bypass, VM runs) get `Edit(**/.git/**)` plus the clones' `.git`
  denied, so a clone's git settings can't be used to run programs on this computer.
* Removing a repository or deleting its workspace stops a running clone and moves the clone to `repos/.trash/` (it may
  hold unpushed work). Backups carry the records, not the clones: restored repositories are cloned again, restored
  folders must exist on the new machine.

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
       [--disallowedTools mcp__browser__browser_extract_content,… when no OpenAI key or in a VM; Bash in a VM]
       [--add-dir <VM shared folder> when the run works in a VM]
       [--add-dir <folder or clone> for each usable workspace folder and repository]
       (prompt is written to stdin)
cwd = agent repo, or the conversation's / agent's folder (then also --add-dir <agent repo>)
```

Stream events are converted into `MessageBlock[]` (text, thinking, tool_use + result) and pushed as
`run.delta` WS events; the final assistant message is stored in SQLite and in the agent repo.
Concurrency is limited by `settings.runner.maxConcurrentRuns` (queue). A per-conversation lock prevents
two concurrent turns in the same conversation. Runs sharing a browser profile don't wait for each other: every chat
works in its own tabs (see Browser).

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
| `agent_create`, `agent_update`, `agent_delete`, `routine_list`, `routine_create`, `routine_update`, `routine_run`, `routine_delete`, `automation_triggers_list`, `automation_events_list`, `runs_list`, `workspaces_list`, `tasks_list`, `task_create`, `task_update` | Management tools — only for agents with `canManageAgents` (the built-in *Godmode* agent) |
| `automation_check_result({ met, observation, summary })` | Only in condition-check runs: report whether an automation's condition holds (see Automations) |
| `task_report_blocked({ reason })` | Only in runs working on a board task: say what's missing; the task moves to Blocked when the run ends (see Tasks) |
| `memory_dream_report({ summary, changes })` | Only in dream runs — and the only tool they get: report what a memory consolidation changed (see Dreaming) |
| `notify_user({ title, body })` | Push a notification to the human |
| `followup_schedule({ at \| inMinutes, note })`, `followup_cancel()` | Continue this chat later on its own (see Follow-ups); not in condition checks |
| `api_tools_list()`, `api_tool_docs({ tool })`, `api_tool_request({ tool, method, path, json \| form \| body, query, saveAs })` | Only for agents with API tools: list them, read one's docs, call its API with the key added by Godmode (see Integrations) |

Runs may get three more servers behind the gateway, all with the same run token: `/mcp/computer` (see Computer use),
`/mcp/vm` (see macOS virtual machines) and `/mcp/ssh` (see SSH servers).

## HTTP API

All routes are under `/api` and require auth except `/api/health` and `/api/auth/*`.
The typed client in `apps/desktop/src/lib/api.ts` is the canonical list of endpoints and payloads;
core routes must match it exactly. Errors are `{ error, code?, details? }` with a proper status
(400 validation, 401 auth, 403 forbidden, 404 missing, 409 conflict, 423 vault locked).

Scope query param `workspaceId`: `all` (default) | `global` | `<workspace id>`.

## Diagnostic log

`log.ts` writes every entry as one JSON line (`LogEntry` in `packages/shared/src/models.ts`) to `logs/godmode.jsonl`
(moved to `godmode.1.jsonl` at 2 MB, so at most two files). Before anything is written, known vault secrets (regardless of
`security.redactSecrets`), bearer tokens, API keys, `key=value` secrets, URL credentials, webhook tokens and the home
directory are masked; request paths are logged as route patterns. `info` and up by default, `debug` too with
`settings.diagnostics.verbose`. What gets recorded besides the existing log calls:

| Scope | Entries |
|---|---|
| `runner` | One per run: status, duration, queue wait, cost, tokens, tool calls, failed tools with their error |
| `http` | Requests slower than 1 s, rejected requests (4xx except sign-in, vault-locked and grant prompts), unknown API routes, 5xx with stack; every request with `verbose` |
| `mcp` | Agent tool calls slower than 10 s or returning an error, crashes, unknown tools |
| `db` | Statements slower than 100 ms (SQL only, once a minute each) |
| `perf` | Event-loop stalls over 300 ms, sleep/wake gaps, memory every 30 min |
| `crash` | Uncaught exceptions and unhandled rejections (the core still exits with 1) |
| `ui` | Render crashes, uncaught errors and failed requests that never reached the core (`POST /api/logs/client`, 60 a minute) |

Settings → Logs reads it through `GET /api/logs` (counts, recurring warnings/errors grouped by message without ids and
numbers), `GET /api/logs/entries?level=&search=&limit=` and `GET /api/logs/report[?full=1]`: Markdown for an AI with
the environment, recurring problems, a run summary, slow spots, the tail of `desktop.log` and the newest entries that fit
in 250 KB (`full` = all). `DELETE /api/logs` removes the log files and empties `desktop.log`.

## WebSocket (`/api/ws`)

Server → UI events are defined in `packages/shared/src/events.ts`. The UI keeps React Query caches in sync
(`apps/desktop/src/lib/realtime.ts`). Browser live view frames are only sent to subscribed clients.

## Browser

* One managed Chromium per **browser profile** (global default + optional per workspace/agent/chat), launched with
  `--remote-debugging-port=<free port> --user-data-dir=~/.godmode/browser/<id>` on 127.0.0.1.
* A run on this computer uses its chat's profile (`conversations.browser_profile_id`, picked in the composer), else its
  agent's pinned profile, else its workspace's default profile (`Workspace.browserProfileId`), else the global default
  (a run in a VM browses in the VM instead). A global agent's chat remembers the workspace selected in the sidebar when
  it started (`conversations.workspace_id`) and uses that workspace's default. Delegated work stays in the caller's
  workspace, and for an agent without a pinned profile keeps the profile picked for the caller's chat when it's global or
  in the target's workspace; deleting a profile sends its chats back to their default. Profiles can be reassigned to another workspace
  (`PATCH /api/browser/profiles/:id { workspaceId }`) or picked in the workspace's settings (`browserProfileId`, which
  moves a global profile into the workspace); cookies and sessions travel with the profile. The global default always
  stays global.
* On macOS a visible browser never takes focus: it is started in the background through LaunchServices
  (`open -g`, no startup window) and its first window opens behind the active app.
* Agents get browser tools from the **browser-use MCP server** (`uvx --from browser-use==0.13.10 browser-use --mcp`)
  configured per run via `BROWSER_USE_CONFIG_PATH` → `<data>/browser-use/<profile>/<agent>/runs/<run-id>/config.json`
  (removed with the run, together with browser-use's scratch files next to it) with `browser_profile.cdp_url`
  pointing at the run's chat endpoint (below); downloads land in the agent's `workspace/downloads`.
  LLM-backed browser-use tools (`browser_extract_content`, `retry_with_browser_use_agent`) are only offered when an
  OpenAI key is in the vault (passed via env, never written to disk); otherwise the runner disallows them.
* **Chat tabs** — one profile = one Chromium, shared by every chat that uses it, but each chat works in its **own tabs**,
  so runs on one profile run in parallel with the same cookies and logins (`browser/tabs.ts`, `browser/proxy.ts`):
  * A chat's first tab is a spare blank page (the browser's first window, or a released tab) or a new background
    window (`Target.createTarget { newWindow, background }` — it never takes focus). Tabs it opens itself and popups
    of its tabs (`openerId`) are its own; iframes belong to their page (`parentId`). Tabs nobody owns (a human's) are
    hidden from every chat.
  * browser-use doesn't connect to Chromium directly: each run gets a loopback DevTools endpoint
    `http://127.0.0.1:<port>/<256-bit token>` (`/json/version` + a browser WebSocket; requests with an `Origin` or
    a foreign `Host` are refused) that forwards CDP to Chromium and back, filtered for the run's chat:
    `Target.getTargets` and target events only list its tabs, commands naming another tab (`attachToTarget`,
    `activateTarget`, `closeTarget`, …) or another tab's session answer like a missing target, `Browser.close` and
    browser-target sessions are refused, auto-attach never makes other chats' new tabs wait for a debugger, and
    `Target.createTarget` opens a background window (a plain new tab would land in whichever window was active last —
    maybe another chat's). Target events that arrive before a `createTarget` answer are held until it's clear whose
    tab it is. The endpoint dies with the run. This keeps chats from getting in each other's way; it is no security
    boundary between agents (Chromium's own DevTools port on loopback is unauthenticated).
  * Which tab a chat works in follows its agent (navigation, input and screenshots through the endpoint); live view,
    vault fills (`vault_fill_*` type into the calling chat's tab only) and missing-login detection use that tab.
  * A chat keeps its tabs between messages. They close when the chat is deleted, archived or moved to another
    profile, or after `keepAliveMinutes` without use (an hour when the browser is kept alive) unless a run of the chat
    is going or someone watches its live view; the browser's last page is kept, blank, for the next chat (closing the
    last window would quit Chromium on Windows and Linux). Chromium has one download folder per profile, so two agents
    downloading through one profile at the same moment may find the file in the folder of the one that set it last.
* **On demand**: a run's endpoint only starts Chromium when browser-use first asks for `/json/version`, on its first
  browser tool call, so a run that never browses never opens a browser. A start that fails or outlasts browser-use's
  15 s connect timeout becomes a warning in that run. Idle browsers (no CDP client attached, no watcher, window not
  focused) stop after `browser.keepAliveMinutes` (default 5); browsers an earlier core left running are adopted at
  startup and closed unless something still uses them.
* **Session import** (“continue where Chrome left off”): the importer uses the same technique as browser-use’s
  `profile-use` — copy the Chrome profile’s cookie store to a temp dir, start the real Chrome binary headless on it
  with CDP, read decrypted cookies via `Storage.getCookies`, inject them into the Godmode profile with
  `Storage.setCookies`. `profile-use` itself is supported for syncing to browser-use Cloud profiles.
* **Bot detection** (`browser/stealth.ts`, `settings.browser.stealth`, on by default): Chromium starts with
  `--disable-blink-features=AutomationControlled`, so `navigator.webdriver` stays false on every Chromium build (current
  Chrome already leaves it false with a debugging port; the VM's Chrome gets the flag too). Headless it also gets the
  user agent the same executable sends with a window (`--user-agent`, learned once per executable from a
  throwaway headless launch, so requests, frames and workers agree) and a desktop screen (`--screen-info`), and
  browser-use doesn't emulate a viewport over it (a page larger than its window gives headless away). The one difference
  left: Chrome withholds detailed client hints (full version) while `--user-agent` is set. Takes effect when a browser
  starts; the launch marker records it for adopted browsers.
* **Bot check** (`browser/botCheck.ts`, `POST /api/browser/profiles/:id/bot-check`, Settings → Browser): serves a page
  from a throwaway loopback server into a background window of the profile's browser and judges its navigator, a web
  worker, window and screen metrics, WebGL, plugins, languages, permissions and request headers the way common bot
  detection does (pass / warn / fail per signal). A browser started just for the check (or for a session import) is
  *transient*: it's stopped again afterwards unless someone else got it meanwhile (`ensureBrowser` / `touchBrowser`
  claim it).
* **Live view**: CDP `Page.startScreencast` frames streamed to subscribed UIs; the human can take over
  (click/type) e.g. to solve a CAPTCHA. A view shows the profile's active tab, or with `conversationId` the tab one chat
  works in (`browser.subscribe { profileId, conversationId }`, frames carry `conversationId`; navigate and input take
  it too). Chats show a *passive* preview of their own tab next to the thread once they have one: passive subscribers
  get frames but don't keep an idle browser running. `BrowserProfile.chats` lists the chats with tabs open, and the
  Browser page switches between them.

## Computer use

A chat can **share** something with its agent — `conversations.computer_target` (`ComputerTarget` in
`packages/shared/src/computer.ts`): one app window, one display, the whole desktop or a tab of a Godmode browser.
Agents allowed to use the computer unattended (`agents.computer`, human-only) get the desktop (or one display) for runs
without a share. Runs in a VM get neither: they use the VM's own screen and apps (see macOS virtual machines). A run with a target gets a fourth MCP server, `computer` → `POST /mcp/computer` on the gateway with
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
  the run stops the wait), then `prepareGuest` readies Godmode's agent in the VM (see below). Work meant for a VM never
  falls back to the host: VMs turned off, a missing VM or a VM that can't start fail the run with the reason, and a tool
  that can't be set up in the guest is left out with a notice — never replaced by the host's. The run gets no host
  browser (`browserMcpServer` isn't called) and no host computer use (no unattended access, and a share in the chat
  doesn't apply); runs in the same VM take turns (one screen, one Chrome). The MCP config gets the `vm` server
  (`/mcp/vm`, same run token), the in-guest `browser` and `cua` servers, the system prompt a "macOS virtual machine"
  section (restated in every resumed turn) and `--add-dir <shared folder>`. With
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
* **Godmode's agent in the VM** (`vm/guest.ts`): the browser and computer use of a VM run live in the guest. Claude
  Code starts two stdio MCP servers as `tart exec -i <vm> /bin/zsh -f -c …` (stdio through the Tart guest agent, which
  runs in the guest user's GUI session; no startup files, so nothing the agent puts there can print into the JSON-RPC
  stream; ending the process kills the command's process group): `browser` — browser-use
  (`browser-use --mcp`, pinned like on the host) connected to Google Chrome in the guest (`~/Applications`, own profile
  in `~/.godmode/browser-profile`, DevTools on the guest's `127.0.0.1:9322`, visible on the VM's screen, downloads in
  `~/Downloads`), started again when it was closed — and `cua` — Cua Driver (`cua-driver mcp --direct`), which controls
  the guest's apps and windows; the Cirrus Labs images grant the guest agent (and so everything `tart exec` starts)
  Accessibility and Screen Recording. Everything is installed on first use, shared by concurrent runs: uv is copied
  from the host (the official installer as fallback), Chrome comes from Google's disk image, browser-use and Cua Driver
  are fetched through uv (`uv tool run --from <pinned spec> python …` records the program's path in
  `~/.godmode/stamps`). A tool that failed isn't retried for 10 minutes (or until the VM stops). Vault fills
  (`vault_fill_login`, `vault_fill_totp` — only with `settings.vm.vaultFill`, like `fill_login`) and the missing-login check reach the guest's Chrome over CDP through an SSH port forward
  (`ssh -N -L 127.0.0.1:<free port>:127.0.0.1:9322` with Godmode's key; one per VM, closed when the VM stops). The
  OpenAI key never goes into a VM, so browser-use's LLM tools are hidden there.
* **Human access**: `POST /api/vms/:id/open { what }` opens Screen Sharing (`vnc://admin:admin@<NAT IP>`), Terminal
  (SSH with Godmode's key) or the shared folder in Finder; `GET /api/vms/:id/screenshot` feeds the card preview and the chat's VM panel
  (never boots a VM). Backups carry VM records and assignments, not disks; a restore keeps this Mac's own VM records, and a
  restored VM whose disk is missing shows an error and can be reset.

## SSH servers

Remote machines agents sign in to and control (`packages/core/src/ssh/`, `/api/ssh`, the **SSH servers** page):

* **Records** (`ssh_servers`): name, host, port, user, `auth` (`password` | `key`) and a description agents read. The
  password (for key logins: the password sudo asks for), private key and passphrase are sealed with the vault key
  (`ssh_servers.<field>:<id>`), redacted like other secrets and never returned by the API; `key_info` keeps the key's type,
  fingerprint and public key. Keys are parsed with ssh2 (OpenSSH, PEM, PuTTY; a passphrase is required and checked on
  save), can be imported from `~/.ssh` of the core's machine (`GET /api/ssh/local-keys`, `privateKeyPath`: only files
  listed there) or generated (`POST /api/ssh/keys`, Ed25519).
* **Assignments**: `agents.ssh_server_ids` (every run of the agent) and `conversations.ssh_server_ids` (the chat's
  composer chip, `sshServerIds` on `POST /api/chat` / `PATCH /api/conversations/:id`), JSON arrays. A run gets its chat's
  and its agent's servers (`ssh/assignments.ts`). Only the human assigns: agent management tools can't, and delegated
  conversations start without the caller's chat servers. Deleting a server removes it everywhere.
* **Connections** (`ssh/client.ts`): [ssh2](https://github.com/mscdex/ssh2) (pure JavaScript, native bindings are never
  built, so the compiled core works on every target). One pooled connection per server shared by runs and the human
  (≤ 6 channels, keepalives, closed after 3 idle minutes or when the server changes). Password logins also answer
  keyboard-interactive password prompts. The host key is pinned on the first successful connection (SHA-256 fingerprint,
  like `StrictHostKeyChecking=accept-new`); a different key fails with both fingerprints and must be forgotten by the
  human (`hostKey: null`; changing host or port forgets it too). `POST /api/ssh/servers/:id/test` signs in, pins the key
  and records the OS (`uname` + `/etc/os-release`); `POST /api/ssh/test` tries unsaved settings (secrets left out come
  from the saved server) without recording anything; `POST /api/ssh/servers/:id/exec` is the card's *Run command*.
* **`ssh` MCP tools** (`/mcp/ssh`, `ssh/tools.ts`, only for runs that had servers when they started; the allowed servers
  are re-read on every call, so taking one away applies at once; unknown ids in assignments are dropped):
  `list_servers`, `shell` (command, `cwd`, `stdin`, `timeout_seconds`; `sudo: true` runs `sudo -n` when sudo needs no
  password, else `sudo -S -k -p <random marker>` and writes the saved password only once that marker shows up on
  stderr — so it never becomes input for the command — then the command's stdin; a second prompt means it was
  rejected), `read_file` / `write_file` / `edit_file` (SFTP; `cat` through the shell when a server has no SFTP
  subsystem) and `upload` / `download` (SFTP, any size; local paths must resolve — symlinks followed, dangling ones
  refused — into the run's folders: its working directory, the agent repo, the VM's shared folder and the workspace's
  sources; downloads default to `workspace/downloads`, go to a new file that is renamed into place, and never into a
  `.git` or `.claude` folder). Every result masks the saved password, passphrase and the key's lines. Ending the run
  aborts its in-flight commands (a timed-out command whose process ignores the closed session may keep running). The
  system prompt lists the servers (address, OS, description, whether sudo can be answered) with rules for working on
  real machines; resumed turns restate them. Audit: `ssh.use` (first call per run and server), `ssh.sudo`,
  `ssh.assign` / `ssh.unassign`.

## Automations

An automation (internally a *routine*: table `routines`, `/api/routines`, `routine_*` tools, `state/routines.json`)
runs an agent's prompt when its trigger fires (`Routine.trigger`):

| Trigger | Fires when | How |
|---|---|---|
| `schedule` | the cron expression matches — or, with `startWindowMinutes`, at a random moment up to that long after it | croner job (`scheduler/scheduler.ts`), timezone aware. A random start window gets a one-off job at the start drawn for the next time slot (offset = hash of routine id + slot, so restarts and edits keep it; slots before the last schedule event are skipped); the window may not exceed the gap between two runs (≤ 12 h, gaps shortened by a DST change don't count — `startWindowLimit` in `@godmode/shared`, also used by the UI) |
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

## Follow-ups

An agent that has to wait — for a reply, a delivery, a build, office hours — sets a time to continue the chat on its
own, like a coworker who says "I'll check back tomorrow at 10" (`services/followups.ts`, table `followups`):

* **Setting one**: `followup_schedule({ at | inMinutes, note })` from any run but condition checks, dreams and tasks
  delegated by another agent (those report back to it). `at` is ISO 8601; without an offset it is the core's time
  zone. It must be 1 minute to 1 year ahead; the note loses anything that looks like a Godmode prompt tag. A chat has one follow-up (keyed by
  the conversation): scheduling again moves it, `followup_cancel` removes it, deleting the chat or agent removes it too.
  The system prompt explains when to use it ("Following up later"); resumed turns restate a pending one so a new message
  can move or cancel it.
* **Running it**: one timer armed for the earliest `due_at` of a chat that isn't busy (re-checked at least every
  minute, so sleep and clock changes are caught); a follow-up whose chat is busy runs when that turn finishes. A due
  follow-up is removed first (the run may schedule the next one), then the chat gets a
  system message with a `followup` block (the marker in the thread) and a run with trigger `followup` that resumes the
  same Claude session with a `<godmode-followup>` prompt carrying the note. Follow-ups that came due while Godmode was
  off run on start, marked `late`. One that can't start (agent turned off) is dropped and the human is notified. When
  the run finishes the human is notified too (unless the agent did it with `notify_user`); in a Slack, Telegram or
  Teams chat the answer goes there instead.
* **Runaway guard**: after 20 follow-up runs in a row without a message from the human, an automation or another
  agent, scheduling is refused and the agent is told to ask the human.
* **The human** sees a bar above the composer (continue now, change the time, cancel), a clock in Recent chats and all
  pending follow-ups on the Automations page: `GET /api/followups`, `PATCH|DELETE /api/conversations/:id/followup`,
  `POST /api/conversations/:id/followup/run`. `Conversation.followup` carries the pending one. Backups carry follow-ups;
  a restore drops the ones already due.

## Tasks

A Kanban board of tickets agents work on (table `tasks`, `/api/tasks`, `tasks/service.ts`), per workspace or global.
Columns are the statuses: `backlog` (parked — assigning an agent never starts it), `todo` (queued — entering it with an
agent, or getting one while in it, starts that agent), `in_progress`, `in_review` (delivered, waiting for the human),
`blocked`, `done` and `cancelled`. Positions are REAL values within a column (a move places the task between its new
neighbours; a column is re-spaced when they get too close). A task may only be assigned to an agent of its workspace or
a global one. Every change is pushed as `task.updated` / `task.deleted` and patched into the UI's cached lists.

* **Starting** (`dispatch`): an active run of the task is cancelled first (restart), the task moves to `in_progress`,
  and the agent gets the task in its conversation (`origin = 'task'`, created archived so it stays off the chat list;
  reused while the agent and folder stay the same) as a `trigger = "task"` run. The prompt carries the title,
  description and what to deliver per type: `general` (do it, summarize), `research` (a Markdown report) or `coding`.
* **Worktrees** (`tasks/git.ts`): every task with a repository works in its own git worktree at `<data>/tasks/<id>` on
  its own branch `godmode/<number>-<slug>` (a new task never takes over an existing branch: `-2`, `-3`… when the name
  is taken), so tasks running side by side never touch each other's files or the human's copy. The repository is the
  task's own (`repoUrl` — any URL `parseGitUrl` accepts — or `repoPath`, one of the workspace's folders, checked again
  on every start), else the workspace's first git repository: a cloned URL or a folder that is a repository's top
  level (`WorkspaceSource.git`). A folder's worktree comes from the human's repository itself (its `origin` is fetched
  first when it has one; the task branch lives there; an origin Godmode can't push to, like a local path, counts as
  none); a URL's from Godmode's bare clone of it at `<data>/repos/.tasks/<name>-<hash>.git`, cloned once and fetched
  before each task starts (offline, tasks start from what it has), shared by that URL's tasks. Git work that changes a
  repository's shared refs (fetches, worktrees, pushes) runs one at a time per repository. The branch starts from
  `origin/<base>` (the task's base, the repository's configured branch, else the remote's default branch — in a local
  repository without one, the branch checked out in the folder), or the local `<base>` when origin doesn't have it.
  The same hardened git as workspace clones is used (the human's credential helper / SSH keys, no prompts, no hooks).
  The URL, folder and resolved base are pinned on the task. The worktree is the conversation's working folder — the
  only folder inside the data directory allowed as one; without bypass mode the agent can't edit its `.git` — and the
  workspace's shared copy of the same repository (folder or clone) is left out of the run's `--add-dir` folders, so the
  agent changes the task's branch only. A restart checks the branch out again when its worktree is gone; a leftover
  that isn't a usable worktree (an interrupted creation) is moved to `<data>/repos/.trash`, never deleted; tasks
  started before worktrees keep their full clone. A coding task can't start without its worktree; other tasks work
  without one when it can't be created (with a notification). Deleting a task removes its worktree and prunes it from
  the repository; its branch stays (while the worktree exists, the branch can't be checked out elsewhere — merge it).
* **Coding tasks** publish their branch: when a run succeeds, Godmode commits what the agent left uncommitted (new
  `.env`/key files are left out), refuses to push when the branch adds such files or its diff contains a secret from
  the vault, merges commits someone else pushed to the branch since Godmode's last push (a conflict blocks the task),
  and pushes with an explicit lease on what it saw — so nothing pushed meanwhile is overwritten. It then opens a pull
  request with `gh pr create` (body: the agent's summary, redacted); without `gh`, or for GitLab, the task links to the
  page that opens one. A branch without commits on top of its base goes to review without a pull request; a local
  repository without a remote keeps the commits on the task's branch. Restarting fast-forwards the worktree to the
  remote branch first; only the task's branch is fetched and pushed (nothing is written to the repository's config).
  When a `general` or `research` task's run ends, what it changed is committed on its branch, which isn't pushed.
* **When a run ends** (any run in the task's conversation, so the human's follow-ups count too): succeeded →
  `in_review` (after publishing, for coding tasks), failed or stopped → `blocked` with the reason, and a
  `task_report_blocked` call during the run → `blocked` with what the agent needs. A follow-up puts a delivered or
  blocked task back to `in_progress`; for coding tasks the next push updates the open pull request.
* **Moving on the board**: away from `in_progress` cancels the run (the UI asks first); into `todo` (or
  `in_progress`) with an agent starts it. Every 5 minutes, tasks in review with an open pull request are checked with
  `gh pr view`: merged → `done`, closed → noted on the task.
* **Races**: one start or publish per task at a time; a start the board asks for meanwhile runs once the task is free,
  and a run that ended meanwhile is handled then. Moves caused by the work (to In review, Blocked, Done) only apply
  from the status the work expects — a move the human made meanwhile wins — and put the task at the top of its column.
* **Agents managing the board**: `task_create` / `task_update` follow the delegation rules (no reveal-mode or unattended
  computer agents from callers that couldn't use them, VM-kept runs stay off the host); coding tasks created by agents
  use the workspace's repositories; and a run working on a task — or delegated from one — can't start a manager agent
  (itself included), so tasks can't spawn tasks without end. Follow-ups wait while Godmode prepares or publishes a task. Task numbers are never reused.
* **Restart**: tasks left `in_progress` without a live run are blocked ("Interrupted"), tasks waiting in `todo` with an
  agent are started. Deleting a task cancels its run and removes the worktree (the conversation and the branch stay); deleting a
  workspace counts its tasks as dependents.

## Integrations

* **Custom MCP servers** (stdio/http/sse), scoped global / workspace / agent; env + headers encrypted.
* **API tools** (`api_tools`, `integrations/apiTools.ts`, `/api/api-tools`, Integrations → Tools): an API key with what
  it's for, docs (Markdown and/or a link), the API's address (`base_url`) and where the key goes (`auth`: a header with an
  optional prefix, or a query parameter), scoped global / workspace / agent like MCP servers (shared ones only for agents
  that inherit shared integrations). The key is sealed (`key_enc`, AAD `api_tools.key:<id>`) and write-only.
  * Agents with tools get an "API tools" section in the system prompt (restated on resumed turns) and the gateway tools
    `api_tools_list` / `api_tool_docs` / `api_tool_request` (`integrations/apiToolRequest.ts`). A request goes to a path
    relative to `base_url` (or a full URL under it — anything else is refused, `..` included); Godmode adds the key, drops
    a header of the same name from the agent, follows redirects only while they stay under the address, masks the key in
    everything returned and audits the call (`api_tool.request`).
  * Files both ways: `{ "$file": path }` sends a file (base64 or a data URL in `json`, an upload in `form`, raw bytes as
    `body`); binary responses and base64/data-URL files inside JSON (sniffed or typed by a sibling `mimeType`) are saved to
    `workspace/api-tools/` (the VM's shared folder in VM runs) or `saveAs`. Both only reach the run's own folders (agent
    repo, chat folder, workspace folders, VM shared folder), symlinks resolved; files are never written through a link,
    over an existing file in a folder, or into hidden paths (`.git`, `.claude`…), and `saveAs` is checked before the
    request is sent. Files in a response that contain the key aren't saved; text is masked before it's cut or saved.
  * `env_var` (opt-in) also puts the key into the environment of runs on this computer for scripts and SDKs; the agent
    can then read it (the most specific tool wins a name). Names must end in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`
    (checked again when a run starts, e.g. after a restore) and can't use prefixes of Godmode, Claude and common tools, so a tool can't set `HTTPS_PROXY` or `BASH_ENV`. Turning that on for a saved key, or
    moving a saved key to an address outside the current one, needs a vault grant unless a new key comes with it.
  * `POST /api/api-tools/:id/test` GETs `test_path` with the key (Test / Save & test in the UI).
* **Composio** (v3.1 REST, `x-api-key`): browse toolkits, connect accounts via `connected_accounts/link`
  (`user_id` = `global` | `ws_<workspaceId>` | `agent_<agentId>`), and expose them to agents through a Tool Router
  session MCP URL (`POST /api/v3.1/tool_router/session`). Connected accounts can also start automations (app
  triggers, see Automations); an automation may only watch accounts its agent could use.

## Messaging

People talk to agents from Slack, Telegram and Microsoft Teams through a bot the human connects (`messaging/`,
`/api/messaging`, the **Messaging** page). A connection (`messaging_connections`) holds the bot's tokens sealed in the
vault (`secrets_enc`, redacted like other secrets), the agents it reaches (`agent_ids`, new chats start with
`default_agent_id`) and who may use it (`access`). Adapters run while the connection is enabled and the vault is
unlocked (tokens stay in memory when it locks later):

| Platform | Transport | Setup |
|---|---|---|
| Telegram | Bot API long polling (`getUpdates`, offset kept in `state`); a webhook set elsewhere is removed | token from @BotFather |
| Slack | Socket Mode (`apps.connections.open` → WebSocket, acks every envelope, pings to detect dead sockets); DMs, mentions in channels (answered in the thread), the `/godmode` slash command (answered privately via `response_url`) | app from Godmode's manifest (`slackManifest`), bot token `xoxb-` + app-level token `xapp-` |
| Teams | Azure Bot (single tenant) delivering to `POST /hooks/messaging/<token>` (public, exempt from the loopback Host check like webhooks; the token is stored as a SHA-256 hash and sealed). Every delivery must carry a Bot Framework JWT (RS256 against the published keys, `iss`, `aud` = app id, expiry, `msteams` endorsement, `serviceurl` claim), come from `msteams` and the configured tenant. Answers go to the Teams connector hosts only, with a client-credentials token | app id, tenant, client secret, public https address; the UI builds the Teams app package (manifest + icons) |

**Access**: with `approved` (default), someone new is recorded in `messaging_users` as pending, told the bot is private
and the human is notified; approving sends them a welcome in their direct chat. Blocked people are ignored. `anyone`
lets everyone who reaches the bot in (it needs a vault grant, and so does widening an open bot: more agents, turning it
back on). **Chats** (`messaging_chats`): one per DM, group, Telegram topic or Slack thread, each continuing one
conversation (origin `slack` / `telegram` / `teams`, with standing instructions naming the platform and saying names are
unverified). Messages of a chat are accepted in order; each starts a normal chat run, the platform shows typing (Slack:
an 👀 reaction) and the answer is converted (Telegram HTML, Slack mrkdwn, Teams Markdown) and split. Chat commands:
`/help`, `/agents`, `/agent <name>` (switch; in a Slack thread the channel follows), `/new`, `/stop`; Slack uses
`/godmode <command>`. Claude Code's own slash commands are not available from chats. Attachments (≤ 25 MB, Telegram ≤ 20 MB)
are downloaded into the agent's uploads. Limits: 20 messages per chat and 120 per bot per minute. Backups carry
connections but restore them turned off, so two machines never answer for one bot.

## Phone app

The phone app (`apps/mobile`) controls one computer's Godmode: chats, runs, agents, automations, VMs and the live
views. `mobile/` in the core pairs phones and serves them; the desktop's Settings → Phone manages both.

* **Transport: Tailscale.** With phone access on (`settings.mobile`, off until the first QR code), `mobile/access.ts`
  runs a second `Bun.serve` on this computer's Tailscale IPv4 address only (`settings.mobile.port`, default 7787),
  never on the LAN. The address comes from `tailscale status --json` (the CLI on PATH or inside Tailscale.app), else
  from a network interface in 100.64.0.0/10; it is re-checked every 30 s and the listener moves with it. Tailscale
  encrypts and authenticates the traffic end to end (WireGuard), so the listener speaks plain HTTP. It checks the Host
  header against the Tailscale address and MagicDNS name, answers only `/api/*` (not `/api/auth/*`, the dashboard,
  `/mcp` or `/hooks`), accepts only device tokens (`c.env.channel = "mobile"`; the access token and dashboard sessions
  get 401) and upgrades `/api/ws` with the device token in the `Authorization` header.
* **Pairing.** `POST /api/mobile/pairing` (desktop) creates a one-time code (32 random bytes, only its SHA-256 kept in
  memory, 5 minutes, a new one replaces the old) and returns `godmode://pair?d=<base64url JSON>` with the instance id,
  the computer's name, the URLs (MagicDNS name first, then the IP) and the code (`encodePairingLink` in
  `@godmode/shared`). The desktop draws it as a QR code. The phone posts the code to `POST /api/mobile/pair` (public,
  rate limited like sign-in) on the first URL that answers, checks the instance id and gets a device token
  (`gmd_` + 32 random bytes); the row in `mobile_devices` keeps its SHA-256, name, model, last address and last use.
  Pairing is audited (`mobile.pair`), notifies the human and emits `mobile.paired`.
* **Scope.** Device tokens only authenticate on the phones' listener while phone access is on, and open a fixed
  allowlist of routes (`mobile/scope.ts`): bootstrap, workspaces, agents, conversations and messages, runs (cancel),
  routines (run, enable), browser profiles (input), computer input, VMs (list, screenshot, start/stop), notifications,
  missing logins and `GET/DELETE /api/mobile/me`; everything else answers 403 `device_forbidden`. Bodies are
  restricted too: a phone can't set a chat's folder, VM, browser, shared screen or instructions, or change an
  automation beyond switching it on or off, and it only watches and controls screens that are shared in a chat
  (`computer.subscribe` and `/api/computer/input`). The listener checks the decoded path, so `/api/%61uth/…` is refused
  like `/api/auth/…`.
* **Key hygiene.** The app only sends its key over plain HTTP to a Tailscale address (100.64.0.0/10 or `*.ts.net`;
  https anywhere, for a future gateway — `isPhoneUrlAllowed`), and first asks the address's `/api/health`, which on
  the phones' listener returns the instance id; an address that answers as another instance never gets the key.
  Writes are sent once (no retry on another address), so a slow network never duplicates a message or a run.
* **Realtime.** Phone sockets get every event except `run.delta`, which only goes to conversations they subscribed to
  (`conversation.subscribe`) — streaming replies are large. New sockets are sent the current `run.activity` of every
  run. Browser and computer frames are opt-in as for the desktop; VM screens are polled (`/api/vms/:id/screenshot`).
* **Removing a phone** (`DELETE /api/mobile/devices/:id`, or the phone itself via `DELETE /api/mobile/me`) deletes the
  row and closes its sockets with code 4003; the app then forgets its token. Backups carry neither the devices nor the
  `mobile` settings.
* **The app** keeps the token and URLs in the Keychain / Keystore (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), tries the
  URL that answered last and falls back to the others, and treats 401 as "removed". It opens its WebSocket only in the
  foreground. An optional Face ID lock covers the app in the app switcher.

A hosted gateway can later be added as another URL in the pairing link.

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
