// Ownership-consolidation audit (2026-07): TurnPlan is the ONLY workflow owner.
// No legacy gate, fallback, validator, postprocessor, or product helper may
// independently decide final customer-visible text/cards unless TurnPlan
// assigned that workflow. This suite pins the SHARED owner-level contract, not
// individual screenshots — one block per broken class the audit targeted.
//
// Run: node scripts/eval-ownership-consolidation.mjs

import assert from "node:assert/strict";
import {
  planTurn, WORKFLOWS, ownerAuthorizedForWorkflow, isWorkflowAgnosticOwner, cardsNotInEvidencePool,
  isRegisteredOwner, registeredOwnerNames, recoveryHopAllowed,
} from "../app/lib/turn-plan.server.js";
import {
  applyAnswerSourceContract, lexicalKnowledgeHit, handoffMetaTextLeak, stripHandoffMetaText, isDeadEndAnswer,
} from "../app/lib/support-handoff.js";
import { answerNamesProductNotInEvidence, KNOWN_INVARIANT_CODES } from "../app/lib/turn-invariant.server.js";
import { effectiveScopeForSearch, pivotSearchScopeLeak, isPivotResetTurn } from "../app/lib/effective-scope.server.js";
import { lexicalRetrieveChunks } from "../app/lib/knowledge-chunks.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const W = WORKFLOWS;
const SUPPORT_CTX = { supportUrl: "https://aetrex.example/support", supportLabel: "Visit Support Hub" };

console.log("\nownership-consolidation — TurnPlan is the only workflow owner\n");

// ── OWNER-AUTHORIZATION REGISTRY (the shared owner-level contract) ───────────
check("registry: every new ownership invariant code is registered", () => {
  for (const c of [
    "unauthorized_owner_for_workflow", "final_card_not_in_current_evidence",
    "answer_names_product_not_in_evidence", "policy_handoff_without_lexical_fallback",
  ]) assert.ok(KNOWN_INVARIANT_CODES.has(c), `missing ${c}`);
});

check("registry hardening: EVERY owner string that reaches turn-invariant logging is registered", () => {
  // The full set of answerOwner/cardOwner strings emitted to logTurnInvariant
  // (audited from chat.jsx). A future owner added without registration fails
  // here — the drift guard behind unknown_owner_unregistered.
  const LOGGED_OWNERS = [
    // dispatch / pre-LLM gates
    "cheat-code", "orthotic-gate", "soft-gender-browse", "soft-browse-refine",
    "variant-facts", "policy-engine", "resolver-no-match", "product-engine",
    // runAgenticLoop finalize owners
    "llm", "prior-evidence", "availability-truth", "compatibility-truth",
    "evidence-plan", "scorer", "comparison", "none",
    // answer-source / handoff
    "answer-source", "support-handoff",
  ];
  for (const o of LOGGED_OWNERS) {
    assert.equal(isRegisteredOwner(o), true, `owner "${o}" reaches logging but is UNREGISTERED`);
  }
});

check("registry hardening: an unknown owner is NOT silently accepted", () => {
  assert.equal(isRegisteredOwner("some-new-owner-2027"), false, "a brand-new owner must read as unregistered");
  // registeredOwnerNames() is the source of truth the drift guard reads.
  const names = registeredOwnerNames();
  assert.ok(names.includes("cheat-code"), "cheat-code is now registered (workflow-agnostic admin bypass)");
  assert.ok(names.includes("orthotic-gate"));
  assert.ok(!names.includes("some-new-owner-2027"));
});

check("registry: browse fallbacks may NOT own a turn TurnPlan gave elsewhere", () => {
  // soft-browse-refine / soft-gender-browse / orthotic-gate must defer on
  // deterministically-owned workflows.
  for (const wf of ["policy_knowledge", "account_private_handoff", "availability", "prior_evidence_availability", "comparison", "product_spec", "named_product_advisory"]) {
    assert.equal(ownerAuthorizedForWorkflow("soft-browse-refine", wf), false, `soft-browse-refine must defer on ${wf}`);
    assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", wf), false, `orthotic-gate must defer on ${wf}`);
  }
  // But they MAY own the browse/clarification turns TurnPlan routes to them.
  assert.equal(ownerAuthorizedForWorkflow("soft-browse-refine", "browse"), true);
  assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", "condition_recommendation"), true);
  assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", "clarification"), true);
});

check("registry: each deterministic owner is scoped to its authorized workflows", () => {
  assert.equal(ownerAuthorizedForWorkflow("availability-truth", "availability"), true);
  assert.equal(ownerAuthorizedForWorkflow("availability-truth", "browse"), false);
  assert.equal(ownerAuthorizedForWorkflow("policy-engine", "policy_knowledge"), true);
  assert.equal(ownerAuthorizedForWorkflow("policy-engine", "browse"), false);
  assert.equal(ownerAuthorizedForWorkflow("comparison", "comparison"), true);
  assert.equal(ownerAuthorizedForWorkflow("comparison", "availability"), false);
  assert.equal(ownerAuthorizedForWorkflow("variant-facts", "product_spec"), true);
  assert.equal(ownerAuthorizedForWorkflow("variant-facts", "comparison"), false);
  // intent-driven owners (explicit human request, empty) are workflow-agnostic.
  assert.equal(isWorkflowAgnosticOwner("none"), true);
  assert.equal(isWorkflowAgnosticOwner("scorer"), false);
});

// ── CLASS 1: ownership pivot (no stale gender/category/color survives reset) ──
check("class=pivot: an explicit reset drops prior category/condition/width/family", () => {
  const msg = "Wait, show me shoes instead, not orthotics.";
  assert.equal(isPivotResetTurn(msg), true);
  const scope = effectiveScopeForSearch({
    latestUserMessage: msg, turnScope: "new_independent", sessionGender: "women",
    inheritedScope: { category: "orthotics", condition: "heel_pain", width: "wide", families: ["lynco"], useCase: "walking" },
  });
  assert.equal(scope.pivot, true);
  assert.equal(scope.condition, null, "stale condition must not survive the pivot");
  assert.equal(scope.width, null, "stale width must not survive the pivot");
  assert.equal(scope.useCase, null, "stale use-case must not survive the pivot");
  assert.deepEqual(scope.families, [], "stale families must not survive the pivot");
  assert.equal(scope.gender, "women", "a stable gender fallback is allowed");
  // and the leak detector catches a stale scope word smuggled into the query
  assert.deepEqual(
    pivotSearchScopeLeak({ message: msg, query: "women's sneakers walking", filters: { category: "sneakers" }, relevanceFloorCategory: "sneakers" }).sort(),
    ["sneakers", "walking"],
  );
});

// ── CLASS 2: policy knowledge (RAG-first, then lexical, then handoff) ─────────
check("class=policy-knowledge: RAG answer is kept, NOT overwritten by a handoff", () => {
  assert.equal(planTurn({ message: "What is your return policy?" }).workflow, W.POLICY_KNOWLEDGE);
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: "What is your return policy?",
    text: "Returns are accepted within 30 days of delivery for unworn shoes.",
    ctx: SUPPORT_CTX, retrievedChunks: [{ fileType: "faqs", similarity: 0.6, content: "x" }],
  });
  assert.equal(r.source, "rag");
  assert.equal(r.handoff, false, "must NOT hand off when RAG answered");
  assert.deepEqual(r.cards, []);
});
check("class=policy-knowledge: lexical fallback catches a dead-end that the corpus DOES cover", () => {
  const corpus = "Teacher discounts: verify your school credentials through SheerID at checkout.";
  assert.equal(lexicalKnowledgeHit("How do I verify I'm a teacher?", corpus), true);
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: "How do I verify I'm a teacher?",
    text: "I don't have that specific detail in my notes.", // model dead-ended
    ctx: SUPPORT_CTX, retrievedChunks: [], knowledgeText: corpus,
  });
  assert.equal(r.handoff, true, "still hands off (model produced no answer)…");
  assert.equal(r.prematureHandoff, true, "…but the corpus HAD it → fires policy_handoff_without_lexical_fallback");
  assert.equal(r.handoffReason, "lexical_hit_but_dead_end");
});
check("class=policy-knowledge: lexical fallback ANSWERS 'verify I'm a teacher' from uploaded knowledge (not just detects)", () => {
  // The exact required regression: RAG missed, but the answer IS in faqs.txt.
  // lexicalRetrieveChunks must surface the teacher section so the model answers
  // from knowledge — never a generic support handoff when the answer exists.
  const knowledge = [
    { fileType: "faqs", content:
      "Shipping\nWe ship within 2 business days.\n\n" +
      "Teacher & Student Discounts\nTo verify you're a teacher, provide your school-issued ID or employment verification through SheerID at checkout. Once verified you receive 15% off.\n\n" +
      "Returns\nReturns accepted within 30 days." },
    { fileType: "brand", content: "Aetrex was founded in 1946 and pioneered arch-support technology." },
  ];
  const q = "What information do I need to provide to verify I'm a teacher?";
  const lex = lexicalRetrieveChunks(knowledge, q, { limit: 3 });
  assert.ok(lex.length > 0, "lexical retrieval must find the teacher section");
  assert.match(lex[0].content, /SheerID|school-issued ID/i, "the matched section is the teacher-verification one");
  assert.ok(lex[0].similarity >= 0.35, "synthetic score clears the policy-engine floor");
  // Feeding those lexical chunks into the contract → answered from knowledge,
  // NO support handoff, NO cards, source=lexical (the injected chunks are the
  // lexical fallback, not semantic RAG).
  const modelAnswer = "To verify as a teacher, provide your school-issued ID or employment verification through SheerID at checkout.";
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q, text: modelAnswer, ctx: SUPPORT_CTX, retrievedChunks: lex, knowledgeText: knowledge.map((k) => k.content).join("\n"),
  });
  assert.equal(r.source, "lexical", "answered from the injected LEXICAL knowledge, not support");
  assert.equal(r.handoff, false, "NO generic support handoff — the answer is in knowledge");
  assert.deepEqual(r.cards, [], "no product cards on a knowledge turn");
  assert.match(r.text, /SheerID/i);
});

check("class=policy-knowledge: lexical fallback finds nothing → support handoff still allowed", () => {
  const knowledge = [{ fileType: "faqs", content: "Returns accepted within 30 days. Free shipping over $75." }];
  const q = "Do you offer lunar delivery to the moon?";
  assert.deepEqual(lexicalRetrieveChunks(knowledge, q, { limit: 3 }), [], "no keyword overlap → no rescue");
});

check("class=policy-knowledge: genuine no-knowledge → clean handoff (no premature flag)", () => {
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: "What is your policy on lunar shipping?",
    text: "I don't have that information.", ctx: SUPPORT_CTX, retrievedChunks: [], knowledgeText: "returns, shipping, warranty",
  });
  assert.equal(r.handoff, true);
  assert.equal(r.prematureHandoff, false);
  assert.ok(r.supportCta && r.supportCta.fallbackUrl === SUPPORT_CTX.supportUrl);
});

// ── CLASS 3: orthotic guided flow (owns only TurnPlan's orthotic-eligible turns)
check("class=orthotic-flow: gate engages on browse/condition/clarification, defers elsewhere", () => {
  // Orthotic requests route to these workflows (verified against planTurn):
  for (const msg of ["i need insole for my dad", "I need orthotics for heel pain", "casual"]) {
    const wf = planTurn({ message: msg }).workflow;
    assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", wf), true, `gate may own "${msg}" (wf=${wf})`);
  }
  // But when TurnPlan owns the turn as policy/availability, the gate must defer.
  assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", planTurn({ message: "what is your return policy?" }).workflow), false);
  assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", planTurn({ message: "is the Jillian in black size 8?", namedProduct: true }).workflow), false);
});

// ── CLASS 4: commerce availability (deterministic truth owner, turnPlan-gated) ─
check("class=availability: availability turn is owned by availability-truth/variant-facts only", () => {
  const wf = planTurn({ message: "is the Jillian in black size 8?", namedProduct: true }).workflow;
  assert.equal(wf, W.AVAILABILITY);
  assert.equal(ownerAuthorizedForWorkflow("availability-truth", wf), true);
  assert.equal(ownerAuthorizedForWorkflow("variant-facts", wf), true);
  // a browse fallback / orthotic gate may NOT claim an availability turn
  assert.equal(ownerAuthorizedForWorkflow("soft-browse-refine", wf), false);
  assert.equal(ownerAuthorizedForWorkflow("orthotic-gate", wf), false);
});

// ── CLASS 5: prior-card follow-up (re-pinned prior cards ARE current evidence) ─
check("class=prior-card: prior_evidence_availability is owned by prior-evidence", () => {
  const wf = planTurn({ message: "Do they come in black?", priorCardFamilies: ["tamara", "danika", "mandy"], hasPriorCards: true }).workflow;
  assert.equal(wf, W.PRIOR_EVIDENCE_AVAILABILITY);
  assert.equal(ownerAuthorizedForWorkflow("prior-evidence", wf), true);
  assert.equal(ownerAuthorizedForWorkflow("availability-truth", wf), true);
  assert.equal(ownerAuthorizedForWorkflow("scorer", wf), false, "the scorer must never own a prior-evidence turn");
});

// ── CLASS 6: product/card alignment (final cards from current evidence; no ghost)
check("class=card-alignment: a final card not in the turn's evidence pool is flagged", () => {
  const pool = [{ handle: "a", title: "Jillian Sandal" }, { handle: "b", title: "Savannah Sandal" }];
  const finalCards = [{ handle: "a", title: "Jillian Sandal" }, { handle: "ghost", title: "Reagan Boot" }];
  const stray = cardsNotInEvidencePool({ finalCards, evidencePool: pool });
  assert.deepEqual(stray.map((c) => c.handle), ["ghost"]);
  // clean set → no stray
  assert.deepEqual(cardsNotInEvidencePool({ finalCards: [{ handle: "a" }], evidencePool: pool }), []);
});
check("class=card-alignment: answer naming a pool product that was dropped from cards fires", () => {
  // Two families were considered (pool); only Jillian is shown, but the copy
  // names Savannah — the customer can't see/click it.
  const named = answerNamesProductNotInEvidence({
    text: "I'd go with the Savannah for all-day walking.",
    cards: [{ title: "Jillian Braided Sandal - Rose", family: "jillian" }],
    knownFamilies: ["jillian", "savannah"],
  });
  assert.equal(named, "savannah");
  // when the named product IS shown, clean
  assert.equal(answerNamesProductNotInEvidence({
    text: "The Jillian is a great pick.",
    cards: [{ title: "Jillian Braided Sandal", family: "jillian" }],
    knownFamilies: ["jillian", "savannah"],
  }), null);
  // no cards shown → naming products is allowed (text-only recommendation)
  assert.equal(answerNamesProductNotInEvidence({ text: "Consider the Savannah.", cards: [], knownFamilies: ["savannah"] }), null);
});

// ── CLASS 7: support handoff (real CTA, never bracket/meta text) ──────────────
check("class=support-handoff: private turn → deterministic CTA, no bracket/meta text", () => {
  const wf = planTurn({ message: "My order says delivered but I didn't get it." }).workflow;
  assert.equal(wf, W.ACCOUNT_PRIVATE_HANDOFF);
  const r = applyAnswerSourceContract({
    workflow: wf, msg: "My order says delivered but I didn't get it.",
    text: "Our team can help. [Support Hub button is available above]", // leaky draft
    ctx: SUPPORT_CTX, retrievedChunks: undefined,
  });
  assert.equal(r.handoff, true);
  assert.ok(r.supportCta && r.supportCta.fallbackUrl === SUPPORT_CTX.supportUrl, "real CTA rendered");
  assert.doesNotMatch(r.text, /[\[\]]/, "no brackets");
  assert.doesNotMatch(r.text, /\bbutton\b/i, "no UI-meta 'button'");
  assert.doesNotMatch(r.text, /available above/i);
});
check("class=support-handoff: meta-text is stripped from an otherwise-good knowledge answer", () => {
  assert.equal(handoffMetaTextLeak("The button is available above."), true);
  const cleaned = stripHandoffMetaText("Returns are free within 30 days. [Support Hub button is available above]");
  assert.match(cleaned, /Returns are free within 30 days/);
  assert.doesNotMatch(cleaned, /[\[\]]|\bbutton\b/i);
  // a pure-meta reply strips to nothing → treated as a dead end (→ handoff)
  assert.equal(isDeadEndAnswer(stripHandoffMetaText("[Support Hub button is available above]")), true);
});

// ── RECOVERY HOPS ARE A FIRST-CLASS OWNER (Phase A item 1, 2026-07-09) ────────
// The in-loop correctives (denial-recovery / recovery-condition-search) were the
// last owners invisible to the invariant layer: unregistered, no suppress guard,
// masquerading as answerOwner="llm". Now they are "recovery" — registered,
// scoped to product-display workflows, and hard-skipped on suppress turns.
check("recovery: registered owner, scoped to product-display workflows only", () => {
  assert.equal(isRegisteredOwner("recovery"), true, "'recovery' is in the owner registry");
  assert.equal(isWorkflowAgnosticOwner("recovery"), false, "'recovery' is NOT workflow-agnostic — the invariant layer can see it");
  for (const wf of [W.BROWSE, W.CONDITION_RECOMMENDATION, W.AVAILABILITY, W.SALE_BROWSE]) {
    assert.equal(ownerAuthorizedForWorkflow("recovery", wf), true, `recovery may act on ${wf}`);
  }
  for (const wf of [W.POLICY_KNOWLEDGE, W.ACCOUNT_PRIVATE_HANDOFF, W.SIZING_HELP, W.CART_HANDOFF, W.DISPLAY_RECOVERY]) {
    assert.equal(ownerAuthorizedForWorkflow("recovery", wf), false, `recovery must NOT claim ${wf}`);
  }
});

check("recovery: hops are hard-skipped on card-suppressing turns (policy/knowledge/handoff)", () => {
  // A policy turn that WOULD have tripped denial-recovery ("we don't offer…"
  // reads as an availability denial) must leave the text untouched: the plan
  // suppresses cards, so recoveryHopAllowed is false before any other check.
  for (const msg of [
    "Do teachers get a discount?",
    "What is your return policy?",
    "I need help with an order that says delivered but I didn't get it.",
  ]) {
    const plan = planTurn({ message: msg });
    assert.equal(plan.productDisplayPolicy, "suppress", `"${msg}" suppresses cards`);
    assert.equal(recoveryHopAllowed(plan), false, `"${msg}" must never be rewritten by a recovery hop`);
  }
  // …while genuine product turns keep the live corrective.
  for (const msg of ["show me sandals for walking", "do you have the Jillian in red?"]) {
    assert.equal(recoveryHopAllowed(planTurn({ message: msg })), true, `"${msg}" keeps recovery`);
  }
  // No plan (defensive) fails OPEN — the hops are live correctives.
  assert.equal(recoveryHopAllowed(null), true);
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
