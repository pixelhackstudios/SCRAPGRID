# Collaboration Harness Current State

**Status date:** 2026-08-10

**Repository baseline:** `9794626` (`main`, synchronized with `origin/main` when this document was written)

**Purpose:** Record what SCRAPGRID currently is, what has been demonstrated, and what remains unresolved.

## 1. How to Read This Document

This is a current-state record, not a replacement architecture or a new roadmap.

- [01 — AI Collaboration Report](./01-AI-Colloboration-Report.md) remains the architectural starting point.
- [02 — Collaboration Harness Implementation Plan](./02%20-%20Collaboration%20Harness%20Implementation%20Plan.md) remains the historical implementation plan and phase model.
- [04 — Pilot 002 Implementation Charter](./04%20-%20Pilot%20002%20Implementation%20Charter.md) is **authoritative for Pilot 002 preparation**. Where this document and the charter disagree about what happens next, the charter governs.
- This document reconciles those intentions with the repository and Pilot 001 as they exist now.

The implementation did not follow the original phase order exactly. The CLI collaboration core and Git truth work were followed by a thin HTTP bridge and a React field terminal before an authoritative daemon was built. A real three-model pilot was then completed using the CLI-first system. The ten-step charter was written afterward to replace ad-hoc sequencing, and steps 1 through 8 have since been implemented and accepted in order.

Two kinds of claim appear throughout, and they are not interchangeable:

- **the harness now implements** — grounded in the repository at this baseline and covered by the automated suite;
- **Pilot 001 demonstrated** — grounded in a real three-model run completed on the older CLI-first system.

Several capabilities described in section 3 did not exist when Pilot 001 ran. Nothing in section 5 should be read as evidence for them.

## 2. Executive State

SCRAPGRID is a working local collaboration harness in which one daemon owns canonical mutation:

```text
 collab CLI (codex)  ─┐  codex session credential
 collab CLI (claude) ─┤  claude session credential
 collab CLI (grok)   ─┤  grok session credential
                      ├──▶  collabd  ──▶  CollaborationService  ──▶  SQLite
 collab CLI (human)  ─┤     127.0.0.1     invariants and authority     sole writer
     control credential
 field terminal     ──┘
     field-terminal credential
```

`collabd` is the only process that opens the collaboration database. The CLI and the browser are both clients of it, and `CollaborationService` remains the single place workflow authority is enforced.

Each model now reaches the daemon as an authenticated collaboration session bound to its durable agent identity, rather than through a shared daemon credential. The daemon's own credential is the local control and bootstrap credential: it establishes and recovers sessions and carries human authority, and it can no longer act as any model.

The backend persists and enforces a complete small-task collaboration flow:

```text
create task (pins base commit + required-check policy)
  → human assigns implementer, reviewer, and verifier
  → submit sealed proposals
  → human reveals proposals
  → agents exchange messages
  → propose and accept a decision
  → implementer claims the task under a lease
  → request review for an immutable candidate commit
  → designated verifier independently verifies that exact commit
  → record review findings and verdict
  → needs_revision reserves the next claim for the original implementer
  → human accepts the task against the evidence
```

The frontend is a live, chronological view of that backend state. It is best understood as a **collaboration field terminal**, not a dashboard and not a general-purpose chat client. Messages, decisions, claims, Git candidates, reviews, findings, verification results, and human actions share one task-filterable activity channel.

Canonical state now also derives what each agent is obliged to do next. The dispatcher is deterministic and deliberately narrow: it reads canonical rows and reports the single permitted action per (agent, task), or reports why there is not one. It ranks nothing, selects no task, and constructs no context.

The system is coherent, daemon-owned, session-authenticated, and deterministically dispatched, but it is still not the full architecture described in the original report. There is no context-bundle identity, no MCP adapter, no complete human control plane, and no agent launching or scheduling. Session liveness is deliberately not model-process liveness: a live session means an authenticated identity has communicated recently or currently has accepted work in flight, not that SCRAPGRID has proven a Claude Code, Codex, or Grok process is running.

## 3. What Exists in the Repository

### 3.1 Durable collaboration model

The SQLite schema is at version 9 and stores:

- stable human and model identities;
- authenticated model collaboration sessions, holding a hash of each bearer credential rather than the credential itself;
- project state and repository binding;
- tasks with optimistic versions, immutable base commits, and a pinned required-check policy;
- temporary task roles (implementer, reviewer, verifier);
- exclusive time-bounded leases;
- revision claim reservations;
- directed messages;
- sealed and revealed proposals;
- proposed and accepted decisions;
- blockers;
- reviews and review findings;
- verification records with exact argument vectors and check identity;
- candidate-scoped human check-policy overrides;
- managed worktree registrations;
- dispatch records, holding the action delivered to one session for one task, the contract version that derived it, and the immutable basis it was derived from;
- operation attempts, recording accepted, rejected, failed, and abandoned outcomes, and the dispatch that caused each one where the agent echoed it;
- an append-only event timeline carrying the `operation_id` that caused each event.

The database is bound to one Git object database using a repository identity derived from its common Git directory and object format. This prevents a collaboration database from being casually reused against a different repository.

One current session per model agent is enforced by a partial unique index rather than by whichever code path happens to open one, so exclusivity is a property of the database instead of a convention in the service.

### 3.2 Operation boundary and causal ledger

Every mutating coordination operation opens an attempt row before its domain transaction and closes it afterward. The six read operations bypass the ledger, matching the service methods they call; `session.heartbeat` and `dispatch.derive` are among them precisely so presence and polling never flood the causal record. Attempt bookkeeping lives outside the rolled-back domain transaction, so a rejection or failure is still recorded when its mutation is discarded, and a successful operation commits its outcome atomically with the domain rows and events it produced. Events carry the `operation_id` that caused them, so a completed task can be reconstructed causally rather than by timestamp correlation.

An attempt left unfinished by a crashed writer is resolved as `abandoned` with reason `daemon_restart` the next time a daemon acquires ownership.

### 3.3 Service-enforced invariants

`CollaborationService` is the authority for workflow transitions. The daemon's CLI and HTTP surfaces both delegate to it rather than reimplementing the state machine.

Implemented gates include:

- task claims use an expected version and fail closed on stale state;
- a live lease prevents a competing agent from claiming the same task;
- roles are human-assigned, task-scoped, and require three distinct enabled model agents;
- roles must be assigned before implementation begins and cannot be reassigned afterward;
- only the designated implementer may claim a task or request review;
- only the designated reviewer may submit a verdict or file findings on that task;
- only the designated verifier may record verification for that task;
- a `needs_revision` verdict reserves the next claim for the original implementer for one hour without granting an execution lease;
- each agent may submit only one proposal per task;
- sealed proposal content is not exposed before a human reveal;
- only a human may assign roles, reveal proposals, accept decisions, override check policy, or accept tasks;
- a review request must come from the task owner while its lease is still live;
- candidate commits must exist, be reachable from repository refs, and descend from the task base commit;
- the requester cannot review its own candidate;
- the task owner cannot supply the verification evidence that satisfies acceptance;
- only a finding's author or a human may resolve it;
- acceptance requires an approved review from the designated reviewer for the exact candidate;
- acceptance requires passing verification from the designated verifier for the exact candidate, run by someone other than the implementer, and this requirement holds even when the named-check policy has been overridden;
- acceptance requires every named check in the task's base-pinned policy to have passed for that candidate under the same policy identity, unless a candidate-scoped human override is recorded;
- open blockers and open blocking findings prevent acceptance;
- task acceptance also uses an expected version to reject stale human actions.

Non-blocking review findings may remain open when a task is accepted. This is current service policy, not an omission in the UI.

### 3.4 Required-check policy

`.scrapgrid/checks.json` is read from the task's base commit at creation time. The task stores both the parsed policy and the Git blob identity of the file that produced it, so later edits to the policy cannot retroactively change what a task requires. Verification evidence carries the same identity, and acceptance matches on it.

If a valid base policy is operationally broken, the human may record a candidate-scoped, reason-bearing override after the candidate enters review. The override waives the named checks for that candidate only. It does not waive independent verification.

### 3.5 Git truth and isolated verification

The Git layer provides:

- repository discovery and durable repository identity;
- full commit resolution and rejection of invented, missing, non-commit, unreachable, or foreign SHAs;
- candidate-descends-from-base validation;
- blob reads at an exact commit for policy pinning;
- stable `collab/grok`, `collab/claude`, and `collab/codex` worktree branches;
- verification in a temporary detached worktree at the exact requested commit;
- exact argument-vector execution with no shell interpolation;
- recorded commit, command arguments, check identity, runner, exit code, and timestamp.

Checks execute inside `collabd`. The process that records an exit code is the process that observed it, so a client cannot submit evidence it did not produce. Output streams back to the terminal that requested the run, and `collab verify` exits with the check's own exit code.

Verification proves the recorded command's exit status at an immutable commit. It does not by itself prove test completeness or environmental reproducibility.

### 3.6 Daemon ownership

`collabd` establishes singleton ownership through an exclusive lock file before opening the database. A lock whose recorded process is still alive fails a competing start closed; a lock naming a departed process is treated as crash residue and taken over.

Shutdown surrenders ownership last: stop listening, drain in-flight operations, close the HTTP server, close the database, drop the discovery file, then release the lock. Draining tracks accepted operations rather than sockets, because a client can disconnect while a check keeps running. A second signal exits immediately instead of unwinding early — a lock outliving a dead process is recoverable residue, whereas a live daemon without a lock is not.

The daemon publishes `.collab/collabd.json` at mode `0600` with its URL, pid, repository identity, schema version, and control credential. Clients verify repository identity and schema before sending anything.

Model sessions are durable and deliberately outlive the process that issued them. A normal restart rotates the daemon's own credentials without invalidating any session, so an agent continues working against the replacement daemon with the credential it already holds.

### 3.7 CLI surface

The CLI is a pure client. It opens no database, constructs no service, and has no fallback path; it resolves a command to one registry operation and sends it to the daemon. It fails closed when the daemon is missing, when its recorded process is gone, when it is bound to a different repository, when it serves a different schema, or when its credential is refused.

Which credential it presents is decided by where it is run. A model running inside its own managed worktree finds the session descriptor the daemon delivered there and is authenticated as itself with no flag; the human running from the main worktree finds none and falls back to the daemon's control credential. `COLLAB_SESSION` names a session descriptor explicitly when a model is not standing in its worktree.

The daemon owns the authoritative operation registry, which validates wire input and maps operation names to `CollaborationService` calls. The CLI separately translates command-line syntax into `{operation, input}` requests; the daemon re-validates every request, so CLI translation cannot bypass service authority. The two can therefore drift in usability — a stale CLI can send a shape the daemon rejects — but not in authority, because nothing reaches canonical state without passing the daemon's own validation.

The registry exposes six read operations (`daemon.info`, `status`, `snapshot`, `agents.list`, `session.heartbeat`, `dispatch.derive`) and twenty-three mutating operations covering session lifecycle, synchronization, worktree bootstrap, task creation, role assignment, claims, proposals, decisions, messages, blockers, reviews, findings, check-policy override, task acceptance, verification, and dispatch issuance.

Each operation declares how it is authenticated: four are control-only (`session.open`, `session.replace`, `session.close`, `worktree.bootstrap`), two require a model session (`session.heartbeat`, `dispatch.issue`), nineteen name the input key whose claimed identity must match the authenticated principal, and one — `dispatch.derive` — uses the bounded `identityOrControl` rule, meaning control may inspect any agent while a session may inspect only itself. That rule exists because the two existing ones cannot express it between them: `control: true` rejects sessions outright, and `identity` compares the claim against the literal `human` a control principal carries.

Every operation answers as a newline-delimited JSON stream: `output` frames as a check produces them, `keepalive` frames across silent stretches, and exactly one terminal `result` or `error` frame. Uniform framing is what allows a long check to hold the connection open without tripping client timeouts.

### 3.8 HTTP surface and credentials

The loopback server exposes:

```text
GET  /api/snapshot                        field-terminal credential
POST /api/operations                      model session or control credential
POST /api/tasks/:id/reveal-proposals      field-terminal credential
POST /api/decisions/:id/accept            field-terminal credential
POST /api/tasks/:id/accept                field-terminal credential
```

`snapshot()` is a side-effect-free serializer over canonical state. It decodes stored JSON, removes the legacy serialized command representation, and redacts the content of sealed proposals. Unlike agent synchronization, snapshot polling does not update `last_seen_at`.

The human mutation handlers remain intentionally thin. They supply the human actor and call the existing service methods, leaving authority and acceptance checks in `CollaborationService`.

`collabd` mints two credentials per start and scopes them separately. The control credential reaches the operation registry and is published in the owner-only discovery file. The field-terminal credential reaches only the snapshot and the human-control routes, and is printed on the daemon's own stdout as a URL fragment rather than written to disk — the page renders agent-authored Markdown, and should not hold the credential that drives every operation. No `/api` route is anonymously callable; credentials are checked before anything else, and browser mutations additionally require a matching `Origin`. Static assets remain unauthenticated because they carry no collaboration state.

The operation route accepts either a durable model session credential or the control credential, and resolves it to a principal:

```text
bearer session credential  →  agent_sessions  →  session_id → agent_id
bearer control credential  →  human
```

The daemon then requires that any identity claimed in the request body match that principal. `--agent codex` and `--from codex` remain in the CLI for clarity, but they are checked rather than believed:

```text
Codex session:   task claim --agent codex     allowed
                 task claim --agent claude    rejected
                 message --from grok          rejected
                 task accept --actor human    rejected
Control:         task accept --actor human    allowed
                 task claim --agent codex     rejected
```

Refusing the last line is what makes the boundary load-bearing rather than decorative: reading the daemon's discovery file is not a way to mutate state as a model.

This is an additional boundary, not a replacement for workflow authority. `CollaborationService` still decides whether an authenticated identity may perform an operation, so proving you are Claude does not let you claim a task assigned to Codex. This is also still not same-user isolation, which loopback cannot provide.

### 3.9 Sessions, heartbeat, and recovery

Each model has at most one current authenticated session. Sessions are durable rows, so they survive daemon restart; the credential is delivered once into the model's own managed worktree at mode `0600` and answers `who am I?`, while the daemon descriptor keeps answering `where is collabd?`. That separation is what lets the daemon's port, pid, and control credential rotate without destroying a model's collaboration identity.

Liveness is a timestamp rather than a history. Any authenticated request from a session refreshes it, and an explicit `session heartbeat` exists for a model with nothing else to say; neither writes to the operation ledger or the event stream. Only `session_opened`, `session_replaced`, and `session_closed` are recorded as events. The stale threshold is fifteen minutes, chosen because frontier coding agents routinely spend minutes inside one turn without touching the daemon, and is configurable through `COLLAB_SESSION_STALE_MS`.

Recovery is deterministic and refuses to create two authorities for one model:

- a session that is merely stale keeps working if its own credential is presented again;
- a stale session with no accepted daemon work in flight may be replaced by a reason-bearing human control operation;
- replacement invalidates the previous credential permanently, so a process that wakes up later fails closed;
- a session with accepted work still in flight is never replaceable, however stale its heartbeat looks.

That last rule reuses the ownership work rather than duplicating it. Step 6 already tracked work the daemon accepted and had not finished, because a client can disconnect while a check keeps running; the same question asked of one session decides whether that session may be replaced. The service holds one probe for that fact, so outward projection cannot contradict the refusal: a session with work in flight reports `work_in_flight: true` and `liveness: live` even when its timestamp is old.

The boundary is enforced after the request body has been read, immediately before authorization and activity registration, with no asynchronous yield in between. An earlier ordering allowed a stale session to authenticate, stall part-way through its body, be replaced while nothing yet protected it, and then resume on the cached principal — which was demonstrated to acquire a lease with a credential that was already dead, and is now covered by a regression.

Recovery is deliberately inert with respect to task authority. A session that goes stale, is closed, or is replaced represents the same durable agent identity, so it does not revoke leases, reassign roles, delete claim reservations, change task owners, alter candidate commits, or remove worktrees. Existing lease TTL, role, and reservation rules continue to govern.

Three concepts are kept separate in the projections, and none of them is a dispatcher state:

```text
agent status    enabled or paused identity
session         live, stale, or none
last heartbeat  a timestamp
```

### 3.10 Deterministic dispatch

The dispatcher answers one question per (agent, task): what does canonical state oblige this agent to do on this task right now? It is a derivation, not a decision. Where canonical state does not yield exactly one permitted action, the result says which kind of absence applies rather than manufacturing a choice.

The dispatchable vocabulary is four actions, and they are a strict subset of the workflow actions:

```text
WorkflowAction   assign_roles | claim | implement | review | verify
               | resolve_finding | unblock | accept
DispatchAction   claim | implement | review | verify
```

An action is dispatchable only when canonical state both shows it must occur for the task to reach `accepted` **and** names exactly which agent must perform it. `resolve_finding` and `unblock` fail the second clause — `resolveReviewFinding()` authorizes the author or any human, and `resolveBlocker()` authorizes any active agent — so the contract reports the unaddressable obligation rather than selecting an addressee. Nothing is dispatched to the human; human obligation is a result, not a dispatch.

Each action carries only identifiers, versions, and commits: no prose, no advice, no ambient conversation. `implement` is folded onto `review.request` as its terminal operation, because canonical state cannot know when an implementation is complete.

A result is one of `action`, `waiting`, `blocked`, `none`, or `indeterminate`. The last is reserved for a derivation that failed to reduce to one action, and is deliberately never collapsed into `waiting` or `none`: when the state table is wrong, the result says the state table is wrong.

Derivation is per (agent, task), never global across agents, and the schema is what makes that total: `task_roles` carries `UNIQUE (task_id, agent_id)`, so one agent holds at most one role on a task, and every dispatchable action is role-gated. Where an agent holds obligations on several tasks, the envelope lists them in a stated non-semantic order and declares it unranked. The API cannot pick one:

- `dispatch.derive {agent, task?}` is read-only, writes nothing, and leaves no ledger entry;
- `dispatch.issue {agent, task}` is mutating, session-bound, and requires an explicit task.

There is no `dispatch.next`, because an operation asked for *the* next action would have to rank tasks that canonical state offers no way to rank. The actor reads its own obligations and names the one it takes up; a harness choosing for it would be a scheduler.

Two properties keep the dispatcher from becoming a second copy of the workflow rules. First, the acceptance gates are enumerated once: `acceptTask()` rejects over the same gap list the `in_review` dispatch rows project onto roles. Second, the lease and reservation expiry comparisons are evaluated once, by shared predicates that both service authority and dispatch consume. The binding guarantee is one-way and is asserted per row in the suite:

```text
dispatcher returns ACTION  ⇒  the terminal operation is permitted now
service operation succeeds ⇏  the dispatcher must have returned ACTION
```

Legal is not due, and the inverse is deliberately not asserted: the service permits many things at once, which is exactly why dispatchability is narrower than permission.

Dispatch mirrors the service's own asymmetries rather than helpfully blocking everything. `claimTask()` consults project pause, so a paused project blocks claims; `requestReview()`, `submitReview()`, and `runVerification()` do not, so review and verification proceed under a paused project. A task whose acceptance gaps are empty under a paused project reports that it awaits a resume rather than a human decision.

A durable record is written only when an action is issued to a **deliverable** session, which requires two separate facts: the session is live *and* has no accepted daemon work in flight. Step 7 reports work in flight as liveness, so liveness alone would allow a second action to be issued from pre-completion state while the first is still running inside `collabd`. Because an issuing operation is itself mutating, it registers its own activity before its body runs; the issuance predicate therefore reads a value sampled before that registration, passed through the operation context.

Delivery identity is idempotent while operation history is not. The uniqueness rule is `(session_id, task_id, dispatch_contract_version, basis_digest)`, and the digest covers workflow state alone — no session, no agent, no timestamp. Unchanged state re-polled by the same session returns the existing record; the same obligation reaching a replacement session is a new, separately attributable delivery. That split matches the step 7 identity model: the durable agent owns the workflow, the session owns the delivery. The contract version joins the key so that a change to the derivation rules can re-dispatch state that has not otherwise moved.

The record stores the basis it was derived from, because `tasks.version` cannot stand in for it — verification evidence, approved reviews, findings, overrides, and above all a lease crossing its expiry all change what is dispatchable while bumping nothing on `tasks`. The stored basis holds the lease row together with its evaluated `live: false` fact, not the clock reading that produced it, and one instant is captured per derivation and used for every expiry comparison within it. `basis_json` is immutable historical evidence: it is never read as current authority and never fed back into derivation, and it is expected to disagree with the domain tables over time.

`operation_attempts.dispatch_id` closes the causal loop, turning "told X to do Y" and "X did Y" into a hard edge rather than a timestamp-and-subject join that is ambiguous in exactly the retry cases Pilot 002 measures. The echoed id is validated, never trusted: it attaches only when the referenced dispatch matches the authenticated agent, the operation's **resolved** task, the terminal operation, and the workflow generation. The resolved task matters because `review.submit` records its subject as the review and reaches the task through the review row. The generation matters because agent, task, and operation all survive a review-to-revision-to-re-claim cycle unchanged, which allowed a dispatch from an earlier cycle to attach to a later operation until Doc 05 revision 6 closed it. Session is deliberately not matched: recovery replaces a session while the workflow stands still, whereas a revision cycle moves the workflow while the session stands still. Attachment is advisory in both directions — a mismatched or absent id costs provenance, never work.

Design authority for all of the above is [05 — Step 8 Dispatch Contract](./05%20-%20Step%208%20Dispatch%20Contract.md), including revision 5, which moved the defensive claim guards inside the claim branch and into the order `claimTask()` actually rejects, and revision 6, which added the generation clause above.

### 3.11 Collaboration field terminal

The React 19, Tailwind CSS 4, and shadcn-based frontend polls `/api/snapshot` every two seconds and renders backend state without implementing a client-side workflow engine.

Its current layout includes:

- model identities and backend status;
- a task-channel selector;
- task owner, base commit, candidate commit, and status;
- registered worktrees;
- a chronological stream of messages and typed domain events;
- inline decision, proposal, review, finding, and verification artifacts;
- confirmed human actions for proposal reveal, decision acceptance, and task acceptance;
- connection, credential, and mutation failure states.

The page takes its credential from the URL fragment the daemon printed, keeps it in `sessionStorage`, and clears the address bar. Opening the terminal without it shows a prompt to use the printed URL. Because credentials rotate on every daemon start, a tab left open across a restart asks to be reopened.

The activity stream uses React Virtuoso for variable-height virtualization, follow-at-bottom behavior, and a jump-to-latest control. Explicit selection of **All activity** is respected rather than being overwritten by later snapshot refreshes.

The interface has been manually exercised at desktop and mobile sizes with both sparse state and the Pilot 001 event history. It has not yet received a formal browser compatibility, keyboard, screen-reader, or automated visual-regression audit.

## 4. Automated Evidence at This Baseline

At `9794626`, the repository test suite contains 61 passing Node tests. Beyond the original schema, identity, Git-truth, lease, proposal, review, and snapshot coverage, they now include:

- operation-ledger preservation of accepted, rejected, and failed attempts with causal event linkage;
- atomic commitment of operation outcomes alongside domain mutations, including the asynchronous verification path;
- revision claim reservation, its expiry, and its restoration of ordinary role-governed claim rules;
- base-pinned required checks, including rejection of a candidate-side policy substitution;
- refusal to let arbitrary passing verification stand in for every named check;
- candidate-scoped human override, and the proof that overriding named checks still cannot bypass the designated verifier;
- role distinctness, assignment authority, and enforcement at every authority boundary;
- daemon singleton ownership and stale-lock takeover;
- a complete CLI-driven task through acceptance against a real daemon;
- fail-closed client behavior with no daemon, a foreign daemon, or a refused credential, including proof that no database is created;
- daemon-side verification with streamed output and exit-code propagation;
- restart recovery of unfinished attempts as `abandoned`, with canonical state unchanged;
- concurrent claims resolving to exactly one owner;
- rejection of every anonymous `/api` route, including the human-authority routes with and without a forged `Origin`;
- credential scoping between the agent and field-terminal surfaces;
- refusal of a replacement daemon while an outgoing one is still draining an in-flight operation;
- clean teardown of server, database, and ownership when startup fails after the socket is listening;
- identity binding, including a model session refused when it claims another model, the human, or a control operation, and the control credential refused when it claims a model;
- session exclusivity, and the permanent invalidation of a credential that has been replaced or closed;
- deterministic stale replacement, and the refusal to replace a live session;
- reconnection of an existing session credential to a replacement daemon after a real restart, with roles, leases, reservations, and task state unchanged by either the restart or a subsequent replacement;
- refusal to replace a session with accepted daemon work in flight, and the same replacement succeeding once that work completes;
- agreement between that refusal and the projection, so a working session is never reported as stale;
- refusal of a request whose session was replaced after it authenticated but before its body arrived, proven against the pre-fix code to have otherwise acquired a lease;
- credential hygiene: the session descriptor is delivered to the model worktree at mode `0600`, and the raw credential appears in neither the database files nor the snapshot;
- liveness refreshed by ordinary authenticated activity and by an explicit heartbeat, with neither adding operation attempts or domain events;
- every dispatchable action row asserted against the state table and then proven permitted by invoking its terminal operation, which is the direction that catches drift between dispatch and service authority;
- the non-action rows asserted by exact kind and reason, with the reasons that name a service rejection additionally asserted to match that service error code;
- agreement between the shared acceptance gates and the dispatcher, so empty gaps, the awaiting-acceptance row, and a successful acceptance stand or fall together;
- a lease crossing its expiry changing the derived action while the task version does not move, proving the basis records the evaluated fact rather than a version;
- the pause asymmetry in both directions: claims blocked under a paused project while review and verification proceed, and acceptance reported as awaiting a resume rather than a decision;
- the defensive claim guards firing in the order `claimTask()` rejects, and only on the claim path, so a corrupted reservation on an in-review task does not surface as a claim conflict;
- an unassigned task waiting on the human for every model agent, ahead of role membership, and the envelope declining to enumerate other agents' tasks as noise;
- delivery idempotency across equivalent polls, distinct attribution across a session replacement, and re-dispatch across a contract-version change;
- a busy session reported as live but not deliverable, and refused issuance, while derivation itself stays available;
- an issuing request over HTTP reading the work-in-flight value sampled before it registered its own activity, and still refused when the session is genuinely busy with other work;
- causal attachment accepted only for a matching agent, resolved task, terminal operation, and workflow generation, including `review.submit` reaching its task through the review row;
- a dispatch from an earlier revision cycle refused attachment to a later re-claim, proven against the pre-fix code to have otherwise recorded a false causal edge;
- a derivation that fails to reduce returned intact and recorded as a rejected attempt rather than resolved by heuristic;
- the derivation boundary itself: control may inspect any agent, a session only itself.

The following commands passed while this document was prepared:

```bash
npm test        # 61 tests, 61 pass, 0 fail
npm run lint    # exit 0
npm run build   # exit 0
```

This is implementation self-validation. It is not independent verification of every architectural claim or of real-world effectiveness.

## 5. Pilot 001

Pilot 001 was run in the separate `/home/scott/Development/SCRAPGRID-pilot` repository, on the CLI-first system as it existed at that time. Its original collaboration database was inspected read-only for this document.

This section is a historical record. The harness has changed substantially since the run, and none of the capabilities added in charter steps 1 through 8 were present. Pilot 001 is not evidence for them.

### 5.1 Task and artifact

The pilot task, `TASK-PILOT`, asked the agents to build a zero-dependency persistent namespaced key/value library with optimistic revisions and atomic compare-and-set.

- Base commit: `e509659ab27e95d29fb5d6d623ea0a1ab468744b`
- Candidate commit: `e171bb445439135b84a868954ebef1617d633de8`
- Implementation owner: Codex
- Reviewer: Claude
- Verification runner: Grok
- Final collaboration status: `accepted`

Those roles were a convention the participants followed, not the enforced task roles the harness gained later.

The candidate commit contains 618 added lines across three source files and one test file. It remains on `collab/codex`; recording human acceptance did not merge it into the pilot repository's `main` branch. SCRAPGRID records acceptance but does not perform Git integration.

### 5.2 Recorded collaboration

The Pilot 001 database contains:

| Record | Count |
|---|---:|
| agents | 4 |
| tasks | 1 |
| managed worktrees | 3 |
| messages | 5 |
| proposals | 3 |
| decisions | 1 |
| blockers | 0 |
| reviews | 1 |
| review findings | 4 |
| verifications | 1 |
| events | 24 |

The event log records this sequence:

1. Human registered three managed worktrees and created the task.
2. Grok, Codex, and Claude independently submitted sealed proposals.
3. Human revealed the proposals.
4. The models exchanged task-scoped messages.
5. Codex proposed a detailed implementation decision and human accepted it.
6. Codex acquired the task lease and requested review for the candidate commit.
7. Grok ran `npm test` against that exact commit; the recorded exit code was `0`.
8. Claude filed four non-blocking findings and approved the review.
9. Human accepted the task.

### 5.3 What the pilot demonstrated

Pilot 001 demonstrated that the harness of that time could:

- coordinate three named model roles and a human through one durable task record;
- preserve independent proposals until human reveal;
- make model-to-model challenge and refinement visible as messages and a durable decision;
- bind a candidate, review, verification, and acceptance to the same immutable commit;
- retain substantive review findings even when they are non-blocking;
- reconstruct the collaboration afterward from structured records and an event timeline;
- render that reconstruction as a coherent collaboration channel in the field terminal.

The pilot also showed that the central product metaphor is viable: the conversation and engineering artifacts can form one readable workflow without a separate dashboard model.

### 5.4 What the pilot did not demonstrate

Pilot 001 did not prove the entire Phase 4 gate from the implementation plan:

- no blocking finding forced a revision cycle;
- no second candidate commit was reviewed and re-verified;
- no lease-expiry or abandoned-worktree recovery occurred;
- no daemon restart or competing process recovery was tested;
- no blocker lifecycle was exercised;
- no required-check policy beyond one passing verification was configured;
- task acceptance did not merge or otherwise integrate the accepted commit;
- the pilot used a zero-dependency artifact, so it did not solve dependency provisioning for detached verification generally.

Some of those gaps have since been closed **in the harness** — a required-check policy now exists, and daemon restart and competing-process recovery are covered by the automated suite. Closing a gap in implementation is not the same as demonstrating it in a real multi-model run. Pilot 002 exists to supply that evidence.

## 6. Issues Exposed by the Pilot and Terminal

### 6.1 Managed worktree metadata becomes stale

All three Pilot 001 `managed_worktrees.head_commit` values remained at the base commit after Codex produced the candidate commit. The candidate itself was correctly recorded on the task and review, but the worktree panel displayed the older registered head.

The current table is effectively bootstrap metadata, not a live Git status projection. The system needs either explicit refresh/update behavior or a clearer semantic name and presentation. **Still open.**

### 6.2 Agent `active` status is not live presence

An agent's current `active` value means the identity is not paused. It does not mean a model process is running or recently connected. Snapshot polling is intentionally side-effect free.

**Addressed in the backend by charter step 7.** Enabled identity, session liveness, and last heartbeat are now three separate durable facts, and the distinction that remains permanent is worth restating: a live session means an authenticated collaboration identity is present, not that a Claude Code, Codex, or Grok process is alive or thinking. SCRAPGRID does not supervise model runtimes.

**Still open in the frontend.** The field terminal has not yet been updated to present the new session projection, so it continues to show enabled-or-paused status where it could now distinguish a live session from a stale one.

### 6.3 Long artifacts need progressive disclosure

Real model proposals are substantially larger than ordinary messages. In Pilot 001, the revealed-proposals artifact dominated the stream. The current complete rendering is truthful, but proposal and long-decision content will likely need collapse/expand behavior that preserves searchability and access to the full record. **Still open.**

### 6.4 Detached verification needs environment policy

The verifier intentionally checks out only committed state. That is correct for Git truth, but commands that depend on untracked or locally installed dependencies may fail in the detached worktree.

**Partly addressed.** The required-check policy gives this an explicit, pinned answer per repository: this repository's own `.scrapgrid/checks.json` provisions dependencies inside the detached worktree as part of its check. That makes the policy a deliberate, auditable choice rather than an accident, but it does not by itself guarantee reproducibility, and a long provisioning step makes each check correspondingly slow.

### 6.5 Acceptance is not integration

`acceptTask()` records that the human accepted a candidate after service gates passed. It does not merge, fast-forward, cherry-pick, publish, or delete worktrees. This separation is safe, but an operator needs an explicit later integration workflow rather than assuming `accepted` means the repository's main branch changed. **Still open.**

## 7. Reconciliation with the Implementation Plan and Charter

Document 02's phase model has been superseded by the ten-step charter for Pilot 002 preparation. The phase table is retained for continuity:

| Plan phase | Current state |
|---|---|
| Phase 0 — contract | Complete as the original task/status/authority baseline. |
| Phase 1 — first usable slice | Implemented in the CLI-first service and SQLite schema. |
| Phase 2 — Git truth | Implemented, and extended past the original slice with base-pinned required checks and daemon-executed verification. Live worktree truth and stale-candidate detection remain incomplete. |
| Phase 3 — daemon and human controls | Daemon portion complete: `collabd` owns canonical mutation, the CLI is a pure client, and restart and concurrency behavior are covered by tests. Authenticated sessions, heartbeat, and deterministic session recovery were added in step 7, and deterministic dispatch of the next permitted action in step 8. The rest of the human control plane — pause/resume, lease revocation, reassignment, waivers — was deliberately not bundled into any of those steps and remains outstanding. |
| Phase 4 — three-terminal pilot | Pilot 001 was completed and is reconstructable, but the formal gate remains partial because no blocking revision cycle or recovery path was exercised in a real run. Pilot 002 is charter step 10. |
| Phase 5 — MCP adapters | Not started, and explicitly deferred by the charter. |
| Phase 6 — game application | Still blocked on a more complete and trustworthy harness. |

Charter status at this baseline: steps 1 through 8 are **COMPLETE**, step 9 is **NEXT**, and step 10 is **PENDING**. See document 04 for the authoritative sequence and the recorded commit for each step.

## 8. Current Boundaries

The following are not implemented:

- supervision of model runtimes: session liveness is collaboration presence, not proof that an agent process is alive or thinking;
- any ranking, priority, scheduling, or automatic task selection: the dispatcher reports an agent's obligations in a stated non-semantic order and refuses to choose among them;
- dispatch of an action to the human, or of the two obligations canonical state cannot uniquely address — resolving a blocking finding and clearing a blocker both remain human-mediated;
- READY/WORKING or any other status machine over sessions;
- session state in the field terminal, which still presents enabled-or-paused agent status only;
- pause/resume for the project or agents;
- human lease revocation or reassignment;
- blocker waiver records;
- lease renewal and abandoned-worktree recovery;
- coupling between task leases and managed worktree state;
- stale-candidate detection after review or verification;
- deterministic context bundles and bundle identity;
- accepted-candidate Git integration;
- MCP adapters;
- agent process launching, terminal management, or scheduling;
- general human chat input in the field terminal;
- authentication or remote deployment beyond loopback confinement;
- game-specific orchestration.

These are deliberate boundaries of the current implementation, not functions hidden elsewhere in the frontend.

## 9. Next Gate

The next gate is **charter step 9 — deterministic context bundles and bundle identity**. Document 04 governs its scope; this document does not propose a competing roadmap.

Step 8 deliberately stopped at the boundary step 9 begins from. A dispatched action carries identifiers, versions, and commits, and nothing else — no prose, no instruction, no assembled context. What an agent should *know* to carry out an action it has been told to perform is a separate question with its own identity requirements, and the dispatch record is explicitly not the place to park it. The recorded boundary is that `basis_json` holds discriminating coordination facts only; the moment bundles land, that field is the obvious place someone will try to store them, and it must refuse.

Four items are recorded as deferred rather than forgotten:

- **Blocker and finding resolution remain human-mediated.** Neither `resolveBlocker()` nor `resolveReviewFinding()` has a unique authorized actor, so canonical state cannot address either obligation and the dispatcher reports the gap instead of inventing a rule. Blocker frequency and human-intervention count are both listed Pilot 002 evidence signals, so this is a measurement the pilot exists to take rather than a defect it should hide.
- **Row 7a can strand a verifier.** After a check-policy override, the independent-verification requirement survives while the pinned policy no longer supplies a command for it, so the verifier is blocked with a determined action kind and an underdetermined argument vector. That is an honest representation of a real hole, and another signal worth counting.
- **Replacement requires staleness.** Recovering a terminal that was lost seconds ago means waiting out the fifteen-minute threshold or configuring it. A forced replacement would weaken the invariant that prevents competing authority, so it was not added. Revisit only if Pilot 002 shows the latency actually costs something.
- **Monotonic operation outcomes**, the item parked in the charter, remains deferred pending real evidence that the extra defense is needed.

Frontend refinement can remain narrow and opportunistic: collapse long artifacts, present the session projection now that presence has a real meaning, and keep actions synchronized literally with canonical task state. The field terminal does not yet surface dispatch records or derived obligations, which is a presentation gap rather than a missing capability.

## 10. Operational Reference

From the SCRAPGRID repository, start the daemon first; it is the only process that opens the collaboration database:

```bash
npm install
npm test
npm run collabd
```

Then, from another terminal:

```bash
npm run collab -- daemon status
npm run collab -- status
```

Before a model can act as itself, the human opens its session from the main worktree, which writes the credential into that model's managed worktree at mode `0600`:

```bash
npm run collab -- worktree bootstrap
npm run collab -- session open codex
```

The model then runs the CLI from its own worktree and is authenticated as itself with no further configuration. If a terminal is lost, recovery is explicit and reason-bearing:

```bash
npm run collab -- session replace codex --reason "terminal was lost"
```

Replacement is refused while that session still has accepted daemon work in flight, and is available once the session is stale. `COLLAB_SESSION_STALE_MS` changes the fifteen-minute threshold, and `COLLAB_SESSION` names a session descriptor for a model that is not standing in its worktree.

A model reads its own obligations from its own worktree and then names the one it is taking up. The listed order is not a priority:

```bash
npm run collab -- dispatch derive --agent codex
npm run collab -- dispatch issue --agent codex --task TASK-ID
```

`dispatch derive` accepts either credential — the human may inspect any agent from the main worktree, while a session may inspect only itself. `dispatch issue` requires a model session and refuses the control credential with `session_required`, because a delivery has to be attributable to the session that received it.

Issuing returns the durable dispatch record. Echoing its id on the terminal operation records the causal edge from the delivery to the work:

```bash
npm run collab -- task claim TASK-ID --agent codex --expected-version 1 --dispatch DISPATCH-ID
```

The echo is advisory: a mismatched or absent id costs provenance, never work. Re-issuing against unchanged state returns the record already written rather than a second delivery.

For the built local terminal:

```bash
npm run build
npm start
```

Open the `field terminal` URL from the daemon's banner — the one carrying the `#t=` fragment. The server listens on `127.0.0.1:4173` by default and uses the `.collab/collab.db` associated with the repository it was started from. `COLLAB_DB` relocates the database, the lock, and the discovery file together, and must be set before starting the daemon.

For local frontend development, run the Vite client and the daemon separately, then open the Vite URL with the same fragment appended:

```bash
npm run dev
npm run dev:api
```

## 11. Source Map

- Current public overview: [README.md](../../README.md)
- Pilot 002 sequence: [04 — Pilot 002 Implementation Charter](./04%20-%20Pilot%20002%20Implementation%20Charter.md)
- Dispatch design authority: [05 — Step 8 Dispatch Contract](./05%20-%20Step%208%20Dispatch%20Contract.md)
- Schema: [`collab/schema.ts`](../../collab/schema.ts)
- Workflow authority: [`collab/service.ts`](../../collab/service.ts)
- Git and verification boundary: [`collab/git.ts`](../../collab/git.ts)
- Daemon entry point and ownership lifecycle: [`collab/collabd.ts`](../../collab/collabd.ts)
- Singleton lock, daemon discovery, and session descriptors: [`collab/runtime.ts`](../../collab/runtime.ts)
- Operation registry and the session identity boundary: [`collab/operations.ts`](../../collab/operations.ts)
- Dispatch state table, result contract, and basis digest: [`collab/dispatch.ts`](../../collab/dispatch.ts)
- CLI: [`collab/cli.ts`](../../collab/cli.ts)
- Daemon client: [`collab/client.ts`](../../collab/client.ts)
- HTTP surface, credentials, and per-session activity: [`collab/http.ts`](../../collab/http.ts)
- Field terminal: [`src/App.tsx`](../../src/App.tsx)
- Field-terminal credential handling: [`src/lib/api.ts`](../../src/lib/api.ts)
- Automated tests: [`tests/collab.test.ts`](../../tests/collab.test.ts)

This document should be revised when the repository crosses the next material gate. Historical claims about Pilot 001 should remain distinguished from whatever later pilots prove.
