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
import { planTurn, WORKFLOWS, textPresentsProducts, workflowDisablesTools, workflowSuppressesCards, resolvedFamilyGender, isStrippedFragmentText, isOrthoticProductCard, messageExplicitlyAsksForShoes, isProductSpecQuestion, specQuestionAnsweredAsAvailability } from "../app/lib/turn-plan.server.js";

let pass = 0, fail = 0;
const fails = [];

function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// C1 — deterministic non-search turns disable tools (no stray search whose card
// the deterministic owner then overwrites; live trace 2026-06-30 display_recovery).
check("workflowDisablesTools: re-pin / selection / clarification turns are tools-off", () => {
  for (const w of ["clarification", "display_recovery", "product_focus", "cart_handoff"]) {
    assert.equal(workflowDisablesTools(w), true, `${w} must be tools-off`);
  }
  for (const w of ["browse", "availability", "condition_recommendation", "named_product_advisory", "comparison", "sale_browse"]) {
    assert.equal(workflowDisablesTools(w), false, `${w} must keep tools`);
  }
});

// C3 — a resolved named family's catalog gender overrides a stale conversation
// gender (women's Savannah must not stay "men" from a prior turn).
check("resolvedFamilyGender returns the single gender, null when mixed/empty", () => {
  assert.equal(resolvedFamilyGender([{ _gender: "women" }, { gender: "women" }]), "women");
  assert.equal(resolvedFamilyGender([{ gender: "men" }]), "men");
  assert.equal(resolvedFamilyGender([{ _gender: "women" }, { gender: "men" }]), null, "mixed → null (let stated gender stand)");
  assert.equal(resolvedFamilyGender([]), null);
  assert.equal(resolvedFamilyGender([{ title: "no gender field" }]), null);
});

// C2 — named-product advisory/styling must instruct using the shown product's
// own color/title (no color drift from earlier in the chat → no retry).
check("named_product_advisory directive forbids color drift", () => {
  const styling = planTurn({ message: "i want to wear gabby with a short white dress", namedProduct: true });
  assert.equal(styling.workflow, WORKFLOWS.NAMED_PRODUCT_ADVISORY);
  assert.ok(styling.directives.some((d) => /actual title and color|own color|never\s+(?:a\s+)?color/i.test(d)),
    `styling directive must pin the shown color; got ${JSON.stringify(styling.directives)}`);
  const advisory = planTurn({ message: "is the Gabby worth it?", namedProduct: true });
  assert.ok(advisory.directives.some((d) => /actual title and color|never a color carried over/i.test(d)),
    `advisory directive must pin the shown color; got ${JSON.stringify(advisory.directives)}`);
});

// textPresentsProducts — protects real cards from the clarification card-wipe
// and powers the cards-promised-but-none-shown recovery.
check("textPresentsProducts detects product-list language", () => {
  for (const t of ["Here are our men's supportive walking shoes.", "I found a few great options for you:", "Take a look at these:", "Here's a solid pick:", "These are my top picks."]) {
    assert.equal(textPresentsProducts(t), true, t);
  }
  for (const t of ["What size are you looking for?", "Are you shopping for men's or women's?", "I can help with that."]) {
    assert.equal(textPresentsProducts(t), false, t);
  }
});

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
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("refund question", { message: "Can I get a refund if the size is wrong?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("shipping time", { message: "How long does shipping take to California?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("exchange", { message: "Do you do exchanges for a different size?" },
  { workflow: W.POLICY_KNOWLEDGE });

// P3 — a return/refund POLICY question is policy_account, NOT a human handoff.
scenario("'What if I need to return them?' → policy_account", { message: "What if I need to return them?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'are they returnable?' → policy_account", { message: "are they returnable?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("'can I return these if they don't fit?' → policy_account", { message: "can I return these if they don't fit?" },
  { workflow: W.POLICY_KNOWLEDGE });
// A genuine return ACTION on an order is still customer_service.
scenario("'I need to return my order' → customer_service (action, not policy)", { message: "I need to return my order" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF });

// ── 1a. customer-service ISSUES (order/delivery/refund/account) → human handoff,
// no search, no cards. Routed BEFORE browse so an order problem never searches.
scenario("'order says delivered but I didn't get it' → customer_service", { message: "I need help with an order that says delivered but I didn't get it." },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("'my package never arrived' → customer_service", { message: "my package never arrived" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'I got the wrong item' → customer_service", { message: "I got the wrong item" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false });
scenario("'order arrived and shoe is damaged, need replacement' → customer_service", { message: "my order arrived and one shoe is damaged, I need a replacement" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("'where is my order?' → customer_service", { message: "Where is my order? I ordered last week." },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'I want a refund' → customer_service", { message: "I want a refund" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false });
scenario("'I was double-charged' → customer_service", { message: "I think I was double-charged for my order" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false });
// Informational policy questions still answer from knowledge (NOT customer_service).
scenario("'what's your return policy?' stays policy_account", { message: "What is your return policy?" },
  { workflow: W.POLICY_KNOWLEDGE });
scenario("'how long does shipping take?' stays policy_account", { message: "How long does shipping take to California?" },
  { workflow: W.POLICY_KNOWLEDGE });

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
scenario("sizing after shown products → sizing_help answer-now, no stale clarifier", { message: "What size should I get if I'm usually an 8.5?", hasPriorCards: true, priorCardFamilies: ["jillian", "savannah"] },
  { workflow: W.SIZING_HELP, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("'help me pick my size' → sizing_help", { message: "Help me pick my size" },
  { workflow: W.SIZING_HELP, searchRequired: false });
scenario("'how do I know my Aetrex size?' → sizing_help", { message: "How do I know my Aetrex size?" },
  { workflow: W.SIZING_HELP, searchRequired: false });
scenario("'do these run true to size?' no context → policy_knowledge (sizing guide)", { message: "Do these run true to size?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("sizing with focus product → advisory (focus that product)", { message: "What size should I get?", focusProduct: { title: "Savannah Sandal - Champagne" } },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true, productDisplayPolicy: "show_focused" });

// ── product SELECTION / FOCUS follow-up → product_focus, NO forced search ──
// Live trace 2026-06-29: "I like the Drew" after sneaker results routed to
// browse with searchRequired=true, the forced search was refused, and the turn
// shipped a search_required_not_attempted violation. A selection picks a shown
// card: anchor it, show_focused, searchRequired=false (can't trip the invariant).
scenario("'I like the Drew' (named + prior cards) → product_focus, no forced search", { message: "I like the Drew", namedProduct: true, hasPriorCards: true },
  { workflow: W.PRODUCT_FOCUS, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "show_focused" });
scenario("'I'll take this one' (focus product) → product_focus", { message: "I'll take this one", focusProduct: { title: "Drew Sneaker" }, hasPriorCards: true },
  { workflow: W.PRODUCT_FOCUS, searchRequired: false });
scenario("'the second one looks good' (prior cards) → product_focus", { message: "the second one looks good", hasPriorCards: true },
  { workflow: W.PRODUCT_FOCUS, searchRequired: false });
// No context to anchor → NOT product_focus (falls through to clarification).
scenario("'I like the Drew' with no prior cards / not named → not product_focus", { message: "I like the Drew" },
  { workflow: W.CLARIFICATION });

// ── CART / checkout intent on the focused product → cart_handoff ──────────
scenario("'add it to my cart' (focus product) → cart_handoff, no search", { message: "add it to my cart", focusProduct: { title: "Drew Sneaker" }, hasPriorCards: true },
  { workflow: W.CART_HANDOFF, searchRequired: false, productDisplayPolicy: "show_focused" });
scenario("'I want to buy it' (focus product) → cart_handoff", { message: "I want to buy it", focusProduct: { title: "Drew Sneaker" } },
  { workflow: W.CART_HANDOFF, searchRequired: false });
// Cart intent with no product in focus → not a cart handoff.
scenario("'I want to buy something' (no focus) → not cart_handoff", { message: "I want to buy some sandals" },
  { workflow: W.BROWSE });

// ── display-ownership: gender refinement + "I can't see any" recovery ─────
// Live trace 2026-06-29: "how about mens?" → clarification → 5 found men's
// cards wiped; "i can't see any" → fresh clarification with zero cards.
scenario("seed: 'supportive shoes for walking or standing' → search turn (cards)", { message: "Show me supportive shoes for walking or standing all day" },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, productDisplayPolicy: "show" });
scenario("'how about mens?' after cards → browse search (NOT clarification)", { message: "how about mens?", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show", gender: "men" });
scenario("'women's instead' after cards → browse search, gender women", { message: "women's instead", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, gender: "women" });
scenario("'for men' after cards → browse search", { message: "for men", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, gender: "men" });
scenario("'i can't see any' after a product reply → display_recovery (re-show)", { message: "i can't see any", hasPriorCards: true, priorAssistantText: "Here are our women's supportive walking shoes." },
  { workflow: W.DISPLAY_RECOVERY, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "show" });
scenario("'nothing showed up' after cards → display_recovery", { message: "nothing showed up", hasPriorCards: true },
  { workflow: W.DISPLAY_RECOVERY, searchRequired: false });
// Guards against misfire: a real category browse keeps its category route.
scenario("'how about mens?' with NO prior context → clarification (nothing to refine)", { message: "how about mens?" },
  { workflow: W.CLARIFICATION });
scenario("'show me men's sandals' (category present) → browse, not a bare refinement", { message: "show me men's sandals" },
  { workflow: W.BROWSE, gender: "men" });

// ── bare "yes" resolves against the prior assistant OFFER ─────────────────
// Live trace 2026-06-29: a lone "yes" became a generic clarification, the model
// called a tool anyway, and the resulting card was wiped.
scenario("'yes' after 'want similar alternatives?' → search (browse)", { message: "yes", priorAssistantText: "Want me to pull up some similar alternatives?", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, clarificationAllowed: false });
scenario("'yes please' after 'check sizes/colors?' → availability", { message: "yes please", priorAssistantText: "Want me to check the sizes and colors for the Drew?", focusProduct: { title: "Drew" }, hasPriorCards: true },
  { workflow: W.AVAILABILITY, searchRequired: true });
scenario("'yes' with NO actionable prior offer → clarification (no tools)", { message: "yes", priorAssistantText: "Anything else I can help with today?", hasPriorCards: true },
  { workflow: W.CLARIFICATION, searchRequired: false, clarificationAllowed: true, productDisplayPolicy: "suppress" });
scenario("'yes' with no prior assistant text → clarification", { message: "yes" },
  { workflow: W.CLARIFICATION, searchRequired: false });

// ── named-product STYLING → advisory (named family dominates, not outfit browse)
// Live trace 2026-06-29: "wear gabby with a white dress with big red flowers"
// routed to generic browse and dropped Gabby for red footwear. A named product
// + styling phrasing must route to named_product_advisory.
scenario("'wear gabby with a white dress with red flowers' → named_product_advisory", { message: "i want to wear gabby with a short white dress with big red flowers", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true, productDisplayPolicy: "show_focused" });
scenario("'does Jillian go with jeans?' → named_product_advisory", { message: "does Jillian go with jeans?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
scenario("'can I wear Savannah to a wedding?' → named_product_advisory", { message: "can I wear Savannah to a wedding?", namedProduct: true },
  { workflow: W.NAMED_PRODUCT_ADVISORY, searchRequired: true });
// Styling WITHOUT a named product stays a browse (no family to anchor).
scenario("'what shoes go with a black dress?' (no named) → browse", { message: "what shoes go with a black dress?" },
  { workflow: W.BROWSE });

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
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("'can I use a promo code on sale sandals?' → policy_account", { message: "Can I use a promo code on sale sandals?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("'can I stack discounts?' → policy_account", { message: "Can I stack discounts?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
// Size/stock FOLLOW-UP after products were shown — no named product in the
// message, but prior cards → availability, not clarification.
scenario("'what about size 9?' after products → availability (not clarification)", { message: "What about size 9?", hasPriorCards: true },
  { workflow: W.AVAILABILITY, searchRequired: true });
scenario("'do you have it in wide?' follow-up → availability", { message: "do you have it in wide?", hasPriorCards: true, focusProduct: "savannah" },
  { workflow: W.AVAILABILITY });
scenario("bare 'what about size 9?' with NO prior cards stays non-availability", { message: "What about size 9?" },
  { workflow: W.CLARIFICATION });

// ── 2a. prior-evidence availability — a new constraint applied to the SET of
// products just shown (2+ distinct families). Must NOT route to normal
// availability (single-family resolution can't handle a set → scorer leak).
scenario("'Do they come in black?' after a 3-product evidence set → prior_evidence_availability",
  { message: "Do they come in black?", priorCardFamilies: ["tamara", "danika", "mandy"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "show_availability" });
scenario("'what about size 8?' after a 3-product set → prior_evidence_availability",
  { message: "what about size 8?", priorCardFamilies: ["tamara", "danika", "mandy"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY, searchRequired: false });
scenario("'do all three come in wide?' → prior_evidence_availability",
  { message: "do all three come in wide?", priorCardFamilies: ["tamara", "danika", "mandy"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY });
scenario("'and in champagne?' after a comparison pair → prior_evidence_availability (not comparison)",
  { message: "and in champagne?", priorCardFamilies: ["jillian", "savannah"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY });
scenario("'are the ones you showed available in 9?' → prior_evidence_availability",
  { message: "are the ones you showed available in 9?", priorCardFamilies: ["jillian", "savannah"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY });
scenario("'Do either of those come in champagne or rose?' (multi-color) → prior_evidence_availability",
  { message: "Do either of those come in champagne or rose?", priorCardFamilies: ["tamara", "savannah"], hasPriorCards: true },
  { workflow: W.PRIOR_EVIDENCE_AVAILABILITY });
// A SINGLE prior family resolves fine on the normal availability path.
scenario("'do they come in black?' with ONE prior family stays normal availability",
  { message: "do they come in black?", priorCardFamilies: ["jillian"], hasPriorCards: true },
  { workflow: W.AVAILABILITY });
// Naming a NEW product this turn → normal availability, not prior-evidence.
scenario("'do you have the Jillian in black?' (named) stays availability despite prior set",
  { message: "do you have the Jillian in black?", namedProduct: true, priorCardFamilies: ["tamara", "danika"], hasPriorCards: true },
  { workflow: W.AVAILABILITY });

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
scenario("comparison follow-up on prior pair: better arch support → comparison", { message: "Which one has better arch support?", hasPriorCards: true, priorCardFamilies: ["jillian", "savannah"] },
  { workflow: W.COMPARISON, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "show" });
scenario("comparison follow-up on prior pair: more cushion for vacation → comparison", { message: "Which has more cushioning for vacation walking?", hasPriorCards: true, priorCardFamilies: ["jillian", "savannah"] },
  { workflow: W.COMPARISON, searchRequired: false, clarificationAllowed: false });
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
scenario("track my order → customer_service", { message: "track my order please" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, productDisplayPolicy: "suppress" });
scenario("return these → customer_service", { message: "I want to return these, they pinch." },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, productDisplayPolicy: "suppress" });
scenario("free shipping", { message: "Do you offer free shipping?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("reset password → customer_service", { message: "How do I reset my password?" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF });
scenario("cancel order → customer_service", { message: "Can I cancel my order?" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF });
scenario("warranty on shoes (policy beats browse)", { message: "what's your warranty on these shoes?" },
  { workflow: W.POLICY_KNOWLEDGE, productDisplayPolicy: "suppress" });
scenario("invoice", { message: "Can you resend my receipt?" },
  { workflow: W.POLICY_KNOWLEDGE });

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
scenario("where is my order number → customer_service", { message: "where is my order #1234?" },
  { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false });
scenario("returns after 30 days", { message: "do you accept returns after 30 days?" },
  { workflow: W.POLICY_KNOWLEDGE });
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

// ── 2026-06-30 PRD log fixes ─────────────────────────────────────────────────
// "verify I'm a teacher" is a discount-ELIGIBILITY (policy) question, not a
// product recommendation. It used to match the occupation "teacher" in
// USECASE_RE → condition_recommendation → 3 random wedge cards.
scenario("teacher-verification → policy_account, no product cards (tools off, suppress)", { message: "What information do I need to provide to verify I'm a teacher?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, clarificationAllowed: false, productDisplayPolicy: "suppress" });
scenario("nurse discount eligibility → policy_account", { message: "how do I verify I'm a nurse for the discount?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false });
scenario("student ID.me verification → policy_account", { message: "How do I qualify for the student discount with ID.me?" },
  { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, productDisplayPolicy: "suppress" });
// But a teacher who is SHOPPING (occupation as a real use-case) still recommends.
scenario("teacher standing all day + recommend → condition_recommendation", { message: "I'm a teacher on my feet all day, what shoes do you recommend?" },
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true });

// SUPPORT / HANDOFF / POLICY workflows show NO product cards + run tools-off so a
// stray search can't leak a card onto a verification/policy answer.
check("policy/support/sizing workflows are tools-off and card-suppressing", () => {
  for (const w of ["policy_account", "customer_service", "sizing_help"]) {
    assert.equal(workflowDisablesTools(w), true, `${w} must be tools-off`);
    assert.equal(workflowSuppressesCards(w), true, `${w} must suppress cards`);
  }
  for (const w of ["browse", "availability", "condition_recommendation", "comparison", "product_spec"]) {
    assert.equal(workflowSuppressesCards(w), false, `${w} must NOT suppress cards`);
  }
});

// ── PRODUCT SPEC / ATTRIBUTE TRUTH (Task 4) ──────────────────────────────────
// "What heel heights do your everyday wedges come in?" was answered like
// availability — "Yes — all three are available in that." (live trace 2026-06-30).
// It must route to its own product_spec workflow (search + show), NEVER availability.
scenario("heel-height spec question → product_spec (not availability)",
  { message: "What heel heights do your everyday wedges come in?", hasPriorCards: true, priorCardFamilies: ["ashley", "kaia", "anna"], primaryGender: "women" },
  { workflow: W.PRODUCT_SPEC, searchRequired: true, clarificationAllowed: false, productDisplayPolicy: "show" });
scenario("material spec question → product_spec", { message: "What material is the upper on the Jillian?", namedProduct: true },
  { workflow: W.PRODUCT_SPEC, searchRequired: true, productDisplayPolicy: "show_focused" });
scenario("waterproof spec question → product_spec", { message: "Are these waterproof?", hasPriorCards: true },
  { workflow: W.PRODUCT_SPEC, searchRequired: true });
scenario("removable-footbed spec question → product_spec", { message: "Do they have a removable footbed?", hasPriorCards: true },
  { workflow: W.PRODUCT_SPEC, searchRequired: true });
scenario("outsole/traction spec question → product_spec", { message: "What kind of outsole do these have?", hasPriorCards: true },
  { workflow: W.PRODUCT_SPEC, searchRequired: true });
// But a plain color/size availability question is STILL availability (not spec).
scenario("'what colors does the Jillian come in?' stays availability (variant data)", { message: "What colors does the Jillian come in?", namedProduct: true },
  { workflow: W.AVAILABILITY, productDisplayPolicy: "show_availability" });

check("isProductSpecQuestion: physical specs true; color/size availability false", () => {
  for (const m of ["What heel heights do your wedges come in?", "what material is it?", "are these waterproof?", "do they have a removable footbed?", "what outsole do they use?", "how tall is the heel on these?"]) {
    assert.equal(isProductSpecQuestion(m), true, `should be a spec question: "${m}"`);
  }
  for (const m of ["what colors does the Jillian come in?", "do you have it in size 9?", "is it in stock?", "what sizes do you carry?"]) {
    assert.equal(isProductSpecQuestion(m), false, `should NOT be a spec question: "${m}"`);
  }
});

check("specQuestionAnsweredAsAvailability fires on stock wording over a spec question", () => {
  const message = "What heel heights do your everyday wedges come in?";
  assert.equal(specQuestionAnsweredAsAvailability({ message, text: "Yes — all three are available in that." }), true);
  assert.equal(specQuestionAnsweredAsAvailability({ message, text: "These wedges have a 2-inch heel height." }), false);
  // Not a spec question → never fires even with availability wording.
  assert.equal(specQuestionAnsweredAsAvailability({ message: "is it in stock?", text: "Yes, it's available." }), false);
});

// ── BROAD GENDER FOLLOW-UP (Task 2) ──────────────────────────────────────────
// Chain: "Show me men's shoes for comfort and arch support." → "How about
// women's?". The bare gender pivot must re-run a GENDER-ONLY search (women),
// dropping the prior comfort/arch-support scope — handled at runtime by the
// gender-only pin, planned here as a browse with the swapped gender.
scenario("'How about women's?' after a men's turn → browse, gender women", { message: "How about women's?", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, clarificationAllowed: false, gender: "women" });
scenario("'what about mens?' after cards → browse, gender men", { message: "what about mens?", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, gender: "men" });
scenario("'show men's now' after cards → browse, gender men", { message: "show men's now", hasPriorCards: true },
  { workflow: W.BROWSE, searchRequired: true, gender: "men" });

// ── ANSWER-SOURCE ROUTING AUDIT (2026-07): knowledge vs private handoff ──────
// Every turn must use the best source first: product truth → RAG knowledge →
// account tool → handoff. KNOWLEDGE questions (policy/FAQ/discount/verification-
// requirements/brand/technology/sizing-guide) route to policy_knowledge (RAG-
// first, no cards, no search). PRIVATE outcomes (verification REJECTED, order
// issue, account access) route to account_private_handoff (support CTA).
const KNOWLEDGE_ROUTES = [
  "What information do I need to provide to verify I'm a teacher?",  // verification requirements
  "Do you offer teacher discounts?",                                 // discount offer
  "What is your return policy?",                                     // policy
  "What is Aetrex arch support technology?",                         // brand/technology
  "How do Aetrex sizes usually fit?",                                // sizing guide
];
for (const msg of KNOWLEDGE_ROUTES) {
  scenario(`answer-source: "${msg.slice(0, 40)}…" → policy_knowledge (RAG, no cards/search)`,
    { message: msg },
    { workflow: W.POLICY_KNOWLEDGE, searchRequired: false, productDisplayPolicy: "suppress" });
}
const PRIVATE_ROUTES = [
  "Why was my teacher verification rejected?",                       // private verification outcome
  "My order says delivered but I didn't get it.",                    // order issue
  "Can someone help me with my account?",                            // account access
];
for (const msg of PRIVATE_ROUTES) {
  scenario(`answer-source: "${msg.slice(0, 40)}…" → account_private_handoff (support CTA)`,
    { message: msg },
    { workflow: W.ACCOUNT_PRIVATE_HANDOFF, searchRequired: false, productDisplayPolicy: "suppress" });
}
// Knowledge + private-handoff workflows are tools-off and card-suppressing.
check("answer-source: knowledge + private workflows are tools-off + card-suppressing", () => {
  for (const w of ["policy_knowledge", "account_private_handoff"]) {
    assert.equal(workflowDisablesTools(w), true, `${w} tools-off`);
    assert.equal(workflowSuppressesCards(w), true, `${w} card-suppress`);
  }
});

// ── Orthotic-flow card purity + fragment guard helpers (PRD owner-leak fix) ───
check("isOrthoticProductCard: orthotics/insoles true; wearable footwear false", () => {
  // Orthotic by category or productType.
  assert.equal(isOrthoticProductCard({ title: "Premium Memory Foam Orthotics", category: "Orthotics" }), true);
  assert.equal(isOrthoticProductCard({ title: "L700 Speed Orthotic", productType: "Insoles" }), true);
  // Under-tagged insole caught by the TITLE.
  assert.equal(isOrthoticProductCard({ title: "Men's Speed Orthotics - Insole For Running", productType: "Footwear" }), true);
  assert.equal(isOrthoticProductCard({ title: "Unisex Thinsoles Orthotics" }), true);
  // Wearable footwear is NOT an orthotic product — even if "Orthotic" is in the name.
  assert.equal(isOrthoticProductCard({ title: "Danika Arch Support Sneaker", category: "Sneakers" }), false);
  assert.equal(isOrthoticProductCard({ title: "Maui Orthotic Flip", category: "Sandals" }), false, "a wearable sandal named 'Orthotic' is footwear");
  assert.equal(isOrthoticProductCard({ title: "Reagan Ankle Boot", category: "Boots" }), false);
});

check("messageExplicitlyAsksForShoes: only an explicit footwear REQUEST exempts", () => {
  for (const m of ["show me shoes and orthotics", "do you have supportive shoes too", "I want shoes or orthotics", "also some sneakers"]) {
    assert.equal(messageExplicitlyAsksForShoes(m), true, `should be an explicit shoes request: "${m}"`);
  }
  // The guided-flow use-case ANSWER mentions a shoe noun but is NOT a request.
  for (const m of ["I'll use them in Hoka sneakers for walking.", "Women's orthotics.", "plantar fasciitis"]) {
    assert.equal(messageExplicitlyAsksForShoes(m), false, `not a shoes request: "${m}"`);
  }
});

check("isStrippedFragmentText: dangling cleanup fragments flagged; complete answers not", () => {
  // The exact live fragment (cleanup stripped the clarifier it referred to).
  assert.equal(isStrippedFragmentText("That one detail will get you to exactly the right pick."), true);
  assert.equal(isStrippedFragmentText("Once you tell me, I'll narrow it down."), true);
  assert.equal(isStrippedFragmentText("Sure!"), true);
  // A complete sales answer is NOT a fragment.
  assert.equal(isStrippedFragmentText("Here are a few supportive, low-profile options that work great for long clinic shifts."), false);
  assert.equal(isStrippedFragmentText("The Lynco L420 is a great fit — it has firm arch support and a slim profile so it won't feel bulky in your work shoes."), false);
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
