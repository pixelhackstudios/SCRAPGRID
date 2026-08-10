import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { GitError, GitRepository } from '../collab/git.js';
import { CollaborationError, CollaborationService } from '../collab/service.js';
import { createCollaborationHttpServer } from '../collab/http.js';
import { daemonRuntimePaths, readDaemonDescriptor, type DaemonDescriptor } from '../collab/runtime.js';
import { SCHEMA_VERSION } from '../collab/schema.js';

function git(path: string, args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
}

const DIST_ROOT = resolve(import.meta.dirname, '..');
const COLLABD_ENTRY = join(DIST_ROOT, 'collab', 'collabd.js');
const CLI_ENTRY = join(DIST_ROOT, 'collab', 'cli.js');
const AGENT_TOKEN = 'test-agent-credential';
const BROWSER_TOKEN = 'test-browser-credential';

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Builds the in-process HTTP server with fixed credentials, standing in for a real daemon. */
function httpServer(service: CollaborationService, repository: GitRepository): Server {
  return createCollaborationHttpServer({
    service,
    repository,
    credentials: { agent: AGENT_TOKEN, browser: BROWSER_TOKEN },
    daemon: {
      url: 'http://127.0.0.1:0',
      pid: process.pid,
      repository_identity: repository.binding.identity,
      schema_version: SCHEMA_VERSION,
      started_at: new Date().toISOString(),
    },
  });
}

interface RunningDaemon {
  descriptor: DaemonDescriptor;
  browserToken: string;
  output: () => string;
  running: () => boolean;
  signal: (signal: NodeJS.Signals) => void;
  exited: Promise<void>;
  stop: () => Promise<void>;
}

/** Waits for a condition, failing loudly rather than hanging the suite. */
async function waitFor(description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(25);
  }
}

/** Spawns a real `collabd` on an ephemeral port and waits until it has published its descriptor. */
async function startDaemon(repositoryPath: string, env: NodeJS.ProcessEnv = {}): Promise<RunningDaemon> {
  const child = spawn(process.execPath, [COLLABD_ENTRY], {
    cwd: repositoryPath,
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((done) => child.on('exit', () => done()));

  const { descriptorPath } = daemonRuntimePaths(repositoryPath);
  const deadline = Date.now() + 20_000;
  while (!(existsSync(descriptorPath) && stdout.includes('#t='))) {
    if (child.exitCode !== null) throw new Error(`collabd exited early: ${stderr || stdout}`);
    if (Date.now() > deadline) throw new Error(`collabd did not start: ${stderr || stdout}`);
    await delay(25);
  }
  return {
    descriptor: readDaemonDescriptor(descriptorPath),
    browserToken: /#t=(\S+)/.exec(stdout)?.[1] ?? '',
    output: () => stdout,
    running: () => child.exitCode === null,
    signal: (signal) => { if (child.exitCode === null) child.kill(signal); },
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** `session` names the session descriptor this invocation authenticates with, if any. */
function cliEnvironment(session?: string): NodeJS.ProcessEnv {
  return session === undefined ? process.env : { ...process.env, COLLAB_SESSION: session };
}

function runCli(repositoryPath: string, args: string[], session?: string): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: repositoryPath,
    encoding: 'utf8',
    env: cliEnvironment(session),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runCliAsync(repositoryPath: string, args: string[], session?: string): Promise<CliResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: repositoryPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cliEnvironment(session),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => done({ status: code ?? 1, stdout, stderr }));
  });
}

/** CLI output may be preceded by streamed check output; the printed record always ends it. */
function parseCliJson(stdout: string): Record<string, unknown> {
  const start = Math.max(stdout.lastIndexOf('\n{\n'), stdout.lastIndexOf('\n[\n'));
  return JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout) as Record<string, unknown>;
}

function cliJson(repositoryPath: string, args: string[], session?: string): Record<string, unknown> {
  const result = runCli(repositoryPath, args, session);
  assert.equal(result.status, 0, `collab ${args.join(' ')} failed: ${result.stderr}`);
  return parseCliJson(result.stdout);
}

/**
 * Opens a real session per model and stores each credential where `COLLAB_SESSION` can name it.
 *
 * Tests that do not bootstrap worktrees have nowhere for the daemon to deliver a descriptor, so the
 * issued credential is written here instead. The credential itself is the daemon's.
 */
function openSessions(repositoryPath: string, agentIds: string[]): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'scrapgrid-session-test-'));
  const sessions: Record<string, string> = {};
  for (const agentId of agentIds) {
    const issued = cliJson(repositoryPath, ['session', 'open', agentId]);
    const session = issued['session'] as Record<string, unknown>;
    const path = join(directory, `${agentId}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        session_id: session['id'],
        agent_id: agentId,
        token: issued['token'],
        issued_at: session['created_at'],
      }),
    );
    sessions[agentId] = path;
  }
  return sessions;
}

function cliError(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stderr.trim()) as Record<string, unknown>;
}

const FIXTURE_CHECK_ARGV = ['node', '-e', 'process.exit(0)'];

function createRepository(checkPolicy: string | null = JSON.stringify({
  version: 1,
  checks: [{ id: 'fixture', argv: FIXTURE_CHECK_ARGV }],
})): { path: string; repository: GitRepository; close: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'scrapgrid-repository-test-'));
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.name', 'SCRAPGRID Test']);
  git(path, ['config', 'user.email', 'test@scrapgrid.invalid']);
  writeFileSync(join(path, 'artifact.txt'), 'base\n');
  if (checkPolicy !== null) {
    mkdirSync(join(path, '.scrapgrid'));
    writeFileSync(join(path, '.scrapgrid', 'checks.json'), `${checkPolicy}\n`);
  }
  git(path, ['add', '--all']);
  git(path, ['commit', '-m', 'Base artifact']);
  return { path, repository: GitRepository.discover(path), close: () => rmSync(path, { recursive: true, force: true }) };
}

function commitArtifact(path: string, content: string): string {
  writeFileSync(join(path, 'artifact.txt'), content);
  git(path, ['add', 'artifact.txt']);
  git(path, ['commit', '-m', `Artifact ${content.trim()}`]);
  return git(path, ['rev-parse', 'HEAD']);
}

function commitCheckPolicy(path: string, policy: unknown): string {
  writeFileSync(join(path, '.scrapgrid', 'checks.json'), `${JSON.stringify(policy)}\n`);
  git(path, ['add', '.scrapgrid/checks.json']);
  git(path, ['commit', '-m', 'Change required checks']);
  return git(path, ['rev-parse', 'HEAD']);
}

function harness(): {
  service: CollaborationService;
  db: DatabaseSync;
  repository: GitRepository;
  repositoryPath: string;
  close: () => void;
} {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
  return {
    service: new CollaborationService(db, fixture.repository),
    db,
    repository: fixture.repository,
    repositoryPath: fixture.path,
    close: () => {
      db.close();
      fixture.close();
    },
  };
}

function assignRoles(
  service: CollaborationService,
  taskId: string,
  roles: { implementer: string; reviewer: string; verifier: string } = {
    implementer: 'codex',
    reviewer: 'claude',
    verifier: 'grok',
  },
): void {
  service.assignTaskRoles({ taskId, actor: 'human', ...roles });
}

test('schema version 1 upgrades roles, reservations, operation linkage, findings, repository binding, and proposals', () => {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  try {
    db.exec(`
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        requester TEXT NOT NULL,
        reviewer TEXT,
        commit_sha TEXT NOT NULL,
        verdict TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        submitted_at TEXT
      );
      CREATE TABLE review_findings (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        location TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const columns = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>;
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const verificationColumns = db.prepare('PRAGMA table_info(verifications)').all() as Array<{ name: string }>;
    const eventColumns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const operationsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_attempts'")
      .get() as { name: string } | undefined;
    const reservationsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claim_reservations'")
      .get() as { name: string } | undefined;
    const overridesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'check_policy_overrides'")
      .get() as { name: string } | undefined;
    const rolesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_roles'")
      .get() as { name: string } | undefined;
    const uniqueIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'proposals_task_agent_unique'")
      .get() as { name: string } | undefined;
    const sessionsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
      .get() as { name: string } | undefined;
    const currentSessionIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_sessions_current'")
      .get() as { name: string } | undefined;
    assert.equal(version.user_version, 8);
    assert.equal(sessionsTable?.name, 'agent_sessions');
    assert.equal(currentSessionIndex?.name, 'agent_sessions_current');
    assert.ok(columns.some((column) => column.name === 'raised_by'));
    assert.ok(taskColumns.some((column) => column.name === 'check_policy_identity'));
    assert.ok(taskColumns.some((column) => column.name === 'check_policy_json'));
    assert.ok(verificationColumns.some((column) => column.name === 'command_argv_json'));
    assert.ok(verificationColumns.some((column) => column.name === 'check_id'));
    assert.ok(verificationColumns.some((column) => column.name === 'check_policy_identity'));
    assert.ok(eventColumns.some((column) => column.name === 'operation_id'));
    assert.equal(operationsTable?.name, 'operation_attempts');
    assert.equal(reservationsTable?.name, 'claim_reservations');
    assert.equal(overridesTable?.name, 'check_policy_overrides');
    assert.equal(rolesTable?.name, 'task_roles');
    assert.equal(uniqueIndex?.name, 'proposals_task_agent_unique');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    fixture.close();
  }
});

test('operation ledger preserves accepted, rejected, and failed attempts with causal event linkage', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-OPS', goal: 'Trace service operations', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-OPS');
    service.claimTask({ taskId: 'TASK-OPS', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-OPS', agent: 'claude', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'stale_version',
    );
    assert.throws(
      () => service.createTask({ id: 'TASK-UNKNOWN-ACTOR', goal: 'Reject unknown actor', acceptance: [], actor: 'nobody' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'unknown_agent',
    );
    assert.throws(() =>
      service.createTask({ id: 'TASK-OPS', goal: 'Duplicate task', acceptance: [], actor: 'human' }),
    );

    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const operations = snapshot['operations'] ?? [];
    const events = snapshot['events'] ?? [];
    const acceptedCreate = operations.find(
      (operation) => operation['operation'] === 'task.create' && operation['outcome'] === 'accepted',
    );
    const rejectedClaim = operations.find(
      (operation) => operation['operation'] === 'task.claim' && operation['outcome'] === 'rejected',
    );
    const failedCreate = operations.find(
      (operation) => operation['operation'] === 'task.create' && operation['outcome'] === 'failed',
    );
    const rejectedUnknownActor = operations.find(
      (operation) => operation['actor'] === 'nobody' && operation['outcome'] === 'rejected',
    );

    assert.ok(acceptedCreate?.['completed_at']);
    assert.equal(acceptedCreate?.['actor'], 'human');
    assert.equal(acceptedCreate?.['subject_id'], 'TASK-OPS');
    assert.ok(events.some((event) => event['operation_id'] === acceptedCreate?.['id'] && event['action'] === 'task_created'));
    assert.equal(rejectedClaim?.['reason_code'], 'stale_version');
    assert.ok(rejectedClaim?.['completed_at']);
    assert.ok(!events.some((event) => event['operation_id'] === rejectedClaim?.['id']));
    assert.equal(rejectedUnknownActor?.['reason_code'], 'unknown_agent');
    assert.ok(failedCreate?.['error_class']);
    assert.ok(failedCreate?.['completed_at']);
    assert.ok(!events.some((event) => event['operation_id'] === failedCreate?.['id']));
  } finally {
    close();
  }
});

test('accepted operation completion commits atomically with domain mutations and events', () => {
  const { service, db, close } = harness();
  try {
    db.exec(`
      CREATE TRIGGER reject_accepted_task_create
      BEFORE UPDATE OF outcome ON operation_attempts
      WHEN NEW.outcome = 'accepted' AND OLD.operation = 'task.create'
      BEGIN
        SELECT RAISE(FAIL, 'accepted outcome unavailable');
      END;
    `);

    assert.throws(
      () => service.createTask({ id: 'TASK-ATOMIC', goal: 'Commit atomically', acceptance: [], actor: 'human' }),
      /accepted outcome unavailable/,
    );

    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const operation = snapshot['operations']?.find(
      (item) => item['operation'] === 'task.create' && item['subject_id'] === 'TASK-ATOMIC',
    );

    assert.equal(operation?.['outcome'], 'failed');
    assert.ok(operation?.['completed_at']);
    assert.ok(!snapshot['tasks']?.some((task) => task['id'] === 'TASK-ATOMIC'));
    assert.ok(!snapshot['events']?.some((event) => event['operation_id'] === operation?.['id']));
  } finally {
    close();
  }
});

test('asynchronous verification events carry the operation that caused them', async () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-ASYNC-OPS', goal: 'Trace verification', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-ASYNC-OPS', { implementer: 'codex', reviewer: 'grok', verifier: 'claude' });
    const verification = await service.runVerification({
      taskId: 'TASK-ASYNC-OPS',
      agent: 'claude',
      commit: repository.headCommit(),
      command: ['node', '-e', 'process.exit(7)'],
    });
    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const operation = snapshot['operations']?.find((item) => item['operation'] === 'verification.run');
    const event = snapshot['events']?.find((item) => item['entity_id'] === verification['id']);

    assert.equal(operation?.['outcome'], 'accepted');
    assert.equal(event?.['operation_id'], operation?.['id']);
    assert.equal(event?.['action'], 'verification_failed');
    assert.equal(verification['exit_code'], 7);
  } finally {
    close();
  }
});

test('accepted verification completion commits atomically with verification evidence and its event', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-ASYNC-ATOMIC', goal: 'Commit verification atomically', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-ASYNC-ATOMIC', { implementer: 'codex', reviewer: 'grok', verifier: 'claude' });
    db.exec(`
      CREATE TRIGGER reject_accepted_verification
      BEFORE UPDATE OF outcome ON operation_attempts
      WHEN NEW.outcome = 'accepted' AND OLD.operation = 'verification.run'
      BEGIN
        SELECT RAISE(FAIL, 'accepted outcome unavailable');
      END;
    `);

    await assert.rejects(
      service.runVerification({
        taskId: 'TASK-ASYNC-ATOMIC',
        agent: 'claude',
        commit: repository.headCommit(),
        command: ['node', '-e', 'process.exit(0)'],
      }),
      /accepted outcome unavailable/,
    );

    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const operation = snapshot['operations']?.find((item) => item['operation'] === 'verification.run');

    assert.equal(operation?.['outcome'], 'failed');
    assert.ok(operation?.['completed_at']);
    assert.equal(snapshot['verifications']?.length, 0);
    assert.ok(!snapshot['events']?.some((event) => event['operation_id'] === operation?.['id']));
  } finally {
    close();
  }
});

test('initialization creates the neutral human plus three stable model identities', () => {
  const { service, close } = harness();
  try {
    assert.deepEqual(
      service.listAgents().map((agent) => agent['id']),
      ['human', 'claude', 'codex', 'grok'],
    );
  } finally {
    close();
  }
});

test('a collaboration database is bound to one Git object database', () => {
  const first = createRepository();
  const second = createRepository();
  const databasePath = join(first.path, 'bound.db');
  const firstDb = openDatabase(databasePath);
  try {
    initializeDatabase(firstDb, first.repository.binding, first.repository.headCommit());
  } finally {
    firstDb.close();
  }
  const secondDb = openDatabase(databasePath);
  try {
    assert.throws(
      () => initializeDatabase(secondDb, second.repository.binding, second.repository.headCommit()),
      /different repository/,
    );
  } finally {
    secondDb.close();
    first.close();
    second.close();
  }
});

test('review requests reject invented, missing, non-commit, unreachable, and foreign SHAs', () => {
  const { service, repository, repositoryPath, close } = harness();
  const foreign = createRepository();
  try {
    service.createTask({ id: 'TASK-GIT', goal: 'Trust Git objects', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-GIT');
    service.claimTask({ taskId: 'TASK-GIT', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: 'proof-sha' }),
      (error: unknown) => error instanceof GitError && error.code === 'invalid_commit_sha',
    );
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: 'deadbee' }),
      (error: unknown) => error instanceof GitError && error.code === 'unknown_commit',
    );
    const tree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: tree }),
      (error: unknown) => error instanceof GitError && error.code === 'unknown_commit',
    );
    const unreachable = git(repositoryPath, ['commit-tree', tree, '-m', 'Unreachable artifact']);
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: unreachable }),
      (error: unknown) => error instanceof GitError && error.code === 'foreign_commit',
    );
    const foreignCommit = commitArtifact(foreign.path, 'foreign\n');
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: foreignCommit }),
      (error: unknown) => error instanceof GitError && error.code === 'unknown_commit',
    );
    const review = service.requestReview({ taskId: 'TASK-GIT', agent: 'codex', commit: repository.headCommit().slice(0, 8) });
    assert.equal(review['commit_sha'], repository.headCommit());
    assert.equal(review['repository_identity'], repository.binding.identity);
  } finally {
    foreign.close();
    close();
  }
});

test('review candidate must descend from the immutable task base', () => {
  const { service, repositoryPath, close } = harness();
  try {
    service.createTask({ id: 'TASK-LINEAGE', goal: 'Enforce task lineage', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-LINEAGE', { implementer: 'grok', reviewer: 'codex', verifier: 'claude' });
    service.claimTask({ taskId: 'TASK-LINEAGE', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    const tree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
    const unrelatedCommit = git(repositoryPath, ['commit-tree', tree, '-m', 'Reachable unrelated root']);
    git(repositoryPath, ['update-ref', 'refs/heads/unrelated', unrelatedCommit]);
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-LINEAGE', agent: 'grok', commit: unrelatedCommit }),
      (error: unknown) => error instanceof GitError && error.code === 'candidate_not_descendant',
    );
  } finally {
    close();
  }
});

test('worktree bootstrap creates stable isolated branches and is idempotent', () => {
  const { service, repository, repositoryPath, close } = harness();
  try {
    const rootPath = join(repositoryPath, 'worktrees');
    const first = service.bootstrapWorktrees({ rootPath, baseCommit: repository.headCommit() });
    assert.deepEqual(first.map((item) => item['agent_id']), ['claude', 'codex', 'grok']);
    for (const agent of ['grok', 'claude', 'codex']) {
      const path = join(rootPath, agent);
      assert.equal(git(path, ['branch', '--show-current']), `collab/${agent}`);
      assert.equal(
        git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        repository.binding.commonGitDir,
      );
    }
    const second = service.bootstrapWorktrees({ rootPath, baseCommit: repository.headCommit() });
    assert.deepEqual(second.map((item) => item['worktree_path']), first.map((item) => item['worktree_path']));
  } finally {
    close();
  }
});

test('stale and role-forbidden claims fail closed', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-001', goal: 'Prove leasing', acceptance: ['one owner'], actor: 'human' });
    assignRoles(service, 'TASK-001', { implementer: 'grok', reviewer: 'codex', verifier: 'claude' });
    service.claimTask({ taskId: 'TASK-001', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-001', agent: 'claude', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'stale_version',
    );
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-001', agent: 'claude', expectedVersion: 2, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_forbidden',
    );
  } finally {
    close();
  }
});

test('proposal sealing allows one proposal per agent and only a human can reveal', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-PROPOSAL', goal: 'Protect independent proposals', acceptance: [], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-PROPOSAL', agent: 'grok', content: 'First independent position.' });
    assert.throws(
      () => service.submitProposal({ taskId: 'TASK-PROPOSAL', agent: 'grok', content: 'Anchored replacement.' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'duplicate_proposal',
    );
    assert.throws(
      () => service.revealProposals('TASK-PROPOSAL', 'grok'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'human_required',
    );
    const revealed = service.revealProposals('TASK-PROPOSAL', 'human');
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0]?.['visibility'], 'revealed');
  } finally {
    close();
  }
});

test('review request requires the requester to still hold an unexpired lease', () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-LEASE', goal: 'Reject expired owners', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-LEASE');
    service.claimTask({ taskId: 'TASK-LEASE', agent: 'codex', expectedVersion: 1, ttlSeconds: 0 });
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-LEASE', agent: 'codex', commit: repository.headCommit() }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'lease_required',
    );
  } finally {
    close();
  }
});

test('needs_revision reserves the next claim for the original implementer without granting a lease', () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-REVISION', goal: 'Preserve revision continuity', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-REVISION');
    service.claimTask({ taskId: 'TASK-REVISION', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const review = service.requestReview({
      taskId: 'TASK-REVISION',
      agent: 'codex',
      commit: repository.headCommit(),
    });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'needs_revision' });

    const revisionState = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const task = revisionState['tasks']?.find((item) => item['id'] === 'TASK-REVISION');
    const reservation = revisionState['claim_reservations']?.find((item) => item['task_id'] === 'TASK-REVISION');
    const revisionEvent = revisionState['events']?.find(
      (item) => item['entity_id'] === review['id'] && item['action'] === 'review_needs_revision',
    );
    const revisionPayload = revisionEvent?.['payload'] as Record<string, unknown> | undefined;

    assert.equal(task?.['status'], 'in_progress');
    assert.equal(task?.['owner_agent_id'], 'codex');
    assert.equal(task?.['candidate_commit'], null);
    assert.equal(revisionState['leases']?.length, 0);
    assert.equal(reservation?.['agent_id'], 'codex');
    assert.equal(reservation?.['reason'], 'revision');
    assert.ok(String(reservation?.['expires_at']) > String(reservation?.['created_at']));
    assert.equal(revisionPayload?.['claim_reserved_for'], 'codex');
    assert.equal(revisionPayload?.['claim_reserved_until'], reservation?.['expires_at']);

    assert.throws(
      () => service.claimTask({ taskId: 'TASK-REVISION', agent: 'grok', expectedVersion: 4, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'reservation_conflict',
    );
    const rejectedState = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.ok(
      rejectedState['operations']?.some(
        (operation) =>
          operation['operation'] === 'task.claim' &&
          operation['actor'] === 'grok' &&
          operation['reason_code'] === 'reservation_conflict',
      ),
    );

    const claimStartedAt = new Date().toISOString();
    const revised = service.claimTask({
      taskId: 'TASK-REVISION',
      agent: 'codex',
      expectedVersion: 4,
      ttlSeconds: 900,
    });
    const claimedState = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const lease = claimedState['leases']?.find((item) => item['task_id'] === 'TASK-REVISION');
    const leaseEvent = claimedState['events']
      ?.filter((item) => item['entity_id'] === 'TASK-REVISION' && item['action'] === 'lease_acquired')
      .at(-1);
    const leasePayload = leaseEvent?.['payload'] as Record<string, unknown> | undefined;

    assert.equal(revised['owner_agent_id'], 'codex');
    assert.equal(revised['version'], 5);
    assert.ok(String(lease?.['acquired_at']) >= claimStartedAt);
    assert.equal(lease?.['agent_id'], 'codex');
    assert.equal(leasePayload?.['reservation_consumed'], true);
    assert.equal(claimedState['claim_reservations']?.length, 0);
  } finally {
    close();
  }
});

test('expired revision reservations restore ordinary role-governed claim rules', () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-EXPIRED-REVISION', goal: 'Release expired priority', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-EXPIRED-REVISION');
    service.claimTask({ taskId: 'TASK-EXPIRED-REVISION', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const review = service.requestReview({
      taskId: 'TASK-EXPIRED-REVISION',
      agent: 'codex',
      commit: repository.headCommit(),
    });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'needs_revision' });
    db.prepare("UPDATE claim_reservations SET expires_at = '1970-01-01T00:00:00.000Z' WHERE task_id = ?").run(
      'TASK-EXPIRED-REVISION',
    );

    assert.throws(
      () => service.claimTask({
        taskId: 'TASK-EXPIRED-REVISION',
        agent: 'grok',
        expectedVersion: 4,
        ttlSeconds: 900,
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_forbidden',
    );
    const claimed = service.claimTask({
      taskId: 'TASK-EXPIRED-REVISION',
      agent: 'codex',
      expectedVersion: 4,
      ttlSeconds: 900,
    });
    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const lease = snapshot['leases']?.find((item) => item['task_id'] === 'TASK-EXPIRED-REVISION');

    assert.equal(claimed['owner_agent_id'], 'codex');
    assert.equal(lease?.['agent_id'], 'codex');
    assert.equal(snapshot['claim_reservations']?.length, 0);
  } finally {
    close();
  }
});

test('task creation fails closed when the base check policy is missing, malformed, or empty', () => {
  const cases: Array<{ name: string; policy: string | null; code: string }> = [
    { name: 'missing', policy: null, code: 'missing_check_policy' },
    { name: 'malformed', policy: '{', code: 'invalid_check_policy' },
    { name: 'empty', policy: JSON.stringify({ version: 1, checks: [] }), code: 'invalid_check_policy' },
  ];

  for (const item of cases) {
    const fixture = createRepository(item.policy);
    const db = openDatabase(':memory:');
    try {
      initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
      const service = new CollaborationService(db, fixture.repository);
      assert.throws(
        () => service.createTask({ id: `TASK-${item.name}`, goal: 'Fail closed', acceptance: [], actor: 'human' }),
        (error: unknown) => error instanceof CollaborationError && error.code === item.code,
      );
      const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
      assert.equal(snapshot['tasks']?.length, 0);
      assert.ok(
        snapshot['operations']?.some(
          (operation) => operation['operation'] === 'task.create' && operation['reason_code'] === item.code,
        ),
      );
    } finally {
      db.close();
      fixture.close();
    }
  }
});

test('required checks are pinned to the task base policy rather than the candidate policy', async () => {
  const { service, repository, repositoryPath, close } = harness();
  try {
    const task = service.createTask({ id: 'TASK-PINNED-POLICY', goal: 'Pin policy at base', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-PINNED-POLICY', { implementer: 'codex', reviewer: 'grok', verifier: 'claude' });
    const basePolicyIdentity = task['check_policy_identity'];
    assert.equal(
      basePolicyIdentity,
      repository.readBlobAtCommit(String(task['base_commit']), '.scrapgrid/checks.json').identity,
    );
    const candidate = commitCheckPolicy(repositoryPath, {
      version: 1,
      checks: [{ id: 'weakened', argv: ['node', '--version'] }],
    });

    await assert.rejects(
      service.runVerification({
        taskId: 'TASK-PINNED-POLICY',
        agent: 'claude',
        commit: candidate,
        checkId: 'weakened',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'unknown_required_check',
    );
    const verification = await service.runVerification({
      taskId: 'TASK-PINNED-POLICY',
      agent: 'claude',
      commit: candidate,
      checkId: 'fixture',
    });

    assert.deepEqual(JSON.parse(String(verification['command_argv_json'])), FIXTURE_CHECK_ARGV);
    assert.equal(verification['check_policy_identity'], basePolicyIdentity);
    assert.equal(verification['check_id'], 'fixture');
  } finally {
    close();
  }
});

test('arbitrary passing verification cannot replace every named check required by the base policy', async () => {
  const fixture = createRepository(
    JSON.stringify({
      version: 1,
      checks: [
        { id: 'first', argv: ['node', '-e', 'process.exit(0)'] },
        { id: 'second', argv: ['node', '-e', 'process.exit(0)'] },
      ],
    }),
  );
  const db = openDatabase(':memory:');
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository);
    service.createTask({ id: 'TASK-REQUIRED-CHECKS', goal: 'Require every named check', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-REQUIRED-CHECKS');
    service.claimTask({ taskId: 'TASK-REQUIRED-CHECKS', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = fixture.repository.headCommit();
    await service.runVerification({
      taskId: 'TASK-REQUIRED-CHECKS',
      agent: 'grok',
      commit: candidate,
      command: ['node', '--version'],
    });
    await service.runVerification({
      taskId: 'TASK-REQUIRED-CHECKS',
      agent: 'grok',
      commit: candidate,
      checkId: 'first',
    });
    const review = service.requestReview({ taskId: 'TASK-REQUIRED-CHECKS', agent: 'codex', commit: candidate });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-REQUIRED-CHECKS', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError &&
        error.code === 'acceptance_gate' &&
        error.message.includes('second'),
    );
    await service.runVerification({
      taskId: 'TASK-REQUIRED-CHECKS',
      agent: 'grok',
      commit: candidate,
      checkId: 'second',
    });
    assert.equal(
      service.acceptTask({ taskId: 'TASK-REQUIRED-CHECKS', actor: 'human', expectedVersion: 3 })['status'],
      'accepted',
    );
  } finally {
    db.close();
    fixture.close();
  }
});

test('human check-policy override is candidate-scoped, reason-bearing, and auditable', async () => {
  const fixture = createRepository(
    JSON.stringify({
      version: 1,
      checks: [{ id: 'broken', argv: ['node', '-e', 'process.exit(7)'] }],
    }),
  );
  const db = openDatabase(':memory:');
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository);
    service.createTask({ id: 'TASK-OVERRIDE', goal: 'Repair broken policy', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-OVERRIDE');
    service.claimTask({ taskId: 'TASK-OVERRIDE', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = fixture.repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-OVERRIDE', agent: 'codex', commit: candidate });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });
    const failedCheck = await service.runVerification({
      taskId: 'TASK-OVERRIDE',
      agent: 'grok',
      commit: candidate,
      checkId: 'broken',
    });
    assert.equal(failedCheck['exit_code'], 7);
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-OVERRIDE', actor: 'human', expectedVersion: 3 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'acceptance_gate',
    );
    assert.throws(
      () => service.overrideCheckPolicy({ taskId: 'TASK-OVERRIDE', actor: 'grok', reason: 'I want to bypass it' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'human_required',
    );
    assert.throws(
      () => service.overrideCheckPolicy({ taskId: 'TASK-OVERRIDE', actor: 'human', reason: '  ' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'override_reason_required',
    );

    const override = service.overrideCheckPolicy({
      taskId: 'TASK-OVERRIDE',
      actor: 'human',
      reason: 'Base policy invokes a deliberately broken check.',
    });
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-OVERRIDE', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError &&
        error.code === 'acceptance_gate' &&
        error.message.includes('designated verifier'),
    );
    const alternativeVerification = await service.runVerification({
      taskId: 'TASK-OVERRIDE',
      agent: 'grok',
      commit: candidate,
      command: ['node', '-e', 'process.exit(0)'],
    });
    assert.equal(alternativeVerification['check_id'], null);
    assert.equal(alternativeVerification['exit_code'], 0);
    assert.equal(
      service.acceptTask({ taskId: 'TASK-OVERRIDE', actor: 'human', expectedVersion: 3 })['status'],
      'accepted',
    );
    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.equal(override['candidate_commit'], candidate);
    assert.equal(override['reason'], 'Base policy invokes a deliberately broken check.');
    assert.ok(
      snapshot['events']?.some(
        (event) => event['entity_id'] === override['id'] && event['action'] === 'check_policy_overridden',
      ),
    );
  } finally {
    db.close();
    fixture.close();
  }
});

test('three agents can propose, implement, communicate, verify, review, and reach human acceptance', async () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({
      id: 'TASK-ROOM',
      goal: 'Prove the three-developer room',
      acceptance: ['independent proposals', 'immutable review', 'passing verification'],
      actor: 'human',
    });
    assignRoles(service, 'TASK-ROOM');
    service.submitProposal({ taskId: 'TASK-ROOM', agent: 'grok', content: 'Use explicit leases.' });
    service.submitProposal({ taskId: 'TASK-ROOM', agent: 'claude', content: 'Review immutable commits.' });
    service.submitProposal({ taskId: 'TASK-ROOM', agent: 'codex', content: 'Record verification by SHA.' });
    const proposals = service.revealProposals('TASK-ROOM', 'human');
    assert.equal(proposals.length, 3);
    assert.ok(proposals.every((proposal) => proposal['visibility'] === 'revealed'));

    service.claimTask({ taskId: 'TASK-ROOM', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    service.sendMessage({
      from: 'codex',
      to: 'claude',
      taskId: 'TASK-ROOM',
      body: 'Please review commit abc123.',
    });
    const candidate = repository.headCommit();
    const verification = await service.runVerification({
      taskId: 'TASK-ROOM',
      agent: 'grok',
      commit: candidate,
      checkId: 'fixture',
    });
    assert.equal(verification['commit_sha'], candidate);
    assert.equal(verification['repository_identity'], repository.binding.identity);
    assert.equal(verification['exit_code'], 0);
    assert.deepEqual(JSON.parse(String(verification['command'])), FIXTURE_CHECK_ARGV);
    assert.equal(verification['check_id'], 'fixture');
    assert.equal(verification['command_argv_json'], verification['command']);
    const review = service.requestReview({ taskId: 'TASK-ROOM', agent: 'codex', commit: candidate });

    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-ROOM', actor: 'human', expectedVersion: 3 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'acceptance_gate',
    );
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });
    const accepted = service.acceptTask({ taskId: 'TASK-ROOM', actor: 'human', expectedVersion: 3 });
    assert.equal(accepted['status'], 'accepted');

    const sync = service.sync('grok') as {
      events: Array<Record<string, unknown>>;
      verifications: Array<Record<string, unknown>>;
    };
    assert.ok(sync.events.some((event) => event['action'] === 'task_accepted'));
    assert.deepEqual(sync.verifications[0]?.['command_argv'], FIXTURE_CHECK_ARGV);
  } finally {
    close();
  }
});

test('task roles are distinct, human-assigned, task-scoped, and enforced at every authority boundary', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-INDEPENDENT', goal: 'Require explicit peer roles', acceptance: [], actor: 'human' });
    const candidate = repository.headCommit();
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-INDEPENDENT', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'roles_required',
    );
    assert.throws(
      () => service.assignTaskRoles({
        taskId: 'TASK-INDEPENDENT',
        actor: 'claude',
        implementer: 'codex',
        reviewer: 'claude',
        verifier: 'grok',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'human_required',
    );
    assert.throws(
      () => service.assignTaskRoles({
        taskId: 'TASK-INDEPENDENT',
        actor: 'human',
        implementer: 'codex',
        reviewer: 'claude',
        verifier: 'claude',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_conflict',
    );
    assignRoles(service, 'TASK-INDEPENDENT');
    assert.throws(
      () => service.assignTaskRoles({
        taskId: 'TASK-INDEPENDENT',
        actor: 'human',
        implementer: 'grok',
        reviewer: 'codex',
        verifier: 'claude',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'invalid_transition',
    );
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-INDEPENDENT', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_forbidden',
    );
    service.claimTask({ taskId: 'TASK-INDEPENDENT', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });

    await assert.rejects(
      service.runVerification({
        taskId: 'TASK-INDEPENDENT',
        agent: 'claude',
        commit: candidate,
        checkId: 'fixture',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_forbidden',
    );

    const review = service.requestReview({ taskId: 'TASK-INDEPENDENT', agent: 'codex', commit: candidate });
    assert.equal(review['reviewer'], 'claude');
    assert.throws(
      () => service.submitReview({ reviewId: String(review['id']), agent: 'grok', verdict: 'approved' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'role_forbidden',
    );
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('TASK-INDEPENDENT') as Record<string, unknown>;
    db.prepare(
      `INSERT INTO verifications
       (id, task_id, repository_identity, commit_sha, command, command_argv_json,
        check_id, check_policy_identity, exit_code, runner, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      'verify-wrong-role',
      'TASK-INDEPENDENT',
      repository.binding.identity,
      candidate,
      JSON.stringify(FIXTURE_CHECK_ARGV),
      JSON.stringify(FIXTURE_CHECK_ARGV),
      'fixture',
      String(task['check_policy_identity']),
      'claude',
      new Date().toISOString(),
    );
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-INDEPENDENT', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError &&
        error.code === 'acceptance_gate' &&
        error.message.includes('designated verifier'),
    );

    await service.runVerification({
      taskId: 'TASK-INDEPENDENT',
      agent: 'grok',
      commit: candidate,
      checkId: 'fixture',
    });
    assert.equal(
      service.acceptTask({ taskId: 'TASK-INDEPENDENT', actor: 'human', expectedVersion: 3 })['status'],
      'accepted',
    );

    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(
      snapshot['task_roles']?.filter((item) => item['task_id'] === 'TASK-INDEPENDENT').map((item) => item['agent_id']).sort(),
      ['claude', 'codex', 'grok'],
    );
    assert.ok(
      snapshot['operations']?.some(
        (operation) =>
          operation['operation'] === 'verification.run' &&
          operation['actor'] === 'claude' &&
          operation['reason_code'] === 'role_forbidden',
      ),
    );
    const roleOperation = snapshot['operations']?.find(
      (operation) => operation['operation'] === 'task.assign_roles' && operation['outcome'] === 'accepted',
    );
    assert.ok(
      snapshot['events']?.some(
        (event) => event['operation_id'] === roleOperation?.['id'] && event['action'] === 'task_roles_assigned',
      ),
    );
  } finally {
    close();
  }
});

test('implementer self-verification remains rejected as defense in depth', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-SELF-VERIFY', goal: 'Retain independent verification defense', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-SELF-VERIFY');
    service.claimTask({ taskId: 'TASK-SELF-VERIFY', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });

    db.prepare("DELETE FROM task_roles WHERE task_id = ? AND role = 'implementer'").run('TASK-SELF-VERIFY');
    db.prepare("UPDATE task_roles SET agent_id = 'codex' WHERE task_id = ? AND role = 'verifier'").run(
      'TASK-SELF-VERIFY',
    );

    await assert.rejects(
      service.runVerification({
        taskId: 'TASK-SELF-VERIFY',
        agent: 'codex',
        commit: repository.headCommit(),
        checkId: 'fixture',
      }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'self_verify',
    );
    const snapshot = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.ok(
      snapshot['operations']?.some(
        (operation) => operation['operation'] === 'verification.run' && operation['reason_code'] === 'self_verify',
      ),
    );
  } finally {
    close();
  }
});

test('verification for a different commit cannot satisfy acceptance', async () => {
  const { service, repository, repositoryPath, close } = harness();
  try {
    service.createTask({ id: 'TASK-SHA', goal: 'Bind evidence to SHA', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-SHA', { implementer: 'grok', reviewer: 'codex', verifier: 'claude' });
    service.claimTask({ taskId: 'TASK-SHA', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    const oldCommit = repository.headCommit();
    await service.runVerification({
      taskId: 'TASK-SHA',
      agent: 'claude',
      commit: oldCommit,
      checkId: 'fixture',
    });
    const newCommit = commitArtifact(repositoryPath, 'candidate\n');
    const review = service.requestReview({ taskId: 'TASK-SHA', agent: 'grok', commit: newCommit });
    service.submitReview({ reviewId: String(review['id']), agent: 'codex', verdict: 'approved' });
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-SHA', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError &&
        error.code === 'acceptance_gate' &&
        error.message.includes('designated verifier'),
    );
  } finally {
    close();
  }
});

test('finding author or human can resolve a finding, while the implementer cannot', async () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-FINDING', goal: 'Close findings', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-FINDING', { implementer: 'grok', reviewer: 'claude', verifier: 'codex' });
    const decision = service.proposeDecision({
      taskId: 'TASK-FINDING',
      actor: 'grok',
      statement: 'Use SQLite for collaboration state.',
      rationale: 'It is local and inspectable.',
    });
    assert.throws(
      () => service.acceptDecision(String(decision['id']), 'codex'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'human_required',
    );
    assert.equal(service.acceptDecision(String(decision['id']), 'human')['status'], 'accepted');

    service.claimTask({ taskId: 'TASK-FINDING', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = repository.headCommit();
    await service.runVerification({
      taskId: 'TASK-FINDING',
      agent: 'codex',
      commit: candidate,
      checkId: 'fixture',
    });
    const review = service.requestReview({ taskId: 'TASK-FINDING', agent: 'grok', commit: candidate });
    const finding = service.addReviewFinding({
      reviewId: String(review['id']),
      agent: 'claude',
      severity: 'blocking',
      description: 'The lease invariant is untested.',
    });
    assert.equal(finding['raised_by'], 'claude');
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-FINDING', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError && error.code === 'acceptance_gate' && error.message.includes('findings'),
    );
    assert.throws(
      () => service.resolveReviewFinding(String(finding['id']), 'codex'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'finding_resolution_forbidden',
    );
    service.resolveReviewFinding(String(finding['id']), 'claude');
    assert.equal(
      service.acceptTask({ taskId: 'TASK-FINDING', actor: 'human', expectedVersion: 3 })['status'],
      'accepted',
    );

    service.createTask({ id: 'TASK-HUMAN-RESOLVE', goal: 'Exercise human authority', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-HUMAN-RESOLVE', { implementer: 'grok', reviewer: 'claude', verifier: 'codex' });
    service.claimTask({ taskId: 'TASK-HUMAN-RESOLVE', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    const humanReview = service.requestReview({
      taskId: 'TASK-HUMAN-RESOLVE',
      agent: 'grok',
      commit: candidate,
    });
    const humanFinding = service.addReviewFinding({
      reviewId: String(humanReview['id']),
      agent: 'claude',
      severity: 'non_blocking',
      description: 'Human may close this explicitly.',
    });
    assert.equal(service.resolveReviewFinding(String(humanFinding['id']), 'human')['status'], 'resolved');
  } finally {
    close();
  }
});

test('sync returns actionable durable state and never leaks sealed proposals', () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-CONTEXT', goal: 'Recover context', acceptance: [], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-CONTEXT', agent: 'grok', content: 'Visible after human reveal.' });
    service.revealProposals('TASK-CONTEXT', 'human');
    const decision = service.proposeDecision({
      taskId: 'TASK-CONTEXT',
      actor: 'codex',
      statement: 'Keep collaboration state structured.',
      rationale: 'Restarted agents need bounded context.',
    });
    service.acceptDecision(String(decision['id']), 'human');

    service.createTask({ id: 'TASK-SEALED', goal: 'Remain independent', acceptance: [], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-SEALED', agent: 'claude', content: 'This must remain sealed.' });

    service.createTask({ id: 'TASK-BLOCKED', goal: 'Expose blocker details', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-BLOCKED', { implementer: 'grok', reviewer: 'codex', verifier: 'claude' });
    service.claimTask({ taskId: 'TASK-BLOCKED', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    service.addBlocker({ taskId: 'TASK-BLOCKED', agent: 'grok', description: 'A concrete dependency is missing.' });

    service.createTask({ id: 'TASK-REVIEW', goal: 'Expose pending review', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-REVIEW', { implementer: 'codex', reviewer: 'grok', verifier: 'claude' });
    service.claimTask({ taskId: 'TASK-REVIEW', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-REVIEW', agent: 'codex', commit: candidate });
    service.addReviewFinding({
      reviewId: String(review['id']),
      agent: 'grok',
      severity: 'blocking',
      description: 'Restart recovery needs a focused test.',
    });

    const synced = service.sync('claude') as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(synced['accepted_decisions']?.map((item) => item['statement']), [
      'Keep collaboration state structured.',
    ]);
    assert.deepEqual(synced['revealed_proposals']?.map((item) => item['content']), [
      'Visible after human reveal.',
    ]);
    assert.deepEqual(synced['open_blockers']?.map((item) => item['description']), [
      'A concrete dependency is missing.',
    ]);
    assert.deepEqual(synced['pending_reviews']?.map((item) => item['commit_sha']), [candidate]);
    assert.deepEqual(synced['open_findings']?.map((item) => item['description']), [
      'Restart recovery needs a focused test.',
    ]);
  } finally {
    close();
  }
});

test('snapshot is side-effect free, decodes JSON, and redacts sealed proposal content', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-SNAPSHOT', goal: 'Expose canonical state', acceptance: ['no side effects'], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-SNAPSHOT', agent: 'grok', content: 'Keep this sealed.' });
    const before = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    const after = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(before['tasks']?.[0]?.['acceptance'], ['no side effects']);
    assert.equal(before['tasks']?.[0]?.['acceptance_json'], undefined);
    assert.equal(before['proposals']?.[0]?.['content'], undefined);
    assert.equal(before['proposals']?.[0]?.['visibility'], 'sealed');
    assert.deepEqual(after, before);
    assert.equal(after['agents']?.find((agent) => agent['id'] === 'human')?.['last_seen_at'], null);

    service.revealProposals('TASK-SNAPSHOT', 'human');
    const revealed = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.equal(revealed['proposals']?.[0]?.['content'], 'Keep this sealed.');
  } finally {
    close();
  }
});

test('HTTP bridge exposes snapshots and delegates human mutations to the service', async () => {
  const { service, repository, close } = harness();
  const server = httpServer(service, repository);
  const credentialed = { authorization: `Bearer ${BROWSER_TOKEN}` };
  try {
    service.createTask({ id: 'TASK-HTTP', goal: 'Expose the service', acceptance: [], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-HTTP', agent: 'claude', content: 'Reveal through the service.' });
    const decision = service.proposeDecision({
      taskId: 'TASK-HTTP',
      actor: 'codex',
      statement: 'Keep HTTP thin.',
      rationale: 'The service owns authority.',
    });
    await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    const initialResponse = await fetch(`${origin}/api/snapshot`, { headers: credentialed });
    const initial = (await initialResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(initialResponse.status, 200);
    assert.equal(initial['proposals']?.[0]?.['content'], undefined);

    const rejectedOrigin = await fetch(`${origin}/api/tasks/TASK-HTTP/reveal-proposals`, {
      method: 'POST',
      headers: { ...credentialed, origin: 'https://example.invalid' },
    });
    assert.equal(rejectedOrigin.status, 403);

    const revealResponse = await fetch(`${origin}/api/tasks/TASK-HTTP/reveal-proposals`, {
      method: 'POST',
      headers: { ...credentialed, origin },
    });
    const revealed = (await revealResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(revealResponse.status, 200);
    assert.equal(revealed['proposals']?.[0]?.['content'], 'Reveal through the service.');
    assert.ok(
      revealed['operations']?.some(
        (operation) => operation['operation'] === 'proposal.reveal' && operation['outcome'] === 'accepted',
      ),
    );

    const acceptResponse = await fetch(`${origin}/api/decisions/${String(decision['id'])}/accept`, {
      method: 'POST',
      headers: { ...credentialed, origin },
    });
    const accepted = (await acceptResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(acceptResponse.status, 200);
    assert.equal(accepted['decisions']?.[0]?.['status'], 'accepted');

    const invalidAccept = await fetch(`${origin}/api/tasks/TASK-HTTP/accept`, {
      method: 'POST',
      headers: { ...credentialed, 'content-type': 'application/json', origin },
      body: JSON.stringify({}),
    });
    assert.equal(invalidAccept.status, 400);
  } finally {
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    close();
  }
});

test('collabd owns the repository as a singleton and takes over only a stale lock', async () => {
  const fixture = createRepository();
  const { lockPath, descriptorPath } = daemonRuntimePaths(fixture.path);
  const daemon = await startDaemon(fixture.path);
  try {
    const competitor = spawnSync(process.execPath, [COLLABD_ENTRY], {
      cwd: fixture.path,
      env: { ...process.env, PORT: '0' },
      encoding: 'utf8',
    });
    assert.notEqual(competitor.status, 0);
    assert.equal((JSON.parse(competitor.stderr.trim()) as Record<string, unknown>)['error'], 'daemon_already_running');
  } finally {
    await daemon.stop();
  }
  assert.ok(!existsSync(lockPath), 'a clean shutdown releases the lock');
  assert.ok(!existsSync(descriptorPath), 'a clean shutdown withdraws the descriptor');

  // A lock naming a process that no longer exists is crash residue, not a live owner.
  const departed = spawnSync(process.execPath, ['-e', '']);
  writeFileSync(lockPath, `${String(departed.pid)}\n`);
  const revived = await startDaemon(fixture.path);
  await revived.stop();
  fixture.close();
});

test('the collab CLI drives a complete task through collabd', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['codex', 'claude', 'grok']);
    cliJson(fixture.path, ['task', 'create', 'TASK-DAEMON', '--goal', 'Prove the daemon boundary', '--acceptance', 'collabd owns every mutation']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-DAEMON', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const candidate = commitArtifact(fixture.path, 'candidate\n');
    cliJson(fixture.path, ['task', 'claim', 'TASK-DAEMON', '--agent', 'codex', '--expected-version', '1'], sessions['codex']);
    const review = cliJson(fixture.path, ['review', 'request', 'TASK-DAEMON', '--agent', 'codex', '--commit', candidate], sessions['codex']);
    const verification = cliJson(fixture.path, ['verify', 'TASK-DAEMON', '--agent', 'grok', '--commit', candidate, '--check', 'fixture'], sessions['grok']);
    assert.equal(verification['exit_code'], 0);
    assert.equal(verification['runner'], 'grok');
    cliJson(fixture.path, ['review', 'submit', String(review['id']), '--agent', 'claude', '--verdict', 'approved'], sessions['claude']);

    const pending = cliJson(fixture.path, ['status'])['tasks'] as Array<Record<string, unknown>>;
    cliJson(fixture.path, ['task', 'accept', 'TASK-DAEMON', '--actor', 'human', '--expected-version', String(pending[0]?.['version'])]);
    const accepted = cliJson(fixture.path, ['status'])['tasks'] as Array<Record<string, unknown>>;
    assert.equal(accepted[0]?.['status'], 'accepted');
    assert.equal(accepted[0]?.['candidate_commit'], candidate);

    const snapshotResponse = await fetch(`${daemon.descriptor.url}/api/snapshot`, {
      headers: { authorization: `Bearer ${daemon.browserToken}` },
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    const ledger = snapshot['operations'] ?? [];
    for (const operation of ['task.create', 'task.assign_roles', 'task.claim', 'review.request', 'verification.run', 'review.submit', 'task.accept']) {
      assert.ok(
        ledger.some((entry) => entry['operation'] === operation && entry['outcome'] === 'accepted'),
        `ledger is missing an accepted ${operation}`,
      );
    }
    assert.ok(ledger.every((entry) => entry['outcome'] !== null), 'every attempt was completed by the daemon');
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

test('a client without a daemon fails closed and never creates the database', () => {
  const fixture = createRepository();
  try {
    const mutation = runCli(fixture.path, ['task', 'create', 'TASK-ORPHAN', '--goal', 'No daemon is running']);
    assert.notEqual(mutation.status, 0);
    assert.equal(cliError(mutation)['error'], 'daemon_unavailable');

    // Reads fail closed too: the CLI has no database path of its own to fall back to.
    const read = runCli(fixture.path, ['status']);
    assert.notEqual(read.status, 0);
    assert.equal(cliError(read)['error'], 'daemon_unavailable');

    assert.ok(!existsSync(join(fixture.path, '.collab', 'collab.db')), 'no client opened a collaboration database');
  } finally {
    fixture.close();
  }
});

test('a client rejects a daemon bound elsewhere and a credential that does not match', async () => {
  const home = createRepository();
  const other = createRepository();
  const daemon = await startDaemon(home.path);
  const homeDescriptor = daemonRuntimePaths(home.path).descriptorPath;
  const published = readFileSync(homeDescriptor, 'utf8');
  try {
    const foreignDescriptor = daemonRuntimePaths(other.path).descriptorPath;
    mkdirSync(dirname(foreignDescriptor), { recursive: true });
    writeFileSync(foreignDescriptor, published);
    const mismatch = runCli(other.path, ['status']);
    assert.notEqual(mismatch.status, 0);
    assert.equal(cliError(mismatch)['error'], 'daemon_repository_mismatch');

    writeFileSync(
      homeDescriptor,
      JSON.stringify({ ...(JSON.parse(published) as Record<string, unknown>), agent_token: 'not-the-published-credential' }),
    );
    const rejected = runCli(home.path, ['status']);
    assert.notEqual(rejected.status, 0);
    assert.equal(cliError(rejected)['error'], 'unauthorized');
  } finally {
    writeFileSync(homeDescriptor, published);
    await daemon.stop();
    home.close();
    other.close();
  }
});

test('verification runs inside collabd while its output streams back to the client', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['grok']);
    cliJson(fixture.path, ['task', 'create', 'TASK-STREAM', '--goal', 'Stream verification output']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-STREAM', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const head = git(fixture.path, ['rev-parse', 'HEAD']);
    const result = runCli(fixture.path, [
      'verify', 'TASK-STREAM', '--agent', 'grok', '--commit', head,
      '--', 'node', '-e', 'console.log("check speaking"); console.error("check warning"); process.exit(3)',
    ], sessions['grok']);
    assert.equal(result.status, 3, 'the client exits with the exit code the daemon observed');
    assert.match(result.stdout, /check speaking/);
    assert.match(result.stderr, /check warning/);
    assert.equal(parseCliJson(result.stdout)['exit_code'], 3);
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

test('a daemon restart preserves canonical state and resolves abandoned attempts', async () => {
  const fixture = createRepository();
  const first = await startDaemon(fixture.path);
  cliJson(fixture.path, ['task', 'create', 'TASK-RESTART', '--goal', 'Survive a restart']);
  const before = (cliJson(fixture.path, ['status'])['tasks'] as Array<Record<string, unknown>>)[0];
  await first.stop();

  // Stand in for a process that died mid-operation, leaving its attempt undecided.
  const databasePath = join(fixture.path, '.collab', 'collab.db');
  const crashed = openDatabase(databasePath);
  crashed
    .prepare('INSERT INTO operation_attempts (id, operation, actor, subject_type, subject_id, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('op-crashed', 'task.claim', 'codex', 'task', 'TASK-RESTART', new Date().toISOString());
  crashed.close();

  const second = await startDaemon(fixture.path);
  try {
    assert.notEqual(second.descriptor.agent_token, first.descriptor.agent_token, 'credentials rotate on restart');
    assert.notEqual(second.browserToken, first.browserToken);
    assert.match(second.output(), /recovered\s+1 abandoned operation attempt/);
    const after = (cliJson(fixture.path, ['status'])['tasks'] as Array<Record<string, unknown>>)[0];
    assert.deepEqual(after, before, 'canonical task state is unchanged by the restart');
  } finally {
    await second.stop();
  }

  const recovered = openDatabase(databasePath);
  const attempt = recovered.prepare('SELECT * FROM operation_attempts WHERE id = ?').get('op-crashed') as Record<string, unknown>;
  recovered.close();
  assert.equal(attempt['outcome'], 'abandoned');
  assert.equal(attempt['reason_code'], 'daemon_restart');
  assert.ok(attempt['completed_at']);
  fixture.close();
});

test('concurrent claims through the daemon produce exactly one owner', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['codex']);
    cliJson(fixture.path, ['task', 'create', 'TASK-RACE', '--goal', 'Only one owner may win']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-RACE', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const attempts = await Promise.all([
      runCliAsync(fixture.path, ['task', 'claim', 'TASK-RACE', '--agent', 'codex', '--expected-version', '1'], sessions['codex']),
      runCliAsync(fixture.path, ['task', 'claim', 'TASK-RACE', '--agent', 'codex', '--expected-version', '1'], sessions['codex']),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === 0);
    const losers = attempts.filter((attempt) => attempt.status !== 0);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    for (const loser of losers) assert.equal(cliError(loser)['error'], 'stale_version');

    const task = (cliJson(fixture.path, ['status'])['tasks'] as Array<Record<string, unknown>>)[0];
    assert.equal(task?.['owner_agent_id'], 'codex');
    assert.equal(task?.['version'], 2);
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

test('no /api route is anonymously callable, including the human-authority routes', async () => {
  const { service, repository, close } = harness();
  const server = httpServer(service, repository);
  try {
    service.createTask({ id: 'TASK-ANON', goal: 'Refuse anonymous authority', acceptance: [], actor: 'human' });
    service.submitProposal({ taskId: 'TASK-ANON', agent: 'grok', content: 'Stay sealed.' });
    const decision = service.proposeDecision({
      taskId: 'TASK-ANON',
      actor: 'codex',
      statement: 'Human authority needs a credential.',
      rationale: 'Loopback is not an authorization decision.',
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    const humanRoutes = [
      `${origin}/api/tasks/TASK-ANON/reveal-proposals`,
      `${origin}/api/decisions/${String(decision['id'])}/accept`,
      `${origin}/api/tasks/TASK-ANON/accept`,
    ];
    for (const route of humanRoutes) {
      // No Origin at all: exactly the bare shell request that used to reach `actor: human`.
      const bare = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_version: 1 }),
      });
      assert.equal(bare.status, 401, `${route} must not accept an uncredentialed request`);

      // An Origin is trivially forged, so it must not be what grants authority either.
      const forged = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ expected_version: 1 }),
      });
      assert.equal(forged.status, 401, `${route} must not accept a forged origin without a credential`);
    }

    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    assert.equal(
      (await fetch(`${origin}/api/operations`, { method: 'POST', body: JSON.stringify({ operation: 'status' }) })).status,
      401,
    );

    const untouched = service.snapshot() as Record<string, Array<Record<string, unknown>>>;
    assert.equal(untouched['tasks']?.[0]?.['status'], 'open');
    assert.equal(untouched['proposals']?.[0]?.['visibility'], 'sealed');
    assert.equal(untouched['decisions']?.[0]?.['status'], 'proposed');
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    close();
  }
});

test('the agent and field-terminal credentials are scoped to their own surfaces', async () => {
  const { service, repository, close } = harness();
  const server = httpServer(service, repository);
  try {
    service.createTask({ id: 'TASK-SCOPE', goal: 'Keep credentials scoped', acceptance: [], actor: 'human' });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    const browserOnOperations = await fetch(`${origin}/api/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BROWSER_TOKEN}` },
      body: JSON.stringify({ operation: 'status' }),
    });
    assert.equal(browserOnOperations.status, 401, 'the page credential cannot drive the operation registry');

    const agentOnHumanRoute = await fetch(`${origin}/api/tasks/TASK-SCOPE/reveal-proposals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, origin },
    });
    assert.equal(agentOnHumanRoute.status, 401, 'the agent credential is not a field-terminal credential');

    const permitted = await fetch(`${origin}/api/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ operation: 'status' }),
    });
    assert.equal(permitted.status, 200);
    assert.equal(permitted.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const frames = (await permitted.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.at(-1)?.['type'], 'result');
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    close();
  }
});

test('a replacement daemon cannot start while the outgoing one is still draining an operation', async () => {
  const fixture = createRepository();
  const sentinel = join(mkdtempSync(join(tmpdir(), 'scrapgrid-drain-')), 'verification-started');
  const { lockPath } = daemonRuntimePaths(fixture.path);
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['grok']);
    cliJson(fixture.path, ['task', 'create', 'TASK-DRAIN', '--goal', 'Hold ownership until the work is done']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-DRAIN', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const head = git(fixture.path, ['rev-parse', 'HEAD']);

    // A check that announces itself and then keeps the daemon busy long enough to overlap a restart.
    const verifying = runCliAsync(fixture.path, [
      'verify', 'TASK-DRAIN', '--agent', 'grok', '--commit', head,
      '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); setTimeout(() => process.exit(0), 5000)`,
    ], sessions['grok']);
    await waitFor('the verification to actually start', () => existsSync(sentinel));

    daemon.signal('SIGTERM');
    await waitFor('the daemon to begin draining', () => /draining 1 in-flight operation/.test(daemon.output()));

    // The dangerous window: shutting down, still holding the database, work still running.
    assert.ok(daemon.running(), 'the outgoing daemon is still alive');
    assert.ok(existsSync(lockPath), 'ownership is retained while work is in flight');
    const replacement = spawnSync(process.execPath, [COLLABD_ENTRY], {
      cwd: fixture.path,
      env: { ...process.env, PORT: '0' },
      encoding: 'utf8',
    });
    assert.notEqual(replacement.status, 0, 'a second writer must not start during the drain');
    assert.equal((JSON.parse(replacement.stderr.trim()) as Record<string, unknown>)['error'], 'daemon_already_running');

    // The outgoing daemon still finishes the work it accepted.
    const verified = await verifying;
    assert.equal(verified.status, 0);
    assert.equal(parseCliJson(verified.stdout)['exit_code'], 0);
    await daemon.exited;
    assert.ok(!existsSync(lockPath), 'ownership is surrendered only after the daemon is done');

    // Ownership is now genuinely free, and the completed evidence survived the handover.
    const successor = await startDaemon(fixture.path);
    try {
      const snapshot = (await (
        await fetch(`${successor.descriptor.url}/api/snapshot`, {
          headers: { authorization: `Bearer ${successor.browserToken}` },
        })
      ).json()) as Record<string, Array<Record<string, unknown>>>;
      const attempts = (snapshot['operations'] ?? []).filter((entry) => entry['operation'] === 'verification.run');
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.['outcome'], 'accepted', 'the drained operation was never reclassified as abandoned');
      assert.equal(snapshot['verifications']?.[0]?.['exit_code'], 0);
    } finally {
      await successor.stop();
    }
  } finally {
    await daemon.stop();
    rmSync(dirname(sentinel), { recursive: true, force: true });
    fixture.close();
  }
});

test('a startup failure after listening surrenders the server, database, and ownership', () => {
  const fixture = createRepository();
  const { lockPath, descriptorPath } = daemonRuntimePaths(fixture.path);
  try {
    // Make publishing the descriptor fail after the server is already listening.
    mkdirSync(descriptorPath, { recursive: true });
    const failed = spawnSync(process.execPath, [COLLABD_ENTRY], {
      cwd: fixture.path,
      env: { ...process.env, PORT: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(failed.status, 0, 'the daemon exits rather than lingering without a descriptor');
    assert.equal(failed.signal, null, 'it exits on its own rather than being killed on timeout');
    assert.ok(!existsSync(lockPath), 'a failed start does not strand the singleton lock');
  } finally {
    rmSync(descriptorPath, { recursive: true, force: true });
    fixture.close();
  }
});

test('a model session is bound to its own identity and the control credential is bound to the human', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['codex', 'claude']);
    cliJson(fixture.path, ['task', 'create', 'TASK-BOUND', '--goal', 'Bind every claim to a principal']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-BOUND', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);

    // Codex may act as Codex.
    cliJson(fixture.path, ['message', 'send', '--from', 'codex', '--to', 'claude', '--body', 'Session bound.'], sessions['codex']);

    // It may not act as another model, as the human, or as the control plane.
    for (const [args, code] of [
      [['task', 'claim', 'TASK-BOUND', '--agent', 'claude', '--expected-version', '1'], 'identity_mismatch'],
      [['message', 'send', '--from', 'grok', '--to', 'human', '--body', 'Not grok.'], 'identity_mismatch'],
      [['task', 'accept', 'TASK-BOUND', '--actor', 'human', '--expected-version', '1'], 'identity_mismatch'],
      [['session', 'open', 'grok'], 'control_credential_required'],
      [['worktree', 'bootstrap'], 'control_credential_required'],
    ] as Array<[string[], string]>) {
      const rejected = runCli(fixture.path, args, sessions['codex']);
      assert.notEqual(rejected.status, 0, `collab ${args.join(' ')} must be refused`);
      assert.equal(cliError(rejected)['error'], code, `collab ${args.join(' ')}`);
    }

    // The control credential carries human authority and no model identity at all, so reading the
    // daemon descriptor is not a way to mutate state as Codex.
    const borrowed = runCli(fixture.path, ['task', 'claim', 'TASK-BOUND', '--agent', 'codex', '--expected-version', '1']);
    assert.notEqual(borrowed.status, 0);
    assert.equal(cliError(borrowed)['error'], 'identity_mismatch');

    // A live session is not a recovery candidate: replacement exists for a session that is gone.
    const live = runCli(fixture.path, ['session', 'replace', 'codex', '--reason', 'no reason to']);
    assert.notEqual(live.status, 0);
    assert.equal(cliError(live)['error'], 'session_live');

    // Domain authority is unchanged by any of this: Claude still cannot claim an implementer task.
    const forbidden = runCli(
      fixture.path,
      ['task', 'claim', 'TASK-BOUND', '--agent', 'claude', '--expected-version', '1'],
      sessions['claude'],
    );
    assert.notEqual(forbidden.status, 0);
    assert.equal(cliError(forbidden)['error'], 'role_forbidden');
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

test('a model has one current session, and closing or replacing it invalidates the old credential', async () => {
  const fixture = createRepository();
  // Every session is immediately eligible for recovery, so staleness never has to be waited out.
  const daemon = await startDaemon(fixture.path, { COLLAB_SESSION_STALE_MS: '0' });
  try {
    const sessions = openSessions(fixture.path, ['codex']);

    const duplicate = runCli(fixture.path, ['session', 'open', 'codex']);
    assert.notEqual(duplicate.status, 0, 'a second current session cannot coexist with the first');
    assert.equal(cliError(duplicate)['error'], 'session_exists');

    const replacement = cliJson(fixture.path, ['session', 'replace', 'codex', '--reason', 'terminal was lost']);
    const replaced = String(replacement['replaced_session_id']);
    assert.notEqual(replacement['token'], undefined);

    // The process holding the old credential fails closed rather than reattaching.
    const stale = runCli(fixture.path, ['sync', '--agent', 'codex'], sessions['codex']);
    assert.notEqual(stale.status, 0);
    assert.equal(cliError(stale)['error'], 'unauthorized');

    const successor = join(mkdtempSync(join(tmpdir(), 'scrapgrid-session-test-')), 'codex.json');
    const issued = replacement['session'] as Record<string, unknown>;
    writeFileSync(
      successor,
      JSON.stringify({
        session_id: issued['id'],
        agent_id: 'codex',
        token: replacement['token'],
        issued_at: issued['created_at'],
      }),
    );
    assert.equal(cliJson(fixture.path, ['sync', '--agent', 'codex'], successor)['agent_id'], 'codex');

    const projected = cliJson(fixture.path, ['status'])['sessions'] as Array<Record<string, unknown>>;
    const open = projected.filter((session) => session['status'] === 'open');
    assert.equal(open.length, 1, 'exactly one session is current');
    assert.equal(open[0]?.['id'], issued['id']);
    const retired = projected.find((session) => session['id'] === replaced);
    assert.equal(retired?.['status'], 'replaced');
    assert.equal(retired?.['replaced_by_session_id'], issued['id']);
    assert.ok(projected.every((session) => !Object.hasOwn(session, 'credential_hash')));

    // A closed session is just as dead as a replaced one.
    cliJson(fixture.path, ['session', 'close', 'codex', '--reason', 'done for the day']);
    const closed = runCli(fixture.path, ['sync', '--agent', 'codex'], successor);
    assert.notEqual(closed.status, 0);
    assert.equal(cliError(closed)['error'], 'unauthorized');
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

test('a session survives a daemon restart, and neither restart nor replacement moves task authority', async () => {
  const fixture = createRepository();
  const first = await startDaemon(fixture.path, { COLLAB_SESSION_STALE_MS: '0' });
  const sessions = openSessions(fixture.path, ['codex']);
  cliJson(fixture.path, ['task', 'create', 'TASK-SESSION', '--goal', 'Keep authority across recovery']);
  cliJson(fixture.path, ['task', 'assign-roles', 'TASK-SESSION', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
  cliJson(fixture.path, ['task', 'claim', 'TASK-SESSION', '--agent', 'codex', '--expected-version', '1'], sessions['codex']);
  const authority = cliJson(fixture.path, ['status']);
  const canonical = (state: Record<string, unknown>): Record<string, unknown> => ({
    tasks: state['tasks'],
    active_leases: state['active_leases'],
    active_claim_reservations: state['active_claim_reservations'],
    task_roles: state['task_roles'],
  });
  await first.stop();

  const second = await startDaemon(fixture.path, { COLLAB_SESSION_STALE_MS: '0' });
  try {
    assert.notEqual(second.descriptor.agent_token, first.descriptor.agent_token, 'the control credential rotated');

    // The same session credential reconnects to the replacement daemon.
    const beat = cliJson(fixture.path, ['session', 'heartbeat'], sessions['codex']);
    assert.equal(beat['agent_id'], 'codex');
    assert.equal(beat['status'], 'open');
    assert.equal(cliJson(fixture.path, ['sync', '--agent', 'codex'], sessions['codex'])['agent_id'], 'codex');
    assert.deepEqual(canonical(cliJson(fixture.path, ['status'])), canonical(authority), 'restart moved no task authority');

    // Nor does deliberate recovery of the session identity.
    cliJson(fixture.path, ['session', 'replace', 'codex', '--reason', 'the terminal was closed']);
    assert.deepEqual(canonical(cliJson(fixture.path, ['status'])), canonical(authority), 'replacement moved no task authority');
  } finally {
    await second.stop();
    fixture.close();
  }
});

test('a session with accepted daemon work in flight cannot be replaced, however stale it looks', async () => {
  const fixture = createRepository();
  const sentinel = join(mkdtempSync(join(tmpdir(), 'scrapgrid-inflight-')), 'verification-started');
  const daemon = await startDaemon(fixture.path, { COLLAB_SESSION_STALE_MS: '0' });
  try {
    const sessions = openSessions(fixture.path, ['grok']);
    cliJson(fixture.path, ['task', 'create', 'TASK-INFLIGHT', '--goal', 'Never overlap two authorities']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-INFLIGHT', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const head = git(fixture.path, ['rev-parse', 'HEAD']);

    const verifying = runCliAsync(fixture.path, [
      'verify', 'TASK-INFLIGHT', '--agent', 'grok', '--commit', head,
      '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); setTimeout(() => process.exit(0), 3000)`,
    ], sessions['grok']);
    await waitFor('the verification to actually start', () => existsSync(sentinel));

    // The heartbeat timestamp already qualifies as stale, and the session is still a live writer.
    const refused = runCli(fixture.path, ['session', 'replace', 'grok', '--reason', 'looks gone']);
    assert.notEqual(refused.status, 0, 'replacement must not overlap two authorities for one model');
    assert.equal(cliError(refused)['error'], 'session_busy');

    const verified = await verifying;
    assert.equal(verified.status, 0);
    assert.equal(parseCliJson(verified.stdout)['exit_code'], 0);

    // Once the daemon is no longer writing on its behalf, the same recovery succeeds.
    const recovered = cliJson(fixture.path, ['session', 'replace', 'grok', '--reason', 'genuinely gone']);
    assert.equal((recovered['session'] as Record<string, unknown>)['agent_id'], 'grok');
  } finally {
    await daemon.stop();
    rmSync(dirname(sentinel), { recursive: true, force: true });
    fixture.close();
  }
});

test('a session credential is delivered to the model worktree at 0600 and never stored raw', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  const worktreeRoot = join(fixture.path, 'worktrees');
  let token = '';
  try {
    cliJson(fixture.path, ['worktree', 'bootstrap', '--root', worktreeRoot]);
    const issued = cliJson(fixture.path, ['session', 'open', 'codex']);
    token = String(issued['token']);
    const descriptorPath = String(issued['descriptor_path']);
    assert.equal(descriptorPath, join(worktreeRoot, 'codex', '.collab', 'session.json'));
    assert.equal(statSync(descriptorPath).mode & 0o777, 0o600);

    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>;
    assert.equal(descriptor['agent_id'], 'codex');
    assert.equal(descriptor['token'], token);
    assert.ok(!Object.hasOwn(descriptor, 'url'), 'the session file answers who am I, not where is collabd');

    // A model running in its own worktree is authenticated as itself without any extra configuration.
    assert.equal(cliJson(join(worktreeRoot, 'codex'), ['sync', '--agent', 'codex'])['agent_id'], 'codex');

    const snapshot = await (
      await fetch(`${daemon.descriptor.url}/api/snapshot`, { headers: { authorization: `Bearer ${daemon.browserToken}` } })
    ).json();
    assert.ok(!JSON.stringify(snapshot).includes(token), 'the snapshot never carries a session credential');
  } finally {
    await daemon.stop();
    fixture.close();
  }
  // Read after the daemon closed, so the write-ahead log has been checkpointed into the database.
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(fixture.path, '.collab', `collab.db${suffix}`);
    if (!existsSync(path)) continue;
    assert.ok(!readFileSync(path).includes(token), `the raw credential is absent from collab.db${suffix}`);
  }
});

test('authenticated activity refreshes liveness without spamming the ledger or the event stream', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path);
  try {
    const sessions = openSessions(fixture.path, ['codex']);
    // One beat first, so the comparison is between two timestamps rather than against never-seen.
    cliJson(fixture.path, ['session', 'heartbeat'], sessions['codex']);
    const record = async (): Promise<{ beat: string; seen: unknown; operations: number; events: number }> => {
      const status = cliJson(fixture.path, ['status']);
      const session = (status['sessions'] as Array<Record<string, unknown>>).find((row) => row['status'] === 'open');
      const agent = (status['agents'] as Array<Record<string, unknown>>).find((row) => row['id'] === 'codex');
      const snapshot = (await (
        await fetch(`${daemon.descriptor.url}/api/snapshot`, { headers: { authorization: `Bearer ${daemon.browserToken}` } })
      ).json()) as Record<string, unknown[]>;
      return {
        beat: String(session?.['last_heartbeat_at']),
        seen: agent?.['last_seen_at'],
        operations: (snapshot['operations'] ?? []).length,
        events: (snapshot['events'] ?? []).length,
      };
    };

    const opened = await record();
    assert.equal(
      (cliJson(fixture.path, ['status'])['sessions'] as Array<Record<string, unknown>>)[0]?.['liveness'],
      'live',
    );

    await delay(5);
    for (let beat = 0; beat < 3; beat += 1) cliJson(fixture.path, ['session', 'heartbeat'], sessions['codex']);
    const beaten = await record();
    assert.ok(beaten.beat > opened.beat, 'an explicit heartbeat refreshes session liveness');
    assert.ok(String(beaten.seen) > String(opened.seen), 'and the agent identity it belongs to');
    assert.equal(beaten.operations, opened.operations, 'heartbeats add no operation attempts');
    assert.equal(beaten.events, opened.events, 'heartbeats add no domain events');

    // Ordinary authenticated work is itself evidence of life; no separate heartbeat is required.
    await delay(5);
    cliJson(fixture.path, ['agent', 'list'], sessions['codex']);
    assert.ok((await record()).beat > beaten.beat, 'any authenticated session request refreshes liveness');
  } finally {
    await daemon.stop();
    fixture.close();
  }
});
