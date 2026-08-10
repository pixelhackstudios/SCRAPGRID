import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GitError, GitRepository } from './git.js';

export class CollaborationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CollaborationError';
  }
}

type JsonObject = Record<string, unknown>;
type Row = Record<string, unknown>;
type OperationDescriptor = {
  name: string;
  actor?: string;
  subjectType?: string;
  subjectId?: string;
};

const REVISION_RESERVATION_TTL_MS = 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseJsonOrNull(value: unknown): unknown {
  try {
    return parseJson(value);
  } catch {
    return null;
  }
}

export class CollaborationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: GitRepository,
  ) {}

  private domainTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private startOperation(descriptor: OperationDescriptor): string {
    const operationId = makeId('op');
    this.db
      .prepare(
        `INSERT INTO operation_attempts
         (id, operation, actor, subject_type, subject_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        descriptor.name,
        descriptor.actor ?? null,
        descriptor.subjectType ?? null,
        descriptor.subjectId ?? null,
        now(),
      );
    return operationId;
  }

  private completeOperation(
    operationId: string,
    outcome: 'accepted' | 'rejected' | 'failed',
    reasonCode?: string,
    errorClass?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE operation_attempts
         SET outcome = ?, reason_code = ?, error_class = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(outcome, reasonCode ?? null, errorClass ?? null, now(), operationId);
  }

  private recordOperationError(operationId: string, error: unknown): void {
    if (error instanceof CollaborationError || error instanceof GitError) {
      this.completeOperation(operationId, 'rejected', error.code);
      return;
    }
    const errorClass = error instanceof Error ? error.constructor.name : typeof error;
    this.completeOperation(operationId, 'failed', undefined, errorClass);
  }

  private transaction<T>(descriptor: OperationDescriptor, execute: (operationId: string) => T): T {
    const operationId = this.startOperation(descriptor);
    try {
      return this.domainTransaction(() => {
        const result = execute(operationId);
        this.completeOperation(operationId, 'accepted');
        return result;
      });
    } catch (error) {
      this.recordOperationError(operationId, error);
      throw error;
    }
  }

  private preparedTransaction<Prepared, Result>(
    descriptor: OperationDescriptor,
    prepare: () => Prepared,
    execute: (operationId: string, prepared: Prepared) => Result,
  ): Result {
    const operationId = this.startOperation(descriptor);
    try {
      const prepared = prepare();
      return this.domainTransaction(() => {
        const result = execute(operationId, prepared);
        this.completeOperation(operationId, 'accepted');
        return result;
      });
    } catch (error) {
      this.recordOperationError(operationId, error);
      throw error;
    }
  }

  private async preparedAsyncTransaction<Prepared, Result>(
    descriptor: OperationDescriptor,
    prepare: () => Promise<Prepared>,
    execute: (operationId: string, prepared: Prepared) => Result,
  ): Promise<Result> {
    const operationId = this.startOperation(descriptor);
    try {
      const prepared = await prepare();
      return this.domainTransaction(() => {
        const result = execute(operationId, prepared);
        this.completeOperation(operationId, 'accepted');
        return result;
      });
    } catch (error) {
      this.recordOperationError(operationId, error);
      throw error;
    }
  }

  private requireAgent(agentId: string): Row {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Row | undefined;
    if (!agent) throw new CollaborationError(`unknown agent: ${agentId}`, 'unknown_agent');
    if (agent['status'] !== 'active') throw new CollaborationError(`agent is paused: ${agentId}`, 'agent_paused');
    return agent;
  }

  private requireTask(taskId: string): Row {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!task) throw new CollaborationError(`unknown task: ${taskId}`, 'unknown_task');
    return task;
  }

  private requireProjectActive(): void {
    const state = this.db.prepare('SELECT status FROM project_state WHERE singleton = 1').get() as Row;
    if (state['status'] !== 'active') throw new CollaborationError('project is paused', 'project_paused');
  }

  private event(
    operationId: string,
    actor: string,
    entityType: string,
    entityId: string,
    action: string,
    payload: JsonObject = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO events
         (operation_id, actor, entity_type, entity_id, action, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(operationId, actor, entityType, entityId, action, JSON.stringify(payload), now());
  }

  listAgents(): Row[] {
    return this.db.prepare('SELECT id, name, kind, status, last_seen_at FROM agents ORDER BY kind, id').all() as Row[];
  }

  status(): JsonObject {
    const project = this.db.prepare('SELECT status, version, updated_at FROM project_state WHERE singleton = 1').get() as Row;
    const repository = this.db.prepare('SELECT * FROM project_repository WHERE singleton = 1').get() as Row;
    const tasks = this.db
      .prepare(
        `SELECT id, goal, status, owner_agent_id, version, repository_identity, base_commit, candidate_commit
         FROM tasks ORDER BY created_at`,
      )
      .all() as Row[];
    const activeLeases = this.db
      .prepare('SELECT task_id, agent_id, lease_version, expires_at FROM leases WHERE expires_at > ? ORDER BY task_id')
      .all(now()) as Row[];
    const activeClaimReservations = this.db
      .prepare(
        `SELECT task_id, agent_id, reason, created_at, expires_at
         FROM claim_reservations WHERE expires_at > ? ORDER BY task_id`,
      )
      .all(now()) as Row[];
    const worktrees = this.db.prepare('SELECT * FROM managed_worktrees ORDER BY agent_id').all() as Row[];
    return {
      project,
      repository,
      agents: this.listAgents(),
      tasks,
      active_leases: activeLeases,
      active_claim_reservations: activeClaimReservations,
      worktrees,
    };
  }

  snapshot(): JsonObject {
    const project = this.db.prepare('SELECT status, version, updated_at FROM project_state WHERE singleton = 1').get() as Row;
    const repository = this.db.prepare('SELECT * FROM project_repository WHERE singleton = 1').get() as Row;
    const tasks = (this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Row[]).map((task) => {
      const { acceptance_json: storedAcceptance, ...plainTask } = task;
      return { ...plainTask, acceptance: parseJsonOrNull(storedAcceptance) };
    });
    const proposals = (this.db.prepare('SELECT * FROM proposals ORDER BY created_at').all() as Row[]).map(
      (proposal) => {
        if (proposal['visibility'] === 'revealed') return proposal;
        const { content: _sealedContent, ...sealedProposal } = proposal;
        return sealedProposal;
      },
    );
    const verifications = (
      this.db.prepare('SELECT * FROM verifications ORDER BY created_at').all() as Row[]
    ).map((verification) => {
      const { command: _legacyCommand, command_argv_json: storedCommand, ...plainVerification } = verification;
      return { ...plainVerification, command_argv: parseJsonOrNull(storedCommand) };
    });
    const events = (this.db.prepare('SELECT * FROM events ORDER BY id').all() as Row[]).map((event) => ({
      ...event,
      payload: parseJsonOrNull(event['payload']),
    }));

    return {
      project,
      repository,
      agents: this.listAgents(),
      tasks,
      leases: this.db.prepare('SELECT * FROM leases ORDER BY acquired_at').all() as Row[],
      claim_reservations: this.db.prepare('SELECT * FROM claim_reservations ORDER BY created_at').all() as Row[],
      worktrees: this.db.prepare('SELECT * FROM managed_worktrees ORDER BY agent_id').all() as Row[],
      messages: this.db.prepare('SELECT * FROM messages ORDER BY created_at').all() as Row[],
      proposals,
      decisions: this.db.prepare('SELECT * FROM decisions ORDER BY created_at').all() as Row[],
      blockers: this.db.prepare('SELECT * FROM blockers ORDER BY created_at').all() as Row[],
      reviews: this.db.prepare('SELECT * FROM reviews ORDER BY created_at').all() as Row[],
      findings: this.db.prepare('SELECT * FROM review_findings ORDER BY created_at').all() as Row[],
      verifications,
      operations: this.db.prepare('SELECT * FROM operation_attempts ORDER BY started_at, id').all() as Row[],
      events,
    };
  }

  sync(agentId: string, afterEvent = 0): JsonObject {
    return this.transaction(
      { name: 'sync', actor: agentId, subjectType: 'agent', subjectId: agentId },
      () => this.syncState(agentId, afterEvent),
    );
  }

  private syncState(agentId: string, afterEvent: number): JsonObject {
    this.requireAgent(agentId);
    const timestamp = now();
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(timestamp, agentId);
    const events = this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500')
      .all(afterEvent) as Row[];
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE recipient = ? ORDER BY created_at DESC LIMIT 100')
      .all(agentId) as Row[];
    const acceptedDecisions = this.db
      .prepare(
        `SELECT id, task_id, statement, rationale, actor, created_at
         FROM decisions WHERE status = 'accepted' ORDER BY created_at`,
      )
      .all() as Row[];
    const revealedProposals = this.db
      .prepare(
        `SELECT id, task_id, agent_id, content, status, created_at
         FROM proposals WHERE visibility = 'revealed' ORDER BY task_id, created_at`,
      )
      .all() as Row[];
    const openBlockers = this.db
      .prepare(
        `SELECT id, task_id, raised_by, description, created_at
         FROM blockers WHERE status = 'open' ORDER BY created_at`,
      )
      .all() as Row[];
    const pendingReviews = this.db
      .prepare(
        `SELECT id, task_id, requester, repository_identity, commit_sha, created_at
         FROM reviews WHERE verdict = 'pending' ORDER BY created_at`,
      )
      .all() as Row[];
    const verificationRows = this.db
      .prepare(
        `SELECT id, task_id, repository_identity, commit_sha, command, command_argv_json,
                exit_code, runner, created_at
         FROM verifications ORDER BY created_at DESC LIMIT 100`,
      )
      .all() as Row[];
    const verifications = verificationRows.map((verification) => ({
      ...verification,
      command_argv: parseJsonOrNull(verification['command_argv_json']),
    }));
    const openFindings = this.db
      .prepare(
        `SELECT finding.id, finding.review_id, review.task_id, review.commit_sha,
                finding.raised_by, finding.severity, finding.location, finding.description, finding.created_at
         FROM review_findings AS finding
         JOIN reviews AS review ON review.id = finding.review_id
         WHERE finding.status = 'open' ORDER BY finding.created_at`,
      )
      .all() as Row[];
    return {
      agent_id: agentId,
      synced_at: timestamp,
      cursor: events.length === 0 ? afterEvent : events.at(-1)?.['id'],
      events: events.map((event) => ({ ...event, payload: parseJson(event['payload']) })),
      messages,
      accepted_decisions: acceptedDecisions,
      revealed_proposals: revealedProposals,
      open_blockers: openBlockers,
      pending_reviews: pendingReviews,
      open_findings: openFindings,
      verifications,
      status: this.status(),
    };
  }

  createTask(input: { id: string; goal: string; acceptance: string[]; actor: string }): Row {
    return this.transaction({ name: 'task.create', actor: input.actor, subjectType: 'task', subjectId: input.id }, (operationId) => {
      this.requireProjectActive();
      this.requireAgent(input.actor);
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO tasks
           (id, goal, acceptance_json, repository_identity, base_commit, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.goal,
          JSON.stringify(input.acceptance),
          this.repository.binding.identity,
          this.repository.headCommit(),
          timestamp,
          timestamp,
        );
      const task = this.requireTask(input.id);
      this.event(operationId, input.actor, 'task', input.id, 'task_created', {
        acceptance: input.acceptance,
        repository: this.repository.binding.identity,
        base_commit: task['base_commit'],
      });
      return task;
    });
  }

  claimTask(input: { taskId: string; agent: string; expectedVersion: number; ttlSeconds: number }): Row {
    return this.transaction({ name: 'task.claim', actor: input.agent, subjectType: 'task', subjectId: input.taskId }, (operationId) => {
      this.requireProjectActive();
      this.requireAgent(input.agent);
      const task = this.requireTask(input.taskId);
      if (task['version'] !== input.expectedVersion) {
        throw new CollaborationError(
          `stale task version: expected ${input.expectedVersion}, current ${String(task['version'])}`,
          'stale_version',
        );
      }
      if (!['open', 'in_progress'].includes(String(task['status']))) {
        throw new CollaborationError(`task cannot be claimed from ${String(task['status'])}`, 'invalid_transition');
      }
      const claimedAt = now();
      const reservation = this.db
        .prepare('SELECT * FROM claim_reservations WHERE task_id = ?')
        .get(input.taskId) as Row | undefined;
      if (
        reservation &&
        String(reservation['expires_at']) > claimedAt &&
        reservation['agent_id'] !== input.agent
      ) {
        throw new CollaborationError(
          `task claim is reserved for ${String(reservation['agent_id'])}`,
          'reservation_conflict',
        );
      }
      const existing = this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(input.taskId) as Row | undefined;
      if (existing && String(existing['expires_at']) > claimedAt && existing['agent_id'] !== input.agent) {
        throw new CollaborationError(`task is leased by ${String(existing['agent_id'])}`, 'lease_conflict');
      }
      const acquiredAt = claimedAt;
      const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
      const nextVersion = input.expectedVersion + 1;
      this.db
        .prepare('UPDATE tasks SET status = \'in_progress\', owner_agent_id = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(input.agent, nextVersion, acquiredAt, input.taskId);
      this.db
        .prepare(
          `INSERT INTO leases (task_id, agent_id, lease_version, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET agent_id = excluded.agent_id,
             lease_version = excluded.lease_version, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        )
        .run(input.taskId, input.agent, nextVersion, acquiredAt, expiresAt);
      this.db.prepare('DELETE FROM claim_reservations WHERE task_id = ?').run(input.taskId);
      this.event(operationId, input.agent, 'task', input.taskId, 'lease_acquired', {
        expires_at: expiresAt,
        version: nextVersion,
        reservation_consumed: Boolean(reservation),
      });
      return this.requireTask(input.taskId);
    });
  }

  submitProposal(input: { taskId: string; agent: string; content: string }): Row {
    return this.transaction({ name: 'proposal.submit', actor: input.agent, subjectType: 'task', subjectId: input.taskId }, (operationId) => {
      this.requireProjectActive();
      this.requireTask(input.taskId);
      this.requireAgent(input.agent);
      const existing = this.db
        .prepare('SELECT id FROM proposals WHERE task_id = ? AND agent_id = ?')
        .get(input.taskId, input.agent);
      if (existing) {
        throw new CollaborationError('agent already submitted a proposal for this task', 'duplicate_proposal');
      }
      const id = makeId('proposal');
      this.db
        .prepare('INSERT INTO proposals (id, task_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, input.taskId, input.agent, input.content, now());
      this.event(operationId, input.agent, 'proposal', id, 'proposal_submitted', { task_id: input.taskId });
      return this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Row;
    });
  }

  revealProposals(taskId: string, actor: string): Row[] {
    return this.transaction({ name: 'proposal.reveal', actor, subjectType: 'task', subjectId: taskId }, (operationId) => {
      this.requireTask(taskId);
      const revealingActor = this.requireAgent(actor);
      if (revealingActor['kind'] !== 'human') {
        throw new CollaborationError('only a human can reveal proposals', 'human_required');
      }
      this.db.prepare('UPDATE proposals SET visibility = \'revealed\' WHERE task_id = ?').run(taskId);
      this.event(operationId, actor, 'task', taskId, 'proposals_revealed');
      return this.db.prepare('SELECT * FROM proposals WHERE task_id = ? ORDER BY created_at').all(taskId) as Row[];
    });
  }

  proposeDecision(input: { taskId?: string; actor: string; statement: string; rationale: string }): Row {
    return this.transaction({ name: 'decision.propose', actor: input.actor, subjectType: input.taskId ? 'task' : undefined, subjectId: input.taskId }, (operationId) => {
      this.requireAgent(input.actor);
      if (input.taskId) this.requireTask(input.taskId);
      const id = makeId('decision');
      this.db
        .prepare(
          `INSERT INTO decisions (id, task_id, statement, rationale, status, actor, created_at)
           VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
        )
        .run(id, input.taskId ?? null, input.statement, input.rationale, input.actor, now());
      this.event(operationId, input.actor, 'decision', id, 'decision_proposed', { task_id: input.taskId ?? null });
      return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row;
    });
  }

  acceptDecision(decisionId: string, actorId: string): Row {
    return this.transaction({ name: 'decision.accept', actor: actorId, subjectType: 'decision', subjectId: decisionId }, (operationId) => {
      const actor = this.requireAgent(actorId);
      if (actor['kind'] !== 'human') throw new CollaborationError('only a human can accept a decision', 'human_required');
      const decision = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Row | undefined;
      if (!decision) throw new CollaborationError(`unknown decision: ${decisionId}`, 'unknown_decision');
      if (decision['status'] !== 'proposed') {
        throw new CollaborationError('decision is not proposed', 'invalid_transition');
      }
      this.db.prepare("UPDATE decisions SET status = 'accepted' WHERE id = ?").run(decisionId);
      this.event(operationId, actorId, 'decision', decisionId, 'decision_accepted', {
        task_id: decision['task_id'] ?? null,
      });
      return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Row;
    });
  }

  sendMessage(input: { from: string; to: string; taskId?: string; body: string }): Row {
    return this.transaction({ name: 'message.send', actor: input.from, subjectType: input.taskId ? 'task' : 'agent', subjectId: input.taskId ?? input.to }, (operationId) => {
      this.requireAgent(input.from);
      this.requireAgent(input.to);
      if (input.taskId) this.requireTask(input.taskId);
      const id = makeId('message');
      this.db
        .prepare('INSERT INTO messages (id, sender, recipient, task_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.from, input.to, input.taskId ?? null, input.body, now());
      this.event(operationId, input.from, 'message', id, 'message_sent', {
        recipient: input.to,
        task_id: input.taskId ?? null,
      });
      return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row;
    });
  }

  addBlocker(input: { taskId: string; agent: string; description: string }): Row {
    return this.transaction({ name: 'blocker.add', actor: input.agent, subjectType: 'task', subjectId: input.taskId }, (operationId) => {
      const task = this.requireTask(input.taskId);
      this.requireAgent(input.agent);
      if (!['in_progress', 'blocked'].includes(String(task['status']))) {
        throw new CollaborationError('blockers require an in-progress task', 'invalid_transition');
      }
      const id = makeId('blocker');
      const timestamp = now();
      this.db
        .prepare('INSERT INTO blockers (id, task_id, raised_by, description, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, input.taskId, input.agent, input.description, timestamp);
      this.db
        .prepare('UPDATE tasks SET status = \'blocked\', version = version + 1, updated_at = ? WHERE id = ?')
        .run(timestamp, input.taskId);
      this.event(operationId, input.agent, 'blocker', id, 'blocker_added', { task_id: input.taskId });
      return this.db.prepare('SELECT * FROM blockers WHERE id = ?').get(id) as Row;
    });
  }

  resolveBlocker(blockerId: string, agent: string): Row {
    return this.transaction({ name: 'blocker.resolve', actor: agent, subjectType: 'blocker', subjectId: blockerId }, (operationId) => {
      this.requireAgent(agent);
      const blocker = this.db.prepare('SELECT * FROM blockers WHERE id = ?').get(blockerId) as Row | undefined;
      if (!blocker) throw new CollaborationError(`unknown blocker: ${blockerId}`, 'unknown_blocker');
      if (blocker['status'] !== 'open') throw new CollaborationError('blocker is not open', 'invalid_transition');
      const timestamp = now();
      this.db
        .prepare('UPDATE blockers SET status = \'resolved\', resolved_by = ?, resolved_at = ? WHERE id = ?')
        .run(agent, timestamp, blockerId);
      const remaining = this.db
        .prepare('SELECT count(*) AS count FROM blockers WHERE task_id = ? AND status = \'open\'')
        .get(String(blocker['task_id'])) as { count: number };
      if (remaining.count === 0) {
        this.db
          .prepare('UPDATE tasks SET status = \'in_progress\', version = version + 1, updated_at = ? WHERE id = ?')
          .run(timestamp, String(blocker['task_id']));
      }
      this.event(operationId, agent, 'blocker', blockerId, 'blocker_resolved');
      return this.db.prepare('SELECT * FROM blockers WHERE id = ?').get(blockerId) as Row;
    });
  }

  requestReview(input: { taskId: string; agent: string; commit: string }): Row {
    return this.preparedTransaction(
      { name: 'review.request', actor: input.agent, subjectType: 'task', subjectId: input.taskId },
      () => {
        const taskAtRequest = this.requireTask(input.taskId);
        return this.repository.requireDescendant(
          String(taskAtRequest['base_commit']),
          input.commit,
        );
      },
      (operationId, { candidateCommit: commit }) => {
        const task = this.requireTask(input.taskId);
        this.requireAgent(input.agent);
        if (task['owner_agent_id'] !== input.agent) {
          throw new CollaborationError('only the task owner can request review', 'not_task_owner');
        }
        if (task['status'] !== 'in_progress') {
          throw new CollaborationError('review requires an in-progress task', 'invalid_transition');
        }
        const timestamp = now();
        const lease = this.db
          .prepare('SELECT agent_id, expires_at FROM leases WHERE task_id = ?')
          .get(input.taskId) as Row | undefined;
        if (!lease || lease['agent_id'] !== input.agent || String(lease['expires_at']) <= timestamp) {
          throw new CollaborationError(
            'review requires the requester to hold the current live lease',
            'lease_required',
          );
        }
        const id = makeId('review');
        this.db
          .prepare(
            `INSERT INTO reviews
             (id, task_id, requester, repository_identity, commit_sha, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.taskId, input.agent, this.repository.binding.identity, commit, timestamp);
        this.db
          .prepare(
            'UPDATE tasks SET status = \'in_review\', candidate_commit = ?, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(commit, timestamp, input.taskId);
        this.db.prepare('DELETE FROM leases WHERE task_id = ?').run(input.taskId);
        this.event(operationId, input.agent, 'review', id, 'review_requested', {
          task_id: input.taskId,
          repository: this.repository.binding.identity,
          commit,
        });
        return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row;
      },
    );
  }

  submitReview(input: { reviewId: string; agent: string; verdict: 'approved' | 'needs_revision' }): Row {
    return this.transaction({ name: 'review.submit', actor: input.agent, subjectType: 'review', subjectId: input.reviewId }, (operationId) => {
      this.requireAgent(input.agent);
      const review = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(input.reviewId) as Row | undefined;
      if (!review) throw new CollaborationError(`unknown review: ${input.reviewId}`, 'unknown_review');
      if (review['requester'] === input.agent) {
        throw new CollaborationError('requester cannot review their own commit', 'self_review');
      }
      if (review['verdict'] !== 'pending') throw new CollaborationError('review already submitted', 'invalid_transition');
      const timestamp = now();
      this.db
        .prepare('UPDATE reviews SET reviewer = ?, verdict = ?, submitted_at = ? WHERE id = ?')
        .run(input.agent, input.verdict, timestamp, input.reviewId);
      let reservationExpiresAt: string | undefined;
      if (input.verdict === 'needs_revision') {
        reservationExpiresAt = new Date(Date.parse(timestamp) + REVISION_RESERVATION_TTL_MS).toISOString();
        this.db
          .prepare(
            'UPDATE tasks SET status = \'in_progress\', candidate_commit = NULL, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(timestamp, String(review['task_id']));
        this.db
          .prepare(
            `INSERT INTO claim_reservations (task_id, agent_id, reason, created_at, expires_at)
             VALUES (?, ?, 'revision', ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET agent_id = excluded.agent_id, reason = excluded.reason,
               created_at = excluded.created_at, expires_at = excluded.expires_at`,
          )
          .run(String(review['task_id']), String(review['requester']), timestamp, reservationExpiresAt);
      }
      this.event(operationId, input.agent, 'review', input.reviewId, `review_${input.verdict}`, {
        task_id: review['task_id'],
        commit: review['commit_sha'],
        ...(input.verdict === 'needs_revision'
          ? {
              claim_reserved_for: review['requester'],
              claim_reserved_until: reservationExpiresAt,
            }
          : {}),
      });
      return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(input.reviewId) as Row;
    });
  }

  addReviewFinding(input: {
    reviewId: string;
    agent: string;
    severity: 'blocking' | 'non_blocking';
    description: string;
    location?: string;
  }): Row {
    return this.transaction({ name: 'finding.add', actor: input.agent, subjectType: 'review', subjectId: input.reviewId }, (operationId) => {
      this.requireAgent(input.agent);
      const review = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(input.reviewId) as Row | undefined;
      if (!review) throw new CollaborationError(`unknown review: ${input.reviewId}`, 'unknown_review');
      if (review['requester'] === input.agent) {
        throw new CollaborationError('requester cannot add findings to their own review', 'self_review');
      }
      const id = makeId('finding');
      this.db
        .prepare(
          `INSERT INTO review_findings (id, review_id, raised_by, severity, location, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.reviewId, input.agent, input.severity, input.location ?? null, input.description, now());
      this.event(operationId, input.agent, 'review_finding', id, 'review_finding_added', {
        review_id: input.reviewId,
        severity: input.severity,
      });
      return this.db.prepare('SELECT * FROM review_findings WHERE id = ?').get(id) as Row;
    });
  }

  resolveReviewFinding(findingId: string, agent: string): Row {
    return this.transaction({ name: 'finding.resolve', actor: agent, subjectType: 'finding', subjectId: findingId }, (operationId) => {
      const resolvingAgent = this.requireAgent(agent);
      const finding = this.db.prepare('SELECT * FROM review_findings WHERE id = ?').get(findingId) as Row | undefined;
      if (!finding) throw new CollaborationError(`unknown review finding: ${findingId}`, 'unknown_finding');
      if (finding['status'] !== 'open') throw new CollaborationError('finding is not open', 'invalid_transition');
      if (resolvingAgent['kind'] !== 'human' && finding['raised_by'] !== agent) {
        throw new CollaborationError(
          'only the finding author or a human can resolve a review finding',
          'finding_resolution_forbidden',
        );
      }
      this.db.prepare("UPDATE review_findings SET status = 'resolved' WHERE id = ?").run(findingId);
      this.event(operationId, agent, 'review_finding', findingId, 'review_finding_resolved');
      return this.db.prepare('SELECT * FROM review_findings WHERE id = ?').get(findingId) as Row;
    });
  }

  async runVerification(input: { taskId: string; agent: string; commit: string; command: string[] }): Promise<Row> {
    return this.preparedAsyncTransaction(
      { name: 'verification.run', actor: input.agent, subjectType: 'task', subjectId: input.taskId },
      async () => {
        this.requireTask(input.taskId);
        this.requireAgent(input.agent);
        return this.repository.runAtCommit(input.commit, input.command);
      },
      (operationId, execution) => {
        const commandArgvJson = JSON.stringify(execution.commandArgv);
        this.requireTask(input.taskId);
        this.requireAgent(input.agent);
        const id = makeId('verify');
        this.db
          .prepare(
            `INSERT INTO verifications
             (id, task_id, repository_identity, commit_sha, command, command_argv_json, exit_code, runner, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.taskId,
            this.repository.binding.identity,
            execution.commit,
            commandArgvJson,
            commandArgvJson,
            execution.exitCode,
            input.agent,
            now(),
          );
        this.event(
          operationId,
          input.agent,
          'verification',
          id,
          execution.exitCode === 0 ? 'verification_passed' : 'verification_failed',
          {
            task_id: input.taskId,
            repository: this.repository.binding.identity,
            commit: execution.commit,
            command_argv: execution.commandArgv,
            exit_code: execution.exitCode,
          },
        );
        return this.db.prepare('SELECT * FROM verifications WHERE id = ?').get(id) as Row;
      },
    );
  }

  bootstrapWorktrees(input: { rootPath: string; baseCommit: string }): Row[] {
    return this.preparedTransaction(
      {
        name: 'worktree.bootstrap',
        actor: 'human',
        subjectType: 'repository',
        subjectId: this.repository.binding.identity,
      },
      () =>
        this.repository.bootstrapWorktrees(input.rootPath, input.baseCommit, [
          'grok',
          'claude',
          'codex',
        ]),
      (operationId, worktrees) => {
        const timestamp = now();
        const upsert = this.db.prepare(
          `INSERT INTO managed_worktrees
           (agent_id, repository_identity, branch_name, worktree_path, head_commit, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET repository_identity = excluded.repository_identity,
             branch_name = excluded.branch_name, worktree_path = excluded.worktree_path,
             head_commit = excluded.head_commit, updated_at = excluded.updated_at`,
        );
        for (const worktree of worktrees) {
          upsert.run(
            worktree.agentId,
            this.repository.binding.identity,
            worktree.branch,
            worktree.path,
            worktree.headCommit,
            timestamp,
            timestamp,
          );
          this.event(operationId, 'human', 'worktree', worktree.agentId, 'worktree_managed', {
            repository: this.repository.binding.identity,
            branch: worktree.branch,
            path: worktree.path,
            head_commit: worktree.headCommit,
          });
        }
        return this.db.prepare('SELECT * FROM managed_worktrees ORDER BY agent_id').all() as Row[];
      },
    );
  }

  acceptTask(input: { taskId: string; actor: string; expectedVersion: number }): Row {
    return this.transaction({ name: 'task.accept', actor: input.actor, subjectType: 'task', subjectId: input.taskId }, (operationId) => {
      this.requireProjectActive();
      const actor = this.requireAgent(input.actor);
      if (actor['kind'] !== 'human') throw new CollaborationError('only a human can accept a task', 'human_required');
      const task = this.requireTask(input.taskId);
      if (task['version'] !== input.expectedVersion) {
        throw new CollaborationError(
          `stale task version: expected ${input.expectedVersion}, current ${String(task['version'])}`,
          'stale_version',
        );
      }
      if (task['status'] !== 'in_review' || !task['candidate_commit']) {
        throw new CollaborationError('task is not awaiting acceptance', 'invalid_transition');
      }
      const openBlockers = this.db
        .prepare('SELECT count(*) AS count FROM blockers WHERE task_id = ? AND status = \'open\'')
        .get(input.taskId) as { count: number };
      if (openBlockers.count > 0) throw new CollaborationError('task has open blockers', 'acceptance_gate');
      const openFindings = this.db
        .prepare(
          `SELECT count(*) AS count
           FROM review_findings AS finding
           JOIN reviews AS review ON review.id = finding.review_id
           WHERE review.task_id = ? AND review.commit_sha = ?
             AND finding.severity = 'blocking' AND finding.status = 'open'`,
        )
        .get(input.taskId, String(task['candidate_commit'])) as { count: number };
      if (openFindings.count > 0) {
        throw new CollaborationError('candidate commit has open blocking review findings', 'acceptance_gate');
      }
      const review = this.db
        .prepare(
          `SELECT id FROM reviews
           WHERE task_id = ? AND repository_identity = ? AND commit_sha = ? AND verdict = 'approved'
           ORDER BY submitted_at DESC LIMIT 1`,
        )
        .get(input.taskId, this.repository.binding.identity, String(task['candidate_commit']));
      if (!review) throw new CollaborationError('candidate commit lacks an approved review', 'acceptance_gate');
      const verification = this.db
        .prepare(
          `SELECT id FROM verifications
           WHERE task_id = ? AND repository_identity = ? AND commit_sha = ? AND exit_code = 0
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.taskId, this.repository.binding.identity, String(task['candidate_commit']));
      if (!verification) throw new CollaborationError('candidate commit lacks a passing verification', 'acceptance_gate');
      const timestamp = now();
      this.db
        .prepare('UPDATE tasks SET status = \'accepted\', version = version + 1, updated_at = ? WHERE id = ?')
        .run(timestamp, input.taskId);
      this.event(operationId, input.actor, 'task', input.taskId, 'task_accepted', {
        commit: task['candidate_commit'],
      });
      return this.requireTask(input.taskId);
    });
  }
}
