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

The repository contains the first CLI-first collaboration slice:

- a SQLite schema for agents, tasks, leases, proposals, decisions, messages, blockers, reviews, findings,
  verifications, and append-only events;
- transactional domain rules with optimistic task versions and exclusive leases;
- one sealed proposal per agent/task, revealed only by the human;
- actionable synchronization state for restarted agents, including accepted decisions, revealed proposals,
  open blockers, pending reviews, and open findings;
- reviews and verification records bound to candidate commit identifiers;
- review requests that require the implementation owner to still hold the live task lease;
- review findings that only their author or the human may resolve;
- acceptance gates requiring a human actor, an approved review, passing verification for the same candidate,
  and no unresolved blockers or blocking findings;
- a JSON-output CLI and implementation-proximate tests.

This slice does **not** yet validate commit identifiers against Git, create agent worktrees, run a daemon, expose
MCP, schedule agents, develop the React UI, or implement MMORPG systems. See
[`docs/02 - Collaboration Harness Implementation Plan.md`](docs/02%20-%20Collaboration%20Harness%20Implementation%20Plan.md)
for the ordered boundary.

The research starting point is
[`docs/Frame Work/01-AI-Colloboration-Report.md`](docs/Frame%20Work/01-AI-Colloboration-Report.md). It informs the
architecture but is not treated as an unquestionable specification.

## Run the collaboration core

The current implementation uses Node's built-in SQLite API and has been exercised with Node 26.

```bash
npm install
npm test
npm run collab -- init
npm run collab -- agent list
```

The default database is `.collab/collab.db`. Override it per invocation with `--db PATH` or set `COLLAB_DB`.
All successful command results are JSON; failures are JSON on stderr with a nonzero exit code.

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
```

Run `npm run collab -- help` for the complete command list.

## Development checks

```bash
npm test
npm run lint
npm run build
```

The React/Vite scaffold remains in place but is intentionally outside the current implementation boundary.
