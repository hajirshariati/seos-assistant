// Conversation-class contract suite.
//
// We stopped screenshot-by-screenshot patching. This suite encodes the ENGINE
// CONTRACT as conversation CLASSES, each with many realistic customer phrasings,
// so a regression in one class is caught regardless of the exact wording that
// surfaced it.
//
// ── The rule for new bug reports ─────────────────────────────────────────
// Every live bug MUST be mapped to one of the classes below. Add the failing
// phrasing(s) to that class. If a bug genuinely doesn't fit any class, add a
// NEW class with 8+ phrasings — never a single one-off regression for one
// phrase. Fix the underlying class behavior, not the phrase.
//
// ── What this layer asserts (deterministic / offline) ────────────────────
// The TurnPlan contract — the backbone every other layer reads:
//   - workflow            (which owner handles the turn)
//   - searchRequired      (must a product search run?)
//   - cardsExpected       (does the plan force a product display? proxy for
//                          "finalCards > 0 expected" vs "no cards")
//   - clarificationAllowed (may the turn ask a question?)
// Runtime assertions that need the live engine — searchATTEMPTED, the exact
// finalCards count, text/card alignment, "no clarification card-wipe after a
// successful search", "no internal/tool/process language", and the rendered
// support-handoff CTA — run on top of these in the PRD/live harness
// (eval-live-core-flows, eval-scenarios, eval-chat-transcripts) and in the
// targeted unit suites (eval-support-handoff, eval-orthotic-gate,
// eval-response-contract). This file locks the deterministic contract those
// build on.
//
// Run: node scripts/eval-conversation-classes.mjs

import assert from "node:assert/strict";
import { planTurn, planForcesProductDisplay } from "../app/lib/turn-plan.server.js";
import { detectSupportHandoffNeed } from "../app/lib/support-handoff.js";

let pass = 0, fail = 0;
const fails = [];
const classCounts = {};

// A case: { msg, in?, wf, search, cards, clar? }
//   wf     — expected workflow, or an array of acceptable workflows
//   search — expected searchRequired
//   cards  — expected planForcesProductDisplay (cards shown vs not)
//   clar   — (optional) expected clarificationAllowed
function runClass(className, cases) {
  classCounts[className] = cases.length;
  console.log(`\n${className} (${cases.length})`);
  for (const c of cases) {
    const name = `[${className}] "${c.msg}"`;
    try {
      const plan = planTurn({ message: c.msg, ...(c.in || {}) });
      const wfOk = Array.isArray(c.wf) ? c.wf.includes(plan.workflow) : plan.workflow === c.wf;
      assert.ok(wfOk, `workflow: expected ${JSON.stringify(c.wf)}, got "${plan.workflow}"`);
      assert.equal(plan.searchRequired, c.search, `searchRequired: expected ${c.search}, got ${plan.searchRequired}`);
      assert.equal(planForcesProductDisplay(plan), c.cards, `cardsExpected: expected ${c.cards}, got ${planForcesProductDisplay(plan)}`);
      if (c.clar !== undefined) assert.equal(plan.clarificationAllowed, c.clar, `clarificationAllowed: expected ${c.clar}, got ${plan.clarificationAllowed}`);
      pass++; console.log(`  ✓ ${name}`);
    } catch (err) {
      fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`);
    }
  }
}

const PRIOR = { hasPriorCards: true };
const PRIOR2 = { hasPriorCards: true, priorCardFamilies: ["jillian", "savannah"] };

// 1. PRODUCT DISCOVERY — open-ended shopping; show products.
runClass("1. product discovery", [
  { msg: "Show me supportive sandals", wf: "browse", search: true, cards: true },
  { msg: "I'm looking for comfortable walking shoes", wf: ["browse", "condition_recommendation"], search: true, cards: true },
  { msg: "do you have any wedges?", wf: "browse", search: true, cards: true },
  { msg: "I need new sneakers", wf: ["browse", "condition_recommendation"], search: true, cards: true },
  { msg: "show me women's loafers", wf: "browse", search: true, cards: true },
  { msg: "what slippers do you carry", wf: "browse", search: true, cards: true },
  { msg: "browse boots under $150", wf: "browse", search: true, cards: true },
  { msg: "looking for something for the beach", wf: ["browse", "condition_recommendation"], search: true, cards: true },
  { msg: "what's on sale", wf: "sale_browse", search: true, cards: true },
  { msg: "show me your bestsellers", wf: ["browse", "sale_browse"], search: true, cards: true },
]);

// 2. CONDITION / SUITABILITY RECOMMENDATION — medical/use-case driven.
runClass("2. condition/suitability recommendation", [
  { msg: "I have plantar fasciitis, what do you recommend?", wf: "condition_recommendation", search: true, cards: true },
  { msg: "shoes for flat feet", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "I'm on my feet all day at work", wf: "condition_recommendation", search: true, cards: true },
  { msg: "something for bunions", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "best shoes for standing all day", wf: "condition_recommendation", search: true, cards: true },
  { msg: "I need arch support for walking a lot", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "what should I get for heel pain", wf: "condition_recommendation", search: true, cards: true },
  { msg: "comfortable shoes for a nurse", wf: "condition_recommendation", search: true, cards: true },
  { msg: "I have overpronation and need support", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "shoes for travel and lots of walking", wf: "condition_recommendation", search: true, cards: true },
]);

// 3. COMPARISON — two named products / which-is-better.
runClass("3. comparison", [
  { msg: "Jillian or Savannah for walking?", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "which is better, the Reagan or the Kaylee?", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "compare the Danika and the Chase", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "Jillian vs Lina", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "is the Savannah or the Gabby more supportive?", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "what's the difference between the Reagan and Kaylee boots", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "should I get the Jillian or the Savannah", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
  { msg: "Danika or something else?", in: { namedProduct: true }, wf: "comparison", search: true, cards: true },
]);

// 4. AVAILABILITY / VARIANT — sizes/colors/stock of a named or focused product.
runClass("4. availability/variant", [
  { msg: "do you have the Jillian in black?", in: { namedProduct: true }, wf: "availability", search: true, cards: true },
  { msg: "what colors does the Savannah come in?", in: { namedProduct: true }, wf: "availability", search: true, cards: true },
  { msg: "is the Danika in stock in size 8?", in: { namedProduct: true }, wf: "availability", search: true, cards: true },
  { msg: "does the Gabby come in wide?", in: { namedProduct: true }, wf: "availability", search: true, cards: true },
  { msg: "what sizes do you have in the Reagan?", in: { namedProduct: true }, wf: "availability", search: true, cards: true },
  { msg: "is this available in a 7.5?", in: { focusProduct: { title: "Jillian Sandal" }, hasPriorCards: true }, wf: "availability", search: true, cards: true },
  { msg: "what about size 9?", in: { focusProduct: { title: "Jillian Sandal" }, hasPriorCards: true }, wf: "availability", search: true, cards: true },
  { msg: "do they come in black?", in: PRIOR2, wf: "prior_evidence_availability", search: false, cards: true },
  { msg: "do all three come in wide?", in: PRIOR2, wf: "prior_evidence_availability", search: false, cards: true },
]);

// 5. FOLLOW-UP REFINEMENT — refine the prior shopping turn; never a clarification.
runClass("5. follow-up refinement", [
  { msg: "how about mens?", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "men's?", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "for men", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "women's instead", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "what about for my husband", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "anything cheaper?", in: PRIOR, wf: ["browse", "sale_browse"], search: true, cards: true },
  { msg: "show me more like these", in: PRIOR, wf: "browse", search: true, cards: true },
  { msg: "i can't see any", in: { ...PRIOR, priorAssistantText: "Here are our women's walking shoes." }, wf: "display_recovery", search: false, cards: true },
  { msg: "nothing showed up", in: PRIOR, wf: "display_recovery", search: false, cards: true },
  { msg: "yes", in: { ...PRIOR, priorAssistantText: "Want me to pull up similar alternatives?" }, wf: "browse", search: true, cards: true },
]);

// 6. FOCUSED PRODUCT FOLLOW-UP — selection / cart / advisory on one product.
runClass("6. focused product follow-up", [
  { msg: "I like the Drew", in: { namedProduct: true, ...PRIOR }, wf: "product_focus", search: false, cards: true },
  { msg: "I'll take this one", in: { focusProduct: { title: "Drew" }, ...PRIOR }, wf: "product_focus", search: false, cards: true },
  { msg: "the second one looks good", in: PRIOR, wf: "product_focus", search: false, cards: true },
  { msg: "let's go with the Savannah", in: { namedProduct: true, ...PRIOR }, wf: "product_focus", search: false, cards: true },
  { msg: "add it to my cart", in: { focusProduct: { title: "Drew" }, ...PRIOR }, wf: "cart_handoff", search: false, cards: true },
  { msg: "I want to buy it", in: { focusProduct: { title: "Drew" } }, wf: "cart_handoff", search: false, cards: true },
  { msg: "is the Gabby any good?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "is the Savannah worth it?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "what size should I get in the Jillian?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
]);

// 7. STYLING / OUTFIT CONTEXT — outfit colors are not product filters.
runClass("7. styling/outfit context", [
  { msg: "i want to wear gabby with a short white dress with big red flowers", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "does the Jillian go with jeans?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "can I wear the Savannah to a wedding?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "would the black Danika work with a navy suit?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "what shoes go with a black dress?", wf: "browse", search: true, cards: true },
  { msg: "something to match my blue jeans", wf: ["browse", "condition_recommendation"], search: true, cards: true },
  { msg: "will the Gabby pair with white pants?", in: { namedProduct: true }, wf: "named_product_advisory", search: true, cards: true },
  { msg: "I need shoes for a red dress", wf: "browse", search: true, cards: true },
]);

// 8. ORTHOTIC GUIDANCE — insole/condition/compat asks (plan level; the seed gate
// handles the interactive chip flow separately).
runClass("8. orthotic guidance", [
  { msg: "I need orthotics for plantar fasciitis", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "do you have insoles for flat feet?", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "can I put orthotics inside the Jillian?", in: { namedProduct: true }, wf: "compatibility", search: true, cards: true },
  { msg: "will an insole fit in the Savannah sandal?", in: { namedProduct: true }, wf: "compatibility", search: true, cards: true },
  { msg: "show me supportive shoes or orthotics for foot pain", wf: "multi_recommendation", search: true, cards: true },
  { msg: "I want a sandal and an orthotic for heel pain", wf: "multi_recommendation", search: true, cards: true },
  { msg: "what orthotic is best for high arches?", wf: ["condition_recommendation", "browse"], search: true, cards: true },
  { msg: "insoles for work boots", wf: ["condition_recommendation", "browse"], search: true, cards: true },
]);

// 9. POLICY / ORDER / SUPPORT — no product search, no cards.
runClass("9. policy/order/support", [
  { msg: "what is your return policy?", wf: "policy_account", search: false, cards: false },
  { msg: "can I get a refund?", wf: "policy_account", search: false, cards: false },
  { msg: "how long does shipping take?", wf: "policy_account", search: false, cards: false },
  { msg: "do you do exchanges?", wf: "policy_account", search: false, cards: false },
  { msg: "can I use two promo codes?", wf: "policy_account", search: false, cards: false },
  { msg: "I need help with an order that says delivered but I didn't get it", wf: "customer_service", search: false, cards: false },
  { msg: "my package never arrived", wf: "customer_service", search: false, cards: false },
  { msg: "I got the wrong item", wf: "customer_service", search: false, cards: false },
  { msg: "where is my order?", wf: ["customer_service", "policy_account"], search: false, cards: false },
]);

// 10. CORRECTION / FRUSTRATION — not a product turn; recover, don't search.
runClass("10. correction/frustration", [
  { msg: "that's not what I asked", wf: "clarification", search: false, cards: false },
  { msg: "you're not listening", wf: "clarification", search: false, cards: false },
  { msg: "this is so annoying", wf: "clarification", search: false, cards: false },
  { msg: "I already told you that", wf: "clarification", search: false, cards: false },
  { msg: "are you even working?", wf: "clarification", search: false, cards: false },
  { msg: "no that's wrong", wf: "clarification", search: false, cards: false },
  { msg: "stop repeating yourself", wf: "clarification", search: false, cards: false },
  { msg: "ugh this isn't helping", wf: "clarification", search: false, cards: false },
]);

// 11. NO-DATA / HANDOFF — an explicit human request must hand off to support.
// The handoff is decided at RUNTIME by detectSupportHandoffNeed (it overrides
// whatever workflow the plan picked and drops cards), so THIS class asserts the
// handoff contract directly rather than the plan workflow.
runClass.handoff = true;
console.log(`\n11. no-data/handoff (8)`);
classCounts["11. no-data/handoff"] = 8;
for (const msg of [
  "can I talk to a human?",
  "connect me to customer service",
  "I want to speak to a representative",
  "get me a real person",
  "I need to reach support",
  "live chat with an agent",
  "I want to contact customer support",
  "put me through to an agent",
]) {
  const name = `[11. no-data/handoff] "${msg}"`;
  try {
    const h = detectSupportHandoffNeed({ ctx: { latestUserMessage: msg, turnPlan: { workflow: "browse" } }, pool: [] });
    assert.equal(h.mode, "hard", `expected hard handoff, got ${JSON.stringify(h)}`);
    assert.equal(h.reason, "explicit_human_request", `expected explicit_human_request, got ${h.reason}`);
    pass++; console.log(`  ✓ ${name}`);
  } catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}

// 12. OFF-TOPIC / NONSENSE — no product intent; ask one question, no cards.
runClass("12. off-topic/nonsense", [
  { msg: "asdf qwerty", wf: "clarification", search: false, cards: false },
  { msg: "what's the weather today?", wf: "clarification", search: false, cards: false },
  { msg: "tell me a joke", wf: "clarification", search: false, cards: false },
  { msg: "hello", wf: "clarification", search: false, cards: false },
  { msg: "🙂🙂🙂", wf: "clarification", search: false, cards: false },
  { msg: "who is the president?", wf: "clarification", search: false, cards: false },
  { msg: "123456", wf: "clarification", search: false, cards: false },
  { msg: "are you a robot?", wf: "clarification", search: false, cards: false },
]);

// Every class must carry enough phrasings to be a CONTRACT, not a one-off.
console.log("\nclass coverage");
for (const [cls, n] of Object.entries(classCounts)) {
  try { assert.ok(n >= 8, `class "${cls}" has only ${n} phrasings (need >= 8)`); pass++; console.log(`  ✓ ${cls}: ${n} phrasings`); }
  catch (err) { fail++; fails.push({ name: `coverage ${cls}`, err }); console.log(`  ✗ ${cls}: ${n} (< 8)`); }
}
assert.ok(Object.keys(classCounts).length === 12, "expected 12 conversation classes");

console.log("");
if (fail === 0) {
  console.log(`✅  ${pass} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${pass} passed, ${fail} failed\n`);
  for (const f of fails) console.log(`  ${f.name}\n    ${f.err.message}`);
  process.exit(1);
}
