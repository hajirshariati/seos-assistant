# Chatbot ownership map

This is the contract for **who owns what** on a turn. It exists so that future
changes don't quietly move ownership and reintroduce the class of bug we just
fixed (Availability Truth selecting cards that a downstream scorer then drops).
When in doubt, the rule is: **the owner of a decision is the only code allowed
to make it; everyone downstream may clean for safety but may not re-decide.**

## Owners

| Concern | Owner | Notes |
|---|---|---|
| **Workflow** (which kind of turn this is) | **TurnPlan** (`app/lib/turn-plan.server.js`, `planTurn`) | Classifies every turn into one of 7 workflows: `policy_account`, `availability`, `comparison`, `named_product_advisory`, `condition_recommendation`, `browse`, `clarification`. Also owns `searchRequired`, `clarificationAllowed`, `productDisplayPolicy`, `gender`. |
| **Exact product / color / size / width availability** | **Availability Truth** (`app/lib/availability-truth.js`) | For `workflow=availability` only. Resolves family → style → variant truth and produces AVAILABLE / UNAVAILABLE / UNKNOWN / NOT_FOUND / DISAMBIGUATION, the answer **text**, and the **cards**. Its output is authoritative for that turn. |
| **Advisory / sales language** | **LLM** | Owns the persuasive, advisory, and conversational phrasing for non-availability turns (browse, comparison, advisory, condition, clarification). Never owns a hard availability yes/no. |
| **Factual safety** | **Grounding validator** (`app/lib/grounding-validator.server.js`) | Blocks ungrounded claims (sizes/colors/stock/policy facts not present in the evidence pool) and non-answers on answer-workflows, forcing a synthesis retry. Owns "is this claim supported by what the model actually saw." |
| **Final safety cleanup** | **Response contract / post-processing** (`response-contract.server.js`, the in-loop guards) | May trim banned phrasing, strip a lineup-promise sentence, suppress a misleading CTA, clear stale cards. **Never selects products** and never overrides an owner's decision. |

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

## Turn invariant log

Every turn emits one structured line (see `chat.jsx`, search `[turn-invariant]`):

```
[turn-invariant] workflow=<w> answerOwner=<llm|availability-truth> cardOwner=<availability-truth|scorer|none> pinnedCards=<n|-> finalCards=<n> textCleanupChanged=<yes|no>
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
