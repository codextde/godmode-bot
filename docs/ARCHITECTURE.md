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
| `apps/cloud` | Godmode Cloud, optional and self-hosted (Next.js + a custom Node server, PostgreSQL): accounts, admin, Stripe billing and the relay to linked computers. See [Godmode Cloud](#godmode-cloud). |
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
link-key              0600 — this installation's X25519 key pair for the runner link (see "Remote runners")
runner.json           a runner only (~/.godmode-runner, GODMODE_RUNNER_HOME): pid and ports while it serves
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

### Files and folders in chat messages

A chat shows the pictures its messages name and links every other file or folder to the file manager — the message
itself stays as the agent wrote it. The UI collects what could be a path (inline code, link and image targets, bare
absolute paths; `fileRefs` in `@godmode/shared`, which skips code blocks and lines over 4,000 characters) and asks
`POST /api/conversations/:id/files {messages: string[][]}` which of them exist (`services/chatFiles.ts`); messages that
ask within the same moment share a request.

* **Lookup.** Absolute paths, `~/…` and `file://` urls are taken as they are. A relative one is tried in the chat's
  folder, the agent's repository, its `workspace/` and the workspace's folders, then next to the other paths of the same
  message — a bare name there first ("the screenshots are in `workspace/shots/`: `01.png`, …"). A trailing `:line` is
  dropped; other urls, network paths (`//server/…`) and names right below the root (`/tasks` is a route) are never
  followed.
* **Pictures** (png, jpeg, gif, webp, avif, bmp up to 25 MB: named like one and told by their first bytes) come from
  `GET /api/files/image?path=`, which serves nothing else and opens regular files only. One that stands alone in a
  paragraph is shown in its place, a list of nothing but pictures as a grid; one named within a sentence or a mixed
  list stays a link and is shown below it. Each opens a preview that steps through the pictures of the message.
* **Show in Finder.** `POST /api/files/reveal {path}` selects a file in its folder and opens a folder (`open`,
  `explorer.exe`, `xdg-open`, never through a shell). A folder with an extension (its own, or the one a link leads to) is
  selected instead, so an app bundle is never launched. It answers only requests from this computer (loopback, no
  forwarding header, a page loaded from this computer) — `local` in the lookup's answer says so, and from anywhere else
  the UI copies the path instead. Phones reach none of the three routes.

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
  login rate limiting, strict CSP for the dashboard. Requests relayed by a linked Godmode Cloud never use these
  credentials; see [Godmode Cloud](#godmode-cloud).
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
       --settings <tmp json>                   (the message-queue hook, see below; `ultracode: true` with Ultracode)
       [--disallowedTools mcp__browser__browser_extract_content,… when no OpenAI key or in a VM; Bash in a VM]
       [--add-dir <VM shared folder> when the run works in a VM]
       [--add-dir <folder or clone> for each usable workspace folder and repository]
       (prompt is written to stdin)
cwd = agent repo, or the conversation's / agent's folder (then also --add-dir <agent repo>)
```

Stream events are converted into `MessageBlock[]` (text, thinking, tool_use + result) and pushed as
`run.delta` WS events; the final assistant message is stored in SQLite and in the agent repo.
A long run has hundreds of blocks and megabytes of tool output and screenshots, and all but the last few never change
again: each block is masked and serialized once and made again only when it changed (or when the vault learned or
forgot a secret). A delta carries what changed (`patch`, see WebSocket); the row saved every few seconds while the run
works is put together from the serialized blocks, less often the longer saving takes (never more than 1/50 of the time).
Claude Code reports a run's cost as the total of its whole Claude session, so on a resumed session the chat's earlier
runs are in it: the run is charged that total minus what the session had counted before
(`conversations.claude_session_cost_usd`). A process can end more than once (a background task that finishes wakes it
for another turn); time, turns and tokens of the endings add up.
Concurrency is limited by `settings.runner.maxConcurrentRuns` (queue). A per-conversation lock prevents
two concurrent turns in the same conversation. Runs sharing a browser profile don't wait for each other: every chat
works in its own tabs (see Browser).

### Ultracode

Claude Code's Ultracode — dynamic workflows on every task, at any effort level — is a setting of the session, not a
flag: the runner adds `ultracode: true` to the run's `--settings` file. Whether it is on: the chat
(`conversations.ultracode`, from the model picker or `/effort ultracode [on|off]`), else the agent, else
`settings.runner.ultracode`. Dreams and condition checks never get it.

* **Availability.** The model catalog probe asks Claude Code (`get_settings` after `initialize`) whether the install has
  dynamic workflows; a model has `ultracode` when it does and the model supports `xhigh` effort (Claude Code's rule).
  The answer is about the probe session's model: when that one has no `xhigh`, the probe switches the session to a
  model that has (`set_model`) and asks again. The UI offers the switch only for such models, and `ultracodeFor` drops
  the setting for the others — an older CLI never sees the key.
* **Without full bypass** the `Workflow` tool joins `--allowedTools`: print mode cannot ask, and Claude Code refuses a
  workflow nobody reviewed.
* **Progress.** A workflow runs in the background of its `Workflow` tool call. Claude Code reports it as `system`
  events (`task_started`, `task_progress`, `task_updated`, `task_notification`); the stream accumulator keeps them as
  `task` on that `tool_use` block (status, current activity, its agents with their state), which the chat shows as a
  card. The process stays until the workflow is done and then sends one `result` per turn; the last one is the answer,
  their usage adds up (the tokens of the workflow's agents are on the `task`, not in the run's usage). A pause ends
  the process and with it the workflow: its `task` is `stopped`, and the continued run starts it again if it needs it.

### Message queue

A message the human sends while the agent works in the chat doesn't become a run that waits for the whole task. With
`queue: true` on `POST /api/conversations/:id/messages` (the desktop app always sends it) it is stored in `queued_messages`
and the answer is `{ queued }` (202) instead of `{ message, run }`; without the flag — the phone app, the messaging
bridge, older clients — a message still gets a run of its own behind the running one. `services/messageQueue.ts`:

* **Picked up mid-run.** Every run except dreams and condition checks gets a `--settings` file with a Claude Code
  `PostToolBatch` HTTP hook pointing at `POST /mcp/hooks/post-tool-batch` (the run's bearer token). Claude Code calls it
  after each batch of tool calls, before the next model call; when messages wait, the answer hands them over as
  `additionalContext`, quoted in `<message-from-human>` tags, and the agent decides how they fit into what it is doing.
  They leave the queue and appear in the running assistant message as `user_message` blocks at that point. Steps of a
  subagent (`agent_id` in the hook input) take nothing.
* **Started as the next turn.** What still waits when a run ends by itself (finished or failed) starts one run: every
  message becomes its own user message, the prompt is all of them. A slash command only works at the start of a turn, so
  it is never handed over mid-run and always starts a turn of its own; messages behind it wait for the turn after.
* **Stop means stop.** A cancelled run (Stop, a deleted agent or task, shutdown) never hands over to the queue: the
  messages stay, shown as not sent, and go first with the human's next message or with **Send**. The same holds after a
  restart — the table survives it.
* **Edited, removed, sent now.** `PATCH` / `DELETE /api/conversations/:id/queue/:messageId` (404 once the agent has the
  message) and `POST /api/conversations/:id/queue/send`, which stops the running run and starts the queue (or just
  starts it when nothing runs). Every change goes out as `queue.updated` with the whole queue;
  `GET /api/conversations/:id` carries it as `queue`. A client may name the queued message itself (`queueId`), so its
  row is the same before and after the answer.
* The table keeps the redacted text; what the human typed stays in memory for the prompt. A message that contains a
  saved secret can't be edited (the editor would only see the mask).

### Pause and continue

A run can stand still and continue later (`services/pauses.ts`, `runner.ts`). It has not ended: its status is `paused`,
it keeps its row, its assistant message and its Claude session, and nothing that waits for its end (a task, an
automation's events, a delegating agent, a platform chat) is told anything — there is no `run.finished`, only
`run.paused`. Table `paused_runs` holds what continuing needs (one per chat) and why it stands still: paused by the
human (`user`), Claude's usage limit (`limit`) or a question for the human (`question`, see Questions and approvals —
only an answer continues it); `Conversation.paused`, `Task.pause` and `Agent.pausedRuns` carry it to the UI.

* **Pausing** (`POST /api/conversations/:id/pause`, `POST /api/agents/:id/pause` for everything an agent works on):
  while a step runs, the `PostToolBatch` hook answers `{ "continue": false }` when Claude Code asks between two steps,
  so the step finishes and the session ends cleanly. With no step running, or when the step takes longer than 8 s, the
  process is stopped like a cancelled run; text and tool calls the model was still writing are dropped (they are not
  in its session); a run that finishes in that moment is finished. Dreams and condition checks can't be paused. Work
  the run delegated is stopped.
* **Claude's usage limit.** A run that ends because a limit was reached — Claude Code's own "You've hit your … limit"
  line, or refused requests (429) while Claude reports the limit — is paused instead of failed. The name of the limit
  and its reset time come from `rate_limit_event` (status `rejected`), which alone proves nothing: requests still go
  through on usage credits. With `settings.runner.autoContinueOnLimit` (default on, per run with
  `PATCH /api/conversations/:id/pause { auto }`, which the run keeps) a timer continues it 30 s after the reset — also
  after a restart. A limit that is still there adds a marker and waits for the next reset; after three such tries by
  the timer in a row the run waits for the human. One notification per limit and reset. Checks, dreams and delegated
  runs fail as before.
* **Continuing** (`POST /api/conversations/:id/continue`, `POST /api/agents/:id/continue`): the run goes back into the
  queue ahead of what waited behind it, with the blocks it had (`pause` blocks mark where it stood still), and the next
  `claude -p --resume` gets a `<godmode-continue>` note to pick the work up where it stopped instead of the prompt.
  Cost, time, turns and tokens add up over the stretches (the budget is what is left); the raw run log is appended to.
  What never reached Claude (paused while queued or starting, a limit on the first request) is sent again — after a
  restart with saved secrets masked. When the session is gone, the new one gets the recap with the run's own task.
* **A paused chat is frozen.** Runs that come after the paused one wait for it (also its follow-up). Messages wait in
  the queue: the run takes them along when it continues. Writing to a chat the human paused continues it — from the
  desktop app with the message, from the phone or a platform chat with the message as the turn after; while a limit is
  reached the message waits for the reset (*Send now* tries at once). A platform chat is told that the chat is paused
  or waits for the limit, and gets the answer when the run has continued; a delegating agent that waits for a run is
  told when it is paused.
* **Stopping** a paused run (`POST /api/runs/:id/cancel`, deleting its chat, agent or task, moving its task off In
  progress) ends it as `cancelled`, like a run stopped while it worked. Backups carry paused runs; after a restore none
  continues by itself.

### Questions and approvals

An agent that needs the human asks and waits, instead of ending its turn with a question in prose
(`services/questions.ts`, table `questions`, `AgentQuestion`):

* **Asking.** `ask_human({ question, context?, options? })` asks for a decision (2–4 suggested answers, at most one
  `recommended`; the human can always answer in their own words), `request_approval({ action, reason, affects })` asks
  for an OK before one specific step. Every run gets them except condition checks, dreams and delegated runs (their
  system prompt tells them to name what needs deciding in their answer, so the agent that handed the task over can ask).
  The system prompt's "Asking" section says when asking is right; Claude Code's own `AskUserQuestion` is disallowed.
  Text is redacted and loses Godmode's note tags. Refused: a second question in the same step, a question while a
  message from the human waits in the chat's queue (it may already answer it), more than 10 per run, and asking while
  the run is being stopped or paused.
* **Standing still.** The question goes on the job and as a `question` block into the turn; the run is paused with
  reason `question` at its next step (the PostToolBatch hook answers `{ continue: false, stopReason: "Waiting for the
  human's answer" }`, else after the pause grace). A run that asked stands still however its process ended — also
  when it ended by itself or hit the usage limit — unless it was stopped, timed out or broke off. The `questions` row
  and the `paused_runs` row are written in one transaction, so an open question always has a run that waits for it;
  `startPauses` repairs what doesn't fit after a restart or restore (an open question without its pause is withdrawn, a
  question pause without its question becomes reason `user`). Then the human is told: a `question` notification
  (toast with *Answer*, OS notification), `question.created`, audit `question.ask`. `Conversation.paused.question`,
  `Task.pause.question` and `Agent.openQuestions` carry it to the UI; `Agent.pausedRuns` doesn't count it.
* **Answering.** `POST /api/questions/:id/answer` with exactly one of `optionId`, `decision` (`approve` | `decline`,
  optional `note`) or `text` (with files). A message to the chat (`POST /api/conversations/:id/messages`, also with
  `queue`) or to its task (`POST /api/tasks/:id/messages`) is the answer: an option's label or number picks it, a few
  plain words approve or decline, anything else is the human's own words; slash commands are not answers. The answer is
  stored redacted on the question and in its block, and the same run continues in the same Claude session with a
  `<godmode-continue>` note: the decision in Godmode's own words (built from the stored status), the question in
  `<your-question>` and the answer in `<answer-from-human>` tags, both stripped of note tags. Continuing without an answer
  is refused (409 `needs_answer` — the chat's Continue, Send now, the agent's Continue). An answer the agent hasn't read
  (the continued run was paused again before it started, or broke off) is kept: re-sent on continue, or put in front of
  the chat's next run (`answer_owed`). It counts as read the moment Claude starts replying (not when the run ends, so a
  crash later can't hand an approval over twice), and the human stopping the run drops it (except when queued
  messages take over: then it goes along with them), so no later turn is told to do a step the human stopped. A reply
  sent while the agent is still asking (before its run stands still) waits up to 15 s and then counts as the answer.
  Audit `question.answer`; the notification is marked read.
* **Withdrawing.** Stopping the run (`POST /api/runs/:id/cancel`, deleting the chat, agent or task, moving the task off
  In progress) withdraws the question; deleting the chat removes it. A question asked by an automation keeps the
  automation busy: skipped ticks say so and remind the human at most once a day.
* **Who may answer.** Only the human: the API (desktop, dashboard, a paired phone — no files), the chat and the task.
  In Slack, Telegram and Teams only the person the human marked as themselves (*This is me* on the bot's people,
  `messaging_users.is_owner`, one per bot, audited) gets the question posted and can answer; everyone else is told the
  agent is checking with the owner. An answer given in Godmode is followed back into the platform chat. Agents have no
  tool that answers.

## Team

Agents form a team with the built-in agent on top (it reports to the human). `shared/team.ts` holds the rules, used by
the core, the desktop and the phone alike.

* **Role and lead.** `agents.role` is a job title (one line, at most 60 characters, no `<`/`>`; agent-written ones pass
  `redact()`). `agents.reports_to` is the agent's lead; NULL = the built-in agent, whose own `reports_to` is always NULL
  (its id given as a lead is stored as NULL). A lead is a global agent or one of the same workspace, never the agent
  itself or one of its reports (`leadProblem`; `resolveLead` answers 400 with the reason). There is no foreign key:
  deleting a lead moves its reports up to the deleted agent's lead (read inside the delete transaction), moving an
  agent into a workspace lets go of reports from other workspaces and resets a lead from elsewhere, and
  `repairReportingLines()` (startup and after a restore) nulls leads that are gone, self, out of scope, the built-in
  agent or part of a loop. Reporting lines grant nothing: who an agent can hand work to stays `peersFor` (scope via
  `withinReach`, enabled, `delegateTo`) plus the reveal/VM/computer refusals and depth 3. An agent can't set a lead it
  couldn't hand work to itself (one that reads secrets in plain text, or controls the computer on its own).
* **In the prompt.** Every run except dreams gets a "Your team" section in the system prompt (`prompt.ts`
  `teamSection`): its job, the reporting line up to the human, and — when it may delegate — the teammates it can reach
  with role and *(your lead)* / *(reports to you)*; otherwise the reports it can reach. Names, roles and descriptions
  are put on one line with tags removed. Delegated runs are told their answer goes back to the teammate; other runs
  say in their answer what is above them (or hand that part to their lead when they can reach it and it doesn't manage
  agents — a decision steered towards a manager goes to the human instead). CLAUDE.md is not touched by team changes.
* **Last run failed.** `agents.failed_run_id` is set in `finalize` when a real run (not a dream or a condition check)
  fails, and by `recoverInterruptedRuns` for runs that were working when Godmode stopped; it is cleared by a later run
  that succeeds, a run the human stops (in a chat, on the board, on a chat platform, or a paused one; `cancelRun(…,
  { byHuman })`), deleting that run's chat, or `DELETE /api/agents/:id/failed-run`. `Agent.status`
  reads `"error"` while it is set; the status column itself holds only idle/running.
* **Presence.** `agentPresence()` decides what an agent is doing — switched off, working (running runs only; queued is
  never working), needs you (an open question or a missing login), last run failed, paused, queued, idle — and
  `presenceLabel()` words it, so cards, the org chart, the agent page and the phone agree. A new socket's `hello`
  carries `activeRunIds` and a `run.started` follows for each active run, so the app drops runs that ended while it
  was away and shows queued runs as queued after a reload.
* **Who wrote a message.** `messages.source` marks user turns the human didn't write: `automation` (scheduler, app and
  condition automations), `delegation` (`agent_delegate`, an agent's `task_message`) and `task` (the board's prompt).
  The human's own messages, including feedback on a ticket, carry none. The thread shows sourced turns as labelled
  cards, transcripts name the speaker from it, and the recap after a lost session labels them.
* **Handoffs both ways.** `Conversation.delegatedFrom` is derived (a join through the chat's first run's parent run),
  so it goes null by itself when the asking agent or chat is deleted. `GET /api/runs?parentRunId=` lists what a run
  handed over; the handoff card, the run sheet ("Handed on") and the chat header ("From <agent>") use it.
* **Duplicate.** `POST /api/agents/:id/duplicate` copies an agent's setup under "<Name> copy" — not its memory, chats
  or automations; a copy that may read secrets needs the passphrase; audited as `agent.duplicate`.
* **Switched off.** `POST /api/conversations` refuses a switched-off agent (409); its existing chats show a bar with
  *Switch on* and keep the draft.
* **Restore.** Migration 53's backfill (`TEAM_BACKFILL_SQL`: the built-in agent's role, message sources of old
  automation/handoff/board prompts, "Run task" chats from origin `api` to `chat`) runs again after a restore, followed
  by `repairReportingLines()`.

## Godmode MCP gateway tools (`/mcp`)

| Tool | Purpose |
|---|---|
| `vault_list_logins({ domain? })` | Logins available to this agent (no secrets) |
| `vault_fill_login({ credentialId, field: "username"\|"password", selector? })` | Type a secret into the browser page |
| `vault_fill_totp({ credentialId? , totpId?, selector? })` | Type the current 2FA code into the page |
| `vault_get_login({ credentialId })` | Reveal username/password — only when `secretAccess = "reveal"` |
| `vault_get_totp({ totpId })` | Reveal current code — only in reveal mode |
| `report_missing_login({ service, url, kind, reason })` | Tell the human a login/account/2FA is missing or broken |
| `agents_list()`, `agent_get({id})` | Discover peer agents: role, who they report to (`relation` marks the caller's lead and reports), and for `agent_get` who reports to it (only agents the caller could reach) |
| `agent_delegate({ agentId, task, wait })` | Hand a task to a peer agent (optionally wait for its result). The chat stores the bare task (`source: "delegation"`); the run's prompt starts with `[Delegated by <name> (<role>), your lead. Your final answer goes back to <name>.]` |
| `agent_create`, `agent_update`, `agent_delete`, `routine_list`, `routine_create`, `routine_update`, `routine_run`, `routine_delete`, `automation_triggers_list`, `automation_events_list`, `runs_list`, `workspaces_list`, `tasks_list`, `task_get`, `task_create`, `task_update`, `task_message` | Management tools — only for agents with `canManageAgents` (the built-in *Godmode* agent). `agent_create` / `agent_update` also set `role` and `reportsTo` |
| `automation_check_result({ met, observation, summary })` | Only in condition-check runs: report whether an automation's condition holds (see Automations) |
| `task_note({ text, taskId? })` | A progress note on the ticket the run works on (managers: any ticket); on its timeline, nobody is notified |
| `ask_human({ question, context?, options? })`, `request_approval({ action, reason, affects })` | Ask the human a question or for an OK and stand still until the answer; the run continues with it (see Questions and approvals). Not in condition checks, dreams or delegated runs |
| `task_report_blocked({ reason })` | Only in runs working on a board task: say what's missing (access, an account, information nobody can give now); the task moves to Blocked when the run ends (see Tasks). Decisions and OKs go through `ask_human` / `request_approval` |
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
| `runner` | A run's start, and one entry when it ends: status, duration (`ms`: Claude's own, `wallMs`: by the clock), queue wait, cost, tokens, tokens read per turn (`contextTokens`), the session's total on a resumed one, tool calls, failed tools with the head and end of their output, how heavy the message got (`blocks`, `resultKb`, `images`, `imageKb`, `deltas`, `slowestSaveMs`) |
| `http` | Requests slower than 1 s (`expected` when the route waits by design — `expectSlow`), rejected requests (4xx except sign-in, vault-locked and grant prompts), unknown API routes, 5xx with stack; every request with `verbose` |
| `mcp` | Agent tool calls slower than 10 s or returning an error, crashes, unknown tools |
| `db` | Statements slower than 100 ms (SQL only, once a minute each, with how often it was that slow meanwhile) |
| `perf` | Event-loop stalls over 300 ms with what the core was doing (`during`: slow synchronous work noted through `diagnostics/slow.ts`) and the runs at work; a sleep after real use or under a run (`sleptAt`; the stirring of a sleeping computer is only counted); every 30 min memory, database size, connected UIs and those sleeps — "high memory use" once, and again when it grew by a quarter |
| `browser` | A browser that went away by itself: whether its process was still alive, how the connection ended, how long it ran and sat idle |
| `sources` | A failed clone or update with git's own words, the step and how long it took |
| `crash` | Uncaught exceptions and unhandled rejections (the core still exits with 1) |
| `ui` | Render crashes, uncaught errors and failed requests that never reached the core (`POST /api/logs/client`, 60 a minute) |

Settings → Logs reads it through `GET /api/logs` (counts, recurring warnings/errors grouped by message without ids and
numbers), `GET /api/logs/entries?level=&search=&limit=` and `GET /api/logs/report[?full=1]`: Markdown for an AI with
the environment (with the build's commit), recurring problems, a run summary (cost by agent, runs that took far longer
by the clock than Claude worked), memory and sleep, slow spots (requests, by-design waits apart, tool calls, queries,
stalls and what blocked them), the tail of `desktop.log` and the newest entries that fit in 250 KB (`full` = all). `DELETE /api/logs` removes the log files and empties `desktop.log`.

## WebSocket (`/api/ws`)

Server → UI events are defined in `packages/shared/src/events.ts`. The UI keeps React Query caches in sync
(`apps/desktop/src/lib/realtime.ts`). Browser live view frames are only sent to subscribed clients.

`run.delta` counts up per stretch of a run (`stream`, `seq`: a paused run continues in a new stretch). A client that
says `deltas.patch` gets only what changed (`patch`: `[index, block]` pairs, `length`: how long the list is afterwards)
and applies it with `applyRunDelta`; when a delta doesn't fit what it has (one was missed), it asks for the whole list
with `run.resync`. A client that connects, or a phone that
opens a chat, is sent the whole list of what runs there. Clients that don't ask for patches (older phone apps) get the
whole list, at most once a second per run.

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
  `<data>/cua-driver`; it is downloaded in the background on first use — an agent's action or opening the share picker
  starts it; the macOS helper acts meanwhile, elsewhere an action waits up to 20 s and the picker says it is under way;
  status checks never start one, also in place of an installed
  `cua-driver` older than the pin (which is used only without uv, and flagged in the system check). Its pixel coordinates refer to its last screenshot
  of the window, so all calls go through one queue and that size is tracked. Element tokens that a newer driver
  snapshot made stale are re-resolved by role/label/position. On macOS the native helper backs it up: window capture
  for the live view, scrolling (through the scroll area's accessibility scroll bars — posted wheel events don't reach
  background windows), and pointer/keyboard delivery with `CGEventPostToPid` + `AXPress` when the driver refuses a
  window it can't match in the accessibility tree.
* **Desktop / display** — the native helper, every monitor: macOS `native/macos/GodmodeComputer.swift` (ScreenCaptureKit,
  global CGEvents; embedded into the compiled core by `scripts/build.ts`, extracted to `<data>/bin`, compiled with
  `swiftc` when running from source), Windows a PowerShell-hosted C# class (`helpers/windowsHelper.ts`: `Screen.AllScreens`,
  `CopyFromScreen`, `SendInput`), Linux/X11 `xrandr` + ImageMagick `import` + `xdotool`. Without one, Cua Driver's
  desktop target covers the primary display (the driver scales desktop pixels by how much its last desktop screenshot
  was downsized, so the client sends them at that size). Desktop runs take turns (one mouse); window/tab shares only
  lock themselves.
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
  for edits), `info`, `permissions` (below) and `screen` — the computer-use action vocabulary (screenshot, clicks, drag, scroll, type, key,
  zoom) over the guest's macOS Screen Sharing on the VM's NAT address (`vm/vnc.ts`: RFB 3.8/3.889 client with Apple
  Remote Desktop authentication, raw 32-bit updates, pointer/key events; `vm/raster.ts`: crop, area-average downscale,
  PNG). Long or non-ASCII text is pasted through the guest clipboard. Screenshots remember their frame, so model
  coordinates map back to framebuffer pixels. (Tart's `--vnc-experimental` server is not used: it listens on every
  network interface.) `fill_login` / `fill_totp` type vault secrets into the focused field (optionally clicking a
  `coordinate` first) when `settings.vm.vaultFill` allows it; a password needs `kCGSSessionSecureInputPID` in the guest's
  `ioreg` (the app that owns it is named in the result and the audit entry). The value is never in a tool result.
* **Privacy permissions in the guest** (`vm/permissions.ts`): the `permissions` tool (`grant` / `revoke` / `list` /
  `denied`) lets the agent set macOS's privacy permissions (TCC) for the VM's software itself, so no dialog waits for a
  human. The Cirrus Labs images run with System Integrity Protection off, so an entry is a row in a SQLite database:
  the system one (`/Library/Application Support/com.apple.TCC/TCC.db`, through `sudo`: Accessibility, Screen Recording,
  Input Monitoring, Full Disk Access, Developer Tools) or the guest user's (everything else — Automation, Camera,
  Microphone, Contacts, folders, …); which daemon answers for a service was measured on macOS 26. A client is an
  app's bundle id or the real path of a bare program, resolved in the guest from a name, bundle id or path; `"shell"`
  is the Tart guest agent, which macOS holds responsible for everything `tart exec` starts. Entries are written without
  a code requirement (like the image's own) and replace a stored refusal — one transaction per database, the system one
  first, so a failure there changes nothing; tccd reads the database on every request, so they apply at once. Automation is per controlled app
  (`target`); revoking Accessibility also removes the PostEvent entry macOS would turn back into it. `denied` reads
  tccd's `AUTHREQ_*` log lines (`log show`) for requests that weren't allowed (Automation requests aren't logged
  that way). Grants and revocations made with the tool are audited, failed attempts included
  (`vm.permission.grant` / `.revoke`). An image with System Integrity Protection on answers with why it can't be done.
  Nothing dismisses dialogs: closing one without "Allow" makes macOS store a refusal over the entry.
* **Godmode's agent in the VM** (`vm/guest.ts`): the browser and computer use of a VM run live in the guest. Claude
  Code starts two stdio MCP servers as `tart exec -i <vm> /bin/zsh -f -c …` (stdio through the Tart guest agent, which
  runs in the guest user's GUI session; no startup files, so nothing the agent puts there can print into the JSON-RPC
  stream; ending the process kills the command's process group): `browser` — browser-use
  (`browser-use --mcp`, pinned like on the host) connected to Google Chrome in the guest (`~/Applications`, own profile
  in `~/.godmode/browser-profile`, DevTools on the guest's `127.0.0.1:9322`, visible on the VM's screen, downloads in
  `~/Downloads`), started again when it was closed — and `cua` — Cua Driver (`cua-driver mcp --direct`), which controls
  the guest's apps and windows; the Cirrus Labs images grant the guest agent (and so everything `tart exec` starts)
  Accessibility and Screen Recording. `prepareGuest` restores what is missing of that on every run (`ensureAgentAccess`:
  the image's entries name one version of the agent's binary and are lost when Homebrew upgrades it), plus Automation of
  System Events and Finder, so an `osascript` from the shell doesn't wait at a dialog. Everything is installed on first use, shared by concurrent runs: uv is copied
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

* **Archive** (`archived_at`, `TaskPatch.archived`, `POST /api/tasks/archive` for a whole column): archived tasks are
  off the board (`GET /api/tasks` lists them only with `archived=1`, latest first) and keep their status, worktree,
  branch and conversation. They never start — `dispatch` and the restart skip them — and archiving a working task stops
  its run and parks it in `backlog`. Moving an archived task to another status, or a follow-up run in its conversation,
  brings it back; restoring it puts it on top of its column (and starts it when it waits in `todo` with an agent).

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
  `.env`/key files are left out), takes secrets out of the commits the remote doesn't have yet (see the next point),
  merges commits someone else pushed to the branch since Godmode's last push (a conflict blocks the task),
  and pushes with an explicit lease on what it saw — so nothing pushed meanwhile is overwritten. It then opens a pull
  request with `gh pr create` (body: the agent's summary, redacted — saved secrets are taken out of the title and body
  even with redaction off); without `gh`, or for GitLab, the task links to the
  page that opens one. A branch without commits on top of its base goes to review without a pull request; a local
  repository without a remote keeps the commits on the task's branch. Restarting fast-forwards the worktree to the
  remote branch first; only the task's branch is fetched and pushed (nothing is written to the repository's config).
  When a `general` or `research` task's run ends, what it changed is committed on its branch, which isn't pushed.
* **Secrets never stop a push and never go along**: before a task's branch is pushed (when a run ends, or from the
  board), Godmode checks the commits that are neither on the base nor on the remote yet, and only what they add: files
  that look like secrets (`.env`, keys), and secrets saved in the vault in an added line, a file name, any version of
  a binary file those commits add (read whole, up to 20 MB) or a commit message. Lines a change removes or merely surrounds don't
  count, a moved file adds only what changed, and what the remote already has isn't checked again. A value counts
  when it is stored as a secret (passwords, 2FA secrets, API keys, tokens; of a custom MCP server's env variables and
  headers the ones whose name says so, like `API_KEY`, `signingKey`, `SENTRY_DSN`, `SLACK_WEBHOOK_URL` or
  `Authorization` — not public keys like `STRIPE_PUBLISHABLE_KEY`, nor a snake_case identifier under a key's name like
  `SORT_KEY=created_at` —, plus bearer tokens and passwords inside URLs) and isn't a single plain word or number — a
  server's other settings (`NODE_ENV=production`, URLs) are only masked in
  transcripts. When something is found, Godmode fixes the branch instead of blocking the task: such files are left out
  (they stay in the worktree; one the branch already had keeps the version the remote has), the secret is replaced
  with `GODMODE_REMOVED_SECRET` in text files (a file that can't be rewritten safely — binary, not UTF-8, a link, not
  writable — is left out too), and the unpushed commits become one commit on top of what the remote has (the branch's
  own last commit as its first parent), so no pushed commit or commit message carries the secret and nothing on the
  remote is rewritten. Exactly the commit that was checked is pushed: when a turn that started meanwhile stages or
  commits something during the fix (or before a merge with someone else's push), nothing is pushed now and that
  turn's end pushes the branch. The branch as the agent left it stays in the worktree as
  `refs/worktree/godmode/with-secrets/<commit>` (never pushed; its reflog keeps the commits for git's 90 days even
  when the repository is cleaned up from another checkout), a notification names the files, and the agent's brief
  tells it to read secrets from the environment. With a locked vault only the file names are checked.
* **When a run ends** (any run in the task's conversation, so the human's follow-ups count too): succeeded →
  `in_review` (after publishing, for coding tasks), failed or stopped → `blocked` with the reason, and a
  `task_report_blocked` call during the run → `blocked` with what the agent needs. A follow-up puts a delivered or
  blocked task back to `in_progress`; for coding tasks the next push updates the open pull request. The run's answer
  becomes the task's result: images it names by path in the agent's folders or the temp folder (checked by their
  bytes, resolved symlinks included, at most 20) are copied into the task's files and the result shows them; earlier
  results keep theirs (they stay readable on the timeline) until the task is deleted. The pull request body keeps the
  paths. The kind of block is stored with it (`Task.blockedKind`): `failed`, `interrupted` (the run was cut off by a
  restart), `stopped` (the human stopped it — a follow-up it set is cancelled), `needs_input` (`task_report_blocked`),
  `publish` (pushing or the pull request failed — *Publish again* from the task moves it to review once it works),
  `setup` (agent gone or switched off, no repository, worktree failed) and `manual` (the human moved it to Blocked, with
  an optional `blockedReason` only they can change). Starting a blocked task again opens the prompt with why: "Godmode
  restarted while you were working…" or "Your last run … failed: <reason>". Handing a blocked task to another agent
  turns `needs_input`, `failed`, `stopped` and `interrupted` into `manual` (the new agent starts again).
* **Tickets**: `priority` (urgent, high, medium, low, none), `dueDate` (a calendar day) and up to 10 `labels`; the agent
  is told them in the prompt. Queued ticket runs (triggers `task` and `followup`) start in priority order, then by the
  earliest due day (`ticketOrder()` in the runner shares out only the queue places ticket runs hold — the human's chat,
  an automation or a continued run keeps its turn); Todo tickets are started in that order after a restart.
* **Timeline** (`task_events`, `TaskEvent`, `GET /api/tasks/:id/events`, WS `task.event`): append-only, oldest first —
  assignments, status moves by the human, starts, every delivery with its full result, blocks with their reason, the
  human's messages (from the sheet, the phone or the ticket's chat) with the status they were sent in, notes agents
  leave (`task_note`, at most 20 per run), pull requests opened / merged / closed, and questions asked and answered.
  `createdBy` says who filed the ticket. Rows a run causes once (started, waiting, delivered, blocked) are unique per
  run; the rows go with the task.
* **Waiting**: when the agent set itself a follow-up and its run succeeds, the ticket stays `in_progress` with
  `Task.followup` — "Waiting — continues <when>" — instead of going to review, without a "ready for review" notice;
  what it changed is committed (and pushed, for coding tickets). When the follow-up runs, the ticket goes on; when the
  human cancels it, the ticket goes to review quietly; when it can't start because the agent is off or gone, the ticket
  is blocked (`setup`). Moving, reassigning, archiving or deleting a waiting ticket cancels its follow-up; a restart
  leaves it waiting. The follow-up's own "got back to" notice isn't sent for tickets: they report themselves.
* **Cost and time**: `costUsd`, `workMs` and `runCount` add up every run that ended in the ticket's conversations
  (with the work it delegated), and survive reassignment and the chat being deleted.
* **Moving on the board**: away from `in_progress` cancels the run (the UI asks first); into `todo` (or
  `in_progress`) with an agent starts it. Every 5 minutes, tasks in review with an open pull request are checked with
  `gh pr view`: merged → `done`, closed → noted on the task.
* **Races**: one start or publish per task at a time; a start the board asks for meanwhile runs once the task is free,
  and a run that ended meanwhile is handled then. Moves caused by the work (to In review, Blocked, Done) only apply
  from the status the work expects — a move the human made meanwhile wins — and put the task at the top of its column.
* **Agents managing the board**: `task_get` reads one ticket in full (result, timeline, cost; by id or `#12`), `tasks_list`
  filters by agent, `task_message` sends feedback into a ticket (it arrives marked as coming from that agent, not the
  human, is on the timeline, and is refused for the caller's own ticket and for a ticket whose run stands still — only
  the human continues those), `task_note` leaves a note (a working agent on its own ticket, managers on any).
  `task_create` / `task_update` follow the delegation rules (no reveal-mode or unattended
  computer agents from callers that couldn't use them, VM-kept runs stay off the host); coding tasks created by agents
  use the workspace's repositories; and a run working on a task — or delegated from one — can't start a manager agent
  (itself included), so tasks can't spawn tasks without end. Follow-ups wait while Godmode prepares or publishes a task. Task numbers are never reused.
* **Restart**: tasks left `in_progress` without a live run or a pending follow-up are blocked (`interrupted`; the board's
  Blocked column offers *Continue all*), tasks waiting in `todo` with an agent are started. Restoring a backup does the
  same for the restored tickets. Deleting a task cancels its run and removes the worktree (the conversation and the branch stay); deleting a
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
  never on the LAN. The address comes from `tailscale status --json` (the CLI on PATH or inside Tailscale.app, run with
  `TERM` set: without it the app's binary tries to start the app instead), else from a network interface in
  100.64.0.0/10; a missing MagicDNS name is asked from Tailscale's resolver (100.100.100.100, reverse lookup), because
  iOS only allows plain HTTP to `*.ts.net` names, not to the bare address. It is re-checked every 30 s and the listener
  moves with it. Tailscale
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
  allowlist of routes (`mobile/scope.ts`): bootstrap, workspaces, agents and their slash commands, the model catalog,
  conversations, messages (with attachments) and the message queue (edit, remove, send now), questions (list, answer
  without files), runs (cancel), routines (run, enable), browser profiles (launch, input), computer input, VMs (list,
  screenshot, start/stop, input), notifications, missing logins and `GET/DELETE /api/mobile/me`; everything else answers
  403 `device_forbidden`. Bodies are restricted too: a phone may pick a chat's model, effort and Ultracode but can't set its
  folder, VM, browser, shared screen or instructions, or change an automation beyond switching it on or off, and it only
  watches and controls screens that are shared in a chat (`computer.subscribe` and `/api/computer/input`); Godmode's VMs
  it may always take over (`POST /api/vms/:id/input`, the computer input events on a picture of the whole screen, sent
  over the VM's Screen Sharing and never booting it). The listener checks the decoded path, so `/api/%61uth/…` is refused
  like `/api/auth/…`.
* **Key hygiene.** The app only sends its key over plain HTTP to a Tailscale address (100.64.0.0/10 or `*.ts.net`;
  https anywhere, which is how the Godmode Cloud gateway is reached — `isPhoneUrlAllowed`), and first asks the address's `/api/health`, which on
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

* **Through Godmode Cloud.** When the computer is linked to a cloud with an https address and both phone switches are
  on (`settings.mobile.enabled`, `settings.cloud.phoneAccess`), the pairing link and `GET /api/mobile/me` also carry
  the gateway URL `https://<cloud>/gw/<deviceId>`, last; the app tries it after the Tailscale addresses. Those requests
  arrive through the cloud link on channel `mobile` and pass the same device-token and scope checks as on the
  phones' listener. See [Godmode Cloud](#godmode-cloud).

## Godmode Cloud

An optional, self-hosted service (`apps/cloud`; deployment and operation in
[apps/cloud/README.md](../apps/cloud/README.md)). It gives people accounts, lets them open a linked computer's
dashboard in any browser and reach it from the phone app without Tailscale, and bills plans through Stripe. A Godmode
that was never linked never talks to a cloud; nothing leaves the computer unless it is linked.

### Components

* **The cloud** (`apps/cloud`): one Node.js process. A custom HTTP server (`server/main.ts`, bundled with esbuild to
  `dist/server.mjs`) answers `/api/health`, serves the dashboard build under `/ui`, owns the relay paths
  (`/relay/v1/connect`, `/d/<deviceId>/…`, `/gw/<deviceId>/…`) and hands everything else to Next.js (App Router):
  sign-in, the setup wizard, the user and admin pages, the link and device APIs and the Stripe webhook. Data lives in
  PostgreSQL (Drizzle; migrations run at start). Configuration is the domain only; everything else is a setting in the
  admin dashboard. Docker Compose with `init` (generates the database password and app secret), `db` and `cloud`.
* **The cloud link in the core** (`packages/core/src/cloud`): linking (`link.ts`), the outbound socket (`client.ts`),
  running relayed requests and sockets through the core's own Hono app (`dispatch.ts`), the classification of every
  route for relayed requests (`scope.ts`), the link state (`state.ts`), and `/api/cloud*` for the desktop.
* **The dashboard in cloud mode** (`apps/desktop`): Settings → Cloud and Billing on the computer. The same UI, built
  with `--base=/ui/` (`build:cloud`), is served by the cloud for `/d/<deviceId>/*` with a
  `<meta name="godmode-cloud">` tag (`CloudUiContext`); with it the UI sends its API calls and WebSocket to
  `/d/<deviceId>/api/…`. The cloud serves its own copy of the build from the same commit, never files from a computer.
* **The phone app** (`apps/mobile`): treats the gateway URL as one more address of the computer.
* **The contract** (`packages/shared/src/cloud.ts`): settings, link and device API payloads, the frame codec, header
  lists, close codes and error codes.

### Link protocol (summary)

1. **Linking.** The computer makes a link secret (`gml_…`) and sends `POST /api/link/v1/start` with its instance id,
   name, platform, version and the secret's SHA-256. The cloud returns a request id, a short user code and
   `verifyUrl` (`<cloud>/link?code=…`), which Godmode opens in the browser. A signed-in person approves there (within
   the plan's computer limit; audited and e-mailed to the account). Meanwhile the computer polls
   `POST /api/link/v1/poll` with the secret as bearer and receives its `deviceId` and the account. The cloud only ever
   stores the hash.
2. **Connection.** The computer keeps one WebSocket to `/relay/v1/connect` with
   `Authorization: Bearer <deviceId>.<secret>`. Its first frame is Hello (protocol version, app version, instance id,
   name, platform, the browser and phone switches); the cloud answers Welcome (device id, account, plan, public URL,
   limits). One live link per computer: a newer one replaces the older.
3. **Frames.** Every message is binary: one byte frame type, a 32-bit stream id, the payload. The cloud opens streams:
   an HTTP request is ReqHead, ReqBody…, ReqEnd, answered by ResHead, ResBody… and exactly one ResEnd; a WebSocket is
   WsOpen, WsAccept or WsReject, then WsText / WsBinary both ways and WsClose; Abort ends a stream from either side.
   Bodies travel in 64 KiB chunks under a 1 MiB window per stream, and the reader grants more (Window) only after it
   handed bytes on, so a slow browser or computer slows the sender instead of filling memory. A Ping goes out after
   20 s of silence; 60 s without any frame ends the link.
4. **Channels.** `/d/<deviceId>/api/*` is for signed-in cloud users: the cloud checks the session, the person's role
   on that computer and the plan, drops cookies and `authorization`, and sends `channel: "cloud"` with the user's id,
   e-mail, name and role. `/gw/<deviceId>/api/*` is for phones: no cloud session, the phone's own `Authorization`
   passes through, `channel: "mobile"`. On the computer the channel alone decides the kind of caller (`cloud` or
   `device`); access tokens and dashboard cookies are never looked at on relayed requests.
5. **Close codes** tell the computer what to show: 4401 revoked (stop), 4402 plan required and 4403 turned off (retry
   slowly), 4409 replaced by another connection, 4429 rate limited, 4400 protocol or version mismatch.
6. **Device API** (`/api/device/v1/*`, same bearer): the computer's account and plan, the owner's billing overview,
   cancel or resume at the end of the period, and unlink. Checkout, payment methods and sign-in happen only in the
   browser.

### Trust model: what the cloud can see

* The cloud terminates TLS, so everything relayed passes through it in the clear: the dashboard's requests and
  responses (chats, files, agent output, screenshots and live views), WebSocket messages and phones' requests. It
  stores none of it; it counts bytes and requests per computer and day (`usage_daily`).
* The admin area has no way to open someone else's computer. Whoever operates the cloud (server, database, sign-in
  e-mail) is trusted and technically can.
* A computer can be opened by its owner and by the people the owner shared it with (operator: everything; viewer:
  read only). Admins see metadata: names, versions, online state, traffic.
* The computer decides what the cloud may do: `settings.cloud.browserAccess`, `phoneAccess` and `allowSecrets`
  (unlocking the vault, revealing passwords and keys, backups; off by default). Some routes are never served to a
  relayed request (dashboard sign-in, phone pairing management, cloud link management, vault setup, revealing a file
  or opening a VM on the computer's own screen, computer permissions); `scope.ts` classifies every route and refuses
  new ones until someone decides. The first use
  per person and day is audited and shown as a notification on the computer.
* Browser side: the cloud session cookie is never forwarded to a computer; a computer's responses pass through a
  header allow-list and always get `content-security-policy: default-src 'none'; sandbox` and `nosniff`, so they can
  never set cookies or run as a page on the cloud's origin; unsafe methods and sockets on `/d` need the cloud's own
  Origin. Redirects from a computer are refused (502).
* Phones: the cloud is a gateway. The phone's `gmd_` key is checked by the computer, and the cloud never answers 401 on
  `/gw` itself (the app forgets its pairing on a 401).

### Where state lives

* **Cloud, PostgreSQL** (`apps/cloud/src/server/db/schema.ts`): people, roles, invites, sessions and sign-in tokens
  (hashes only), settings (the SMTP password and Stripe keys encrypted with the app secret), computers (hash of the
  link secret, switches, last seen), shares, pending link requests, daily usage, plans, prices and subscriptions
  mirrored from Stripe, processed Stripe events, and the audit log.
* **Cloud, volumes:** `secrets` (database password and app secret, written once by `init`) and `/data`
  (`setup-code.txt` until the instance is claimed).
* **Cloud, memory:** the live links (the relay hub), rate-limit buckets and the settings cache. One process per
  database; replicas would not see each other's links.
* **Computer:** meta keys `cloud.url`, `cloud.device_id`, `cloud.account`, `cloud.linked_at` (plus `cloud.revoked`,
  `cloud.plan`) in `godmode.db`, kept out of backups, and the link secret in `<dataDir>/cloud-link` (0600): not in
  Settings, which paired phones can read, and not in the vault, because the link must come up while the vault is
  locked. The switches are `settings.cloud`.
* **Browser:** the cloud session cookie (`__Host-gmc_session` on https, HttpOnly, SameSite=Lax, 365 days by default,
  renewed while used). **Phone:** its device token and the computer's addresses, including the gateway URL, in the
  Keychain / Keystore.

## Remote runners

A **runner** is a headless Godmode core on another computer (macOS for now) that works for the human's Godmode — the
**controller** — so chats go on while the controller's lid is closed. Everything lives in `packages/core/src/remote/`
(not `runner/`, which is the Claude run executor); shared types are in `packages/shared/src/remote.ts`.

* **Role and process.** `godmode runner serve` (or the LaunchAgent `dev.codext.godmode.runner` that `godmode runner
  install` writes, `RunAtLoad`, `KeepAlive` on failure, `LimitLoadToSessionType Aqua` because agents need the desktop
  session) starts the core with `config().role = "runner"` and data dir `~/.godmode-runner` (`GODMODE_RUNNER_HOME`).
  A runner keeps its API on loopback (random port; the MCP gateway needs it), doesn't run schedules, dreaming,
  automations, messaging, the task board or phone access, holds `caffeinate -i -m -s -w <pid>` (plus `-d` while runs
  work, `keepAwake.ts`), writes `runner.json` (pid, ports) while it serves and refuses a second instance on the same
  data dir. On its first start it installs what is missing (Claude Code, uv, browser-use, Chromium) through the
  doctor's installers (`bootstrapDependencies`; `GODMODE_RUNNER_BOOTSTRAP=0` turns that off). Agents on a runner get no
  tools that change the setup, automations or the board (`managesSetup` in `mcp/tools.ts`): their setup is a copy.
* **The link.** The runner listens on every interface at its link port (meta `link.port`, default 7788, next free one
  if taken, written back) and serves only `GET /` and the WebSocket `/link` (`linkServer.ts`, 30 handshakes per IP
  and minute). Each socket gets a `SecureChannel` (`channel.ts`, `crypto.ts`): X25519 ephemeral + static keys,
  HKDF-SHA256 over the transcript, one AES-256-GCM key per direction, frames numbered (replays, losses and reordering
  end the link), 1 MiB per frame, binary streams up to 256 MiB. In a session the keys depend on both static keys (the
  runner pins the controller's in `link_controllers`, the controller pins the runner's in `runners`); while pairing on
  the runner's static key and the code's one-time secret. Every installation has one static key pair in
  `<data dir>/link-key` (0600). Over the link the controller sends requests (`req` → the runner's own API with the master
  token, tagged `c.env.channel = "runner-link"`, only `/api/*` and never `/api/auth/*`) and live-view subscriptions
  (`client`); the runner sends answers and, through a virtual client of the event hub, every event a local UI would get
  (frames and streaming text are dropped while the socket is backed up). The controller's `RemoteLink`
  (`linkClient.ts`) dials each known address in turn (LAN, Tailscale, `.local`), pings every 20 s and reconnects with
  backoff (5 minutes for a version mismatch). `/api/link/*` (`server/routes/link.ts`) exists only on that channel:
  info, setup sync, health and fixes, agent memory, cookies, `exec` (for the autofix chat; audited) and `forget`.
* **Pairing.** `godmode runner pair` (and the end of `runner install`) stores a one-time code in meta `link.pairing`
  (10 minutes) and prints `gmr1.<base64url JSON>`: name, addresses, port, static key, pairing id and secret. Pasting it
  in Godmode (`POST /api/runners`) runs the pair handshake: the runner stores the controller's key and drops the code
  before it answers. Or Godmode makes an offer (`POST /api/runners/pairing`): a temporary listener on every interface
  and `gmo1.<…>` with its URLs and a token, inside an install command — `curl …/godmode` from this computer with the
  binary's SHA-256 pinned (compiled builds only) or `godmode.codext.de/runner.sh` with the license key — that ends in
  `godmode runner install --pair <offer>`. The runner then posts its code to the offer's `POST /pair`, sealed with a
  key derived from the token (which never crosses the network), and the controller pairs with it; the listener stops.
* **Setup copy** (`snapshot.ts`). Before a chat starts on a runner, before every message to it, and 5 s after the
  setup changes while it is connected, the controller compares its digest with the one the runner reported and sends
  the snapshot when they differ: workspaces, agents, logins, 2FA, app secrets, MCP servers, Composio connections, API
  tools, SSH servers, browser profiles, git sources and VM records with the same ids, settings except the machine's own
  (`server`, `mobile`, `diagnostics`) and the fields that name programs, and the vault's wrapped key, canary and — when
  the controller's vault is open — the data key, which the runner adopts (verified against the canary, remembered in
  its keychain). The runner upserts by primary key, keeps its own columns (paths, last use, status), never deletes an
  agent with an active run and rewrites changed agents' CLAUDE.md. Agent memory is merged three ways after each run and
  before each start (`memorySync.ts`, base in `runner_memory`; no line is dropped), and the chat's browser profile's
  cookies are copied when they changed (`runners.sync_browser`).
* **Chats on a runner.** `POST /api/chat` with `runnerId` syncs, forwards the start to the runner (without folders,
  shared screens and VMs, which are this computer's) and adopts the answer. The chat keeps `conversations.runner_id`;
  its messages and runs are copies under the runner's ids. `mirror.ts` applies the runner's events — only for chats
  whose `runner_id` is that runner's, field by field — and re-emits them, so the UI renders a runner's chat like any
  other; `activeRuns.ts` knows which of its runs work. After every connect `catchUp` adopts and refreshes what changed
  meanwhile. `routing.ts` forwards requests about a runner's chat (messages, queue, pause, continue, follow-ups, files,
  its runs, its browser tab's input, `runner:<id>:<view>` screen input, `/api/runners/:id/proxy/*`); `pinned` and
  `archived` stay local, and reading works from the copy while the runner is offline (`409 runner_offline` for
  everything else). Live views: the hub hands subscriptions to a runner's chat tab and to `runner:` views to the link
  (`setRemoteViewHandlers`) and re-sends them after a reconnect; the frames come back through the mirror.
* **Health** (`health.ts`): software (doctor), macOS permissions (Accessibility, Screen Recording, Full Disk Access),
  access (vault, setup copied), system (service, keep-awake, desktop session, disk, firewall), each with a fix kind
  (`install`, `request`, `open-settings`, `sync`, `restart`, `manual` + hint) and `installing` for what is on its way.
  `godmode runner status` asks the serving runner (`/api/runner/health` on loopback) for its own view. **Fix with
  Claude** starts a chat on this computer with `conversations.runner_tools_id`: its agent gets `runner_health`,
  `runner_fix` and `runner_exec` (a login shell on the runner, in its data dir) and the health report and log tail.
* **Removing a runner** tells it to forget this computer, fails its working runs and turns its chats into chats of this
  computer. Backups carry no runners, controllers or `link.*` meta, and restored chats lose their runner.

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
