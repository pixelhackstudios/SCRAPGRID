import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { CollaborationError, CollaborationService } from '../collab/service.js';

function harness(): { service: CollaborationService; close: () => void } {
  const db = openDatabase(':memory:');
  initializeDatabase(db);
  return { service: new CollaborationService(db), close: () => db.close() };
}

test('schema version 1 upgrades finding authorship and proposal uniqueness metadata', () => {
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
      PRAGMA user_version = 1;
    `);
    initializeDatabase(db);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const columns = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>;
    const uniqueIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'proposals_task_agent_unique'")
      .get() as { name: string } | undefined;
    assert.equal(version.user_version, 2);
    assert.ok(columns.some((column) => column.name === 'raised_by'));
    assert.equal(uniqueIndex?.name, 'proposals_task_agent_unique');
  } finally {
    db.close();
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
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-LEASE', goal: 'Reject expired owners', acceptance: [], actor: 'human' });
    service.claimTask({ taskId: 'TASK-LEASE', agent: 'codex', expectedVersion: 1, ttlSeconds: 0 });
    assert.throws(
      () => service.requestReview({ taskId: 'TASK-LEASE', agent: 'codex', commit: 'expired-sha' }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'lease_required',
    );
  } finally {
    close();
  }
});

test('three agents can propose, implement, communicate, verify, review, and reach human acceptance', () => {
  const { service, close } = harness();
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
    service.recordVerification({
      taskId: 'TASK-ROOM',
      agent: 'codex',
      commit: 'abc123',
      command: 'npm test',
      exitCode: 0,
    });
    const review = service.requestReview({ taskId: 'TASK-ROOM', agent: 'codex', commit: 'abc123' });

    assert.throws(
      () => service.acceptTask({ taskId: 'TASK-ROOM', actor: 'human', expectedVersion: 3 }),
      (error: unknown) => error instanceof CollaborationError && error.code === 'acceptance_gate',
    );
    service.submitReview({ reviewId: String(review['id']), agent: 'claude', verdict: 'approved' });
    const accepted = service.acceptTask({ taskId: 'TASK-ROOM', actor: 'human', expectedVersion: 3 });
    assert.equal(accepted['status'], 'accepted');

    const sync = service.sync('grok') as { events: Array<Record<string, unknown>> };
    assert.ok(sync.events.some((event) => event['action'] === 'task_accepted'));
  } finally {
    close();
  }
});

test('verification for a different commit cannot satisfy acceptance', () => {
  const { service, close } = harness();
  try {
    service.createTask({ id: 'TASK-SHA', goal: 'Bind evidence to SHA', acceptance: [], actor: 'human' });
    service.claimTask({ taskId: 'TASK-SHA', agent: 'grok', expectedVersion: 1, ttlSeconds: 900 });
    service.recordVerification({
      taskId: 'TASK-SHA',
      agent: 'grok',
      commit: 'old-sha',
      command: 'npm test',
      exitCode: 0,
    });
    const review = service.requestReview({ taskId: 'TASK-SHA', agent: 'grok', commit: 'new-sha' });
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

test('finding author or human can resolve a finding, while the implementer cannot', () => {
  const { service, close } = harness();
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
    service.recordVerification({
      taskId: 'TASK-FINDING',
      agent: 'codex',
      commit: 'finding-sha',
      command: 'npm test',
      exitCode: 0,
    });
    const review = service.requestReview({ taskId: 'TASK-FINDING', agent: 'grok', commit: 'finding-sha' });
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
      commit: 'human-sha',
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
  const { service, close } = harness();
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
    const review = service.requestReview({ taskId: 'TASK-REVIEW', agent: 'codex', commit: 'context-sha' });
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
    assert.deepEqual(synced['pending_reviews']?.map((item) => item['commit_sha']), ['context-sha']);
    assert.deepEqual(synced['open_findings']?.map((item) => item['description']), [
      'Restart recovery needs a focused test.',
    ]);
  } finally {
    close();
  }
});
