# SCRAPGRID — Repository Operating Contract

This file is `AGENTS.md` at the repository root — the operating contract for any agent working in this
repository.

## 1. What this repository is

SCRAPGRID is currently building and testing a multi-agent collaboration harness — `collabd`, the `collab` CLI,
and the coordination schema in `collab/` — before building the MMORPG the harness is meant to eventually
support. The harness itself is the current product. Do not treat this repository as an MMORPG codebase, and do
not treat it as the source of the `.agents/skills/` framework it happens to vendor as a dependency.

## 2. Truth layers

- **Git is artifact truth.** Source code, task branches, and commits are the record of what was actually built.
- **`collabd` / SQLite (`.collab/`) are coordination truth.** Task state, roles, leases, reservations, reviews,
  verifications, and decisions live only there. `.collab/` is gitignored and local to this machine — never
  assume it is portable or ask it to be committed.
- Reconstructing "what happened" on a task requires both: the operation ledger and domain events from
  `collabd`, and the actual Git commits they reference.

## 3. Agents work only from their assigned worktrees

The linked worktrees under `worktrees/{claude,codex,grok}/` (gitignored, `stable collab/<agent>` branches) are
each agent's exclusive workspace and role. Do not edit another agent's worktree, do not work outside your
assigned worktree/branch, and do not create ad hoc worktrees or branches outside what `collab`/`collabd`
manages.

## 4. `collab` is the only interface to coordination state

All canonical coordination operations — claiming, proposing, reviewing, verifying, accepting, messaging,
blocking — go through the `collab` CLI (`collab/cli.ts`, built to `dist-collab/collab`). Never edit
`.collab/collab.db` or any file under `.collab/` directly, and never hand-construct coordination state by
editing Git refs that `collabd` owns (e.g. the `collab/*` branches) outside the flows `collab` performs.

## 5. Obey dispatcher results

The dispatcher (`collab/dispatch.ts`) returns one of `waiting`, `blocked`, `none`, or `indeterminate` when there
is no permitted next action. When you receive one of these results, stop and report it — do not manufacture
work, invent a task, or route around it by acting outside the coordination flow. These results are signals to
relay to the human or wait on, not obstacles to solve creatively.

## 6. Commits and review

- Commit before requesting review. A review or verification request references an exact candidate commit SHA;
  there is nothing to review without one.
- Review and verification operate on the exact candidate commit claimed — not on "the current state of the
  branch," not on intent, not on a later fixup. If the commit changes, the claim changes.

## 7. Pilot 002: architecture freeze

Pilot 002's harness architecture is frozen per
`docs/framework-documentation/04 - Pilot 002 Implementation Charter.md`. During the pilot, do not redesign,
generalize, or extend the harness in response to friction — record the problem and let the human decide whether
it warrants a change afterward. New ideas belong in that document's parking lot unless they are required to
prevent the pilot from producing misleading results.

## 8. Source of truth and authority

1. Current explicit user instructions.
2. This file.
3. `docs/framework-documentation/04 - Pilot 002 Implementation Charter.md` for anything governing Pilot 002
   specifically.
4. Everything else (other docs, `.agents/skills/`, prior session memory) is subordinate — verify against the
   actual repository state rather than relying on a remembered claim.

This hierarchy does not override platform-level, system-level, safety, security, or tool-use requirements
governing the agent.

## 9. Git safety

- Record baseline state (`git status`) before modifying files; distinguish pre-existing work from your own
  changes.
- Never run destructive Git operations (`git reset --hard`, `git clean -fd`, broad `checkout`/`restore`, force
  push) without explicit authorization.
- Protect unrelated work: inspect your diff against the recorded baseline before reporting completion, and
  confirm only files within your authorized scope changed.

## 10. Scope

This file governs process and safety for working in this repository. It does not redefine the coordination
schema, the dispatcher's decision rules, or the harness's internal invariants — those are defined by the code in
`collab/` and by the Pilot 002 charter. Do not treat this file as license to bypass either.
