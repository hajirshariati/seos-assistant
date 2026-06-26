# Legacy-owner cleanup audit (`LLM_OWNS_ALL_TURNS=true`)

**Status: AUDIT ONLY — nothing deleted.** This report inventories every legacy
"owner" that can produce or mutate a turn's answer and records whether it is
still reachable on the current PRD path (where `LLM_OWNS_ALL_TURNS` defaults
ON). The companion script `scripts/audit-legacy-owners.mjs` prints the same
table and **fails if the guards it relied on are no longer present in the
source**, so this report cannot silently drift from the code.

## How the flag gates the turn

- `isLlmOwnsTurnEnabled()` / `llmOwnsTurnActive()` read `LLM_OWNS_ALL_TURNS`.
  Both default **ON**; `LLM_OWNS_ALL_TURNS=false` is the kill switch.
- In the route loader, `if (isLlmOwnsTurnEnabled()) { … emit … return; }`
  short-circuits the turn. The **entire legacy dispatcher cascade**
  (`runVariantFactDispatch` → policy → resolver-no-match → `runProductTurnDispatch`)
  lives *after* that `return`, so it is statically unreachable while the flag is ON.
- `runAgenticLoop` (the agentic model loop + its in-loop post-processors) runs on
  **both** paths. So a handful of post-processors are *not* turned off by the flag
  and remain live on PRD — these are the ones that need care.

## Audit table

| Owner | Active on PRD? | Flag-gated off? | Needed as rollback? | Safe to delete |
|---|---|---|---|---|
| `runVariantFactDispatch` | no | yes | yes | later |
| `runProductTurnDispatch` | no | yes | yes | later |
| legacy dispatcher cascade (variant_fact / policy / resolver_no_match / product_engine) | no | yes | yes | later |
| denial-recovery | **yes** | no | yes | **unsafe** |
| recovery search (condition/occasion) | **yes** | no | yes | **unsafe** |
| auto-broaden | no | yes | yes | later |
| repeated-clarifier escape | no | yes | yes | later |
| PRODUCT_AUTHORITY gates (`PRODUCT_TURN_ENGINE_ENABLED`) | no | no | no | later |
| shadow mode (`LLM_OWNS_ALL_TURNS_SHADOW` + orthotic-gate shadow) | no | no | no | later |

## Per-owner detail

### `runVariantFactDispatch` / `runProductTurnDispatch` / the dispatcher cascade
Unreachable on PRD — they are the `else` of the LLM-owns short-circuit (the LLM
path emits then `return;`). Kept **only** as the kill-switch rollback path. This
is the single largest block of legacy code. **Delete `later`**: only after the
kill switch itself is permanently retired, then the whole cascade can go at once.

### denial-recovery — **live, do NOT delete**
Inside `runAgenticLoop` post-processing (which the architecture intentionally
keeps on the LLM-owns path). Gated by
`!productAuthorityModeEnabled() && !productSearchAttempted && containsAvailabilityDenial(...)`
— **not** by `llmOwnsTurnActive()`. So it still fires on PRD when the model
denies availability without searching. The grounding validator now blocks most
ungrounded denials, but it does not provably subsume the no-search case yet.
Keep until a test proves the validator fully covers it.

### recovery search (condition/occasion) — **live, do NOT delete**
Also inside `runAgenticLoop`. Gated by
`!productAuthorityModeEnabled() && !productSearchAttempted && looksLikeProductPitch(...) && pool empty`.
Reachable on PRD when the model pitches products without searching. Overlaps the
answer-workflow forced-search in `emit-finalize`, but not provably redundant.
Keep until covered.

### auto-broaden — delete `later`
Explicitly gated `!llmOwnsTurnActive()` → dead on PRD. Under LLM-owns the model
owns breadth and the card guards / response contract own the final set. Safe to
delete once the flag is retired.

### repeated-clarifier escape — delete `later`
Explicitly gated `!llmOwnsTurnActive()` → dead on PRD. Replaced under LLM-owns by
the plan clarifier gate + grounding validator (clarifier-non-answer is a blocking
kind). Safe to delete after the flag is retired.

### PRODUCT_AUTHORITY gates — delete `later` (independent of the kill switch)
A separate experiment flag, `PRODUCT_TURN_ENGINE_ENABLED`, default OFF and not
set on PRD, so `productAuthorityModeEnabled()` is always false. The
`!productAuthorityModeEnabled()` guards therefore always pass (no-op gates) and
the product-authority engine branch never runs on PRD. Not a rollback for
LLM-owns. The dead `productAuthorityModeEnabled() === true` branches can be
removed in their own scoped change.

### shadow mode — delete `later`
Diagnostic only: runs the *other* path into a discard buffer and logs the diff;
engages only when its own env flag is true (default OFF, not set on PRD). Never
reaches the customer. Harmless to keep; remove once the migration is closed.

## Recommendation

1. **Delete now:** nothing. Keep the kill switch until the LLM-owns path has
   soaked on PRD.
2. **Before deleting the `later` group:** retire `LLM_OWNS_ALL_TURNS` (make ON
   unconditional), confirm no PRD env still sets it to `false`, then delete the
   cascade + flag-gated post-processors in one change.
3. **Do not touch** denial-recovery and recovery search until tests prove the
   grounding validator / answer-workflow forced-search subsume them.
4. Run `node scripts/audit-legacy-owners.mjs` after any change to this area — it
   fails on drift between this report and the code.
