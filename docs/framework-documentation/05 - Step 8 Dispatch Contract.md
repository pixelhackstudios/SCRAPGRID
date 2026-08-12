# Step 8 — Deterministic Dispatch Contract

## Authority and status

This document is the **design freeze** for charter step 8. It is not an implementation and it does not
authorize one. It defines the dispatch-action vocabulary, the state table that derives it, the result
contract, and the durable dispatch record. Document 04 governs scope; where this document and 04 conflict,
04 governs.

Baseline scanned: `9587195`, schema version 8.

**Revision 6 (review findings, proven by reproduction).** `dispatch_id` attachment also matches the workflow
generation (§5.4). Agent, task, and terminal operation are all stable across a review-to-revision-to-re-claim
cycle, so revision 4's three-way match let a dispatch issued in an earlier cycle attach to a later operation —
reproduced against `e0dd0d9`, where a re-claim at task version 4 recorded a dispatch whose `basis_json` reads
`task_version: 1`. Session remains deliberately unmatched. Separately, `awaiting_unblock` is removed from the
§4 reason vocabulary: §3's shorthand rule resolves rows 5 and 5a to `awaiting_actor`, which is what row 8
already spells out for the identical null-address case, so the reason had no emitter.

**Revision 5 (narrow correction, proven by implementation).** The defensive claim guards move *inside* the
claim branch and are evaluated in the order `claimTask()` actually rejects (§3, §3.11). They were previously
listed as a global precedence step ahead of rows 2–9a, which contradicted §6.1's requirement that a dispatch
reason naming a service rejection matches the service's own code: in a state that was both paused and
conflict-corrupted, this document said `reservation_conflict` while `claimTask()` says `project_paused`, and a
corrupted reservation on a `blocked` or `in_review` task could surface as a claim conflict the service would
never evaluate. Nothing else about the guards changes — they remain defensive, structurally unreachable under
the role invariants, and named rather than assumed away.

**Revision 4 (literal).** Row 5 names the implementer's blocked `action_kind` (§3, §3.5); the two
structurally unreachable claim conflicts become executable defensive branches (§3.11); and `dispatch_id`
attachment compares the terminal operation's *resolved task* rather than its ledger subject (§5.4).

**Revision 3.** `resolve_finding` is removed from the dispatchable vocabulary, which is now **four**
actions (§3.8); `dispatch_contract_version` joins the record and the idempotency key (§5.1); two uncovered
branches are closed — `open` with no roles, and completed acceptance under a paused project (§3, §3.10);
derivation is pinned to one captured instant (§3.12); and the optional `dispatch_id` echo is validated
rather than trusted (§5.4).

**Revision 2.** Six corrections: the §6.1 equivalence property was unsound, the idempotency key lost
attribution across session replacement, `basis_digest` had nothing to reconstruct from and rested on a false
claim about `task_version`, a session busy with accepted work was dispatchable, `dispatch.next` could not
honour the unranked multi-task model, and override handling contradicted this document's own definition of
obligation.

Accepted and unchanged since revision 1: per-(agent, task) derivation, human-mediated blocker resolution,
project-pause asymmetry, and the unranked multi-task model.

---

## 1. Why "permitted" cannot equal "dispatchable"

`CollaborationService` deliberately permits many concurrent operations. `sendMessage()` accepts any
active agent pair. `proposeDecision()` and `submitProposal()` are open to every agent regardless of task
status. `addBlocker()` needs only an in-progress task. `resolveBlocker()` has **no** authority check
beyond `requireAgent()`. Asking "what could legally succeed right now?" returns a set on almost every
state, and choosing among that set is supervision.

The dispatchability test used throughout this document has two clauses, both required:

1. **Obligation** — canonical state shows the action must occur for the task to reach `accepted`.
2. **Unique address** — canonical state names exactly which agent must perform it.

Applied to the full operation surface in `collab/operations.ts`:

| Operation | Obligation | Unique address | Dispatchable | Why not |
|---|---|---|---|---|
| `sync`, `session.heartbeat` | no | n/a | no | transport and presence, not workflow |
| `task.create` | precedes the task | — | no | outside the dispatched lifecycle |
| `task.assign_roles` | yes | human | no | human authority (`human_required`) |
| `task.claim` | yes | implementer | **yes** | — |
| `review.request` | yes | implementer | **yes** (folded, §2) | — |
| `review.submit` | yes | reviewer | **yes** | — |
| `verification.run` | yes | verifier | **yes** | — |
| `finding.resolve` | conditional | **author *or* human** | no | two authorized actors; not uniquely addressed (§3.8) |
| `finding.add` | no | reviewer | no | reviewer judgment; folded into `review` |
| `blocker.add` | no | any agent | no | judgment, and unaddressed |
| `blocker.resolve` | yes when open | **none** | no | service permits any agent (§8.5) |
| `proposal.submit` / `proposal.reveal` | no | any / human | no | acceptance never consults proposals |
| `decision.propose` / `decision.accept` | no | any / human | no | parallel track, not an acceptance gate |
| `message.send` | no | any | no | the "many at once" surface, by design |
| `check_policy.override` | no | human | no | human affordance at acceptance |
| `task.accept` | yes | human | no | human authority |
| `worktree.*`, `session.*` | no | control | no | control plane |

**Bounded model-agent vocabulary: `claim`, `implement`, `review`, `verify`.** Four kinds.

Nothing is dispatched to `human`; human obligation is a *result*, not a dispatch (§4). Note that the
*obligation* clause and the *unique address* clause fail independently, and the table above uses both:
`blocker.add` fails obligation, `blocker.resolve` and `finding.resolve` fail unique address. Where an
obligation exists but cannot be addressed, the contract represents that rather than choosing an addressee
(§3.8, §8.5).

---

## 2. Dispatch is a function of (agent, task), and this is provable from schema

`task_roles` carries `PRIMARY KEY (task_id, role)` **and** `UNIQUE (task_id, agent_id)`
(`collab/schema.ts:83-84`). One agent holds at most one role on a task. Every dispatchable action is
role-gated through `requireTaskRole()` or `requireIndependentVerifier()`
(`collab/service.ts:892, 1053, 1117, 1168, 1217`). Therefore:

> At most one dispatchable action exists per (agent, task). This is enforced by the database, not by
> dispatcher logic.

Every precondition of every dispatchable action is task-scoped — roles, leases, reservations, reviews,
findings, and verifications all key on `task_id`. No precondition reads another task. So per-(agent, task)
derivation is **total and independent**, and the per-agent answer is the union over that agent's tasks.

This settles the open question: **derive per agent, never globally across agents.** Global selection would
require inventing priority between agents, and it is unnecessary — the human already partitioned the work
when they assigned roles. The dispatcher only reports what each agent's existing assignment currently
implies.

It does **not** settle multi-task ordering, and deliberately refuses to. If an agent holds actions on two
tasks, canonical state offers nothing to rank them by. The per-agent envelope carries the list in a stated
non-semantic order (`tasks.created_at, tasks.id`) and declares it unranked. The actor chooses. An actor
choosing among its own obligations is not a scheduler; a harness choosing for it would be.

### 2.1 Why `implement` is folded, and `claim` is not

`review.request` requires a candidate commit that descends from the task base and that the implementer
judges complete. Canonical state cannot know completeness: the durable `managed_worktrees.head_commit` is
written only at bootstrap, while status and snapshot merely project the current Git HEAD; in either case,
"differs from base" is not "done". So `implement` and `review.request` **must be one
action** — an action whose terminal operation is `review.request`. Splitting them would produce a dispatch
the harness cannot know is due.

`claim` stays separate because a canonical fact discriminates it: whether the agent holds an unexpired
lease on the task.

`verify` folds the remaining required checks into **one** action carrying a list, rather than one action
per check. Emitting one per check would manufacture ambiguity between items that are all required.

---

## 3. The state table

Read per (agent, task). `L` = a row in `leases` for the task with `expires_at > at` (§3.12). `C` =
`tasks.candidate_commit`. All facts cited are canonical rows, never inference.

**Rows are evaluated in this order, and the first match wins.** The order is stated because rows 1, 10, and
11 otherwise overlap, and precedence changes the answer:

1. task status is terminal → row 10
2. no `task_roles` rows exist for the task → row 1  *(before role membership: the workflow is waiting on the
   human, and this agent may yet be assigned)*
3. this agent holds no `task_roles` row → row 11
4. otherwise, by `tasks.status` → rows 2–9a

Where rows 2 or 4 derive `claim`, that branch is then resolved in the order `claimTask()` rejects (§3.11).

Cells use `waiting(actor, action_kind)` shorthand; the reason is `awaiting_actor` unless the cell names one.
A `null` actor means canonical state cannot address the obligation to anyone (rows 5 and 8).

| # | `tasks.status` | Discriminating canonical facts | Implementer | Reviewer | Verifier |
|---|---|---|---|---|---|
| 1 | `open` | no `task_roles` rows for task | `waiting(human, assign_roles, awaiting_roles)` | ← same | ← same (no role holders exist yet) |
| 2 | `open` | 3 `task_roles` rows | **`claim`** | `waiting(implementer, claim)` | `waiting(implementer, claim)` |
| 3 | `in_progress` | `L` exists and `L.agent_id` = implementer | **`implement`** | `waiting(implementer, implement)` | `waiting(implementer, implement)` |
| 4 | `in_progress` | no `L` (expired, or post-`needs_revision`) | **`claim`** | `waiting(implementer, claim)` | `waiting(implementer, claim)` |
| 5 | `blocked` | ≥1 open blocker; `L` held by implementer | `blocked(implement, task_blocked, [blocker_ids])` | `waiting(null, unblock)` | `waiting(null, unblock)` |
| 5a | `blocked` | ≥1 open blocker; no `L` | `blocked(claim, task_blocked, [blocker_ids])` | `waiting(null, unblock)` | `waiting(null, unblock)` |
| 6 | `in_review` | `C` set; a `reviews` row at `C` with `verdict='pending'` | `waiting(reviewer, review)` | **`review`** | row 7 applies independently |
| 7 | `in_review` | `C` set; **no** override for `C`; ≥1 pinned check lacks a passing verification by the verifier at `C` | `waiting(verifier, verify)` | row 6 applies independently | **`verify([check_ids])`** |
| 7a | `in_review` | `C` set; override exists for `C`; no passing verification by the verifier at `C` | `waiting(verifier, verify)` | row 6 applies independently | `blocked(verify, verification_spec_required, [override_id])` (§3.9) |
| 8 | `in_review` | `C` set; **no** pending review at `C`; ≥1 `review_findings` `blocking`+`open` on a review at `C` | `waiting(null, resolve_finding, awaiting_actor)` | ← same | ← same (§3.8) |
| 9 | `in_review` | acceptance gaps empty; project `active` | `waiting(human, accept, awaiting_human_acceptance)` | ← same | ← same |
| 9a | `in_review` | acceptance gaps empty; project `paused` | `waiting(human, accept, awaiting_project_resume)` | ← same | ← same (§3.10) |
| 10 | `accepted` | — | `none(task_terminal)` | `none(task_terminal)` | `none(task_terminal)` |
| 11 | any | roles exist, but **this** agent holds none | `none(no_role)` | `none(no_role)` | `none(no_role)` |

Rows 6 and 7 are concurrent and address **different agents**, so they are not ambiguity. Review and
verification are independently required by `acceptTask()` and the service imposes no order between them.

Every `in_review` row (6, 7, 7a, 8, 9, 9a) reads the **same** `acceptanceGaps()` list (§6). The rows are a
projection of that list onto role, not a second enumeration of the gates.

Row 12 (`cancelled`) is omitted: the status exists in the CHECK constraint but **no service method
transitions to it** (verified — `cancelled` appears only in `collab/schema.ts:48`). If it ever exists, treat
as row 10.

### 3.5 Why row 5 splits

A `blocked` result carries an `action_kind`, so row 5 has to name one. `addBlocker()` sets
`tasks.status = 'blocked'` and bumps the version but **does not touch `leases`**; `resolveBlocker()` returns
the task to `in_progress` once no open blockers remain. The lease therefore survives the blocked interval
and may or may not still be live when it ends.

That is the same captured lease fact rows 3 and 4 already turn on, and §3.12 guarantees one reading of it
per derivation, so no new basis field is needed:

```
live implementer lease → blocked(implement, task_blocked, [blocker_ids])
no live lease          → blocked(claim,     task_blocked, [blocker_ids])
```

Naming the kind matters beyond tidiness: it is what tells the implementer whether clearing the blocker
returns them to work directly or requires a re-claim first.

### 3.8 Row 8: an obligation with no unique address

Revisions 1 and 2 dispatched `resolve_finding` to the finding's author. **That violated §1's own unique-address
clause**, and the operation table admitted as much by recording the address as "author or human".

The service authorizes either actor, flatly (`collab/service.ts:1193`):

```js
if (resolvingAgent['kind'] !== 'human' && finding['raised_by'] !== agent) throw ...
```

Human resolution is not characterized as an emergency override or a recovery path — it is an ordinary
authorized route. So canonical state does not say *the reviewer must resolve this*; it says *either may*.
Selecting the reviewer is a responsibility policy the service does not contain, and inventing one is the
dispatcher deciding.

Of the two available repairs — represent the ambiguity, or redefine §1 to mean "unique *model-responsible*
actor" and treat `raised_by` as canonical responsibility — this document takes the first. The deciding
argument is that `resolve_finding` is the **only** member of the vocabulary with a second authorized actor:
`claim`, `implement`, and `review.request` are gated to the implementer, `review.submit` to the reviewer,
and `verification.run` to the verifier, each through `requireTaskRole()` with no human alternative.
Redefining the rule to rescue exactly one member is the tail wagging the dog, and it would put a human
authority carve-out into the definition that every other row is fine without.

It also unifies row 8 with row 5, which was already settled the same way and accepted: `resolveBlocker()`
has no unique address, so the harness represents the gap instead of filling it. Row 8 is the weaker version
of the same defect — a partial address rather than none — and gets the same treatment.

```
{ kind: 'waiting', actor: null, action_kind: 'resolve_finding', reason: 'awaiting_actor' }
```

**The dispatchable vocabulary is therefore four actions, not five.** The cost is that a second state now
requires human intervention with no model dispatch. That raises the human-intervention count in Pilot 002 —
which is a listed evidence signal, i.e. a measurement the pilot exists to take, not a defect it should hide.

#### Why row 8 still needs "no pending review at `C`"

The clause survives the change, because without it row 8 and row 6 would both match and produce genuine
ambiguity for the reviewer. Two reviews can exist at the same commit: request review at `C` → `in_review`;
reviewer submits `needs_revision` → task returns to `in_progress`, `candidate_commit` cleared, claim
reserved; the implementer re-claims and requests review at the **same** `C` (the descendant check still
passes). There are now two reviews at `C`, and the first review's findings are still open at `C`. A pending
review at the candidate is unambiguously the earlier obligation, so it discriminates — a canonical ordering
fact, not a heuristic.

Note the related service behaviour, left as-is: `acceptTask()` scopes the blocking-finding gate by
`review.commit_sha`, not by review id, so findings from the superseded review still gate acceptance of the
resubmitted identical commit. That reads as intentional — the defect is still in the code — and is out of
step 8's scope.

### 3.9 Required checks under a human override

`acceptTask()` skips the per-check loop when a `check_policy_overrides` row exists for the candidate, but
still requires one passing verification by the designated verifier at `C`.

Revision 1 said dispatch ignores overrides entirely. **That was wrong, and it contradicted this document's
own definition of obligation.** §1 admits an action as dispatchable only when canonical state shows it
*must occur for the task to reach `accepted`*. After an override, the named checks demonstrably need not
occur — `acceptTask()` waives them. Dispatching them anyway would have the dispatcher assert an obligation
the service does not hold, which is the dispatcher deciding.

Overrides therefore flow through `acceptanceGaps()` like every other gate, and the truth is:

```
override present for C
    → named-check gaps disappear
    → independent-verifier evidence gap REMAINS  (acceptTask still requires it)
```

That surviving gap has a determined actor (the assigned verifier) and **no determined command**. The pinned
policy no longer supplies one, and canonical state contains nothing else that does. This is precisely the
first-class result the contract exists to express, so row 7a returns:

```
{ kind: 'blocked', action_kind: 'verify',
  reason: 'verification_spec_required', refs: { override_id } }
```

It is `blocked` rather than `indeterminate` because the action *kind* is unambiguous; only its argv is
underdetermined. `indeterminate` is reserved for a genuine failure to reduce to one action kind.

If the verifier has already recorded a passing verification at `C`, the gap is closed and the task falls to
row 9. The earlier concern — that dispatch would nag a verifier to run an unrunnable check forever — is
removed rather than accepted as a cost.

### 3.10 Project pause is asymmetric, and dispatch must mirror it exactly

`requireProjectActive()` is called by `createTask`, `claimTask`, `submitProposal`, and `acceptTask` only
(`collab/service.ts:780, 866, 923, 1365`). `requestReview`, `submitReview`, `runVerification`,
`addReviewFinding`, `resolveReviewFinding`, `addBlocker`, and `resolveBlocker` do **not** consult it.

So under `project_state.status='paused'`: rows 2 and 4 become `blocked(project_paused)`, while rows 3, 6, 7,
7a, and 8 are unaffected — the implementer cannot claim, but review and verification proceed.

`acceptTask()` **is** on the gated list, so the asymmetry reaches the far end of the workflow too. A task
whose acceptance gaps are empty under a paused project is not awaiting a human decision; it is awaiting a
human *resume*, and `acceptTask()` would reject with `project_paused` if attempted. Row 9a exists so the
contract does not report acceptance as presently executable when the service would refuse it. This is the
same distinction the result contract draws everywhere else — an obligation that exists versus an obligation
that can proceed — applied to an actor who is not this agent. A dispatcher that "helpfully" blocked everything would be a second, subtly
different copy of the rules — exactly the failure mode step 8 must avoid. Same for `agents.status='paused'`
via `requireAgent()`, which gates every operation.

### 3.11 Defensive claim guards

Two service rejections should be unreachable on a dispatched path, because
`requireTaskRole(..., 'implementer', ...)` means only one agent can ever claim a task:

- `reservation_conflict` — reservations are always created for `review.requester`, who is the implementer.
- `lease_conflict` — no second agent can reach the lease check.

Revision 3 recorded that and stopped, which left both codes in the `blocked` vocabulary and in the §6.1 test
rule with no row able to produce them. Worse, if either state ever *did* exist, rows 2 and 4 would emit
`claim` into a service that rejects it — breaking the one-way property in §6.1, which is the contract's
load-bearing guarantee.

So they become real branches — but *within* the claim branch, not ahead of it. Reaching them already means the
table has derived that `claim` is this agent's obligation, so the guards resolve in the order `claimTask()`
itself rejects (`collab/service.ts`: `requireProjectActive()`, then `requireAgent()`, then the reservation
check, then the lease check):

| # | Guard | Result |
|---|---|---|
| — | project is paused | `blocked(claim, project_paused)` |
| — | this agent is paused | `blocked(claim, agent_paused)` |
| C1 | active `claim_reservations` row for the task owned by another agent | `blocked(claim, reservation_conflict, {reserved_for})` |
| C2 | live lease on the task held by another agent | `blocked(claim, lease_conflict, {lease_holder})` |
| — | otherwise | **`claim`** |

Both parts of the placement are load-bearing, and revision 4's global ordering got both wrong:

- **Pause precedes the conflict guards**, because the service tests it first. Deriving `reservation_conflict`
  for a paused project would name a barrier `claimTask()` never reaches, breaking the §6.1 clause that pins
  dispatch's reason vocabulary to the service's `CollaborationError.code`.
- **The guards belong to the claim branch only.** As a global precedence step they would fire on a `blocked` or
  `in_review` task whose reservation or lease row was corrupted, reporting a claim conflict for a task the
  service would refuse on its status long before it looked at either row.

They cost two comparisons against rows the derivation already reads. Neither should fire under the role
invariants; if one does, Pilot 002 has caught an authority regression with a named reason code rather than
a mystery rejection at the service boundary. That is strictly better than asserting the states cannot happen
and emitting an action that proves otherwise.

### 3.12 Derivation happens at one captured instant

Time is part of the basis: lease and reservation expiry are pure timestamp comparisons against `now()`, and
a lease crossing `expires_at` turns row 3 into row 4 with no database mutation (§5.2). A derivation that
calls `now()` more than once can therefore observe a TTL from both sides and assemble a basis that never
existed at any single instant.

One instant is captured at the start of a derivation and used for **every** expiry comparison within it, and
for `issued_at` when that derivation is issued:

```js
const at = Date.now();   // one per derivation, never re-read
```

`at` is recorded on the dispatch record as `issued_at`. It is deliberately **not** part of `basis_json` and
therefore not part of `basis_digest` — including it would change the digest on every poll and destroy the
idempotency the record depends on (§5.1). What goes into the basis is the *evaluated* result of the
comparison (`lease_live: false`), not the clock reading that produced it.

The same instant is what `publicSession()` already takes as its `at` parameter, so session projection and
dispatch derivation can agree rather than straddle a staleness boundary.

---

## 4. Result contract

The scope split matters and corrects a natural but wrong grouping. "Cannot proceed" reasons do **not** all
live at the same level: a blocker is task-scoped, but session presence and work-in-flight are agent-scoped.
Putting session facts inside each per-task result would repeat them N times and misstate what they qualify.

```
DispatchEnvelope           // per agent — one derivation
  agent_id
  derived_at
  session: { session_id | null, liveness: 'live'|'stale'|'none', work_in_flight: bool }
  deliverable: bool        // liveness == 'live' AND work_in_flight == false  (see below)
  tasks: DispatchResult[]  // ordered by (tasks.created_at, tasks.id); ORDER IS NOT PRIORITY
```

Derivation is **not** gated on session presence. Deriving for an agent with no session is legitimate and
useful (human inspection, tests). Only *issuing a dispatch record* is gated (§5, §7).

**A busy session is not dispatchable.** Step 7 deliberately defines work in flight as implying liveness
(`publicSession()` reports `liveness: 'live'` whenever `hasWorkInFlight()` is true, however old the
heartbeat). So `liveness == 'live'` alone would let step 8 issue a second `verify` from pre-completion state
while the first verification is still running inside `collabd`. Issuance requires **both** facts, which is
exactly why step 7 kept them separate.

Implementation requirement, recorded now so it is not improvised later: `collab/http.ts:292-293` computes
`tracked = principal.kind === 'session' && definition.mutating` and calls `sessionActivity.begin()` *before*
invoking the operation. An issuing operation is mutating, so it marks its own session busy before it can
read the flag. The issuance predicate must therefore read a `work_in_flight` value **sampled before the
request registered its own activity**, passed through `OperationContext`. It must not compare counter
depths or special-case the operation name. (`definition.mutating` is used for nothing else — the ledger is
driven by the service methods themselves — so weakening that flag to dodge tracking is not an option
either.)

```
DispatchResult = one of

  { kind: 'action',        task_id, action }
      exactly one obligation, addressed to this agent, and permitted now

  { kind: 'waiting',       task_id, actor: agent_id|'human'|null, action_kind, reason }
      a required action exists on this task but is not this agent's to perform
      actor is null when canonical state cannot uniquely address it (rows 5, 8)
      reason ∈ awaiting_roles | awaiting_actor
             | awaiting_human_acceptance | awaiting_project_resume   (rows 9 / 9a)

  { kind: 'blocked',       task_id, action_kind, reason, refs }
      this agent's action exists but a canonical precondition forbids it now
      reason ∈ project_paused | agent_paused | task_blocked | missing_check_policy
             | verification_spec_required                (§3.9, row 7a)
             | reservation_conflict | lease_conflict     (§3.11, rows C1/C2: defensive)
      refs carries the canonical rows responsible
           (blocker ids, override id, reservation agent, lease holder)

  { kind: 'none',          task_id, reason }
      reason ∈ no_role | task_terminal

  { kind: 'indeterminate', task_id, candidates: action_kind[], basis }
      derivation produced ≠ 1 candidate — a HARNESS DEFECT, never resolved by heuristic
```

`indeterminate` must never be collapsed into `waiting` or `none`. It is the branch that keeps the opening
rule honest: when the table is wrong, the result says the table is wrong.

Two action-name sets exist, and conflating them is what let revision 1 dispatch an unaddressable action.

```
WorkflowAction   — labels used by `waiting.action_kind`; what must happen, whoever does it
                   assign_roles | claim | implement | review | verify
                 | resolve_finding | unblock | accept

DispatchAction   — the strict subset that is dispatchable to a model agent
                   claim | implement | review | verify
```

`DispatchAction ⊂ WorkflowAction` is the narrower deterministic protocol named in the opening rules. Only
a `DispatchAction` can appear in an `action` result or a dispatch record.

```
Action =
  kind: 'claim' | 'implement' | 'review' | 'verify'
  terminal_operation: 'task.claim' | 'review.request' | 'review.submit' | 'verification.run'
  task_id
  task_version            // the version derived against; IS the expectedVersion for task.claim
  repository_identity
  base_commit
  candidate_commit?       // review, verify
  review_id?              // review
  check_ids?              // verify — remaining pinned checks, in policy order
  dispatch_contract_version
  basis_digest
```

No prose. No advice. No ambient conversation. Every field is an identifier, a version, or a commit.

### 4.1 Which tasks the envelope enumerates

`dispatch.derive { agent }` enumerates non-terminal tasks where the agent holds a role, plus tasks with no
roles assigned (row 1 concerns every model agent, since any of them may yet be assigned). It does not list
every task in the project as `none(no_role)` noise.

`dispatch.derive { agent, task }` evaluates whatever task is named and returns the full result, including
`none(no_role)` and `none(task_terminal)`. Explicit inspection is never filtered.

---

## 5. The durable dispatch record

The charter's reconstruction criterion names "role and dispatch records", so step 8 must leave evidence,
not compute ephemerally.

**A record is written only when an `action` is issued to a deliverable session** (§4). Recording every
derivation would turn polling into write amplification and bury the causal record the ledger exists to keep
readable — the same reasoning that keeps `touchSession()` off the ledger.

```sql
CREATE TABLE dispatches (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  session_id         TEXT NOT NULL REFERENCES agent_sessions(id),
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_kind        TEXT NOT NULL CHECK (action_kind IN
                       ('claim','implement','review','verify')),
  terminal_operation TEXT NOT NULL,
  dispatch_contract_version INTEGER NOT NULL,
  repository_identity TEXT NOT NULL,
  base_commit        TEXT NOT NULL,
  candidate_commit   TEXT,
  review_id          TEXT REFERENCES reviews(id),
  subject_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(subject_json)),  -- check_ids
  basis_json         TEXT NOT NULL CHECK (json_valid(basis_json)),
  basis_digest       TEXT NOT NULL,
  issued_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX dispatches_basis
  ON dispatches(session_id, task_id, dispatch_contract_version, basis_digest);
CREATE INDEX dispatches_agent ON dispatches(agent_id, task_id, issued_at);
```

### 5.1 Idempotency is keyed on the session, the basis on workflow state alone

Revision 1 keyed the unique index on `(agent_id, task_id, basis_digest)` while excluding the session from
the basis. Those two choices are incompatible. A session receives dispatch `D`; canonical workflow state
does not change; the session is replaced under step 7 recovery; the replacement polls. The basis is
identical, so the key finds `D` — but `D` records `session_id = A`, and the session actually being told is
`B`. Updating `D` destroys the historical attribution the record exists for, and inserting is refused by
the index.

The split that resolves it:

- **`basis_digest` covers workflow state only.** No session, no agent, no timestamp. This keeps the digest a
  statement about the task, which is what makes it comparable across recoveries.
- **Idempotency is `(session_id, task_id, basis_digest)`.** Same session plus unchanged state returns the
  existing row; a replacement session plus unchanged state is a new, separately attributable delivery.
- **`agent_id` is an ordinary recorded column**, indexed for reconstruction, not part of the key.
- **`dispatch_contract_version` is part of the key**, because the basis alone does not determine the answer
  (below).

This matches step 7's identity model exactly: the durable agent owns the workflow, the session owns the
delivery.

**Why the contract version belongs in the key as well as the record.** Storing the inputs explains a past
dispatch only if the *function* that consumed them is also known. Given `basis_json = X`, derivation v1 may
have returned `review` where v2 returns something else; re-running today's table against yesterday's basis
does not necessarily reproduce yesterday's answer. Worse, without the version in the key, the same session
and unchanged workflow state would collide with a pre-update dispatch *after a derivation rule changed* —
suppressing exactly the re-dispatch the change was meant to cause.

`dispatch_contract_version` is a plain integer, `1` at step 8, bumped whenever the state table or the basis
shape changes. `basis_digest` stays state-only, as revision 2 established. The version says which
deterministic function consumed that state.

### 5.2 The basis must be stored, and `task_version` cannot stand in for it

Revision 1 claimed the digest made reconstruction executable by letting a reader "re-run derivation against
the recorded facts" — but recorded no facts. It then rested idempotency on the claim that *any canonical
change bumps `task_version`*. **That claim is false**, and the following dispatch-relevant changes bump
nothing on `tasks` (all verified at this baseline):

| Change | Bumps `tasks.version`? |
|---|---|
| `runVerification()` inserts verification evidence | no — inserts into `verifications` only |
| `submitReview()` with `approved` | no — updates `reviews` only; only `needs_revision` touches `tasks` |
| `addReviewFinding()` / `resolveReviewFinding()` | no |
| `overrideCheckPolicy()` | no |
| **a lease crossing `expires_at`** | **no database mutation at all** |

The last is the sharpest: an `implement` result becomes a `claim` result purely because time passed. A
version-derived basis cannot see it.

So the record carries a compact normalized **`basis_json`** — the exact discriminating facts the table read,
and nothing else. Not a state snapshot, not context (step 9 owns that):

```
task status, task version
this agent's assigned role
project status, agent status              (where the row consults them)
lease agent_id + expires_at + the evaluated live/expired fact
active claim reservation                  (where consulted)
candidate_commit
pending review id at the candidate
open blocking finding ids at the candidate
remaining acceptance gaps / remaining check ids
check policy identity, override id        (where present)
```

`basis_digest = sha256(canonical serialization of basis_json)`. The evaluated lease fact is stored
explicitly rather than recomputed, because `expires_at` alone does not tell a later reader which side of the
boundary the dispatcher was on.

The record now explains itself: a reader reconstructs why agent X was told to do Y by re-running the state
table against `basis_json` and confirming the same action falls out.

### 5.3 Indeterminate results

`dispatch.derive` returns `indeterminate` and **writes nothing** — it is a read operation (§7). An attempted
`dispatch.issue` on an indeterminate result creates a rejected `operation_attempts` row with
`reason_code = 'dispatch_indeterminate'`. That ledger already exists to hold rejected attempts, so no second
anomaly table is needed, and the read/write split stays clean.

**Deliberately absent from the record:** priority, deadline, prose instruction, ordering, retry count, status
machine. Each is a scheduler or a supervisor in miniature. Step 9 context bundles are not referenced.

### 5.4 Closing the causal loop

Recommended, one nullable column and one optional input: `operation_attempts.dispatch_id`, echoed by the
agent when it invokes the terminal operation. This converts "told X to do Y" and "X did Y" from a
time-and-subject join into a hard causal edge, which is what "reconstruct why agent X was told to perform
action Y" actually demands. The alternative — joining on
`(actor, operation, subject, started_at > issued_at)` — is ambiguous exactly in the retry cases Pilot 002
is meant to measure.

**The echoed id is validated, never trusted.** A caller supplying a valid id belonging to another task or
another agent would otherwise manufacture false provenance in the very record the pilot reads for causality.
The attachment rule:

```
dispatch_id supplied
   → attach only if the referenced dispatch matches
        agent_id            (the authenticated principal)
        task_id             (the operation's RESOLVED task — see below)
        terminal_operation  (the operation being invoked)
        task_version        (the generation the dispatch was derived against — see below)
   → otherwise record NULL, and do not reject the operation
```

**The generation must be matched, or the edge is forgeable by accident.** Revision 4 named the first three
clauses only, and all three are stable across a revision cycle: the same implementer re-claims the same task
through the same operation. A dispatch issued before `needs_revision` therefore satisfied every clause when
echoed against the re-claim that followed — recording that the later work happened because of a dispatch whose
stored basis describes a task version that has since moved on. That is precisely the retry case §5.4 exists to
disambiguate, so the weakness sat in the clause meant to close it.

`task_version` is the generation marker `basis_json` already carries, and it is what the terminal operation was
derived against, so the comparison needs no new column. The operation supplies the version it *observed*, before
its own mutation: `task.claim` compares the version it verified as `expectedVersion`, `review.request` the
version it read before bumping, `review.submit` the version captured before the `needs_revision` branch moves
it, and `verification.run` the version it read (which it never mutates — so one `verify` dispatch legitimately
attaches to each check it carries).

Session stays out of the match for the reason revision 3 gave. Generation is a different question from identity:
recovery replaces a session while the workflow stands still, whereas a revision cycle moves the workflow while
the session stands still.

**The task is the operation's resolved task, not its ledger subject.** Three of the four terminal operations
record `subjectType: 'task'`, but `review.submit` records `subjectType: 'review'` with the review id
(`collab/service.ts:1113`) and reaches the task through the review row. Comparing blindly against
`operation_attempts.subject_id` would therefore never attach review provenance — the one action whose
causal edge the review-to-revision-to-re-review cycle most needs. Attachment resolves the task the same way
the operation itself does.

Advisory in both directions: a mismatched or absent id costs provenance, never work. A dispatch id that
cannot be attached must not block a domain mutation the service would otherwise accept.

Session is deliberately **not** part of the match. Step 7 recovery can legitimately replace a session while
the durable agent's work continues, and requiring a session match would break the causal edge precisely
across the recovery events the pilot most needs to reconstruct.

---

## 6. Reusing existing authority instead of copying it

Named private predicates already carrying the real invariants, to be reused directly:
`requireTaskRole()`, `requireAssignedRoles()`, `requireIndependentVerifier()`, `requireProjectActive()`,
`requireAgent()`, `requireTaskCheckPolicy()`.

Three invariants are currently **inline and duplicated**, and must be extracted before dispatch reads them —
otherwise step 8 grows the second copy this design exists to prevent:

1. **`liveLease(taskId)`** — the live-lease test is written twice, inline in `claimTask()`
   (`collab/service.ts:893`) and `requestReview()` (`collab/service.ts:1071-1073`). Rows 3 and 4 depend on it.
2. **`activeClaimReservation(taskId)`** — inline in `claimTask()` (`collab/service.ts:880-891`).
3. **`acceptanceGaps(task)`** — the highest-value extraction. `acceptTask()`
   (`collab/service.ts:1363-1460`) contains ~90 lines that already encode every remaining obligation on a
   candidate: open blockers, open blocking findings at `C`, the missing approved review by the assigned
   reviewer, the missing independent verification, and the per-check policy loop (skipped under an override,
   §3.9). **Inverted, that function
   *is* the `in_review` dispatch table.** Extract it to return the list of unmet gates; have `acceptTask()`
   reject when the list is non-empty, and have rows 6–9 read the same list. One source, two readers.

### 6.1 Test obligation: a one-way implication, not an equivalence

Revision 1 proposed that dispatch returns `action` **iff** the corresponding service call succeeds. That
property is unsound, and it contradicts this document's own opening rule. If permitted and dispatchable were
equivalent, §1 would have nothing to say.

Two counterexamples at this baseline, both reachable:

- **Row 3.** The implementer holds a live lease, so dispatch derives `implement`. But `claimTask()` rejects a
  lease conflict only when the live lease belongs to *another* agent
  (`existing['agent_id'] !== input.agent`, `collab/service.ts:894`) and permits claiming from `in_progress`.
  So `task.claim` still succeeds while `claim` is not the obligation.
- **Row 9.** Once required verification is satisfied, `runVerification()` will happily record another passing
  verification at the same commit. Nothing gates it on outstanding need.

Legal is not due. The binding property is one-way:

```
dispatcher returns ACTION
    ⇒ the terminal operation's authority and preconditions permit it now

service operation succeeds
    ⇏ dispatcher must have returned ACTION
```

The test obligation over every row of §3 is therefore:

1. **Action rows.** Construct the state, assert kind `action` with the expected `action_kind`, then invoke
   the terminal operation and assert it **succeeds**. A dispatch the service refuses is a hard failure — this
   is the direction that catches drift.
2. **Non-action rows.** Assert the exact kind and reason code. Do **not** assert that the corresponding
   service call fails; several are legal-but-not-due. Where the row's reason names a service rejection
   (`project_paused`, `agent_paused`, `reservation_conflict`, `lease_conflict`), additionally assert the
   service rejects with that same `CollaborationError.code` — pinning dispatch's reason vocabulary to the
   service's. Row 9a asserts the same for `acceptTask()` under a paused project.
3. **Shared-predicate rows.** For rows whose discrimination comes from `acceptanceGaps()`, assert the
   dispatch result and `acceptTask()`'s behaviour agree: gaps empty ⟺ row 9 ⟺ acceptance succeeds.

Clause 3 is what makes the extraction in §6 load-bearing rather than cosmetic.

---

## 7. Proposed operations

Revision 1 proposed `dispatch.next { agent }`, which cannot exist. §2 deliberately allows an agent to hold
actions on several tasks and refuses to rank them, so an operation asked for *the* next action would have to
choose — putting the scheduler back into the API under a different name.

The split that keeps it out:

- **`dispatch.derive { agent, task? }`** — read-only, writes nothing, no ledger entry, matching the other
  read operations in `collab/operations.ts`. Returns the full unranked envelope (§4), or the single
  `DispatchResult` when `task` is given. This is where the multi-task list is exposed.
- **`dispatch.issue { agent, task }`** — mutating, session-bound, **`task` required**. Derives that one
  pair, and on an `action` result writes the dispatch record (§5). On any other kind it writes no record and
  returns the result unchanged, except `indeterminate`, which additionally lands in the ledger (§5.3).

So the actor reads its unranked obligations and explicitly names the one it is taking up. The harness never
orders them, and never issues a task the caller did not name.

### 7.1 Authorization

`dispatch.issue` is expressible with the existing metadata: `{ mutating: true, session: true,
identity: 'agent' }`.

`dispatch.derive` is **not**. It needs "the control credential may inspect any agent, and a model session
may inspect only itself", and `authorizeOperation()` in `collab/operations.ts` offers no such combination:
`control: true` rejects sessions outright, and `identity: 'agent'` compares the claim against
`principal.agentId`, which is the literal `'human'` for a control principal — so control could never inspect
`claude`. Leaving `identity` off would let any session derive for any agent, silently weakening the identity
binding step 7 established.

Step 8 therefore needs one bounded addition to the operation boundary — a flag such as
`identityOrControl: 'agent'`, meaning *control passes; a session must match* — expressed in
`authorizeOperation()` alongside the existing rules rather than checked ad hoc inside an operation body. It
is the smallest change that states the intent where every other authorization rule already lives.

---

## 8. Challenges to this design

Recorded so review can attack them directly rather than rediscover them.

1. **`implement` is not a service operation.** Dispatching an action the harness cannot observe completing
   is arguably a category error. Defended: the alternative dispatches only API calls and leaves the largest
   span of a task with no record of what the agent was told — which fails the reconstruction criterion for
   precisely the interval that matters most.
2. **The multi-task list is unranked.** This looks like an evasion. It is a deliberate refusal: any ranking
   the harness supplies is scheduling, and scheduling is explicitly deferred in document 04. Revision 2
   makes the refusal structural rather than advisory by removing the API's ability to pick (§7).
3. **Row 8 now dispatches nothing, and the underlying defect is still parked.** Revision 3 removed
   `resolve_finding` from the vocabulary (§3.8), so an approved review carrying an open blocking finding at
   the candidate stalls until a human acts. The root cause is that the service permits that state at all;
   the clean fix is refusing approval while blocking findings are open at the candidate. That changes
   service semantics, so the charter's freeze rule parks it. Step 8 represents the stall; it does not
   resolve it.
4. **Overrides now suppress named-check dispatch (§3.9).** Reversed in revision 2. The residual risk moved
   rather than vanished: dispatch no longer nags for a waived check, but row 7a can leave a verifier
   `blocked` with `verification_spec_required` and no canonical way forward except human acceptance. That is
   the honest representation of a real hole, and it is a Pilot 002 signal worth counting.
5. **`blocked` yields no model action (row 5), and this is the largest pilot-visible risk.**
   `resolveBlocker()` has no authority rule at all — any active agent may resolve any blocker — so canonical
   state cannot address the unblock to anyone. Step 8 must not invent that rule (that would be the
   dispatcher deciding). Two honest exits, for review to choose: accept human-mediated unblocking as a
   recorded Pilot 002 boundary, or add a one-line authority rule to `resolveBlocker()` as a scoped step 8
   review finding. **Recommended: the former.** Blocker frequency is already a listed evidence signal.

6. **`basis_json` is a second copy of state at rest.** Retained deliberately, under an explicit boundary:

   > `basis_json` is immutable historical evidence only. It is never read as current authority and never
   > fed into current derivation. Domain rows remain the sole authority for what is true now. Its shape is
   > versioned by `dispatch_contract_version`, and its contents stay limited to discriminating coordination
   > facts — context belongs to step 9.

   It is expected to *disagree* with the domain tables over time; that is what makes it a record of an
   observation rather than a cache. The live risk is not staleness but scope creep: the moment step 9 lands,
   `basis_json` is the obvious place someone will try to park bundle contents. The boundary above exists to
   refuse that.

---

## 9. What this document does not do

It does not implement anything, migrate the schema, or advance the charter. Step 8 remains **NEXT**. The
schema in §5 is a proposal for review, not a migration. Nothing here anticipates step 9 context bundles.

The stopping rule holds: once §3 survives review, the schema and API step 8 actually needs are known — rather
than inventing a `dispatches` table first and discovering halfway through that "dispatch" was never defined.
