// TurnPlan eval — real customer scenarios from our failure logs.
//
// Each scenario asserts the PLAN the central planner produces: the workflow,
// whether search is required, whether a clarifying question is allowed, the
// product-display policy, and the resolved gender. This is the deterministic
// backbone of the turn-quality harness; live tool-call / card-count / answer-
// quality assertions run against PRD on top of these.
//
// Run: node scripts/eval-turn-plan.mjs

import assert from "node:assert/strict";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";

let pass = 0, fail = 0;
const fails = [];

// A scenario: { name, in, expect } where `expect` is a subset of the plan.
function scenario(name, input, expect) {
  try {
    const plan = planTurn(input);
    for (const [k, v] of Object.entries(expect)) {
      assert.deepEqual(plan[k], v, `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(plan[k])}`);
    }
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    fails.push({ name, err });
    fail++;
  }
}

const W = WORKFLOWS;

// ── 1. policy / order / account ───────────────────────────────────
scenario("return policy", { message: "What is your return policy if they don't work for my feet?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("order status", { message: "Where is my order? I ordered last week." },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("refund question", { message: "Can I get a refund if the size is wrong?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
scenario("shipping time", { message: "How long does shipping take to California?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
scenario("exchange", { message: "Do you do exchanges for a different size?" },
  { workflow: W.POLICY_ACCOUNT });

// ── 2. availability (size / color / stock) ────────────────────────
scenario("Jillian black size 8 (named)", { message: "Do you have the Jillian in black size 8?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show_availability" });
scenario("what colors does the Jillian come in", { message: "What colors does the Jillian come in?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true, productDisplayPolicy: "show_availability" });
scenario("is it in stock (focus product)", { message: "Is it in stock in a size 7?", focusProduct: "jillian-black" },
  { workflow: W.AVAILABILITY, productDisplayPolicy: "show_availability" });
scenario("availability without product context falls to browse (no product to look up)", { message: "what sizes do you carry?" },
  { workflow: W.BROWSE });
scenario("size question on a named product", { message: "what size should I get in the Savannah?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true });

// ── 3. comparison ─────────────────────────────────────────────────
scenario("Jillian vs Savannah", { message: "Which is better for all-day walking, Jillian or Savannah?", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show" });
scenario("compare in words", { message: "compare the Reagan and the Kaylee boots", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true });
scenario("difference between", { message: "what's the difference between the Maui and the Jess?", namedProduct: true },
  { workflow: W.COMPARISON });
scenario("comparison defaults gender to primary on condition", { message: "for plantar fasciitis, Jillian or Savannah?", namedProduct: true, attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.COMPARISON, gender: "women" });

// ── 4. named-product advisory / value ─────────────────────────────
scenario("Jillian worth it for PF", { message: "Is the Aetrex Jillian actually worth $100+ for plantar fasciitis?", namedProduct: true, attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show_focused", gender: "women" });
scenario("will the Jillian hold up", { message: "will the Jillian hold up for active walking or is it a casual stroll sandal?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("is the Jillian good for plantar fasciitis", { message: "Are the Jillian sandals good for plantar fasciitis?", namedProduct: true, attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("named advisory defaults gender", { message: "is the Danika worth it?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, gender: "women" });

// ── 5. condition / use-case recommendation (the gender-gate fix) ──
scenario("PF sandals for walking vacation — no gender ask", { message: "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?", attrs: { condition: "plantar_fasciitis", useCase: "walking" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, clarificationAllowed: false, gender: "women", productDisplayPolicy: "show" });
scenario("standing all day", { message: "I'm on my feet standing all day, what do you recommend?", attrs: { useCase: "standing" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, clarificationAllowed: false });
scenario("bunions recommendation", { message: "I have bunions, what shoes should I get?", attrs: { condition: "bunions" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, clarificationAllowed: false });
scenario("Disney 10 miles PF", { message: "I need shoes for Disney, 10 miles a day, plantar fasciitis.", attrs: { condition: "plantar_fasciitis", useCase: "walking" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true });
scenario("condition recommendation resolves husband to men", { message: "my husband has plantar fasciitis, what do you recommend?", attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "men" }); // "husband" → men
scenario("vacation walking sandals", { message: "sandals for a hot-weather walking vacation", attrs: { useCase: "vacation" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, clarificationAllowed: false, gender: "women" });

// ── 6. plain browse / search ──────────────────────────────────────
scenario("show me women's sandals under 120", { message: "Show me women's sandals under $120 for arch support." },
  { workflow: W.BROWSE, searchRequired: true });
scenario("show me black sandals", { message: "show me black sandals" },
  { workflow: W.BROWSE, searchRequired: true });
scenario("bare generic shoes may ask one narrowing question", { message: "do you have shoes?" },
  { workflow: W.BROWSE, clarificationAllowed: true });
scenario("specific browse does not ask gender", { message: "show me women's sneakers" },
  { workflow: W.BROWSE, clarificationAllowed: false });
scenario("looking for clogs", { message: "I'm looking for some clogs" },
  { workflow: W.BROWSE, searchRequired: true });

// ── 7. clarification / no-data ────────────────────────────────────
scenario("vague hello", { message: "hi there" },
  { workflow: W.CLARIFICATION, searchRequired: false, clarificationAllowed: true, productDisplayPolicy: "suppress" });
scenario("ambiguous one word", { message: "help" },
  { workflow: W.CLARIFICATION });

// ── Gender-default discipline ─────────────────────────────────────
scenario("dad resolves to men (recommendation)", { message: "walking shoes for my dad with foot pain", attrs: { condition: "foot_pain", useCase: "walking" } },
  { gender: "men" });
scenario("explicit women keeps women", { message: "women's sandals for plantar fasciitis", attrs: { gender: "women", condition: "plantar_fasciitis" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "women" });

// ══════════════════════════════════════════════════════════════════
// Expanded coverage — more real-customer phrasings per workflow so the
// classifier is pinned against drift. (Target ≥75 total scenarios.)
// ══════════════════════════════════════════════════════════════════

// ── 1b. policy / order / account variants ─────────────────────────
scenario("track my order", { message: "track my order please" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("return these", { message: "I want to return these, they pinch." },
  { workflow: W.POLICY_ACCOUNT, productDisplayPolicy: "suppress" });
scenario("free shipping", { message: "Do you offer free shipping?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
scenario("reset password", { message: "How do I reset my password?" },
  { workflow: W.POLICY_ACCOUNT });
scenario("cancel order", { message: "Can I cancel my order?" },
  { workflow: W.POLICY_ACCOUNT });
scenario("warranty on shoes (policy beats browse)", { message: "what's your warranty on these shoes?" },
  { workflow: W.POLICY_ACCOUNT, productDisplayPolicy: "suppress" });
scenario("invoice", { message: "Can you resend my receipt?" },
  { workflow: W.POLICY_ACCOUNT });

// ── 2b. availability variants ─────────────────────────────────────
scenario("Lina available size 9", { message: "Is the Lina available in size 9?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true, productDisplayPolicy: "show_availability" });
scenario("Reagan come in brown", { message: "does the Reagan come in brown?", namedProduct: true },
  { workflow: W.AVAILABILITY, productDisplayPolicy: "show_availability" });
scenario("Danika sold out", { message: "is the Danika sold out?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true });
scenario("focus product wide width", { message: "do you have it in a wide width?", focusProduct: "jillian-black" },
  { workflow: W.AVAILABILITY, productDisplayPolicy: "show_availability" });
scenario("availability never suppresses card", { message: "what colors does the Maui come in?", namedProduct: true },
  { workflow: W.AVAILABILITY, productDisplayPolicy: "show_availability", clarificationAllowed: false });

// ── 3b. comparison variants ───────────────────────────────────────
scenario("which one should I get Maui or Lina", { message: "which one should I get, the Maui or the Lina?", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true });
scenario("Jillian versus Savannah for travel", { message: "Jillian versus Savannah for travel?", namedProduct: true },
  { workflow: W.COMPARISON });
scenario("better for bunions defaults women", { message: "is the Jillian or the Danika better for bunions?", namedProduct: true, attrs: { condition: "bunions" } },
  { workflow: W.COMPARISON, gender: "women" });

// ── 4b. named-product advisory variants ───────────────────────────
scenario("should I buy the Reagan", { message: "should I buy the Reagan boots?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("Maui durable for hiking", { message: "are the Maui sandals durable enough for hiking?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("Lina more of a dress shoe", { message: "is the Lina more of a dress shoe?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY });
scenario("is the Jillian comfortable", { message: "Is the Jillian comfortable?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY });

// ── 5b. condition / use-case recommendation variants ──────────────
scenario("recommend for heel pain", { message: "what do you recommend for heel pain?", attrs: { condition: "heel_pain" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, clarificationAllowed: false, gender: "women" });
scenario("neuroma need shoes", { message: "I need shoes for my neuroma", attrs: { condition: "neuroma" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true });
scenario("nurses 12 hour shifts", { message: "best shoes for nurses on 12 hour shifts", attrs: { useCase: "standing" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, gender: "women" });
scenario("overpronate what to wear", { message: "I overpronate, what should I wear?" },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true });
scenario("teacher on her feet all day", { message: "shoes for a teacher on her feet all day" },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true });

// ── 6b. plain browse variants ─────────────────────────────────────
scenario("show me men's sneakers", { message: "show me men's sneakers" },
  { workflow: W.BROWSE, searchRequired: true, clarificationAllowed: false });
scenario("what sandals do you have", { message: "what sandals do you have?" },
  { workflow: W.BROWSE, searchRequired: true });
scenario("browse collection", { message: "browse your collection" },
  { workflow: W.BROWSE });
scenario("want to see boots", { message: "I want to see some boots" },
  { workflow: W.BROWSE });
scenario("do you carry wide widths", { message: "do you carry wide widths?" },
  { workflow: W.BROWSE, searchRequired: true });
scenario("looking for slip-on sneakers", { message: "looking for slip-on sneakers" },
  { workflow: W.BROWSE });

// ── 7b. clarification variants ────────────────────────────────────
scenario("plain hello", { message: "hello" },
  { workflow: W.CLARIFICATION, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("thanks", { message: "thanks!" },
  { workflow: W.CLARIFICATION });
scenario("can you help (no me find)", { message: "can you help?" },
  { workflow: W.CLARIFICATION, clarificationAllowed: true });

// ── Gender-default discipline (more) ──────────────────────────────
scenario("son with flat feet resolves to men", { message: "my son has flat feet, what do you recommend?", attrs: { condition: "flat_feet" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "men" });
scenario("explicit men attrs keeps men", { message: "sandals for plantar fasciitis", attrs: { gender: "men", condition: "plantar_fasciitis" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "men" });
scenario("named advisory with men attrs keeps men", { message: "is the Lloyd worth it?", namedProduct: true, attrs: { gender: "men" } },
  { workflow: W.NAMED_PRODUCT_ADVISORY, gender: "men" });
scenario("wife resolves to women (recommendation)", { message: "shoes for my wife with bunions", attrs: { condition: "bunions" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "women" });
scenario("her resolves to women (browse)", { message: "show me sandals for her" },
  { workflow: W.BROWSE, gender: "women" });
scenario("his resolves to men (availability)", { message: "is the Lloyd in his size 11 in stock?", namedProduct: true },
  { workflow: W.AVAILABILITY, gender: "men" });
scenario("husband+wife conflict stays ambiguous", { message: "sandals for my husband and my wife for plantar fasciitis", attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.CONDITION_RECOMMENDATION, gender: "women" }); // conflict → null stated → defaults to primary line

// ── Extra real-world phrasings to clear the ≥75 bar ───────────────
scenario("where is my order number", { message: "where is my order #1234?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
scenario("returns after 30 days", { message: "do you accept returns after 30 days?" },
  { workflow: W.POLICY_ACCOUNT });
scenario("Savannah in stock", { message: "is the Savannah in stock?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true, productDisplayPolicy: "show_availability" });
scenario("compare vs explicit", { message: "compare Jillian vs Lina", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true });
scenario("Danika worth the price", { message: "are the Danika sneakers worth the price?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("bunion need wide shoes", { message: "I have a bunion and need wide shoes", attrs: { condition: "bunions" } },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, gender: "women" });
scenario("show me clogs under 100", { message: "show me clogs under $100" },
  { workflow: W.BROWSE, searchRequired: true });
scenario("bare ok is clarification", { message: "ok" },
  { workflow: W.CLARIFICATION });

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
