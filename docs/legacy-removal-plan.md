# Legacy removal plan

Companion to `docs/legacy-cleanup-audit.md` (reachability analysis) and
`scripts/audit-legacy-owners.mjs` (self-verifying audit). This doc adds the
**removal schedule**: for each legacy owner, when (if ever) it is safe to delete.

**Nothing is removed in this change.** Removal happens only when an owner is
(1) unreachable on the PRD path, (2) covered by replacement tests, and (3) not
needed as a rollback. Run `node scripts/audit-legacy-owners.mjs` before any
removal — it fails if the reachability facts below have drifted from the code.

## Schedule legend

- **Active in PRD?** reachable on the live path (`LLM_OWNS_ALL_TURNS` unset/true).
- **Only when flag=false?** reachable only with the kill switch flipped.
- **Remove now?** safe to delete in the next change.
- **Remove after 2wk clean QA?** safe once the LLM-owns path has soaked with no
  regressions and the kill switch is retired.
- **Keep permanently?** not legacy / still load-bearing.

| Owner | Active in PRD? | Only when flag=false? | Remove now? | Remove after 2wk clean QA? | Keep permanently? |
|---|---|---|---|---|---|
| old product-turn engine (`runProductTurnDispatch`) | no | yes | no | yes | no |
| variant fact dispatcher (`runVariantFactDispatch`) | no | yes | no | yes | no |
| old resolver no-match dispatcher (`runResolverNoMatchDispatch`) | no | yes | no | yes | no |
| policy dispatcher (`runPolicyTurnDispatch`) | no | yes | no | yes | no |
| denial recovery | **yes** | no | no | no | **conditional** |
| recovery search (condition/occasion) | **yes** | no | no | no | **conditional** |
| repeated-clarifier escape | no | yes | no | yes | no |
| auto-broaden | no | yes | no | yes | no |
| PRODUCT_AUTHORITY gates (`PRODUCT_TURN_ENGINE_ENABLED`) | no | no | no | yes (own change) | no |
| shadow mode (`LLM_OWNS_ALL_TURNS_SHADOW` + orthotic-gate shadow) | no | no | no | yes | no |

## Detail & sequencing

### Group 1 — the legacy dispatcher cascade (remove together, after 2wk)
`runVariantFactDispatch`, `runPolicyTurnDispatch`, `runResolverNoMatchDispatch`,
`runProductTurnDispatch`. All live **after** the `if (isLlmOwnsTurnEnabled()) { …
return; }` short-circuit in the route loader, so they are statically unreachable
while the flag is ON. They are the kill-switch rollback path.

**Removal order when the time comes:**
1. Confirm no PRD/staging env sets `LLM_OWNS_ALL_TURNS=false` (the kill switch).
2. Make `isLlmOwnsTurnEnabled()` return `true` unconditionally (retire the flag).
3. Delete the four dispatcher functions + their call sites in one change.
4. Replacement coverage already exists: `eval-live-core-flows.mjs`
   (workflow + search routing), `eval-availability-truth.mjs`,
   `eval-grounding-validator.mjs`, `eval-turn-plan*.mjs`.

### Group 2 — flag-gated in-loop post-processors (remove after 2wk)
`auto-broaden` and `repeated-clarifier escape` are explicitly gated
`!llmOwnsTurnActive()` → dead on PRD. Replaced by: the model owning breadth +
the card guards (auto-broaden), and the plan clarifier gate + grounding
validator's clarifier-non-answer blocking kind (repeated-clarifier). Safe to
delete with Group 1.

### Group 3 — independent experiment/diagnostic flags (own change, after 2wk)
- **PRODUCT_AUTHORITY gates** — `PRODUCT_TURN_ENGINE_ENABLED`, default OFF, not
  set on PRD. The `!productAuthorityModeEnabled()` guards are no-ops on PRD; the
  authority engine branch never runs. Removable independently of the kill
  switch, but in its own scoped change (it threads through several guards).
- **Shadow mode** — `LLM_OWNS_ALL_TURNS_SHADOW` + orthotic-gate shadow. Pure
  diagnostics (runs the other path into a discard buffer, logs the diff). Never
  reaches the customer. Delete once the migration is closed and the diff data is
  no longer wanted.

### Group 4 — STILL LIVE, do NOT remove (conditional / keep)
`denial-recovery` and `recovery search` run **inside** `runAgenticLoop`'s
post-processing, which the architecture intentionally keeps on the LLM-owns
path. They are NOT flag-gated:
- denial-recovery: fires when the model denies availability **without searching**.
- recovery search: fires when the model pitches products **without searching**.

The grounding validator now blocks most ungrounded denials and the
answer-workflow forced-search covers most no-search pitches, but neither is
**provably** a full superset yet. **Keep until** a targeted test proves the
replacement subsumes each case; only then do they move to "remove". Until then
they are conditional keepers, not deletion candidates.

## Pre-removal checklist (paste into the removal PR)

- [ ] `node scripts/audit-legacy-owners.mjs` passes (no drift).
- [ ] No env in PRD/staging sets `LLM_OWNS_ALL_TURNS=false`.
- [ ] ≥2 weeks of PRD `[turn-invariant]` logs with no `VIOLATION` lines.
- [ ] `eval-live-core-flows.mjs` + `eval-availability-truth.mjs` +
      `eval-grounding-validator.mjs` + `eval-turn-plan*.mjs` all green.
- [ ] Removing only owners marked "Remove now" or "Remove after 2wk" above —
      never a Group 4 keeper.
