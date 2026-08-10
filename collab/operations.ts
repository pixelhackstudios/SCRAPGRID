import type { GitRepository } from './git.js';
import { CollaborationError, type CollaborationService } from './service.js';

export type OutputStream = 'stdout' | 'stderr';

export interface DaemonSummary {
  url: string;
  pid: number;
  repository_identity: string;
  schema_version: number;
  started_at: string;
}

export interface OperationContext {
  service: CollaborationService;
  repository: GitRepository;
  daemon: DaemonSummary;
  onOutput?: (stream: OutputStream, data: string) => void;
}

export interface OperationDefinition {
  /** Read operations bypass the ledger, matching the service methods they call. */
  mutating: boolean;
  invoke(context: OperationContext, input: Record<string, unknown>): unknown | Promise<unknown>;
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
  sync: {
    mutating: true,
    invoke: ({ service }, input) => service.sync(requiredString(input, 'agent'), nonNegativeInteger(input, 'after', 0)),
  },
  'worktree.bootstrap': {
    mutating: true,
    invoke: ({ service, repository }, input) =>
      service.bootstrapWorktrees({
        rootPath: optionalString(input, 'rootPath') ?? `${repository.binding.rootPath}/worktrees`,
        baseCommit: optionalString(input, 'baseCommit') ?? repository.headCommit(),
      }),
  },
  'task.create': {
    mutating: true,
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
    invoke: ({ service }, input) =>
      service.claimTask({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        expectedVersion: nonNegativeInteger(input, 'expectedVersion'),
        ttlSeconds: nonNegativeInteger(input, 'ttlSeconds', 900),
      }),
  },
  'task.accept': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.acceptTask({
        taskId: requiredString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        expectedVersion: nonNegativeInteger(input, 'expectedVersion'),
      }),
  },
  'proposal.submit': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.submitProposal({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        content: requiredString(input, 'content'),
      }),
  },
  'proposal.reveal': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.revealProposals(requiredString(input, 'taskId'), requiredString(input, 'actor')),
  },
  'decision.propose': {
    mutating: true,
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
    invoke: ({ service }, input) =>
      service.acceptDecision(requiredString(input, 'decisionId'), requiredString(input, 'actor')),
  },
  'message.send': {
    mutating: true,
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
    invoke: ({ service }, input) =>
      service.addBlocker({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        description: requiredString(input, 'description'),
      }),
  },
  'blocker.resolve': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.resolveBlocker(requiredString(input, 'blockerId'), requiredString(input, 'agent')),
  },
  'review.request': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.requestReview({
        taskId: requiredString(input, 'taskId'),
        agent: requiredString(input, 'agent'),
        commit: requiredString(input, 'commit'),
      }),
  },
  'review.submit': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.submitReview({
        reviewId: requiredString(input, 'reviewId'),
        agent: requiredString(input, 'agent'),
        verdict: enumValue(input, 'verdict', ['approved', 'needs_revision']),
      }),
  },
  'finding.add': {
    mutating: true,
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
    invoke: ({ service }, input) =>
      service.resolveReviewFinding(requiredString(input, 'findingId'), requiredString(input, 'agent')),
  },
  'check_policy.override': {
    mutating: true,
    invoke: ({ service }, input) =>
      service.overrideCheckPolicy({
        taskId: requiredString(input, 'taskId'),
        actor: requiredString(input, 'actor'),
        reason: requiredString(input, 'reason'),
      }),
  },
  'verification.run': {
    mutating: true,
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
        },
        onOutput,
      );
    },
  },
};

export function requireOperation(name: string): OperationDefinition {
  const definition = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
  if (!definition) throw new CollaborationError(`unknown operation: ${name}`, 'unknown_operation');
  return definition;
}
