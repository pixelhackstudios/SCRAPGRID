import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { GitError, GitRepository } from '../collab/git.js';
import { CollaborationError, CollaborationService } from '../collab/service.js';
import { createCollaborationHttpServer } from '../collab/http.js';

function git(path: string, args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
}

function createRepository(): { path: string; repository: GitRepository; close: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'scrapgrid-repository-test-'));
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.name', 'SCRAPGRID Test']);
  git(path, ['config', 'user.email', 'test@scrapgrid.invalid']);
  writeFileSync(join(path, 'artifact.txt'), 'base\n');
  git(path, ['add', 'artifact.txt']);
  git(path, ['commit', '-m', 'Base artifact']);
  return { path, repository: GitRepository.discover(path), close: () => rmSync(path, { recursive: true, force: true }) };
}

function commitArtifact(path: string, content: string): string {
  writeFileSync(join(path, 'artifact.txt'), content);
  git(path, ['add', 'artifact.txt']);
  git(path, ['commit', '-m', `Artifact ${content.trim()}`]);
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

test('schema version 1 upgrades operation linkage, finding authorship, repository binding, and proposal metadata', () => {
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
    const verificationColumns = db.prepare('PRAGMA table_info(verifications)').all() as Array<{ name: string }>;
    const eventColumns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const operationsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_attempts'")
      .get() as { name: string } | undefined;
    const uniqueIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'proposals_task_agent_unique'")
      .get() as { name: string } | undefined;
    assert.equal(version.user_version, 4);
    assert.ok(columns.some((column) => column.name === 'raised_by'));
    assert.ok(verificationColumns.some((column) => column.name === 'command_argv_json'));
    assert.ok(eventColumns.some((column) => column.name === 'operation_id'));
    assert.equal(operationsTable?.name, 'operation_attempts');
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

test('stale claims and competing leases fail closed', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-001', goal: 'Prove leasing', acceptance: ['one owner'], actor: 'human' });
    service.claimTask({ taskId: 'TASK-001', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-001', agent: 'claude', expectedVersion: 1, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'stale_version',
    );
    assert.throws(
      () => service.claimTask({ taskId: 'TASK-001', agent: 'claude', expectedVersion: 2, ttlSeconds: 900 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'lease_conflict',
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
    service.claimTask({ taskId: 'TASK-LEASE', agent: 'codex', expectedVersion: 1, ttlSeconds: 0 });
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-LEASE', agent: 'codex', commit: repository.headCommit() }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'lease_required',
    );
  } finally {
    close();
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
      agent: 'codex',
      commit: candidate,
      command: ['node', '-e', "process.exit(require('fs').readFileSync('artifact.txt', 'utf8') === 'base\\n' ? 0 : 1)"],
    });
    assert.equal(verification['commit_sha'], candidate);
    assert.equal(verification['repository_identity'], repository.binding.identity);
    assert.equal(verification['exit_code'], 0);
    assert.deepEqual(JSON.parse(String(verification['command'])), [
      'node',
      '-e',
      "process.exit(require('fs').readFileSync('artifact.txt', 'utf8') === 'base\\n' ? 0 : 1)",
    ]);
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
    assert.deepEqual(sync.verifications[0]?.['command_argv'], [
      'node',
      '-e',
      "process.exit(require('fs').readFileSync('artifact.txt', 'utf8') === 'base\\n' ? 0 : 1)",
    ]);
  } finally {
    close();
  }
});

test('verification for a different commit cannot satisfy acceptance', async () => {
  const { service, repository, repositoryPath, close } = harness();
  try {
    service.createTask({ id: 'TASK-SHA', goal: 'Bind evidence to SHA', acceptance: [], actor: 'human' });
    service.claimTask({ taskId: 'TASK-SHA', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    const oldCommit = repository.headCommit();
    await service.runVerification({
      taskId: 'TASK-SHA',
      agent: 'grok',
      commit: oldCommit,
      command: ['node', '-e', 'process.exit(0)'],
    });
    const newCommit = commitArtifact(repositoryPath, 'candidate\n');
    const review = service.requestReview({ taskId: 'TASK-SHA', agent: 'grok', commit: newCommit });
    service.submitReview({ reviewId: String(review['id']), agent: 'codex', verdict: 'approved' });
    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-SHA', actor: 'human', expectedVersion: 3 }),
      (error: unknown) =>
        error instanceof CollaborationError &&
        error.code === 'acceptance_gate' &&
        error.message.includes('passing verification'),
    );
  } finally {
    close();
  }
});

test('finding author or human can resolve a finding, while the implementer cannot', async () => {
  const { service, repository, close } = harness();
  try {
    service.createTask({ id: 'TASK-FINDING', goal: 'Close findings', acceptance: [], actor: 'human' });
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
      command: ['node', '-e', 'process.exit(0)'],
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
    service.claimTask({ taskId: 'TASK-BLOCKED', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    service.addBlocker({ taskId: 'TASK-BLOCKED', agent: 'grok', description: 'A concrete dependency is missing.' });

    service.createTask({ id: 'TASK-REVIEW', goal: 'Expose pending review', acceptance: [], actor: 'human' });
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
  const { service, close } = harness();
  const server = createCollaborationHttpServer(service);
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

    const initialResponse = await fetch(`${origin}/api/snapshot`);
    const initial = (await initialResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(initialResponse.status, 200);
    assert.equal(initial['proposals']?.[0]?.['content'], undefined);

    const rejectedOrigin = await fetch(`${origin}/api/tasks/TASK-HTTP/reveal-proposals`, {
      method: 'POST',
      headers: { origin: 'https://example.invalid' },
    });
    assert.equal(rejectedOrigin.status, 403);

    const revealResponse = await fetch(`${origin}/api/tasks/TASK-HTTP/reveal-proposals`, {
      method: 'POST',
      headers: { origin },
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
      headers: { origin },
    });
    const accepted = (await acceptResponse.json()) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(acceptResponse.status, 200);
    assert.equal(accepted['decisions']?.[0]?.['status'], 'accepted');

    const invalidAccept = await fetch(`${origin}/api/tasks/TASK-HTTP/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({}),
    });
    assert.equal(invalidAccept.status, 400);
  } finally {
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    close();
  }
});
