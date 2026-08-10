export const SCHEMA_VERSION = 8;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'model')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_seen_at TEXT
);

-- One authenticated collaboration session per model agent. The bearer credential itself is never
-- stored: only its hash is, so a database copy cannot be replayed as an identity.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  credential_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'replaced')),
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  replaced_by_session_id TEXT REFERENCES agent_sessions(id)
);

CREATE TABLE IF NOT EXISTS project_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_repository (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  identity TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  common_git_dir TEXT NOT NULL,
  object_format TEXT NOT NULL,
  bound_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'in_review', 'accepted', 'cancelled')),
  owner_agent_id TEXT REFERENCES agents(id),
  version INTEGER NOT NULL DEFAULT 1,
  acceptance_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_json)),
  repository_identity TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  check_policy_identity TEXT NOT NULL,
  check_policy_json TEXT NOT NULL CHECK (json_valid(check_policy_json)),
  candidate_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lease_version INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_reservations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL CHECK (reason IN ('revision')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_roles (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer', 'verifier')),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  assigned_by TEXT NOT NULL REFERENCES agents(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role),
  UNIQUE (task_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL REFERENCES agents(id),
  recipient TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'sealed' CHECK (visibility IN ('sealed', 'revealed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('proposed', 'accepted', 'superseded')),
  supersedes_id TEXT REFERENCES decisions(id),
  actor TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blockers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  raised_by TEXT NOT NULL REFERENCES agents(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived')),
  resolved_by TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requester TEXT NOT NULL REFERENCES agents(id),
  reviewer TEXT REFERENCES agents(id),
  repository_identity TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'approved', 'needs_revision')),
  created_at TEXT NOT NULL,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  raised_by TEXT NOT NULL REFERENCES agents(id),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'non_blocking')),
  location TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_identity TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  command TEXT NOT NULL,
  command_argv_json TEXT NOT NULL CHECK (json_valid(command_argv_json)),
  check_id TEXT,
  check_policy_identity TEXT,
  exit_code INTEGER NOT NULL,
  runner TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_policy_overrides (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_identity TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  check_policy_identity TEXT,
  actor TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_worktrees (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  repository_identity TEXT NOT NULL,
  branch_name TEXT NOT NULL UNIQUE,
  worktree_path TEXT NOT NULL UNIQUE,
  head_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Actor and subject identifiers are deliberately not foreign keys: rejected attempts may name unknown targets.
CREATE TABLE IF NOT EXISTS operation_attempts (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  actor TEXT,
  subject_type TEXT,
  subject_id TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'rejected', 'failed', 'abandoned')),
  reason_code TEXT,
  error_class TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT REFERENCES operation_attempts(id),
  actor TEXT NOT NULL REFERENCES agents(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  timestamp TEXT NOT NULL
);

-- The exclusivity invariant itself: at most one current session per model agent, enforced by the
-- database rather than by whichever code path happens to open one.
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_current ON agent_sessions(agent_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS events_actor_cursor ON events(actor, id);
CREATE INDEX IF NOT EXISTS operation_attempts_started ON operation_attempts(started_at);
CREATE INDEX IF NOT EXISTS operation_attempts_subject ON operation_attempts(subject_type, subject_id, started_at);
CREATE INDEX IF NOT EXISTS claim_reservations_expires ON claim_reservations(expires_at);
CREATE INDEX IF NOT EXISTS task_roles_agent ON task_roles(agent_id, role, task_id);
CREATE INDEX IF NOT EXISTS messages_recipient_cursor ON messages(recipient, created_at);
CREATE INDEX IF NOT EXISTS proposals_task ON proposals(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_task_agent_unique ON proposals(task_id, agent_id);
CREATE INDEX IF NOT EXISTS reviews_task_commit ON reviews(task_id, commit_sha);
CREATE INDEX IF NOT EXISTS verifications_task_commit ON verifications(task_id, commit_sha);
CREATE INDEX IF NOT EXISTS check_policy_overrides_task_commit
  ON check_policy_overrides(task_id, repository_identity, candidate_commit);
`;
