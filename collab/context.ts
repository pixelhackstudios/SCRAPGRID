import { createHash } from 'node:crypto';
import { canonicalJson, type DispatchActionDescriptor, type DispatchRole } from './dispatch.js';

/**
 * Which deterministic selection produced a recorded bundle.
 *
 * Stored content only explains a past delivery if the function that selected it is also known: the same
 * canonical state yields different bundles under different visibility, ordering, or bound rules. Bump this
 * whenever the included tables, the visibility predicates, the ordering, the message cap, or the shape
 * changes — a formatting change that could not alter the digest is not a change.
 */
export const CONTEXT_BUNDLE_CONTRACT_VERSION = 1;

/**
 * The one cap in the contract, and it applies to one class.
 *
 * Durable coordination truth — decisions, blockers, reviews, findings, evidence — is uncapped, because
 * withholding an accepted decision is a worse failure than a long bundle. Conversation is bounded instead,
 * which is what gives the promotion rule its teeth: a message that must survive should have become a
 * finding, a blocker, a proposal, or a decision. The cap is part of the selection, not a presentation
 * detail, so changing it changes what a stored bundle would have been.
 */
export const CONTEXT_BUNDLE_MESSAGE_LIMIT = 50;

export interface ContextTask {
  status: string;
  goal: string;
  acceptance: unknown;
  candidate_commit: string | null;
}

export interface ContextLease {
  agent_id: string;
  expires_at: string;
}

export interface ContextCheckPolicy {
  identity: string;
  checks: Array<{ id: string; argv: string[] }>;
}

export interface ContextDecision {
  id: string;
  task_id: string | null;
  statement: string;
  rationale: string;
  actor: string;
  created_at: string;
}

export interface ContextProposal {
  id: string;
  agent_id: string;
  content: string;
  status: string;
  created_at: string;
}

export interface ContextBlocker {
  id: string;
  raised_by: string;
  description: string;
  created_at: string;
}

export interface ContextFinding {
  id: string;
  raised_by: string;
  severity: string;
  location: string | null;
  description: string;
  status: string;
  created_at: string;
}

export interface ContextReview {
  id: string;
  requester: string;
  reviewer: string | null;
  commit_sha: string;
  verdict: string;
  created_at: string;
  submitted_at: string | null;
  findings: ContextFinding[];
}

export interface ContextVerification {
  id: string;
  commit_sha: string;
  command_argv: unknown;
  check_id: string | null;
  check_policy_identity: string | null;
  exit_code: number;
  runner: string;
  created_at: string;
}

export interface ContextOverride {
  id: string;
  candidate_commit: string;
  check_policy_identity: string | null;
  actor: string;
  reason: string;
  created_at: string;
}

export interface ContextMessage {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  created_at: string;
}

export interface ContextConversation {
  limit: number;
  total: number;
  truncated: boolean;
  messages: ContextMessage[];
}

/**
 * What one agent is given alongside one already-issued dispatch.
 *
 * No field appears twice: the action descriptor is the single statement of every fact it already carries,
 * which is why `task` omits the id, the version, the repository identity, and the base commit. Reusing the
 * descriptor verbatim also settles a class of mistakes for free — it structurally cannot carry a session
 * id, a dispatch row id, or an issuance timestamp, because step 8 already refused to put them there.
 *
 * Nothing here is derived from reading the clock at assembly time, and nothing here is read from Git: the
 * commits named by the descriptor and the review history are the reference to artifact truth, and the
 * agents hold real worktrees to resolve them with.
 */
export interface ContextBundle {
  agent_id: string;
  role: DispatchRole;
  action: DispatchActionDescriptor;
  task: ContextTask;
  roles: Partial<Record<DispatchRole, string>>;
  lease: ContextLease | null;
  check_policy: ContextCheckPolicy | null;
  decisions: ContextDecision[];
  proposals: ContextProposal[];
  blockers: ContextBlocker[];
  reviews: ContextReview[];
  verifications: ContextVerification[];
  check_policy_overrides: ContextOverride[];
  conversation: ContextConversation;
}

/**
 * Content identity, on the one canonicalization the harness already has.
 *
 * Canonical serialization gives byte sensitivity over the bundle's value domain; the digest is then a
 * collision-resistant name for those bytes, not an injective one. A second canonicalizer would be a second
 * answer to a question that must have exactly one.
 */
export function contextBundleDigest(bundle: ContextBundle): string {
  return createHash('sha256').update(canonicalJson(bundle)).digest('hex');
}
