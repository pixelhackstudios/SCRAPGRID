# Step 9 — Deterministic Context Bundle Contract

## Authority and status

This document is the **design freeze** for charter step 9. It is not an implementation and it does not
authorize one. It defines what an authenticated agent is given alongside an already-issued dispatch, how
that gift is selected from canonical state, how it is identified, and how it is tied to the work performed
from it. Document 04 governs scope; where this document and 04 conflict, 04 governs. Document 05 governs
dispatch; where this document and 05 appear to conflict about dispatch, 05 governs and this document is
wrong.

Baseline scanned: `2ef4a7a`, schema version 9.

**Revision 4 (review finding, exposed by implementation).** C/W/N classify two axes — the bundle selection
and `DispatchFacts` — and delivery identity is a third, owned by step 7 and step 8. Revision 3 left the
`Neither` class asserting that the dispatch row is unchanged too, which §7.1 contradicts in the one case
that matters: a replacement session receives a new dispatch row and a new bundle row carrying the same
digest, and it must. The N rule and the §12 obligation now carry the session qualifier the third axis
requires; the implementation was already right about this and does not change.

**Revision 3 (review finding, literal).** The two conditional rows in §6.2 were labelled class `W` while
the prose beneath them and §12 both said the branch decides, so the table contradicted its own reading. They
are now `C or W`, the C-row claim is narrowed to the three *unconditional* C rows, and the finding row's
gate is stated as what it actually is: a blocking finding behaves as `W` only where it reaches the gaps
dispatch currently consumes, so a blocking finding on an earlier review is context-only.

**Revision 2 (review finding, blocking).** The load-bearing property was scoped too broadly, and §12
inherited the error as an impossible test obligation. Revision 1 asked every bundle-changing operation to
leave `dispatches.id` unchanged, but roughly half of them — `task.claim`, `review.submit`,
`check_policy.override`, and the rest — are *supposed* to move workflow state, and a dispatch identity that
survived `task.claim` would mean step 8 was broken. The property is now stated over the class it was always
about: changes that alter selected context while leaving step 8's `DispatchFacts` alone (§6, §6.2, §12).
Separately, P1 no longer claims injectivity of SHA-256, which no fixed-width digest has (§6); a
`context_bundles` row is named as one distinct content record rather than one delivery (§7); and
`context_bundles` itself is written into the fixpoint exclusion (§6.3).

**Revision 1.** First freeze. Nothing accepted yet.

The question this document answers:

> What is the minimum deterministic snapshot of shared coordination truth an agent needs to carry out an
> already-issued dispatch, such that exactly what it received can later be reconstructed by identity?

And the property it must make true, which is to step 9 what `ACTION ⇒ the service permits it` was to step 8.
Canonical changes fall into exactly three classes with respect to one (agent, task), and the property names
all three:

> **Context-only** — a change that alters the selected context but leaves step 8's `DispatchFacts`
> unchanged **must** change the bundle digest and **must not** produce a new dispatch.
>
> **Workflow** — a change that alters `DispatchFacts` may legitimately produce a new dispatch, a different
> action, or no action at all; step 9 must never be the *cause* of that movement, and where an action is
> still delivered its bundle reflects the new state.
>
> **Neither** — a change that is irrelevant or invisible to this agent leaves the bundle digest unchanged,
> and leaves the dispatch unchanged *provided the step 8 delivery identity is unchanged too*.

The classes range over content and workflow. **Delivery identity is a third, orthogonal axis**, and it
belongs to steps 7 and 8 rather than to this contract: replacing a session moves neither `S` nor
`DispatchFacts`, yet it correctly produces a new dispatch row and a new bundle row carrying the same digest
(§7.1). That is why the `Neither` clause is qualified rather than absolute — an unqualified reading would
make step 7 recovery look like a step 9 defect.

The first class is the one step 9 exists for and the one nothing in step 8 can express. Sections 4, 6, and
6.2 exist to make all three checkable rather than aspirational.

---

## 1. What step 8 left, and what step 9 owes

Step 8 answers *what this agent is obliged to do*: an action descriptor of identifiers, versions, and
commits, with no prose, no advice, and no ambient conversation (`collab/dispatch.ts:100-112`). That was
deliberate, and Doc 05 §8.6 recorded the boundary in advance:

> `basis_json` is immutable historical evidence only. […] its contents stay limited to discriminating
> coordination facts — context belongs to step 9.

Step 9 answers the different question: *what should this agent know in order to carry out the action it
has already been told to perform*. The two questions have different inputs, different change rates, and —
this is the load-bearing claim of §2 — different identities.

The original collaboration report already reached most of this. It said `sync` should hand a restarted
agent a **bounded summary** rather than making it reconstruct state through ten calls
(`docs/framework-documentation/01-AI-Colloboration-Report.md:265`), and it drew the line that keeps such a
summary small: **messaging is not project memory**
(`docs/framework-documentation/01-AI-Colloboration-Report.md:491-509`). Things that must survive get
promoted — message → finding / blocker / proposal → decision or resolved finding — so shared context stays
small and machine-readable.

`syncState()` (`collab/service.ts:856-935`) is the ancestor of this contract. It already assembles
messages, accepted decisions, revealed proposals, open blockers, pending reviews, open findings,
verifications, overrides, and roles. What it does not do is scope them to one task and one recipient,
bound them, or give the assembled result an identity. Step 9 is that, and only that.

**Step 9 is not "build a context system."** It is a deterministic projection of shared truth that already
exists in the schema, plus a digest.

---

## 2. Context identity cannot be part of dispatch identity

This is the step 9 equivalent of step 8's action-only return type, and getting it wrong corrupts step 8
rather than merely inconveniencing step 9.

Consider Codex dispatched to `implement` on `TASK-42`. Claude then sends Codex a task message, or the human
accepts a decision. The dispatch basis is untouched — the same task status, the same version, the same
live lease, the same role, the same agent — so step 8's derivation returns the identical action and the
idempotency key `(session_id, task_id, dispatch_contract_version, basis_digest)` finds the identical row
(`collab/schema.ts:260-261`). But what Codex ought to know has changed.

Two ways to get this wrong, both fatal:

- **Put context in `basis_json`, or fold context into the dispatch idempotency key.** Then a message
  manufactures a new dispatch. Conversation starts producing obligations, `basis_json` stops being a
  statement about workflow state, and the digest stops being comparable across recoveries — which was the
  whole point of keeping session, agent, and timestamp out of it (Doc 05 §5.1).
- **Make one bundle permanently one-to-one with the dispatch row.** Then reissuing after the message
  returns the stale bundle forever, and the agent is structurally unable to receive anything that arrived
  after the first delivery.

The only relation that survives both:

```text
workflow state
    ↓  (step 8 derivation)
one dispatch identity
    ↓  (step 9 selection)
zero, one, or several context-bundle deliveries over time
```

Same action, same dispatch, **new bundle when the selected shared context changes**. Delivery identity and
content identity stay separate, exactly as step 7 separated the durable agent from the session and step 8
separated workflow basis from delivery.

### 2.1 The boundary in one line each

| Artifact | Answers | Keyed by | Changes when |
|---|---|---|---|
| `dispatches.basis_json` | why this action was derived | `(session, task, contract version, basis digest)` | discriminating workflow facts move |
| `context_bundles.bundle_json` | what the agent was told alongside it | `(dispatch, contract version, bundle digest)` | selected shared truth visible to this agent moves |

They overlap in a few fields (task version, candidate commit) and that duplication is deliberate: they are
two records with two readers and two lifetimes. §13.5 defends it rather than merging them.

---

## 3. What canonical state can supply

Every table at schema version 9, and whether it is eligible for a bundle. "Eligible" means: it is canonical
shared coordination truth, it is visible to the recipient, and including it does not import a second copy of
something that already has an authority elsewhere.

| Table | In bundle | Why / why not |
|---|---|---|
| `tasks` | **yes**, partially | goal, acceptance, status, candidate — the task truth the action is about |
| `task_roles` | **yes** | who to review with, who to message; three rows, immutable in practice |
| `leases` | **yes**, the agent's own | `requestReview()` refuses without a live lease (`collab/service.ts:1244-1250`); the deadline is required by the dispatched action itself |
| `decisions` | **yes**, accepted only | durable project truth; the promotion target the report names |
| `proposals` | **yes**, revealed only | sealed content must never appear (§4.3) |
| `blockers` | **yes**, open only | resolved blockers are history the ledger keeps |
| `reviews` | **yes**, full task history | the re-claiming implementer needs the verdict that sent it back |
| `review_findings` | **yes**, with their review | the actual revision instructions |
| `verifications` | **yes**, over the review commit set | evidence, argv, exit code — no output is stored anywhere (§5.2) |
| `check_policy_overrides` | **yes**, over the review commit set | changes what acceptance requires |
| `project_repository` | **yes**, as identity only | `repository_identity` already rides the action descriptor |
| `agents` | **no** | `last_seen_at` is rewritten by every `sync()` (`collab/service.ts:859`); presence is not task truth (§6.2) |
| `agent_sessions` | **no** | delivery metadata; the bundle must survive session replacement with an unchanged digest (§7.1) |
| `project_state` | **no** | project-scoped condition; the dispatch envelope reports it (Doc 05 §4) |
| `claim_reservations` | **no** | binds claim authority to the same agent role gating already binds it to |
| `managed_worktrees` | **no** | `head_commit` is written only at bootstrap and is known-stale (Doc 03 §6.1); hashing a known-false fact is worse than omitting it |
| `dispatches` | **no** | issuing a bundle would change the next bundle (§6.3) |
| `operation_attempts` | **no** | same fixpoint problem, plus it is the causal record *of* delivery |
| `events` | **no** | `events.id` advances on nearly every write project-wide (§6.3); this is the single largest churn source and the clearest line between a bundle and `sync` |
| `check policy` (pinned JSON on `tasks`) | **yes** | the exact commands the verifier will run; the implementer is otherwise guessing |

Six task columns are **write-once at `task.create`** — `goal`, `acceptance_json`, `repository_identity`,
`base_commit`, `check_policy_identity`, `check_policy_json` (`collab/service.ts:948-949`; the only
`UPDATE tasks SET` statements are at `collab/service.ts:1068, 1191, 1213, 1269, 1318, 1591` and touch none
of them). That immutability is what makes the largest part of the bundle contribute zero churn.

---

## 4. Visibility, scope, and order, stated literally

No relevance scoring, no ranking, no summarization. Selection is three literal predicates — task scope,
participant visibility, recency — and a stated total order.

### 4.1 Task scope, and why untargeted messages are excluded

The bundle is scoped to **one task**: the task named in the dispatch. Doc 05 §2 proved that dispatch
derivation is per-(agent, task) and *independent* — no precondition of any dispatchable action reads
another task. Step 9 preserves that independence deliberately.

`messages.task_id` is nullable (`collab/schema.ts:87-94`), so a message can be addressed to an agent with no
task at all. Including those would couple every bundle on every task the agent holds to one untargeted
message, and would make the digest of `TASK-42` move because of a remark about `TASK-7`. Untargeted
messages are therefore **excluded**, and `sync` remains the channel that carries them (§10.3).

Accepted decisions are the one deliberate exception: a decision with `task_id IS NULL` is project-wide
truth by construction (`collab/service.ts:1128-1141`), and accepting one *should* change every bundle.
That is a should-change, not churn.

### 4.2 Participant visibility

`sendMessage()` writes exactly one sender and one recipient (`collab/service.ts:1161-1177`); there is no
broadcast. So a message between Claude and Grok on `TASK-42` is not addressed to Codex, and must not appear
in Codex's bundle merely because they share a task.

**Rule: task-scoped messages where the recipient agent is `sender` OR `recipient`.**

The sender side is a deliberate widening of `syncState()`, which selects on `recipient` alone
(`collab/service.ts:863-865`). An agent's own outbound messages are not a disclosure to itself, and without
them the window is half a conversation — the reviewer's question appears with no record of the answer that
was already given. Nothing is disclosed that the agent did not author or receive.

### 4.3 Sealed proposals

`proposals.visibility` defaults to `sealed` and only a human can reveal (`collab/service.ts:1115-1125`).
Sealed proposals are excluded **entirely** — not redacted, not listed by id. Listing them would leak that
an agent has already proposed, which is precisely the anchoring the sealed mechanism exists to prevent, and
`snapshot()`'s redaction of `content` alone (`collab/service.ts:805-811`) is a display concession, not a
model for a hashed artifact. The agent's own sealed proposal is also excluded: re-showing an agent what it
wrote has no coordination value and would make bundles asymmetric for no gain.

Consequence, stated so it is checkable: `proposal.submit` changes no bundle digest anywhere;
`proposal.reveal` changes them for every recipient on that task.

### 4.4 The commit set

Verification evidence and overrides are selected over **every commit in the task's review history**, not
over the current candidate alone.

The current candidate is always a member of that set, and this is provable rather than assumed:
`requestReview()` inserts the review row at `commit` and sets `tasks.candidate_commit = commit` in one
transaction (`collab/service.ts:1252-1270`), and nothing else ever sets `candidate_commit` — the only other
write is the `needs_revision` clear at `collab/service.ts:1318`. So `{candidate} ⊆ {reviewed commits}`, and
"the review commit set" needs no second clause.

Widening past the current candidate matters for exactly one recipient: the implementer re-claiming after
`needs_revision`, whose candidate has just been cleared to `NULL`. Under a candidate-only rule that agent
would receive the verdict that sent it back but none of the evidence gathered against the commit it is
about to revise. The wider rule is still literal, still deterministic, and bounded by revision count.

### 4.5 The conversation bound

One cap, on one class:

```text
CONTEXT_BUNDLE_MESSAGE_LIMIT = 50
```

The most recent 50 task-scoped, participant-visible messages, selected in descending
`(created_at, id)` order and emitted ascending, with `total` and `truncated` stated alongside.

This is not relevance. It is literal task scope, plus participant visibility, plus recency. And it gives
architectural teeth to the report's promotion rule: a message that must survive as project memory should
have become a finding, a blocker, a proposal, or a decision — all of which are in the bundle uncapped.

The cap is part of the **selection function**, not a presentation detail. Changing it changes what a stored
bundle would have been, so changing it bumps `bundle_contract_version` (§6.4).

### 4.6 Ordering is a total order over stored values

Determinism requires that two assemblies over identical state produce byte-identical JSON, which requires a
**total** order — not merely a sorted-by-time order.

| Collection | Order |
|---|---|
| `messages` | `(created_at, id)` ascending, after the descending window selection |
| `decisions` | `(created_at, id)` ascending |
| `proposals` | `(created_at, id)` ascending |
| `blockers` | `(created_at, id)` ascending |
| `reviews` | `(created_at, id)` ascending |
| `review_findings` | `(created_at, id)` ascending, nested inside their review |
| `verifications` | `(created_at, id)` ascending |
| `check_policy_overrides` | `(created_at, id)` ascending |
| `acceptance`, `checks` | stated policy/task order, never sorted |

`created_at` is ISO-8601 with millisecond precision (`collab/service.ts:88-90`) and ids carry a random
UUID suffix (`collab/service.ts:92-94`), so two rows written inside one millisecond are ordered
arbitrarily — but *stably*, because the tiebreak reads stored values only. Sub-millisecond arrival order is
not recoverable from `messages`, which has no monotonic column. §13.2 records the alternative that was
rejected and why.

Array order is meaningful everywhere it appears, which is exactly the rule `canonicalJson()` already
encodes: keys sorted, arrays left alone (`collab/dispatch.ts:196-203`).

### 4.7 No clock in the hashed content

The bundle contains no value derived from reading the clock at assembly time: no `assembled_at`, no
"expires in", no relative recency, no evaluated liveness flag. Stored timestamps are stored values and are
fine; a *comparison against now* is not, because it would make the digest move with no canonical change
behind it. `lease.expires_at` is therefore carried raw, without the `live` boolean the dispatch basis
carries (`collab/dispatch.ts:149-153`) — that evaluation belongs to derivation, and derivation's answer is
already in the action descriptor the bundle embeds.

---

## 5. Bundle v1 content

One deterministic task-context shape for all four action kinds. Not four shapes, and not an action-specific
relevance filter — that is where semantic routing grows back. A reviewer receiving the pinned check policy
is not harmed by it; a per-action selector is a decision function nobody can audit.

```text
ContextBundle                       -- hashed content, contract version 1

  agent_id
  role                              implementer | reviewer | verifier
  action                            the DispatchActionDescriptor, verbatim
                                    (kind, terminal_operation, task_id, task_version,
                                     repository_identity, base_commit, candidate_commit?,
                                     review_id?, check_ids?, dispatch_contract_version,
                                     basis_digest)

  task                              { status, goal, acceptance[], candidate_commit }
  roles                             { implementer, reviewer, verifier }
  lease                             { agent_id, expires_at } | null
  check_policy                      { identity, checks: [ { id, argv[] } ] }

  decisions[]                       accepted; task_id = this task OR NULL
                                    { id, task_id, statement, rationale, actor, created_at }
  proposals[]                       revealed; this task
                                    { id, agent_id, content, status, created_at }
  blockers[]                        open; this task
                                    { id, raised_by, description, created_at }
  reviews[]                         every review on this task
                                    { id, requester, reviewer, commit_sha, verdict,
                                      created_at, submitted_at,
                                      findings: [ { id, raised_by, severity, location,
                                                    description, status, created_at } ] }
  verifications[]                   over the review commit set
                                    { id, commit_sha, command_argv[], check_id,
                                      check_policy_identity, exit_code, runner, created_at }
  check_policy_overrides[]          over the review commit set
                                    { id, candidate_commit, check_policy_identity,
                                      actor, reason, created_at }
  conversation                      { limit, total, truncated, messages: [
                                      { id, sender, recipient, body, created_at } ] }
```

**No field appears twice.** The action descriptor is the single statement of every fact it already carries,
which is why `task` omits `id`, `version`, `repository_identity`, and `base_commit`. Reusing
`DispatchActionDescriptor` verbatim also settles a class of mistakes for free: it structurally cannot carry
a session id, a dispatch row id, or an issuance timestamp, because step 8 already refused to put them there.

### 5.1 Literal content, not source ids alone

The bundle stores the delivered values, not just the identifiers of the rows they came from.

Several included rows are mutable after delivery: `reviews.verdict` and `reviews.reviewer`
(`collab/service.ts:1311`), `review_findings.status` (`collab/service.ts:1396`), `blockers.status`
(`collab/service.ts:1206`), `decisions.status` (`collab/service.ts:1153`), `proposals.visibility`
(`collab/service.ts:1122`). Storing `review-123` and replaying it later would show today's verdict, not the
one the agent read. That is the same reasoning that made `basis_json` a stored basis rather than a
`task_version` (Doc 05 §5.2): the record is historical evidence, and evidence that re-reads current state is
not evidence.

Canonical ids are kept **alongside** the values, so a reader can still join to what the row became.

### 5.2 No source tree

Git commits are the reference to artifact truth. The bundle never serializes files, diffs, shell output,
web results, or model transcripts into SQLite.

This is not only a size argument. Doc 04 states that SCRAPGRID coordinates existing native agent runtimes
and does not replace their terminal, tool, web-search, or file-handling capabilities. Claude, Codex, and
Grok each hold a real worktree and native Git. A bundle carrying `base_commit`, `candidate_commit`, and the
reviewed commit set tells each of them precisely which objects to read, and Git's own content addressing
makes those identities exact. Duplicating bytes into the coordination database would create a second,
divergent copy of the one thing the repository is already authoritative about.

Note also that no verification **output** exists to leak: `verifications` stores argv and an exit code, and
the daemon forwards live output to the requester without persisting it (`collab/service.ts:1402-1420`).

---

## 6. Content identity, and the property that must hold

```text
CONTEXT_BUNDLE_CONTRACT_VERSION = 1
bundle_digest = sha256(canonicalJson(bundle))
```

Reuse `canonicalJson()` and the SHA-256 path step 8 already has (`collab/dispatch.ts:196-207`). Not RFC 8785
conformance, and not a new dependency: one implementation and one versioned contract is the property that
matters, and a second canonicalizer would be a second answer to a question that must have one.

Write the contract as three properties over the selection function `S(agent, task, state)`:

- **P1 — sensitivity.** If `S` differs in content, its canonical serialization differs in bytes. This
  follows from §5.1 (literal values, not ids) plus canonical serialization over the restricted value domain
  of §5. Bundle identity is the SHA-256 digest of those bytes, and **collision resistance is assumed** for
  identity purposes. It is not injectivity: no fixed 256-bit function is injective over arbitrary-length
  input, and a contract that claimed otherwise would be claiming something false. What the suite asserts is
  that each concrete sensitivity mutation moves the digest, not that no collision exists.
- **P2 — stability.** If `S` is unchanged, the digest is unchanged. This follows only from what is
  *excluded*: no clock (§4.7), no counters, no presence, no delivery metadata, no row-order dependence.
- **P3 — non-interference.** No change visible to `S` and invisible to `DispatchFacts` may alter the
  dispatch. This is structural rather than statistical: `deriveDispatchResult()` takes `DispatchFacts` and
  nothing else (`collab/dispatch.ts:168-194`), that record contains no message, decision, proposal, or
  bundle, and §2 forbids context from reaching `basis_json` or the dispatch idempotency key. P3 is why the
  bundle can move while the obligation stands still.

P1 and P2 are properties of the digest. P3 is a property of the *boundary between* step 8 and step 9, and it
is the one the header's context-only class rests on. §3 and §4 are the argument that `S` is the right
selection; §6.2 is the enumeration that makes all three checkable.

**P3 is not the claim that a bundle change implies dispatch stability.** Most canonical changes move both,
and are supposed to: `task.claim` changes the task version, the status, and the lease, so the next dispatch
is a different obligation with a different basis, and a `dispatches.id` that survived it would mean step 8
had stopped observing the workflow. P3 constrains only the direction step 9 could break — context leaking
into derivation — and says nothing about workflow changes moving both records at once.

### 6.1 Two agents, two digests

`agent_id` and `role` are inside the hashed content, so two agents on one task in one state produce
different digests. That is correct: visibility is per-recipient, so content identity is per-recipient. What
the digest deliberately does *not* depend on is the session, which is what makes §7.1's third case work.

### 6.2 Change classes, enumerated

Every mutating operation in `collab/operations.ts`, against agent `A` on task `T`, on **two independent
axes**: does it change the bundle selection `S`, and does it change step 8's `DispatchFacts`? Collapsing
those into one column is what produced revision 1's impossible test obligation. This is the step 9 analogue
of Doc 05 §1's operation table, and it is the table §12 is written from.

`Class` is the header's three-way split: **C** context-only, **W** workflow, **N** neither. `N*` marks a row
that moves neither axis while moving delivery identity, which §7.1 governs rather than this table. `MAY` means the
`DispatchFacts` answer depends on state the operation does not itself determine, and a row whose facts answer
is `MAY` therefore carries a **conditional class**, written `C or W`: it lands in `W` on the branch where
facts move and in `C` on the branch where they do not. Both branches are stated in the reason, and §12
requires both to be tested.

| Operation | Bundle `S` | `DispatchFacts` | Class | Why |
|---|---|---|---|---|
| `sync` | no | no | N | writes `agents.last_seen_at` only (`collab/service.ts:859`); presence is excluded (§3) |
| `session.open` / `close` / `replace` / `heartbeat` | no | no | N* | neither axis moves, but delivery identity does: a replacement session is a new dispatch row and a new bundle row at the *same* digest (§7.1). Liveness gates issuance, not derivation |
| `worktree.bootstrap` | no | no | N | `managed_worktrees` excluded (§3) |
| `task.create` | no | no | N | another task; per-task independence (§4.1) |
| `proposal.submit` on T | no | no | N | sealed proposals are invisible (§4.3) |
| `decision.propose` | no | no | N | only `accepted` decisions are selected |
| `decision.accept`, another task | no | no | N | task scope |
| `message.send`, T, between the other two agents | no | no | N | participant visibility (§4.2) |
| `message.send`, no task | no | no | N | untargeted messages are excluded (§4.1) |
| `dispatch.derive` | no | no | N | read-only, writes nothing |
| `dispatch.issue` | no | no | N | required by §6.3 |
| **`message.send`, T, A is sender or recipient** | **yes** | **no** | **C** | enters the window, may evict the oldest; no message is a `DispatchFacts` field |
| **`proposal.reveal` on T** | **yes** | **no** | **C** | the revealed set changes for every recipient; acceptance never consults proposals |
| **`decision.accept`, task = T or NULL** | **yes** | **no** | **C** | durable project truth (§4.1); decisions are a parallel track, not an acceptance gate |
| `task.assign_roles` on T | yes | yes | W | `roles` and `role` are read by both |
| `task.claim` on T | yes | yes | W | status, version, lease |
| `blocker.add` / `blocker.resolve` on T | yes | yes | W | open-blocker set and task status |
| `review.request` on T | yes | yes | W | candidate, pending review, status, version |
| `review.submit` on T | yes | yes | W | verdict; on `needs_revision`, status, version, candidate, reservation |
| `check_policy.override` on T | yes | yes | W | `override_id`, and the gates the override waives |
| `finding.add` / `finding.resolve` on a review of T | yes | **MAY** | **C or W** | `W` only where the finding reaches the gaps dispatch currently consumes: blocking, open, on a review at the *current candidate*, with the task scoped (`collab/service.ts:1630`, `428-437`). A `non_blocking` finding, or a blocking one on an earlier review, changes no fact — the gap query joins on `review.commit_sha = candidate` — so it is `C` |
| `verification.run` at a commit in T's review set | yes | **MAY** | **C or W** | `W` where a passing required check at the current candidate closes a gap. A failing run, or any run at an earlier reviewed commit, changes no fact and is `C` |
| `task.accept` on T | n/a | yes | W | terminal; dispatch returns `none`, so no bundle is issued (§7.3) |

**The C class is the whole reason step 9 exists.** Three operations are *unconditionally* C — they move what
an agent should know while leaving its obligation identical, and step 8 has no way to express any of them.
The two conditional rows contribute further C branches, which is why they are the rows most likely to be
implemented as though they were purely W. Everything else either moves both records — which is ordinary, and
which the W class exists to stop anyone from testing as a defect — or moves neither, with the single `N*`
row moving delivery identity alone.

Four rows are the ones worth attacking in review. `sync` mutates on every call and must still be inert.
`dispatch.issue` must be inert or §6.3 fails. And the two `MAY` rows are where a plausible implementation
gets the class wrong: `verification.run` looks like a pure workflow mutation, but a failing check at the
candidate changes the evidence in the bundle while leaving every `DispatchFacts` field — including `gaps` —
exactly as it was, which makes it behave as class C in that branch.

### 6.3 The fixpoint requirement

**Nothing the act of issuing a bundle mutates may appear in a bundle.**

`issueDispatch()` writes an `operation_attempts` row, a `dispatches` row on first delivery, a
`dispatch_issued` event, and — under step 9 — a `context_bundles` row (`collab/service.ts:1822-1888`). If any
of those were selected into the content, then issuing bundle `B₁` would change the selection, so the next
issuance would compute `B₂ ≠ B₁`, and the one after that `B₃`, forever. Idempotency would be unreachable by
construction, two agents polling the same task would churn each other's digests, and the "same context →
same bundle" case in §7.1 could never be observed.

This single requirement is why `dispatches`, `operation_attempts`, `events`, and **`context_bundles`
itself** are excluded from §3, and it is a stronger reason than tidiness. `context_bundles` does not exist at
schema version 9, so it has no row in §3's table; naming it here is what stops a later reader from concluding
that a table absent from that table was merely overlooked. A bundle that carried the bundle history of its
own dispatch would be the purest form of the defect. It is also the sharpest available argument against ever letting the
bundle grow "what I was told last time" — that is a self-referential field, and self-reference is what
breaks the fixpoint.

### 6.4 What the contract version covers

`bundle_contract_version` names the **selection function and the shape together**, for the same reason
`dispatch_contract_version` names the derivation (Doc 05 §5.1): stored content only explains a delivery if
the function that produced it is known. Bump it when any of these change — the included tables, the
visibility predicates, the ordering rules, the message cap, or the field shape. Do not bump it for a
formatting change that cannot alter the digest, because there is no such thing: a formatting change that
cannot alter the digest is not a change.

---

## 7. The durable record

```sql
CREATE TABLE context_bundles (
  id                      TEXT PRIMARY KEY,
  dispatch_id             TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  bundle_contract_version INTEGER NOT NULL,
  bundle_json             TEXT NOT NULL CHECK (json_valid(bundle_json)),
  bundle_digest           TEXT NOT NULL,
  created_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX context_bundles_content
  ON context_bundles(dispatch_id, bundle_contract_version, bundle_digest);
CREATE INDEX context_bundles_dispatch ON context_bundles(dispatch_id, created_at);
```

A row is **one distinct bundle-content record for one dispatch**, not one delivery.
`(bundle_contract_version, bundle_digest)` is the content identity, and because context that changes and
later reverts lands back on the earlier row (§7.2), the count of rows is a count of distinct things said
rather than a count of times they were said. The delivery *occurrence* is the `dispatch.issue` operation
attempt and its `dispatch_issued` event, which are written every time (§7.2). `bundle_json` stores the canonical serialization, immutable, never read as current authority —
the same standing `basis_json` has (`collab/schema.ts:186-192`).

No `context_sources`, no `bundle_members`, no `bundle_revisions`, no join table per included class. Pilot
002 needs to reconstruct what was delivered and to whom; a normalized graph of it would be a schema for a
question nobody has asked yet.

### 7.1 Delivery identity versus content identity

```text
same session, same workflow basis, same visible context
    → same dispatch row          (step 8 idempotency)
    → same bundle row            (this index)

same session, same workflow basis, NEW visible context
    → same dispatch row
    → NEW bundle row             ← the case §2 exists for

replacement session, same workflow basis, same visible context
    → NEW dispatch row           (step 7 attribution, Doc 05 §5.1)
    → NEW bundle row
    → SAME bundle_digest         ← delivery differs, content does not
```

The third case is the one that pays for keeping the session out of the hashed content. A reader can ask
"was the replacement told the same thing?" and answer it by comparing two hex strings, rather than diffing
two JSON blobs and hoping key order was stable.

### 7.2 A reused row is not a lost delivery

Content-keyed idempotency means a re-poll over unchanged context returns the existing row, and it also means
context that changes and then reverts — a blocker opened and resolved — lands back on the earlier row with
its earlier `created_at`. That is deliberate, for the same reason step 8 refuses to be a poll log: recording
every derivation would bury the causal record under write amplification.

Per-issuance delivery is not lost, because it lives where it already lives. `issueDispatch()` opens an
`operation_attempts` row and writes a `dispatch_issued` event on **every** action issuance, including the
idempotent path (`collab/service.ts:1876-1884`). Step 9 adds `context_bundle_digest` and
`context_bundle_id` to that event payload. Then "every poll" is reconstructible from the ledger, and
"every distinct thing said" is reconstructible from `context_bundles`, and neither table is doing the
other's job.

### 7.3 No bundle without a dispatch

A bundle is written **only** where a dispatch record is written: an `action` result delivered to a
deliverable session (Doc 05 §5). `waiting`, `blocked`, `none`, and `indeterminate` carry no obligation to
carry out, so they carry no context to carry it out with. `dispatch.derive` writes nothing and returns no
bundle (§10.1).

This also means `NOT NULL` on `dispatch_id` is honest rather than convenient: a bundle with no dispatch
would be a context artifact with no action, no recipient obligation, and no way to attach to work.

---

## 8. Closing the causal loop

Step 8 established `dispatch D → terminal operation O`. Step 9 wants the middle term:

```text
dispatch D  →  context bundle B  →  terminal operation O
```

One nullable column, mirroring `operation_attempts.dispatch_id` exactly:

```sql
ALTER TABLE operation_attempts ADD COLUMN context_bundle_id TEXT REFERENCES context_bundles(id);
CREATE INDEX operation_attempts_bundle ON operation_attempts(context_bundle_id);
```

Same philosophy: **advisory provenance, never workflow authority.**

```text
context_bundle_id supplied
   → resolve the bundle's own dispatch row
   → attach only if that dispatch matches
        agent_id            (the authenticated principal)
        task_id             (the operation's RESOLVED task, Doc 05 §5.4)
        terminal_operation  (the operation being invoked)
        task_version        (the generation in the dispatch's basis_json)
   → otherwise record NULL, and do not reject the operation
```

The bundle is validated **through its own `dispatch_id`**, not through the separately echoed one. The two
columns then stay independently truthful: `dispatch_id` is the dispatch the caller claims to be executing,
`context_bundle_id` is the context the caller claims to have worked from. They will normally agree, and
where they disagree the record says so rather than silently reconciling them. Nothing is inferred: if only a
bundle is echoed, `dispatch_id` stays NULL, and the dispatch is still reachable by joining
`context_bundles.dispatch_id`.

### 8.1 An older bundle from the same generation must attach

Codex receives `B₁`, a message arrives, `B₂` is generated, and Codex — having actually worked from `B₁` —
echoes `B₁`. **Record `B₁`.**

Rewriting that to "the latest bundle" would destroy exactly the evidence Pilot 002 exists to collect: *how
often an agent misunderstands its task or receives stale or incomplete context* is a pre-registered evidence
signal in Doc 04. A harness that quietly upgrades stale provenance to current provenance cannot measure
staleness.

A bundle from an **earlier revision generation** fails attachment automatically, and needs no new rule: its
dispatch fails the `task_version` clause Doc 05 revision 6 added. So the separation is clean —

```text
dispatch generation  =  authority and retry safety
bundle identity      =  what shared information was actually delivered
```

— and the second is allowed to lag the first within one generation, because that lag is a real thing that
happens to real agents.

---

## 9. Assembly happens inside the issuing transaction

`issueDispatch()` already runs inside `domainTransaction()`, which opens `BEGIN IMMEDIATE`
(`collab/service.ts:164-166, 1835`). Reads inside one SQLite transaction see one consistent database
snapshot, and `BEGIN IMMEDIATE` takes the write lock at the start, so no other writer can interleave between
the derivation and the bundle assembly.

Three consequences, all required rather than merely convenient:

1. The bundle and the dispatch basis describe **the same instant**. A bundle whose reviews were read after
   another agent's `review.submit` landed, but whose action descriptor was derived before it, would be an
   artifact that never existed.
2. The single captured `at` that step 8 uses for every expiry comparison (Doc 05 §3.12) is the same instant
   the bundle is assembled at, so `lease.expires_at` in the bundle and `lease.live` in the basis cannot
   contradict each other.
3. Assembly must not perform I/O. No Git reads, no file reads, no subprocess. Every field comes from a row
   already committed to SQLite. This keeps the write lock short and keeps §5.2 structurally true rather than
   merely intended.

---

## 10. Proposed operations

### 10.1 Extend the result, do not add a surface

`dispatch.issue` already means: *I am this authenticated model, I am taking up this explicit task, derive
the current obligation, record that it was delivered to me.* Context delivery is the second half of that
same sentence.

```text
dispatch.issue { agent, task }
    { result, dispatch }                      →  { result, dispatch, context_bundle }
```

`context_bundle` is `null` on every non-`action` result, exactly as `dispatch` already is
(`collab/service.ts:1859-1866`). No new authorization metadata: `{ mutating: true, session: true,
identity: 'agent' }` is unchanged, because the recipient is the authenticated session and the content is
selected for that agent.

There is deliberately **no** `context.next`, `context.build`, `context.refresh`, and no context daemon. A
bundle built outside an issuance would have no dispatch to belong to, no recipient obligation, and nothing
to attach to work — §7.3.

### 10.2 Echo on the terminal operation

The four terminal operations already accept `dispatchId` (`collab/operations.ts:313, 394, 405, 452`). Add
`contextBundleId` beside it, with a `--bundle ID` CLI flag beside `--dispatch ID`. Optional, validated,
advisory (§8).

### 10.3 What does not change

`snapshot()` gains `context_bundles`, alongside the `dispatches` it already lists
(`collab/service.ts:843`), because reconstruction reads from there.

**`sync()` is not touched.** It is older, general, per-agent coordination recovery with an event cursor; a
bundle is a specific, immutable, per-dispatch, per-task artifact. They overlap, and the overlap is not a
defect to fix before there is evidence about which one agents actually use. Whether `sync` becomes redundant
is a Pilot 002 question, and answering it now would be exactly the speculative generalization Doc 04's
stopping rule forbids.

---

## 11. Named anti-goals

These are **not** tradeoffs to be balanced. They are out of scope by name, and a proposal that reintroduces
one is rejected on that basis rather than argued on merit:

semantic summarization; LLM-generated summaries; embeddings or vector retrieval; relevance scoring or
ranking; context inside `dispatch.basis_json`; context in the dispatch idempotency key; source-file, diff,
or patch duplication into SQLite; model or runtime transcript capture; shell output capture; web-search
results; attachments; task ranking, scheduling, or automatic task selection; model-specific prompt
construction or templating; token-budget optimization; an "important message" detector; MCP adapters;
generalized long-term-memory machinery.

The bundle is a **deterministic projection of existing shared truth**. It is not a memory architecture, and
the moment it acquires a scoring function it stops being reconstructible by identity.

---

## 12. Test obligation

Written directly from §6.2, one obligation per class, because a single assertion applied to every
bundle-changing operation is exactly what revision 1 got wrong.

1. **Class C — context-only (P1 + P3).** For each **C** row: construct the state, issue, apply the change,
   issue again from the same session, and assert the digest **differs** while `dispatches.id` and
   `dispatches.basis_digest` are **unchanged**. Additionally assert that `dispatch.derive` returns an
   identical result across the change, modulo `derived_at`. That pairing is the load-bearing property made
   executable: a test asserting only that the digest moved would pass on a design that also manufactured a
   new dispatch, which is the failure §2 exists to prevent.
2. **Class W — workflow.** For each **W** row: apply the change and assert that the bundle reflects the new
   state, that a non-`action` result writes **no** bundle (§7.3), and that the recorded `basis_digest` for
   the resulting state equals the value the step 8 suite already pins for that state. Do **not** assert that
   `dispatches.id` is unchanged — for most of these it must change, and requiring otherwise would assert
   step 8 is broken. The direction under test is only that step 9 never *causes* dispatch movement, which is
   why the assertion is on the step 8 basis rather than on the absence of a new row.
   For the two conditional rows, test **both** branches and assert the class each actually lands in rather
   than assuming the operation's usual one. For findings: a blocking finding on the review at the current
   candidate is W; a `non_blocking` finding is C; and a blocking finding on an **earlier** review is also C —
   the bundle carries it as revision history (§4.4) while `acceptanceGaps()` never sees it, because the gap
   query joins on `review.commit_sha = candidate`. For verification: a passing required check at the current
   candidate is W, a failing run at that same commit is C, and any run at an earlier reviewed commit is C.
3. **Class N — neither (P2).** For each **N** row: apply the change **from the same session** and assert the
   digest is byte-identical, the same `context_bundles.id` is returned, and no new `dispatches` row appears.
   `sync` and `dispatch.issue` are the two that matter most — the first mutates on every call, the second
   must satisfy §6.3. The `N*` row is the exception the qualifier exists for: session replacement is
   governed by obligation 6 below, which asserts new rows at an unchanged digest rather than no new rows.
4. **Visibility.** A Claude→Grok message on `T` does not change Codex's digest. A sealed proposal does not.
   A decision accepted against another task does not. An untargeted message does not.
5. **Determinism.** Assemble twice over unchanged state and assert byte-identical `bundle_json`, not merely
   equal digests — this catches a key-order or array-order regression at the point it happens.
6. **Delivery versus content.** Replace the session under unchanged state: assert a new `dispatches` row, a
   new `context_bundles` row, and an **equal** `bundle_digest`.
7. **Window boundary.** With more than `CONTEXT_BUNDLE_MESSAGE_LIMIT` visible messages, assert `truncated`,
   assert `total`, and assert the window is the most recent by the stated total order.
8. **Attachment.** An older bundle from the same generation attaches. A bundle whose dispatch is from an
   earlier generation does not. A bundle belonging to another agent or another task does not. An absent,
   unknown, or malformed id costs provenance and **never** work — assert the domain mutation still succeeds.
9. **No I/O.** Assert bundle assembly performs no repository read, so §5.2 cannot erode into "just this one
   diff".

---

## 13. Challenges to this design

Recorded so review can attack them directly rather than rediscover them.

1. **Only conversation is capped.** Decisions, blockers, reviews, findings, verifications, and overrides are
   uncapped, so bundle size grows with durable record count. Defended: those classes grow with *coordination
   events*, which the promotion discipline is meant to keep small, and capping durable truth would mean
   silently withholding an accepted decision — a far worse failure than a long bundle. The honest residual is
   that a task with thirty revision cycles produces a large bundle. Pilot 002 should measure bundle size
   rather than this document guessing a limit.
2. **`messages` has no monotonic key.** Ordering falls back to `(created_at, id)` with a random id tiebreak
   (§4.6). The rejected alternative was ordering messages by their `message_sent` row in `events`, which
   does carry `INTEGER PRIMARY KEY AUTOINCREMENT` (`collab/schema.ts:228-237`). Rejected because ordering
   would then depend on the causal ledger, making the bundle's content a function of a table §6.3 requires
   it to exclude. Adding a monotonic column to `messages` is the clean fix and is a schema change to an
   existing table for a marginal gain; parked.
3. **Untargeted messages are invisible to bundles (§4.1).** The human's habit of sending unscoped remarks is
   real, and under this contract those never enter a bundle. Two honest exits for review: accept it, with
   `sync` as the untargeted channel and the promotion rule as the remedy — **recommended** — or scope the
   human's messages differently from agents', which introduces a per-sender rule this contract otherwise has
   none of.
4. **`agent_id` and `role` are inside the hash, so bundles are per-recipient.** This means three agents on
   one task in one state produce three digests and three rows, and a reader cannot ask "what was the context
   on `TASK-42`?" without naming an agent. Defended: there is no such thing as the context on a task, only
   the context each participant could see, and pretending otherwise would require ignoring §4.2.
5. **The bundle duplicates a few basis fields.** `task_version` and `candidate_commit` appear in both
   records. Retained: they are two artifacts with two readers and two change rates, and merging them would
   put context in `basis_json` — the exact thing Doc 05 §8.6 recorded a boundary to refuse. The duplication
   is bounded to the action descriptor, which is embedded verbatim rather than restated.
6. **Two writes per issuance instead of one.** Bounded by content change rather than by polling: an agent
   polling an unchanged task writes neither a dispatch nor a bundle row, only the ledger entry it already
   wrote at step 8.
7. **`sync` and bundles now overlap (§10.3).** Two paths to overlapping information is a real smell. Parked
   deliberately until Pilot 002 shows which one agents actually use; collapsing them now would be a redesign
   of a working surface on the strength of an aesthetic preference.
8. **The bundle can be right and still insufficient.** Nothing in this contract guarantees an agent has
   enough information to do good work — only that what it was given is exactly reconstructible. That is the
   correct scope: sufficiency is a Pilot 002 measurement, and it is already a pre-registered evidence signal.

---

## 14. What this document does not do

It does not implement anything, migrate the schema, or advance the charter. Step 9 remains **NEXT**. The
schema in §7 and §8 is a proposal for review, not a migration. No code is written until §4 and §6 survive
review.

It does not change `sync()`, does not touch `basis_json`, does not alter step 8's derivation, result
contract, or idempotency, and does not anticipate step 10 beyond the reconstruction criterion Doc 04 already
states.
