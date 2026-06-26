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
// "What size should I GET in X" is a fit/sizing ADVICE question about a named
// product — focus it and answer from fit/variant/review data (advisory), NOT a
// stock check (availability). Stock questions use "what sizes do you HAVE".
scenario("sizing advice on a named product → named_product_advisory", { message: "what size should I get in the Savannah?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("stock question on a named product → availability", { message: "what sizes do you have in the Savannah?", namedProduct: true },
  { workflow: W.AVAILABILITY, searchRequired: true });

// ── sizing_help (Failure A): generic sizing must NOT search or show cards ──
scenario("generic 'help choosing the right size' → sizing_help, no search/cards", { message: "I need help choosing the right size" },
  { workflow: W.SIZING_HELP, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'what size should I get?' no context → sizing_help", { message: "What size should I get?" },
  { workflow: W.SIZING_HELP, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'help me pick my size' → sizing_help", { message: "Help me pick my size" },
  { workflow: W.SIZING_HELP, searchRequired: false });
scenario("'how do I know my Aetrex size?' → sizing_help", { message: "How do I know my Aetrex size?" },
  { workflow: W.SIZING_HELP, searchRequired: false });
scenario("'do these run true to size?' no context → sizing_help", { message: "Do these run true to size?" },
  { workflow: W.SIZING_HELP, searchRequired: false });
scenario("sizing with focus product → advisory (focus that product)", { message: "What size should I get?", focusProduct: { title: "Savannah Sandal - Champagne" } },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true, productDisplayPolicy: "show_focused" });

// ── sale_browse (Failure B): shopping a sale is commerce, not support ──
scenario("'show me current sales and promotions' → sale_browse", { message: "Show me current sales and promotions" },
  { workflow: W.SALE_BROWSE, searchRequired: true, productDisplayPolicy: "show" });
scenario("'what's on sale?' → sale_browse", { message: "What's on sale?" },
  { workflow: W.SALE_BROWSE, searchRequired: true });
scenario("'show me women's sneakers on sale' → sale_browse women", { message: "Show me women's sneakers on sale" },
  { workflow: W.SALE_BROWSE, searchRequired: true, gender: "women" });
scenario("'show me discounted sandals under $100' → sale_browse", { message: "Show me discounted sandals under $100" },
  { workflow: W.SALE_BROWSE, searchRequired: true });
scenario("'any deals?' → sale_browse", { message: "Any deals?" },
  { workflow: W.SALE_BROWSE, searchRequired: true });

// ── multi_recommendation + compatibility (ConstraintPlan workflows) ──
scenario("'one sandal, one sneaker, and one slipper for heel pain' → multi_recommendation", { message: "Give me one sandal, one sneaker, and one slipper for heel pain" },
  { workflow: W.MULTI_RECOMMENDATION, searchRequired: true, productDisplayPolicy: "show" });
scenario("'orthotics AND supportive sandals for flat feet' → multi_recommendation", { message: "I need orthotics AND supportive sandals for my flat feet — what should I buy?" },
  { workflow: W.MULTI_RECOMMENDATION, searchRequired: true });
scenario("'can I put orthotics inside the Jillian sandal?' → compatibility", { message: "Can I put orthotics inside the Jillian sandal?", namedProduct: true },
  { workflow: W.COMPATIBILITY, searchRequired: true, productDisplayPolicy: "show_focused" });
scenario("compatibility with no named product → suppress cards", { message: "Can I put my orthotics inside these?" },
  { workflow: W.COMPATIBILITY, productDisplayPolicy: "suppress" });
scenario("single-category condition stays condition_recommendation (not multi)", { message: "what supportive sandals do you recommend for plantar fasciitis?" },
  { workflow: W.CONDITION_RECOMMENDATION });

// ── promo MECHANICS → policy, never a product search ──
scenario("'do you have a military discount?' → policy_account, no cards", { message: "Do you have a military discount?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'can I use a promo code on sale sandals?' → policy_account", { message: "Can I use a promo code on sale sandals?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
scenario("'can I stack discounts?' → policy_account", { message: "Can I stack discounts?" },
  { workflow: W.POLICY_ACCOUNT, searchRequired: false });
// Size/stock FOLLOW-UP after products were shown — no named product in the
// message, but prior cards → availability, not clarification.
scenario("'what about size 9?' after products → availability (not clarification)", { message: "What about size 9?", hasPriorCards: true },
  { workflow: W.AVAILABILITY, searchRequired: true });
scenario("'do you have it in wide?' follow-up → availability", { message: "do you have it in wide?", hasPriorCards: true, focusProduct: "savannah" },
  { workflow: W.AVAILABILITY });
scenario("bare 'what about size 9?' with NO prior cards stays non-availability", { message: "What about size 9?" },
  { workflow: W.CLARIFICATION });

// ── 3. comparison ─────────────────────────────────────────────────
scenario("Jillian vs Savannah", { message: "Which is better for all-day walking, Jillian or Savannah?", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show" });
scenario("compare in words", { message: "compare the Reagan and the Kaylee boots", namedProduct: true },
  { workflow: W.COMPARISON, searchRequired: true });
scenario("difference between", { message: "what's the difference between the Maui and the Jess?", namedProduct: true },
  { workflow: W.COMPARISON });
scenario("comparison defaults gender to primary on condition", { message: "for plantar fasciitis, Jillian or Savannah?", namedProduct: true, attrs: { condition: "plantar_fasciitis" } },
  { workflow: W.COMPARISON, gender: "women" });
// COMPARISON OUTRANKS multi_recommendation — a "compare X and Y" of two NAMED
// families that ALSO names category words ("wedge"/"heels") must stay a
// comparison, NOT decompose into a category multi-recommendation.
scenario("'Compare Sydney and Rebecca for standing at a wedding' → comparison (not multi)", { message: "Compare Sydney and Rebecca for standing at a wedding", namedProduct: true },
  { workflow: W.COMPARISON });
scenario("'compare the Sydney wedge and the Rebecca heels' → comparison (category words don't trigger multi)", { message: "compare the Sydney wedge and the Rebecca heels for standing all day at that wedding", namedProduct: true },
  { workflow: W.COMPARISON });
scenario("'Which is better, Jillian or Savannah?' → comparison (not multi)", { message: "Which is better, Jillian or Savannah?", namedProduct: true },
  { workflow: W.COMPARISON });
// But an unnamed multi-category ask is still a multi_recommendation.
scenario("'one sandal, one sneaker, one slipper for heel pain' stays multi (no named families)", { message: "Give me one sandal, one sneaker, and one slipper for heel pain" },
  { workflow: W.MULTI_RECOMMENDATION });

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
// Browse gender default — primary line (women) when no gender stated; never
// inferred from a logged-in account. Stated gender still wins.
scenario("cute black sandals under $100 → women default", { message: "Show me cute black sandals under $100" },
  { workflow: W.BROWSE, gender: "women" });
scenario("black sandals for my husband → men", { message: "Show me black sandals for my husband" },
  { workflow: W.BROWSE, gender: "men" });
scenario("black sandals for men → men", { message: "Show me black sandals for men" },
  { workflow: W.BROWSE, gender: "men" });
scenario("black sandals for women → women", { message: "Show me black sandals for women" },
  { workflow: W.BROWSE, gender: "women" });

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
