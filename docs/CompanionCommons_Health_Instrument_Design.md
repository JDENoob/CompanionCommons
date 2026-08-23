# CompanionCommons Health Instrument Design (v1)

## Why this exists
The original check-in instrument (single 1-8 ad-hoc slider per domain, no behavioral anchors beyond a global impression label) is well-suited to consumer engagement but not to commercial credibility. Pharma and insurance buyers evaluating a licensed dataset will ask what instrument was used to collect it. This redesign moves toward the standard real veterinary clinical research already uses, without infringing on it.

## Grounding in real veterinary literature
Three published, validated instruments were reviewed before designing our own:

- **CBPI (Canine Brief Pain Inventory)** — developed at the University of Pennsylvania (Brown et al., 2007), validated on a sample of 70 owners of dogs with osteoarthritis and 50 owners of clinically normal dogs (120 total). 11 items across pain severity (4 items) and pain interference with activity (6 items), plus a standalone quality-of-life item, each on a 0-10 scale. Used in real pharma clinical trials, including for Galliprant (grapiprant) and Librela (bedinvetmab). Copyright held by Dr. Dorothy Cimino Brown; terms of use published at CanineBPI.com. Structurally the closest fit to our mobility domain — brief, owner-completed, real commercial pedigree.
- **LOAD (Liverpool Osteoarthritis in Dogs)** — 23 items, designed for biannual administration alongside veterinary assessment, not weekly owner self-service. Owned by the University of Liverpool, distributed under exclusive license by Elanco, restricted to animal healthcare professionals. Ruled out as a direct model — wrong cadence for our use case, and licensing is a hard wall controlled by a company that's a potential future counterparty on both the customer and competitor side of our B2B business.
- **CCDR (Canine Cognitive Dysfunction Rating Scale)** — developed from a cross-sectional survey of 957 dogs aged 8+, 13 items distilled from 27 candidates, covering orientation, memory, apathy, impaired smell, and locomotion. Used as the domain reference for our cognitive redesign (orientation, memory, interest/engagement, sleep-wake pattern — smell dropped as unreliable for a lay owner to observe consistently at home).

## Legal position — not a substitute for real counsel
No item wording, response anchors, or item structure (count, grouping, order) was copied from any of the above. Facts and behavioral concepts (e.g., "dogs with pain avoid stairs") aren't copyrightable; specific expression and compilation structure can be. Our instrument was built independently: our own construct definition, our own candidate item generation, our own wording, our own item count and grouping decisions, deliberately not mirroring any single source instrument's structure. This should be confirmed by real IP counsel before the instrument is considered final — either as part of the existing planned privacy/data-monetization lawyer conversation, or a separate IP-specific question. This document is not a substitute for that review.

## Target for future formal validation
CBPI's original validation used 120 dogs; its bone cancer validation used 100; CCDR's development used 957. These are realistic near-term targets for CompanionCommons's own real logging data, not distant aspirational numbers. Once real volume in this range exists, running actual validation (factor analysis, internal consistency / Cronbach's alpha, responsiveness testing) turns this from "reasonably designed" into "validated" — a real, achievable milestone, not a someday goal.

## Design principles applied throughout
- Every item is a neutral current-state rating, never a comparison presupposing a direction of change (no "how much lower/worse than usual" framing anywhere — this was caught and corrected during design; zero must always be a natural, unforced answer)
- Higher score always means more concerning, consistently across every domain and item (this is a deliberate reversal from the old energy/appetite convention, where higher used to mean better — chosen for composite-scoring and future alert-logic simplicity, and to match how CBPI itself is scored)
- 0-10 scale throughout, not the old 1-8, matching the standard convention across the veterinary pain/cognition literature
- Timeframe language matches actual cadence: "this past week" on weekly domains, "this past month" on the 4-week-cadence cognitive domain
- Button-tap input (0-10 discrete buttons), not a drag slider — more accurate and less error-prone on mobile than dragging across 11 discrete stops
- Mobility and cognitive get full multi-item composites (4 items each); energy and appetite stay single-item, weekly. Mobility because it's the core commercial wedge and can shift week to week (injury, new medication, vet visit); cognitive because its 4-week cadence gives friction budget for more depth without raising weekly load; energy/appetite are supporting signals, not the core sell, so single-item weekly keeps overall friction manageable

## The locked instrument

### Mobility Impact Score (weekly, 4 items)
| Item | 0 | 10 |
|---|---|---|
| Getting Up | No difficulty, gets up right away | Severe difficulty, struggles significantly or needs help |
| Stairs | No difficulty, moves easily | Severe difficulty, avoids stairs entirely or needs to be carried |
| Stiffness After Rest | Moves normally right away | Remains very stiff even after moving around, doesn't fully loosen up |
| Walk Distance | No limitation, walks normal distances easily | Severe limitation, unable to walk normal distances |
Composite = average of the four items, 0-10.

### Energy (weekly, 1 item)
"How would you rate your dog's energy level?" — 0 = Normal, active energy level → 10 = Very low energy, lethargic most or all of the time

### Appetite (weekly, 1 item)
"How would you rate your dog's appetite?" — 0 = Normal, healthy appetite → 10 = Barely eating or refusing food

### Cognitive Impact Score (every 4th week, 4 items)
| Item | 0 | 10 |
|---|---|---|
| Orientation | Not at all, fully alert and aware | Frequently disoriented or confused |
| Memory / Recognition | No signs of forgetting | Frequent signs of forgetting |
| Interest / Engagement | Normal interest and engagement | Little to no interest, seems withdrawn |
| Sleep-Wake Pattern | Normal sleep pattern | Significantly disrupted |
Composite = average of the four items, 0-10.

## Downstream dependencies
- STEP 27E (AI Contextual Logging Questions) should be redesigned around structured, per-item confounder branching once this instrument ships — a meaningful score delta on a specific item (e.g., Stairs) is a much stronger trigger than a change to a single vague mobility slider ever was.
- health_alerts trend-detection logic needs to move from comparing single stored slider values to comparing composite scores (and potentially individual item deltas).
- Dashboard, Journey Summary, and breed guide "current status" displays all reference the old single-score fields and need updating to the new composite structure.
