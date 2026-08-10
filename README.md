# SCRAPGRID

SCRAPGRID is currently building its collaboration harness before its MMORPG.

The immediate product is a small local software-development room for three independent coding agents:

- `grok` — Grok Build
- `claude` — Claude Code
- `codex` — Codex
- `human` — the project owner and final authority

Git is the artifact layer, SQLite is the durable collaboration state, `collabd` is the authoritative mutation
owner, `collab` is the universal interface, and tests provide executable evidence. No model has supervisory
authority over another.

```text
 collab CLI (codex)  ─┐
 collab CLI (claude) ─┤
 collab CLI (grok)   ─┼──▶  collabd  ──▶  CollaborationService  ──▶  SQLite
 field terminal     ──┘     127.0.0.1     invariants and authority     sole writer
```

## Current status

The repository contains the daemon-owned collaboration core plus its Git-truth slice:

- a singleton `collabd` daemon that holds the only connection to the collaboration database, established by an
  exclusive lock whose stale predecessor is taken over only when its recorded process is gone;
- a `collab` CLI that is purely a client: it opens no database, keeps no fallback path, and fails closed when the
  daemon is absent, dead, bound to another repository, serving another schema, or refusing its credential;
- resolution of operation attempts left unfinished by a crashed writer, recorded as `abandoned` on the next
  daemon start so the next permitted action is never indeterminate;
- a SQLite schema for agents, tasks, temporary task roles, leases, revision claim reservations, proposals, decisions, messages,
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
- human-assigned, task-scoped implementer, reviewer, and verifier authority with three distinct peer models;
- named required checks loaded from `.scrapgrid/checks.json` at each task's base commit, with the Git blob identity
  pinned to the task and carried by satisfying verification evidence;
- review requests that require the implementation owner to still hold the live task lease;
- review findings that only their author or the human may resolve;
- acceptance gates requiring a human actor, an approved review, every base-pinned named check passing for the same
  candidate, and no unresolved blockers or blocking findings;
- a candidate-scoped, reason-bearing human check-policy override recorded in canonical state and domain events;
- a side-effect-free, visibility-safe snapshot of collaboration state exposed through a loopback-only HTTP API;
- two separately scoped daemon credentials, so no `/api` route is anonymously callable and the page that renders
  agent-authored Markdown does not hold the credential that drives the operation registry;
- a React, Tailwind 4, and shadcn/ui collaboration field terminal that renders messages and typed domain events
  as one chronological activity stream;
- human controls for revealing proposals, accepting decisions, and accepting tasks that delegate authority checks
  to the existing collaboration service;
- a JSON-output CLI and implementation-proximate tests.

This slice does **not** yet reassign roles after implementation begins, couple leases to mutable worktree
ownership, recover stale post-review edits, track agent sessions or presence, expose MCP, schedule agents,
provide general-purpose human chat input, or implement MMORPG systems. See
[`docs/framework-documentation/04 - Pilot 002 Implementation Charter.md`](docs/framework-documentation/04%20-%20Pilot%20002%20Implementation%20Charter.md)
for the authoritative Pilot 002 prerequisite sequence.

The research starting point is
[`docs/framework-documentation/01-AI-Colloboration-Report.md`](docs/framework-documentation/01-AI-Colloboration-Report.md). It informs the
architecture but is not treated as an unquestionable specification.

## Run the collaboration core

The current implementation uses Node's built-in SQLite API and has been exercised with Node 26.

Start the daemon first, in its own terminal. It is the only process that opens the collaboration database, and
it must stay running for any `collab` command to work:

```bash
npm install
npm test
npm run collabd
```

It prints where it is listening, where agent clients should look for it, and the field terminal's URL:

```text
SCRAPGRID collabd listening on http://127.0.0.1:4173
repository      sha256:…
agent clients   /path/to/repo/.collab/collabd.json
field terminal  http://127.0.0.1:4173/#t=…
```

Then use the CLI from any other terminal, including a linked agent worktree:

```bash
npm run collab -- daemon status
npm run collab -- worktree bootstrap
npm run collab -- agent list
```

`collabd` performs database initialization at startup, so there is no separate init step; `collab init` reports
the running daemon. The default database is `<main-worktree>/.collab/collab.db`, and the daemon's lock and
discovery file sit beside it. Set `COLLAB_DB` before starting the daemon to move all three; the CLI reads the
same variable to find them. `--db` is no longer accepted, because a client no longer chooses a database. Use
`--repo PATH` when invoking from outside the repository. A database fails closed if opened against another Git
object database. All successful command results are JSON; failures are JSON on stderr with a nonzero exit code.

A client fails closed rather than falling back to direct database access when the daemon is missing, when its
recorded process is gone, when it is bound to a different repository, when it serves a different schema, or when
its credential does not match.

### Credentials

`collabd` mints two credentials on every start and scopes them separately:

| Credential | Reaches | Delivered by |
|---|---|---|
| agent | `POST /api/operations` — the whole operation registry | `.collab/collabd.json`, mode `0600` |
| field terminal | `GET /api/snapshot` and the human-control routes | the `#t=…` URL printed above; never written to disk |

They are separate because the field terminal renders agent-authored Markdown, and that page should not be
holding the credential that drives every operation. The fragment is never sent to the server, never reaches an
access log, and never leaks through a `Referer` header.

This is a boundary around the daemon, not an identity system:

```text
Step 6 authenticates access to collabd.
It does not yet authenticate the claimed agent/human identity of each operation.
```

The agent credential proves "this caller may reach the collaboration daemon," not "this caller is Codex."
`collab task accept --actor human` therefore remains a declared-identity path: the harness trusts participants
to name themselves honestly, which is the cooperative model the whole design rests on. Nor is this same-user
isolation, which loopback cannot provide — anything that can read `.collab/collabd.json` can already read
`.collab/collab.db`. What it does close is the anonymous path: no unauthenticated HTTP request can exercise
human authority.

Example flow:

```bash
npm run collab -- task create TASK-001 \
  --goal "Prove one bounded change" \
  --acceptance "An independent review approves the candidate commit"

npm run collab -- task assign-roles TASK-001 --actor human \
  --implementer codex --reviewer claude --verifier grok

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

The check runs inside `collabd`, not inside the CLI: the process that records an exit code is the process that
observed it, so a client cannot report evidence it did not produce. Its output still streams back to the
terminal that asked for it, and `collab verify` exits with the check's own exit code.

If a valid base policy is operationally broken, the human may record the deliberately narrow escape hatch after
the candidate enters review:

```bash
npm run collab -- policy override TASK-001 --actor human --reason "Base check cannot resolve its pinned tool."
```

Run `npm run collab -- help` for the complete command list.

## Run the collaboration view

Build the frontend, then start the daemon, which also serves the loopback-only operator view:

```bash
npm run build
npm start
```

Open the `field terminal` URL from the daemon's banner — the one ending in `#t=…`. The page takes the credential
out of the fragment, keeps it in `sessionStorage`, and clears the address bar; opening `http://127.0.0.1:4173`
without it shows a prompt to use the printed URL instead. The credential rotates on every daemon start, so a tab
left open across a restart asks to be reopened. The view polls the side-effect-free `/api/snapshot` endpoint
every two seconds.

For frontend development with Vite hot reload, run `npm run dev:api` and `npm run dev` in separate terminals,
then open the Vite URL with the same `#t=…` fragment appended.

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
collabd owns the only connection and serializes every mutation
        ↓
loopback HTTP serializes frontend-safe state
        ↓
React renders and polls that state
```

The HTTP surface is:

| Method | Path | Credential | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/snapshot` | field terminal | Return the current frontend-safe collaboration state without presence side effects |
| `POST` | `/api/operations` | agent | Run one registry operation and stream newline-delimited JSON back to the client |
| `POST` | `/api/tasks/:id/reveal-proposals` | field terminal | Delegate the human reveal operation to `CollaborationService` |
| `POST` | `/api/decisions/:id/accept` | field terminal | Delegate decision acceptance to `CollaborationService` |
| `POST` | `/api/tasks/:id/accept` | field terminal | Delegate version-checked task acceptance to `CollaborationService` |

The HTTP layer does not reproduce service authorization rules. Human routes use the neutral `human` actor and
return a fresh snapshot after the existing service operation succeeds. The server binds to `127.0.0.1`, every
`/api` route requires its credential before anything else is checked, and browser mutations additionally require
a matching `Origin`. Static assets are unauthenticated because they carry no collaboration state.

Every operation answers with the same framing, which is what lets a long check hold the connection open: headers
flush before the command starts, `output` frames arrive as it produces them, `keepalive` frames cover silent
stretches, and exactly one `result` or `error` frame ends the stream.

If the Vite view reports that the snapshot service is unavailable, start `npm run dev:api` in the second
terminal. `npm run dev` serves and hot-reloads the frontend; it does not start the daemon.

## Development checks

```bash
npm test
npm run lint
npm run build
```

Rendered browser checks remain implementation self-validation rather than an independent verification verdict.
