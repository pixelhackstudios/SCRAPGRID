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

- a SQLite schema for agents, tasks, leases, proposals, decisions, messages, blockers, reviews, findings,
  verifications, and append-only events;
- transactional domain rules with optimistic task versions and exclusive leases;
- one sealed proposal per agent/task, revealed only by the human;
- actionable synchronization state for restarted agents, including accepted decisions, revealed proposals,
  open blockers, pending reviews, and open findings;
- a database binding to this repository's shared Git object database, canonical root, and object format;
- immutable base commits on tasks and full, reachable descendant commits on reviews;
- validation that rejects malformed, missing, non-commit, unreachable, and wrong-object-database SHA claims;
- stable `collab/grok`, `collab/claude`, and `collab/codex` branches in isolated linked worktrees;
- verification commands executed in disposable detached worktrees at the exact claimed SHA, with repository,
  normalized commit, exact command argv as JSON, and exit code recorded;
- review requests that require the implementation owner to still hold the live task lease;
- review findings that only their author or the human may resolve;
- acceptance gates requiring a human actor, an approved review, passing verification for the same candidate,
  and no unresolved blockers or blocking findings;
- a JSON-output CLI and implementation-proximate tests.

This slice does **not** yet enforce required-check policy, couple leases to mutable worktree ownership, recover
stale post-review edits, run a daemon, expose MCP, schedule agents, develop the React UI, or implement MMORPG
systems. See
[`docs/framework-documentation/02 - Collaboration Harness Implementation Plan.md`](docs/framework-documentation/02%20-%20Collaboration%20Harness%20Implementation%20Plan.md)
for the ordered boundary.

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
npm run collab -- verify TASK-001 --agent claude --commit "$(git rev-parse HEAD)" -- npm test
```

`verify` creates a detached temporary worktree at the normalized commit, runs the exact argv there, records that
argv as JSON with the result, and removes the worktree. Commands must prepare any untracked dependencies they
require; the verifier never borrows `node_modules` or other mutable state from an agent worktree.

Run `npm run collab -- help` for the complete command list.

## Development checks

```bash
npm test
npm run lint
npm run build
```

The React/Vite scaffold remains in place but is intentionally outside the current implementation boundary.
