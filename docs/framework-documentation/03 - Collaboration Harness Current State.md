# Collaboration Harness Current State

**Status date:** 2026-08-09

**Repository baseline:** `db9d0aa` (`main`, synchronized with `origin/main` when this document was written)

**Purpose:** Record what SCRAPGRID currently is, what has been demonstrated, and what remains unresolved.

## 1. How to Read This Document

This is a current-state record, not a replacement architecture or a new roadmap.

- [01 — AI Collaboration Report](./01-AI-Colloboration-Report.md) remains the architectural starting point.
- [02 — Collaboration Harness Implementation Plan](./02%20-%20Collaboration%20Harness%20Implementation%20Plan.md) remains the historical implementation plan and phase model.
- This document reconciles those intentions with the repository and Pilot 001 as they exist now.

The implementation did not follow the original phase order exactly. The CLI collaboration core and Git truth work were followed by a thin HTTP bridge and a React field terminal before an authoritative daemon was built. A real three-model pilot was then completed using the CLI-first system. That sequence produced a useful operator interface and concrete evidence, but it did not silently complete the deferred daemon, recovery, or MCP work.

## 2. Executive State

SCRAPGRID is currently a working local collaboration harness with four layers:

```text
SQLite collaboration database
          │
          ▼
CollaborationService invariants
      │              │
      ▼              ▼
CLI commands      thin loopback HTTP
                         │
                         ▼
              React collaboration terminal
```

The backend can persist and enforce a complete small-task collaboration flow:

```text
create task
  → submit sealed proposals
  → human reveals proposals
  → agents exchange messages
  → propose and accept a decision
  → claim the task under a lease
  → request review for an immutable candidate commit
  → independently verify that exact commit
  → record review findings and verdict
  → human accepts the task
```

The frontend is a live, chronological view of that backend state. It is best understood as a **collaboration field terminal**, not a dashboard and not a general-purpose chat client. Messages, decisions, claims, Git candidates, reviews, findings, verification results, and human actions share one task-filterable activity channel.

The current system is useful and demonstrably coherent, but it is not yet the full architecture described in the original report. In particular, there is no authoritative `collabd` process, no complete human control plane, no recovery protocol, no MCP adapter, and no agent launching or scheduling.

## 3. What Exists in the Repository

### 3.1 Durable collaboration model

The SQLite schema currently stores:

- stable human and model identities;
- project state and repository binding;
- tasks and optimistic task versions;
- exclusive time-bounded leases;
- directed messages;
- sealed and revealed proposals;
- proposed and accepted decisions;
- blockers;
- reviews and review findings;
- verification records;
- managed worktree registrations;
- an append-only event timeline.

The database is bound to one Git object database using a repository identity derived from its common Git directory and object format. This prevents a collaboration database from being casually reused against a different repository.

### 3.2 Service-enforced invariants

`CollaborationService` is the authority for workflow transitions. Both the CLI and HTTP handlers delegate to it rather than reimplementing the state machine.

Implemented gates include:

- task claims use an expected version and fail closed on stale state;
- a live lease prevents a competing agent from claiming the same task;
- each agent may submit only one proposal per task;
- sealed proposal content is not exposed before a human reveal;
- only a human may reveal proposals, accept decisions, or accept tasks;
- a review request must come from the task owner while its lease is still live;
- candidate commits must exist, be reachable from repository refs, and descend from the task base commit;
- the requester cannot review its own candidate;
- the implementer cannot resolve another agent's review finding;
- task acceptance requires the exact candidate commit to have an approved review and a passing verification;
- open blockers and open blocking findings prevent acceptance;
- task acceptance also uses an expected version to reject stale human actions.

Non-blocking review findings may remain open when a task is accepted. This is current service policy, not an omission in the UI.

### 3.3 Git truth and isolated verification

The Git layer currently provides:

- repository discovery and durable repository identity;
- full commit resolution and rejection of invented, missing, non-commit, unreachable, or foreign SHAs;
- candidate-descends-from-base validation;
- stable `collab/grok`, `collab/claude`, and `collab/codex` worktree branches;
- verification in a temporary detached worktree at the exact requested commit;
- exact argument-vector execution with no shell interpolation;
- recorded commit, command arguments, runner, exit code, and timestamp.

Verification proves the recorded command's exit status at an immutable commit. It does not by itself prove test completeness, environmental reproducibility, or that every required check was run.

### 3.4 CLI surface

The CLI exposes the implemented collaboration operations:

- initialize and inspect status;
- synchronize durable state for an agent;
- list agents;
- bootstrap worktrees;
- create, claim, and accept tasks;
- submit and reveal proposals;
- propose and accept decisions;
- send messages;
- add and resolve blockers;
- request and submit reviews;
- add and resolve findings;
- run verification.

The CLI remains the broadest control surface. It opens the collaboration database and invokes `CollaborationService` directly; it is not yet a client of a single authoritative daemon.

### 3.5 HTTP snapshot and human mutations

The loopback server currently exposes:

```text
GET  /api/snapshot
POST /api/tasks/:id/reveal-proposals
POST /api/decisions/:id/accept
POST /api/tasks/:id/accept
```

`snapshot()` is a side-effect-free serializer over canonical state. It decodes stored JSON, removes the legacy serialized command representation, and redacts the content of sealed proposals. Unlike agent synchronization, snapshot polling does not update `last_seen_at`.

The mutation handlers are intentionally thin. They supply the human actor and call the existing service methods, leaving authority and acceptance checks in `CollaborationService`. Cross-origin mutations are rejected, and the production server binds to `127.0.0.1`. There is no authentication layer; loopback confinement is the current deployment boundary.

This HTTP server is an operator bridge, not the authoritative daemon proposed in the original architecture. Most collaboration commands still bypass it.

### 3.6 Collaboration field terminal

The React 19, Tailwind CSS 4, and shadcn-based frontend polls `/api/snapshot` every two seconds and renders backend state without implementing a client-side workflow engine.

Its current layout includes:

- model identities and backend status;
- a task-channel selector;
- task owner, base commit, candidate commit, and status;
- registered worktrees;
- a chronological stream of messages and typed domain events;
- inline decision, proposal, review, finding, and verification artifacts;
- confirmed human actions for proposal reveal, decision acceptance, and task acceptance;
- connection and mutation failure states.

The activity stream uses React Virtuoso for variable-height virtualization, follow-at-bottom behavior, and a jump-to-latest control. Explicit selection of **All activity** is respected rather than being overwritten by later snapshot refreshes.

The interface has been manually exercised at desktop and mobile sizes with both sparse state and the Pilot 001 event history. It has not yet received a formal browser compatibility, keyboard, screen-reader, or automated visual-regression audit.

## 4. Automated Evidence at This Baseline

At `db9d0aa`, the repository test suite contains 15 passing Node tests. They cover:

1. schema migration;
2. stable identities;
3. repository binding;
4. invalid and foreign commit rejection;
5. candidate ancestry;
6. idempotent worktree bootstrap;
7. stale claims and competing leases;
8. sealed proposal visibility and human reveal authority;
9. live-lease review requests;
10. a complete three-agent service flow through human acceptance;
11. rejection of verification recorded for the wrong commit;
12. review-finding resolution authority;
13. durable sync state without sealed proposal leakage;
14. side-effect-free snapshot serialization and redaction;
15. HTTP snapshot and human-mutation delegation.

The following commands passed while this document was prepared:

```bash
npm test
npm run build
```

This is implementation self-validation. It is not independent verification of every architectural claim or of real-world effectiveness.

## 5. Pilot 001

Pilot 001 was run in the separate `/home/scott/Development/SCRAPGRID-pilot` repository. Its original collaboration database was inspected read-only for this document.

### 5.1 Task and artifact

The pilot task, `TASK-PILOT`, asked the agents to build a zero-dependency persistent namespaced key/value library with optimistic revisions and atomic compare-and-set.

- Base commit: `e509659ab27e95d29fb5d6d623ea0a1ab468744b`
- Candidate commit: `e171bb445439135b84a868954ebef1617d633de8`
- Implementation owner: Codex
- Reviewer: Claude
- Verification runner: Grok
- Final collaboration status: `accepted`

The candidate commit contains 618 added lines across three source files and one test file. It remains on `collab/codex`; recording human acceptance did not merge it into the pilot repository's `main` branch. SCRAPGRID currently records acceptance but does not perform Git integration.

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

Pilot 001 demonstrated that the current harness can:

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

The pilot is therefore meaningful real-world evidence, but not evidence that every planned failure and recovery path is complete.

## 6. Issues Exposed by the Pilot and Terminal

### 6.1 Managed worktree metadata becomes stale

All three Pilot 001 `managed_worktrees.head_commit` values remained at the base commit after Codex produced the candidate commit. The candidate itself was correctly recorded on the task and review, but the worktree panel displayed the older registered head.

The current table is effectively bootstrap metadata, not a live Git status projection. The system needs either explicit refresh/update behavior or a clearer semantic name and presentation.

### 6.2 Agent `active` status is not live presence

An agent's current `active` value means the identity is not paused. It does not mean a model process is running or recently connected. Snapshot polling is intentionally side-effect free, and only agent synchronization updates `last_seen_at`.

The terminal currently presents backend status literally, but future presence language should distinguish enabled identity, recent synchronization, and a genuinely running agent session.

### 6.3 Long artifacts need progressive disclosure

Real model proposals are substantially larger than ordinary messages. In Pilot 001, the revealed-proposals artifact dominated the stream. The current complete rendering is truthful, but proposal and long-decision content will likely need collapse/expand behavior that preserves searchability and access to the full record.

### 6.4 Detached verification needs environment policy

The verifier intentionally checks out only committed state. That is correct for Git truth, but commands that depend on untracked or locally installed dependencies may fail in the detached worktree. Pilot 001 avoided this by using only Node built-ins. A general solution still needs an explicit dependency provisioning or reproducible-environment policy.

### 6.5 Acceptance is not integration

`acceptTask()` records that the human accepted a candidate after service gates passed. It does not merge, fast-forward, cherry-pick, publish, or delete worktrees. This separation is safe, but an operator needs an explicit later integration workflow rather than assuming `accepted` means the repository's main branch changed.

## 7. Reconciliation with the Implementation Plan

| Plan phase | Current state |
|---|---|
| Phase 0 — contract | Complete as the original task/status/authority baseline. |
| Phase 1 — first usable slice | Implemented in the CLI-first service and SQLite schema. |
| Phase 2 — Git truth | Core slice implemented: repository binding, candidate validation, worktrees, exact-commit verification, review and acceptance gates. Recovery policy, required-check configuration, and live worktree truth remain incomplete. |
| Phase 3 — daemon and human controls | Partial and out of order. Three human actions exist in the field terminal, but there is no authoritative daemon, pause/resume control plane, assignment/revocation, override, or waiver workflow. |
| Phase 4 — three-terminal pilot | Pilot 001 was completed and is reconstructable, but the formal gate remains partial because no blocking revision cycle or recovery path was exercised. |
| Phase 5 — MCP adapters | Not started. |
| Phase 6 — game application | Still blocked on a more complete and trustworthy harness. |

The React field terminal was originally outside the near-term boundary in Document 02. It was intentionally brought forward after the backend exposure proved small enough to keep the frontend as a thin view and control surface. That change did not alter backend semantics.

## 8. Current Boundaries

The following are not implemented:

- authoritative daemon ownership of writes;
- pause/resume for the project or agents;
- human task assignment, lease revocation, or reassignment controls;
- formal override and waiver records;
- lease renewal and abandoned-worktree recovery;
- coupling between task leases and managed worktree state;
- required-check configuration;
- stale-candidate detection after review or verification;
- accepted-candidate Git integration;
- MCP adapters;
- agent process launching, terminal management, or scheduling;
- general human chat input in the field terminal;
- authentication or remote deployment;
- game-specific orchestration.

These are deliberate boundaries of the current implementation, not functions hidden elsewhere in the frontend.

## 9. Recommended Next Gate

The next work should strengthen backend truth using the evidence the pilot exposed, while preserving the terminal as a thin projection.

A sensible next gate is:

1. define whether `managed_worktrees` is registration metadata or live status, then make code and UI agree;
2. define a reproducible verification environment and required-check policy;
3. exercise one task with a blocking finding, a revised candidate, re-review, and re-verification;
4. specify the accepted-candidate integration step without silently making acceptance mutate Git;
5. build the authoritative daemon and recovery controls before adding MCP or agent scheduling.

Frontend refinement can remain narrow: collapse long artifacts, clarify presence language, and keep actions synchronized literally with canonical task state.

## 10. Operational Reference

From the SCRAPGRID repository:

```bash
npm install
npm test
npm run build
npm run collab -- init
npm run collab -- status
```

For local frontend development, run the Vite client and API bridge separately:

```bash
npm run dev
npm run dev:api
```

For the built local terminal:

```bash
npm run build
npm start
```

The server listens on `127.0.0.1:4173` by default and uses the `.collab/collab.db` associated with the repository from which it is started.

## 11. Source Map

- Current public overview: [README.md](../../README.md)
- Schema: [`collab/schema.ts`](../../collab/schema.ts)
- Workflow authority: [`collab/service.ts`](../../collab/service.ts)
- Git and verification boundary: [`collab/git.ts`](../../collab/git.ts)
- CLI: [`collab/cli.ts`](../../collab/cli.ts)
- HTTP bridge: [`collab/http.ts`](../../collab/http.ts)
- Local server: [`collab/server.ts`](../../collab/server.ts)
- Field terminal: [`src/App.tsx`](../../src/App.tsx)
- Automated tests: [`tests/collab.test.ts`](../../tests/collab.test.ts)

This document should be revised when the repository crosses the next material gate. Historical claims about Pilot 001 should remain distinguished from whatever later pilots prove.
