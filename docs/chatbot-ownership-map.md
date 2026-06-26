# Chatbot ownership map

This is the contract for **who owns what** on a turn. It exists so that future
changes don't quietly move ownership and reintroduce the class of bug we just
fixed (Availability Truth selecting cards that a downstream scorer then drops).
When in doubt, the rule is: **the owner of a decision is the only code allowed
to make it; everyone downstream may clean for safety but may not re-decide.**

## Owners

| Concern | Owner | Notes |
|---|---|---|
| **Workflow** (which kind of turn this is) | **TurnPlan** (`app/lib/turn-plan.server.js`, `planTurn`) | Classifies every turn into one of 11 workflows: `policy_account`, `availability`, `comparison`, `named_product_advisory`, `condition_recommendation`, `multi_recommendation`, `compatibility`, `sale_browse`, `sizing_help`, `browse`, `clarification`. Also owns `searchRequired`, `clarificationAllowed`, `productDisplayPolicy`, `gender`. |
| **Constraint decomposition** | **ConstraintPlan / EvidencePlan** (`app/lib/constraint-plan.js`) | The structured layer between TurnPlan and search. `extractConstraintPlan` decomposes the latest message into askType + productFamilies + categories + conditions + useCases + constraints + **slots** (one per category for a multi-recommendation). Category nouns (sandal, sneaker, …) are NEVER product families. chat.jsx searches each slot deterministically and pins one card per slot (`evidencePinnedCards`). |
| **Exact product / color / size / width availability** | **Availability Truth** (`app/lib/availability-truth.js`) | For `workflow=availability` only. Resolves family → style → variant truth and produces AVAILABLE / UNAVAILABLE / UNKNOWN / NOT_FOUND / DISAMBIGUATION, the answer **text**, and the **cards**. Its output is authoritative for that turn. |
| **A new constraint applied to the SET just shown** | **Prior-evidence availability** (`chat.jsx` + `app/lib/prior-evidence.js`, `priorEvidencePinnedCards`) | For `workflow=prior_evidence_availability` ("do they come in black?" after a multi-product turn). Remaps EACH previously-displayed family to the new color/size/width via Availability Truth, shows only the matching prior products' cards, and OWNS the deterministic answer text ("Yes — Tamara and Danika come in black. I'm not seeing Mandy…"). Cards are a subset/remap of the prior families — **never the scorer, never random alternates**. |
| **Comparison cards** | **Comparison pin** (`chat.jsx`, `comparisonPinnedCards`) | For `workflow=comparison`: the LLM owns the verdict text; the code pins ONE representative card per named family (max 4), bypassing the scorer so a two-product comparison shows ~2 cards, never a flooded carousel. When the pool lacks a family card the pin searches for that family independently; if NONE are found it ships text-only (`comparisonPinnedCards=[]`) — **a comparison turn never falls back to scorer cards**. |
| **Advisory / sales language** | **LLM** | Owns the persuasive, advisory, and conversational phrasing for non-availability turns (browse, comparison, advisory, condition, clarification). Never owns a hard availability yes/no. |
| **Factual safety** | **Grounding validator** (`app/lib/grounding-validator.server.js`) | Blocks ungrounded claims (sizes/colors/stock/policy facts not present in the evidence pool) and non-answers on answer-workflows, forcing a synthesis retry. Owns "is this claim supported by what the model actually saw." |
| **Final safety cleanup** | **Response contract / post-processing** (`response-contract.server.js`, the in-loop guards) | May trim banned phrasing, strip a lineup-promise sentence, suppress a misleading CTA, clear stale cards. **Never selects products** and never overrides an owner's decision. |
| **Customer-service handoff** | **Support handoff** (`app/lib/support-handoff.js`) | A final safety GATE (not a text scrubber). When the bot genuinely can't finish — explicit human request, dead-end with no cards, exhausted validator, weak policy answer — it replaces the dead-end with a polite handoff + the configured support CTA (HARD). When it has a card but one unconfirmable detail, it keeps the card and adds a handoff line (SOFT). Never fires on a successful product/sale/comparison/availability turn or a normal clarification. |

## Hard rules

1. **Cards must come from the same evidence pool as the answer.** The cards
   shown are the products the model (or Availability Truth) actually used to
   answer. Cleanup may *remove* an unsupported card; it may never *add* an
   unrelated one or resurrect a card the answer doesn't reference.

2. **Do-not-mutate (availability).** Once Availability Truth pins its cards and
   text for `workflow=availability` (`availabilityPinnedCards`), downstream code
   must not **replace, broaden, wipe, or add** cards, and must not rewrite the
   availability answer text. The final card emitter reads
   `availabilityPinnedCards` and bypasses the scorer / group guards / alignment
   / chip-suppression entirely. The only escape hatch is Availability Truth
   itself throwing (best-effort), in which case the model's answer stands.

3. **No broad CTA on exact availability.** A precise yes/no/unknown answer must
   not carry a "View All Women's Sandals" collection or auto-search link — that
   makes a precise answer look like browse mode. The family card (and its
   product page) is the answer.

4. **Workflow is decided once.** TurnPlan decides the workflow before synthesis;
   downstream code reads `ctx.turnPlan.workflow` but never reclassifies.

5. **No forced search from a raw non-product sentence.** A plan-driven forced
   card search (`chat.jsx`, `forcedSearchAllowed`) may run ONLY when the plan is
   a concrete commerce workflow AND the turn carries a concrete constraint
   (named product / focus / category / color / condition / sale / price). It is
   refused outright for `clarification` / `sizing_help` / `policy_account`, and
   whenever the assistant's own answer is a clarifying question. This is what
   stops "I need help choosing the right size" from force-searching the sentence
   and surfacing a random product.

6. **Sizing advice vs stock check.** "What size should I *get*?" is sizing
   advice (`sizing_help` with no product context → ask; `named_product_advisory`
   with a product → answer from fit/review data). "What sizes do you *have*?" is
   `availability`. Generic sizing never shows cards.

7. **Shopping a sale is commerce, not support.** "What's on sale" → `sale_browse`
   (search `onSale=true`, show discounted cards, never a Support Hub CTA). Only
   promo *mechanics* ("military discount?", "promo code?") are `policy_account`.

8. **Comparison is a governed CONCISE workflow.** Bubble shape: ≤4 sentences,
   ≤110 words, answer-first ("Pick X for Y. Choose Z if A."). `compactComparison`
   is applied **deterministically to every comparison answer at ship time** (not
   gated on a `too_long` warning) — first ≤4 sentences, then drop trailing
   sentences / hard-truncate to ≤110 words. **Retries never re-run tools:** both
   products' facts are already pooled, so any comparison retry is forced
   rewrite-only (tools off); a comparison attempt >1 that searched logs a
   `[grounding-retry] VIOLATION`. Cards: ≤4, one per named family. No broad "View
   All" CTA — the cards ARE the comparison. **cardOwner=scorer on a comparison
   turn with cards is a VIOLATION** — the comparison pin is the only card owner.

13. **Rewrite-only retries don't search and don't re-pick cards.** When the
    runner forces a tools-off rewrite (`comparison` / `evidence-plan`, or a
    style-only fix), it carries the prior attempt's final cards + `cardOwner`
    into the retry (`ctx.rewriteOnlyRetry`, `ctx.carriedCards`,
    `ctx.carriedCardOwner`). On that retry chat.jsx (a) skips the plan-driven
    forced search and the evidence-plan / compatibility per-slot searches, and
    (b) restores the carried pinned cards + owner so the scorer NEVER takes over
    a comparison / evidence-plan / availability turn on a text-only rewrite.
    Rewrite-only means exactly: rewrite from existing evidence, do not search
    again.

11. **Never dead-end — hand off.** When the bot can't confidently answer, it does
    NOT ship "I don't know / I can't verify / I'm not finding" or a weird generic
    fallback. The support-handoff gate replaces it with a polite "Aetrex customer
    service can help" + the configured CTA (HARD), or keeps a partial answer's
    card and adds a confirmation line (SOFT). Logs `[handoff] mode=… reason=…
    support=… cards=…`. If `supportUrl` is blank, the text still names customer
    service but no fake button is emitted. This is a safety net, NOT a substitute
    for a real product answer.

10. **Condition / advisory forced search is STRUCTURED, never the raw sentence.**
    With no named family, `buildAnswerWorkflowForcedSearch` assembles the query
    from the latest message's constraints — support + style adjective + use-case
    + condition + category (e.g. "supportive cute walking sandals", category=
    sandals) — instead of raw-querying the whole sentence. Stale memory
    (size/width/onSale/category) never leaks in.

9. **Memory hygiene.** Variant-level (`size`/`width`) and sale (`onSale`)
   constraints are turn-ephemeral: a prior availability/sale turn's values never
   silently filter a later browse/condition/comparison search. They apply only
   when the latest message restates them (availability resolves them on its own
   deterministic path).

12. **Complex asks are DECOMPOSED, not flattened.** A request spanning multiple
    categories ("one sandal, one sneaker, one slipper for heel pain") →
    `multi_recommendation`: one slot per category, each searched separately, one
    card pinned per slot (`evidencePinnedCards` → cardOwner=evidence-plan). An
    orthotic-fits-shoe question ("can I put orthotics in the Jillian?") →
    `compatibility`: answered from product + orthotic knowledge, only the named
    product's card shown, never a random orthotic browse. Category nouns
    (sandal/sneaker/slipper/…) are categories, never product families. For
    `condition_recommendation`/`multi_recommendation`, current-turn evidence
    cards survive the scorer/alignment — alignment removes hard contradictions
    only, never a 5→0 wipe on category-level answer language.

14. **A new constraint on the SET just shown has a real owner.** When the last
    turn displayed 2+ distinct families and the customer applies a bare
    color/size/width follow-up ("do they come in black?", "what about size 8?",
    "do all three come in wide?"), TurnPlan routes to
    `prior_evidence_availability` (NOT normal availability with `named=false`,
    which finds no family and leaks scorer cards). chat.jsx remaps EACH prior
    family to the new constraint via Availability Truth, shows only the matching
    prior products' cards (a per-family scoped search, never a broad scorer
    search), and OWNS the deterministic answer naming which prior items match and
    which don't. **Invariants:** `cardOwner` must be `prior-evidence` (or
    `availability-truth`) — `scorer` is a VIOLATION; every final card must belong
    to a previously-shown family — a stray (random alternate) is a VIOLATION. If
    none match, it ships text-only and offers to look for alternatives — never
    random replacement cards. A single prior family still uses the normal
    availability path; naming a NEW product this turn routes to normal
    availability.

## Turn invariant log

Every turn emits one structured line (see `chat.jsx`, search `[turn-invariant]`):

```
[turn-invariant] workflow=<w> answerOwner=<llm|availability-truth|prior-evidence> cardOwner=<availability-truth|comparison|evidence-plan|prior-evidence|scorer|none> pinnedCards=<n|-> finalCards=<n> textCleanupChanged=<yes|no>
```

- `answerOwner` — who produced the customer-facing text.
- `cardOwner` — who produced the final cards.
- `pinnedCards` — count Availability Truth pinned (`-` when it didn't run).
- `finalCards` — count actually emitted.
- `textCleanupChanged` — did the safety-cleanup pipeline change the owner's text.

**Invariant:** for `workflow=availability` with `pinnedCards != -`,
`finalCards` MUST equal `pinnedCards`. A mismatch logs
`[turn-invariant] VIOLATION availability pinned=… but final=…` — a downstream
mutator broke the do-not-mutate rule and must be fixed (not worked around).

## Where this is enforced / tested

- Pinning + bypass: `app/routes/chat.jsx` (`availabilityPinnedCards`).
- Availability truth: `scripts/eval-availability-truth.mjs`.
- Workflow classification + cross-cutting invariants:
  `scripts/eval-live-core-flows.mjs`.
- Legacy reachability (what may still mutate a turn): `scripts/audit-legacy-owners.mjs`
  and `docs/legacy-removal-plan.md`.
