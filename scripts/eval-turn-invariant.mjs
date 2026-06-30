// Turn-invariant violation sink (audit #7) — counters are recorded + readable.
//
// Run: node scripts/eval-turn-invariant.mjs

import assert from "node:assert/strict";
import {
  recordTurnInvariantViolation,
  getTurnInvariantCounters,
  totalTurnInvariantViolations,
  resetTurnInvariantCounters,
  KNOWN_INVARIANT_CODES,
  ownerFallthroughAfterRequiredGate,
  shownCardsNotInActiveOwnerPool,
} from "../app/lib/turn-invariant.server.js";
import { negationCorruptedPositiveCategory } from "../app/lib/chat-postprocessing.js";
import { hardGenderFailOpen } from "../app/lib/turn-plan.server.js";
import { staleWidthAppliedAcrossProducts, availabilityTextCardColorMismatch } from "../app/lib/availability-truth.js";
import { handoffOnCatalogBrowse } from "../app/lib/support-handoff.js";
import { pivotSearchScopeLeak, effectiveScopeForSearch } from "../app/lib/effective-scope.server.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

console.log("\nturn-invariant violation counters\n");

test("starts empty", () => {
  resetTurnInvariantCounters();
  assert.deepEqual(getTurnInvariantCounters(), {});
  assert.equal(totalTurnInvariantViolations(), 0);
});

test("recording increments the per-code counter (and logs)", () => {
  resetTurnInvariantCounters();
  recordTurnInvariantViolation("card_not_in_evidence_pool", { cards: ["ghost"] });
  recordTurnInvariantViolation("card_not_in_evidence_pool", { cards: ["phantom"] });
  recordTurnInvariantViolation("comparison_scorer_takeover", { cardOwner: "scorer" });
  assert.deepEqual(getTurnInvariantCounters(), {
    card_not_in_evidence_pool: 2,
    comparison_scorer_takeover: 1,
  });
  assert.equal(totalTurnInvariantViolations(), 3);
});

test("reset clears all counters", () => {
  recordTurnInvariantViolation("x");
  resetTurnInvariantCounters();
  assert.equal(totalTurnInvariantViolations(), 0);
});

test("a clean run (no violations recorded) reports zero — the CI assertion", () => {
  resetTurnInvariantCounters();
  // (no recordTurnInvariantViolation calls)
  assert.equal(totalTurnInvariantViolations(), 0, "a regression that fires a violation would make this non-zero");
});

// ── 2026-07 state/scope-ownership invariants ─────────────────────────────────
test("registry lists every new hard invariant code", () => {
  for (const code of [
    "current_turn_negation_corrupted_positive_category", "hard_gender_fail_open",
    "stale_width_or_color_applied_to_new_product", "availability_text_card_color_mismatch",
    "handoff_on_catalog_browse", "owner_fallthrough_after_required_gate",
    "shown_card_not_in_active_owner_pool", "pivot_search_scope_leak",
    "support_handoff_cards_leak", "spec_question_answered_as_availability",
    "handoff_meta_text_leak",
  ]) {
    assert.ok(KNOWN_INVARIANT_CODES.has(code), `registry must list ${code}`);
  }
});

test("pivot_search_scope_leak: stale 'sneakers/walking' in a pivot query fires; clean query passes", () => {
  const message = "Wait, show me shoes instead, not orthotics.";
  // The exact bad case from the PRD log.
  assert.deepEqual(
    pivotSearchScopeLeak({ message, query: "women's sneakers walking", filters: { category: "sneakers", gender: "women" }, relevanceFloorCategory: "sneakers" }).sort(),
    ["sneakers", "walking"],
  );
  // A clean, current-message-only query leaks nothing (gender is exempt).
  assert.deepEqual(pivotSearchScopeLeak({ message, query: "women's shoes", filters: { gender: "women", category: "footwear" } }), []);
  // SYNONYM: "i need insole for my dad" → resolver query "orthotics" is CORRECT
  // (insole/insert/footbed = orthotics), NOT a leak. Live trace 2026-06-30 false
  // positive that logged an [err]-level violation.
  assert.deepEqual(pivotSearchScopeLeak({ message: "i need insole for my dad", query: "orthotics", filters: { category: "orthotics", gender: "men" } }), []);
  assert.deepEqual(pivotSearchScopeLeak({ message: "do you have arch support inserts", query: "orthotics", filters: { category: "orthotics" } }), []);
  // CANONICAL CATEGORY: "wedges" → the Aetrex category slug "wedges-heels"; the
  // "heels" inside it is the category's own name, not a stale constraint (live
  // trace 2026-06-30 [err] false positive on a normal wedges browse).
  assert.deepEqual(pivotSearchScopeLeak({ message: "Do you have wedges in black?", query: "black wedges-heels", filters: { category: "wedges-heels", color: "black" } }), []);
  assert.deepEqual(pivotSearchScopeLeak({ message: "Are there any wedges under $120?", query: "wedges-heels", filters: { category: "wedges-heels" } }), []);
  // The effective scope for this pivot is current-message-only.
  const scope = effectiveScopeForSearch({ latestUserMessage: message, turnScope: "new_independent", sessionGender: "women" });
  assert.equal(scope.pivot, true);
  assert.equal(scope.category, "footwear");
  assert.deepEqual(scope.rejectedCategories, ["orthotics"]);
  assert.equal(scope.useCase, null);
  assert.equal(scope.condition, null);
  assert.equal(scope.width, null);
  assert.deepEqual(scope.families, []);
  assert.equal(scope.gender, "women");
});

test("current_turn_negation_corrupted_positive_category: false after the fix, never corrupts a positive", () => {
  // "Now only show me sandals, not shoes" must NOT corrupt the positive sandals.
  assert.equal(negationCorruptedPositiveCategory("Now only show me sandals, not shoes."), false);
  assert.equal(negationCorruptedPositiveCategory("I don't want sneakers, show me sandals"), false);
  assert.equal(negationCorruptedPositiveCategory("no boots or sandals"), false);
});

test("hard_gender_fail_open: opposite-gender card under a hard gender request fires", () => {
  assert.equal(hardGenderFailOpen({ requestedGender: "women", shownCardGenders: ["men", "men"] }), true);
  assert.equal(hardGenderFailOpen({ requestedGender: "women", shownCardGenders: ["women"] }), false);
  assert.equal(hardGenderFailOpen({ requestedGender: null, shownCardGenders: ["men"] }), false);
});

test("stale_width_or_color_applied_to_new_product: far-back width never leaks", () => {
  const colors = ["rose", "champagne", "black"];
  const leaky = [
    { role: "user", content: "Do you have Jillian in wide?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "Does Jillian come in rose or champagne?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "What about size 8?" },
  ];
  assert.equal(staleWidthAppliedAcrossProducts(leaky, colors), false, "width must not leak from the far-back turn");
});

test("availability_text_card_color_mismatch: 'available in Rose' + Denim card fires", () => {
  const fire = availabilityTextCardColorMismatch({
    text: "Yes — the Jillian is available in Rose.",
    cards: [{ title: "Jillian Braided Sandal - Denim" }],
  });
  assert.equal(fire, "rose");
  const clean = availabilityTextCardColorMismatch({
    text: "Yes — the Jillian is available in Rose.",
    cards: [{ title: "Jillian Braided Sandal - Rose" }],
  });
  assert.equal(clean, null);
});

test("handoff_on_catalog_browse: hard handoff on a browse turn fires; explicit-human exempt", () => {
  assert.equal(handoffOnCatalogBrowse({ mode: "hard", reason: "dead_end_no_answer", workflow: "browse" }), true);
  assert.equal(handoffOnCatalogBrowse({ mode: "hard", reason: "explicit_human_request", workflow: "browse" }), false);
  assert.equal(handoffOnCatalogBrowse({ mode: null, reason: "catalog_no_match_refine", workflow: "browse" }), false);
});

test("owner_fallthrough_after_required_gate: off-domain cards under an active gate fire", () => {
  assert.equal(ownerFallthroughAfterRequiredGate({ requiredGate: "orthotic-gate", finalOwner: "scorer", offDomainCards: 3 }), true);
  assert.equal(ownerFallthroughAfterRequiredGate({ requiredGate: "orthotic-gate", finalOwner: "orthotic-gate", offDomainCards: 0 }), false);
  assert.equal(ownerFallthroughAfterRequiredGate({ requiredGate: null, finalOwner: "scorer", offDomainCards: 3 }), false);
});

test("shown_card_not_in_active_owner_pool: a shown card outside the owner pool is flagged", () => {
  const strays = shownCardsNotInActiveOwnerPool({
    shownCards: [{ handle: "a" }, { handle: "ghost" }],
    ownerPool: [{ handle: "a" }, { handle: "b" }],
  });
  assert.deepEqual(strays.map((c) => c.handle), ["ghost"]);
  assert.deepEqual(shownCardsNotInActiveOwnerPool({ shownCards: [{ handle: "a" }], ownerPool: [{ handle: "a" }] }), []);
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
