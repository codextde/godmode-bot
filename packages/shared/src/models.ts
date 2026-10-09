import type { AgentHeartbeat } from "./heartbeat";
import type { AttentionCounts } from "./attention";
import type { AgentCharacter } from "./character";
/**
 * Core domain models shared between the Godmode core daemon and the UI.
 *
 * Scoping rules:
 *  - `workspaceId: null` means the item is GLOBAL (visible to every workspace).
 *  - An item with a `workspaceId` is only visible to agents inside that workspace.
 *  - Some items (MCP servers, Composio connections, credentials) can additionally be
 *    pinned to a single agent via `agentId`.
 */
import type { AgentComputerConfig, ComputerTarget } from "./computer";
import type { CloudSettings } from "./cloud";

export type ID = string;
export type ISODate = string;

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  description: string;
  color: string; // tailwind-ish color token e.g. "violet" | hex
  icon: string; // emoji or lucide icon name
  /** Agent context: standing instructions for every agent in this workspace, on every run. */
  instructions: string;
  /** macOS VM the workspace's agents work in (unless their chat or the agent has its own). null = none. */
  vmId: ID | null;
  /** The workspace's default browser profile (unless an agent pins its own). null = the global default. */
  browserProfileId: ID | null;
  /** Folders and git repositories every agent in the workspace works with. */
  sources: WorkspaceSource[];
  /** A ticket's pull request is merged as soon as its agent delivers it, and the ticket is done — no review step. */
  autoMerge: boolean;
  /** Optional projects inside the workspace, A–Z. */
  projects: Project[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * A project inside a workspace (optional). Chats, tickets and agents may belong to one: their runs get the workspace's
 * context, folders and repositories plus the project's, and browse with the project's profile unless the chat or the
 * agent has its own.
 */
export interface Project {
  id: ID;
  workspaceId: ID;
  name: string;
  slug: string;
  description: string;
  color: string;
  icon: string;
  /** Agent context for every run in the project, on top of the workspace's. */
  instructions: string;
  /** Browser profile for runs in the project (global or of its workspace); null = the workspace's default. */
  browserProfileId: ID | null;
  /** Folders and git repositories of the project, on top of the workspace's. */
  sources: WorkspaceSource[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * A folder on this computer or a git repository attached to a workspace. Godmode clones repositories into its data
 * directory; every run of an agent in the workspace gets them (`--add-dir`).
 *  - `ready`: usable (a repository is cloned)
 *  - `cloning` / `syncing`: a clone or an update is in progress
 *  - `missing`: the folder is gone, or the repository isn't cloned yet (the next run or a sync clones it)
 *  - `error`: cloning failed (`error`)
 */
export type WorkspaceSourceStatus = "ready" | "cloning" | "syncing" | "missing" | "error";

export interface WorkspaceSource {
  id: ID;
  kind: "folder" | "git";
  name: string;
  /** The folder, or where the repository is cloned. */
  path: string;
  /** Clone URL (git only). */
  url: string | null;
  /** Branch to check out (git only); null = the repository's default branch. */
  branch: string | null;
  /** A git repository: a clone, or a folder with its own .git. Tasks work in their own worktree of it. */
  git: boolean;
  status: WorkspaceSourceStatus;
  /** Why the folder can't be used, or why the last clone or update failed (a clone stays usable). */
  error: string | null;
  /** Why the last update left the clone as it was (local changes, no tracking branch). */
  note: string | null;
  /** Checked out commit and branch (git only). */
  commit: string | null;
  headBranch: string | null;
  /** Last successful clone or update (git only). */
  syncedAt: ISODate | null;
}

/* ------------------------------------------------------------------ */
/* Agents (a.k.a. Bots)                                                */
/* ------------------------------------------------------------------ */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentStatus = "idle" | "running" | "error" | "disabled";
export type SecretAccessMode = "fill" | "reveal";

export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
}

export interface AgentPermissions {
  /** Agent may create/update/delete other agents and routines (the "Godmode" orchestrator). */
  canManageAgents: boolean;
  /** Agent may delegate tasks to peer agents. */
  allowDelegation: boolean;
  /** Peer agent ids this agent may delegate to. Empty = any agent in reach. */
  delegateTo: ID[];
  /**
   * How the agent gets secrets:
   *  - "fill": secrets are typed straight into the browser by Godmode, the model never sees them (default, safest)
   *  - "reveal": the model may read raw usernames/passwords/TOTP codes
   */
  secretAccess: SecretAccessMode;
  /** Credential ids the agent may use. `null` = every credential in its scope (global + workspace). */
  credentialIds: ID[] | null;
  /** TOTP ids the agent may use. `null` = every TOTP in its scope. */
  totpIds: ID[] | null;
  /** Hard cost cap per run in USD (passed to claude --max-budget-usd). null = unlimited */
  maxBudgetUsd: number | null;
  /** What the agent may cost per calendar month in USD; used up = its unattended work waits. null = no budget. Human-only. */
  monthlyBudgetUsd?: number | null;
}

export interface AgentBrowserConfig {
  /** Browser profile to use. null = the workspace/global default profile. */
  profileId: ID | null;
  /** Enable browser tools for this agent at all. */
  enabled: boolean;
  headless: boolean | null; // null = use global setting
}

export interface Agent {
  id: ID;
  workspaceId: ID | null;
  /** The project of its workspace it works on by default (chats and tickets may pick another). null = none. */
  projectId: ID | null;
  name: string;
  slug: string;
  /** Emoji — the agent's glyph where only text fits (chat apps, CLAUDE.md). The app shows `character`. */
  avatar: string;
  color: string;
  /** What the agent looks like: a small creature with a face (see character.ts). */
  character: AgentCharacter;
  /** How the agent sounds: a PERSONALITY_PRESETS id, free text, or "" for no particular tone. */
  personality: string;
  description: string;
  /** The agent's standing instructions (go into its CLAUDE.md). */
  instructions: string;
  /** Job title on the team, e.g. "Bookkeeper". "" = none set. One line, at most MAX_AGENT_ROLE_LENGTH. */
  role: string;
  /** Its lead. null = the built-in agent (which reports to the human; always null for the built-in agent). */
  reportsTo: ID | null;
  /** Its latest real run when that failed and the human hasn't dismissed it. `status` is then "error". */
  failedRunId: ID | null;
  /** Claude model id or alias. Empty string = use global default. */
  model: string;
  effort: Effort | null;
  /** Ultracode (see RunnerSettings.ultracode) for this agent. null = the global default. */
  ultracode: boolean | null;
  /** The built-in main assistant ("Godmode"). Cannot be deleted. */
  isDefault: boolean;
  enabled: boolean;
  status: AgentStatus;
  permissions: AgentPermissions;
  browser: AgentBrowserConfig;
  /** Computer use without a screen shared in the chat (routines, delegated tasks). */
  computer: AgentComputerConfig;
  /** MCP server ids (custom + composio) explicitly attached to this agent (in addition to scope-inherited ones). */
  mcpServerIds: ID[];
  /** Whether to inherit global/workspace MCP servers. */
  inheritMcp: boolean;
  subagents: SubagentDefinition[];
  /** Folder the agent works in by default (Claude's cwd). null = its own repository. */
  workingDirectory: string | null;
  /** macOS VM the agent works in (unless its chat has its own). null = the workspace's VM, if any. */
  vmId: ID | null;
  /** SSH servers the agent may sign in to and control in every run. */
  sshServerIds: ID[];
  /** Wakes up on its own rhythm to move its tickets forward and run its checklist (see heartbeat.ts). */
  heartbeat: AgentHeartbeat;
  /** Absolute path of the agent's git repository. */
  repoPath: string;
  /** Runs of the agent that stand still: paused by the human, or waiting for Claude's usage limit to reset. */
  pausedRuns?: number;
  /** Runs of the agent that wait for the human's answer (see AgentQuestion). They are not part of `pausedRuns`. */
  openQuestions?: number;
  /** Runs of the agent held because a monthly budget is used up. They are not part of `pausedRuns`. */
  heldRuns?: number;
  lastRunAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Routines = automations: a prompt an agent runs when its trigger fires */
/* ------------------------------------------------------------------ */

/**
 * What starts an automation:
 *  - `schedule`: the cron expression fires.
 *  - `app`: an event in a connected app (Composio trigger: new email, Slack message, Notion update…).
 *  - `condition`: the agent checks a condition in plain language on the cron schedule and acts once it holds.
 *  - `webhook`: an HTTP POST to the automation's secret URL.
 */
export type RoutineTriggerType = "schedule" | "app" | "condition" | "webhook";

export type RoutineTrigger =
  | {
      type: "schedule";
      /**
       * Start at a random moment up to this many minutes after each scheduled time, drawn anew for every run
       * ("0 8 * * 1-5" + 90 = weekdays somewhere between 08:00 and 09:30). Absent = on time.
       */
      startWindowMinutes?: number;
      /**
       * Run this many times per scheduled time instead of once: the start window is split into equal parts and each
       * run starts at a random moment in its part ("0 8 * * *" + 840 + 5 = five runs a day between 08:00 and 22:00).
       * Needs `startWindowMinutes`. Absent = once.
       */
      runsPerWindow?: number;
    }
  | {
      type: "app";
      /** Godmode Composio connection (`ComposioConnection.id`) whose account is watched. */
      connectionId: ID;
      /** Composio toolkit slug, e.g. "gmail". */
      toolkit: string;
      /** Composio trigger type slug, e.g. "GMAIL_NEW_GMAIL_MESSAGE". */
      triggerSlug: string;
      /** Display name of the trigger type, e.g. "New Gmail message". */
      triggerName: string;
      /** Trigger configuration (fields of the trigger type's config schema). */
      config: Record<string, unknown>;
    }
  | {
      type: "condition";
      /** Plain-language condition, e.g. "a competitor changes their pricing page". */
      condition: string;
      /** Model for the periodic checks; null = the agent's model. */
      checkModel: string | null;
    }
  | { type: "webhook" };

/** Health of the trigger (listening for app events, last check, webhook calls…). */
export interface RoutineTriggerStatus {
  state: "ok" | "pending" | "error" | "off";
  /** Why it is pending / failing, human readable. */
  message: string | null;
  /** Last time the trigger fired (event received, condition met). */
  lastEventAt: ISODate | null;
  /** Condition triggers: last check and what the agent observed then. */
  lastCheckAt: ISODate | null;
  observation: string | null;
}

/** When an automation tells the human that a run ended. A failure is told once until a run succeeds again. */
export type RoutineNotify = "always" | "failures" | "never";

export interface Routine {
  id: ID;
  agentId: ID;
  name: string;
  trigger: RoutineTrigger;
  /** Cron expression (5 or 6 fields): the schedule, or how often a condition is checked. "" for app/webhook triggers. */
  cron: string;
  timezone: string;
  prompt: string;
  /** Event triggers (app, webhook): only act on events that match this, in plain language. "" = every event. */
  filter: string;
  enabled: boolean;
  /** Keep a single conversation for every run of this routine (continuity) vs. new conversation per run. */
  reuseConversation: boolean;
  /** When it tells the human that a run ended: `failures` (default), `always`, or `never`. */
  notify: RoutineNotify;
  conversationId: ID | null;
  lastRunAt: ISODate | null;
  /** Next scheduled run (schedule) or check (condition). */
  nextRunAt: ISODate | null;
  lastStatus: RunStatus | null;
  triggerStatus: RoutineTriggerStatus;
  /**
   * Webhook triggers: the secret path to POST to, e.g. "/hooks/whk_…" (relative to the core's address).
   * null for other triggers, and while the vault is locked (the token is stored encrypted).
   */
  webhookPath: string | null;
  /** Events waiting for the automation to finish its current run. */
  pendingEvents: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** schedule: the cron fired · app / webhook: an event arrived · condition: a check found the condition met · manual: Run now / test event. */
export type AutomationEventSource = "schedule" | "app" | "webhook" | "condition" | "manual";
/**
 * pending: waiting for the automation's current run · running: handed to a run · done / failed: that run's outcome ·
 * skipped: not run (automation paused, duplicate, dropped from a full queue).
 */
export type AutomationEventStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Something that happened and started (or will start) an automation. */
export interface AutomationEvent {
  id: ID;
  routineId: ID;
  source: AutomationEventSource;
  /** One line, e.g. "New Gmail message · Invoice #1042 from ACME". */
  title: string;
  /** Event data as received (JSON, truncated). Untrusted. */
  payload: unknown;
  status: AutomationEventStatus;
  runId: ID | null;
  /** Why it was skipped or failed. */
  note: string | null;
  createdAt: ISODate;
}

/** A Composio trigger type (event a connected app can emit). */
export interface ComposioTriggerType {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolkit: string;
  toolkitLogo: string | null;
  /** "poll" triggers are checked by Composio every few minutes; "webhook" ones arrive instantly. */
  kind: "poll" | "webhook" | null;
  /** JSON schema of the trigger configuration. */
  config: Record<string, unknown>;
  /** Setup in the upstream app is needed before events arrive (e.g. a Slack/Notion webhook subscription). */
  requiresWebhookSetup: boolean;
}

/* ------------------------------------------------------------------ */
/* Conversations, messages, runs                                        */
/* ------------------------------------------------------------------ */

/**
 * `dream`: the archived conversation an agent's dreams (memory consolidation) run in ·
 * `slack` / `telegram` / `teams`: a chat on that platform (see Messaging) · `task`: an agent works on a board task.
 */
export type ConversationOrigin = "chat" | "routine" | "delegation" | "api" | "dream" | "slack" | "telegram" | "teams" | "task" | "heartbeat";

export interface Conversation {
  id: ID;
  agentId: ID;
  title: string;
  origin: ConversationOrigin;
  /** Claude CLI session id used with --resume. */
  claudeSessionId: string | null;
  /** Per-chat override from the model picker or /model. null = the agent's model. */
  model: string | null;
  /** Per-chat override from the effort control or /effort. null = the agent's effort. */
  effort: Effort | null;
  /** Per-chat override from the Ultracode switch or `/effort ultracode`. null = the agent's. */
  ultracode: boolean | null;
  /** Folder this conversation works in, overriding the agent's. null = the agent's default. */
  workingDirectory: string | null;
  /** What the human shared with the agent in this chat (screen, window or browser tab). null = nothing. */
  computerTarget: ComputerTarget | null;
  /** macOS VM this chat works in, overriding the agent's and the workspace's. null = theirs. */
  vmId: ID | null;
  /** Browser profile this chat works in, overriding the agent's and the workspace / global default. null = theirs. */
  browserProfileId: ID | null;
  /** Workspace a global agent's chat was started in; it browses with that workspace's default profile. */
  workspaceId: ID | null;
  /** Project the chat works on (one of its workspace's); null = the agent's project, if any. */
  projectId: ID | null;
  /** SSH servers runs in this chat may use, in addition to the agent's. */
  sshServerIds: ID[];
  /** Standing instructions for this chat only; they take precedence over the agent's, workspace and global ones. */
  instructions: string;
  /** The runner (another computer) this chat works on; fixed when the chat is created. null = this computer. */
  runnerId: ID | null;
  /** A local chat whose agent may run commands on that runner (the "fix with Claude" chat of a runner). */
  runnerToolsId: ID | null;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Denormalized for lists */
  preview?: string;
  running?: boolean;
  /** When the agent continues this chat on its own (see Followup). */
  followup?: ConversationFollowup | null;
  /** Something new happened while nobody had the chat open: its latest run's end. Opening the chat reads it. */
  unread?: { runId: ID; failed: boolean } | null;
  /** The chat's run stands still: paused by the human, waiting for Claude's usage limit to reset, or waiting for the human's answer. */
  paused?: RunPause | null;
  /** A chat another agent handed over: who asked, from which chat (null when that chat was deleted) and which run. */
  delegatedFrom?: { agentId: ID; conversationId: ID | null; runId: ID } | null;
}

export type ConversationFollowup = Pick<Followup, "note" | "dueAt" | "createdAt">;

/**
 * `user`: the human paused the run · `limit`: Claude's usage limit was reached mid-run · `question`: the run asked the
 * human something and waits for the answer (see AgentQuestion) · `budget`: unattended work held because a monthly budget
 * is used up (see PauseBudget).
 */
export type PauseReason = "user" | "limit" | "question" | "budget";

/** How a turn that ended early is picked up: `continue` where it stopped, or `again` from its prompt. */
export type RetryMode = "continue" | "again";

/** Whose monthly budget holds a run: the agent's own, or the whole team's. */
export interface PauseBudget {
  scope: "agent" | "team";
  /** The monthly budget in USD when the run was held. */
  limitUsd: number;
}

/** A run that stands still. Continuing it picks the work up where it stopped, in the same run and Claude session. */
export interface RunPause {
  runId: ID;
  reason: PauseReason;
  pausedAt: ISODate;
  /** Limit pauses: Claude's name for the limit, e.g. "session limit". */
  limit: string | null;
  /** Limit pauses: when the limit resets. null = Claude didn't say. */
  resumeAt: ISODate | null;
  /** Limit pauses: the run continues by itself at `resumeAt`. */
  auto: boolean;
  /** Question pauses: what the human is asked. Answering it is the only way to continue the run. */
  question?: Pick<AgentQuestion, "id" | "kind" | "title"> | null;
  /** Budget pauses: which budget holds it. It continues by itself on the 1st of next month (`resumeAt`) or once the
   *  budget has room again, or now when the human lets it run. */
  budget?: PauseBudget | null;
}

/** `question`: the agent asks something, with suggested answers · `approval`: it asks for an OK before one specific step. */
export type QuestionKind = "question" | "approval";

/**
 * `open`: the run stands still for it · `answered`: an option was picked or the human wrote something · `approved` /
 * `declined`: the decision on an approval · `withdrawn`: the run was stopped before the answer came.
 */
export type QuestionStatus = "open" | "answered" | "approved" | "declined" | "withdrawn";

/** Where the answer was given: the desktop app or dashboard, the phone app, the task's message box, or a chat platform. */
export type AnswerVia = "app" | "phone" | "task" | "slack" | "telegram" | "teams";

/** An answer the agent suggests. `id` is its position, "1" for the first. */
export interface QuestionOption {
  id: string;
  /** The answer as the human would say it. */
  label: string;
  /** What choosing it means or leads to. */
  description?: string;
  /** The agent's recommendation (at most one option has it). */
  recommended?: boolean;
}

export interface QuestionAnswer {
  /** The suggested answer that was picked; null = the human's own words, or a decision on an approval. */
  optionId: string | null;
  /** The picked option's label, what the human wrote, or the note that came with a decision ("" = none). Saved secrets masked. */
  text: string;
  attachments: Attachment[];
  at: ISODate;
  via: AnswerVia;
}

/**
 * Something an agent asked the human in the middle of a run (`ask_human`, `request_approval`). While it is open the run
 * stands still (`RunPause.reason` is "question"); the answer continues that run in the same Claude session, and
 * stopping the run withdraws the question.
 */
export interface AgentQuestion {
  id: ID;
  kind: QuestionKind;
  agentId: ID;
  runId: ID;
  conversationId: ID;
  /** The agent's message that shows the question (its `question` block has the same id). */
  messageId: ID;
  /** The board task the run works on. */
  taskId: ID | null;
  /** The automation that started the run. */
  routineId: ID | null;
  workspaceId: ID | null;
  /** The question in one sentence, or the step to approve. */
  title: string;
  /** Question: what the human needs to know to decide. Approval: why the agent wants to take the step. Markdown. */
  body: string;
  /** Approvals: what the step changes and for whom. "" for questions. */
  affects: string;
  /** Suggested answers ([] for approvals and open questions). The human can always answer in their own words. */
  options: QuestionOption[];
  status: QuestionStatus;
  /** Set once the status is answered, approved or declined. */
  answer: QuestionAnswer | null;
  /** Withdrawn: why, when it wasn't simply stopped by the human (e.g. "Stopped from the task board"). */
  closedReason: string | null;
  /** Denormalized for lists. */
  conversationTitle?: string;
  taskNumber?: number | null;
  routineName?: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * A time an agent set to continue a chat on its own — like a coworker who says "I'll check back tomorrow at 10" while
 * waiting for a reply, a delivery or a build. One per chat; it goes away when it fires or is cancelled.
 */
export interface Followup {
  conversationId: ID;
  agentId: ID;
  /** Title of the chat it continues. */
  title: string;
  /** What the agent will do then, in its own words. */
  note: string;
  dueAt: ISODate;
  /** When the agent set it. */
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type MessageRole = "user" | "assistant" | "system";

/** Structured content blocks for rich rendering of assistant turns. */
export type MessageBlock =
  | {
      type: "text";
      text: string;
      /** Set when the text was produced by a subagent (Task tool) — nest it under that tool_use block. */
      parentToolUseId?: string | null;
    }
  | {
      type: "thinking";
      /** May be empty when the model's thinking is redacted — still shown as a "thinking" indicator. */
      text: string;
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      /** Filled when the matching tool_result arrives. */
      result?: string;
      isError?: boolean;
      /** Optional base64 image result (e.g. browser screenshot). */
      image?: string;
      /** Work the tool started in the background (a Claude Code workflow), kept up to date while it runs. */
      task?: ToolTask;
      parentToolUseId?: string | null;
    }
  | { type: "error"; text: string }
  /** `mod`: the note comes from a Claude Code mod (its plugin name), not from Godmode. */
  | { type: "notice"; level: "info" | "warning" | "success"; text: string; mod?: string }
  /** Output of a Claude Code slash command that ran locally (e.g. /context, /usage, /model). */
  | { type: "command"; name: string; args: string; output: string }
  /** Marks where the agent continued the chat on its own (the system message of a follow-up run). */
  | { type: "followup"; note: string; dueAt: ISODate; setAt: ISODate; reason: FollowupReason }
  /** Where the human closed a task the agent gave them (see HumanTask) and the chat continued with it. */
  | { type: "human_task"; id: ID; number: number; title: string; outcome: "done" | "declined"; note: string; at: ISODate }
  /** The human picked up a turn that ended early: `continue` where it stopped, or `again` from its prompt. */
  | { type: "retry"; mode: RetryMode; runId: ID; at: ISODate; masked?: boolean }
  /** A message the human sent while the agent was working, at the point where the agent picked it up. */
  | { type: "user_message"; id: ID; text: string; attachments: Attachment[]; sentAt: ISODate }
  /** Where the run stood still (see RunPause). `resumedAt` is set once it continued from there. */
  | { type: "pause"; reason: PauseReason; at: ISODate; limit?: string | null; resumeAt?: ISODate | null; resumedAt?: ISODate; budget?: PauseBudget | null }
  /**
   * What the agent asked the human at this point of the turn (see AgentQuestion; `id` is the question's). A snapshot
   * that needs no lookup: it is `open` from the moment the agent asks — the run stands still for it a moment later,
   * once `Conversation.paused.question` names it — and changes when the answer comes or the question is withdrawn.
   */
  | {
      type: "question";
      id: ID;
      kind: QuestionKind;
      title: string;
      body: string;
      affects: string;
      options: QuestionOption[];
      askedAt: ISODate;
      status: QuestionStatus;
      answer?: QuestionAnswer | null;
      closedReason?: string | null;
    };

/**
 * Background work of a tool call, as Claude Code reports it (`task_started`, `task_progress`, `task_notification`).
 * `running` on a run that has ended means the work was cut off with it.
 */
export interface ToolTask {
  id: string;
  /** "local_workflow" for a workflow; other kinds of background work keep Claude Code's name. */
  kind: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** What the task is, e.g. "Review the changed files". */
  description: string;
  /** What it does right now, e.g. "Review: bugs". "" = nothing reported yet. */
  activity: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  /** The agents of a workflow in the order they were queued. Empty for other kinds of work. */
  agents: ToolTaskAgent[];
  /** It runs on its own: its tool call returned at once and the run goes on meanwhile (a subagent in the background). */
  background?: boolean;
  /** When it started (epoch ms), for a live timer. */
  startedAt?: number;
  /** The tool it used last, e.g. "Bash". */
  lastTool?: string;
  /** A subagent's final report, from Claude Code's notification that it ended. */
  summary?: string;
}

export interface ToolTaskAgent {
  label: string;
  /** Title of the workflow phase the agent belongs to; "" = none. */
  phase: string;
  state: "queued" | "running" | "done" | "failed";
  /** The tool it used last, e.g. "Bash". */
  lastTool?: string;
  tokens?: number;
}

/** Why a follow-up ran: it was due, it was overdue (Godmode was off or asleep), or the human said "continue now". */
export type FollowupReason = "due" | "late" | "now";

/** A slash command offered by the installed Claude Code CLI for an agent. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  /** Shipped with Claude Code (false = project command or skill in the agent repo). */
  builtin: boolean;
}

export interface Attachment {
  name: string;
  mime: string;
  /** Path inside the agent repo (attachments/…) */
  path: string;
  size: number;
}

/** A message sent while the agent was working: it waits in the chat's queue until the agent picks it up. */
export interface QueuedMessage {
  id: ID;
  conversationId: ID;
  content: string;
  attachments: Attachment[];
  createdAt: ISODate;
}

/** Who wrote a user message when it wasn't the human: an automation, another agent handing work over, the task board. */
export type MessageSource = "automation" | "delegation" | "task";

export interface Message {
  id: ID;
  conversationId: ID;
  role: MessageRole;
  /** A user message that wasn't written by the human. */
  source?: MessageSource;
  /** Plain-text version (final text for assistant). */
  content: string;
  blocks: MessageBlock[];
  runId: ID | null;
  attachments: Attachment[];
  createdAt: ISODate;
}

/** `paused`: the run stands still and continues where it stopped (see RunPause); it has not ended. */
export type RunStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
/**
 * `routine`: an automation ran (schedule, app event, condition met, webhook) · `check`: an automation checked its condition ·
 * `dream`: the agent consolidated its memory in the background · `followup`: the agent continued a chat at the time it set ·
 * `task`: the agent worked on a board task.
 */
export type RunTrigger = "chat" | "routine" | "check" | "dream" | "delegation" | "manual" | "api" | "followup" | "task" | "heartbeat";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  id: ID;
  agentId: ID;
  conversationId: ID;
  routineId: ID | null;
  parentRunId: ID | null;
  trigger: RunTrigger;
  status: RunStatus;
  prompt: string;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: RunUsage | null;
  model: string | null;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
  createdAt: ISODate;
  /** In run lists: why a paused run stands still (and until when). */
  pause?: RunPause | null;
}

/* ------------------------------------------------------------------ */
/* Dreams: background memory consolidation                              */
/* ------------------------------------------------------------------ */

export type DreamReason = "schedule" | "manual";
/**
 * `paused`: a scheduled dream gave way to a run someone waits for (rolled back, retried when the agent is idle) ·
 * `reverted`: the human undid the dream's changes. Failed, cancelled and paused dreams changed nothing (rolled back).
 */
export type DreamStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "paused" | "reverted";
/** What a dream did to one memory entry (reported by the agent). */
export type DreamChangeKind = "added" | "updated" | "merged" | "removed" | "corrected" | "dated";

export interface DreamChange {
  kind: DreamChangeKind;
  /** One line: the entry and why it changed. */
  text: string;
}

/** A memory file a dream changed. before/after = null: the file didn't exist before / was deleted. */
export interface DreamFileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface Dream {
  id: ID;
  agentId: ID;
  runId: ID | null;
  reason: DreamReason;
  status: DreamStatus;
  /** Activity the dream reviewed: runs that finished after `sourceFrom` (null = from the start) up to `sourceTo`. */
  sourceFrom: ISODate | null;
  sourceTo: ISODate | null;
  /** Exchanges (finished runs) and conversations the dream reviewed. */
  exchanges: number;
  conversations: number;
  /** One or two sentences from the agent: what it consolidated. */
  summary: string;
  changes: DreamChange[];
  /** Paths of the memory files the dream changed (contents via the dream's detail). */
  files: string[];
  /** The changes can still be undone (no later edit touched the same files). */
  canRevert: boolean;
  error: string | null;
  createdAt: ISODate;
  /** When the dream's run started (null while queued). */
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export interface DreamDetail extends Dream {
  fileChanges: DreamFileChange[];
}

/** Dreaming status of one agent. */
export interface DreamOverview {
  /** Dreaming is switched on in Settings → Memory. */
  enabled: boolean;
  /** Next scheduled dream time (null when dreaming is off or the schedule is invalid). */
  nextDreamAt: ISODate | null;
  /** Activity since the last successful dream, waiting to be consolidated. */
  pending: { exchanges: number; conversations: number; since: ISODate | null };
  /** The dream currently queued or running, if any. */
  active: Dream | null;
  /** Latest dreams, newest first. */
  dreams: Dream[];
}

/* ------------------------------------------------------------------ */
/* Vault: credentials (logins) and TOTP (2FA)                          */
/* ------------------------------------------------------------------ */

export interface Credential {
  id: ID;
  workspaceId: ID | null;
  name: string;
  /** Primary login URL */
  url: string;
  /** Domains this login applies to, e.g. ["github.com"] */
  domains: string[];
  username: string;
  /** Present only when explicitly revealed */
  password?: string;
  hasPassword: boolean;
  notes?: string;
  /** Linked TOTP entry */
  totpId: ID | null;
  tags: string[];
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpEntry {
  id: ID;
  workspaceId: ID | null;
  issuer: string;
  accountName: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  credentialId: ID | null;
  icon: string | null;
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface TotpCode {
  id: ID;
  code: string;
  /** seconds remaining in the current period */
  remaining: number;
  period: number;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  /** DEK stored in OS keychain for auto-unlock */
  rememberDevice: boolean;
  autoLockMinutes: number;
}

/* ------------------------------------------------------------------ */
/* Missing logins                                                       */
/* ------------------------------------------------------------------ */

export type MissingLoginStatus = "open" | "resolved" | "dismissed";
export type MissingLoginKind = "missing_credential" | "invalid_credential" | "missing_totp" | "missing_account" | "other";

export interface MissingLogin {
  id: ID;
  agentId: ID | null;
  runId: ID | null;
  workspaceId: ID | null;
  kind: MissingLoginKind;
  service: string;
  url: string;
  reason: string;
  status: MissingLoginStatus;
  credentialId: ID | null;
  occurrences: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Integrations: MCP servers + Composio                                 */
/* ------------------------------------------------------------------ */

export type McpTransport = "stdio" | "http" | "sse";
export type McpSource = "custom" | "composio";

export interface McpServer {
  id: ID;
  workspaceId: ID | null;
  /** Pinned to a single agent (optional) */
  agentId: ID | null;
  name: string;
  description: string;
  source: McpSource;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** Names only; values are encrypted server side. */
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  /** For composio servers */
  composio?: { toolkits: string[]; userId: string } | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface McpServerInput {
  workspaceId: ID | null;
  agentId: ID | null;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Plain values; a value of "********" keeps the stored one. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* API tools: an API key, what it's for and how to call it              */
/* ------------------------------------------------------------------ */

/** Where Godmode puts the key on requests: a header (`<name>: <prefix><key>`) or a query parameter (`?<name>=<key>`). */
export interface ApiToolAuth {
  in: "header" | "query";
  name: string;
  prefix: string;
}

export interface ApiTool {
  id: ID;
  workspaceId: ID | null;
  /** Pinned to a single agent (optional) */
  agentId: ID | null;
  name: string;
  /** What agents can use it for. */
  description: string;
  /** How to call the API (Markdown). Agents read it before their first request. */
  docs: string;
  docsUrl: string;
  /** The key is only ever sent to URLs under this address. "" = no requests through Godmode (env var only). */
  baseUrl: string;
  auth: ApiToolAuth;
  /** GET path (under baseUrl) that checks the key. "" = no test. */
  testPath: string;
  /** Environment variable runs get the key in; null = only through Godmode (agents never see the key). */
  envVar: string | null;
  /** Preset it was created from, e.g. "gemini" (UI icon). */
  preset: string | null;
  hasKey: boolean;
  enabled: boolean;
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ApiToolInput {
  workspaceId?: ID | null;
  agentId?: ID | null;
  name: string;
  description?: string;
  docs?: string;
  docsUrl?: string;
  baseUrl?: string;
  auth?: ApiToolAuth;
  testPath?: string;
  envVar?: string | null;
  preset?: string | null;
  /** New key. Omitted = keep the stored one, "" = remove it. */
  apiKey?: string;
  enabled?: boolean;
}

export interface ApiToolTestResult {
  ok: boolean;
  status: number | null;
  ms: number;
  message: string;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  logo: string | null;
  description: string;
  categories: string[];
  authSchemes: string[];
  noAuth: boolean;
}

export interface ComposioConnection {
  id: ID;
  /** Composio connected account id */
  connectedAccountId: string;
  toolkit: string;
  workspaceId: ID | null;
  agentId: ID | null;
  userId: string;
  status: string;
  createdAt: ISODate;
}

export interface ComposioStatus {
  configured: boolean;
  valid: boolean | null;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Browser                                                              */
/* ------------------------------------------------------------------ */

export interface BrowserProfile {
  id: ID;
  workspaceId: ID | null;
  name: string;
  /** Directory of the Chromium user-data-dir managed by Godmode */
  userDataDir: string;
  isDefault: boolean;
  /** Source of last cookie import e.g. "Chrome — Profile 1" */
  importedFrom: string | null;
  importedAt: ISODate | null;
  cookieCount: number;
  running: boolean;
  cdpUrl: string | null;
  /** How the running browser was started; null while it isn't running. */
  headless: boolean | null;
  stealth: boolean | null;
  /** Chats with tabs open in the running browser, in the order they opened their first tab. */
  chats: BrowserChat[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A chat's own tabs in a profile's browser: chats work in parallel, each in its own tabs, with the profile's logins. */
export interface BrowserChat {
  conversationId: ID;
  /** null when the conversation no longer exists */
  title: string | null;
  agentId: ID | null;
  /** The tab the chat's agent works in */
  url: string;
  pageTitle: string;
  tabs: number;
  /** A run of the chat is using the browser right now */
  active: boolean;
  lastUsedAt: ISODate;
}

export interface LocalChromeProfile {
  browser: string; // "Google Chrome", "Chromium", "Microsoft Edge", "Brave"
  profileDir: string; // "Default", "Profile 1"
  name: string;
  email: string | null;
  path: string;
}

/* ------------------------------------------------------------------ */
/* Notifications, audit, settings                                       */
/* ------------------------------------------------------------------ */

/** `question`: an agent asked something and waits for the answer (marked read once it is answered or withdrawn). */
export type NotificationKind = "info" | "success" | "warning" | "error" | "missing_login" | "run" | "question";

export interface AppNotification {
  id: ID;
  kind: NotificationKind;
  title: string;
  body: string;
  /** In-app route, e.g. /agents/abc */
  link: string | null;
  read: boolean;
  createdAt: ISODate;
}

export interface AuditEntry {
  id: ID;
  ts: ISODate;
  actor: string; // "user" | "agent:<id>" | "system"
  action: string; // e.g. "credential.fill", "credential.reveal", "vault.unlock"
  target: string | null;
  details: Record<string, unknown>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line of the diagnostic log (`<data>/logs/godmode.jsonl`). Secrets are masked before it is written. */
export interface LogEntry {
  ts: ISODate;
  level: LogLevel;
  /** Subsystem that wrote it: "runner", "http", "vault", "ui", … */
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
  err?: { name?: string; message: string; stack?: string };
}

/** Recurring warnings and errors, grouped by what they say (ids and numbers ignored). */
export interface LogIssue {
  level: "warn" | "error";
  scope: string;
  msg: string;
  count: number;
  firstTs: ISODate;
  lastTs: ISODate;
}

export interface LogOverview {
  path: string;
  sizeBytes: number;
  entries: number;
  counts: Record<LogLevel, number>;
  firstTs: ISODate | null;
  lastTs: ISODate | null;
  issues: LogIssue[];
}

export interface DiagnosticsSettings {
  /** Also record every request and debug details (the log fills faster). */
  verbose: boolean;
}

/** Keeping the tools Godmode relies on working and current (Settings → System). */
export interface MaintenanceSettings {
  /** Repair in the background what Godmode can repair by itself: file permissions and missing required tools. */
  autoFix: boolean;
  /** Install updates of the installed tools in the background, while no agent is working. */
  autoUpdate: boolean;
  /** Clean up what is safe to remove (Settings → Cleanup, recommended items) once a day, while no agent is working. */
  autoCleanup: boolean;
}

export interface GeneralSettings {
  theme: "dark" | "light" | "system";
  accent: string;
  /** User display name for greetings */
  userName: string;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  desktopNotifications: boolean;
  language: string;
}

export interface RunnerSettings {
  /** Path to claude CLI; empty = auto-detect */
  claudePath: string;
  model: string;
  fallbackModel: string;
  effort: Effort;
  /**
   * Ultracode by default: Claude Code plans every task as a dynamic workflow of several subagents, at any effort
   * level. Thorough, but slower and far more tokens. Only applies to models that support it (ClaudeModel.ultracode).
   */
  ultracode: boolean;
  /** --dangerously-skip-permissions (full bypass). */
  bypassPermissions: boolean;
  maxConcurrentRuns: number;
  /** Timeout per run in minutes */
  runTimeoutMinutes: number;
  /** A run that hit Claude's usage limit continues by itself once the limit has reset. */
  autoContinueOnLimit: boolean;
  /** The watchdog stops runs that stall or go in circles (see heartbeat.ts). */
  watchdog: boolean;
  /** No sign of life for this long (a tool that runs: three times as long, at least 30 minutes) = stalled. */
  stallMinutes: number;
  /** The same tool with the same input and the same result this many times in a row = going in circles. */
  loopRepeats: number;
  defaultMaxBudgetUsd: number | null;
  /** What the whole team may cost per calendar month in USD; used up = unattended work waits. null = no budget. */
  monthlyBudgetUsd: number | null;
  extraArgs: string[];
  /** Global instructions: included in every run of every agent. */
  appendSystemPrompt: string;
}

export interface BrowserSettings {
  enabled: boolean;
  /** Path to Chrome/Chromium; empty = auto-detect */
  chromePath: string;
  headless: boolean;
  /** browser-use MCP command; empty = default uvx command */
  browserUseCommand: string;
  keepAliveMinutes: number;
  liveView: boolean;
  /** Hide automation signals so sites don't treat agents as bots (applies when a browser launches). */
  stealth: boolean;
}

export interface ComputerSettings {
  /** Agents may see and control the computer when a screen, window or tab is shared with them. */
  enabled: boolean;
  /** Use Cua Driver (trycua/cua) for background control of single windows. Off = Godmode's built-in helper (macOS). */
  useCuaDriver: boolean;
  /** Custom cua-driver command; empty = the pinned version via uvx. */
  cuaDriverCommand: string;
  /** A shared window may be brought to the front briefly when a background action doesn't land. */
  allowForeground: boolean;
  /** Show Cua Driver's agent cursor on the window an agent controls. */
  agentCursor: boolean;
  /** Stream what agents see while you watch. */
  liveView: boolean;
  /** Live view frames per second (1–10). */
  liveViewFps: number;
  /** Long edge of screenshots sent to the model, in pixels (the model sees at most ~1.15 megapixels). */
  screenshotMaxSize: number;
}

export type SttProvider = "browser" | "openai";
export type TtsProvider = "browser" | "openai" | "elevenlabs";

export interface VoiceSettings {
  enabled: boolean;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  /** Auto-speak assistant replies when message was dictated */
  autoSpeak: boolean;
  language: string;
  openaiBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  elevenlabsVoiceId: string;
  /** Web speech voice name */
  browserVoice: string;
  rate: number;
}

export interface SecuritySettings {
  autoLockMinutes: number;
  /** Default secret access for new agents */
  defaultSecretAccess: SecretAccessMode;
  /** Redact known secret values from transcripts and logs */
  redactSecrets: boolean;
  /** Load website icons for logins from Google's favicon service (reveals the domains to Google). */
  fetchSiteIcons: boolean;
  /** Require confirmation in UI before an agent reveals a secret */
  auditRetentionDays: number;
}

export interface ServerSettings {
  host: string;
  port: number;
  /** Allow remote dashboard access (binding to non-loopback host) */
  remoteAccess: boolean;
  /** Password hash for dashboard login (never sent to UI) */
  hasDashboardPassword: boolean;
  allowedOrigins: string[];
}

export interface MemorySettings {
  /** "files" = MEMORY.md in agent repo (default); "claude-mem" = thedotmack/claude-mem plugin */
  backend: "files" | "claude-mem";
  autoCommit: boolean;
  /** Summarize and store learnings after each run */
  reflectAfterRun: boolean;
  /** Load MEMORY.md into every new session's system prompt (the agent starts each chat already knowing it). */
  injectMemory: boolean;
  dreaming: DreamingSettings;
}

/**
 * Dreaming: agents periodically review their recent conversations in the background and rewrite their memory —
 * capturing what was never explicitly saved, merging duplicates, fixing contradictions and dating time-bound facts.
 */
export interface DreamingSettings {
  enabled: boolean;
  /** When agents dream: cron expression (5 fields) in local time, e.g. "0 3 * * *" = every night at 03:00. */
  cron: string;
  /** Model for dreams (alias or id). "" = the agent's own model. */
  model: string;
  /** A scheduled dream needs at least this many new exchanges (finished runs) since the agent's last dream. */
  minNewExchanges: number;
  /**
   * Without enough new activity, still dream when the last dream is this many days old and the memory mentions
   * dates — so plans that have passed are rewritten as past events. 0 = never.
   */
  refreshDays: number;
}

export interface VmSettings {
  /** Agents may work in macOS VMs assigned to them, their chat or their workspace. */
  enabled: boolean;
  /**
   * Runs with a VM stay off this Mac: Claude Code's own Bash tool (which would run here) is turned off, and permissions
   * aren't bypassed, so its file tools only reach the agent's repository, the chat's folder and the VM's shared folder.
   */
  isolateHostShell: boolean;
  /**
   * Agents may type saved logins and 2FA codes into their VM's screen (vm tools `fill_login` / `fill_totp`). Godmode
   * types the values, so the model never sees them, and passwords only go into password fields (macOS secure input) —
   * but unlike browser fills they can't be bound to the login's website. Turning it on needs a vault grant.
   */
  vaultFill: boolean;
  /**
   * What happens to running VMs when Godmode quits: "suspend" saves their memory to disk so they resume where they
   * left off, "stop" shuts macOS down, "keep" leaves them running (Godmode picks them up again when it starts).
   * Disks are always kept.
   */
  onQuit: "suspend" | "stop" | "keep";
  /** Stop a VM after it was not used by any run for this many minutes. 0 = never. */
  idleStopMinutes: number;
  /** Custom tart binary; empty = Godmode's own copy (installed on demand) or one on PATH. */
  tartPath: string;
}

/** The phone app: phones reach Godmode over Tailscale (see mobile.ts). */
export interface MobileSettings {
  /** Paired phones may connect. */
  enabled: boolean;
  /** Port Godmode listens on for phones, on this computer's Tailscale address only. */
  port: number;
}

export interface Settings {
  general: GeneralSettings;
  runner: RunnerSettings;
  browser: BrowserSettings;
  computer: ComputerSettings;
  vm: VmSettings;
  voice: VoiceSettings;
  security: SecuritySettings;
  server: ServerSettings;
  memory: MemorySettings;
  diagnostics: DiagnosticsSettings;
  maintenance: MaintenanceSettings;
  mobile: MobileSettings;
  /** Godmode Cloud (see cloud.ts). The link secret is never part of the settings. */
  cloud: CloudSettings;
  onboardingComplete: boolean;
}

/* ------------------------------------------------------------------ */
/* Models (as offered by the installed Claude Code CLI)                 */
/* ------------------------------------------------------------------ */

export interface ClaudeModel {
  /** Value for `claude --model`: an alias ("opus") or a full model id. */
  id: string;
  /** Model id the value currently resolves to, e.g. "claude-opus-5-5". */
  resolvedModel: string;
  label: string;
  description: string;
  /** Effort levels the model accepts, low → high. Empty = no effort control. */
  efforts: Effort[];
  /** Ultracode can be turned on with this model: the installed Claude Code has dynamic workflows and the model supports them. */
  ultracode: boolean;
  /** Newest model of its family; the others are older versions. */
  latest: boolean;
}

export interface ModelCatalog {
  models: ClaudeModel[];
  /** "claude" = reported by the installed Claude Code CLI, "builtin" = static list (CLI missing or unreachable). */
  source: "claude" | "builtin";
  claudeVersion: string | null;
  fetchedAt: ISODate;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Doctor (dependency checks)                                           */
/* ------------------------------------------------------------------ */

export type DependencyId = "claude" | "claude-auth" | "uv" | "browser-use" | "chrome" | "git" | "claude-mem" | "cua-driver";

export interface DependencyStatus {
  id: DependencyId;
  name: string;
  ok: boolean;
  version: string | null;
  path: string | null;
  detail: string;
  required: boolean;
  installable: boolean;
  installHint: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  checkedAt: ISODate;
  dependencies: DependencyStatus[];
}

/** Claude Code's release channel (`autoUpdatesChannel` in ~/.claude/settings.json). */
export type ClaudeReleaseChannel = "latest" | "stable";

export interface ClaudeUpdateStatus {
  current: string | null;
  latest: string | null;
  channel: ClaudeReleaseChannel;
  updateAvailable: boolean;
  checkedAt: ISODate;
}

export interface ClaudeUpdateResult {
  ok: boolean;
  previous: string | null;
  version: string | null;
  output: string;
}

/* ------------------------------------------------------------------ */
/* Permissions, repairs and tool updates (Settings → System)            */
/* ------------------------------------------------------------------ */

export type PermissionId = "data-dir" | "data-private" | "tool-binaries" | "claude-config" | "accessibility" | "screen-recording" | "full-disk-access";

export interface PermissionStatus {
  id: PermissionId;
  name: string;
  ok: boolean;
  detail: string;
  /** File or folder the check is about. */
  path: string | null;
  /** Godmode can't work without it; false = only a feature is limited. */
  required: boolean;
  /**
   * How a problem gets solved: "auto" = Godmode repairs it itself, "request" = Godmode asks the system and the human
   * allows it there, "manual" = only the human can (see fixHint).
   */
  fix: "auto" | "request" | "manual";
  fixHint: string;
}

export interface PermissionReport {
  ok: boolean;
  checkedAt: ISODate;
  permissions: PermissionStatus[];
}

/** What a repair did: "pending" = the system now waits for the human, "manual" = Godmode can't do it. */
export type FixOutcome = "fixed" | "pending" | "failed" | "manual";

export interface FixResult {
  kind: "dependency" | "permission";
  id: DependencyId | PermissionId;
  name: string;
  outcome: FixOutcome;
  output: string;
}

export interface FixReport {
  /** Nothing that Godmode needs is still broken. */
  ok: boolean;
  startedAt: ISODate;
  finishedAt: ISODate;
  results: FixResult[];
}

export type ToolId = Exclude<DependencyId, "claude-auth"> | "tart";

/**
 * How a tool is kept current: "release" follows its own releases, "pinned" is the version this Godmode release was
 * tested with, "external" is updated by the system or a package manager.
 */
export type UpdateTrack = "release" | "pinned" | "external";

export interface ToolUpdateStatus {
  id: ToolId;
  name: string;
  installed: boolean;
  current: string | null;
  /** Version an update would install; null = unknown. */
  latest: string | null;
  updateAvailable: boolean;
  /** Godmode can install updates of it. */
  updatable: boolean;
  track: UpdateTrack;
  detail: string;
}

export interface UpdateReport {
  checkedAt: ISODate;
  tools: ToolUpdateStatus[];
}

export interface ToolUpdateResult {
  id: ToolId;
  name: string;
  ok: boolean;
  /** Nothing was installed: it already was up to date. */
  upToDate: boolean;
  previous: string | null;
  version: string | null;
  output: string;
}

/** The background upkeep (settings.maintenance) and what its last pass did. */
export interface MaintenanceStatus {
  running: boolean;
  lastRunAt: ISODate | null;
  nextRunAt: ISODate | null;
  /** Why the last pass left updates for later, e.g. agents were working. */
  postponed: string | null;
  fixes: FixResult[];
  updates: ToolUpdateResult[];
}

/* ------------------------------------------------------------------ */
/* Cleanup (Settings → Cleanup)                                         */
/* ------------------------------------------------------------------ */

export type CleanupId =
  | "temp-files"
  | "browser-cache"
  | "task-worktrees"
  | "task-clones"
  | "database"
  | "old-logs"
  | "vm-downloads"
  | "trash"
  | "vm-images";

export interface CleanupEntry {
  name: string;
  path: string | null;
  bytes: number;
  modifiedAt: ISODate | null;
  /** Why this one stays when its group is cleaned (uncommitted changes, the browser is open…); null = it goes. */
  kept: string | null;
}

export interface CleanupItem {
  id: CleanupId;
  name: string;
  detail: string;
  /** What cleaning frees (entries that are kept don't count). */
  bytes: number;
  count: number;
  /** Safe to clean without looking: selected by default and cleaned by the automatic cleanup. */
  recommended: boolean;
  /** Why it can't be cleaned right now; null = it can. */
  blocked: string | null;
  entries: CleanupEntry[];
}

export type StorageArea = "agents" | "browser" | "vms" | "repos" | "database" | "other";

export interface StorageUsage {
  area: StorageArea;
  name: string;
  bytes: number;
}

export type HealthCheckId = "database" | "disk" | "worktrees";

export interface HealthCheck {
  id: HealthCheckId;
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

export interface CleanupResult {
  id: CleanupId;
  name: string;
  ok: boolean;
  freedBytes: number;
  removed: number;
  /** Entries left alone (see CleanupEntry.kept). */
  kept: number;
  output: string;
}

export interface CleanupRun {
  automatic: boolean;
  startedAt: ISODate;
  finishedAt: ISODate;
  freedBytes: number;
  results: CleanupResult[];
}

export interface CleanupReport {
  checkedAt: ISODate;
  dataDir: string;
  disk: { freeBytes: number; totalBytes: number } | null;
  storage: StorageUsage[];
  checks: HealthCheck[];
  items: CleanupItem[];
  lastRun: CleanupRun | null;
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                            */
/* ------------------------------------------------------------------ */

export interface Bootstrap {
  version: string;
  mode: "desktop" | "server";
  dataDir: string;
  /** Home directory of the machine running the core (paths in the UI are shown relative to it). */
  homeDir: string;
  platform: string;
  vault: VaultStatus;
  settings: Settings;
  defaultAgentId: ID | null;
  counts: {
    agents: number;
    workspaces: number;
    credentials: number;
    totp: number;
    openMissingLogins: number;
    /** Questions and approvals agents wait for (see AgentQuestion). */
    openQuestions: number;
    runningRuns: number;
    unreadNotifications: number;
    /** People waiting for approval to talk to a messaging bot. */
    messagingRequests: number;
    /** Everything that waits for the human ("Needs you"), by kind. */
    attention: AttentionCounts;
    /** Chats with something new, not archived. */
    unreadChats: number;
  };
}
