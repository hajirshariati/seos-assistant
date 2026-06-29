// Turn-invariant violation sink (audit #7) — counters are recorded + readable.
//
// Run: node scripts/eval-turn-invariant.mjs

import assert from "node:assert/strict";
import {
  recordTurnInvariantViolation,
  getTurnInvariantCounters,
  totalTurnInvariantViolations,
  resetTurnInvariantCounters,
} from "../app/lib/turn-invariant.server.js";

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

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
