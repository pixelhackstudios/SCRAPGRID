import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

const DEFAULT_AGENTS = [
  ['human', 'Project Owner', 'human'],
  ['grok', 'Grok Build', 'model'],
  ['claude', 'Claude Code', 'model'],
  ['codex', 'Codex', 'model'],
] as const;

export function defaultDatabasePath(): string {
  return resolve(process.env['COLLAB_DB'] ?? '.collab/collab.db');
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

export function initializeDatabase(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA_SQL);
    const findingColumns = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>;
    if (!findingColumns.some((column) => column.name === 'raised_by')) {
      db.exec('ALTER TABLE review_findings ADD COLUMN raised_by TEXT REFERENCES agents(id)');
      db.exec(`UPDATE review_findings
               SET raised_by = (SELECT reviewer FROM reviews WHERE reviews.id = review_findings.review_id)
               WHERE raised_by IS NULL`);
    }
    const insertAgent = db.prepare(
      'INSERT OR IGNORE INTO agents (id, name, kind, status) VALUES (?, ?, ?, \'active\')',
    );
    for (const agent of DEFAULT_AGENTS) insertAgent.run(...agent);
    const now = new Date().toISOString();
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
