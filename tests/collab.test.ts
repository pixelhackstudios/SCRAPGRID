import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { GitError, GitRepository } from '../collab/git.js';
import { CollaborationError, CollaborationService } from '../collab/service.js';
import { createCollaborationHttpServer, createSessionActivity } from '../collab/http.js';
import { authorizeOperation, type SessionActivity } from '../collab/operations.js';
import { canonicalJson, DISPATCH_CONTRACT_VERSION, type DispatchResult } from '../collab/dispatch.js';
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
function httpServer(
  service: CollaborationService,
  repository: GitRepository,
  sessionActivity?: SessionActivity,
): Server {
  return createCollaborationHttpServer({
    service,
    repository,
    sessionActivity,
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
    const dispatchesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatches'")
      .get() as { name: string } | undefined;
    const dispatchBasisIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'dispatches_basis'")
      .get() as { name: string } | undefined;
    const bundlesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_bundles'")
      .get() as { name: string } | undefined;
    const bundleContentIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'context_bundles_content'")
      .get() as { name: string } | undefined;
    const attemptColumns = db.prepare('PRAGMA table_info(operation_attempts)').all() as Array<{ name: string }>;
    assert.equal(version.user_version, 10);
    assert.equal(dispatchesTable?.name, 'dispatches');
    assert.equal(dispatchBasisIndex?.name, 'dispatches_basis');
    assert.equal(bundlesTable?.name, 'context_bundles');
    assert.equal(bundleContentIndex?.name, 'context_bundles_content');
    assert.ok(attemptColumns.some((column) => column.name === 'dispatch_id'));
    assert.ok(attemptColumns.some((column) => column.name === 'context_bundle_id'));
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

    // The projection has to agree with that refusal. A session the daemon is still writing on
    // behalf of is the opposite of absent, however long ago it last said anything.
    const working = (cliJson(fixture.path, ['status'])['sessions'] as Array<Record<string, unknown>>)
      .find((session) => session['agent_id'] === 'grok' && session['status'] === 'open');
    assert.equal(working?.['work_in_flight'], true);
    assert.equal(working?.['liveness'], 'live', 'accepted work in flight is never projected as stale');

    const verified = await verifying;
    assert.equal(verified.status, 0);
    assert.equal(parseCliJson(verified.stdout)['exit_code'], 0);

    // With the work finished, the same session falls back to what its timestamp says.
    const quiet = (cliJson(fixture.path, ['status'])['sessions'] as Array<Record<string, unknown>>)
      .find((session) => session['agent_id'] === 'grok' && session['status'] === 'open');
    assert.equal(quiet?.['work_in_flight'], false);
    assert.equal(quiet?.['liveness'], 'stale');

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

/**
 * Sends one raw request whose body is delivered in two halves, so a test can act in the window
 * between the daemon reading the headers and the daemon reading the body.
 */
function splitBodyRequest(url: string, token: string, body: string): {
  finish: () => void;
  response: Promise<string>;
} {
  const { hostname, port } = new URL(url);
  const payload = Buffer.from(body, 'utf8');
  const socket = connect({ host: hostname, port: Number(port) });
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => { received += chunk; });
  const response = new Promise<string>((done, failed) => {
    socket.on('close', () => done(received));
    socket.on('error', failed);
  });
  socket.on('connect', () => {
    socket.write(
      [
        'POST /api/operations HTTP/1.1',
        `host: ${hostname}:${port}`,
        `authorization: Bearer ${token}`,
        'content-type: application/json',
        `content-length: ${payload.length}`,
        'connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    socket.write(payload.subarray(0, 10));
  });
  return { finish: () => socket.end(payload.subarray(10)), response };
}

test('a session replaced mid-request cannot finish the request it had already authenticated', async () => {
  const fixture = createRepository();
  const daemon = await startDaemon(fixture.path, { COLLAB_SESSION_STALE_MS: '0' });
  try {
    const issued = cliJson(fixture.path, ['session', 'open', 'codex']);
    cliJson(fixture.path, ['task', 'create', 'TASK-CROSS', '--goal', 'Refuse a crossed replacement boundary']);
    cliJson(fixture.path, ['task', 'assign-roles', 'TASK-CROSS', '--actor', 'human', '--implementer', 'codex', '--reviewer', 'claude', '--verifier', 'grok']);
    const before = cliJson(fixture.path, ['status']);

    // The old session authenticates, then stalls part-way through its body.
    const crossing = splitBodyRequest(
      daemon.descriptor.url,
      String(issued['token']),
      JSON.stringify({
        operation: 'task.claim',
        input: { taskId: 'TASK-CROSS', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 },
      }),
    );
    await delay(250);

    // Nothing is registered as in flight yet, so recovery is permitted and the credential dies.
    const replacement = cliJson(fixture.path, ['session', 'replace', 'codex', '--reason', 'terminal was lost']);
    assert.notEqual(replacement['token'], String(issued['token']));

    crossing.finish();
    const answered = await crossing.response;
    assert.match(answered, /^HTTP\/1\.1 401 /, 'the replaced session is refused at the operation boundary');
    assert.match(answered, /"code":"unauthorized"/);

    // The decisive assertion: the crossed request left no trace in canonical state.
    const after = cliJson(fixture.path, ['status']);
    assert.deepEqual(after['tasks'], before['tasks'], 'a replaced session committed no task mutation');
    assert.deepEqual(after['active_leases'], [], 'and acquired no lease');
  } finally {
    await daemon.stop();
    fixture.close();
  }
});

/** A fourth model agent, so "roles exist but this agent holds none" is reachable at all. */
function extraModelAgent(db: DatabaseSync, id: string): void {
  db.prepare("INSERT INTO agents (id, name, kind, status) VALUES (?, ?, 'model', 'active')").run(id, id);
}

function expectKind<K extends DispatchResult['kind']>(
  result: DispatchResult,
  kind: K,
): Extract<DispatchResult, { kind: K }> {
  assert.equal(result.kind, kind, `expected a ${kind} result, got ${result.kind}`);
  return result as Extract<DispatchResult, { kind: K }>;
}

function derive(service: CollaborationService, agent: string, taskId: string): DispatchResult {
  return service.deriveDispatchForTask({ agent, taskId });
}

function taskVersion(db: DatabaseSync, taskId: string): number {
  return Number((db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version);
}

async function callOperation(
  origin: string,
  token: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<{ status: number; frames: Array<Record<string, unknown>> }> {
  const response = await fetch(`${origin}/api/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, input }),
  });
  const body = (await response.text()).trim();
  const frames = body ? body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  return { status: response.status, frames };
}

test('every action row dispatches an obligation the service then permits', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-ROWS', goal: 'Walk the action rows', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-ROWS');

    // Row 2: open, three roles assigned.
    const claim = expectKind(derive(service, 'codex', 'TASK-ROWS'), 'action');
    assert.equal(claim.action.kind, 'claim');
    assert.equal(claim.action.terminal_operation, 'task.claim');
    assert.equal(claim.action.task_version, taskVersion(db, 'TASK-ROWS'));
    assert.equal(claim.action.dispatch_contract_version, DISPATCH_CONTRACT_VERSION);
    assert.equal(claim.action.repository_identity, repository.binding.identity);
    for (const agent of ['claude', 'grok']) {
      const pending = expectKind(derive(service, agent, 'TASK-ROWS'), 'waiting');
      assert.equal(pending.actor, 'codex');
      assert.equal(pending.action_kind, 'claim');
      assert.equal(pending.reason, 'awaiting_actor');
    }
    // The binding direction: a dispatched action is one the service permits right now.
    service.claimTask({
      taskId: 'TASK-ROWS',
      agent: 'codex',
      expectedVersion: claim.action.task_version,
      ttlSeconds: 900,
    });

    // Row 3: the implementer holds the live lease.
    const implement = expectKind(derive(service, 'codex', 'TASK-ROWS'), 'action');
    assert.equal(implement.action.kind, 'implement');
    assert.equal(implement.action.terminal_operation, 'review.request');
    const waitingOnImplementer = expectKind(derive(service, 'grok', 'TASK-ROWS'), 'waiting');
    assert.equal(waitingOnImplementer.action_kind, 'implement');
    assert.equal(waitingOnImplementer.actor, 'codex');
    const candidate = repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-ROWS', agent: 'codex', commit: candidate });

    // Rows 6 and 7 are concurrent and address different agents, so both are actions at once.
    const reviewAction = expectKind(derive(service, 'claude', 'TASK-ROWS'), 'action');
    assert.equal(reviewAction.action.kind, 'review');
    assert.equal(reviewAction.action.terminal_operation, 'review.submit');
    assert.equal(reviewAction.action.review_id, String(review['id']));
    assert.equal(reviewAction.action.candidate_commit, candidate);
    const verifyAction = expectKind(derive(service, 'grok', 'TASK-ROWS'), 'action');
    assert.equal(verifyAction.action.kind, 'verify');
    assert.equal(verifyAction.action.terminal_operation, 'verification.run');
    assert.deepEqual(verifyAction.action.check_ids, ['fixture']);
    const implementerWaits = expectKind(derive(service, 'codex', 'TASK-ROWS'), 'waiting');
    assert.equal(implementerWaits.actor, 'claude');
    assert.equal(implementerWaits.action_kind, 'review');

    await service.runVerification({ taskId: 'TASK-ROWS', agent: 'grok', commit: candidate, checkId: 'fixture' });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    // Row 9, and the shared-predicate obligation: gaps empty <=> row 9 <=> acceptance succeeds.
    for (const agent of ['codex', 'claude', 'grok']) {
      const awaitingHuman = expectKind(derive(service, agent, 'TASK-ROWS'), 'waiting');
      assert.equal(awaitingHuman.actor, 'human');
      assert.equal(awaitingHuman.action_kind, 'accept');
      assert.equal(awaitingHuman.reason, 'awaiting_human_acceptance');
    }
    assert.equal(
      service.acceptTask({ taskId: 'TASK-ROWS', actor: 'human', expectedVersion: taskVersion(db, 'TASK-ROWS') })['status'],
      'accepted',
    );

    // Row 10.
    for (const agent of ['codex', 'claude', 'grok']) {
      assert.equal(expectKind(derive(service, agent, 'TASK-ROWS'), 'none').reason, 'task_terminal');
    }
  } finally {
    close();
  }
});

test('an unassigned task waits on the human before role membership is consulted', () => {
  const { service, db, close } = harness();
  try {
    extraModelAgent(db, 'mistral');
    service.createTask({ id: 'TASK-UNASSIGNED', goal: 'Wait for roles', acceptance: [], actor: 'human' });

    // Row 1 precedes row 11: an agent with no role still reports the human obligation, because it
    // may yet be the one assigned.
    for (const agent of ['codex', 'claude', 'grok', 'mistral']) {
      const pending = expectKind(derive(service, agent, 'TASK-UNASSIGNED'), 'waiting');
      assert.equal(pending.actor, 'human');
      assert.equal(pending.action_kind, 'assign_roles');
      assert.equal(pending.reason, 'awaiting_roles');
    }
    assert.ok(
      service.deriveDispatch({ agent: 'mistral' }).tasks.some((result) => result.task_id === 'TASK-UNASSIGNED'),
      'an unassigned task concerns every model agent',
    );

    assignRoles(service, 'TASK-UNASSIGNED');

    // Row 11, now that roles exist and this agent holds none.
    assert.equal(expectKind(derive(service, 'mistral', 'TASK-UNASSIGNED'), 'none').reason, 'no_role');
    assert.ok(
      !service.deriveDispatch({ agent: 'mistral' }).tasks.some((result) => result.task_id === 'TASK-UNASSIGNED'),
      'the envelope does not enumerate other agents’ tasks as no_role noise',
    );
    // Explicit inspection is never filtered, even when the envelope omits it.
    assert.equal(expectKind(derive(service, 'mistral', 'TASK-UNASSIGNED'), 'none').reason, 'no_role');
  } finally {
    close();
  }
});

test('a lease crossing its expiry changes the derived action while the task version does not move', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-TTL', goal: 'Cross a TTL', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-TTL');
    service.claimTask({ taskId: 'TASK-TTL', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });

    const held = expectKind(derive(service, 'codex', 'TASK-TTL'), 'action');
    assert.equal(held.action.kind, 'implement');
    const versionWhileHeld = taskVersion(db, 'TASK-TTL');

    // The sharpest case in the contract: a dispatch-relevant change with no database mutation at
    // all. A version-derived basis could not see this, which is why the basis stores the evaluated
    // lease fact rather than a version.
    db.prepare("UPDATE leases SET expires_at = '1970-01-01T00:00:00.000Z' WHERE task_id = ?").run('TASK-TTL');

    const expired = expectKind(derive(service, 'codex', 'TASK-TTL'), 'action');
    assert.equal(expired.action.kind, 'claim', 'row 3 becomes row 4 purely because the lease lapsed');
    assert.equal(taskVersion(db, 'TASK-TTL'), versionWhileHeld, 'nothing about the task itself moved');
    assert.notEqual(held.action.basis_digest, expired.action.basis_digest, 'the basis records which side it was on');
    for (const agent of ['claude', 'grok']) {
      const pending = expectKind(derive(service, agent, 'TASK-TTL'), 'waiting');
      assert.equal(pending.action_kind, 'claim');
      assert.equal(pending.actor, 'codex');
    }
    // Row 4 is dispatchable, so the service must permit the re-claim it names.
    service.claimTask({
      taskId: 'TASK-TTL',
      agent: 'codex',
      expectedVersion: expired.action.task_version,
      ttlSeconds: 900,
    });
  } finally {
    close();
  }
});

test('a blocked task names the kind the implementer resumes with and addresses unblocking to nobody', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-BLOCKED', goal: 'Stall on a blocker', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-BLOCKED');
    service.claimTask({ taskId: 'TASK-BLOCKED', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const blocker = service.addBlocker({
      taskId: 'TASK-BLOCKED',
      agent: 'codex',
      description: 'The upstream contract is undecided.',
    });

    // Row 5: the lease survives the blocked interval, so clearing the blocker returns the
    // implementer straight to work.
    const withLease = expectKind(derive(service, 'codex', 'TASK-BLOCKED'), 'blocked');
    assert.equal(withLease.action_kind, 'implement');
    assert.equal(withLease.reason, 'task_blocked');
    assert.deepEqual(withLease.refs['blocker_ids'], [String(blocker['id'])]);
    // `resolveBlocker()` has no authority rule at all, so no actor can be named.
    for (const agent of ['claude', 'grok']) {
      const pending = expectKind(derive(service, agent, 'TASK-BLOCKED'), 'waiting');
      assert.equal(pending.actor, null);
      assert.equal(pending.action_kind, 'unblock');
      assert.equal(pending.reason, 'awaiting_actor');
    }

    // Row 5a: the same blocker, but the lease has since lapsed, so a re-claim comes first.
    db.prepare("UPDATE leases SET expires_at = '1970-01-01T00:00:00.000Z' WHERE task_id = ?").run('TASK-BLOCKED');
    const withoutLease = expectKind(derive(service, 'codex', 'TASK-BLOCKED'), 'blocked');
    assert.equal(withoutLease.action_kind, 'claim');
    assert.equal(withoutLease.reason, 'task_blocked');
  } finally {
    close();
  }
});

test('an approved review with an open blocking finding stalls with no model action to dispatch', async () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-FINDING', goal: 'Stall on a finding', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-FINDING');
    service.claimTask({ taskId: 'TASK-FINDING', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-FINDING', agent: 'codex', commit: candidate });
    await service.runVerification({ taskId: 'TASK-FINDING', agent: 'grok', commit: candidate, checkId: 'fixture' });
    service.addReviewFinding({
      reviewId: String(review['id']),
      agent: 'claude',
      severity: 'blocking',
      description: 'The lease is released before the candidate is durable.',
    });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    // Row 8. `resolveReviewFinding()` authorizes the author *or* any human, flatly, so canonical
    // state does not say who must act. The contract represents the gap instead of choosing.
    for (const agent of ['codex', 'claude', 'grok']) {
      const pending = expectKind(derive(service, agent, 'TASK-FINDING'), 'waiting');
      assert.equal(pending.actor, null);
      assert.equal(pending.action_kind, 'resolve_finding');
      assert.equal(pending.reason, 'awaiting_actor');
    }
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-FINDING', actor: 'human', expectedVersion: 3 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'acceptance_gate',
    );
  } finally {
    close();
  }
});

test('a check-policy override waives the named checks and leaves the verifier without a command', async () => {
  const fixture = createRepository(
    JSON.stringify({ version: 1, checks: [{ id: 'broken', argv: ['node', '-e', 'process.exit(7)'] }] }),
  );
  const db = openDatabase(':memory:');
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository);
    service.createTask({ id: 'TASK-7A', goal: 'Waive a broken check', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-7A');
    service.claimTask({ taskId: 'TASK-7A', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    const candidate = fixture.repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-7A', agent: 'codex', commit: candidate });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    // Row 7 first: the pinned check is still required, so it is dispatched by name.
    const beforeOverride = expectKind(derive(service, 'grok', 'TASK-7A'), 'action');
    assert.equal(beforeOverride.action.kind, 'verify');
    assert.deepEqual(beforeOverride.action.check_ids, ['broken']);

    const override = service.overrideCheckPolicy({
      taskId: 'TASK-7A',
      actor: 'human',
      reason: 'The pinned check is deliberately broken at this base.',
    });

    // Row 7a: the named check is waived, but `acceptTask()` still demands independent verification
    // and the policy no longer supplies a command for it. The kind is certain; only argv is not.
    const stalled = expectKind(derive(service, 'grok', 'TASK-7A'), 'blocked');
    assert.equal(stalled.action_kind, 'verify');
    assert.equal(stalled.reason, 'verification_spec_required');
    assert.equal(stalled.refs['override_id'], String(override['id']));
    const implementerWaits = expectKind(derive(service, 'codex', 'TASK-7A'), 'waiting');
    assert.equal(implementerWaits.action_kind, 'verify');
    assert.equal(implementerWaits.actor, 'grok');

    // Supplying the missing evidence closes the gap rather than nagging forever.
    await service.runVerification({
      taskId: 'TASK-7A',
      agent: 'grok',
      commit: candidate,
      command: ['node', '-e', 'process.exit(0)'],
    });
    const awaitingHuman = expectKind(derive(service, 'grok', 'TASK-7A'), 'waiting');
    assert.equal(awaitingHuman.action_kind, 'accept');
    assert.equal(awaitingHuman.reason, 'awaiting_human_acceptance');
    assert.equal(service.acceptTask({ taskId: 'TASK-7A', actor: 'human', expectedVersion: 3 })['status'], 'accepted');
  } finally {
    db.close();
    fixture.close();
  }
});

test('project pause reaches exactly the operations the service gates, and no further', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-PAUSE', goal: 'Mirror the pause asymmetry', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-PAUSE');
    service.claimTask({ taskId: 'TASK-PAUSE', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    service.createTask({ id: 'TASK-PAUSE-OPEN', goal: 'Stay claimable', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-PAUSE-OPEN');
    db.prepare("UPDATE project_state SET status = 'paused' WHERE singleton = 1").run();

    // `claimTask()` consults `requireProjectActive()`, so row 2 becomes blocked...
    const claimBlocked = expectKind(derive(service, 'codex', 'TASK-PAUSE-OPEN'), 'blocked');
    assert.equal(claimBlocked.action_kind, 'claim');
    assert.equal(claimBlocked.reason, 'project_paused');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-PAUSE-OPEN', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'project_paused',
    );

    // ...while `requestReview()` does not, so row 3 is unaffected and still dispatchable.
    const stillImplementing = expectKind(derive(service, 'codex', 'TASK-PAUSE'), 'action');
    assert.equal(stillImplementing.action.kind, 'implement');
    const candidate = repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-PAUSE', agent: 'codex', commit: candidate });
    const stillReviewing = expectKind(derive(service, 'claude', 'TASK-PAUSE'), 'action');
    assert.equal(stillReviewing.action.kind, 'review');
    const stillVerifying = expectKind(derive(service, 'grok', 'TASK-PAUSE'), 'action');
    assert.equal(stillVerifying.action.kind, 'verify');
    await service.runVerification({ taskId: 'TASK-PAUSE', agent: 'grok', commit: candidate, checkId: 'fixture' });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });

    // Row 9a: the gaps are empty, but acceptance is awaiting a resume rather than a decision.
    for (const agent of ['codex', 'claude', 'grok']) {
      const pending = expectKind(derive(service, agent, 'TASK-PAUSE'), 'waiting');
      assert.equal(pending.actor, 'human');
      assert.equal(pending.action_kind, 'accept');
      assert.equal(pending.reason, 'awaiting_project_resume');
    }
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-PAUSE', actor: 'human', expectedVersion: 3 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'project_paused',
    );

    // Resuming turns the same state into row 9, and acceptance then succeeds.
    db.prepare("UPDATE project_state SET status = 'active' WHERE singleton = 1").run();
    assert.equal(
      expectKind(derive(service, 'codex', 'TASK-PAUSE'), 'waiting').reason,
      'awaiting_human_acceptance',
    );
    assert.equal(service.acceptTask({ taskId: 'TASK-PAUSE', actor: 'human', expectedVersion: 3 })['status'], 'accepted');
  } finally {
    close();
  }
});

test('a paused agent is blocked on its own action without blocking anyone else', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-AGENT-PAUSE', goal: 'Pause one agent', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-AGENT-PAUSE');
    db.prepare("UPDATE agents SET status = 'paused' WHERE id = 'codex'").run();

    const blocked = expectKind(derive(service, 'codex', 'TASK-AGENT-PAUSE'), 'blocked');
    assert.equal(blocked.action_kind, 'claim');
    assert.equal(blocked.reason, 'agent_paused');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-AGENT-PAUSE', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'agent_paused',
    );
    // The other roles still report the obligation as the implementer's, not as blocked for them.
    const pending = expectKind(derive(service, 'claude', 'TASK-AGENT-PAUSE'), 'waiting');
    assert.equal(pending.action_kind, 'claim');
    assert.equal(pending.actor, 'codex');
  } finally {
    close();
  }
});

test('defensive claim guards fire in the order claimTask rejects, and only on the claim path', () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-C1', goal: 'Corrupt a reservation', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-C1');
    // Structurally unreachable through the service: reservations are only ever created for the
    // implementer. Written directly so the guard is executable rather than asserted-impossible.
    db.prepare(
      `INSERT INTO claim_reservations (task_id, agent_id, reason, created_at, expires_at)
       VALUES (?, 'claude', 'revision', ?, ?)`,
    ).run('TASK-C1', new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());

    const c1 = expectKind(derive(service, 'codex', 'TASK-C1'), 'blocked');
    assert.equal(c1.action_kind, 'claim');
    assert.equal(c1.reason, 'reservation_conflict');
    assert.equal(c1.refs['reserved_for'], 'claude');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-C1', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'reservation_conflict',
    );

    // Revision 5: pause is tested before the conflict guards, because `claimTask()` rejects in that
    // order. Deriving `reservation_conflict` here would name a barrier the service never reaches.
    db.prepare("UPDATE project_state SET status = 'paused' WHERE singleton = 1").run();
    const paused = expectKind(derive(service, 'codex', 'TASK-C1'), 'blocked');
    assert.equal(paused.reason, 'project_paused', 'the dispatch reason names the barrier the service hits first');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-C1', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'project_paused',
    );
    db.prepare("UPDATE project_state SET status = 'active' WHERE singleton = 1").run();
    db.prepare("UPDATE agents SET status = 'paused' WHERE id = 'codex'").run();
    assert.equal(expectKind(derive(service, 'codex', 'TASK-C1'), 'blocked').reason, 'agent_paused');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-C1', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'agent_paused',
    );
    db.prepare("UPDATE agents SET status = 'active' WHERE id = 'codex'").run();

    // C2: a live lease held by another agent, on a task the implementer would otherwise re-claim.
    service.createTask({ id: 'TASK-C2', goal: 'Corrupt a lease', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-C2');
    service.claimTask({ taskId: 'TASK-C2', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    db.prepare("UPDATE leases SET agent_id = 'claude' WHERE task_id = ?").run('TASK-C2');
    const c2 = expectKind(derive(service, 'codex', 'TASK-C2'), 'blocked');
    assert.equal(c2.action_kind, 'claim');
    assert.equal(c2.reason, 'lease_conflict');
    assert.equal(c2.refs['lease_holder'], 'claude');
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-C2', agent: 'codex', expectedVersion: 2, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'lease_conflict',
    );

    // Revision 5, second half: the guards belong to the claim branch. A corrupted reservation on an
    // in-review task must not surface as a claim conflict the service would never evaluate.
    service.createTask({ id: 'TASK-C3', goal: 'Corrupt a reservation in review', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-C3');
    service.claimTask({ taskId: 'TASK-C3', agent: 'codex', expectedVersion: 1, ttlSeconds: 900 });
    service.requestReview({ taskId: 'TASK-C3', agent: 'codex', commit: repository.headCommit() });
    db.prepare(
      `INSERT INTO claim_reservations (task_id, agent_id, reason, created_at, expires_at)
       VALUES (?, 'grok', 'revision', ?, ?)`,
    ).run('TASK-C3', new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());
    const reviewing = expectKind(derive(service, 'claude', 'TASK-C3'), 'action');
    assert.equal(reviewing.action.kind, 'review');
    const verifying = expectKind(derive(service, 'grok', 'TASK-C3'), 'action');
    assert.equal(verifying.action.kind, 'verify');
    const implementerWaiting = expectKind(derive(service, 'codex', 'TASK-C3'), 'waiting');
    assert.equal(implementerWaiting.action_kind, 'review');
  } finally {
    close();
  }
});

test('a dispatch record is keyed on the session while its basis covers workflow state alone', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-RECORD', goal: 'Record a delivery', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-RECORD');
    const opened = service.openSession('codex');
    const session = { sessionId: String(opened.session['id']), agentId: 'codex' };

    const issued = service.issueDispatch({ agent: 'codex', taskId: 'TASK-RECORD', session, workInFlight: false });
    assert.equal(issued.result.kind, 'action');
    assert.ok(issued.dispatch);
    assert.equal(issued.dispatch?.['action_kind'], 'claim');
    assert.equal(issued.dispatch?.['terminal_operation'], 'task.claim');
    assert.equal(issued.dispatch?.['dispatch_contract_version'], DISPATCH_CONTRACT_VERSION);
    assert.equal(issued.dispatch?.['session_id'], session.sessionId);
    assert.equal(issued.dispatch?.['agent_id'], 'codex');

    // Reading is free: derivation writes nothing, however often it is polled.
    for (let poll = 0; poll < 5; poll += 1) service.deriveDispatch({ agent: 'codex' });
    // And an equivalent poll of the issuing operation returns the delivery already recorded.
    const repeated = service.issueDispatch({ agent: 'codex', taskId: 'TASK-RECORD', session, workInFlight: false });
    assert.equal(repeated.dispatch?.['id'], issued.dispatch?.['id']);
    assert.equal(
      Number((db.prepare('SELECT count(*) AS count FROM dispatches').get() as { count: number }).count),
      1,
      'unchanged workflow state polled by the same session is one delivery, not many',
    );

    // Step 7 recovery: the durable agent owns the workflow, the session owns the delivery. The same
    // obligation reaching a replacement session is a new, separately attributable delivery.
    db.prepare("UPDATE agent_sessions SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE id = ?").run(
      session.sessionId,
    );
    const replacement = service.replaceSession({ agentId: 'codex', reason: 'the agent process was restarted' });
    const nextSession = { sessionId: String(replacement.session['id']), agentId: 'codex' };
    const afterRecovery = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-RECORD',
      session: nextSession,
      workInFlight: false,
    });
    assert.notEqual(afterRecovery.dispatch?.['id'], issued.dispatch?.['id']);
    assert.equal(
      afterRecovery.dispatch?.['basis_digest'],
      issued.dispatch?.['basis_digest'],
      'the digest is a statement about the task, so it survives the recovery unchanged',
    );
    assert.equal(afterRecovery.dispatch?.['session_id'], nextSession.sessionId);
    assert.equal(Number((db.prepare('SELECT count(*) AS count FROM dispatches').get() as { count: number }).count), 2);

    // The contract version is part of the key, so a derivation change can re-dispatch state that has
    // not otherwise moved rather than colliding with the pre-change delivery.
    db.prepare('UPDATE dispatches SET dispatch_contract_version = 0 WHERE id = ?').run(
      String(afterRecovery.dispatch?.['id']),
    );
    const afterVersionChange = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-RECORD',
      session: nextSession,
      workInFlight: false,
    });
    assert.notEqual(afterVersionChange.dispatch?.['id'], afterRecovery.dispatch?.['id']);
    assert.equal(Number((db.prepare('SELECT count(*) AS count FROM dispatches').get() as { count: number }).count), 3);

    // The record explains itself: re-running the table against the stored basis is possible because
    // the basis is stored, and the digest pins it.
    const stored = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(String(issued.dispatch?.['id'])) as Record<string, unknown>;
    const basis = JSON.parse(String(stored['basis_json'])) as Record<string, unknown>;
    assert.equal(basis['task_status'], 'open');
    assert.equal(basis['role'], 'implementer');
    assert.equal(basis['project_status'], 'active');
    assert.ok(!Object.hasOwn(basis, 'issued_at'), 'the captured instant is not part of the basis');
    assert.ok(!Object.hasOwn(basis, 'session_id'), 'the basis is workflow state alone');
    assert.ok(Object.hasOwn(stored, 'issued_at') && stored['issued_at']);
  } finally {
    close();
  }
});

test('a session busy with accepted work is live but not deliverable', () => {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  const busy = new Set<string>();
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository, {
      hasWorkInFlight: (sessionId) => busy.has(sessionId),
    });
    service.createTask({ id: 'TASK-BUSY', goal: 'Refuse a second delivery', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-BUSY');
    const opened = service.openSession('codex');
    const session = { sessionId: String(opened.session['id']), agentId: 'codex' };

    const quiet = service.deriveDispatch({ agent: 'codex' });
    assert.equal(quiet.session.liveness, 'live');
    assert.equal(quiet.session.work_in_flight, false);
    assert.equal(quiet.deliverable, true);

    busy.add(session.sessionId);
    const working = service.deriveDispatch({ agent: 'codex' });
    // Step 7 reports work in flight *as* liveness, which is exactly why liveness alone is not enough.
    assert.equal(working.session.liveness, 'live');
    assert.equal(working.session.work_in_flight, true);
    assert.equal(working.deliverable, false, 'both facts are required, which is why step 7 kept them separate');
    // Derivation itself is never gated: reading obligations is legitimate while working.
    assert.ok(working.tasks.length > 0);

    assert.throws(
      () => service.issueDispatch({ agent: 'codex', taskId: 'TASK-BUSY', session, workInFlight: true }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'session_busy',
    );
    assert.equal(Number((db.prepare('SELECT count(*) AS count FROM dispatches').get() as { count: number }).count), 0);

    busy.delete(session.sessionId);
    assert.ok(service.issueDispatch({ agent: 'codex', taskId: 'TASK-BUSY', session, workInFlight: false }).dispatch);
  } finally {
    db.close();
    fixture.close();
  }
});

test('an issuing request reads the work-in-flight flag sampled before it registered its own', async () => {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  const sessionActivity = createSessionActivity();
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository, {
      hasWorkInFlight: (sessionId) => sessionActivity.busy(sessionId),
    });
    service.createTask({ id: 'TASK-SAMPLE', goal: 'Sample before registering', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-SAMPLE');
    const opened = service.openSession('codex');
    const sessionId = String(opened.session['id']);
    const server = httpServer(service, fixture.repository, sessionActivity);
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      // `dispatch.issue` is mutating, so the transport marks this very session busy before the
      // operation body runs. Reading the live flag would make every issue refuse itself.
      const issued = await callOperation(origin, opened.token, 'dispatch.issue', {
        agent: 'codex',
        task: 'TASK-SAMPLE',
      });
      assert.equal(issued.status, 200);
      const result = issued.frames.at(-1);
      assert.equal(result?.['type'], 'result', JSON.stringify(result));
      const value = result?.['value'] as { dispatch: Record<string, unknown> | null };
      assert.ok(value.dispatch, 'a quiet session is deliverable even though the request itself is tracked');

      // A session genuinely busy with other accepted work is refused, which is the fact the
      // sampling exists to preserve rather than erase.
      sessionActivity.begin(sessionId);
      try {
        const refused = await callOperation(origin, opened.token, 'dispatch.issue', {
          agent: 'codex',
          task: 'TASK-SAMPLE',
        });
        const failure = refused.frames.at(-1);
        assert.equal(failure?.['type'], 'error');
        assert.equal(failure?.['code'], 'session_busy');
      } finally {
        sessionActivity.end(sessionId);
      }
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  } finally {
    db.close();
    fixture.close();
  }
});

test('an echoed dispatch id is attached only when it matches the agent, resolved task, and operation', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-CAUSAL', goal: 'Close the causal loop', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-CAUSAL');
    service.createTask({ id: 'TASK-OTHER', goal: 'Hold a foreign dispatch', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-OTHER');
    const codexSession = { sessionId: String(service.openSession('codex').session['id']), agentId: 'codex' };
    const claudeSession = { sessionId: String(service.openSession('claude').session['id']), agentId: 'claude' };

    const claimDispatch = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-CAUSAL',
      session: codexSession,
      workInFlight: false,
    }).dispatch;
    const foreignDispatch = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-OTHER',
      session: codexSession,
      workInFlight: false,
    }).dispatch;
    assert.ok(claimDispatch && foreignDispatch);

    const attemptFor = (operation: string, subjectId: string): Record<string, unknown> =>
      db
        .prepare(
          `SELECT * FROM operation_attempts WHERE operation = ? AND subject_id = ?
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(operation, subjectId) as Record<string, unknown>;

    // A dispatch for another task must not manufacture provenance, and must not cost the work.
    service.claimTask({
      taskId: 'TASK-CAUSAL',
      agent: 'codex',
      expectedVersion: 1,
      ttlSeconds: 900,
      dispatchId: String(foreignDispatch['id']),
    });
    assert.equal(attemptFor('task.claim', 'TASK-CAUSAL')['dispatch_id'], null);
    assert.equal(attemptFor('task.claim', 'TASK-CAUSAL')['outcome'], 'accepted');

    const candidate = repository.headCommit();
    const implementDispatch = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-CAUSAL',
      session: codexSession,
      workInFlight: false,
    }).dispatch;
    assert.equal(implementDispatch?.['action_kind'], 'implement');
    // A real id for the wrong terminal operation is refused just as firmly.
    service.requestReview({
      taskId: 'TASK-CAUSAL',
      agent: 'codex',
      commit: candidate,
      dispatchId: String(claimDispatch['id']),
    });
    assert.equal(attemptFor('review.request', 'TASK-CAUSAL')['dispatch_id'], null);

    // The matching case: agent, resolved task, and terminal operation all agree.
    const reviewDispatch = service.issueDispatch({
      agent: 'claude',
      taskId: 'TASK-CAUSAL',
      session: claudeSession,
      workInFlight: false,
    }).dispatch;
    assert.equal(reviewDispatch?.['action_kind'], 'review');
    const review = db.prepare('SELECT id FROM reviews WHERE task_id = ?').get('TASK-CAUSAL') as { id: string };
    service.submitReview({
      reviewId: review.id,
      agent: 'claude',
      verdict: 'approved',
      dispatchId: String(reviewDispatch?.['id']),
    });
    // `review.submit` records `subjectType: 'review'` and reaches the task through the review row,
    // so a blind comparison against the ledger subject would never attach this edge at all.
    const submitAttempt = attemptFor('review.submit', review.id);
    assert.equal(submitAttempt['dispatch_id'], String(reviewDispatch?.['id']));
    assert.equal(submitAttempt['subject_type'], 'review');

    // An unknown id is advisory in the same direction: no provenance, no refusal.
    await service.runVerification({
      taskId: 'TASK-CAUSAL',
      agent: 'grok',
      commit: candidate,
      checkId: 'fixture',
      dispatchId: 'dispatch-does-not-exist',
    });
    assert.equal(attemptFor('verification.run', 'TASK-CAUSAL')['dispatch_id'], null);
    assert.equal(attemptFor('verification.run', 'TASK-CAUSAL')['outcome'], 'accepted');
  } finally {
    close();
  }
});

test('a derivation that fails to reduce is returned intact and recorded as a rejected attempt', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-PARTIAL', goal: 'Break the role invariant', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-PARTIAL');
    const session = { sessionId: String(service.openSession('codex').session['id']), agentId: 'codex' };
    // Roles are inserted as one atomic set, so a partial set is a harness defect rather than a state
    // the workflow can reach. The contract says so out loud instead of guessing an action.
    db.prepare("DELETE FROM task_roles WHERE task_id = ? AND role = 'verifier'").run('TASK-PARTIAL');

    const derived = expectKind(derive(service, 'codex', 'TASK-PARTIAL'), 'indeterminate');
    assert.deepEqual(derived.candidates, []);
    assert.equal(derived.basis['role_count'], 2);

    const issued = service.issueDispatch({ agent: 'codex', taskId: 'TASK-PARTIAL', session, workInFlight: false });
    assert.equal(issued.result.kind, 'indeterminate', 'the result is returned unchanged');
    assert.equal(issued.dispatch, null, 'and nothing is recorded as delivered');
    const attempt = db
      .prepare("SELECT * FROM operation_attempts WHERE operation = 'dispatch.issue' ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown>;
    assert.equal(attempt['outcome'], 'rejected');
    assert.equal(attempt['reason_code'], 'dispatch_indeterminate');
  } finally {
    close();
  }
});

test('derivation may be inspected by control for any agent, but by a session only for itself', () => {
  const definition = { mutating: false, identityOrControl: 'agent', invoke: () => null };
  const control = { kind: 'control', agentId: 'human' } as const;
  const claude = { kind: 'session', agentId: 'claude', sessionId: 'session-1' } as const;

  // `control: true` would reject sessions outright, and `identity` would compare against the literal
  // 'human' a control principal carries — so neither existing rule can express this on its own.
  assert.doesNotThrow(() => authorizeOperation(definition, control, { agent: 'codex' }));
  assert.doesNotThrow(() => authorizeOperation(definition, claude, { agent: 'claude' }));
  assert.throws(
    () => authorizeOperation(definition, claude, { agent: 'codex' }),
    (error: unknown) => error instanceof CollaborationError && error.code === 'identity_mismatch',
    'a session deriving for another agent would silently weaken the identity binding step 7 established',
  );
});

test('a dispatch from an earlier cycle cannot claim credit for a later operation', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-STALE', goal: 'Round-trip a revision cycle', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-STALE');
    const codexSession = { sessionId: String(service.openSession('codex').session['id']), agentId: 'codex' };

    const first = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-STALE',
      session: codexSession,
      workInFlight: false,
    }).dispatch;
    assert.equal(first?.['action_kind'], 'claim');
    const staleId = String(first?.['id']);

    service.claimTask({ taskId: 'TASK-STALE', agent: 'codex', expectedVersion: 1, ttlSeconds: 900, dispatchId: staleId });
    const candidate = repository.headCommit();
    const review = service.requestReview({ taskId: 'TASK-STALE', agent: 'codex', commit: candidate });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'needs_revision' });

    // The review-to-revision-to-re-review cycle is a Pilot 002 hard path, and it returns the task to
    // a claimable state at a later version under a fresh reservation for the same implementer.
    assert.equal(taskVersion(db, 'TASK-STALE'), 4);
    const reclaim = expectKind(derive(service, 'codex', 'TASK-STALE'), 'action');
    assert.equal(reclaim.action.kind, 'claim');
    assert.equal(reclaim.action.task_version, 4);

    // Agent, task, and terminal operation are all identical across the two cycles, so those three
    // alone would let the first cycle's dispatch attach here.
    service.claimTask({ taskId: 'TASK-STALE', agent: 'codex', expectedVersion: 4, ttlSeconds: 900, dispatchId: staleId });
    const claims = db
      .prepare("SELECT * FROM operation_attempts WHERE operation = 'task.claim' AND subject_id = ? ORDER BY started_at, id")
      .all('TASK-STALE') as Array<Record<string, unknown>>;
    assert.equal(claims.length, 2);
    assert.equal(claims[0]?.['dispatch_id'], staleId, 'the first claim was genuinely caused by this dispatch');
    assert.equal(
      claims[1]?.['dispatch_id'],
      null,
      'a dispatch whose basis describes version 1 must not be recorded as the cause of a version 4 claim',
    );
    // Advisory in both directions: the stale echo cost provenance, never the work.
    assert.equal(claims[1]?.['outcome'], 'accepted');
    assert.equal(taskVersion(db, 'TASK-STALE'), 5);

    // The dispatch actually issued for this generation attaches, so the check discriminates rather
    // than simply refusing every second echo.
    const current = service.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-STALE',
      session: codexSession,
      workInFlight: false,
    }).dispatch;
    assert.equal(current?.['action_kind'], 'implement');
    service.requestReview({
      taskId: 'TASK-STALE',
      agent: 'codex',
      commit: candidate,
      dispatchId: String(current?.['id']),
    });
    const requested = db
      .prepare("SELECT * FROM operation_attempts WHERE operation = 'review.request' AND subject_id = ? ORDER BY started_at DESC LIMIT 1")
      .get('TASK-STALE') as Record<string, unknown>;
    assert.equal(requested['dispatch_id'], String(current?.['id']));
  } finally {
    close();
  }
});

// --- Step 9: deterministic context bundles ---------------------------------

test('a schema 9 database upgrades in place, index and column in the order SQLite requires', () => {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    // Wind the real schema back to 9 rather than hand-copying it, so this regression cannot drift
    // away from the shape it claims to be testing.
    db.exec(`
      INSERT INTO operation_attempts (id, operation, actor, outcome, started_at)
        VALUES ('op-legacy', 'task.create', 'human', 'accepted', '2026-01-01T00:00:00.000Z');
      DROP INDEX operation_attempts_bundle;
      ALTER TABLE operation_attempts DROP COLUMN context_bundle_id;
      DROP TABLE context_bundles;
      PRAGMA user_version = 9;
    `);
    assert.ok(
      !(db.prepare('PRAGMA table_info(operation_attempts)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'context_bundle_id',
      ),
      'the fixture must actually be a schema 9 database',
    );

    // The upgrade a real deployment performs: schema 10 code opening the database step 8 left behind.
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const attemptColumns = db.prepare('PRAGMA table_info(operation_attempts)').all() as Array<{ name: string }>;
    const bundleIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'operation_attempts_bundle'")
      .get() as { name: string } | undefined;
    const bundlesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_bundles'")
      .get() as { name: string } | undefined;
    assert.equal(version.user_version, 10);
    assert.ok(attemptColumns.some((column) => column.name === 'dispatch_id'));
    assert.ok(attemptColumns.some((column) => column.name === 'context_bundle_id'));
    assert.equal(bundleIndex?.name, 'operation_attempts_bundle');
    assert.equal(bundlesTable?.name, 'context_bundles');

    const preserved = db
      .prepare('SELECT operation, outcome, context_bundle_id FROM operation_attempts WHERE id = ?')
      .get('op-legacy') as Record<string, unknown>;
    assert.equal(preserved['operation'], 'task.create');
    assert.equal(preserved['outcome'], 'accepted');
    assert.equal(preserved['context_bundle_id'], null, 'attempts recorded before step 9 carry no bundle');
  } finally {
    db.close();
    fixture.close();
  }
});

interface TestSession {
  sessionId: string;
  agentId: string;
}

function sessionFor(service: CollaborationService, agentId: string): TestSession {
  const opened = service.openSession(agentId);
  return { sessionId: String(opened.session['id']), agentId };
}

function issue(
  service: CollaborationService,
  agent: string,
  taskId: string,
  session: TestSession,
): { result: DispatchResult; dispatch: Record<string, unknown> | null; context_bundle: Record<string, unknown> | null } {
  return service.issueDispatch({ agent, taskId, session, workInFlight: false });
}

/** The recorded delivery, as a reader of the ledger would reconstruct it. */
function delivered(
  service: CollaborationService,
  agent: string,
  taskId: string,
  session: TestSession,
): { dispatchId: string; bundleId: string; digest: string; bundle: Record<string, unknown> } {
  const issued = issue(service, agent, taskId, session);
  assert.equal(issued.result.kind, 'action', `expected an action for ${agent} on ${taskId}`);
  assert.ok(issued.dispatch && issued.context_bundle);
  return {
    dispatchId: String(issued.dispatch?.['id']),
    bundleId: String(issued.context_bundle?.['id']),
    digest: String(issued.context_bundle?.['bundle_digest']),
    bundle: JSON.parse(String(issued.context_bundle?.['bundle_json'])) as Record<string, unknown>,
  };
}

function bundleCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS count FROM context_bundles').get() as { count: number }).count);
}

function latestAttempt(db: DatabaseSync, operation: string, subjectId: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT * FROM operation_attempts WHERE operation = ? AND subject_id = ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(operation, subjectId) as Record<string, unknown>;
}

function canonicalBundle(bundle: Record<string, unknown>): string {
  return canonicalJson(bundle);
}

function dispatchCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS count FROM dispatches').get() as { count: number }).count);
}

/** Derivation as a comparable value: the captured instant is the one field allowed to move. */
function derivedShape(service: CollaborationService, agent: string): string {
  const { derived_at: _instant, ...rest } = service.deriveDispatch({ agent });
  return JSON.stringify(rest);
}

test('context that moves while the obligation stands still is a new bundle, not a new dispatch', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-CONTEXT', goal: 'Carry context', acceptance: ['ships'], actor: 'human' });
    assignRoles(service, 'TASK-CONTEXT');
    const codex = sessionFor(service, 'codex');

    const first = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    const beforeDerivation = derivedShape(service, 'codex');

    // Class C, row one: a task message this agent is party to. The obligation is untouched — same
    // action, same basis — so step 8 must return the record it already wrote.
    service.sendMessage({ from: 'claude', to: 'codex', taskId: 'TASK-CONTEXT', body: 'Base moved to abc123' });
    const afterMessage = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.equal(afterMessage.dispatchId, first.dispatchId, 'a message is not an obligation');
    assert.notEqual(afterMessage.digest, first.digest);
    assert.notEqual(afterMessage.bundleId, first.bundleId);
    assert.equal(
      derivedShape(service, 'codex'),
      beforeDerivation,
      'derivation cannot see the message at all: the bundle is never an input to it',
    );
    const conversation = afterMessage.bundle['conversation'] as Record<string, unknown>;
    assert.equal((conversation['messages'] as unknown[]).length, 1);
    assert.equal(conversation['total'], 1);
    assert.equal(conversation['truncated'], false);

    // Class C, row two: a revealed proposal. Submitting one is invisible; revealing it is not.
    service.submitProposal({ taskId: 'TASK-CONTEXT', agent: 'codex', content: 'Try the smaller migration' });
    const afterSeal = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.equal(afterSeal.digest, afterMessage.digest, 'a sealed proposal is absent, not redacted');
    assert.equal(afterSeal.bundleId, afterMessage.bundleId);
    service.revealProposals('TASK-CONTEXT', 'human');
    const afterReveal = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.equal(afterReveal.dispatchId, first.dispatchId);
    assert.notEqual(afterReveal.digest, afterSeal.digest);
    assert.equal((afterReveal.bundle['proposals'] as unknown[]).length, 1);

    // Class C, row three: an accepted decision, scoped to this task or to the project.
    const proposed = service.proposeDecision({
      taskId: 'TASK-CONTEXT',
      actor: 'claude',
      statement: 'Migrate in two commits',
      rationale: 'Reviewability',
    });
    const afterProposal = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.equal(afterProposal.digest, afterReveal.digest, 'only accepted decisions are selected');
    service.acceptDecision(String(proposed['id']), 'human');
    const afterDecision = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.equal(afterDecision.dispatchId, first.dispatchId);
    assert.notEqual(afterDecision.digest, afterProposal.digest);
    const global = service.proposeDecision({
      actor: 'claude',
      statement: 'Every task pins its checks at base',
      rationale: 'Reproducibility',
    });
    service.acceptDecision(String(global['id']), 'human');
    const afterGlobal = delivered(service, 'codex', 'TASK-CONTEXT', codex);
    assert.notEqual(afterGlobal.digest, afterDecision.digest, 'project-wide truth reaches every bundle');
    assert.equal((afterGlobal.bundle['decisions'] as unknown[]).length, 2);

    // Four distinct things were said, and exactly one obligation was ever issued.
    assert.equal(dispatchCount(db), 1, 'one obligation, however much was said about it');
    assert.equal(bundleCount(db), 5, 'and five distinct things said');
  } finally {
    close();
  }
});

test('a change invisible or irrelevant to an agent leaves its bundle byte-identical', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-QUIET', goal: 'Stay quiet', acceptance: [], actor: 'human' });
    service.createTask({ id: 'TASK-OTHER', goal: 'Somewhere else', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-QUIET');
    assignRoles(service, 'TASK-OTHER', { implementer: 'claude', reviewer: 'grok', verifier: 'codex' });
    const codex = sessionFor(service, 'codex');
    const baseline = delivered(service, 'codex', 'TASK-QUIET', codex);

    // Repeated issuance is the fixpoint case: what issuing writes must never feed the next bundle,
    // or no two consecutive deliveries could ever agree.
    for (let poll = 0; poll < 3; poll += 1) {
      const repeated = delivered(service, 'codex', 'TASK-QUIET', codex);
      assert.equal(repeated.bundleId, baseline.bundleId);
      assert.equal(repeated.digest, baseline.digest);
    }
    const serialized = JSON.stringify(baseline.bundle);
    assert.ok(!serialized.includes(baseline.dispatchId), 'a bundle never names the dispatch row it rides');
    assert.ok(!serialized.includes(baseline.bundleId), 'nor itself');
    for (const key of ['dispatches', 'operations', 'events', 'context_bundles', 'sessions']) {
      assert.ok(!Object.hasOwn(baseline.bundle, key), `${key} is excluded by the fixpoint requirement`);
    }

    // sync mutates on every call, and must still be inert: presence is not task truth.
    service.sync('codex');
    service.sync('claude');
    // Messages this agent is not party to, and messages scoped to no task at all.
    service.sendMessage({ from: 'claude', to: 'grok', taskId: 'TASK-QUIET', body: 'Between the two of us' });
    service.sendMessage({ from: 'claude', to: 'codex', body: 'Unscoped remark' });
    // Another task entirely, including its accepted decisions.
    const elsewhere = service.proposeDecision({
      taskId: 'TASK-OTHER',
      actor: 'claude',
      statement: 'Not this task',
      rationale: 'Scope',
    });
    service.acceptDecision(String(elsewhere['id']), 'human');
    service.sendMessage({ from: 'claude', to: 'codex', taskId: 'TASK-OTHER', body: 'About the other task' });
    // A proposal nobody has revealed, and a decision nobody has accepted.
    service.submitProposal({ taskId: 'TASK-QUIET', agent: 'claude', content: 'Sealed' });
    service.proposeDecision({ taskId: 'TASK-QUIET', actor: 'grok', statement: 'Merely proposed', rationale: 'Not yet' });
    // Presence, and a read that writes nothing.
    service.heartbeat(codex);
    service.deriveDispatch({ agent: 'codex' });

    const quiet = delivered(service, 'codex', 'TASK-QUIET', codex);
    assert.equal(quiet.digest, baseline.digest, 'none of that is addressed to codex on this task');
    assert.equal(quiet.bundleId, baseline.bundleId, 'and so it is the same recorded content');
    assert.equal(
      String(
        (
          db.prepare('SELECT bundle_json FROM context_bundles WHERE id = ?').get(baseline.bundleId) as {
            bundle_json: string;
          }
        ).bundle_json,
      ),
      canonicalBundle(baseline.bundle),
      'the stored serialization is canonical and stable',
    );
    assert.equal(bundleCount(db), 1);
  } finally {
    close();
  }
});

test('a workflow change may move the dispatch, and the bundle follows the state it moved to', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-FLOW', goal: 'Walk the workflow', acceptance: ['green'], actor: 'human' });
    assignRoles(service, 'TASK-FLOW');
    const codex = sessionFor(service, 'codex');
    const claude = sessionFor(service, 'claude');
    const grok = sessionFor(service, 'grok');

    const claim = delivered(service, 'codex', 'TASK-FLOW', codex);
    assert.equal((claim.bundle['action'] as Record<string, unknown>)['kind'], 'claim');
    assert.equal(claim.bundle['lease'], null, 'nothing is leased yet');
    assert.equal((claim.bundle['task'] as Record<string, unknown>)['status'], 'open');
    assert.deepEqual((claim.bundle['task'] as Record<string, unknown>)['acceptance'], ['green']);
    assert.deepEqual((claim.bundle['check_policy'] as Record<string, unknown>)['checks'], [
      { id: 'fixture', argv: FIXTURE_CHECK_ARGV },
    ]);

    // Class W: the obligation itself moves, so a new dispatch is correct rather than a defect.
    service.claimTask({
      taskId: 'TASK-FLOW',
      agent: 'codex',
      expectedVersion: taskVersion(db, 'TASK-FLOW'),
      ttlSeconds: 900,
      dispatchId: claim.dispatchId,
      contextBundleId: claim.bundleId,
    });
    const implement = delivered(service, 'codex', 'TASK-FLOW', codex);
    assert.notEqual(implement.dispatchId, claim.dispatchId, 'the workflow moved, so the delivery did too');
    assert.equal((implement.bundle['action'] as Record<string, unknown>)['kind'], 'implement');
    assert.equal((implement.bundle['task'] as Record<string, unknown>)['status'], 'in_progress');
    const lease = implement.bundle['lease'] as Record<string, unknown>;
    assert.equal(lease['agent_id'], 'codex');
    assert.ok(String(lease['expires_at']).length > 0, 'requestReview refuses without a live lease, so the deadline rides along');

    const first = commitArtifact(repository.binding.rootPath, 'candidate one\n');
    const reviewOne = service.requestReview({ taskId: 'TASK-FLOW', agent: 'codex', commit: first });
    service.addReviewFinding({
      reviewId: String(reviewOne['id']),
      agent: 'claude',
      severity: 'blocking',
      description: 'Missing migration guard',
      location: 'src/migrate.ts',
    });
    service.submitReview({ reviewId: String(reviewOne['id']), agent: 'claude', verdict: 'needs_revision' });

    // The re-claiming implementer has no candidate any more, and the evidence it needs is the
    // history of the commit it is about to revise.
    const reclaim = delivered(service, 'codex', 'TASK-FLOW', codex);
    assert.equal((reclaim.bundle['action'] as Record<string, unknown>)['kind'], 'claim');
    assert.equal((reclaim.bundle['task'] as Record<string, unknown>)['candidate_commit'], null);
    const carriedReviews = reclaim.bundle['reviews'] as Array<Record<string, unknown>>;
    assert.equal(carriedReviews.length, 1);
    assert.equal(carriedReviews[0]?.['verdict'], 'needs_revision');
    assert.equal(carriedReviews[0]?.['commit_sha'], first);
    const carriedFindings = carriedReviews[0]?.['findings'] as Array<Record<string, unknown>>;
    assert.equal(carriedFindings.length, 1);
    assert.equal(carriedFindings[0]?.['description'], 'Missing migration guard');
    assert.equal(carriedFindings[0]?.['severity'], 'blocking');

    service.claimTask({
      taskId: 'TASK-FLOW',
      agent: 'codex',
      expectedVersion: taskVersion(db, 'TASK-FLOW'),
      ttlSeconds: 900,
    });
    service.resolveReviewFinding(String(carriedFindings[0]?.['id']), 'claude');
    const second = commitArtifact(repository.binding.rootPath, 'candidate two\n');
    const reviewTwo = service.requestReview({ taskId: 'TASK-FLOW', agent: 'codex', commit: second });

    // Both cycles are carried, so the reviewer sees what it already said.
    const reviewing = delivered(service, 'claude', 'TASK-FLOW', claude);
    assert.equal((reviewing.bundle['action'] as Record<string, unknown>)['kind'], 'review');
    assert.equal((reviewing.bundle['reviews'] as unknown[]).length, 2);
    assert.equal(reviewing.bundle['role'], 'reviewer');
    assert.equal(reviewing.bundle['lease'], null, 'the lease belongs to the implementer, not the reviewer');

    // Conditional row, C branch: a failing check at the candidate changes the evidence and no fact.
    const verifying = delivered(service, 'grok', 'TASK-FLOW', grok);
    await service.runVerification({
      taskId: 'TASK-FLOW',
      agent: 'grok',
      commit: second,
      command: ['node', '-e', 'process.exit(3)'],
    });
    const afterFailure = delivered(service, 'grok', 'TASK-FLOW', grok);
    assert.equal(afterFailure.dispatchId, verifying.dispatchId, 'a failing run closes no gap');
    assert.notEqual(afterFailure.digest, verifying.digest, 'but the agent should still know it failed');
    const failures = afterFailure.bundle['verifications'] as Array<Record<string, unknown>>;
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.['exit_code'], 3);
    assert.deepEqual(failures[0]?.['command_argv'], ['node', '-e', 'process.exit(3)']);

    // Conditional row, W branch: the passing required check closes the gap the dispatch was derived
    // on, and with no verifier work left the obligation is the reviewer's.
    await service.runVerification({ taskId: 'TASK-FLOW', agent: 'grok', commit: second, checkId: 'fixture' });
    const afterPass = issue(service, 'grok', 'TASK-FLOW', grok);
    assert.equal(afterPass.result.kind, 'waiting');
    assert.equal(afterPass.dispatch, null);
    assert.equal(afterPass.context_bundle, null, 'no obligation, no context to carry it out with');

    // Conditional row, C branch: a blocking finding on an earlier review is history, not a gate.
    const beforeStale = delivered(service, 'claude', 'TASK-FLOW', claude);
    const staleFinding = service.addReviewFinding({
      reviewId: String(reviewOne['id']),
      agent: 'claude',
      severity: 'blocking',
      description: 'Still worth recording against the old candidate',
    });
    const afterStale = delivered(service, 'claude', 'TASK-FLOW', claude);
    assert.equal(
      afterStale.dispatchId,
      beforeStale.dispatchId,
      'the gap query joins on the candidate, so an earlier review reaches no fact',
    );
    assert.notEqual(afterStale.digest, beforeStale.digest);
    assert.ok(
      JSON.stringify(afterStale.bundle).includes(String(staleFinding['id'])),
      'and the bundle carries it as revision history',
    );

    // Conditional row, C branch: a non-blocking finding at the current candidate.
    const beforeSoft = delivered(service, 'claude', 'TASK-FLOW', claude);
    service.addReviewFinding({
      reviewId: String(reviewTwo['id']),
      agent: 'claude',
      severity: 'non_blocking',
      description: 'Naming nit',
    });
    const afterSoft = delivered(service, 'claude', 'TASK-FLOW', claude);
    assert.equal(afterSoft.dispatchId, beforeSoft.dispatchId, 'non-blocking findings gate nothing');
    assert.notEqual(afterSoft.digest, beforeSoft.digest);

    // A terminal task carries no obligation, and so no context to carry it out with.
    service.submitReview({ reviewId: String(reviewTwo['id']), agent: 'claude', verdict: 'approved' });
    service.acceptTask({ taskId: 'TASK-FLOW', actor: 'human', expectedVersion: taskVersion(db, 'TASK-FLOW') });
    const terminal = issue(service, 'codex', 'TASK-FLOW', codex);
    assert.equal(terminal.result.kind, 'none');
    assert.equal(terminal.dispatch, null);
    assert.equal(terminal.context_bundle, null, 'no action, no bundle');
  } finally {
    close();
  }
});

test('a replacement session is a new delivery of the same content', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-RECOVER', goal: 'Survive recovery', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-RECOVER');
    const codex = sessionFor(service, 'codex');
    const before = delivered(service, 'codex', 'TASK-RECOVER', codex);

    db.prepare("UPDATE agent_sessions SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE id = ?").run(
      codex.sessionId,
    );
    const replacement = service.replaceSession({ agentId: 'codex', reason: 'the agent process was restarted' });
    const next: TestSession = { sessionId: String(replacement.session['id']), agentId: 'codex' };
    const after = delivered(service, 'codex', 'TASK-RECOVER', next);

    assert.notEqual(after.dispatchId, before.dispatchId, 'the session owns the delivery');
    assert.notEqual(after.bundleId, before.bundleId);
    assert.equal(after.digest, before.digest, 'while the content is a statement about the task');
    assert.equal(dispatchCount(db), 2);
    assert.equal(bundleCount(db), 2);
  } finally {
    close();
  }
});

test('the conversation window is the most recent by a stated total order, and nothing else is capped', () => {
  const { service, db, close } = harness();
  try {
    service.createTask({ id: 'TASK-WINDOW', goal: 'Bound the conversation', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-WINDOW');
    const codex = sessionFor(service, 'codex');

    for (let index = 0; index < 60; index += 1) {
      service.sendMessage({ from: 'claude', to: 'codex', taskId: 'TASK-WINDOW', body: `message ${index}` });
      // Not addressed to codex: these move nobody's window here, nor the total it reports.
      service.sendMessage({ from: 'claude', to: 'grok', taskId: 'TASK-WINDOW', body: `aside ${index}` });
      // Sixty sends land inside the same millisecond, where the contract says the id tiebreak is
      // stable but arbitrary. Recency is a claim about `created_at`, so the test states it.
      db.prepare('UPDATE messages SET created_at = ? WHERE body = ?').run(
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        `message ${index}`,
      );
    }

    const bundle = delivered(service, 'codex', 'TASK-WINDOW', codex).bundle;
    const conversation = bundle['conversation'] as Record<string, unknown>;
    const messages = conversation['messages'] as Array<Record<string, unknown>>;
    assert.equal(conversation['limit'], 50);
    assert.equal(conversation['total'], 60, 'the total counts what this agent can see, not what exists');
    assert.equal(conversation['truncated'], true);
    assert.equal(messages.length, 50);
    assert.equal(messages[0]?.['body'], 'message 10', 'the window is the most recent, not the first');
    assert.equal(messages.at(-1)?.['body'], 'message 59');
    // The window is the tail of the whole visible set under the stated total order, computed here
    // independently of the query that produced it.
    const visible = (
      db
        .prepare('SELECT id, created_at FROM messages WHERE task_id = ? AND (sender = ? OR recipient = ?)')
        .all('TASK-WINDOW', 'codex', 'codex') as Array<{ id: string; created_at: string }>
    ).sort((left, right) =>
      left.created_at === right.created_at
        ? left.id.localeCompare(right.id)
        : left.created_at.localeCompare(right.created_at),
    );
    assert.deepEqual(
      messages.map((message) => String(message['id'])),
      visible.slice(-50).map((message) => message.id),
      'emitted ascending after a descending selection, tiebroken on the stored id',
    );
    for (const message of messages) {
      assert.ok(message['sender'] === 'codex' || message['recipient'] === 'codex');
    }
  } finally {
    close();
  }
});

test('an echoed bundle id is attached through its own dispatch, and never inferred', async () => {
  const { service, db, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-ECHO', goal: 'Attach provenance', acceptance: [], actor: 'human' });
    service.createTask({ id: 'TASK-ELSE', goal: 'Somewhere else', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-ECHO');
    assignRoles(service, 'TASK-ELSE');
    const codex = sessionFor(service, 'codex');
    const claude = sessionFor(service, 'claude');

    const first = delivered(service, 'codex', 'TASK-ECHO', codex);
    // The agent keeps working from what it was handed while the context moves on beneath it.
    service.sendMessage({ from: 'claude', to: 'codex', taskId: 'TASK-ECHO', body: 'Landed after you started' });
    const second = delivered(service, 'codex', 'TASK-ECHO', codex);
    assert.equal(second.dispatchId, first.dispatchId);
    assert.notEqual(second.bundleId, first.bundleId);

    const elsewhere = delivered(service, 'codex', 'TASK-ELSE', codex);
    service.claimTask({
      taskId: 'TASK-ECHO',
      agent: 'codex',
      expectedVersion: taskVersion(db, 'TASK-ECHO'),
      ttlSeconds: 900,
      contextBundleId: elsewhere.bundleId,
    });
    let attempt = latestAttempt(db, 'task.claim', 'TASK-ECHO');
    assert.equal(attempt['context_bundle_id'], null, 'a bundle from another task manufactures no provenance');
    assert.equal(attempt['outcome'], 'accepted', 'and costs no work');

    // The stale bundle is the truth of what this agent worked from, so it is what gets recorded.
    const candidate = commitArtifact(repository.binding.rootPath, 'echoed candidate\n');
    const implement = delivered(service, 'codex', 'TASK-ECHO', codex);
    service.sendMessage({ from: 'claude', to: 'codex', taskId: 'TASK-ECHO', body: 'Arrived mid-implementation' });
    const fresher = delivered(service, 'codex', 'TASK-ECHO', codex);
    assert.equal(fresher.dispatchId, implement.dispatchId);
    const review = service.requestReview({
      taskId: 'TASK-ECHO',
      agent: 'codex',
      commit: candidate,
      contextBundleId: implement.bundleId,
    });
    attempt = latestAttempt(db, 'review.request', 'TASK-ECHO');
    assert.equal(
      attempt['context_bundle_id'],
      implement.bundleId,
      'an older bundle from the same generation attaches: that is what it actually worked from',
    );
    assert.equal(attempt['dispatch_id'], null, 'and nothing is inferred from it about the dispatch echo');

    // The bundle is validated through its own dispatch, which carries the generation clause.
    const reviewDelivery = delivered(service, 'claude', 'TASK-ECHO', claude);
    service.addReviewFinding({
      reviewId: String(review['id']),
      agent: 'claude',
      severity: 'blocking',
      description: 'Send it back',
    });
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'needs_revision' });
    service.claimTask({
      taskId: 'TASK-ECHO',
      agent: 'codex',
      expectedVersion: taskVersion(db, 'TASK-ECHO'),
      ttlSeconds: 900,
    });
    const nextCandidate = commitArtifact(repository.binding.rootPath, 'second candidate\n');
    const reRequested = service.requestReview({ taskId: 'TASK-ECHO', agent: 'codex', commit: nextCandidate });
    service.submitReview({
      reviewId: String(reRequested['id']),
      agent: 'claude',
      verdict: 'approved',
      contextBundleId: reviewDelivery.bundleId,
    });
    attempt = latestAttempt(db, 'review.submit', String(reRequested['id']));
    assert.equal(
      attempt['context_bundle_id'],
      null,
      'a bundle from an earlier revision generation cannot claim credit for later work',
    );
    assert.equal(attempt['outcome'], 'accepted');

    // Unknown, malformed, and absent ids all cost provenance and nothing else.
    await service.runVerification({
      taskId: 'TASK-ECHO',
      agent: 'grok',
      commit: nextCandidate,
      checkId: 'fixture',
      contextBundleId: 'bundle-does-not-exist',
    });
    attempt = latestAttempt(db, 'verification.run', 'TASK-ECHO');
    assert.equal(attempt['context_bundle_id'], null);
    assert.equal(attempt['outcome'], 'accepted');
  } finally {
    close();
  }
});

test('bundle assembly reads canonical rows and never the repository', () => {
  const fixture = createRepository();
  const db = openDatabase(':memory:');
  try {
    initializeDatabase(db, fixture.repository.binding, fixture.repository.headCommit());
    const service = new CollaborationService(db, fixture.repository);
    service.createTask({ id: 'TASK-NOIO', goal: 'Touch no files', acceptance: [], actor: 'human' });
    assignRoles(service, 'TASK-NOIO');

    // Every method on the binding throws, so any Git, file, or subprocess read during issuance is a
    // failure rather than a slow path. Property access stays open: `binding.identity` is a value.
    const sealed = new Proxy(fixture.repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value === 'function') {
          return () => {
            throw new Error(`bundle assembly reached the repository: ${String(property)}`);
          };
        }
        return value;
      },
    }) as GitRepository;
    const guarded = new CollaborationService(db, sealed);
    const codex = sessionFor(guarded, 'codex');
    const issued = guarded.issueDispatch({
      agent: 'codex',
      taskId: 'TASK-NOIO',
      session: codex,
      workInFlight: false,
    });
    assert.equal(issued.result.kind, 'action');
    assert.ok(issued.context_bundle);
    const bundle = JSON.parse(String(issued.context_bundle?.['bundle_json'])) as Record<string, unknown>;
    assert.equal((bundle['action'] as Record<string, unknown>)['base_commit'], fixture.repository.headCommit());
  } finally {
    db.close();
    fixture.close();
  }
});
