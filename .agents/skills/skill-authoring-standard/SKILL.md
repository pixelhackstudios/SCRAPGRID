---
name: skill-authoring-standard
description: |
  Governing standard for authoring, reviewing, and validating all agent skills, differentiated by skill class:
  framework (governance) skills carry the full section structure; capability (craft, technique, library,
  workflow) skills satisfy a minimum integration contract and their subtype's own body standard.
  MANDATORY: Execute whenever creating, modifying, or auditing files in `.agents/skills/`.

  Trigger immediately for:
  - Designing a new skill structure, or classifying a proposed skill as framework or capability.
  - Modifying or updating an existing skill file.
  - Auditing skills for quality compliance.
  - Adding a capability skill to a family routing document, or defining a new capability subtype standard.

  DO NOT trigger for:
  - Performing application code development or testing that does not modify the skill framework itself.
  - Executing an installed capability skill's own procedure (use that skill directly).
---

# Skill Authoring Standard

This document governs the quality, structure, boundaries, and validation of all agent skills.

## Skill Classes

This repository contains two classes of skill. They answer different questions, carry different authority, and
therefore have different structural requirements. Determine the class before applying any other rule in this
document — most requirements below are class-specific.

### Framework Skill (Governance)

Answers **"who decides what, on what evidence, and where does the work go next?"** A framework skill owns a
discipline's authority boundary, activation conditions, decision classification, escalation path, evidence
model, and handoffs to other disciplines.

Framework skills must satisfy the full requirements of this document, including every section listed under
[Exact Deliverables](#exact-deliverables) and every gate under [Validation Gates](#validation-gates).

Installing, removing, or changing the ownership of a framework skill is a Material change requiring explicit
authorization.

Current framework skills: `task-framing`, `product-design`, `creative-direction`, `visual-design`,
`ux-writing`, `copywriting`, `software-development`, `frontend-development`, `testing-and-verification`, and
this standard.

### Capability Skill (Craft, Technique, Library, Workflow)

Answers **"how is this actually made?"** A capability skill supplies technique, library knowledge, visual
direction, specialist procedure, or a reusable workflow. It executes *within* the authority framework skills
define; it does not define authority.

Capability skills must satisfy the
[Capability Skill Integration Contract](#capability-skill-integration-contract) below. They must **not** be
forced into the framework-skill section structure — a technique skill wrapped in twelve governance sections
buries its operational content in ceremony that changes no agent behaviour.

Capability skills have subtypes, each of which may have its own body-authoring standard:

| Subtype | What it owns | Body-authoring standard |
|---|---|---|
| `technique` | One visual or interaction mechanism | `codex/web-technique-to-skill` |
| `direction` | A coherent visual/expressive direction | No standard yet — see [Open Authoring Standards](#open-authoring-standards) |
| `library` | An external library, framework, or vendor system | Preserve the upstream/reference structure that makes it accurate and current |
| `workflow` | A repeatable multi-step procedure | No standard yet — see [Open Authoring Standards](#open-authoring-standards) |
| `foundation` | Cross-cutting craft knowledge applied by many skills | No standard yet — see [Open Authoring Standards](#open-authoring-standards) |

Do not impose one body structure across subtypes. The seven `gsap-*` skills are correct *because* they preserve
a technical-reference shape; rewriting them into mechanism-extraction form would degrade them.

## Capability Routing

Capability skills are selected through their family's **routing document** (for web-design capabilities,
`.agents/skills/web-design/README.md`). Description matching alone does not discriminate among dozens of
skills whose descriptions share vocabulary, so a family with overlapping skills requires a router.

### Subtypes and Routing Groups Are Different Axes

Keep these distinct; conflating them is the most likely source of confusion for a future author.

- A **subtype** classifies what a skill *is*, and therefore how it is **authored**. The five subtypes above are
  the complete set.
- A **routing group** classifies what a *request needs*, and therefore how skills are **selected**. Routing
  groups are defined by a family's router, and a single group may contain skills of several subtypes.

The web-design router's "page archetypes" group is the clearest example: it contains `workflow` skills
(`build-awwwards-quality-sites`, `build-threejs-scroll-worlds`), a `direction` skill
(`cinematic-scroll-storytelling`), and cross-cutting page knowledge (`landing-page`) — grouped together because
a user picking a page shape looks in one place, not because they are authored alike.

Adding a routing group is a router-level decision requiring no change here. Adding a **subtype** is a change to
this standard and is Material, because a subtype implies a distinct body-authoring standard. Do not promote a
routing group to a subtype merely because it has its own selection rule; promote it only when its members share
authoring requirements the existing subtypes cannot express.

### What a Routing Document Owns

- the routing groups for its family, and which skills belong to each;
- **selection rules**, including exclusivity ("at most one direction per project", "at most one page-archetype
  skill per page") and combination rules;
- nearest-neighbour distinctions between skills a request could plausibly match either way;
- known overlaps not yet resolved, so an agent can route around them.

A routing document owns **selection**, never **authority**. Selecting a capability skill does not give it
standing over a controlling framework output; where a capability skill and an approved specification or thesis
disagree, the approved output governs.

### Consumption Requirement

A framework skill that consumes capability knowledge must consult the applicable family routing document before
choosing among capability skills, rather than selecting on description match. The framework skills that consume
capability knowledge, and the point at which each does so, are stated in their own Ordered Procedures —
`creative-direction` when reaching for expressive references, `visual-design` when reaching for visual direction
or treatment technique, and `frontend-development` when reaching for implementation technique or a library.

`task-framing` may identify the applicable **family** when routing a task; it does not select individual
capability skills, which would make it a technique router and duplicate the disciplines' own authority.

## Capability Skill Integration Contract

The minimum a capability skill must satisfy to participate safely in this framework. Each requirement exists to
prevent an observed failure; do not add requirements for structural symmetry with framework skills.

1. **Identity** — a `name` in frontmatter matching its directory name, unique across `.agents/skills/`.
   *Prevents:* ambiguous or colliding references from routers and other skills.
2. **Activation description** — a `description` in frontmatter carrying the concrete trigger phrases a user
   would actually type. State the mechanism or outcome, not an unsupported adjective. A description whose
   distinguishing terms are `premium`, `clean`, `modern`, or `beautiful` does not discriminate against its
   siblings and will be selected arbitrarily.
   *Prevents:* the wrong skill loading, or several near-identical skills loading together.
3. **Capability type** — state the subtype (`technique`, `direction`, `library`, `workflow`, `foundation`)
   where it is not already unambiguous from the skill's routing entry.
   *Prevents:* stacking multiple `direction` skills, which produces incoherent output.
4. **Nearest neighbour boundary** — when another installed skill plausibly covers the same request, name it in
   the opening lines and state when to reach for it instead. Required only where a genuine near-neighbour
   exists; a skill with no plausible overlap does not need to invent one.
   *Prevents:* two skills that both "add particles" with no stated boundary, so neither is picked correctly.
5. **Framework authority boundary** — when a capability skill's content touches territory a framework skill
   owns (product behaviour, exact interface or promotional copy, visual specification, creative thesis,
   independent verification), state that the framework skill governs and this skill supplies technique within
   it. Required only where the overlap actually exists.
   *Prevents:* a capability skill silently taking ownership of a governed discipline.
6. **Provenance** — one line stating where the knowledge came from and what conditions it held up under: an
   official vendor source (name it — vendor identity is what makes it checkable and datable), an extracted
   technique (describe the *kind* of work and the constraints it survived), or original authorship.
   Describe **context, not identity**: a reusable skill must not carry a project name, client name, personal
   repository name or path, hard-coded asset path, or unrelated brand in its body. Everything a reader needs
   survives the substitution — "extracted from an owned editorial WebGL project where the effect had to stay
   legible behind display type" answers their question; the project's name does not.
   *Prevents:* stale vendor guidance being trusted as current; unportable skills that assume one machine's
   directory layout; and skills that read as one project's documentation rather than as reusable knowledge.
   For `technique` skills, `codex/web-technique-to-skill` states this rule in the same terms.
7. **Motion lifecycle** — any capability skill whose output animates must state its `prefers-reduced-motion`
   behaviour (render a designed still frame; do not merely hide the effect), and its pause/teardown behaviour
   on `document.hidden`, viewport exit, and unmount.
   *Prevents:* capability output that fails `frontend-development`'s own validation gates.

A capability skill must not contradict a framework skill's authority boundary. Where it appears to, the
framework skill governs and the contradiction is a defect in the capability skill.

### Open Authoring Standards

`direction`, `workflow`, and `foundation` subtypes have no body-authoring standard yet. Until one exists,
author them against the Integration Contract above plus this document's general
[Prohibited Behaviours](#prohibited-behaviours) — in particular the ban on vague advice and generic phrases.
Do not treat the absence of a subtype standard as permission to write adjectives in place of operational
content.

## Purpose and Exclusive Responsibility
- **Goal**: Standardize the construction of agent skills to ensure they are actionable, reliable, self-contained, and clear.
- **Exclusive Responsibility**: Governing the authoring and evolution of the skill framework in `.agents/skills/`, including which requirements apply to which [skill class](#skill-classes). No other skill may define structure or validation rules for skill authoring. This standard may delegate the *body* structure of a capability subtype to a named subtype standard (as it delegates `technique` bodies to `codex/web-technique-to-skill`); such a standard operates under this one and does not compete with it.

## Responsibility Boundaries
- **Primary Responsibility**: Defining the structure, quality rules, layout, and validation guidelines for files within `.agents/skills/`, differentiated by [skill class](#skill-classes).
- **Adjacent Responsibilities**: Integrates with workspace-level configurations (e.g., `AGENTS.md`) and validation pipelines. Delegates capability-subtype body authoring to the subtype standards named in [Skill Classes](#skill-classes).
- **Explicit Exclusions**: Does not govern actual application runtime logic, product features, or tests of software applications. Does not govern the technical accuracy of a capability skill's subject matter — that remains with the skill's own provenance and maintenance.
- **Handoff Conditions**: When a skill has been authored and validated, handoff control to the relevant agent execution flow or user review.

## Activation and Non-Activation Conditions
- **Activation**: Triggers whenever the agent is tasked to:
  - Create a new skill (e.g., creating a new directory in `.agents/skills/`).
  - Modify, extend, or audit any existing skill.
- **Non-Activation**: Does not activate during ordinary software engineering tasks (e.g., editing application source code, writing tests for application features, deploying, etc.) unless those tasks explicitly involve changing or referencing the definition of an agent skill.

## Required Inputs
- Target location for the skill (e.g., `.agents/skills/<skill-name>/`, which may not exist yet).
- Proposed or existing `SKILL.md` (which may not exist yet).
- The context/documentation of the specific task or discipline the skill is designed to solve.

## Authority Boundaries
- **Authorized Actions**:
  - Read access to all existing files under `.agents/skills/` to inspect for duplicate ownership, conflicting instructions, or required handoffs.
  - Write and structure files and directories inside `.agents/skills/<skill-name>/`.
  - Create standard helper scripts under `.agents/skills/<skill-name>/scripts/`.
- **Unauthorized Actions**:
  - Write access outside the target skill (e.g., `.agents/skills/<skill-name>/`) unless broader modification is explicitly authorized.
  - Deleting global configurations or existing skills without explicit user consent.
  - Silently making product, architectural, visual, editorial, or policy decisions outside granted authority.

## Ordered Procedure
1. **Classify the skill**: Determine whether the skill is a [Framework Skill or a Capability Skill](#skill-classes), and for a capability skill, its subtype. This selects which requirements apply for every step that follows. A skill that defines authority, escalation, or handoffs between disciplines is a framework skill regardless of its subject matter.
2. **Scope definition**: Identify the skill’s single primary responsibility, the outcomes it owns, and the responsibilities it explicitly does not own.
3. **Audit & Check**: Check current `.agents/skills/` to confirm that duplicate procedures or competing ownership are avoided. For a capability skill, identify the nearest existing skill covering the same request; if one already covers the mechanism, extend it rather than adding a near-duplicate.
4. **Structure Initialization**: Create the directory structure:
   - `.agents/skills/<skill-name>/SKILL.md`
   - (Optional) `scripts/`, `examples/`, `resources/`, `references/`
5. **Draft SKILL.md**: Write the YAML frontmatter and the body. For a framework skill, conform to the section structure in [Exact Deliverables](#exact-deliverables). For a capability skill, satisfy the [Capability Skill Integration Contract](#capability-skill-integration-contract) and the applicable subtype body standard.
6. **Add Operational Assets**: Add only the supporting assets required for reliable execution. Include examples, scripts, tests, rubrics, references, or resources when they provide operational value. Do not create empty or decorative directories.
7. **Register for Routing**: For a capability skill, add or update its entry in the routing document governing its family (for web-design capabilities, `.agents/skills/web-design/README.md`). An unrouted capability skill competes for activation on description text alone and will be selected arbitrarily against its siblings.
8. **Self-Audit**: Run the validation gates applicable to the skill's class.
9. **Report & Propose**: Present the skill to the user for final verification.

## Evidence Requirements
- **Actionability**: Every procedural step must use imperative language and identify a concrete action plus its expected outcome or validation evidence. Every instruction must map to an observable action, decision, artifact, evaluation criterion, or verification method.
- **Demonstrated Execution**: A framework skill must contain at least one concrete usage example (stored in `examples/` or documented in `SKILL.md`). A capability skill must supply the evidence its subtype standard requires — for `technique` skills a working demo, for `library` skills current and attributable reference material.
- **Operational Constants**: A capability skill that specifies visual, motion, or timing behaviour must carry the actual constants it was tuned to — sizes, ranges, durations, easings, budgets — not adjectives describing them. "Subtle" is not implementable; `0.3–0.5` is.
- **Named Failure Modes**: A capability rule should state the wrong result it prevents, not only the right outcome it seeks. A rule with a named failure is testable; a rule without one is decoration.
- **Tested Skills**: Execution evidence (e.g., run logs) is required only when the skill has actually been tested.

## Exact Deliverables

### Framework Skill Package
1. `SKILL.md` containing:
   - YAML frontmatter with `name` and `description` (with explicit `Trigger immediately for` / `DO NOT trigger for` conditions).
   - Core sections: Purpose and Exclusive Responsibility, Responsibility Boundaries, Activation and Non-Activation Conditions, Required Inputs, Authority Boundaries, Ordered Procedure, Evidence Requirements, Exact Deliverables, Validation Gates, Stop and Failure Conditions, Prohibited Behaviours, Conflict-Resolution and Evidence Hierarchy.
2. Supporting assets (optional):
   - Detailed manuals, rubrics, and reference material moved to supporting files (e.g., `references/`) to keep `SKILL.md` focused.

### Capability Skill Package
1. `SKILL.md` containing:
   - YAML frontmatter with `name` and `description`, satisfying items 1–3 of the [Capability Skill Integration Contract](#capability-skill-integration-contract).
   - A body satisfying contract items 4–7 and the applicable subtype body standard.
2. Supporting assets as the subtype standard requires (for `technique` skills, a working demo; for `library` skills, current reference material).

A capability skill is **not** required to contain the twelve framework sections, an authority hierarchy, a
conflict-resolution hierarchy, or escalation procedure. It inherits all of those from the framework skills
governing the task it executes within.

## Validation Gates

### Applying to Every Skill
- [ ] **Class Declared**: The skill's class — and, for a capability skill, its subtype — is determined and consistent with its content and routing entry.
- [ ] **Target File Existence**: The file exists at the correct path.
- [ ] **Frontmatter Parses**: The file starts with valid YAML frontmatter containing `name` and `description`, and parses successfully.
- [ ] **Name Uniqueness**: The `name` matches its directory and collides with no other installed skill.
- [ ] **No Placeholders**: No TODOs, accidental placeholders, unfinished template text, or unresolved drafting markers remain. Clearly defined instructional metavariables such as `<skill-name>` are permitted.
- [ ] **No Empty Sections**: No heading is followed immediately by another heading. An empty section is a drafting artifact, not a structure.
- [ ] **Link Verification**: All file links resolve correctly. Prefer repository-relative links; use absolute links only when explicitly required or justified.
- [ ] **Clean Package Check**: `git diff` (or workspace audit) contains only the authorized target skill package, explicitly authorized integration changes to existing skills or repository documentation (e.g., updating cross-skill handoffs when a new skill is installed), and no unrelated edits.

### Framework Skills Only
- [ ] **Explicit Triggers**: The `description` contains explicit `Trigger immediately for` and `DO NOT trigger for` conditions.
- [ ] **Required Sections Check**: All twelve framework sections listed under [Exact Deliverables](#exact-deliverables) are present.
- [ ] **Concrete Example**: The concrete usage example is present.
- [ ] **No Duplicate Ownership**: No responsibility owned by another framework skill is re-owned here; adjacent responsibilities intersect only through documented boundaries and handoffs.

### Capability Skills Only
- [ ] **Integration Contract**: Every applicable item of the [Capability Skill Integration Contract](#capability-skill-integration-contract) is satisfied, and each item judged not applicable has an evident reason.
- [ ] **Discriminating Description**: The description's distinguishing terms are mechanisms or outcomes, not unsupported aesthetic adjectives.
- [ ] **Routing Entry**: The skill appears in the routing document for its family, and that entry distinguishes it from its nearest siblings.
- [ ] **No Framework Overreach**: The skill does not assert authority over product behaviour, exact interface or promotional copy, visual specification, creative thesis, or independent verification.
- [ ] **Motion Lifecycle**: If the skill's output animates, reduced-motion and pause/teardown behaviour are specified.

## Stop and Failure Conditions
- **Halt Execution immediately when**:
  - The skill cannot be implemented without modifying global configurations that are out of bounds.
  - A required external tool or dependency is unavailable.
- **On Failure**: Preserve partial work unless it is demonstrably invalid or the user explicitly authorizes deletion. Report:
  - What was completed;
  - What remains;
  - The exact blocker;
  - Whether it is mechanical or requires a policy decision.

## Prohibited Behaviours
- **Vague Advice**: Prohibit phrases like "ensure code is clean", "be careful when editing", "optimize if necessary", or "follow best practices". Every instruction must specify *exactly* how to achieve and verify the outcome.
- **Overlapping Ownership**: Each skill must have one clearly defined primary responsibility. Adjacent skills may intersect only through explicitly documented boundaries and handoffs. Duplicate procedures or competing ownership are prohibited. Between framework skills this means duplicate *authority*; between capability skills it means two skills covering the same mechanism with no stated boundary, so neither can be selected correctly.
- **Cross-Class Authority Assertion**: A capability skill must not assert authority a framework skill owns. Supplying technique inside a governed discipline is correct; deciding product behaviour, exact copy, visual specification, or creative thesis is not.
- **Unsupported Completion Claims**: Do not declare a step or skill complete without evidence appropriate to the claimed outcome. Evidence may include test results, runtime output, diffs, validated artifacts, reference comparisons, acceptance-criteria checks, evaluation rubrics, link checks, or other directly inspectable results.
- **Silent Policy Decisions**: A skill must not silently make product, architectural, visual, editorial, or policy decisions outside its granted authority. Do not interrupt the user for every minor choice: use established project rules and reversible defaults where authorized, and surface only material decisions.
- **Generic Phrases**: Every instruction must map to an observable action, decision, artifact, evaluation criterion, or verification method.

## Conflict-Resolution and Evidence Hierarchy
This hierarchy resolves conflicts among workspace instructions and skill documents. It does not override platform-level, system-level, safety, security, or tool-use requirements governing the agent.
- **Conflict Resolution**:
  1. User's explicit instructions in the current prompt.
  2. Workspace rules (`AGENTS.md` or equivalent).
  3. Governing standard (`.agents/skills/skill-authoring-standard/SKILL.md`).
  4. Individual skill `SKILL.md`.
  5. Global agent guidelines.
- **Evidence Hierarchy (Source of Truth)**:
  The applicable evidence depends on the discipline. Console output is not automatically superior to visual references, approved copy, or explicit user decisions.
  1. Explicit user instructions and decisions from the current task.
  2. Supplied acceptance criteria, screenshots, prototypes, examples, and reference assets.
  3. Observable behaviour and direct execution evidence.
  4. Current workspace files, schemas, architecture, and established conventions.
  5. Tests, compiler output, lint results, and runtime logs where applicable.
  6. Project documentation.
  7. External authoritative references.
  8. Skill defaults and model assumptions.

When evidence conflicts, use the source with the most direct authority over the specific claim. For example, an approved screenshot governs visual fidelity, current official API documentation governs external API behaviour, runtime evidence governs observed application behaviour, and explicit user decisions govern intended outcomes.

## Concrete Usage Examples

> [!NOTE]
> All named execution skills and resource paths in these examples are hypothetical unless explicitly identified as installed. The repository's installed **framework** skills are `skill-authoring-standard`, `task-framing`, `product-design`, `creative-direction`, `visual-design`, `ux-writing`, `copywriting`, `software-development`, `frontend-development`, and `testing-and-verification`. Installed **capability** skills are enumerated by their family routing documents, not here — this list would go stale immediately.

### Example 1: Reviewing a Proposed Framework Skill

A concise review of a proposed skill (`ui-layout-guidance`):

1. **Class**: Proposed as a framework skill — but inspect the claim. It defines *how* to build layouts, not *who decides* layout. It is a **capability** skill (`foundation` subtype), and the twelve framework sections do not apply.
2. **Primary Responsibility**: Define responsive layout mechanics using Grid, Flexbox, container queries, breakpoints, and structural spacing.
3. **Nearest Neighbour Boundary**: State when to reach for the installed `web-design/framed-grid-layout` capability skill instead — that one owns a specific visible-boundary framing treatment; this one owns general layout mechanics.
4. **Framework Authority Boundary**: `visual-design` owns the exact visual specification; this skill supplies layout technique within it and does not choose colours, typography, visual identity, or component behaviour. Interactive behaviour is `frontend-development`'s.
5. **Applicable Evidence**:
   - Approved screenshots or layout specifications.
   - Browser inspection at required viewport sizes.
   - Validation of overflow and responsive behaviour.
   - Inspection of the resulting HTML/CSS.

### Example 2: Classifying an Ambiguous Skill

- **Proposal**: A skill that "reviews rendered pages for craft defects and routes findings to the responsible discipline."
- **Analysis**: It defines routing between disciplines and issues findings that other skills must act on. That is authority, not technique.
- **Classification**: **Framework** skill. It requires the full twelve sections, explicit trigger/non-trigger conditions, and a conflict-resolution hierarchy — and installing it is a Material change requiring authorization, because it adds a discipline to the routing graph.
- **Contrast**: A skill that "checks whether corner radii nest correctly and type scale holds at 390px" with no routing authority is a **capability** skill (`foundation`), and requires none of that.
