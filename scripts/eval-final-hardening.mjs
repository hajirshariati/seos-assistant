// FINAL HARDENING (2026-07-09) — the last pre-traffic layer:
//   1. medical disclaimer (permanent, code-applied, model can't remove it)
//   2. handoff context transfer (structured summary for the human agent)
//   3. session foot profile (lightweight continuity, relevant workflows only)
//   4. improvement hook (every violation maps to a tuning target)
//
// Run: node scripts/eval-final-hardening.mjs

import assert from "node:assert/strict";
import {
  applyMedicalDisclaimer, medicalDisclaimerRequired, MEDICAL_DISCLAIMER_TEXT,
} from "../app/lib/medical-disclaimer.js";
import { detectUnsupportedMedicalClaim, detectProcessNarration } from "../app/lib/sales-voice.js";
import { buildHandoffContext, INTENT_DRIVEN_HANDOFF_REASONS } from "../app/lib/support-handoff.js";
import { buildFootProfile, buildFootProfilePromptBlock } from "../app/lib/foot-profile.js";
import { improvementHintFor, KNOWN_INVARIANT_CODES } from "../app/lib/turn-invariant.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

console.log("\nfinal hardening — disclaimer / handoff context / foot profile / improvement hook\n");

// ── 1. MEDICAL DISCLAIMER ─────────────────────────────────────────────────────
check("disclaimer: fires on condition/orthotic answers, appended verbatim", () => {
  const r = applyMedicalDisclaimer({
    workflow: "condition_recommendation",
    message: "I have plantar fasciitis, what shoes do you recommend?",
    text: "I'd start with the Jillian — its contoured arch support keeps you comfortable all day.",
  });
  assert.equal(r.applied, true);
  assert.ok(r.text.endsWith(MEDICAL_DISCLAIMER_TEXT), "the fixed disclaimer is appended verbatim");
});

check("disclaimer: also fires when only the REPLY mentions the condition (orthotic advisory)", () => {
  const r = applyMedicalDisclaimer({
    workflow: "compatibility",
    message: "can I wear those inside sandals?",
    text: "Orthotics belong in closed shoes with removable insoles — Aetrex sandals have built-in arch support instead.",
  });
  assert.equal(r.applied, true);
});

check("disclaimer: does NOT fire on non-medical advisory or policy/support turns", () => {
  assert.equal(applyMedicalDisclaimer({
    workflow: "condition_recommendation",
    message: "something cute for a beach vacation",
    text: "The Gabby is a great pick — light, strappy, and dressy enough for dinners.",
  }).applied, false, "no medical term anywhere → no disclaimer");
  assert.equal(applyMedicalDisclaimer({
    workflow: "policy_knowledge",
    message: "what's your return policy for orthotics?",
    text: "Returns are accepted within 30 days.",
  }).applied, false, "policy turns never get the disclaimer");
  assert.equal(medicalDisclaimerRequired({ workflow: "account_private_handoff", message: "my orthotics order is missing" }), false);
});

check("disclaimer: idempotent — never stacks a second disclaimer", () => {
  const once = applyMedicalDisclaimer({
    workflow: "condition_recommendation", message: "heel pain shoes?",
    text: "The Danika has firm arch support for heel pain days.",
  });
  const twice = applyMedicalDisclaimer({
    workflow: "condition_recommendation", message: "heel pain shoes?", text: once.text,
  });
  assert.equal(twice.applied, false);
  assert.equal(twice.text, once.text);
});

check("disclaimer: text is safe — trips neither the medical-claim nor narration detectors", () => {
  assert.equal(detectUnsupportedMedicalClaim(MEDICAL_DISCLAIMER_TEXT).hit, false);
  assert.equal(detectProcessNarration(MEDICAL_DISCLAIMER_TEXT).hit, false);
});

// ── 2. HANDOFF CONTEXT ────────────────────────────────────────────────────────
check("handoff context: classifies trigger (intent vs validator vs pattern), caps titles", () => {
  const intent = buildHandoffContext({
    workflow: "browse", reason: "explicit_human_request",
    shownTitles: ["Jillian Sandal", "Gabby Sandal", "Danika Sneaker", "Maui Flips", "Fifth Thing"],
    searchAttempted: true,
  });
  assert.equal(intent.trigger, "customer_intent");
  assert.equal(intent.shownBeforeHandoff.length, 4, "titles capped at 4");
  const exhausted = buildHandoffContext({
    workflow: "availability", reason: "validation_failed",
    validatorAttempts: 3, firstErrorKind: "false_color_denial",
  });
  assert.equal(exhausted.trigger, "validator_exhausted");
  assert.equal(exhausted.validatorAttempts, 3);
  assert.equal(exhausted.firstErrorKind, "false_color_denial");
  const pattern = buildHandoffContext({ workflow: "policy_knowledge", reason: "dead_end_no_answer" });
  assert.equal(pattern.trigger, "pattern_dead_end");
  // every intent-driven reason classifies as customer intent except validator exhaustion
  for (const r of INTENT_DRIVEN_HANDOFF_REASONS) {
    const t = buildHandoffContext({ reason: r }).trigger;
    assert.ok(t === "customer_intent" || (r === "validation_failed" && t === "validator_exhausted"));
  }
});

// ── 3. SESSION FOOT PROFILE ───────────────────────────────────────────────────
check("foot profile: extracts conditions/width/size/families from the conversation", () => {
  const p = buildFootProfile({
    messages: [
      { role: "user", content: "I have plantar fasciitis and wide feet." },
      { role: "assistant", content: "…" },
      { role: "user", content: "I'm usually a size 8.5. What about sandals?" },
    ],
    priorShownTitles: ["Jillian Braided Sandal - Rose", "Danika Arch Support Sneaker"],
  });
  assert.deepEqual(p.conditions, ["plantar fasciitis"]);
  assert.equal(p.width, "wide");
  assert.deepEqual(p.sizes, ["8.5"]);
  assert.deepEqual(p.families, ["Jillian", "Danika"]);
  assert.equal(p.empty, false);
});

check("foot profile: prompt block only on relevant workflows, silent when empty", () => {
  const p = buildFootProfile({
    messages: [{ role: "user", content: "I have bunions and need wide shoes" }],
    priorShownTitles: [],
  });
  const block = buildFootProfilePromptBlock(p, "condition_recommendation");
  assert.match(block, /CUSTOMER PROFILE/);
  assert.match(block, /bunions/);
  assert.match(block, /wide/);
  assert.equal(buildFootProfilePromptBlock(p, "policy_knowledge"), "", "policy turns never get the profile");
  const emptyP = buildFootProfile({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(emptyP.empty, true);
  assert.equal(buildFootProfilePromptBlock(emptyP, "condition_recommendation"), "", "nothing known → nothing injected");
});

check("foot profile: never invents — only what the customer actually said", () => {
  const p = buildFootProfile({ messages: [{ role: "user", content: "show me black sneakers" }] });
  assert.deepEqual(p.conditions, []);
  assert.equal(p.width, null);
  assert.equal(p.empty, true);
});

// ── 4. IMPROVEMENT HOOK ───────────────────────────────────────────────────────
check("improvement hook: every hint routes to a tuning target; unmapped codes get triage", () => {
  assert.match(improvementHintFor("advisory_named_unpinned_product"), /^tune=advisory/);
  assert.match(improvementHintFor("answer_source_misattributed"), /^tune=applyAnswerSourceContract/);
  assert.match(improvementHintFor("handoff_on_catalog_browse"), /^tune=detectSupportHandoffNeed/);
  assert.match(improvementHintFor("some_future_code"), /^tune=triage/);
  // Every mapped hint key must be a REAL registered invariant code (no typos).
  const mapped = [
    "unauthorized_owner_for_workflow", "unknown_owner_unregistered",
    "answer_names_product_not_in_evidence", "advisory_named_unpinned_product",
    "product_type_mismatch", "variant_text_card_mismatch",
    "availability_text_card_color_mismatch", "final_card_not_in_current_evidence",
    "answer_source_misattributed", "policy_handoff_without_lexical_fallback",
    "policy_rag_hit_handoff", "handoff_on_catalog_browse",
    "support_handoff_cards_leak", "handoff_meta_text_leak",
  ];
  for (const code of mapped) {
    assert.ok(KNOWN_INVARIANT_CODES.has(code), `hint key ${code} must be a registered invariant`);
    assert.doesNotMatch(improvementHintFor(code), /^tune=triage/, `${code} must have a real hint`);
  }
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
