import { createHash } from 'node:crypto';

/**
 * Which deterministic function consumed a recorded basis.
 *
 * Stored inputs only explain a past dispatch if the function that read them is also known: given the
 * same basis, one version of the state table may return `review` where another returns something
 * else. Bump this whenever the state table or the basis shape changes.
 */
export const DISPATCH_CONTRACT_VERSION = 1;

export type DispatchRole = 'implementer' | 'reviewer' | 'verifier';

/** What must happen for a task to reach `accepted`, whoever performs it. */
export type WorkflowActionKind =
  | 'assign_roles'
  | 'claim'
  | 'implement'
  | 'review'
  | 'verify'
  | 'resolve_finding'
  | 'unblock'
  | 'accept';

/**
 * The strict subset of `WorkflowActionKind` that can be addressed to one model agent.
 *
 * An action is admitted here only when canonical state shows it must occur *and* names exactly which
 * agent must perform it. `resolve_finding` and `unblock` fail the second clause — the service
 * authorizes more than one actor — so they stay workflow labels and never become dispatches.
 */
export type DispatchActionKind = 'claim' | 'implement' | 'review' | 'verify';

export type TerminalOperation = 'task.claim' | 'review.request' | 'review.submit' | 'verification.run';

/**
 * The operation that completes each action.
 *
 * `implement` terminates at `review.request` rather than at an operation of its own: canonical state
 * cannot know when an implementation is complete, so the two are one action whose observable end is
 * the review request.
 */
export const TERMINAL_OPERATIONS: Record<DispatchActionKind, TerminalOperation> = {
  claim: 'task.claim',
  implement: 'review.request',
  review: 'review.submit',
  verify: 'verification.run',
};

export type WaitingReason =
  | 'awaiting_roles'
  | 'awaiting_actor'
  | 'awaiting_human_acceptance'
  | 'awaiting_project_resume';

export type BlockedReason =
  | 'project_paused'
  | 'agent_paused'
  | 'task_blocked'
  | 'missing_check_policy'
  | 'verification_spec_required'
  | 'reservation_conflict'
  | 'lease_conflict';

export type NoneReason = 'no_role' | 'task_terminal';

/**
 * One unmet acceptance gate.
 *
 * Inverted, the list of these *is* the `in_review` dispatch table: rows 6 through 9a are a projection
 * of the same gaps onto a role rather than a second enumeration of the gates.
 */
export type AcceptanceGap =
  | { gate: 'open_blockers'; ids: string[] }
  | { gate: 'blocking_findings'; ids: string[] }
  | { gate: 'approved_review' }
  | { gate: 'independent_verification' }
  | { gate: 'check_policy_invalid' }
  | { gate: 'required_check'; check_id: string };

/** Why `acceptTask()` refuses, phrased exactly as it did before the gates were extracted. */
export function acceptanceGapMessage(gap: AcceptanceGap): string {
  switch (gap.gate) {
    case 'open_blockers':
      return 'task has open blockers';
    case 'blocking_findings':
      return 'candidate commit has open blocking review findings';
    case 'approved_review':
      return 'candidate commit lacks an approved review';
    case 'independent_verification':
      return 'candidate commit lacks passing verification from the designated verifier';
    case 'check_policy_invalid':
      return 'task lacks a valid pinned required-check policy';
    case 'required_check':
      return `candidate commit lacks passing required check: ${gap.check_id}`;
  }
}

/** No prose, no advice: every field is an identifier, a version, or a commit. */
export interface DispatchActionDescriptor {
  kind: DispatchActionKind;
  terminal_operation: TerminalOperation;
  task_id: string;
  task_version: number;
  repository_identity: string;
  base_commit: string;
  candidate_commit?: string;
  review_id?: string;
  check_ids?: string[];
  dispatch_contract_version: number;
  basis_digest: string;
}

export type DispatchResult =
  | { kind: 'action'; task_id: string; action: DispatchActionDescriptor }
  | {
      kind: 'waiting';
      task_id: string;
      actor: string | null;
      action_kind: WorkflowActionKind;
      reason: WaitingReason;
    }
  | {
      kind: 'blocked';
      task_id: string;
      action_kind: DispatchActionKind;
      reason: BlockedReason;
      refs: Record<string, unknown>;
    }
  | { kind: 'none'; task_id: string; reason: NoneReason }
  | {
      kind: 'indeterminate';
      task_id: string;
      candidates: DispatchActionKind[];
      basis: Record<string, unknown>;
    };

export interface DispatchEnvelope {
  agent_id: string;
  derived_at: string;
  session: { session_id: string | null; liveness: 'live' | 'stale' | 'none'; work_in_flight: boolean };
  /** Issuance requires both liveness and quiet: step 7 reports work in flight *as* liveness. */
  deliverable: boolean;
  /** Ordered by (tasks.created_at, tasks.id). ORDER IS NOT PRIORITY. */
  tasks: DispatchResult[];
}

/** A lease row as the derivation reads it, with the expiry comparison already evaluated. */
export interface LeaseFact {
  agent_id: string;
  expires_at: string;
  live: boolean;
}

export interface ReservationFact {
  agent_id: string;
  expires_at: string;
  active: boolean;
}

/**
 * Every canonical fact the state table may consult, gathered at one instant.
 *
 * Expiry is a pure timestamp comparison with no backing mutation, so a derivation that read the
 * clock twice could assemble a basis that never existed at any single instant. The `live` and
 * `active` flags are therefore evaluated once, by the caller, against the instant it captured.
 */
export interface DispatchFacts {
  agent_id: string;
  task_id: string;
  task_status: string;
  task_version: number;
  repository_identity: string;
  base_commit: string;
  candidate_commit: string | null;
  role: DispatchRole | null;
  roles: Partial<Record<DispatchRole, string>>;
  project_status: string;
  agent_status: string;
  lease: LeaseFact | null;
  reservation: ReservationFact | null;
  open_blocker_ids: string[];
  pending_review_id: string | null;
  /** Empty unless the task is `in_review` with a candidate: the gates are candidate-scoped. */
  gaps: AcceptanceGap[];
  override_id: string | null;
  check_policy_identity: string | null;
}

/**
 * Deterministic serialization for the digest: object keys sorted, arrays left in their stated order.
 *
 * Array order is meaningful everywhere it appears — gaps follow the acceptance-gate order and check
 * ids follow policy order — so sorting them would erase a fact rather than normalize one.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function basisDigest(basis: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(basis)).digest('hex');
}

type Derivation = { result: DispatchResult; basis: Record<string, unknown> };

function leaseBasis(lease: LeaseFact | null): unknown {
  // The evaluated fact is stored, not just the timestamp: `expires_at` alone does not tell a later
  // reader which side of the boundary the dispatcher was on.
  return lease ? { agent_id: lease.agent_id, expires_at: lease.expires_at, live: lease.live } : null;
}

function reservationBasis(reservation: ReservationFact | null): unknown {
  return reservation
    ? { agent_id: reservation.agent_id, expires_at: reservation.expires_at, active: reservation.active }
    : null;
}

function waiting(
  taskId: string,
  actor: string | null,
  actionKind: WorkflowActionKind,
  reason: WaitingReason,
): DispatchResult {
  return { kind: 'waiting', task_id: taskId, actor, action_kind: actionKind, reason };
}

function blocked(
  taskId: string,
  actionKind: DispatchActionKind,
  reason: BlockedReason,
  refs: Record<string, unknown> = {},
): DispatchResult {
  return { kind: 'blocked', task_id: taskId, action_kind: actionKind, reason, refs };
}

function action(
  facts: DispatchFacts,
  kind: DispatchActionKind,
  basis: Record<string, unknown>,
  extra: { candidate_commit?: string; review_id?: string; check_ids?: string[] } = {},
): DispatchResult {
  return {
    kind: 'action',
    task_id: facts.task_id,
    action: {
      kind,
      terminal_operation: TERMINAL_OPERATIONS[kind],
      task_id: facts.task_id,
      task_version: facts.task_version,
      repository_identity: facts.repository_identity,
      base_commit: facts.base_commit,
      ...extra,
      dispatch_contract_version: DISPATCH_CONTRACT_VERSION,
      basis_digest: basisDigest(basis),
    },
  };
}

function indeterminate(
  facts: DispatchFacts,
  basis: Record<string, unknown>,
  candidates: DispatchActionKind[] = [],
): Derivation {
  return { result: { kind: 'indeterminate', task_id: facts.task_id, candidates, basis }, basis };
}

/**
 * The claim branch, in the order `claimTask()` actually rejects.
 *
 * C1 and C2 are defensive guards *within* this branch rather than global precedence rules. Reaching
 * here already means claim is the derived obligation, so a corrupted reservation or lease on a
 * blocked or in-review task cannot surface as a claim conflict the service would never reach.
 * Pause is tested first because `requireProjectActive()` and `requireAgent()` precede both conflict
 * checks in `claimTask()`; deriving a conflict code the service would not return would break the
 * one-way guarantee that a dispatched action is permitted now.
 */
function claimBranch(facts: DispatchFacts): Derivation {
  const basis = {
    task_status: facts.task_status,
    task_version: facts.task_version,
    role: facts.role,
    project_status: facts.project_status,
    agent_status: facts.agent_status,
    lease: leaseBasis(facts.lease),
    reservation: reservationBasis(facts.reservation),
  };
  if (facts.project_status !== 'active') {
    return { result: blocked(facts.task_id, 'claim', 'project_paused'), basis };
  }
  if (facts.agent_status !== 'active') {
    return { result: blocked(facts.task_id, 'claim', 'agent_paused'), basis };
  }
  if (facts.reservation?.active && facts.reservation.agent_id !== facts.agent_id) {
    return {
      result: blocked(facts.task_id, 'claim', 'reservation_conflict', {
        reserved_for: facts.reservation.agent_id,
      }),
      basis,
    };
  }
  if (facts.lease?.live && facts.lease.agent_id !== facts.agent_id) {
    return {
      result: blocked(facts.task_id, 'claim', 'lease_conflict', { lease_holder: facts.lease.agent_id }),
      basis,
    };
  }
  return { result: action(facts, 'claim', basis), basis };
}

/** Row 3. `requestReview()` does not consult project pause, so neither does this. */
function implementBranch(facts: DispatchFacts): Derivation {
  const basis = {
    task_status: facts.task_status,
    task_version: facts.task_version,
    role: facts.role,
    agent_status: facts.agent_status,
    lease: leaseBasis(facts.lease),
  };
  if (facts.agent_status !== 'active') {
    return { result: blocked(facts.task_id, 'implement', 'agent_paused'), basis };
  }
  return { result: action(facts, 'implement', basis), basis };
}

/** Rows 6 through 9a, all reading the one `acceptanceGaps()` list. */
function inReviewBranch(facts: DispatchFacts): Derivation {
  const blockingFindingIds =
    facts.gaps.find((gap) => gap.gate === 'blocking_findings')?.ids ?? [];
  const requiredCheckIds = facts.gaps
    .filter((gap) => gap.gate === 'required_check')
    .map((gap) => gap.check_id);
  const checkPolicyInvalid = facts.gaps.some((gap) => gap.gate === 'check_policy_invalid');
  const independentVerificationMissing = facts.gaps.some((gap) => gap.gate === 'independent_verification');
  const verifierWork = independentVerificationMissing || requiredCheckIds.length > 0 || checkPolicyInvalid;

  const basis = {
    task_status: facts.task_status,
    task_version: facts.task_version,
    role: facts.role,
    project_status: facts.project_status,
    agent_status: facts.agent_status,
    candidate_commit: facts.candidate_commit,
    pending_review_id: facts.pending_review_id,
    blocking_finding_ids: blockingFindingIds,
    gaps: facts.gaps,
    override_id: facts.override_id,
    check_policy_identity: facts.check_policy_identity,
  };

  // A candidate is the premise of every row here; without one the table cannot reduce.
  if (!facts.candidate_commit) return indeterminate(facts, basis);

  const acceptanceRow = (): DispatchResult =>
    facts.project_status === 'active'
      ? waiting(facts.task_id, 'human', 'accept', 'awaiting_human_acceptance')
      : waiting(facts.task_id, 'human', 'accept', 'awaiting_project_resume');

  if (facts.role === 'verifier') {
    // Rows 6 and 7 are concurrent and address different agents, so the verifier reads row 7 first.
    if (verifierWork) {
      if (facts.agent_status !== 'active') {
        return { result: blocked(facts.task_id, 'verify', 'agent_paused'), basis };
      }
      if (checkPolicyInvalid) {
        return { result: blocked(facts.task_id, 'verify', 'missing_check_policy'), basis };
      }
      if (facts.override_id) {
        // Row 7a: the waived checks are gone, the independent-verifier evidence is not, and the
        // pinned policy no longer supplies a command for it. The kind is certain; only argv is not.
        return {
          result: blocked(facts.task_id, 'verify', 'verification_spec_required', {
            override_id: facts.override_id,
          }),
          basis,
        };
      }
      if (requiredCheckIds.length === 0) return indeterminate(facts, basis, ['verify']);
      return {
        result: action(facts, 'verify', basis, {
          candidate_commit: facts.candidate_commit,
          check_ids: requiredCheckIds,
        }),
        basis,
      };
    }
    if (facts.pending_review_id) return { result: waiting(facts.task_id, facts.roles.reviewer ?? null, 'review', 'awaiting_actor'), basis };
    if (blockingFindingIds.length > 0) {
      return { result: waiting(facts.task_id, null, 'resolve_finding', 'awaiting_actor'), basis };
    }
    if (facts.gaps.length === 0) return { result: acceptanceRow(), basis };
    return indeterminate(facts, basis);
  }

  if (facts.role === 'reviewer') {
    if (facts.pending_review_id) {
      if (facts.agent_status !== 'active') {
        return { result: blocked(facts.task_id, 'review', 'agent_paused'), basis };
      }
      return {
        result: action(facts, 'review', basis, {
          candidate_commit: facts.candidate_commit,
          review_id: facts.pending_review_id,
        }),
        basis,
      };
    }
    if (blockingFindingIds.length > 0) {
      return { result: waiting(facts.task_id, null, 'resolve_finding', 'awaiting_actor'), basis };
    }
    if (verifierWork) {
      return { result: waiting(facts.task_id, facts.roles.verifier ?? null, 'verify', 'awaiting_actor'), basis };
    }
    if (facts.gaps.length === 0) return { result: acceptanceRow(), basis };
    return indeterminate(facts, basis);
  }

  // Implementer: row 6 precedes row 7, per the stated first-match-wins order.
  if (facts.pending_review_id) {
    return { result: waiting(facts.task_id, facts.roles.reviewer ?? null, 'review', 'awaiting_actor'), basis };
  }
  if (blockingFindingIds.length > 0) {
    return { result: waiting(facts.task_id, null, 'resolve_finding', 'awaiting_actor'), basis };
  }
  if (verifierWork) {
    return { result: waiting(facts.task_id, facts.roles.verifier ?? null, 'verify', 'awaiting_actor'), basis };
  }
  if (facts.gaps.length === 0) return { result: acceptanceRow(), basis };
  return indeterminate(facts, basis);
}

/**
 * The state table, read per (agent, task).
 *
 * The dispatcher derives; it does not decide. Where canonical state does not yield exactly one
 * permitted action, the result says so — `waiting` when the obligation is someone else's, `blocked`
 * when it is this agent's but forbidden now, `indeterminate` when the table itself failed to reduce.
 * No branch invents an addressee, and none consults anything outside `facts`.
 */
export function deriveDispatchResult(facts: DispatchFacts): Derivation {
  const taskId = facts.task_id;
  const roleCount = Object.keys(facts.roles).length;
  const coreBasis = {
    task_status: facts.task_status,
    task_version: facts.task_version,
    role: facts.role,
  };

  // Row 10, before everything: a terminal task has no obligations left to address.
  if (facts.task_status === 'accepted' || facts.task_status === 'cancelled') {
    return { result: { kind: 'none', task_id: taskId, reason: 'task_terminal' }, basis: coreBasis };
  }
  // Row 1, before role membership: the workflow waits on the human, and this agent may yet be assigned.
  if (roleCount === 0) {
    return {
      result: waiting(taskId, 'human', 'assign_roles', 'awaiting_roles'),
      basis: { ...coreBasis, roles_assigned: false },
    };
  }
  // Roles are inserted as one atomic set, so a partial set is a harness defect rather than a state.
  if (roleCount !== 3) return indeterminate(facts, { ...coreBasis, role_count: roleCount });
  // Row 11.
  if (!facts.role) {
    return { result: { kind: 'none', task_id: taskId, reason: 'no_role' }, basis: coreBasis };
  }

  const ownLease = facts.lease?.live === true && facts.lease.agent_id === facts.roles.implementer;

  switch (facts.task_status) {
    case 'open':
      // Row 2.
      if (facts.role === 'implementer') return claimBranch(facts);
      return {
        result: waiting(taskId, facts.roles.implementer ?? null, 'claim', 'awaiting_actor'),
        basis: { ...coreBasis, lease: leaseBasis(facts.lease) },
      };
    case 'in_progress':
      // Rows 3 and 4, discriminated by the one captured lease fact.
      if (ownLease) {
        if (facts.role === 'implementer') return implementBranch(facts);
        return {
          result: waiting(taskId, facts.roles.implementer ?? null, 'implement', 'awaiting_actor'),
          basis: { ...coreBasis, lease: leaseBasis(facts.lease) },
        };
      }
      if (facts.role === 'implementer') return claimBranch(facts);
      return {
        result: waiting(taskId, facts.roles.implementer ?? null, 'claim', 'awaiting_actor'),
        basis: { ...coreBasis, lease: leaseBasis(facts.lease) },
      };
    case 'blocked': {
      // Rows 5 and 5a. `addBlocker()` never touches `leases`, so the lease survives the blocked
      // interval: naming the kind is what tells the implementer whether clearing the blocker returns
      // them to work directly or requires a re-claim first.
      const blockerIds = facts.open_blocker_ids;
      const basis = {
        ...coreBasis,
        lease: leaseBasis(facts.lease),
        open_blocker_ids: blockerIds,
      };
      if (facts.role === 'implementer') {
        return {
          result: blocked(taskId, ownLease ? 'implement' : 'claim', 'task_blocked', { blocker_ids: blockerIds }),
          basis,
        };
      }
      // `resolveBlocker()` has no authority rule at all, so canonical state cannot address this.
      return { result: waiting(taskId, null, 'unblock', 'awaiting_actor'), basis };
    }
    case 'in_review':
      return inReviewBranch(facts);
    default:
      return indeterminate(facts, coreBasis);
  }
}
