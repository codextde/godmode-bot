/**
 * Facts the team package writes down for rows that predate it: the built-in agent's role, who wrote old automation,
 * handoff and board prompts, and "Run task" chats (once labelled API). Idempotent; also run after a restore, because a
 * backup from before migration 53 brings those rows back without them. Migration 53 embeds it: only ever add guarded,
 * idempotent statements here.
 */
export const TEAM_BACKFILL_SQL = /* sql */ `
UPDATE agents SET role = 'Chief of staff' WHERE is_default = 1 AND role = '';
UPDATE messages SET source = 'automation' WHERE source IS NULL AND role = 'user' AND run_id IN (SELECT id FROM runs WHERE trigger IN ('routine', 'check'));
UPDATE messages SET source = 'delegation' WHERE source IS NULL AND role = 'user' AND run_id IN (SELECT id FROM runs WHERE trigger = 'delegation');
UPDATE messages SET source = 'task' WHERE source IS NULL AND role = 'user' AND rowid IN (
  SELECT MIN(m.rowid) FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE c.origin = 'task' AND m.role = 'user' GROUP BY m.conversation_id);
UPDATE conversations SET origin = 'chat' WHERE origin = 'api';
`;

/**
 * Who filed a ticket and why it is blocked, for tickets from before migration 51. Idempotent (only rows without the
 * facts); run after a restore, because a backup from before migration 51 brings tickets back without them.
 */
export const TICKET_FACTS_SQL = /* sql */ `
UPDATE tasks SET created_by = COALESCE(
  (SELECT actor FROM audit_log WHERE action = 'task.create' AND target = tasks.id AND actor LIKE 'agent:%' ORDER BY ts LIMIT 1), 'user')
  WHERE created_by = 'user';
UPDATE tasks SET blocked_kind = CASE
    WHEN blocked_reason IS NULL OR blocked_reason = '' THEN 'manual'
    WHEN blocked_reason LIKE 'Interrupted%' THEN 'interrupted'
    WHEN blocked_reason = 'Stopped before it finished.' THEN 'stopped'
    WHEN blocked_reason LIKE 'Couldn''t push%' THEN 'publish'
    WHEN blocked_reason LIKE 'Couldn''t create the task''s worktree%' OR blocked_reason LIKE 'Coding tasks need a git repository%'
      OR blocked_reason LIKE '% is disabled — %' OR blocked_reason LIKE 'The assigned agent doesn''t exist%' THEN 'setup'
    ELSE NULL END
  WHERE status = 'blocked' AND blocked_kind IS NULL;
`;

/**
 * What was spent before the spend ledger existed, booked when each run last stood still or ended. Idempotent (runs that
 * have a ledger row are skipped); also run after a restore, because a backup from before migration 52 has no ledger.
 * Costs of runs from before migration 30 are Claude's session totals: only what a run added to its chat's session
 * counts. Migration 52 embeds it: only ever add guarded, idempotent statements here.
 */
export const SPEND_BACKFILL_SQL = /* sql */ `
INSERT INTO spend (run_id, agent_id, agent_name, trigger, at, cost_usd, duration_ms, failed)
SELECT id, agent_id, agent_name, trigger, at, MAX(0, own), duration_ms, failed FROM (
  SELECT r.id, r.agent_id, COALESCE(a.name, '') AS agent_name, r.trigger,
    COALESCE(r.finished_at, r.started_at, r.created_at) AS at,
    CASE
      WHEN r.cost_usd IS NULL THEN 0
      WHEN r.created_at >= COALESCE((SELECT applied_at FROM _migrations WHERE id = 30), '') THEN r.cost_usd
      WHEN LAG(r.cost_usd) OVER w IS NOT NULL AND r.cost_usd >= LAG(r.cost_usd) OVER w THEN r.cost_usd - LAG(r.cost_usd) OVER w
      ELSE r.cost_usd
    END AS own,
    COALESCE(r.duration_ms, 0) AS duration_ms, r.status = 'failed' AS failed
  FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
  WHERE r.status IN ('succeeded', 'failed', 'cancelled', 'paused')
  WINDOW w AS (PARTITION BY r.conversation_id ORDER BY r.created_at, r.rowid)
) WHERE id NOT IN (SELECT run_id FROM spend) AND (own > 0 OR duration_ms > 0);
`;

/**
 * Ordered, append-only SQL migrations. Never edit a shipped migration — add a new one.
 * JSON columns are stored as TEXT. Encrypted columns end with `_enc` and hold vault ciphertext.
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial",
    sql: /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'violet',
  icon TEXT NOT NULL DEFAULT '🗂️',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  avatar TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT 'violet',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  permissions TEXT NOT NULL DEFAULT '{}',
  browser TEXT NOT NULL DEFAULT '{}',
  mcp_server_ids TEXT NOT NULL DEFAULT '[]',
  inherit_mcp INTEGER NOT NULL DEFAULT 1,
  subagents TEXT NOT NULL DEFAULT '[]',
  repo_path TEXT NOT NULL,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  reuse_conversation INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_agent ON routines(agent_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  origin TEXT NOT NULL DEFAULT 'chat',
  claude_session_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id, last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  routine_id TEXT,
  parent_run_id TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  error TEXT,
  note TEXT,
  cost_usd REAL,
  duration_ms INTEGER,
  num_turns INTEGER,
  usage TEXT,
  model TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  domains TEXT NOT NULL DEFAULT '[]',
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT,
  notes_enc TEXT,
  totp_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_workspace ON credentials(workspace_id);

CREATE TABLE IF NOT EXISTS totp (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  credential_id TEXT,
  icon TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_totp_workspace ON totp(workspace_id);

CREATE TABLE IF NOT EXISTS missing_logins (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  run_id TEXT,
  workspace_id TEXT,
  kind TEXT NOT NULL DEFAULT 'missing_credential',
  service TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  credential_id TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missing_logins_status ON missing_logins(status);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'custom',
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  env_enc TEXT,
  headers_enc TEXT,
  env_keys TEXT NOT NULL DEFAULT '[]',
  header_keys TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  composio TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS composio_connections (
  id TEXT PRIMARY KEY,
  connected_account_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'INITIATED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_data_dir TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  imported_from TEXT,
  imported_at TEXT,
  cookie_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: "conversation_overrides",
    sql: /* sql */ `
ALTER TABLE conversations ADD COLUMN model TEXT;
ALTER TABLE conversations ADD COLUMN effort TEXT;
`,
  },
  {
    id: 3,
    name: "working_directories",
    sql: /* sql */ `
ALTER TABLE agents ADD COLUMN working_directory TEXT;
ALTER TABLE conversations ADD COLUMN working_directory TEXT;
`,
  },
  {
    id: 4,
    name: "computer_use",
    sql: /* sql */ `
ALTER TABLE agents ADD COLUMN computer TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN computer_target TEXT;
`,
  },
  {
    id: 5,
    name: "layered_instructions",
    sql: /* sql */ `
ALTER TABLE workspaces ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN instructions_digest TEXT;
-- Sessions started with global instructions under the old heading must be told about changes.
UPDATE conversations SET instructions_digest = 'legacy'
WHERE claude_session_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'runner' AND trim(coalesce(json_extract(value, '$.appendSystemPrompt'), '')) != '');
`,
  },
  {
    id: 6,
    name: "automation_triggers",
    sql: /* sql */ `
ALTER TABLE routines ADD COLUMN trigger TEXT NOT NULL DEFAULT '{"type":"schedule"}';
ALTER TABLE routines ADD COLUMN filter TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN trigger_state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE routines ADD COLUMN webhook_token_hash TEXT;
ALTER TABLE routines ADD COLUMN webhook_token_enc TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_webhook ON routines(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_events (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  title TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL,
  run_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_events_routine ON automation_events(routine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_events_status ON automation_events(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_events_dedupe ON automation_events(routine_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
`,
  },
  {
    id: 7,
    name: "dreaming",
    sql: /* sql */ `
-- Dreams: background memory consolidation runs. \`snapshot\` holds the memory files as they were when the dream
-- started (JSON, cleared when it ends); \`files\` the files it changed, before and after (JSON), for review and undo.
CREATE TABLE IF NOT EXISTS dreams (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  source_from TEXT,
  source_to TEXT,
  exchanges INTEGER NOT NULL DEFAULT 0,
  conversations INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  snapshot TEXT,
  error TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dreams_agent ON dreams(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dreams_run ON dreams(run_id);
-- Digest of MEMORY.md as the conversation's Claude session last saw it (changes are pointed out on resume).
ALTER TABLE conversations ADD COLUMN memory_digest TEXT;
`,
  },
  {
    id: 8,
    name: "vms",
    sql: /* sql */ `
-- macOS VMs (Tart). A VM's disk lives in <data>/vm/tart/vms/<id>, its shared folder in <data>/vm/shared/<id> (both
-- derived from the id, so the data dir can move; a restored backup brings the records, not the disks).
CREATE TABLE IF NOT EXISTS vms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  cpu INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  display TEXT NOT NULL,
  -- Set once Godmode prepared the guest (shared folder link, SSH key, computer name).
  provisioned_at TEXT,
  last_error TEXT,
  last_started_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Where agents work: the chat's VM, else the agent's, else the workspace's.
ALTER TABLE agents ADD COLUMN vm_id TEXT;
ALTER TABLE conversations ADD COLUMN vm_id TEXT;
ALTER TABLE workspaces ADD COLUMN vm_id TEXT;
`,
  },
  {
    id: 9,
    name: "workspace_sources",
    sql: /* sql */ `
-- Folders and git repositories attached to a workspace. \`path\` is the folder, or for git the clone's directory name
-- under <data>/repos/<workspace id>/ (derived, so the data dir can move).
CREATE TABLE IF NOT EXISTS workspace_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT,
  branch TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  note TEXT,
  commit_sha TEXT,
  head_branch TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_sources_workspace ON workspace_sources(workspace_id, position);
`,
  },
  {
    id: 10,
    name: "messaging",
    sql: /* sql */ `
-- Bots on Slack, Telegram and Teams that people use to talk to agents. \`secrets_enc\` holds the tokens (sealed JSON),
-- \`endpoint_hash\` the SHA-256 of a Teams bot's secret endpoint token, \`state\` runtime data (Telegram update offset).
CREATE TABLE IF NOT EXISTS messaging_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  bot TEXT NOT NULL DEFAULT '{}',
  config TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT,
  agent_ids TEXT NOT NULL DEFAULT '[]',
  default_agent_id TEXT,
  access TEXT NOT NULL DEFAULT 'approved',
  endpoint_hash TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_endpoint ON messaging_connections(endpoint_hash) WHERE endpoint_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS messaging_users (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES messaging_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_users_external ON messaging_users(connection_id, external_id);

-- \`reply\` says where answers go (Teams service URL, Slack thread, Telegram topic); \`user_id\` is the person of a direct chat.
CREATE TABLE IF NOT EXISTS messaging_chats (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES messaging_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'direct',
  user_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  conversation_id TEXT,
  reply TEXT NOT NULL DEFAULT '{}',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_chats_external ON messaging_chats(connection_id, external_id);
`,
  },
  {
    id: 11,
    name: "chat_browser_profile",
    sql: /* sql */ `
-- Browser profile a chat works in, overriding its agent's (and the workspace / global default).
ALTER TABLE conversations ADD COLUMN browser_profile_id TEXT;
`,
  },
  {
    id: 12,
    name: "chat_workspace",
    sql: /* sql */ `
-- Workspace a chat with a global agent was started in: it browses with that workspace's default profile.
ALTER TABLE conversations ADD COLUMN workspace_id TEXT;
`,
  },
  {
    id: 13,
    name: "followups",
    sql: /* sql */ `
-- A time an agent set to continue a chat on its own (one per chat). Removed when it runs or is cancelled.
CREATE TABLE IF NOT EXISTS followups (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  due_at TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_at);
`,
  },
  {
    id: 14,
    name: "tasks",
    sql: /* sql */ `
-- Kanban tasks agents work on. Coding tasks work in a checkout at <data>/tasks/<id> (derived from the id).
-- repo_url "" = the workspace's first git repository (workspace_sources).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'backlog',
  position REAL NOT NULL DEFAULT 0,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id TEXT,
  repo_url TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT '',
  branch TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_state TEXT,
  -- Last commit Godmode pushed to the branch (commits pushed by others since are merged in, never overwritten).
  pushed_sha TEXT,
  summary TEXT,
  blocked_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs(conversation_id, created_at);
`,
  },
  {
    id: 15,
    name: "api_tools",
    sql: /* sql */ `
-- APIs agents may call with a stored key (\`key_enc\`, sealed): what they're for, their docs, where the key may be sent
-- (\`base_url\`, \`auth\`) and the optional environment variable runs get it in.
CREATE TABLE IF NOT EXISTS api_tools (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  docs TEXT NOT NULL DEFAULT '',
  docs_url TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT '{}',
  test_path TEXT NOT NULL DEFAULT '',
  env_var TEXT,
  preset TEXT,
  key_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_tools_scope ON api_tools(workspace_id, agent_id);
`,
  },
  {
    id: 16,
    name: "ssh_servers",
    sql: /* sql */ `
-- Remote machines agents sign in to over SSH. \`*_enc\` are sealed with the vault key; \`key_info\` describes the private
-- key (type, fingerprint, public key — nothing secret). The host key is pinned on the first connection.
CREATE TABLE IF NOT EXISTS ssh_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'password',
  description TEXT NOT NULL DEFAULT '',
  password_enc TEXT,
  private_key_enc TEXT,
  passphrase_enc TEXT,
  key_info TEXT,
  host_key_type TEXT,
  host_key_fingerprint TEXT,
  os TEXT,
  last_connected_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- SSH servers an agent uses in every run, and the ones a chat adds (JSON arrays of ids).
ALTER TABLE agents ADD COLUMN ssh_server_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversations ADD COLUMN ssh_server_ids TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 17,
    name: "mobile_devices",
    sql: /* sql */ `
-- Phones paired with the Godmode app. \`token_hash\` is the SHA-256 of the phone's device token.
CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT,
  app_version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  last_address TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 18,
    name: "task_worktrees",
    sql: /* sql */ `
-- Every task with a repository works in its own git worktree at <data>/tasks/<id> on its own branch. repo_path is the
-- workspace folder (a git repository) the worktree comes from; "" = a remote repository (repo_url) Godmode clones.
ALTER TABLE tasks ADD COLUMN repo_path TEXT NOT NULL DEFAULT '';
`,
  },
  {
    id: 19,
    name: "task_attachments",
    sql: /* sql */ `
-- Files added to task descriptions (images, PDFs, …), stored at <data>/attachments/tasks/<id>/<name>. An upload belongs
-- to no task until a task's description links it (task_id); unclaimed uploads are swept after a day.
CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
`,
  },
  {
    id: 20,
    name: "agent_characters",
    sql: /* sql */ `
-- Every agent is a small character with a face and a personality. character is JSON (body, eyes, mouth, top, face,
-- neck); NULL = the stable default look derived from the agent id. personality is a preset id, free text or '' (none).
ALTER TABLE agents ADD COLUMN character TEXT;
ALTER TABLE agents ADD COLUMN personality TEXT NOT NULL DEFAULT '';
-- The built-in agent becomes Godmode's mascot, and turns emerald unless someone already restyled it.
UPDATE agents SET personality = 'buddy',
  character = '{"body":"blob","eyes":"dots","mouth":"smile","top":"bolt","face":"blush","neck":"none"}'
  WHERE is_default = 1;
UPDATE agents SET color = 'emerald' WHERE is_default = 1 AND color = 'violet' AND avatar = '⚡';
`,
  },
  {
    id: 21,
    name: "task_archive",
    sql: /* sql */ `
-- Archived tasks are off the board and never start; their status, worktree and branch stay. NULL = on the board.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
`,
  },
  {
    id: 22,
    name: "message_queue",
    sql: /* sql */ `
-- Messages sent while the agent was working in the chat. A row leaves the queue when the agent picks it up between two
-- steps of its run, or when it starts the chat's next run.
CREATE TABLE IF NOT EXISTS queued_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  voice INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queued_messages_conversation ON queued_messages(conversation_id, created_at);
`,
  },
  {
    id: 23,
    name: "paused_runs",
    sql: /* sql */ `
-- A run that stands still: the human paused it, or Claude's usage limit was reached. The row holds what continuing
-- needs and goes when the run continues or is stopped. resume_at: when the limit resets; auto = continue by itself
-- then (choice: what the human set for this run, NULL = the setting decides); retries counts such tries that hit the
-- limit again. delivered = 0: Claude never got what the run sent last, so
-- continuing sends it again (redo: that text with saved secrets masked, for after a restart).
CREATE TABLE IF NOT EXISTS paused_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_message_id TEXT,
  also_answers TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  limit_name TEXT,
  resume_at TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  choice INTEGER,
  delivered INTEGER NOT NULL DEFAULT 1,
  redo TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  voice INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paused_runs_agent ON paused_runs(agent_id);
`,
  },
  {
    id: 30,
    name: "session_cost",
    sql: /* sql */ `
-- What Claude Code has counted for the chat's Claude session so far. It reports the total of the whole session, so a
-- run's own cost is that total minus this. Runs recorded before this column hold such totals (their costs stay as they
-- are): the latest one of each chat with a session is where its count stands — a paused one too, which goes on from it.
ALTER TABLE conversations ADD COLUMN claude_session_cost_usd REAL;
UPDATE conversations SET claude_session_cost_usd = (
  SELECT r.cost_usd FROM runs r
  WHERE r.conversation_id = conversations.id AND r.cost_usd IS NOT NULL AND r.status IN ('succeeded', 'failed', 'paused')
  ORDER BY r.created_at DESC LIMIT 1
) WHERE claude_session_id IS NOT NULL;
`,
  },
  {
    id: 40,
    name: "ultracode",
    sql: /* sql */ `
-- Ultracode (Claude Code plans every task as a workflow of several agents). NULL = inherit: an agent the global
-- default, a chat its agent's.
ALTER TABLE agents ADD COLUMN ultracode INTEGER;
ALTER TABLE conversations ADD COLUMN ultracode INTEGER;
`,
  },
  {
    id: 50,
    name: "questions",
    sql: /* sql */ `
-- What an agent asked the human while it worked (ask_human, request_approval). An open one belongs to a run that
-- stands still for it (paused_runs.reason = 'question', written in the same transaction): answering continues that
-- run, stopping it withdraws the question. title: the question, or the step to approve. body: context / why.
-- affects: approvals only. cut_off = 1: another step was still running when the run was stopped for the question.
-- answer_owed = 1: answered, but the agent has not read the answer yet — the run continues with it, and when that run
-- breaks off first (a crash, a restart) the chat's next run starts with it. reminded_at: when an automation that keeps
-- skipping runs because of this question last reminded the human. posted_chat_id: the platform chat (messaging_chats)
-- the question was posted to; the owner's reply there answers it.
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- question | approval
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,                 -- the assistant message that shows the card
  task_id TEXT,
  routine_id TEXT,
  workspace_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  affects TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',       -- [{ id, label, description?, recommended? }]
  status TEXT NOT NULL DEFAULT 'open',      -- open | answered | approved | declined | withdrawn
  option_id TEXT,
  answer TEXT,                              -- saved secrets masked
  answer_attachments TEXT NOT NULL DEFAULT '[]',
  answered_via TEXT,                        -- app | phone | task | slack | telegram | teams
  answered_at TEXT,
  closed_reason TEXT,
  notification_id TEXT,
  cut_off INTEGER NOT NULL DEFAULT 0,
  answer_owed INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT,
  posted_chat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_run ON questions(run_id);
CREATE INDEX IF NOT EXISTS idx_questions_conversation ON questions(conversation_id);
-- A run waits for one question at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_open_run ON questions(run_id) WHERE status = 'open';

-- "This is me": the human who owns this Godmode, writing from a platform account. Only they see an agent's questions
-- in their chat and can answer them there.
ALTER TABLE messaging_users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 51,
    name: "task_tickets",
    sql: /* sql */ `
-- Tickets: priority, due date, labels, who filed them, what kind of block, what the work cost, and their timeline.
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'none';
-- A calendar day, YYYY-MM-DD.
ALTER TABLE tasks ADD COLUMN due_date TEXT;
-- JSON array of strings.
ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
-- 'user' or 'agent:<id>'.
ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
-- needs_input | failed | stopped | interrupted | publish | setup | manual; NULL unless blocked (or unknown, for old rows).
ALTER TABLE tasks ADD COLUMN blocked_kind TEXT;
-- Running totals over every run that ended in the task's conversations.
ALTER TABLE tasks ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;

UPDATE tasks SET created_by = COALESCE(
  (SELECT actor FROM audit_log WHERE action = 'task.create' AND target = tasks.id AND actor LIKE 'agent:%' ORDER BY ts LIMIT 1), 'user');

UPDATE tasks SET blocked_kind = CASE
    WHEN blocked_reason IS NULL OR blocked_reason = '' THEN 'manual'
    WHEN blocked_reason LIKE 'Interrupted%' THEN 'interrupted'
    WHEN blocked_reason = 'Stopped before it finished.' THEN 'stopped'
    WHEN blocked_reason LIKE 'Couldn''t push%' OR blocked_reason LIKE '%so Godmode didn''t push%' THEN 'publish'
    WHEN blocked_reason LIKE 'Couldn''t create the task''s worktree%' OR blocked_reason LIKE 'Coding tasks need a git repository%'
      OR blocked_reason LIKE '% is disabled — %' OR blocked_reason LIKE 'The assigned agent doesn''t exist%' THEN 'setup'
    ELSE NULL END
  WHERE status = 'blocked';

UPDATE tasks SET
  cost_usd  = COALESCE((SELECT SUM(cost_usd)    FROM runs WHERE conversation_id = tasks.conversation_id AND status IN ('succeeded','failed','cancelled')), 0),
  work_ms   = COALESCE((SELECT SUM(duration_ms) FROM runs WHERE conversation_id = tasks.conversation_id AND status IN ('succeeded','failed','cancelled')), 0),
  run_count =          (SELECT COUNT(*)         FROM runs WHERE conversation_id = tasks.conversation_id AND status IN ('succeeded','failed','cancelled'))
  WHERE conversation_id IS NOT NULL;

-- What happened on a task, oldest first. Append-only: nothing edits or deletes a row; rows go with their task.
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
-- One row per run for what a run causes once (a run's end may be handled twice: by its event and by settle()).
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_run ON task_events(task_id, kind, run_id)
  WHERE run_id IS NOT NULL AND kind IN ('started', 'waiting', 'delivered', 'blocked');
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
`,
  },
  {
    id: 53,
    name: "team",
    sql: /* sql */ `
-- Every agent has a job title and may report to another agent; NULL = it reports to the built-in agent, which reports
-- to the human. failed_run_id: the agent's latest real run (not a dream or a condition check) when it failed; NULL once
-- a later one ends or the human dismisses it.
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN reports_to TEXT;
ALTER TABLE agents ADD COLUMN failed_run_id TEXT;
-- Who wrote a user message: NULL = a human, else 'automation', 'delegation' or 'task'.
ALTER TABLE messages ADD COLUMN source TEXT;
${TEAM_BACKFILL_SQL}
`,
  },
  {
    // 60, not the next free id: other branches add migrations at the same time, and the migrator applies every missing
    // id in array order.
    id: 60,
    name: "runners",
    sql: /* sql */ `
-- Computers that run Godmode as a runner for this one. public_key: the runner's static X25519 key (base64url), pinned
-- when it was paired.
CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL UNIQUE,
  addresses TEXT NOT NULL DEFAULT '[]',
  port INTEGER NOT NULL,
  platform TEXT,
  arch TEXT,
  version TEXT,
  sync_browser INTEGER NOT NULL DEFAULT 1,
  last_address TEXT,
  last_seen_at TEXT,
  synced_at TEXT,
  sync_digest TEXT,
  sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- On a runner: the Godmode installations that may control it (their static X25519 keys).
CREATE TABLE IF NOT EXISTS link_controllers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  last_address TEXT,
  created_at TEXT NOT NULL
);
-- Agent memory as controller and runner last agreed on it (the base of the next three-way merge).
CREATE TABLE IF NOT EXISTS runner_memory (
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, agent_id)
);
-- runner_id: the runner a chat works on (its messages and runs are copies of the runner's). runner_state: what the
-- runner last said about it (JSON: running, activeRunId, paused, followup). runner_tools_id: a local chat whose agent
-- may run commands on that runner (autofix).
ALTER TABLE conversations ADD COLUMN runner_id TEXT;
ALTER TABLE conversations ADD COLUMN runner_state TEXT;
ALTER TABLE conversations ADD COLUMN runner_tools_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_runner ON conversations(runner_id) WHERE runner_id IS NOT NULL;
`,
  },
  {
    id: 52,
    name: "spend",
    sql: /* sql */ `
-- What the team spent, booked when it was spent: one row per stretch of a run (until it ended, or stood still for a
-- pause), so a run that continues next month is charged to next month for what it costs then. No foreign keys: spend
-- stays when an agent, a chat or a run is deleted (agent_name keeps who it was).
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL,
  at TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  -- 1: this stretch ended the run as failed.
  failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spend_at ON spend(at);
CREATE INDEX IF NOT EXISTS idx_spend_agent ON spend(agent_id, at);
${SPEND_BACKFILL_SQL}
-- A run held because a monthly budget is used up (reason 'budget'): whose budget ('agent' | 'team') and how much it was.
ALTER TABLE paused_runs ADD COLUMN budget_scope TEXT;
ALTER TABLE paused_runs ADD COLUMN budget_usd REAL;
`,
  },
  {
    id: 54,
    name: "needs_you",
    sql: /* sql */ `
-- A chat with something new: the run that ended while nobody had it open (NULL = read).
ALTER TABLE conversations ADD COLUMN unread_run_id TEXT;
-- When an automation tells the human that a run ended: 'failures' (default), 'always' or 'never'.
ALTER TABLE routines ADD COLUMN notify TEXT NOT NULL DEFAULT 'failures';
CREATE INDEX IF NOT EXISTS idx_runs_routine ON runs(routine_id, trigger, created_at);
`,
  },
  {
    id: 55,
    name: "budget_exempt",
    sql: /* sql */ `
-- A paused run the human started or let run past a used-up budget keeps that when it continues.
ALTER TABLE paused_runs ADD COLUMN exempt INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 57,
    name: "sub_tickets",
    sql: /* sql */ `
-- A sub-ticket: part of a bigger ticket (its parent waits until its sub-tickets are done, then continues with them).
ALTER TABLE tasks ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;
`,
  },
  {
    id: 58,
    name: "away_indexes",
    sql: /* sql */ `
-- "While you were away" reads what ended, and what was delivered, in a window of time.
CREATE INDEX IF NOT EXISTS idx_runs_finished ON runs(finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_events_kind ON task_events(kind, created_at);
`,
  },
  {
    id: 59,
    name: "parts_seen",
    sql: /* sql */ `
-- When the ticket's agent last got its parts' results (in its brief, or woken with them): parts that closed later are news.
ALTER TABLE tasks ADD COLUMN parts_seen_at TEXT;
`,
  },
  {
    id: 61,
    name: "parts_seen_backfill",
    sql: /* sql */ `
-- Tickets with parts from before parts_seen_at: their agent saw those parts already (they aren't news on its next run).
UPDATE tasks SET parts_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE parts_seen_at IS NULL AND status != 'in_progress' AND id IN (SELECT parent_id FROM tasks WHERE parent_id IS NOT NULL);
`,
  },
  {
    id: 62,
    name: "goals",
    sql: /* sql */ `
-- What the work is for: tickets serve a goal (its agent is told why), and the board shows how far each goal is.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE tasks ADD COLUMN goal_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id) WHERE goal_id IS NOT NULL;
`,
  },
  {
    id: 63,
    name: "ticket_dependencies",
    sql: /* sql */ `
-- A ticket that waits for others: it starts once each of them is delivered (or done, cancelled, archived).
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  waits_for_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, waits_for_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_waits_for ON task_dependencies(waits_for_id);
`,
  },
  {
    id: 64,
    name: "goals_of_deleted_workspaces",
    sql: /* sql */ `
-- Goals of workspaces deleted before they went along with them.
UPDATE tasks SET goal_id = NULL WHERE goal_id IN (SELECT id FROM goals WHERE workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM workspaces));
DELETE FROM goals WHERE workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM workspaces);
`,
  },
  {
    id: 31,
    name: "chat_secret_access",
    sql: /* sql */ `
-- 'fill': no raw secrets in this chat, whatever its agent may read — its task came from an agent that could not
-- read them itself. NULL = the agent's own secret access.
ALTER TABLE conversations ADD COLUMN secret_access TEXT;
`,
  },
  {
    id: 70,
    name: "connectors",
    sql: /* sql */ `
-- Apps outside Godmode (Claude Code, other MCP clients) that may call its management tools. \`token_hash\` is the
-- SHA-256 of the app's key. installed: Godmode added the app's entry to Claude Code on this computer.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'other',
  access TEXT NOT NULL DEFAULT 'manage',
  token_hash TEXT NOT NULL UNIQUE,
  installed INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  last_tool TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 71,
    name: "mods",
    sql: /* sql */ `
-- Claude Code mods. files: the plugin's files (JSON, path → text). check_report: what this computer's Claude Code said
-- about them; check_key: the files and the Claude Code that report is about. secrets_enc: sensitive option values.
CREATE TABLE IF NOT EXISTS mods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'puzzle',
  origin TEXT NOT NULL DEFAULT 'custom',
  template_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  files TEXT NOT NULL DEFAULT '{}',
  option_values TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT,
  secret_keys TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'all',
  agent_ids TEXT NOT NULL DEFAULT '[]',
  check_report TEXT,
  check_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 72,
    name: "heartbeats",
    sql: /* sql */ `
-- Heartbeats: the agent wakes on its own rhythm (agents.heartbeat, JSON). One row per beat: what it woke the agent on
-- (wakes), the tickets waiting for the human then (waiting), and the checklist's run.
ALTER TABLE agents ADD COLUMN heartbeat TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'scheduled',
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  wakes TEXT NOT NULL DEFAULT '[]',
  waiting TEXT NOT NULL DEFAULT '[]',
  changes INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  conversation_id TEXT,
  retried INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id, created_at);
-- Runs the watchdog stopped: where and why (report), and whether something tries again (action).
CREATE TABLE IF NOT EXISTS watchdog_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  report TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_agent ON watchdog_events(agent_id, created_at);
`,
  },
  {
    id: 73,
    name: "workspace_auto_merge",
    sql: /* sql */ `
-- 1: a delivered ticket's pull request is merged into its base branch right away (no review step).
ALTER TABLE workspaces ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 76,
    name: "runner_auto_update",
    sql: /* sql */ `
-- 1: the runner gets this computer's Godmode by itself when it runs another one (remote/runnerUpdates.ts).
ALTER TABLE runners ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    id: 77,
    name: "projects",
    sql: /* sql */ `
-- Optional projects inside a workspace, with their own context, folders/repositories (workspace_sources.project_id)
-- and browser profile. Chats, tickets and agents may belong to one.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'violet',
  icon TEXT NOT NULL DEFAULT '📁',
  instructions TEXT NOT NULL DEFAULT '',
  browser_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(workspace_id, slug);
ALTER TABLE workspace_sources ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
`,
  },
];
