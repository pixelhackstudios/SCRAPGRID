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
   - **COMPLETE** — `2a9480cbe3adeea59cde6a7f533874e67d3217b6` (implementation),
     `4ec211777e0234acfcfa0fa397c1a0ca4dc37cd1` (ownership lifecycle)
7. **Sessions / heartbeat / recovery**
   - **COMPLETE** — `c067efbe2d341907afa865735bdbcedc2f81ffe2` (implementation),
     `08964d3bdf9e49d408eabdde438eac3b2871208b` (replacement-boundary review fix)
8. **Deterministic dispatcher**
   - **COMPLETE** — `e0dd0d9b7afc81c35eda1e89b5cf2fbd5810bbd1` (implementation candidate),
     `9794626c0b449daa6d5b98ed79cb153aa53ac752` (accepted review fixes)
9. **Deterministic context bundles + bundle identity**
   - **COMPLETE** — `8413415f2326d5a793a659c3b32498ad13c8bc54` (implementation candidate),
     `1f5671735624df8d8b83ca80b665db629f1a157d` (accepted migration fix)
10. **Pilot 002**
    - **NEXT**

Implement these prerequisites in order. A step is complete only when its bounded implementation and validation
are committed and pushed. Do not begin the next step while a blocking review finding remains open on the current
step.

## Architecture freeze and stopping rule

New ideas go into the parking lot unless they are required to complete one of the ten prerequisites or prevent
Pilot 002 from producing misleading results. Do not expand a prerequisite into a generalized platform before the
pilot demonstrates that need.

## Parking lot

Deferred until real evidence demands them.

- **Monotonic operation outcomes.** `completeOperation()` overwrites a terminal outcome rather than requiring
  `outcome IS NULL`. Raised during step 6 review, when a daemon-ownership overlap could have let one process
  classify an attempt as abandoned while another completed it. That path was removed and regression-tested in
  `4ec211777e0234acfcfa0fa397c1a0ca4dc37cd1`, so the remaining value is defense in depth — and the guard opens a
  second question it does not answer: what a caller should do when zero rows change. Revisit only if Pilot 002 or
  another concrete failure shows the extra defense is needed.

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
