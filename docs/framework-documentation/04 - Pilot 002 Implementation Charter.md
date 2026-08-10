# Pilot 002 Implementation Charter

## Authority and status

This document is the frozen implementation sequence required before Pilot 002. Where it conflicts with earlier
planning documents, this document governs Pilot 002 preparation. Earlier documents remain historical records of
how the harness reached its current state.

SCRAPGRID coordinates existing native agent runtimes; it does not replace their terminal, tool, web-search,
file-handling, or agent capabilities. The user-facing terminal is a visual and control layer over those runtimes,
while the collaboration service remains the authoritative truth and coordination layer.

## Pilot 002 prerequisite sequence

1. **Operation ledger + causal `operation_id`**
   - **COMPLETE** — `302c4be98669b3ee40d490c394b15c3a32c88f6b`
2. **Revision claim reservation**
   - **COMPLETE** — `9dbe385cd897eb95520984ea61be2579a2feadbb`
3. **Independent verification**
   - **COMPLETE** — `048ba7cbc3562fcea1c2f386f8a731a6b93e7505`
4. **Base-pinned required-check policy + explicit human override**
   - **COMPLETE** — `20ce79b0039009d715983528b1fdb2b236d7dc5f`
5. **Temporary task roles**
   - **COMPLETE** — `7636555a000f3fba3d75491605fb9a97e8b214e4`
6. **`collabd`**
   - **NEXT**
7. **Sessions / heartbeat / recovery**
   - **PENDING**
8. **Deterministic dispatcher**
   - **PENDING**
9. **Deterministic context bundles + bundle identity**
   - **PENDING**
10. **Pilot 002**
    - **PENDING**

Implement these prerequisites in order. A step is complete only when its bounded implementation and validation
are committed and pushed. Do not begin the next step while a blocking review finding remains open on the current
step.

## Architecture freeze and stopping rule

New ideas go into the parking lot unless they are required to complete one of the ten prerequisites or prevent
Pilot 002 from producing misleading results. Do not expand a prerequisite into a generalized platform before the
pilot demonstrates that need.

## Pre-registered Pilot 002 criteria

### Hard failures

Any of the following means the harness failed the pilot:

- canonical state violates its own task, role, lease, reservation, review, verification, or acceptance rules;
- a task can be accepted without the required independent review and verification evidence for its exact
  repository and candidate commit;
- an operation reports rejection or failure after committing its database-backed domain mutation, leaving a
  retry ambiguous;
- the required review-to-revision-to-re-review cycle cannot complete without manual database or Git repair;
- daemon or session recovery loses canonical state, creates competing execution or claim authority, or makes the
  next permitted action indeterminate;
- the completed task cannot be reconstructed from the operation ledger, domain events, role and dispatch records,
  verification evidence, context-bundle identity, and Git artifacts.

### Evidence signals

The following are measurements, not automatic pilot failures:

- whether peer review finds a material issue that verification did not catch;
- how often the human must clarify, relay, override, or advance work;
- how often an agent misunderstands its task or receives stale or incomplete context;
- the number and causes of rejected, failed, abandoned, or retried operations;
- revision count, coordination latency, and the useful contribution of each model.

Structural breakage fails the pilot. Model usefulness is measured rather than declared. A peer review that finds
nothing is data; a bogus verification that satisfies acceptance is a broken harness.

## Explicitly deferred work

The following remain outside Pilot 002 preparation unless a prerequisite or misleading-pilot risk makes one
strictly necessary:

- semantic AI routing or an AI supervisor;
- game or world-state integration;
- generalized CI or environment orchestration;
- elaborate waiver or override taxonomies;
- exhaustive instrumentation of human routing or cognition;
- generalized fairness or scheduler optimization;
- MCP adapters;
- remote deployment, authentication, or multi-host operation.

Reality from Pilot 002 should generate the next requirements. Do not extend this charter through speculative
architecture before that evidence exists.
