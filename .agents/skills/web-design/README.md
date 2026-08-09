# Web Design Capability Skills

Capability skills for web visual design, motion, 3D, layout, and interaction technique.

These are **capability skills**, not framework skills. They supply technique and direction; they do not own
authority. Product behaviour remains `product-design`'s, the expressive thesis `creative-direction`'s, the
exact visual specification `visual-design`'s, exact wording `ux-writing`'s and `copywriting`'s, and the
independent verdict `testing-and-verification`'s. See
[`skill-authoring-standard`](../skill-authoring-standard/SKILL.md) for the class distinction.

## Who consults this document, and when

This router is part of the execution path, not background reading. The framework skills that consume capability
knowledge are required to consult it before selecting among these skills:

```text
task request
    ↓
task-framing names the applicable capability family (this document) — but selects no individual skill
    ↓
creative-direction    → reaching for expressive references or a signature device
visual-design         → reaching for a visual direction or a treatment technique
frontend-development  → reaching for an implementation technique or a library
    ↓
this router's groups and selection rules
    ↓
narrowest applicable skill(s)
    ↓
applied within the consuming discipline's existing authority
```

Each of those three skills carries a `Consuming Capability Skills` section stating this, and a validation gate
checking it. `frontend-development` activates for any production frontend change, so a request that reaches
implementation without an upstream design package still passes through this router.

Selecting a skill from this document grants it no authority. Where a capability skill disagrees with an approved
thesis, specification, reference, design token, or accessibility constraint, the approved source governs.

## How to select

**Load the narrowest skill that covers the request.** These skills are additive, not comprehensive — three
technique skills applied to one page is normal; three direction skills is incoherent.

### Groups are not subtypes

The headings below are **routing groups** — they organize skills by what a request needs. A skill's
**subtype** (`technique`, `direction`, `library`, `workflow`, `foundation`) is a separate axis describing how it
is authored, defined by [`skill-authoring-standard`](../skill-authoring-standard/SKILL.md). One group can hold
several subtypes: the page-archetype group below contains `workflow` skills
(`build-awwwards-quality-sites`, `build-threejs-scroll-worlds`), a `direction` skill
(`cinematic-scroll-storytelling`), and cross-cutting page knowledge (`landing-page`) — grouped together because
that is where you look for a page shape, not because they are alike inside.

`archetype` is therefore a routing group here, not a capability subtype. Selection rules below may name either a
group or a subtype; both are valid subjects for a routing rule.

Precedence, in order:

1. **At most one `direction` skill per project.** Directions are whole-page visual systems and they contradict
   each other by design. If two seem to fit, the request is under-specified — resolve it with
   `creative-direction` before picking one, or pick neither and let the thesis drive the visual system.
2. **At most one page-archetype skill per page.** Archetypes carry page structure and section sequence, and two
   sequences cannot both be the page.
3. **A page archetype and a direction may combine.** Their exclusivity scopes differ — archetype per page,
   direction per project — and one supplies structure while the other supplies the visual system.
4. **`technique` skills combine freely.** They own one mechanism each and are meant to be composed.
5. **`library` skills load on demand**, when the project actually uses that library.
6. **Prefer a `technique` skill over a `direction` skill** when the request names a specific effect. "Add a
   word-by-word headline reveal" is a technique request even inside an editorial project.
7. **A direction skill is a starting point, not a specification.** It does not replace `visual-design`'s
   specification or `creative-direction`'s thesis, and adopting one wholesale produces the interchangeable
   result those skills exist to prevent. Where a direction skill and an approved thesis disagree, the thesis
   governs.

## Page archetypes — structure and section sequence

Routing group. Pick at most one. Each carries a page structure, not just a look; members differ in subtype
(see [Groups are not subtypes](#groups-are-not-subtypes)).

| The page is | Use |
|---|---|
| A single-offer conversion page for SaaS, an app, or a service | [`landing-page`](landing-page/SKILL.md) |
| A SaaS pricing page with plans, comparison, and FAQ | [`pricing-page`](pricing-page/SKILL.md) |
| A SaaS/AI product page where a real workflow or demo is the proof | [`product-proof-saas`](product-proof-saas/SKILL.md) |
| An enterprise AI/automation/security page explaining boundaries, approvals, and auditability | [`operational-enterprise-ai`](operational-enterprise-ai/SKILL.md) |
| A creative studio, agency, photographer, or artist portfolio led by project work | [`editorial-portfolio-chapters`](editorial-portfolio-chapters/SKILL.md) |
| An agency/production/architecture/culture site with billboard type and hard chapters | [`documentary-brutalist-agency`](documentary-brutalist-agency/SKILL.md) |
| An appointment-based service site (salon, spa, clinic, hospitality) | [`editorial-service-booking`](editorial-service-booking/SKILL.md) |
| A long-form story, case study, or article rebuilt as a scroll-driven journey | [`scroll-world-storytelling`](scroll-world-storytelling/SKILL.md) |
| A cinematic scroll-driven landing page with sticky stacks and scrubbed transitions | [`cinematic-scroll-storytelling`](cinematic-scroll-storytelling/SKILL.md) |
| An ambitious motion-led marketing, editorial, or portfolio site, art direction included | [`build-awwwards-quality-sites`](build-awwwards-quality-sites/SKILL.md) |
| One continuous 3D world the reader travels through across chapters | [`build-threejs-scroll-worlds`](build-threejs-scroll-worlds/SKILL.md) |

`build-awwwards-quality-sites` is the broadest entry here: it art-directs *and* implements, and it names the
other capability skills it expects to combine with. Reach for it when the request is for ambition rather than a
specific page type. Reach for a narrower archetype when the page type is the request.

## Visual directions — whole-page visual systems

**Pick at most one.** Grouped by family; skills within a family are close neighbours and are candidates for
consolidation (see [Known overlaps](#known-overlaps)).

| Family | Skills |
|---|---|
| Editorial / minimal | [`agency-grid-layout-minimal`](agency-grid-layout-minimal/SKILL.md), [`clean-minimal-beige-light-mode`](clean-minimal-beige-light-mode/SKILL.md), [`book-serif-index`](book-serif-index/SKILL.md), [`image-first-grid-layout`](image-first-grid-layout/SKILL.md), [`editorial-tech`](editorial-tech/SKILL.md) |
| Dark glass | [`dark-glass-clean-layout`](dark-glass-clean-layout/SKILL.md), [`blue-laser-clean-glass-layout`](blue-laser-clean-glass-layout/SKILL.md), [`glass-dark-mode-clock`](glass-dark-mode-clock/SKILL.md) |
| Technical / framed | [`framed-tech-dark-border-gradient`](framed-tech-dark-border-gradient/SKILL.md), [`light-mode-paper-technical`](light-mode-paper-technical/SKILL.md), [`technical-wireframe-info-layout`](technical-wireframe-info-layout/SKILL.md), [`split-layout-technical`](split-layout-technical/SKILL.md), [`funky-purple-container-tech`](funky-purple-container-tech/SKILL.md), [`bright-green-tech-system-webgl`](bright-green-tech-system-webgl/SKILL.md) |
| Dark atmospheric | [`dither-laser-dark-mode`](dither-laser-dark-mode/SKILL.md), [`mesh-gradient-dark-blue-clean`](mesh-gradient-dark-blue-clean/SKILL.md), [`dark-blue-contrasting-clean`](dark-blue-contrasting-clean/SKILL.md), [`tech-green-dark-mode-modern`](tech-green-dark-mode-modern/SKILL.md) |
| Light / product | [`orange-clean-paper-saas`](orange-clean-paper-saas/SKILL.md), [`blue-cloudy-clean-modern`](blue-cloudy-clean-modern/SKILL.md), [`nested-container-clean-agency`](nested-container-clean-agency/SKILL.md) |
| Skeuomorphic | [`high-contrast-skeuomorphic-clean`](high-contrast-skeuomorphic-clean/SKILL.md) |
| Cinematic motion-led | [`cinematic-gsap-lenis-motion-system`](cinematic-gsap-lenis-motion-system/SKILL.md) |

> **Quality caveat.** Most skills in this section currently describe their target in adjectives rather than
> constants, and none yet satisfies the Integration Contract's
> [Operational Constants](../skill-authoring-standard/SKILL.md) requirement. Treat them as mood references, not
> as specifications: they tell you where to aim, not what to set. Derive actual values from `visual-design`'s
> specification. Consolidation and rewrite are tracked in `ROADMAP.md`.

## Motion and scroll

| The need | Use |
|---|---|
| General motion principles, easing and duration defaults, choreography | [`animation-systems`](animation-systems/SKILL.md) |
| GSAP API, timelines, ScrollTrigger, React integration, plugins, performance | The [`gsap-*` family](../gsap-core/SKILL.md) — `gsap-core`, `gsap-timeline`, `gsap-scrolltrigger`, `gsap-react`, `gsap-plugins`, `gsap-utils`, `gsap-performance` |
| Reveal elements as they enter the viewport, no GSAP dependency | [`animation-on-scroll`](animation-on-scroll/SKILL.md) |
| Headline reveals word-by-word through a hard mask edge, on entry | [`masked-reveal`](masked-reveal/SKILL.md) |
| Headline words fade and rise on entry, no mask, no GSAP | [`staggered-word-reveal`](staggered-word-reveal/SKILL.md) |
| Reading progress follows scroll position continuously and reverses | [`scroll-scrubbed-word-reveal`](scroll-scrubbed-word-reveal/SKILL.md) |
| A pinned stage whose visual transforms forward and backward with scroll | [`scroll-scrubbed-visual-sequence`](scroll-scrubbed-visual-sequence/SKILL.md) |
| An ordered process rendered as a progress-tracked timeline | [`scroll-progress-timeline`](scroll-progress-timeline/SKILL.md) |
| Sticky product storytelling with progressive UI reveals | [`gsap-scrolltrigger-storytelling`](gsap-scrolltrigger-storytelling/SKILL.md) |
| A seamless infinite marquee | [`marquee-loop`](marquee-loop/SKILL.md) |

**Smooth scroll:** choose exactly one engine and never initialize two. Default to **ScrollSmoother** when GSAP
is already the animation system — it is free, shares ScrollTrigger's measurement pass, and adds no dependency
(see [`gsap-plugins`](../gsap-plugins/SKILL.md)). Use **Lenis** when smooth scroll is needed without GSAP, or
when a Lenis integration already exists.

## Backgrounds and atmosphere

Composable. Keep the count low — a page needs one atmospheric layer, not four.

| The effect | Use |
|---|---|
| Drifting vertical light folds with a concentrated bloom | [`atmosphere-background`](atmosphere-background/SKILL.md) |
| Perspective WebGL grid receding with parallax | [`background-grid-webgl`](background-grid-webgl/SKILL.md) |
| Bayer-style ordered dither field, near-black, organic wave masses | [`dither-background`](dither-background/SKILL.md) |
| Corner-anchored laser beams with a bright emitter node | [`corner-lasers`](corner-lasers/SKILL.md) |
| Full-screen vertical laser core with halo and fog | [`webgl-laser`](webgl-laser/SKILL.md) |
| Merging organic blobs via SVG filter threshold | [`gooey-blob-system`](gooey-blob-system/SKILL.md) |
| Configurable ambient motes bounded to one section | [`ambient-section-particles`](ambient-section-particles/SKILL.md) |
| Falling shapes that must read as a recognisable object (leaves, petals) | [`falling-leaves`](falling-leaves/SKILL.md) |
| Drop-in animated WebGL backgrounds from a library | [`vantajs`](vantajs/SKILL.md) |
| A hosted interactive animation embed | [`unicorn-studio`](unicorn-studio/SKILL.md) |

`ambient-section-particles` owns generic motes; `falling-leaves` owns particles whose *shape must be
recognisable*. Choose by whether the silhouette carries meaning.

## Pointer and hover interaction

| The effect | Use |
|---|---|
| A mote trail whose spacing stays constant at any hand speed | [`pointer-trail-emitter`](pointer-trail-emitter/SKILL.md) |
| A halftone/twinkle cursor trail rendered in WebGPU | [`add-shader-cursor-trail`](add-shader-cursor-trail/SKILL.md) |
| Fluid ripple distortion following the cursor over an image | [`shaders-cursor-ripples`](shaders-cursor-ripples/SKILL.md) |
| A cursor-following spotlight revealing a second aligned image | [`reveal-hover-effect`](reveal-hover-effect/SKILL.md) |

## Layout structure and surface detail

| The need | Use |
|---|---|
| Thin visible boundary lines with L-shaped corner brackets | [`framed-grid-layout`](framed-grid-layout/SKILL.md) |
| Container-in-container nesting with layered frames | [`nested-container-frames`](nested-container-frames/SKILL.md) |
| Vertical container-width guide lines with corner squares | [`container-lines`](container-lines/SKILL.md) |
| Diagonal-cut / chamfered corners on controls and panels | [`corner-diagonals`](corner-diagonals/SKILL.md) |
| Gradient border edges on cards, nav, modals | [`css-border-gradient`](css-border-gradient/SKILL.md) |
| Layered neutral elevation via exact Tailwind shadow utilities | [`beautiful-shadows`](beautiful-shadows/SKILL.md) |
| Edge fades using mask-image gradients | [`css-alpha-masking`](css-alpha-masking/SKILL.md) |
| Stepped backdrop-blur fading from a viewport edge | [`progressive-blur`](progressive-blur/SKILL.md) |
| Frosted dark-mode glass surfaces with readable contrast | [`glass-dark-ui`](glass-dark-ui/SKILL.md) |
| Pressed, carved, tactile physical surface styling | [`skeuomorphic-ui`](skeuomorphic-ui/SKILL.md) |
| Decorative 01/02/03 numeric section markers | [`number-details`](number-details/SKILL.md) |

`framed-grid-layout`, `nested-container-frames`, and `container-lines` are close neighbours: the first owns
bracketed section boundaries, the second owns nested inset shells, the third owns width guide lines. Pick by
which line is actually visible in the intended result.

## 3D and WebGL

| The need | Use |
|---|---|
| Three.js scene, camera, materials, loaders, disposal | [`threejs`](threejs/SKILL.md) |
| A faceted 3D hero object with real lighting | [`webgl-3d-object`](webgl-3d-object/SKILL.md) |
| A luminous particle globe with an orbital ring | [`globe-particles`](globe-particles/SKILL.md) |
| A data globe with points, arcs, polygons, labels | [`globe-gl`](globe-gl/SKILL.md) |
| A lightweight interactive globe, minimal setup | [`cobejs`](cobejs/SKILL.md) |
| 2D physics bodies and constraints | [`matterjs`](matterjs/SKILL.md) |
| Steering a WebGL-heavy landing page toward a visual outcome | [`webgl-landing-steering`](webgl-landing-steering/SKILL.md) |

`globe-particles` renders a synthesized particle sphere; `globe-gl` and `cobejs` render a geographic globe with
data layers. Choose by whether the sphere carries real geography.

## Components, assets, and libraries

| The need | Use |
|---|---|
| Tailwind layout, theming, responsive and state variants | [`tailwindcss`](tailwindcss/SKILL.md) |
| shadcn/ui components, registries, composition | [`shadcn`](../shadcn/SKILL.md) |
| Animated edge-glow states on cards, buttons, tabs | [`beam-glow-states`](beam-glow-states/SKILL.md) |
| Animated liquid-metal borders (React `metal-fx`) | [`liquid-metal-border`](liquid-metal-border/SKILL.md) |
| AI/agent activity indicators replacing a generic spinner | [`thinking-orbs`](thinking-orbs/SKILL.md) |
| Real company logos as icons rather than text | [`company-logos`](company-logos/SKILL.md) |
| Solar Duotone Bold icon style | [`solar-duotone-bold`](solar-duotone-bold/SKILL.md) |
| Stock photography for backgrounds, portraits, avatars | [`unsplash-asset-images`](../media/unsplash-asset-images/SKILL.md), [`aura-asset-images`](../media/aura-asset-images/SKILL.md) |

**On stock imagery:** legitimate for backgrounds, textures, and real avatar photography where no original asset
exists. Not legitimate as a substitute for a concept, as decorative filler, or as fabricated proof —
`build-awwwards-quality-sites` and `visual-design` both prohibit those uses, and neither is relaxed by the
existence of a sourcing skill.

## Known overlaps

Recorded so an agent can route around them, not yet consolidated. Where two skills overlap, prefer the one whose
stated mechanism matches the request; if neither is clearly closer, prefer the one carrying real constants.

- **`gsap`** is superseded by the seven `gsap-*` skills, which are current and cross-linked. Prefer those; the
  local `gsap` skill remains only for its short recipe list and its cleanup advice is out of date (see its own
  header note).
- **`masked-reveal` / `staggered-word-reveal`** describe near-identical effects with materially different
  constants. Distinguished above by mask edge and GSAP dependency.
- **Scroll storytelling** — `cinematic-scroll-storytelling`, `gsap-scrolltrigger-storytelling`,
  `scroll-world-storytelling`, and `build-threejs-scroll-worlds` overlap substantially. Distinguished above by
  output: page archetype, sticky product section, article transformation, and continuous 3D world respectively.
- **Direction families** — skills within each family row above are close neighbours; the row is the routing
  unit until consolidation.
- **`animation-systems` / `cinematic-gsap-lenis-motion-system`** both define motion systems; the first is
  library-agnostic principles, the second is a GSAP+Lenis cinematic direction.

## Adding a skill here

Follow [`skill-authoring-standard`](../skill-authoring-standard/SKILL.md)'s Capability Skill Integration
Contract, and for a `technique` skill, [`web-technique-to-skill`](../codex/web-technique-to-skill/SKILL.md).
Add the routing entry in the same change — an unrouted skill competes for activation on description text alone
and will be selected arbitrarily against its siblings.

Place it in the routing group where someone would look for it, which need not match its subtype. Adding a new
routing group is a decision this document makes on its own; adding a new capability **subtype** is a change to
`skill-authoring-standard` and is Material.
