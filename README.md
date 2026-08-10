# SCRAPGRID

SCRAPGRID is currently building its collaboration harness before its MMORPG.

The immediate product is a small local software-development room for three independent coding agents:

- `grok` — Grok Build
- `claude` — Claude Code
- `codex` — Codex
- `human` — the project owner and final authority

Git is the artifact layer, SQLite is the durable collaboration state, `collab` is the universal interface, and
tests provide executable evidence. No model has supervisory authority over another.

## Current status

The repository contains the CLI-first collaboration core plus its first Git-truth slice:

- a SQLite schema for agents, tasks, leases, revision claim reservations, proposals, decisions, messages,
  blockers, reviews, findings, verifications, check-policy overrides, operation attempts, and append-only events;
- a transport-neutral operation boundary that records accepted, rejected, and failed coordination operations
  outside rolled-back domain transactions, while unfinished rows preserve crash or abandonment evidence;
- causal `operation_id` linkage from successful operations to the domain events they produced;
- transactional domain rules with optimistic task versions and exclusive leases;
- revision continuity through one-hour claim reservations that retain the original implementer's claim priority
  without granting an execution lease;
- one sealed proposal per agent/task, revealed only by the human;
- actionable synchronization state for restarted agents, including accepted decisions, revealed proposals,
  open blockers, pending reviews, and open findings;
- a database binding to this repository's shared Git object database, canonical root, and object format;
- immutable base commits on tasks and full, reachable descendant commits on reviews;
- validation that rejects malformed, missing, non-commit, unreachable, and wrong-object-database SHA claims;
- stable `collab/grok`, `collab/claude`, and `collab/codex` branches in isolated linked worktrees;
- verification commands executed in disposable detached worktrees at the exact claimed SHA, with repository,
  normalized commit, exact command argv as JSON, and exit code recorded;
- independent verification enforcement that rejects the task owner as runner and prevents owner-authored evidence
  from satisfying acceptance;
- named required checks loaded from `.scrapgrid/checks.json` at each task's base commit, with the Git blob identity
  pinned to the task and carried by satisfying verification evidence;
- review requests that require the implementation owner to still hold the live task lease;
- review findings that only their author or the human may resolve;
- acceptance gates requiring a human actor, an approved review, every base-pinned named check passing for the same
  candidate, and no unresolved blockers or blocking findings;
- a candidate-scoped, reason-bearing human check-policy override recorded in canonical state and domain events;
- a side-effect-free, visibility-safe snapshot of collaboration state exposed through a loopback-only HTTP API;
- a React, Tailwind 4, and shadcn/ui collaboration field terminal that renders messages and typed domain events
  as one chronological activity stream;
- human controls for revealing proposals, accepting decisions, and accepting tasks that delegate authority checks
  to the existing collaboration service;
- a JSON-output CLI and implementation-proximate tests.

This slice does **not** yet couple leases to mutable worktree ownership, recover stale post-review edits, run a
daemon, expose MCP, schedule agents, provide general-purpose human chat input, or implement MMORPG systems. See
[`docs/framework-documentation/04 - Pilot 002 Implementation Charter.md`](docs/framework-documentation/04%20-%20Pilot%20002%20Implementation%20Charter.md)
for the authoritative Pilot 002 prerequisite sequence.

The research starting point is
[`docs/framework-documentation/01-AI-Colloboration-Report.md`](docs/framework-documentation/01-AI-Colloboration-Report.md). It informs the
architecture but is not treated as an unquestionable specification.

## Run the collaboration core

The current implementation uses Node's built-in SQLite API and has been exercised with Node 26.

```bash
npm install
npm test
npm run collab -- init
npm run collab -- worktree bootstrap
npm run collab -- agent list
```

The default database is `<main-worktree>/.collab/collab.db`, including when the CLI is invoked from a linked
agent worktree. Override it per invocation with `--db PATH` or set `COLLAB_DB`. Use `--repo PATH` when invoking
from outside the repository. A database fails closed if opened against another Git object database. All
successful command results are JSON; failures are JSON on stderr with a nonzero exit code.

Example flow:

```bash
npm run collab -- task create TASK-001 \
  --goal "Prove one bounded change" \
  --acceptance "An independent review approves the candidate commit"

npm run collab -- proposal submit TASK-001 --agent grok --content "Use an exclusive task lease."
npm run collab -- proposal submit TASK-001 --agent claude --content "Review one immutable commit."
npm run collab -- proposal submit TASK-001 --agent codex --content "Record verification against that commit."
npm run collab -- proposal reveal TASK-001 --actor human

npm run collab -- task claim TASK-001 --agent codex --expected-version 1
npm run collab -- message send --from codex --to claude --task TASK-001 --body "Candidate is ready."
npm run collab -- review request TASK-001 --agent codex --commit "$(git rev-parse HEAD)"
npm run collab -- verify TASK-001 --agent claude --commit "$(git rev-parse HEAD)" --check quality
```

`verify --check ID` resolves the named argv from the task's base-pinned `.scrapgrid/checks.json`. An explicit
command after `--` remains useful as evidence but cannot satisfy acceptance. Every named check must pass for the
exact candidate under the pinned policy identity. `verify` runs the resolved argv in a detached temporary
worktree and never borrows mutable dependencies from an agent worktree.

If a valid base policy is operationally broken, the human may record the deliberately narrow escape hatch after
the candidate enters review:

```bash
npm run collab -- policy override TASK-001 --actor human --reason "Base check cannot resolve its pinned tool."
```

Run `npm run collab -- help` for the complete command list.

## Run the collaboration view

Build the frontend and collaboration server, then start the loopback-only operator view:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:4173`. The view polls the side-effect-free `/api/snapshot` endpoint every two seconds.
For frontend development with Vite hot reload, run `npm run dev:api` and `npm run dev` in separate terminals,
then open the Vite URL.

The first interface is deliberately a live collaboration channel rather than a separate dashboard model. It
combines messages and typed domain events into one chronological stream, with task and worktree context in the
left rail. Decisions, proposals, reviews, findings, verification runs, claims, and other system activity keep
their domain-specific presentation without acquiring frontend-owned workflow semantics. The desktop shell keeps
the header and human-authority controls visible while the activity region scrolls; narrow screens return to
normal document flow. The activity stream uses [React Virtuoso](https://virtuoso.dev/react-virtuoso/) to
virtualize long histories while preserving follow-at-bottom and jump-to-latest behavior.

The boundary is intentionally thin:

```text
SQLite stores canonical state
        ↓
CollaborationService enforces visibility and authority
        ↓
loopback HTTP serializes frontend-safe state
        ↓
React renders and polls that state
```

The initial HTTP surface is:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/snapshot` | Return the current frontend-safe collaboration state without presence side effects |
| `POST` | `/api/tasks/:id/reveal-proposals` | Delegate the human reveal operation to `CollaborationService` |
| `POST` | `/api/decisions/:id/accept` | Delegate decision acceptance to `CollaborationService` |
| `POST` | `/api/tasks/:id/accept` | Delegate version-checked task acceptance to `CollaborationService` |

The HTTP layer does not reproduce service authorization rules. Mutation routes use the neutral `human` actor
and return a fresh snapshot after the existing service operation succeeds. Same-origin checks protect browser
mutations, and the server binds to `127.0.0.1` by default.

If the Vite view reports that the snapshot service is unavailable, start `npm run dev:api` in the second
terminal. `npm run dev` serves and hot-reloads the frontend; it does not start the collaboration API.

## Development checks

```bash
npm test
npm run lint
npm run build
```

Rendered browser checks remain implementation self-validation rather than an independent verification verdict.
