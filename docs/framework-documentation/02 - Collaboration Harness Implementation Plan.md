# Collaboration Harness Implementation Plan

## Development boundary

SCRAPGRID will prove local collaboration among Grok Build, Claude Code, and Codex before implementing the game.
The three model agents are peers. Each receives a stable identity, its own terminal/session, and eventually its
own Git worktree. The human project owner assigns, pauses, overrides, rejects, and accepts work.

The collaboration report in `docs/framework-documentation/01-AI-Colloboration-Report.md` is the architectural
starting artifact, not gospel. Current code, direct execution evidence, and explicit human decisions can correct
it.

In scope for the harness:

- durable collaboration state;
- explicit state transitions and concurrency protection;
- independent proposals, messages, decisions, blockers, reviews, findings, and verification;
- Git artifacts and isolated worktrees;
- a universal CLI, followed later by a daemon and optional MCP adapters;
- a reconstructable append-only event history.

Out of scope until the harness is proven:

- MMORPG implementation;
- React product UI;
- autonomous task scheduling or one model supervising another;
- a universal model runtime or IDE;
- MCP as a source of collaboration truth.

## Authority model

| Participant | Stable ID | Authority |
|---|---|---|
| Project owner | `human` | Intent, assignment, pause, override, rejection, final acceptance |
| Grok Build | `grok` | Independent proposals, bounded implementation when leased, review, verification |
| Claude Code | `claude` | Independent proposals, bounded implementation when leased, review, verification |
| Codex | `codex` | Independent proposals, bounded implementation when leased, review, verification |
| Collaboration service | — | State-transition, lease, concurrency, and acceptance invariants |
| SQLite | — | Durable collaboration records |
| Git | — | Durable software artifacts |
| Tests and validators | — | Executable evidence for exact commits |

No agent may approve its own review request. Holding a collaboration lease and owning a Git branch are distinct.

## Ordered implementation

### Phase 0 — Repository and boundary reconciliation

Status: complete.

- Confirm the local checkout is the standalone `pixelhackstudios/SCRAPGRID` repository.
- Confirm local `main` and `origin/main` share the same starting commit.
- Inventory the React/Vite scaffold and committed research artifact.
- Establish collaboration-first scope and explicit exclusions.

Completion evidence: the local repository root resolves to the SCRAPGRID directory and the baseline reports zero
divergence from `origin/main`.

### Phase 1 — CLI-first collaboration semantics

Status: first usable slice implemented.

- Define the SQLite schema and stable identities.
- Enforce task lifecycle transitions, optimistic versions, and exclusive leases in transactions.
- Support sealed proposals, messages, durable decisions, blockers, reviews, review findings, verification, and
  append-only events.
- Restrict proposal reveal to the human, permit one proposal per agent/task, require a live lease when requesting
  review, and restrict finding resolution to its author or the human.
- Return actionable durable state from `sync` so a restarted agent can recover without reconstructing details
  from event names alone.
- Require a human actor plus approved same-candidate review and verification before acceptance.
- Return machine-readable JSON from a universal CLI.

Current limitation: the CLI accesses the domain service directly; a single long-running daemon does not yet
serialize application operations.

Completion gate: implementation-proximate tests and a disposable CLI flow demonstrate three distinct agents,
one implementation lease, independent review, same-candidate verification, and human acceptance.

### Phase 2 — Git and worktree integration

Status: Git-truth slice implemented; ownership and recovery rules remain planned.

- Validate candidate commits and verification commits with Git before recording them.
- Record repository identity and immutable base/candidate SHAs.
- Require every candidate commit to descend from its task's immutable base commit.
- Bootstrap one linked worktree and branch namespace for each of `grok`, `claude`, and `codex`.
- Run verification commands in disposable detached worktrees at the claimed SHA and record the repository,
  normalized SHA, exact command argv as JSON, and exit code.
- Refuse shared mutable worktree ownership and stale post-review edits.
- Add safe recovery for expired leases without deleting agent work.

Implemented boundary: repository binding, real reachable descendant validation, stable managed worktrees, and
detached-SHA verification execution with exact argv evidence. Required-check policy, lease/worktree coupling,
stale post-review edit handling, and expired-lease recovery remain deliberately deferred.

Observed limitation: `collab verify ... -- npm test` reaches the repository test script in the detached worktree
but exits `2` because untracked installed dependencies are unavailable there. Dependency provisioning is a
concrete pilot prerequisite and remains deliberately unresolved in this slice.

Completion gate: three terminals operate in separate worktrees against the same repository, and the gateway
rejects an unknown SHA, a wrong-repository SHA, and evidence for an older candidate.

### Phase 3 — Local daemon and human controls

Status: planned.

- Move invocation behind a loopback-only `collabd` process while preserving the domain service.
- Make the CLI a client of the daemon rather than a direct database writer.
- Add explicit project pause/resume, assignment/revocation, waiver, and reason-bearing override operations.
- Prove restart recovery, concurrent claim handling, stale updates, and bounded database lock behavior.

Completion gate: daemon restart preserves state; concurrent claims produce one owner; a human pause blocks new
mutations; every override is attributable in the event ledger.

### Phase 4 — Three-terminal pilot

Status: planned.

- Use one disposable, nontrivial, multi-file software task.
- Have all three agents submit independent sealed proposals.
- Assign exactly one implementation owner.
- Require the other agents to review or independently verify the immutable candidate.
- Exercise at least one blocking finding and revision cycle.
- Measure collisions, stale-operation rejection, human interventions, review effectiveness, and reconstructability.

Completion gate: another person can reconstruct the complete task history from Git and SQLite without relying on
the agents' private transcripts.

### Phase 5 — Optional MCP adapters

Status: deferred until the CLI pilot passes.

- Expose the same domain operations through thin MCP adapters where each installed agent supports them cleanly.
- Keep SQLite and the domain service authoritative.
- Repeat the pilot without changing task, review, or verification semantics.

Completion gate: CLI and MCP paths produce equivalent state transitions and event records.

### Phase 6 — SCRAPGRID game development

Status: intentionally blocked on collaboration proof.

Only after the three-terminal pilot and failure gates pass should the collaboration system be pointed at MMORPG
implementation work.
