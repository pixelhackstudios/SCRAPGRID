import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RepositoryBinding } from './git.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

const DEFAULT_AGENTS = [
  ['human', 'Project Owner', 'human'],
  ['grok', 'Grok Build', 'model'],
  ['claude', 'Claude Code', 'model'],
  ['codex', 'Codex', 'model'],
] as const;

export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export function defaultDatabasePath(repositoryRoot = process.cwd()): string {
  return resolve(process.env['COLLAB_DB'] ?? resolve(repositoryRoot, '.collab/collab.db'));
}

export function openDatabase(path = defaultDatabasePath()): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function initializeDatabase(db: DatabaseSync, repository: RepositoryBinding, baseCommit: string): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA_SQL);
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === 'repository_identity')) {
      db.exec('ALTER TABLE tasks ADD COLUMN repository_identity TEXT');
    }
    if (!taskColumns.some((column) => column.name === 'base_commit')) {
      db.exec('ALTER TABLE tasks ADD COLUMN base_commit TEXT');
    }
    if (!taskColumns.some((column) => column.name === 'check_policy_identity')) {
      db.exec('ALTER TABLE tasks ADD COLUMN check_policy_identity TEXT');
    }
    if (!taskColumns.some((column) => column.name === 'check_policy_json')) {
      db.exec('ALTER TABLE tasks ADD COLUMN check_policy_json TEXT');
    }
    const reviewColumns = db.prepare('PRAGMA table_info(reviews)').all() as Array<{ name: string }>;
    if (!reviewColumns.some((column) => column.name === 'repository_identity')) {
      db.exec('ALTER TABLE reviews ADD COLUMN repository_identity TEXT');
    }
    const verificationColumns = db.prepare('PRAGMA table_info(verifications)').all() as Array<{ name: string }>;
    if (!verificationColumns.some((column) => column.name === 'repository_identity')) {
      db.exec('ALTER TABLE verifications ADD COLUMN repository_identity TEXT');
    }
    if (!verificationColumns.some((column) => column.name === 'command_argv_json')) {
      db.exec('ALTER TABLE verifications ADD COLUMN command_argv_json TEXT');
    }
    if (!verificationColumns.some((column) => column.name === 'check_id')) {
      db.exec('ALTER TABLE verifications ADD COLUMN check_id TEXT');
    }
    if (!verificationColumns.some((column) => column.name === 'check_policy_identity')) {
      db.exec('ALTER TABLE verifications ADD COLUMN check_policy_identity TEXT');
    }
    const findingColumns = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>;
    if (!findingColumns.some((column) => column.name === 'raised_by')) {
      db.exec('ALTER TABLE review_findings ADD COLUMN raised_by TEXT REFERENCES agents(id)');
      db.exec(`UPDATE review_findings
               SET raised_by = (SELECT reviewer FROM reviews WHERE reviews.id = review_findings.review_id)
               WHERE raised_by IS NULL`);
    }
    const eventColumns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === 'operation_id')) {
      db.exec('ALTER TABLE events ADD COLUMN operation_id TEXT REFERENCES operation_attempts(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS events_operation ON events(operation_id)');
    const insertAgent = db.prepare(
      'INSERT OR IGNORE INTO agents (id, name, kind, status) VALUES (?, ?, ?, \'active\')',
    );
    for (const agent of DEFAULT_AGENTS) insertAgent.run(...agent);
    const now = new Date().toISOString();
    const existingRepository = db
      .prepare('SELECT identity, common_git_dir FROM project_repository WHERE singleton = 1')
      .get() as { identity: string; common_git_dir: string } | undefined;
    if (existingRepository && existingRepository.identity !== repository.identity) {
      throw new DatabaseError(
        `collaboration database belongs to a different repository: ${existingRepository.common_git_dir}`,
        'repository_mismatch',
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO project_repository
       (singleton, identity, root_path, common_git_dir, object_format, bound_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(repository.identity, repository.rootPath, repository.commonGitDir, repository.objectFormat, now);
    db.prepare(
      `UPDATE tasks SET repository_identity = COALESCE(repository_identity, ?),
         base_commit = COALESCE(base_commit, ?)`,
    ).run(repository.identity, baseCommit);
    db.prepare(
      'INSERT OR IGNORE INTO project_state (singleton, status, version, updated_at) VALUES (1, \'active\', 1, ?)',
    ).run(now);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
