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
    name: "tasks",
    sql: /* sql */ `
-- Kanban tasks agents work on. Coding tasks work in a checkout at <data>/tasks/<id> (derived from the id).
ALTER TABLE workspaces ADD COLUMN repo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN repo_branch TEXT NOT NULL DEFAULT '';
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
];
