# QA readiness report

_Snapshot for the availability/ownership hardening pass. Update the counts when
the eval suite changes._

## Automated scenario coverage

All deterministic owners (TurnPlan, Availability Truth, variant matcher,
grounding validator) are covered by unit/integration evals. The live LLM
phrasing layer is verified by manual PRD live-testing, not these suites.

| Suite | Passing | Failing | Covers |
|---|---:|---:|---|
| `eval-live-core-flows` | 64 | 0 | core scenarios: workflow + search/clarify/gender + availability card-count + leak/CTA/family invariants + sizing + sale + comparison card-contract + same-session pivots + sale-search input |
| `eval-availability-truth` | 51 | 0 | availability classification, soft color, style disambiguation, follow-up memory (incl. color-only follow-up size inheritance), width split |
| `eval-variant-matcher` | 39 | 0 | size/width/SKU normalization, Aetrex labels, ranges, array-shape options |
| `eval-turn-plan` | 112 | 0 | workflow classification across all 11 workflows (incl. multi_recommendation, compatibility, sizing_help, sale_browse; comparison outranks multi_recommendation for two named families) |
| `eval-turn-plan-gates` | 26 | 0 | executable gate deciders (search/display/clarifier) |
| `eval-turn-plan-failures` | 19 | 0 | regression cases from prior PRD failures |
| `eval-named-family-evidence` | 14 | 0 | named-family evidence requirement |
| `eval-clarifier-and-detector` | 41 | 0 | clarifier blocking + specific-product detection (generic words like "weather" never a family) |
| `eval-evidence-alignment` | 19 | 0 | card/text family alignment |
| `eval-grounding-validator` | 74 | 0 | factual-safety blocking/warning partition + comparison length cap |
| `eval-support-handoff` | 23 | 0 | customer-service handoff: explicit human, dead-end, partial, validation-failed; never on successful turns |
| `eval-constraint-plan` | 15 | 0 | ConstraintPlan: multi-recommendation slots, compatibility, category-noun exclusion, kids gender, structured constraints |
| **Total** | **497** | **0** | |

Run all: `npm run build && for s in scripts/eval-*.mjs; do node "$s"; done`

## What this pass fixed (proven failures only)

Per the "no new behavior without a proven failure" rule, the one behavior change
this pass made was driven by a QA scenario that reproduced a failure:

- **Deictic availability follow-up** — `"and in black?"` / `"in a 9?"` with a
  product in focus classified as `clarification`, so the deterministic
  availability block never ran (even though `resolveAvailabilityRequest` already
  handled it). Fixed in `turn-plan.server.js` (`FOLLOWUP_AVAIL_RE`, gated to ≤5
  words + product context). Locked by `eval-live-core-flows`.
- **Failure A — generic sizing showed a random product.** "I need help choosing
  the right size" planned as `browse`/`searchRequired`, and the forced-search
  layer searched the raw sentence → random "Mila Low Boot" + "View All Women's
  Boots". Fixed with a `sizing_help` workflow (no search, no cards), the
  `forcedSearchAllowed` invariant (no forced search without a concrete
  constraint or when the answer is a clarifying question), and a clarification
  card-wipe guard. Sizing on a named/focus product → `named_product_advisory`.
- **Failure B — "show me current sales" gave a support answer.** Planned as
  `browse` and raw-searched → 0 cards + Support Hub CTA. Fixed with a
  `sale_browse` workflow (search `onSale=true` with category/gender/price, never
  the raw sentence), promo-mechanics → `policy_account`, and Support-CTA
  suppression on commerce turns.
- **Comparison ran 3 agent retries + flooded the carousel + still too long.**
  "Which is better, Jillian or Savannah?" retried 3× (re-searching each time),
  showed 9 cards, and shipped 646-687 char answers. Fixed: comparison cards
  pinned to one per family (≤4); comparison retries are **forced rewrite-only**
  (tools off — both products are already pooled), with a `[grounding-retry]
  VIOLATION` if a retry re-searches; and `compactComparison` (≤4 sentences,
  ≤110 words) is applied **deterministically to every comparison answer at ship
  time**, not just when flagged `too_long`. Broad/support CTAs suppressed.
- **Condition/advisory forced search raw-queried the sentence.** "I need
  supportive sandals for vacation walking, but cute" force-searched the whole
  sentence with category=-. Fixed: `buildAnswerWorkflowForcedSearch` now builds a
  STRUCTURED query (support + style + use-case + condition + category →
  "supportive cute walking sandals", category=sandals) and never inherits stale
  size/width/onSale/category.
- **Dead-ends instead of a customer-service handoff.** The bot would ship "I
  don't know / I can't verify / I'm not finding" or a weird fallback. Added a
  central `support-handoff.js` gate: HARD handoff (replace text + support
  CTA, drop cards) on explicit human request / dead-end-no-cards / exhausted
  validator / weak policy; SOFT handoff (keep card + add line + CTA) on a partial
  availability answer. Never fires on a successful product/sale/comparison turn
  or a normal clarification; no fake CTA when `supportUrl` is blank.
- **Handoff CTA opened Support Hub instead of live chat.** The handoff shipped
  an SSE `type:"link"` anchor → Support Hub. Now it emits `type:"support_cta"`,
  which the widget renders as a button calling `openSupportChat(fallbackUrl)` —
  prefers Zendesk, then Intercom, then Gorgias, Support Hub URL only as fallback.
  The `[data-dead-end="support"]` button uses the same opener so all support
  paths behave identically. (Helper renamed `support-handoff.server.js` →
  `support-handoff.js` so the route imports it without tripping React Router's
  server-only-module resolver.)

- **Stability pass: comparison vs multi, evidence-plan card survival, follow-up
  size inheritance.** Three PRD blockers fixed as one pass:
  1. *Comparison must outrank multi_recommendation.* "Compare Sydney and Rebecca
     for standing at a wedding" (with category words like "wedge"/"heels") wrongly
     decomposed into a category multi. Fix: when the customer uses a
     compare/versus/which-is-better frame AND names two families, the turn stays
     `comparison` (`turn-plan.server.js`: the multi branch now yields when
     `hasNamed && COMPARISON_RE`).
  2. *EvidencePlan workflows must not hard-fail on a validator exhaustion.* A
     `multi_recommendation` pins one card per slot deterministically; when the
     LLM's phrasing couldn't pass the validator (too_long warning + a "mismatch"
     blocking error), the runner retried 3× then hard-handed-off and DROPPED the
     pinned cards. Fix: cardOwner=evidence-plan retries are rewrite-only, and on
     exhaustion the runner ships a deterministic concise fallback ("Here are
     three strong starting points: the X for sandals, the Y for sneakers, and
     the Z for slippers.") and KEEPS the pinned cards — no handoff
     (`llm-owns-turn.server.js` evidence-plan exhaustion branch + `chat.jsx`
     `evidenceFallbackText`).
  3. *Color-only follow-up inherits the earlier size.* "…Jillian in sage?" →
     "what about size 8?" → "and in black?" ran availability with size=- and
     disambiguated. Fix: `priorAvailabilityConstraints` accumulates the most
     recent size/width/color across ALL prior turns, the family is resolved by
     scanning prior turns for the most recent one that NAMES a family (not just
     the most recent constraint message), and the resolved family is passed to
     `resolveAvailabilityRequest` so inheritance runs → family=jillian,
     color=black, size=8.
  Plus a cleanup: generic everyday words ("weather", "today", "store", …) are
  denylisted in `catalog-resolver.server.js` so a coincidental "Weatherproof…"
  SKU never makes "weather" a product family.

- **Complex mixed requests were flattened into one broad search.** Added a
  ConstraintPlan/EvidencePlan layer (`constraint-plan.js`): multi-category asks
  ("one sandal, one sneaker, one slipper for heel pain") → `multi_recommendation`
  with one slot per category, each searched separately, one card pinned per slot;
  orthotic-fits-shoe questions → `compatibility` (answer from product + orthotic
  knowledge, only the named card, no random orthotic browse). Category nouns are
  never product families; kids never falls back to adult; condition/multi cards
  survive the scorer/alignment (no 5→0 wipe on category-level language).

## Known limitations

1. **LLM phrasing is not unit-tested.** Advisory/sales language quality
   (workflows: browse, comparison, advisory, condition) depends on the live
   model and is only verified by manual PRD testing. The evals guarantee
   *routing, facts, and cards*, not tone.
2. **Availability card display needs cards in the search pool.** When the model
   doesn't surface the family card in its tool results, Availability Truth pins
   whatever it filtered from the pool; if that's empty it falls back to
   text-only (correct answer, no card). The pin guarantees *no extra/wrong*
   cards, not that a card always appears.
3. **denial-recovery / recovery search overlap** the grounding validator and
   answer-workflow forced-search but aren't provably redundant — kept live as
   safety nets (see `docs/legacy-removal-plan.md`, Group 4).
4. **Width truth** is only as good as the variant data: when a family carries no
   Width option, width questions return UNKNOWN with an honest "not a tracked
   option" answer rather than a guess.
5. **Cross-repo drift risk.** The public mirror must be kept in lockstep
   manually; `scripts/audit-legacy-owners.mjs` guards the legacy guards but not
   every file.

## Remaining cleanup candidates

From `docs/legacy-removal-plan.md` — none removed yet:
- **After 2wk clean QA + flag retirement:** legacy dispatcher cascade
  (variant-fact / policy / resolver-no-match / product-turn engine),
  auto-broaden, repeated-clarifier escape.
- **Own scoped change:** PRODUCT_AUTHORITY gates, shadow mode.
- **Keep (conditional):** denial-recovery, recovery search — until tests prove
  the validator/forced-search subsume them.

## Production readiness estimate

**Ready for continued PRD soak / supervised live use.** The deterministic core
(routing, availability truth, factual safety, card ownership, support handoff) is green at 490/0
and instrumented with the `[turn-invariant]` log + VIOLATION check for live
monitoring. The remaining risk is concentrated in (a) LLM phrasing quality
(monitored manually) and (b) legacy code that is inert on PRD but not yet
deleted (rollback safety). Recommended gate before removing the kill switch:
**2 weeks of PRD logs with zero `[turn-invariant] VIOLATION` lines** and no new
reproduced failures, then proceed with the Group 1–3 removals.

Confidence: **medium-high** for the availability/ownership surface; **medium**
overall pending the LLM-phrasing soak.
