export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'model')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS project_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'in_review', 'accepted', 'cancelled')),
  owner_agent_id TEXT REFERENCES agents(id),
  version INTEGER NOT NULL DEFAULT 1,
  acceptance_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_json)),
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
  commit_sha TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  runner TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL REFERENCES agents(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_actor_cursor ON events(actor, id);
CREATE INDEX IF NOT EXISTS messages_recipient_cursor ON messages(recipient, created_at);
CREATE INDEX IF NOT EXISTS proposals_task ON proposals(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_task_agent_unique ON proposals(task_id, agent_id);
CREATE INDEX IF NOT EXISTS reviews_task_commit ON reviews(task_id, commit_sha);
CREATE INDEX IF NOT EXISTS verifications_task_commit ON verifications(task_id, commit_sha);
`;
