import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  acceptanceGapMessage,
  basisDigest,
  canonicalJson,
  deriveDispatchResult,
  DISPATCH_CONTRACT_VERSION,
  TERMINAL_OPERATIONS,
  type AcceptanceGap,
  type DispatchActionDescriptor,
  type DispatchActionKind,
  type DispatchEnvelope,
  type DispatchFacts,
  type DispatchResult,
  type DispatchRole,
  type TerminalOperation,
} from './dispatch.js';
import {
  contextBundleDigest,
  CONTEXT_BUNDLE_CONTRACT_VERSION,
  CONTEXT_BUNDLE_MESSAGE_LIMIT,
  type ContextBundle,
  type ContextCheckPolicy,
  type ContextFinding,
  type ContextMessage,
  type ContextReview,
} from './context.js';
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
type RequiredCheck = { id: string; argv: string[] };
type CheckPolicy = { version: 1; checks: RequiredCheck[] };
type VerificationInput = {
  taskId: string;
  agent: string;
  commit: string;
  command?: string[];
  checkId?: string;
  dispatchId?: string;
  contextBundleId?: string;
};
type TaskRole = 'implementer' | 'reviewer' | 'verifier';
type TaskRoleAssignment = Record<TaskRole, string>;

const REVISION_RESERVATION_TTL_MS = 60 * 60 * 1000;
const CHECK_POLICY_PATH = '.scrapgrid/checks.json';

/**
 * How long an authenticated session may go quiet before recovery may replace it.
 *
 * Fifteen minutes is chosen for frontier coding agents, which routinely spend minutes inside a
 * single turn without touching the daemon. A short presence timeout would classify ordinary
 * thinking as absence and invite exactly the replacement races step 7 exists to prevent.
 */
export const SESSION_STALE_AFTER_MS = 15 * 60 * 1000;

export interface SessionPrincipal {
  sessionId: string;
  agentId: string;
}

export interface ServiceOptions {
  sessionStaleAfterMs?: number;
  /**
   * Whether a session still has daemon work the daemon accepted and has not finished.
   *
   * Liveness and replacement are two questions about one fact, so they consult one probe. Without
   * it the harness could refuse a replacement because a session is working while simultaneously
   * projecting that same session as stale.
   */
  hasWorkInFlight?: (sessionId: string) => boolean;
}

export function hashSessionCredential(token: string): string {
  return createHash('sha256').update(`scrapgrid-session\0${token}`).digest('hex');
}

export function mintSessionCredential(): string {
  return randomBytes(32).toString('base64url');
}

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

function parseCheckPolicy(contents: unknown): CheckPolicy {
  let value: unknown;
  try {
    value = parseJson(contents);
  } catch {
    throw new CollaborationError(`${CHECK_POLICY_PATH} must contain valid JSON`, 'invalid_check_policy');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollaborationError(`${CHECK_POLICY_PATH} must contain an object`, 'invalid_check_policy');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1 || !Array.isArray(candidate['checks']) || candidate['checks'].length === 0) {
    throw new CollaborationError(
      `${CHECK_POLICY_PATH} requires version 1 and at least one check`,
      'invalid_check_policy',
    );
  }
  const ids = new Set<string>();
  const checks = candidate['checks'].map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CollaborationError('each required check must be an object', 'invalid_check_policy');
    }
    const check = item as Record<string, unknown>;
    const id = check['id'];
    const argv = check['argv'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || ids.has(id)) {
      throw new CollaborationError('required check ids must be unique names', 'invalid_check_policy');
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      typeof argv[0] !== 'string' ||
      argv[0].length === 0 ||
      !argv.every((argument) => typeof argument === 'string')
    ) {
      throw new CollaborationError(`required check ${id} must define a non-empty argv`, 'invalid_check_policy');
    }
    ids.add(id);
    return { id, argv: [...argv] };
  });
  return { version: 1, checks };
}

export class CollaborationService {
  private readonly sessionStaleAfterMs: number;
  private readonly hasWorkInFlight: (sessionId: string) => boolean;

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: GitRepository,
    options: ServiceOptions = {},
  ) {
    this.sessionStaleAfterMs = options.sessionStaleAfterMs ?? SESSION_STALE_AFTER_MS;
    this.hasWorkInFlight = options.hasWorkInFlight ?? (() => false);
  }

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

  private loadBaseCheckPolicy(): { baseCommit: string; identity: string; policy: CheckPolicy } {
    const baseCommit = this.repository.headCommit();
    let source;
    try {
      source = this.repository.readBlobAtCommit(baseCommit, CHECK_POLICY_PATH);
    } catch (error) {
      if (error instanceof GitError && error.code === 'missing_repository_file') {
        throw new CollaborationError(
          `${CHECK_POLICY_PATH} is required at task base ${baseCommit}`,
          'missing_check_policy',
        );
      }
      throw error;
    }
    return { baseCommit, identity: source.identity, policy: parseCheckPolicy(source.contents) };
  }

  private requireTaskCheckPolicy(task: Row): CheckPolicy {
    if (!task['check_policy_identity'] || !task['check_policy_json']) {
      throw new CollaborationError('task has no pinned required-check policy', 'missing_check_policy');
    }
    return parseCheckPolicy(task['check_policy_json']);
  }

  private verificationSpec(task: Row, input: VerificationInput): {
    command: string[];
    checkId?: string;
    checkPolicyIdentity?: string;
  } {
    if (input.checkId && input.command) {
      throw new CollaborationError('verification must use either a named check or explicit argv', 'invalid_verification');
    }
    if (input.checkId) {
      const policy = this.requireTaskCheckPolicy(task);
      const check = policy.checks.find((candidate) => candidate.id === input.checkId);
      if (!check) throw new CollaborationError(`unknown required check: ${input.checkId}`, 'unknown_required_check');
      return {
        command: check.argv,
        checkId: check.id,
        checkPolicyIdentity: String(task['check_policy_identity']),
      };
    }
    if (!input.command || input.command.length === 0) {
      throw new CollaborationError('verification requires a named check or explicit argv', 'missing_verification_command');
    }
    return { command: input.command };
  }

  private requireIndependentVerifier(taskId: string, agentId: string): Row {
    const task = this.requireTask(taskId);
    if (task['owner_agent_id'] === agentId) {
      throw new CollaborationError('task implementer cannot verify their own candidate', 'self_verify');
    }
    return task;
  }

  private requireTaskRole(taskId: string, role: TaskRole, agentId: string): Row {
    const assignment = this.db
      .prepare('SELECT * FROM task_roles WHERE task_id = ? AND role = ?')
      .get(taskId, role) as Row | undefined;
    if (!assignment) {
      throw new CollaborationError(`task requires an assigned ${role}`, 'roles_required');
    }
    if (assignment['agent_id'] !== agentId) {
      throw new CollaborationError(
        `${role} authority belongs to ${String(assignment['agent_id'])}`,
        'role_forbidden',
      );
    }
    return assignment;
  }

  private requireAssignedRoles(taskId: string): TaskRoleAssignment {
    const rows = this.db
      .prepare('SELECT role, agent_id FROM task_roles WHERE task_id = ?')
      .all(taskId) as Array<{ role: TaskRole; agent_id: string }>;
    if (rows.length !== 3) throw new CollaborationError('task requires all three assigned roles', 'roles_required');
    return Object.fromEntries(rows.map((row) => [row.role, row.agent_id])) as TaskRoleAssignment;
  }

  private requireProjectActive(): void {
    const state = this.db.prepare('SELECT status FROM project_state WHERE singleton = 1').get() as Row;
    if (state['status'] !== 'active') throw new CollaborationError('project is paused', 'project_paused');
  }

  /**
   * The lease row and whether it is live at `at` — the single place that comparison is made.
   *
   * Expiry is a timestamp comparison with no backing mutation, so a caller that reads the clock
   * twice can see the same lease from both sides. Every caller passes the one instant it decided to
   * evaluate against, and this predicate never reads the clock itself.
   *
   * The row is returned alongside the verdict because the two readers need different things from
   * it: authority wants the live lease and nothing else, while dispatch records the expired row in
   * `basis_json` so a later reader can see which side of the boundary the derivation was on. Both
   * still consume one evaluation, so changing the rule cannot leave dispatch behind.
   */
  private leaseFact(taskId: string, at: string): { row: Row | undefined; live: boolean } {
    const row = this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId) as Row | undefined;
    return { row, live: row !== undefined && String(row['expires_at']) > at };
  }

  /** The claim reservation row and whether it is active at `at`. Same one-instant rule as leases. */
  private reservationFact(taskId: string, at: string): { row: Row | undefined; active: boolean } {
    const row = this.db
      .prepare('SELECT * FROM claim_reservations WHERE task_id = ?')
      .get(taskId) as Row | undefined;
    return { row, active: row !== undefined && String(row['expires_at']) > at };
  }

  private liveLease(taskId: string, at: string): Row | undefined {
    const fact = this.leaseFact(taskId, at);
    return fact.live ? fact.row : undefined;
  }

  private activeClaimReservation(taskId: string, at: string): Row | undefined {
    const fact = this.reservationFact(taskId, at);
    return fact.active ? fact.row : undefined;
  }

  /**
   * Everything still standing between a candidate and acceptance, in the order `acceptTask()`
   * refuses on them.
   *
   * This is the single enumeration of the acceptance gates, with two readers: `acceptTask()`
   * rejects when the list is non-empty, and dispatch derivation projects the same list onto roles.
   * Keeping one source is what stops the dispatcher from growing a second, subtly different copy of
   * the acceptance rules — the failure mode step 8 exists to avoid.
   *
   * The caller supplies status and version checks; this answers only "what evidence is missing".
   */
  private acceptanceGaps(task: Row, roles: TaskRoleAssignment): AcceptanceGap[] {
    const taskId = String(task['id']);
    const candidate = String(task['candidate_commit']);
    const identity = this.repository.binding.identity;
    const gaps: AcceptanceGap[] = [];

    const openBlockers = this.db
      .prepare("SELECT id FROM blockers WHERE task_id = ? AND status = 'open' ORDER BY created_at, id")
      .all(taskId) as Row[];
    if (openBlockers.length > 0) {
      gaps.push({ gate: 'open_blockers', ids: openBlockers.map((row) => String(row['id'])) });
    }

    const openFindings = this.db
      .prepare(
        `SELECT finding.id AS id
         FROM review_findings AS finding
         JOIN reviews AS review ON review.id = finding.review_id
         WHERE review.task_id = ? AND review.commit_sha = ?
           AND finding.severity = 'blocking' AND finding.status = 'open'
         ORDER BY finding.created_at, finding.id`,
      )
      .all(taskId, candidate) as Row[];
    if (openFindings.length > 0) {
      gaps.push({ gate: 'blocking_findings', ids: openFindings.map((row) => String(row['id'])) });
    }

    const review = this.db
      .prepare(
        `SELECT id FROM reviews
         WHERE task_id = ? AND repository_identity = ? AND commit_sha = ? AND verdict = 'approved'
           AND reviewer = ?
         ORDER BY submitted_at DESC LIMIT 1`,
      )
      .get(taskId, identity, candidate, roles.reviewer);
    if (!review) gaps.push({ gate: 'approved_review' });

    const override = this.db
      .prepare(
        `SELECT id FROM check_policy_overrides
         WHERE task_id = ? AND repository_identity = ? AND candidate_commit = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, identity, candidate) as Row | undefined;

    const independentVerification = this.db
      .prepare(
        `SELECT id FROM verifications
         WHERE task_id = ? AND repository_identity = ? AND commit_sha = ? AND exit_code = 0
           AND runner = ? AND runner <> ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, identity, candidate, roles.verifier, String(task['owner_agent_id']));
    if (!independentVerification) gaps.push({ gate: 'independent_verification' });

    // An override waives the named checks and nothing else: the independent-verifier evidence above
    // is still required, which is why it is gathered before this branch rather than inside it.
    if (override) return gaps;

    let policy: CheckPolicy;
    try {
      policy = this.requireTaskCheckPolicy(task);
    } catch {
      gaps.push({ gate: 'check_policy_invalid' });
      return gaps;
    }
    for (const check of policy.checks) {
      const verification = this.db
        .prepare(
          `SELECT id FROM verifications
           WHERE task_id = ? AND repository_identity = ? AND commit_sha = ? AND exit_code = 0
             AND runner = ? AND runner <> ? AND check_id = ? AND check_policy_identity = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(
          taskId,
          identity,
          candidate,
          roles.verifier,
          String(task['owner_agent_id']),
          check.id,
          String(task['check_policy_identity']),
        );
      if (!verification) gaps.push({ gate: 'required_check', check_id: check.id });
    }
    return gaps;
  }

  /** The check policy override recorded against a task's candidate, if a human made one. */
  private candidateOverride(task: Row): Row | undefined {
    return this.db
      .prepare(
        `SELECT id FROM check_policy_overrides
         WHERE task_id = ? AND repository_identity = ? AND candidate_commit = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(String(task['id']), this.repository.binding.identity, String(task['candidate_commit'])) as Row | undefined;
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

  /** Where a model's session credential can be delivered, when its worktree has been registered. */
  managedWorktreePath(agentId: string): string | undefined {
    const worktree = this.db
      .prepare('SELECT worktree_path FROM managed_worktrees WHERE agent_id = ?')
      .get(agentId) as Row | undefined;
    return worktree ? String(worktree['worktree_path']) : undefined;
  }

  /** Projects registered worktree metadata with the current Git HEAD instead of bootstrap-time state. */
  private managedWorktrees(): Row[] {
    const registered = this.db.prepare('SELECT * FROM managed_worktrees ORDER BY agent_id').all() as Row[];
    return registered.map((worktree) => ({
      ...worktree,
      head_commit: this.repository.worktreeHead(String(worktree['worktree_path'])),
    }));
  }

  listAgents(): Row[] {
    return this.db.prepare('SELECT id, name, kind, status, last_seen_at FROM agents ORDER BY kind, id').all() as Row[];
  }

  private requireModelAgent(agentId: string): Row {
    const agent = this.requireAgent(agentId);
    if (agent['kind'] !== 'model') {
      throw new CollaborationError(
        `collaboration sessions belong to model agents: ${agentId}`,
        'invalid_session_agent',
      );
    }
    return agent;
  }

  private currentSession(agentId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM agent_sessions WHERE agent_id = ? AND status = 'open'")
      .get(agentId) as Row | undefined;
  }

  private sessionIsStale(session: Row, at = Date.now()): boolean {
    return Date.parse(String(session['last_heartbeat_at'])) <= at - this.sessionStaleAfterMs;
  }

  /**
   * Ends a session and mints the credential that replaces it, if any.
   *
   * Every path that retires a session goes through here, so "the previous credential is permanently
   * invalid" is one rule rather than one rule per caller.
   */
  private retireSession(
    session: Row,
    status: 'closed' | 'replaced',
    reason: string,
    replacedBy?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
         SET status = ?, ended_at = ?, ended_reason = ?, replaced_by_session_id = ?
         WHERE id = ?`,
      )
      .run(status, now(), reason, replacedBy ?? null, String(session['id']));
  }

  private insertSession(agentId: string): { id: string; token: string } {
    const id = makeId('session');
    const token = mintSessionCredential();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO agent_sessions (id, agent_id, credential_hash, status, created_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, agentId, hashSessionCredential(token), timestamp, timestamp);
    return { id, token };
  }

  private requireSessionRow(sessionId: string): Row {
    const session = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as Row | undefined;
    if (!session) throw new CollaborationError(`unknown session: ${sessionId}`, 'unknown_session');
    return session;
  }

  /**
   * Session rows as projected outward. The credential hash never leaves the database.
   *
   * A live session is one that has communicated recently *or* currently has accepted work in
   * flight. A model routinely spends minutes inside one operation without saying anything else, and
   * a session the daemon is still writing on behalf of is the opposite of absent.
   */
  private publicSession(session: Row, at = Date.now()): Row {
    const { credential_hash: _hash, ...visible } = session;
    const working = session['status'] === 'open' && this.hasWorkInFlight(String(session['id']));
    return {
      ...visible,
      liveness:
        session['status'] !== 'open'
          ? 'ended'
          : working || !this.sessionIsStale(session, at)
            ? 'live'
            : 'stale',
      work_in_flight: session['status'] === 'open' ? working : false,
    };
  }

  sessions(): Row[] {
    const at = Date.now();
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions ORDER BY created_at, id')
      .all() as Row[];
    return rows.map((session) => this.publicSession(session, at));
  }

  /**
   * Resolves a presented bearer credential to its session principal.
   *
   * Only an open session authenticates. A closed or replaced credential resolves to nothing, which
   * is what makes an agent process that wakes up after recovery fail closed rather than reattach.
   */
  authenticateSession(token: string): SessionPrincipal | undefined {
    const session = this.db
      .prepare("SELECT id, agent_id FROM agent_sessions WHERE credential_hash = ? AND status = 'open'")
      .get(hashSessionCredential(token)) as Row | undefined;
    if (!session) return undefined;
    return { sessionId: String(session['id']), agentId: String(session['agent_id']) };
  }

  /**
   * Refreshes liveness without touching the ledger or the event stream.
   *
   * Presence is a timestamp, not history. Recording every heartbeat as an attempt and an event
   * would bury the causal record it exists to keep readable.
   */
  touchSession(principal: SessionPrincipal): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ? AND status = 'open'")
      .run(timestamp, principal.sessionId);
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(timestamp, principal.agentId);
  }

  heartbeat(principal: SessionPrincipal): Row {
    this.touchSession(principal);
    return this.publicSession(this.requireSessionRow(principal.sessionId));
  }

  openSession(agentId: string): { session: Row; token: string } {
    return this.transaction(
      { name: 'session.open', actor: 'human', subjectType: 'agent', subjectId: agentId },
      (operationId) => {
        this.requireModelAgent(agentId);
        if (this.currentSession(agentId)) {
          throw new CollaborationError(
            `${agentId} already has a current session; replace it instead of opening a second one`,
            'session_exists',
          );
        }
        const { id, token } = this.insertSession(agentId);
        this.event(operationId, 'human', 'session', id, 'session_opened', { agent_id: agentId });
        return { session: this.publicSession(this.requireSessionRow(id)), token };
      },
    );
  }

  /**
   * Deterministic recovery for a session whose agent is gone.
   *
   * Replacement is refused while the outgoing session still has accepted daemon work in flight.
   * A stale heartbeat only means nobody has called recently; a check running inside `collabd` is
   * still a writer, and handing the same identity to a second process would create exactly the
   * competing authority Pilot 002 counts as a hard failure.
   */
  replaceSession(input: { agentId: string; reason: string }): { session: Row; token: string; replaced: string } {
    return this.transaction(
      { name: 'session.replace', actor: 'human', subjectType: 'agent', subjectId: input.agentId },
      (operationId) => {
        this.requireModelAgent(input.agentId);
        const reason = input.reason.trim();
        if (!reason) {
          throw new CollaborationError('session replacement requires a reason', 'session_reason_required');
        }
        const current = this.currentSession(input.agentId);
        if (!current) {
          throw new CollaborationError(`${input.agentId} has no current session`, 'unknown_session');
        }
        const outgoing = String(current['id']);
        if (this.hasWorkInFlight(outgoing)) {
          throw new CollaborationError(
            `${input.agentId} still has accepted daemon work in flight`,
            'session_busy',
          );
        }
        if (!this.sessionIsStale(current)) {
          throw new CollaborationError(
            `${input.agentId} has a live session; replacement recovers a stale one`,
            'session_live',
          );
        }
        // The outgoing row is retired first so the one-open-session index admits the replacement.
        this.retireSession(current, 'replaced', reason);
        const { id, token } = this.insertSession(input.agentId);
        this.db.prepare('UPDATE agent_sessions SET replaced_by_session_id = ? WHERE id = ?').run(id, outgoing);
        this.event(operationId, 'human', 'session', id, 'session_replaced', {
          agent_id: input.agentId,
          replaced_session_id: outgoing,
          reason,
        });
        return { session: this.publicSession(this.requireSessionRow(id)), token, replaced: outgoing };
      },
    );
  }

  closeSession(input: { agentId: string; reason: string }): Row {
    return this.transaction(
      { name: 'session.close', actor: 'human', subjectType: 'agent', subjectId: input.agentId },
      (operationId) => {
        this.requireModelAgent(input.agentId);
        const current = this.currentSession(input.agentId);
        if (!current) {
          throw new CollaborationError(`${input.agentId} has no current session`, 'unknown_session');
        }
        const outgoing = String(current['id']);
        if (this.hasWorkInFlight(outgoing)) {
          throw new CollaborationError(
            `${input.agentId} still has accepted daemon work in flight`,
            'session_busy',
          );
        }
        this.retireSession(current, 'closed', input.reason.trim() || 'closed');
        this.event(operationId, 'human', 'session', outgoing, 'session_closed', { agent_id: input.agentId });
        return this.publicSession(this.requireSessionRow(outgoing));
      },
    );
  }

  status(): JsonObject {
    const project = this.db.prepare('SELECT status, version, updated_at FROM project_state WHERE singleton = 1').get() as Row;
    const repository = this.db.prepare('SELECT * FROM project_repository WHERE singleton = 1').get() as Row;
    const tasks = this.db
      .prepare(
        `SELECT id, goal, status, owner_agent_id, version, repository_identity, base_commit,
                check_policy_identity, candidate_commit
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
    const worktrees = this.managedWorktrees();
    return {
      project,
      repository,
      agents: this.listAgents(),
      // Enabled/paused identity, live/stale session, and last heartbeat stay three separate facts.
      sessions: this.sessions(),
      tasks,
      active_leases: activeLeases,
      active_claim_reservations: activeClaimReservations,
      task_roles: this.db.prepare('SELECT * FROM task_roles ORDER BY task_id, role').all() as Row[],
      worktrees,
    };
  }

  snapshot(): JsonObject {
    const project = this.db.prepare('SELECT status, version, updated_at FROM project_state WHERE singleton = 1').get() as Row;
    const repository = this.db.prepare('SELECT * FROM project_repository WHERE singleton = 1').get() as Row;
    const tasks = (this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Row[]).map((task) => {
      const {
        acceptance_json: storedAcceptance,
        check_policy_json: storedCheckPolicy,
        ...plainTask
      } = task;
      return {
        ...plainTask,
        acceptance: parseJsonOrNull(storedAcceptance),
        check_policy: parseJsonOrNull(storedCheckPolicy),
      };
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
      sessions: this.sessions(),
      tasks,
      leases: this.db.prepare('SELECT * FROM leases ORDER BY acquired_at').all() as Row[],
      claim_reservations: this.db.prepare('SELECT * FROM claim_reservations ORDER BY created_at').all() as Row[],
      task_roles: this.db.prepare('SELECT * FROM task_roles ORDER BY task_id, role').all() as Row[],
      worktrees: this.managedWorktrees(),
      messages: this.db.prepare('SELECT * FROM messages ORDER BY created_at').all() as Row[],
      proposals,
      decisions: this.db.prepare('SELECT * FROM decisions ORDER BY created_at').all() as Row[],
      blockers: this.db.prepare('SELECT * FROM blockers ORDER BY created_at').all() as Row[],
      reviews: this.db.prepare('SELECT * FROM reviews ORDER BY created_at').all() as Row[],
      findings: this.db.prepare('SELECT * FROM review_findings ORDER BY created_at').all() as Row[],
      verifications,
      check_policy_overrides: this.db
        .prepare('SELECT * FROM check_policy_overrides ORDER BY created_at')
        .all() as Row[],
      dispatches: this.db.prepare('SELECT * FROM dispatches ORDER BY issued_at, id').all() as Row[],
      context_bundles: this.db
        .prepare('SELECT * FROM context_bundles ORDER BY created_at, id')
        .all() as Row[],
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
                check_id, check_policy_identity, exit_code, runner, created_at
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
    const checkPolicyOverrides = this.db
      .prepare(
        `SELECT id, task_id, repository_identity, candidate_commit, check_policy_identity, actor, reason, created_at
         FROM check_policy_overrides ORDER BY created_at`,
      )
      .all() as Row[];
    const taskRoles = this.db
      .prepare('SELECT task_id, role, agent_id, assigned_by, assigned_at FROM task_roles ORDER BY task_id, role')
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
      check_policy_overrides: checkPolicyOverrides,
      task_roles: taskRoles,
      status: this.status(),
    };
  }

  createTask(input: { id: string; goal: string; acceptance: string[]; actor: string }): Row {
    return this.preparedTransaction(
      { name: 'task.create', actor: input.actor, subjectType: 'task', subjectId: input.id },
      () => this.loadBaseCheckPolicy(),
      (operationId, policySource) => {
        this.requireProjectActive();
        this.requireAgent(input.actor);
        const timestamp = now();
        this.db
          .prepare(
            `INSERT INTO tasks
             (id, goal, acceptance_json, repository_identity, base_commit,
              check_policy_identity, check_policy_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.goal,
            JSON.stringify(input.acceptance),
            this.repository.binding.identity,
            policySource.baseCommit,
            policySource.identity,
            JSON.stringify(policySource.policy),
            timestamp,
            timestamp,
          );
        const task = this.requireTask(input.id);
        this.event(operationId, input.actor, 'task', input.id, 'task_created', {
          acceptance: input.acceptance,
          repository: this.repository.binding.identity,
          base_commit: task['base_commit'],
          check_policy_identity: policySource.identity,
          required_checks: policySource.policy.checks.map((check) => check.id),
        });
        return task;
      },
    );
  }

  assignTaskRoles(input: {
    taskId: string;
    actor: string;
    implementer: string;
    reviewer: string;
    verifier: string;
  }): Row[] {
    return this.transaction(
      { name: 'task.assign_roles', actor: input.actor, subjectType: 'task', subjectId: input.taskId },
      (operationId) => {
        const actor = this.requireAgent(input.actor);
        if (actor['kind'] !== 'human') {
          throw new CollaborationError('only a human can assign task roles', 'human_required');
        }
        const task = this.requireTask(input.taskId);
        if (task['status'] !== 'open') {
          throw new CollaborationError('task roles must be assigned before implementation begins', 'invalid_transition');
        }
        const assignments: TaskRoleAssignment = {
          implementer: input.implementer,
          reviewer: input.reviewer,
          verifier: input.verifier,
        };
        if (new Set(Object.values(assignments)).size !== 3) {
          throw new CollaborationError('implementer, reviewer, and verifier must be distinct', 'role_conflict');
        }
        const existing = this.db
          .prepare('SELECT count(*) AS count FROM task_roles WHERE task_id = ?')
          .get(input.taskId) as { count: number };
        if (existing.count > 0) {
          throw new CollaborationError('task roles are already assigned', 'invalid_transition');
        }
        const timestamp = now();
        const insert = this.db.prepare(
          `INSERT INTO task_roles (task_id, role, agent_id, assigned_by, assigned_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const [role, agentId] of Object.entries(assignments) as Array<[TaskRole, string]>) {
          const agent = this.requireAgent(agentId);
          if (agent['kind'] !== 'model' || agent['status'] !== 'active') {
            throw new CollaborationError(`${role} must be an enabled model agent`, 'invalid_role_agent');
          }
          insert.run(input.taskId, role, agentId, input.actor, timestamp);
        }
        this.event(operationId, input.actor, 'task', input.taskId, 'task_roles_assigned', assignments);
        return this.db.prepare('SELECT * FROM task_roles WHERE task_id = ? ORDER BY role').all(input.taskId) as Row[];
      },
    );
  }

  claimTask(input: {
    taskId: string;
    agent: string;
    expectedVersion: number;
    ttlSeconds: number;
    dispatchId?: string;
    contextBundleId?: string;
  }): Row {
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
      // Any reservation row is consumed by the unconditional delete below, expired or not, so the
      // event payload counts rows while the conflict test below counts only live ones.
      const reservationExists = Boolean(
        this.db.prepare('SELECT 1 FROM claim_reservations WHERE task_id = ?').get(input.taskId),
      );
      const reservation = this.activeClaimReservation(input.taskId, claimedAt);
      if (reservation && reservation['agent_id'] !== input.agent) {
        throw new CollaborationError(
          `task claim is reserved for ${String(reservation['agent_id'])}`,
          'reservation_conflict',
        );
      }
      this.requireTaskRole(input.taskId, 'implementer', input.agent);
      const existing = this.liveLease(input.taskId, claimedAt);
      if (existing && existing['agent_id'] !== input.agent) {
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
      this.attachDispatch(operationId, {
        dispatchId: input.dispatchId,
        agentId: input.agent,
        taskId: input.taskId,
        taskVersion: Number(task['version']),
        terminalOperation: 'task.claim',
        contextBundleId: input.contextBundleId,
      });
      this.event(operationId, input.agent, 'task', input.taskId, 'lease_acquired', {
        expires_at: expiresAt,
        version: nextVersion,
        reservation_consumed: reservationExists,
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

  requestReview(input: {
    taskId: string;
    agent: string;
    commit: string;
    dispatchId?: string;
    contextBundleId?: string;
  }): Row {
    return this.preparedTransaction(
      { name: 'review.request', actor: input.agent, subjectType: 'task', subjectId: input.taskId },
      () => {
        const taskAtRequest = this.requireTask(input.taskId);
        this.requireAgent(input.agent);
        this.requireTaskRole(input.taskId, 'implementer', input.agent);
        return this.repository.requireDescendant(
          String(taskAtRequest['base_commit']),
          input.commit,
        );
      },
      (operationId, { candidateCommit: commit }) => {
        const task = this.requireTask(input.taskId);
        this.requireAgent(input.agent);
        this.requireTaskRole(input.taskId, 'implementer', input.agent);
        if (task['owner_agent_id'] !== input.agent) {
          throw new CollaborationError('only the task owner can request review', 'not_task_owner');
        }
        if (task['status'] !== 'in_progress') {
          throw new CollaborationError('review requires an in-progress task', 'invalid_transition');
        }
        const timestamp = now();
        const lease = this.liveLease(input.taskId, timestamp);
        if (!lease || lease['agent_id'] !== input.agent) {
          throw new CollaborationError(
            'review requires the requester to hold the current live lease',
            'lease_required',
          );
        }
        const id = makeId('review');
        this.db
          .prepare(
            `INSERT INTO reviews
             (id, task_id, requester, reviewer, repository_identity, commit_sha, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.taskId,
            input.agent,
            this.requireAssignedRoles(input.taskId).reviewer,
            this.repository.binding.identity,
            commit,
            timestamp,
          );
        this.db
          .prepare(
            'UPDATE tasks SET status = \'in_review\', candidate_commit = ?, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(commit, timestamp, input.taskId);
        this.db.prepare('DELETE FROM leases WHERE task_id = ?').run(input.taskId);
        this.attachDispatch(operationId, {
          dispatchId: input.dispatchId,
          agentId: input.agent,
          taskId: input.taskId,
          taskVersion: Number(task['version']),
          terminalOperation: 'review.request',
          contextBundleId: input.contextBundleId,
        });
        this.event(operationId, input.agent, 'review', id, 'review_requested', {
          task_id: input.taskId,
          reviewer: this.requireAssignedRoles(input.taskId).reviewer,
          repository: this.repository.binding.identity,
          commit,
        });
        return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row;
      },
    );
  }

  submitReview(input: {
    reviewId: string;
    agent: string;
    verdict: 'approved' | 'needs_revision';
    dispatchId?: string;
    contextBundleId?: string;
  }): Row {
    return this.transaction({ name: 'review.submit', actor: input.agent, subjectType: 'review', subjectId: input.reviewId }, (operationId) => {
      this.requireAgent(input.agent);
      const review = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(input.reviewId) as Row | undefined;
      if (!review) throw new CollaborationError(`unknown review: ${input.reviewId}`, 'unknown_review');
      this.requireTaskRole(String(review['task_id']), 'reviewer', input.agent);
      if (review['requester'] === input.agent) {
        throw new CollaborationError('requester cannot review their own commit', 'self_review');
      }
      if (review['verdict'] !== 'pending') throw new CollaborationError('review already submitted', 'invalid_transition');
      // Captured before the `needs_revision` branch bumps it, so the generation compared against is
      // the one this review was dispatched for rather than the one this call produces.
      const reviewedVersion = Number(this.requireTask(String(review['task_id']))['version']);
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
      // The resolved task, not the ledger subject: this operation records `subjectType: 'review'`
      // and reaches the task through the review row, so a blind subject comparison would never
      // attach the one action whose causal edge the revision cycle most needs.
      this.attachDispatch(operationId, {
        dispatchId: input.dispatchId,
        agentId: input.agent,
        taskId: String(review['task_id']),
        taskVersion: reviewedVersion,
        terminalOperation: 'review.submit',
        contextBundleId: input.contextBundleId,
      });
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
      this.requireTaskRole(String(review['task_id']), 'reviewer', input.agent);
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

  /**
   * `onOutput` only forwards the running command's output to whoever requested the run. The exit
   * code recorded as evidence is always the one this process observed.
   */
  async runVerification(
    input: VerificationInput,
    onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
  ): Promise<Row> {
    return this.preparedAsyncTransaction(
      { name: 'verification.run', actor: input.agent, subjectType: 'task', subjectId: input.taskId },
      async () => {
        this.requireAgent(input.agent);
        this.requireTaskRole(input.taskId, 'verifier', input.agent);
        const task = this.requireIndependentVerifier(input.taskId, input.agent);
        const spec = this.verificationSpec(task, input);
        const execution = await this.repository.runAtCommit(input.commit, spec.command, onOutput);
        return { execution, spec };
      },
      (operationId, { execution, spec }) => {
        const commandArgvJson = JSON.stringify(execution.commandArgv);
        this.requireAgent(input.agent);
        this.requireTaskRole(input.taskId, 'verifier', input.agent);
        const task = this.requireIndependentVerifier(input.taskId, input.agent);
        if (spec.checkPolicyIdentity && task['check_policy_identity'] !== spec.checkPolicyIdentity) {
          throw new CollaborationError('task check policy changed during verification', 'stale_check_policy');
        }
        const id = makeId('verify');
        this.db
          .prepare(
            `INSERT INTO verifications
             (id, task_id, repository_identity, commit_sha, command, command_argv_json,
              check_id, check_policy_identity, exit_code, runner, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.taskId,
            this.repository.binding.identity,
            execution.commit,
            commandArgvJson,
            commandArgvJson,
            spec.checkId ?? null,
            spec.checkPolicyIdentity ?? null,
            execution.exitCode,
            input.agent,
            now(),
          );
        this.attachDispatch(operationId, {
          dispatchId: input.dispatchId,
          agentId: input.agent,
          taskId: input.taskId,
          taskVersion: Number(task['version']),
          terminalOperation: 'verification.run',
          contextBundleId: input.contextBundleId,
        });
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
            check_id: spec.checkId ?? null,
            check_policy_identity: spec.checkPolicyIdentity ?? null,
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

  overrideCheckPolicy(input: { taskId: string; actor: string; reason: string }): Row {
    return this.transaction(
      { name: 'check_policy.override', actor: input.actor, subjectType: 'task', subjectId: input.taskId },
      (operationId) => {
        const actor = this.requireAgent(input.actor);
        if (actor['kind'] !== 'human') {
          throw new CollaborationError('only a human can override required checks', 'human_required');
        }
        const reason = input.reason.trim();
        if (!reason) throw new CollaborationError('check policy override requires a reason', 'override_reason_required');
        const task = this.requireTask(input.taskId);
        if (task['status'] !== 'in_review' || !task['candidate_commit']) {
          throw new CollaborationError('check policy override requires a candidate in review', 'invalid_transition');
        }
        const id = makeId('override');
        const timestamp = now();
        this.db
          .prepare(
            `INSERT INTO check_policy_overrides
             (id, task_id, repository_identity, candidate_commit, check_policy_identity, actor, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.taskId,
            this.repository.binding.identity,
            String(task['candidate_commit']),
            task['check_policy_identity'] ? String(task['check_policy_identity']) : null,
            input.actor,
            reason,
            timestamp,
          );
        this.event(operationId, input.actor, 'check_policy_override', id, 'check_policy_overridden', {
          task_id: input.taskId,
          repository: this.repository.binding.identity,
          candidate_commit: task['candidate_commit'],
          check_policy_identity: task['check_policy_identity'] ?? null,
          reason,
        });
        return this.db.prepare('SELECT * FROM check_policy_overrides WHERE id = ?').get(id) as Row;
      },
    );
  }

  acceptTask(input: { taskId: string; actor: string; expectedVersion: number }): Row {
    return this.transaction({ name: 'task.accept', actor: input.actor, subjectType: 'task', subjectId: input.taskId }, (operationId) => {
      this.requireProjectActive();
      const actor = this.requireAgent(input.actor);
      if (actor['kind'] !== 'human') throw new CollaborationError('only a human can accept a task', 'human_required');
      const task = this.requireTask(input.taskId);
      const roles = this.requireAssignedRoles(input.taskId);
      if (task['version'] !== input.expectedVersion) {
        throw new CollaborationError(
          `stale task version: expected ${input.expectedVersion}, current ${String(task['version'])}`,
          'stale_version',
        );
      }
      if (task['status'] !== 'in_review' || !task['candidate_commit']) {
        throw new CollaborationError('task is not awaiting acceptance', 'invalid_transition');
      }
      // One enumeration of the gates, shared with dispatch derivation. Rejection names the first
      // unmet gate, which is the gate this method used to reject on before the list was extracted.
      const gaps = this.acceptanceGaps(task, roles);
      const firstGap = gaps[0];
      if (firstGap) throw new CollaborationError(acceptanceGapMessage(firstGap), 'acceptance_gate');
      const override = this.candidateOverride(task);
      const timestamp = now();
      this.db
        .prepare('UPDATE tasks SET status = \'accepted\', version = version + 1, updated_at = ? WHERE id = ?')
        .run(timestamp, input.taskId);
      this.event(operationId, input.actor, 'task', input.taskId, 'task_accepted', {
        commit: task['candidate_commit'],
        check_policy_identity: task['check_policy_identity'] ?? null,
        check_policy_override_id: override?.['id'] ?? null,
      });
      return this.requireTask(input.taskId);
    });
  }

  /**
   * Gathers every canonical fact the state table may read, all against one captured instant.
   *
   * Nothing here infers: each field is a row or the evaluated comparison of a row against `at`. The
   * candidate-scoped gates are read only where a candidate exists, so a `blocked` or `in_progress`
   * task never pays for the acceptance query.
   */
  private dispatchFacts(agentId: string, agentStatus: string, task: Row, at: number): DispatchFacts {
    const taskId = String(task['id']);
    const atIso = new Date(at).toISOString();
    const roleRows = this.db
      .prepare('SELECT role, agent_id FROM task_roles WHERE task_id = ?')
      .all(taskId) as Array<{ role: TaskRole; agent_id: string }>;
    const roles: Partial<Record<DispatchRole, string>> = {};
    for (const row of roleRows) roles[row.role] = row.agent_id;
    // The same evaluated predicates `claimTask()` and `requestReview()` consume, not a second copy
    // of the expiry comparison: the point of the extraction is that changing the rule there cannot
    // silently leave dispatcher authority behind.
    const lease = this.leaseFact(taskId, atIso);
    const reservation = this.reservationFact(taskId, atIso);
    const projectState = this.db
      .prepare('SELECT status FROM project_state WHERE singleton = 1')
      .get() as Row | undefined;
    const openBlockers = this.db
      .prepare("SELECT id FROM blockers WHERE task_id = ? AND status = 'open' ORDER BY created_at, id")
      .all(taskId) as Row[];

    const candidate = task['candidate_commit'] ? String(task['candidate_commit']) : null;
    const scoped = candidate !== null && task['status'] === 'in_review' && roleRows.length === 3;
    const pendingReview = scoped
      ? (this.db
          .prepare(
            `SELECT id FROM reviews
             WHERE task_id = ? AND commit_sha = ? AND verdict = 'pending'
             ORDER BY created_at, id LIMIT 1`,
          )
          .get(taskId, candidate) as Row | undefined)
      : undefined;

    return {
      agent_id: agentId,
      task_id: taskId,
      task_status: String(task['status']),
      task_version: Number(task['version']),
      repository_identity: String(task['repository_identity']),
      base_commit: String(task['base_commit']),
      candidate_commit: candidate,
      role: roleRows.find((row) => row.agent_id === agentId)?.role ?? null,
      roles,
      project_status: String(projectState?.['status'] ?? 'active'),
      agent_status: agentStatus,
      lease: lease.row
        ? {
            agent_id: String(lease.row['agent_id']),
            expires_at: String(lease.row['expires_at']),
            live: lease.live,
          }
        : null,
      reservation: reservation.row
        ? {
            agent_id: String(reservation.row['agent_id']),
            expires_at: String(reservation.row['expires_at']),
            active: reservation.active,
          }
        : null,
      open_blocker_ids: openBlockers.map((row) => String(row['id'])),
      pending_review_id: pendingReview ? String(pendingReview['id']) : null,
      gaps: scoped ? this.acceptanceGaps(task, roles as TaskRoleAssignment) : [],
      override_id: scoped ? (this.candidateOverride(task)?.['id'] as string | undefined) ?? null : null,
      check_policy_identity: task['check_policy_identity'] ? String(task['check_policy_identity']) : null,
    };
  }

  /**
   * The agent as dispatch reads it: unknown is an error, paused is a *fact*.
   *
   * `requireAgent()` throws on a paused agent, which is right for a mutation and wrong here — the
   * contract has to be able to report `blocked(agent_paused)` rather than fail to answer.
   */
  private dispatchAgent(agentId: string): Row {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Row | undefined;
    if (!agent) throw new CollaborationError(`unknown agent: ${agentId}`, 'unknown_agent');
    return agent;
  }

  private deriveOne(
    agentId: string,
    agentStatus: string,
    task: Row,
    at: number,
  ): { result: DispatchResult; basis: Record<string, unknown> } {
    return deriveDispatchResult(this.dispatchFacts(agentId, agentStatus, task, at));
  }

  /**
   * The agent's session as the envelope reports it.
   *
   * `workInFlight` is passed in rather than probed whenever the caller is an operation that has
   * already registered its own activity: an issuing request marks its session busy before it can
   * read the flag, so probing here would always see itself.
   */
  private dispatchSession(
    agentId: string,
    at: number,
    workInFlight?: boolean,
  ): DispatchEnvelope['session'] {
    const session = this.currentSession(agentId);
    if (!session) return { session_id: null, liveness: 'none', work_in_flight: false };
    const working = workInFlight ?? this.hasWorkInFlight(String(session['id']));
    return {
      session_id: String(session['id']),
      liveness: working || !this.sessionIsStale(session, at) ? 'live' : 'stale',
      work_in_flight: working,
    };
  }

  /**
   * Every obligation this agent currently holds, in a stated non-semantic order.
   *
   * The list is deliberately unranked. Canonical state offers nothing to rank two tasks by, so any
   * order the harness supplied would be scheduling. The actor chooses among its own obligations;
   * a harness choosing for it would be a supervisor.
   */
  deriveDispatch(input: { agent: string; workInFlight?: boolean }): DispatchEnvelope {
    const at = Date.now();
    const agent = this.dispatchAgent(input.agent);
    const session = this.dispatchSession(input.agent, at, input.workInFlight);
    // Non-terminal tasks this agent holds a role on, plus unassigned tasks: row 1 concerns every
    // model agent, since any of them may yet be assigned. Not every task as `no_role` noise.
    const tasks = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status NOT IN ('accepted', 'cancelled')
           AND (id IN (SELECT task_id FROM task_roles WHERE agent_id = ?)
                OR id NOT IN (SELECT task_id FROM task_roles))
         ORDER BY created_at, id`,
      )
      .all(input.agent) as Row[];
    return {
      agent_id: input.agent,
      derived_at: new Date(at).toISOString(),
      session,
      deliverable: session.liveness === 'live' && !session.work_in_flight,
      tasks: tasks.map((task) => this.deriveOne(input.agent, String(agent['status']), task, at).result),
    };
  }

  /** Explicit inspection of one pair, never filtered: `no_role` and `task_terminal` are returned. */
  deriveDispatchForTask(input: { agent: string; taskId: string }): DispatchResult {
    const at = Date.now();
    const agent = this.dispatchAgent(input.agent);
    const task = this.requireTask(input.taskId);
    return this.deriveOne(input.agent, String(agent['status']), task, at).result;
  }

  /**
   * Writes the delivery record, or returns the one already written for this exact delivery.
   *
   * Idempotency is keyed on the session while the digest covers workflow state alone. That split is
   * what lets a replacement session receive the same obligation as a new, separately attributable
   * delivery instead of silently overwriting who was told what.
   */
  /**
   * The pinned required-check policy as the bundle carries it, or null if the task has none.
   *
   * `requireTaskCheckPolicy()` throws, which is right for authority and wrong here: an unpinned or
   * corrupt policy is a fact about the task that the recipient should see, not a reason to fail the
   * delivery of an action the service already derived.
   */
  private contextCheckPolicy(task: Row): ContextCheckPolicy | null {
    if (!task['check_policy_identity'] || !task['check_policy_json']) return null;
    const parsed = parseJsonOrNull(task['check_policy_json']);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const checks = (parsed as Row)['checks'];
    if (!Array.isArray(checks)) return null;
    return {
      identity: String(task['check_policy_identity']),
      checks: checks.map((check) => {
        const entry = check as Row;
        return { id: String(entry['id']), argv: (entry['argv'] as string[]) ?? [] };
      }),
    };
  }

  /**
   * The deterministic projection of shared truth this agent receives alongside one issued action.
   *
   * Three literal predicates and a stated order, with no relevance scoring anywhere: task scope,
   * participant visibility, and recency. Every value is read from a row already committed to SQLite —
   * no clock comparison, no Git read, no file read, no subprocess — so two assemblies over identical
   * state produce identical bytes, and issuing a bundle cannot change what the next one contains.
   */
  private assembleContextBundle(params: {
    agentId: string;
    role: DispatchRole;
    roles: Partial<Record<DispatchRole, string>>;
    task: Row;
    action: DispatchActionDescriptor;
  }): ContextBundle {
    const taskId = String(params.task['id']);
    const repositoryIdentity = String(params.task['repository_identity']);

    // The lease the recipient itself holds: `requestReview()` refuses without a live one, so the
    // deadline is required by the very action being dispatched. Stored raw, never evaluated against
    // now — that comparison belongs to derivation, whose answer is already in the descriptor.
    const leaseRow = this.db
      .prepare('SELECT agent_id, expires_at FROM leases WHERE task_id = ? AND agent_id = ?')
      .get(taskId, params.agentId) as Row | undefined;

    const decisions = this.db
      .prepare(
        `SELECT id, task_id, statement, rationale, actor, created_at
         FROM decisions
         WHERE status = 'accepted' AND (task_id = ? OR task_id IS NULL)
         ORDER BY created_at, id`,
      )
      .all(taskId) as Row[];

    // Revealed only. A sealed proposal is not redacted here, it is absent: listing one would leak that
    // its author has already proposed, which is the anchoring the seal exists to prevent.
    const proposals = this.db
      .prepare(
        `SELECT id, agent_id, content, status, created_at
         FROM proposals WHERE task_id = ? AND visibility = 'revealed'
         ORDER BY created_at, id`,
      )
      .all(taskId) as Row[];

    const blockers = this.db
      .prepare(
        `SELECT id, raised_by, description, created_at
         FROM blockers WHERE task_id = ? AND status = 'open'
         ORDER BY created_at, id`,
      )
      .all(taskId) as Row[];

    // Full review history, not the current candidate alone: after `needs_revision` the candidate is
    // NULL, and the verdict that sent the implementer back is the context it most needs.
    const reviewRows = this.db
      .prepare(
        `SELECT id, requester, reviewer, commit_sha, verdict, created_at, submitted_at
         FROM reviews WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as Row[];
    const findingsFor = this.db.prepare(
      `SELECT id, raised_by, severity, location, description, status, created_at
       FROM review_findings WHERE review_id = ? ORDER BY created_at, id`,
    );
    const reviews: ContextReview[] = reviewRows.map((review) => ({
      id: String(review['id']),
      requester: String(review['requester']),
      reviewer: review['reviewer'] ? String(review['reviewer']) : null,
      commit_sha: String(review['commit_sha']),
      verdict: String(review['verdict']),
      created_at: String(review['created_at']),
      submitted_at: review['submitted_at'] ? String(review['submitted_at']) : null,
      findings: (findingsFor.all(String(review['id'])) as Row[]).map((finding) => ({
        id: String(finding['id']),
        raised_by: String(finding['raised_by']),
        severity: String(finding['severity']),
        location: finding['location'] ? String(finding['location']) : null,
        description: String(finding['description']),
        status: String(finding['status']),
        created_at: String(finding['created_at']),
      })) as ContextFinding[],
    }));

    // Evidence is selected over the review commit set. The current candidate is always a member:
    // `requestReview()` inserts the review at the commit and sets `candidate_commit` in one
    // transaction, so the set needs no second clause.
    const commitSet = [...new Set(reviewRows.map((review) => String(review['commit_sha'])))];
    const placeholders = commitSet.map(() => '?').join(', ');
    const verifications = commitSet.length
      ? (this.db
          .prepare(
            `SELECT id, commit_sha, command_argv_json, check_id, check_policy_identity,
                    exit_code, runner, created_at
             FROM verifications
             WHERE task_id = ? AND repository_identity = ? AND commit_sha IN (${placeholders})
             ORDER BY created_at, id`,
          )
          .all(taskId, repositoryIdentity, ...commitSet) as Row[])
      : [];
    const overrides = commitSet.length
      ? (this.db
          .prepare(
            `SELECT id, candidate_commit, check_policy_identity, actor, reason, created_at
             FROM check_policy_overrides
             WHERE task_id = ? AND repository_identity = ? AND candidate_commit IN (${placeholders})
             ORDER BY created_at, id`,
          )
          .all(taskId, repositoryIdentity, ...commitSet) as Row[])
      : [];

    // Task-scoped, and only where this agent is a party. Messages between the other two participants
    // are not addressed to it and must not appear merely because they share a task. Untargeted
    // messages stay out entirely, so one unscoped remark cannot move every task's bundle at once.
    const total = Number(
      (
        this.db
          .prepare(
            'SELECT count(*) AS count FROM messages WHERE task_id = ? AND (sender = ? OR recipient = ?)',
          )
          .get(taskId, params.agentId, params.agentId) as { count: number }
      ).count,
    );
    const window = this.db
      .prepare(
        `SELECT id, sender, recipient, body, created_at
         FROM messages WHERE task_id = ? AND (sender = ? OR recipient = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(taskId, params.agentId, params.agentId, CONTEXT_BUNDLE_MESSAGE_LIMIT) as Row[];
    const messages: ContextMessage[] = window
      .map((message) => ({
        id: String(message['id']),
        sender: String(message['sender']),
        recipient: String(message['recipient']),
        body: String(message['body']),
        created_at: String(message['created_at']),
      }))
      .reverse();

    return {
      agent_id: params.agentId,
      role: params.role,
      action: params.action,
      task: {
        status: String(params.task['status']),
        goal: String(params.task['goal']),
        acceptance: parseJsonOrNull(params.task['acceptance_json']),
        candidate_commit: params.task['candidate_commit'] ? String(params.task['candidate_commit']) : null,
      },
      roles: params.roles,
      lease: leaseRow
        ? { agent_id: String(leaseRow['agent_id']), expires_at: String(leaseRow['expires_at']) }
        : null,
      check_policy: this.contextCheckPolicy(params.task),
      decisions: decisions.map((decision) => ({
        id: String(decision['id']),
        task_id: decision['task_id'] ? String(decision['task_id']) : null,
        statement: String(decision['statement']),
        rationale: String(decision['rationale']),
        actor: String(decision['actor']),
        created_at: String(decision['created_at']),
      })),
      proposals: proposals.map((proposal) => ({
        id: String(proposal['id']),
        agent_id: String(proposal['agent_id']),
        content: String(proposal['content']),
        status: String(proposal['status']),
        created_at: String(proposal['created_at']),
      })),
      blockers: blockers.map((blocker) => ({
        id: String(blocker['id']),
        raised_by: String(blocker['raised_by']),
        description: String(blocker['description']),
        created_at: String(blocker['created_at']),
      })),
      reviews,
      verifications: verifications.map((verification) => ({
        id: String(verification['id']),
        commit_sha: String(verification['commit_sha']),
        command_argv: parseJsonOrNull(verification['command_argv_json']),
        check_id: verification['check_id'] ? String(verification['check_id']) : null,
        check_policy_identity: verification['check_policy_identity']
          ? String(verification['check_policy_identity'])
          : null,
        exit_code: Number(verification['exit_code']),
        runner: String(verification['runner']),
        created_at: String(verification['created_at']),
      })),
      check_policy_overrides: overrides.map((override) => ({
        id: String(override['id']),
        candidate_commit: String(override['candidate_commit']),
        check_policy_identity: override['check_policy_identity']
          ? String(override['check_policy_identity'])
          : null,
        actor: String(override['actor']),
        reason: String(override['reason']),
        created_at: String(override['created_at']),
      })),
      conversation: {
        limit: CONTEXT_BUNDLE_MESSAGE_LIMIT,
        total,
        truncated: total > messages.length,
        messages,
      },
    };
  }

  /**
   * Writes the content record, or returns the one already written for this exact content.
   *
   * Keyed on content rather than on delivery: the same context redelivered against the same dispatch is
   * the row already there, while context that moves while the obligation stands still is a new row
   * against the same dispatch. Each issuance is still recorded, by its own operation attempt and
   * `dispatch_issued` event — this table counts distinct things said, not the times they were said.
   */
  private recordContextBundle(dispatchId: string, bundle: ContextBundle, createdAt: string): Row {
    const digest = contextBundleDigest(bundle);
    const existing = this.db
      .prepare(
        `SELECT * FROM context_bundles
         WHERE dispatch_id = ? AND bundle_contract_version = ? AND bundle_digest = ?`,
      )
      .get(dispatchId, CONTEXT_BUNDLE_CONTRACT_VERSION, digest) as Row | undefined;
    if (existing) return existing;
    const id = makeId('bundle');
    this.db
      .prepare(
        `INSERT INTO context_bundles
         (id, dispatch_id, bundle_contract_version, bundle_json, bundle_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, dispatchId, CONTEXT_BUNDLE_CONTRACT_VERSION, canonicalJson(bundle), digest, createdAt);
    return this.db.prepare('SELECT * FROM context_bundles WHERE id = ?').get(id) as Row;
  }

  private recordDispatch(params: {
    agentId: string;
    sessionId: string;
    taskId: string;
    kind: DispatchActionKind;
    repositoryIdentity: string;
    baseCommit: string;
    candidateCommit: string | null;
    reviewId: string | null;
    checkIds: string[] | null;
    basis: Record<string, unknown>;
    issuedAt: string;
  }): Row {
    const digest = basisDigest(params.basis);
    const existing = this.db
      .prepare(
        `SELECT * FROM dispatches
         WHERE session_id = ? AND task_id = ? AND dispatch_contract_version = ? AND basis_digest = ?`,
      )
      .get(params.sessionId, params.taskId, DISPATCH_CONTRACT_VERSION, digest) as Row | undefined;
    if (existing) return existing;
    const id = makeId('dispatch');
    this.db
      .prepare(
        `INSERT INTO dispatches
         (id, agent_id, session_id, task_id, action_kind, terminal_operation, dispatch_contract_version,
          repository_identity, base_commit, candidate_commit, review_id, subject_json,
          basis_json, basis_digest, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.sessionId,
        params.taskId,
        params.kind,
        TERMINAL_OPERATIONS[params.kind],
        DISPATCH_CONTRACT_VERSION,
        params.repositoryIdentity,
        params.baseCommit,
        params.candidateCommit,
        params.reviewId,
        JSON.stringify(params.checkIds ? { check_ids: params.checkIds } : {}),
        canonicalJson(params.basis),
        digest,
        params.issuedAt,
      );
    return this.db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id) as Row;
  }

  /**
   * Derives one pair and, on an `action`, records the delivery.
   *
   * The operation lifecycle is written out rather than delegated to `transaction()` because an
   * `indeterminate` result is neither an accepted operation nor a thrown error: it is a harness
   * defect that must land in the ledger as a rejected attempt while still being returned to the
   * caller unchanged.
   */
  issueDispatch(input: {
    agent: string;
    taskId: string;
    session: SessionPrincipal;
    workInFlight: boolean;
  }): { result: DispatchResult; dispatch: Row | null; context_bundle: Row | null } {
    const operationId = this.startOperation({
      name: 'dispatch.issue',
      actor: input.agent,
      subjectType: 'task',
      subjectId: input.taskId,
    });
    try {
      return this.domainTransaction(() => {
        const at = Date.now();
        const agent = this.dispatchAgent(input.agent);
        const session = this.requireSessionRow(input.session.sessionId);
        if (session['status'] !== 'open' || session['agent_id'] !== input.agent) {
          throw new CollaborationError(`unknown session: ${input.session.sessionId}`, 'unknown_session');
        }
        // Both facts are required. Step 7 reports work in flight *as* liveness, so liveness alone
        // would let a second action be issued from pre-completion state while the first still runs.
        if (input.workInFlight) {
          throw new CollaborationError(
            `${input.agent} still has accepted daemon work in flight`,
            'session_busy',
          );
        }
        if (this.sessionIsStale(session, at)) {
          throw new CollaborationError(`${input.agent} has no live session to deliver to`, 'session_stale');
        }
        const task = this.requireTask(input.taskId);
        const { result, basis } = this.deriveOne(input.agent, String(agent['status']), task, at);
        if (result.kind === 'indeterminate') {
          this.completeOperation(operationId, 'rejected', 'dispatch_indeterminate');
          return { result, dispatch: null, context_bundle: null };
        }
        if (result.kind !== 'action') {
          this.completeOperation(operationId, 'accepted');
          return { result, dispatch: null, context_bundle: null };
        }
        const dispatch = this.recordDispatch({
          agentId: input.agent,
          sessionId: input.session.sessionId,
          taskId: input.taskId,
          kind: result.action.kind,
          repositoryIdentity: result.action.repository_identity,
          baseCommit: result.action.base_commit,
          candidateCommit: result.action.candidate_commit ?? null,
          reviewId: result.action.review_id ?? null,
          checkIds: result.action.check_ids ?? null,
          basis,
          issuedAt: new Date(at).toISOString(),
        });
        // Assembled from the same transaction and the same captured instant as the derivation above,
        // so the context and the obligation cannot describe two different moments. The bundle is a
        // second record rather than a second dispatch: context that moves while the obligation stands
        // still produces a new bundle against this same dispatch row.
        const roleRows = this.db
          .prepare('SELECT role, agent_id FROM task_roles WHERE task_id = ?')
          .all(input.taskId) as Array<{ role: DispatchRole; agent_id: string }>;
        const roles: Partial<Record<DispatchRole, string>> = {};
        for (const row of roleRows) roles[row.role] = row.agent_id;
        const role = roleRows.find((row) => row.agent_id === input.agent)?.role;
        // Structurally unreachable: every dispatchable action is role-gated, so an action result for an
        // agent holding no role would already be a derivation defect. Named rather than assumed away.
        if (!role) {
          throw new CollaborationError(`${input.agent} holds no role on ${input.taskId}`, 'role_required');
        }
        const bundle = this.assembleContextBundle({
          agentId: input.agent,
          role,
          roles,
          task,
          action: result.action,
        });
        const contextBundle = this.recordContextBundle(
          String(dispatch['id']),
          bundle,
          new Date(at).toISOString(),
        );
        this.event(operationId, input.agent, 'dispatch', String(dispatch['id']), 'dispatch_issued', {
          task_id: input.taskId,
          action_kind: result.action.kind,
          terminal_operation: result.action.terminal_operation,
          session_id: input.session.sessionId,
          dispatch_contract_version: DISPATCH_CONTRACT_VERSION,
          basis_digest: result.action.basis_digest,
          // Every issuance writes this event, including the one that reused both records, so the
          // ledger carries each delivery occurrence while the tables carry distinct content.
          context_bundle_id: String(contextBundle['id']),
          context_bundle_contract_version: CONTEXT_BUNDLE_CONTRACT_VERSION,
          context_bundle_digest: String(contextBundle['bundle_digest']),
        });
        this.completeOperation(operationId, 'accepted');
        return { result, dispatch, context_bundle: contextBundle };
      });
    } catch (error) {
      this.recordOperationError(operationId, error);
      throw error;
    }
  }

  /**
   * Turns "told X to do Y", "with this context", and "X did Y" into hard causal edges, when the echoed
   * ids check out.
   *
   * Validated, never trusted: an id belonging to another task or agent would otherwise manufacture
   * false provenance in the very record the pilot reads for causality. Advisory in both directions —
   * a mismatched or absent id costs provenance, never work, so this never throws.
   *
   * Session is deliberately not matched. Recovery can replace a session while the durable agent's
   * work continues, and matching it would break the edge across exactly those events.
   *
   * The workflow generation *is* matched. Agent, task, and operation are all stable across a
   * review-to-revision-to-re-claim cycle, so those three alone let a dispatch issued in an earlier
   * cycle attach to a later operation — claiming the work happened because of a dispatch whose
   * recorded basis describes a task version that has since moved on. `task_version` is the
   * generation marker the basis already carries, and it is what the terminal operation was derived
   * against, so a legitimate echo matches it and a stale one cannot.
   */
  private attachDispatch(
    operationId: string,
    params: {
      dispatchId?: string;
      contextBundleId?: string;
      agentId: string;
      taskId: string;
      /** The task version this operation observed, before the operation mutated it. */
      taskVersion: number;
      terminalOperation: TerminalOperation;
    },
  ): void {
    if (params.dispatchId && this.dispatchMatches(params.dispatchId, params)) {
      this.db
        .prepare('UPDATE operation_attempts SET dispatch_id = ? WHERE id = ?')
        .run(params.dispatchId, operationId);
    }
    if (!params.contextBundleId) return;
    // Validated through the bundle's *own* dispatch, never through the separately echoed id. The two
    // columns then stay independently truthful: one is the dispatch the caller claims to be executing,
    // the other the context it claims to have worked from. Where they disagree the record says so
    // rather than reconciling them, and neither is inferred from the other.
    const bundle = this.db
      .prepare('SELECT dispatch_id FROM context_bundles WHERE id = ?')
      .get(params.contextBundleId) as Row | undefined;
    if (!bundle || !this.dispatchMatches(String(bundle['dispatch_id']), params)) return;
    this.db
      .prepare('UPDATE operation_attempts SET context_bundle_id = ? WHERE id = ?')
      .run(params.contextBundleId, operationId);
  }

  /**
   * Whether one dispatch row can legitimately have caused this operation.
   *
   * Shared by both attachments so a bundle cannot reach the ledger through a weaker test than the
   * dispatch it belongs to. An *older bundle from the same generation* passes deliberately: an agent
   * that kept working from the context it was handed before a message arrived did exactly that, and
   * rewriting the record to the latest bundle would erase the staleness the pilot exists to measure.
   * A bundle from an earlier revision generation fails here for free, because its dispatch already
   * fails the `task_version` clause.
   */
  private dispatchMatches(
    dispatchId: string,
    params: { agentId: string; taskId: string; taskVersion: number; terminalOperation: TerminalOperation },
  ): boolean {
    const dispatch = this.db
      .prepare('SELECT agent_id, task_id, terminal_operation, basis_json FROM dispatches WHERE id = ?')
      .get(dispatchId) as Row | undefined;
    if (
      !dispatch ||
      dispatch['agent_id'] !== params.agentId ||
      dispatch['task_id'] !== params.taskId ||
      dispatch['terminal_operation'] !== params.terminalOperation
    ) {
      return false;
    }
    const basis = parseJsonOrNull(dispatch['basis_json']);
    if (!basis || typeof basis !== 'object' || Array.isArray(basis)) return false;
    return (basis as Row)['task_version'] === params.taskVersion;
  }
}
