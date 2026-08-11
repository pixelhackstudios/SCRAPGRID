import type { GitRepository } from './git.js';
import { sessionDescriptorPath, writeSessionDescriptor } from './runtime.js';
import { CollaborationError, type CollaborationService } from './service.js';

export type OutputStream = 'stdout' | 'stderr';

export interface DaemonSummary {
  url: string;
  pid: number;
  repository_identity: string;
  schema_version: number;
  started_at: string;
}

/**
 * Who the daemon has authenticated, as distinct from whom the request body claims to be.
 *
 * `control` is the local bootstrap credential the daemon publishes in its own descriptor. It
 * establishes and recovers sessions and carries human authority; it deliberately cannot act as any
 * model, or session identity would be decorative.
 */
export type OperationPrincipal =
  | { kind: 'control'; agentId: 'human' }
  | { kind: 'session'; agentId: string; sessionId: string };

/**
 * Which sessions currently have daemon work the daemon has accepted but not finished.
 *
 * `ActivityGate` already answers this for the daemon as a whole so shutdown can outlast a socket.
 * Recovery needs the same question asked of one session, and nothing more: this is presence
 * bookkeeping, not a scheduler.
 */
export interface SessionActivity {
  begin(sessionId: string): void;
  end(sessionId: string): void;
  busy(sessionId: string): boolean;
}

export interface OperationContext {
  service: CollaborationService;
  repository: GitRepository;
  daemon: DaemonSummary;
  principal: OperationPrincipal;
  sessionActivity?: SessionActivity;
  /**
   * Whether this session had work in flight *before* this request registered its own.
   *
   * A mutating request marks its session busy before the operation body runs, so an operation that
   * probed the live flag would always see itself. Sampling belongs to the transport, which is the
   * only layer that observes the moment before registration.
   */
  sessionWorkInFlight?: boolean;
  onOutput?: (stream: OutputStream, data: string) => void;
}

export interface OperationDefinition {
  /** Read operations bypass the ledger, matching the service methods they call. */
  mutating: boolean;
  /** Input key carrying a claimed collaboration identity, which must match the principal. */
  identity?: string;
  /** Requires the local control credential rather than a model session. */
  control?: boolean;
  /** Requires a model session rather than the control credential. */
  session?: boolean;
  /**
   * Input key carrying a claimed identity that control may inspect on behalf of any agent, and a
   * session may claim only for itself.
   *
   * `control` and `identity` cannot express this between them: `control: true` rejects sessions
   * outright, while `identity` compares the claim against `principal.agentId`, which is the literal
   * `'human'` for a control principal — so control could never inspect a model agent.
   */
  identityOrControl?: string;
  invoke(context: OperationContext, input: Record<string, unknown>): unknown | Promise<unknown>;
}

/**
 * The session boundary, applied before any operation runs.
 *
 * This is an additional gate, not a replacement for `CollaborationService` authority: passing here
 * only proves the caller is who it says it is. Whether that identity may perform the operation is
 * still decided by the service.
 */
export function authorizeOperation(
  definition: OperationDefinition,
  principal: OperationPrincipal,
  input: Record<string, unknown>,
): void {
  if (definition.control && principal.kind !== 'control') {
    throw new CollaborationError(
      'this operation requires the local control credential',
      'control_credential_required',
    );
  }
  if (definition.session && principal.kind !== 'session') {
    throw new CollaborationError('this operation requires a model session', 'session_required');
  }
  if (definition.identityOrControl && principal.kind !== 'control') {
    requireClaimedIdentity(input, definition.identityOrControl, principal);
  }
  if (!definition.identity) return;
  requireClaimedIdentity(input, definition.identity, principal);
}

function requireClaimedIdentity(
  input: Record<string, unknown>,
  key: string,
  principal: OperationPrincipal,
): void {
  const claimed = input[key];
  // A malformed claim is left to the operation's own input validation, which reports it precisely.
  if (typeof claimed !== 'string' || claimed.length === 0) return;
  if (claimed !== principal.agentId) {
    throw new CollaborationError(
      `authenticated as ${principal.agentId}, but this operation claims ${claimed}`,
      'identity_mismatch',
    );
  }
}

/**
 * Publishes a freshly issued credential into the model's own worktree.
 *
 * The write happens after the session row commits, so a delivery failure retires the session it
 * could not deliver rather than leaving a credential nobody holds.
 */
function deliverSession(
  service: CollaborationService,
  agentId: string,
  issued: { session: Record<string, unknown>; token: string },
): Record<string, unknown> {
  const worktree = service.managedWorktreePath(agentId);
  let descriptorPath: string | null = null;
  if (worktree) {
    descriptorPath = sessionDescriptorPath(worktree);
    try {
      writeSessionDescriptor(descriptorPath, {
        session_id: String(issued.session['id']),
        agent_id: agentId,
        token: issued.token,
        issued_at: String(issued.session['created_at']),
      });
    } catch (error) {
      service.closeSession({ agentId, reason: 'session credential could not be delivered' });
      throw new CollaborationError(
        `session credential could not be written to ${descriptorPath}: ${error instanceof Error ? error.message : String(error)}`,
        'session_delivery_failed',
      );
    }
  }
  return { session: issued.session, token: issued.token, descriptor_path: descriptorPath };
}

function invalid(message: string): CollaborationError {
  return new CollaborationError(message, 'invalid_operation_input');
}

export function operationInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('operation input must be an object');
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${key} must be a non-empty string`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${key} must be a non-empty string`);
  return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

function nonNegativeInteger(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${key} must be a non-negative integer`);
  }
  return value;
}

function enumValue<const T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = requiredString(input, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(`${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export const OPERATIONS: Record<string, OperationDefinition> = {
  'daemon.info': {
    mutating: false,
    invoke: ({ service, repository, daemon }) => ({
      daemon,
      repository: repository.binding,
      agents: service.listAgents(),
    }),
  },
  status: {
    mutating: false,
    invoke: ({ service }) => service.status(),
  },
  snapshot: {
    mutating: false,
    invoke: ({ service }) => service.snapshot(),
  },
  'agents.list': {
    mutating: false,
    invoke: ({ service }) => service.listAgents(),
  },
  'session.open': {
    mutating: true,
    control: true,
    invoke: ({ service }, input) => {
      const agentId = requiredString(input, 'agent');
      return deliverSession(service, agentId, service.openSession(agentId));
    },
  },
  'session.replace': {
    mutating: true,
    control: true,
    invoke: ({ service }, input) => {
      const agentId = requiredString(input, 'agent');
      const replaced = service.replaceSession({ agentId, reason: requiredString(input, 'reason') });
      return { ...deliverSession(service, agentId, replaced), replaced_session_id: replaced.replaced };
    },
  },
  'session.close': {
    mutating: true,
    control: true,
    invoke: ({ service }, input) =>
      service.closeSession({
        agentId: requiredString(input, 'agent'),
        reason: optionalString(input, 'reason') ?? 'closed',
      }),
  },
  'session.heartbeat': {
    mutating: false,
    session: true,
    invoke: ({ service, principal }) => {
      if (principal.kind !== 'session') throw new CollaborationError('no session principal', 'session_required');
      return service.heartbeat(principal);
    },
  },
  sync: {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) => service.sync(requiredString(input, 'agent'), nonNegativeInteger(input, 'after', 0)),
  },
  'worktree.bootstrap': {
    mutating: true,
    control: true,
    invoke: ({ service, repository }, input) =>
      service.bootstrapWorktrees({
        rootPath: optionalString(input, 'rootPath') ?? `${repository.binding.rootPath}/worktrees`,
        baseCommit: optionalString(input, 'baseCommit') ?? repository.headCommit(),
      }),
  },
  'task.create': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.createTask({
        id: requiredString(input, 'id'),
        goal: requiredString(input, 'goal'),
        acceptance: stringArray(input, 'acceptance'),
        actor: requiredString(input, 'actor'),
      }),
  },
  'task.assign_roles': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.assignTaskRoles({
        taskId: requiredString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        implementer: requiredString(input, 'implementer'),
        reviewer: requiredString(input, 'reviewer'),
        verifier: requiredString(input, 'verifier'),
      }),
  },
  'task.claim': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.claimTask({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        expectedVersion: nonNegativeInteger(input, 'expectedVersion'),
        ttlSeconds: nonNegativeInteger(input, 'ttlSeconds', 900),
        dispatchId: optionalString(input, 'dispatchId'),
        contextBundleId: optionalString(input, 'contextBundleId'),
      }),
  },
  'task.accept': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.acceptTask({
        taskId: requiredString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        expectedVersion: nonNegativeInteger(input, 'expectedVersion'),
      }),
  },
  'proposal.submit': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.submitProposal({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        content: requiredString(input, 'content'),
      }),
  },
  'proposal.reveal': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.revealProposals(requiredString(input, 'taskId'), requiredString(input, 'actor')),
  },
  'decision.propose': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.proposeDecision({
        taskId: optionalString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        statement: requiredString(input, 'statement'),
        rationale: requiredString(input, 'rationale'),
      }),
  },
  'decision.accept': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.acceptDecision(requiredString(input, 'decisionId'), requiredString(input, 'actor')),
  },
  'message.send': {
    mutating: true,
    identity: 'from',
    invoke: ({ service }, input) =>
      service.sendMessage({
        from: requiredString(input, 'from'),
        to: requiredString(input, 'to'),
        taskId: optionalString(input, 'taskId'),
        body: requiredString(input, 'body'),
      }),
  },
  'blocker.add': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.addBlocker({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        description: requiredString(input, 'description'),
      }),
  },
  'blocker.resolve': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.resolveBlocker(requiredString(input, 'blockerId'), requiredString(input, 'agent')),
  },
  'review.request': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.requestReview({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        commit: requiredString(input, 'commit'),
        dispatchId: optionalString(input, 'dispatchId'),
        contextBundleId: optionalString(input, 'contextBundleId'),
      }),
  },
  'review.submit': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.submitReview({
        reviewId: requiredString(input, 'reviewId'),
        agent: requiredString(input, 'agent'),
        verdict: enumValue(input, 'verdict', ['approved', 'needs_revision']),
        dispatchId: optionalString(input, 'dispatchId'),
        contextBundleId: optionalString(input, 'contextBundleId'),
      }),
  },
  'finding.add': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.addReviewFinding({
        reviewId: requiredString(input, 'reviewId'),
        agent: requiredString(input, 'agent'),
        severity: enumValue(input, 'severity', ['blocking', 'non_blocking']),
        description: requiredString(input, 'description'),
        location: optionalString(input, 'location'),
      }),
  },
  'finding.resolve': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service }, input) =>
      service.resolveReviewFinding(requiredString(input, 'findingId'), requiredString(input, 'agent')),
  },
  'check_policy.override': {
    mutating: true,
    identity: 'actor',
    invoke: ({ service }, input) =>
      service.overrideCheckPolicy({
        taskId: requiredString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        reason: requiredString(input, 'reason'),
      }),
  },
  'verification.run': {
    mutating: true,
    identity: 'agent',
    invoke: ({ service, onOutput }, input) => {
      const checkId = optionalString(input, 'checkId');
      const command = optionalStringArray(input, 'command');
      if (Boolean(checkId) === Boolean(command)) {
        throw invalid('verification requires exactly one of checkId or command');
      }
      return service.runVerification(
        {
          taskId: requiredString(input, 'taskId'),
          agent: requiredString(input, 'agent'),
          commit: requiredString(input, 'commit'),
          checkId,
          command,
          dispatchId: optionalString(input, 'dispatchId'),
          contextBundleId: optionalString(input, 'contextBundleId'),
        },
        onOutput,
      );
    },
  },
  /**
   * Read-only. Writes nothing and leaves no ledger entry, matching the other read operations.
   *
   * There is deliberately no `dispatch.next`: an operation asked for *the* next action would have to
   * rank an agent's tasks, and canonical state offers nothing to rank them by. The actor reads its
   * unranked obligations here and names the one it takes up in `dispatch.issue`.
   */
  'dispatch.derive': {
    mutating: false,
    identityOrControl: 'agent',
    invoke: ({ service, principal, sessionWorkInFlight }, input) => {
      const agent = requiredString(input, 'agent');
      const task = optionalString(input, 'task');
      if (task !== undefined) return service.deriveDispatchForTask({ agent, taskId: task });
      return service.deriveDispatch({
        agent,
        workInFlight: principal.kind === 'session' && principal.agentId === agent ? sessionWorkInFlight : undefined,
      });
    },
  },
  /** Mutating and session-bound. `task` is required: the harness never picks which one. */
  'dispatch.issue': {
    mutating: true,
    session: true,
    identity: 'agent',
    invoke: ({ service, principal, sessionWorkInFlight }, input) => {
      if (principal.kind !== 'session') throw new CollaborationError('no session principal', 'session_required');
      return service.issueDispatch({
        agent: requiredString(input, 'agent'),
        taskId: requiredString(input, 'task'),
        session: principal,
        workInFlight: sessionWorkInFlight ?? false,
      });
    },
  },
};

export function requireOperation(name: string): OperationDefinition {
  const definition = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
  if (!definition) throw new CollaborationError(`unknown operation: ${name}`, 'unknown_operation');
  return definition;
}
