// RECOVERY-HOP REDUNDANCY PROOF (final hardening, 2026-07-09).
//
// The two in-loop recovery hops (denial-recovery / recovery-condition-search)
// exist for two historical failure classes:
//   A. the model DENIES availability without searching ("we don't carry that")
//   B. the model PITCHES products without searching (empty pool, made-up names)
// This suite PROVES the primary path now covers both classes on its own:
//   - TurnPlan routes these turns with searchRequired=true (forced search)
//   - the grounding validator BLOCKS the bad draft (false_catalog_denial /
//     ungrounded_product_name / answer_workflow_non_answer) and forces a retry
//   - commerce truth refuses to ship listing copy with zero cards
// …and that the hops are now LAST-RESORT (they wait for the primary net to
// fail before firing). Per the removal plan (Group 4) the hops are NOT deleted
// — this proof is the documented precondition for ever doing so, together with
// the [legacy-cov] soak counts.
//
// Run: node scripts/eval-recovery-redundancy.mjs

import assert from "node:assert/strict";
import { planTurn, WORKFLOWS, recoveryHopAllowed, recoveryHopIsLastResort } from "../app/lib/turn-plan.server.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";
import { enforceCommerceTruth } from "../app/lib/commerce-truth.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const CGMAP = {
  sneakers: { genders: ["men", "women"] },
  sandals: { genders: ["men", "women"] },
  orthotics: { genders: ["men", "women"] },
};

console.log("\nrecovery-hop redundancy — the primary path covers the hops' failure classes\n");

// ── LAST-RESORT GATE ──────────────────────────────────────────────────────────
check("last-resort: first attempt on a search-required plan DEFERS to the primary net", () => {
  const plan = planTurn({ message: "do you have wide sandals?" });
  assert.equal(plan.searchRequired, true, "the plan itself carries the forced-search net");
  assert.equal(
    recoveryHopIsLastResort({ plan, attempt: 0, validatorNetActive: true }),
    false,
    "attempt 0 + forced-search + validator → the hop must WAIT",
  );
});

check("last-resort: a retry attempt (primary failed) or a missing net re-arms the hop", () => {
  const plan = planTurn({ message: "do you have wide sandals?" });
  assert.equal(recoveryHopIsLastResort({ plan, attempt: 1, validatorNetActive: true }), true, "validator already failed the draft once");
  assert.equal(recoveryHopIsLastResort({ plan, attempt: 0, validatorNetActive: false }), true, "legacy kill-switch path has no validator — hop is the corrective");
  const noSearchPlan = { workflow: "clarification", searchRequired: false, productDisplayPolicy: "show" };
  assert.equal(recoveryHopIsLastResort({ plan: noSearchPlan, attempt: 0, validatorNetActive: true }), true, "no forced-search net downstream — hop allowed");
});

check("last-resort composes with the suppress guard (policy turns never recover)", () => {
  const plan = planTurn({ message: "Do teachers get a discount?" });
  assert.equal(recoveryHopAllowed(plan), false, "suppress guard blocks before last-resort is even consulted");
});

// ── CLASS A: denial without search — validator owns it ────────────────────────
check("class A: a false catalog denial is BLOCKED by the validator (retry, not hop)", () => {
  const out = validateGrounding({
    text: "We don't carry men's sandals right now.",
    pool: [],
    categoryGenderMap: CGMAP,
    userMessage: "do you have men's sandals?",
  });
  assert.equal(out.ok, false, "the denial never ships as-is");
  assert.ok(out.errors.some((e) => e.kind === "false_catalog_denial"), "blocked specifically as a false denial");
});

check("class A: an availability turn owes a real answer — a generic non-answer is blocked", () => {
  const plan = planTurn({ message: "Do you have the Jillian in black size 8?", namedProduct: true });
  assert.equal(plan.workflow, WORKFLOWS.AVAILABILITY);
  assert.equal(plan.searchRequired, true, "TurnPlan forces the search the model skipped");
  const out = validateGrounding({
    text: "Tell me a bit more about what you're looking for?",
    pool: [{ title: "Jillian Braided Sandal - Black" }],
    workflow: "availability",
    userMessage: "Do you have the Jillian in black size 8?",
  });
  assert.equal(out.ok, false, "a stall on an availability turn is a blocked non-answer");
});

// ── CLASS B: pitch without search — forced-search + validator + commerce truth ─
check("class B: a product name outside the fetched pool is BLOCKED (ungrounded_product_name)", () => {
  // On the primary path the pool is never empty for a pitch: TurnPlan's
  // forced search seeds it (checked below). Given THAT pool, a name the model
  // invented (not in it) is a blocking grounding failure.
  const out = validateGrounding({
    text: "The **Fairytale** is perfect for that — supportive and cute.",
    pool: [{ title: "Jillian Braided Sandal - Rose" }, { title: "Gabby Sandal - Black" }],
    userMessage: "what should I wear for a wedding with heel pain?",
    workflow: "condition_recommendation",
  });
  assert.equal(out.ok, false, "an invented product name never ships");
  assert.ok(out.errors.some((e) => e.kind === "ungrounded_product_name"),
    `blocked as ungrounded (got: ${out.errors.map((e) => e.kind).join(",")})`);
});

check("class B: condition turns carry the forced-search net in the plan itself", () => {
  const plan = planTurn({ message: "I have plantar fasciitis, what do you recommend?" });
  assert.equal(plan.workflow, WORKFLOWS.CONDITION_RECOMMENDATION);
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.clarificationAllowed, false);
});

check("class B: listing copy with ZERO cards is refused at commerce truth", () => {
  const r = enforceCommerceTruth({
    message: "what should I get for standing all day?",
    text: "Here are some great options for standing all day.",
    cards: [], evidencePool: [], knownColors: [], knownFamilies: [],
  });
  assert.ok(r.repairs.some((x) => x.code === "product_listing_without_cards"), "the empty 'here are…' is repaired");
  assert.doesNotMatch(r.text, /^here are/i, "the listing copy is replaced with an honest line");
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  console.log("VERDICT: the primary path (TurnPlan forced-search + grounding validator + commerce truth) covers classes A and B; the hops are last-resort correctives pending the [legacy-cov] soak.");
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
