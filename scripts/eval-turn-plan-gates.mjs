// TurnPlan integration eval — the EXECUTABLE gates, not just the planner.
//
// eval-turn-plan.mjs asserts the plan a turn produces. This suite asserts
// what the deterministic gates DO with that plan + a simulated model reply:
//   - searchRequired forces a product search (planRequiresSearch)
//   - product-display policy overrides card suppression (planForcesProductDisplay)
//   - a disallowed generic clarifier is repaired when products exist, or
//     flagged when none (clarifierGateDecision)
//   - the repair text actually answers/*frames* rather than re-asking
//
// These run with no network — they exercise the same pure functions the
// chat route calls, so the harness and production share one code path.
// Live PRD assertions (real tool calls, real card counts) layer on top.
//
// Run: node scripts/eval-turn-plan-gates.mjs

import assert from "node:assert/strict";
import {
  planTurn,
  WORKFLOWS as W,
  planRequiresSearch,
  planForcesProductDisplay,
  clarifierGateDecision,
  isGenericClarifierReply,
  buildPlanClarifierRepair,
} from "../app/lib/turn-plan.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// Stock stall replies the model must NOT ship when the plan says act-first.
const GENDER_STALL = "Sure! Are you shopping for men's or women's?";
const VAGUE_STALL = "I can help with that — could you tell me a little more about what you're after?";
const STYLE_STALL = "Happy to help! What style, color, or budget did you have in mind?";
// A real answer that merely ends with a soft refinement offer must survive.
const REAL_ANSWER =
  "The Jillian is a great pick for plantar fasciitis — its built-in arch support and cushioned footbed take pressure off the heel. " +
  "I started with our women's line here; want me to pull men's instead?";

// ── 1. isGenericClarifierReply: stalls flagged, real answers spared ──
check("gender stall is a generic clarifier", () => assert.equal(isGenericClarifierReply(GENDER_STALL), true));
check("vague 'tell me more' is a clarifier", () => assert.equal(isGenericClarifierReply(VAGUE_STALL), true));
check("style/color/budget stall is a clarifier", () => assert.equal(isGenericClarifierReply(STYLE_STALL), true));
check("real product answer is NOT a clarifier (too long / substantive)", () => assert.equal(isGenericClarifierReply(REAL_ANSWER), false));
check("statement without a question is not a clarifier", () => assert.equal(isGenericClarifierReply("Here are some women's sandals."), false));

// ── 2. planRequiresSearch / planForcesProductDisplay across workflows ──
const pfPlan = planTurn({ message: "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?", attrs: { condition: "plantar_fasciitis", useCase: "walking" } });
check("PF recommendation requires search", () => assert.equal(planRequiresSearch(pfPlan), true));
check("PF recommendation forces product display", () => assert.equal(planForcesProductDisplay(pfPlan), true));
check("PF recommendation defaults gender to women", () => assert.equal(pfPlan.gender, "women"));

const availPlan = planTurn({ message: "Do you have the Jillian in black size 8?", namedProduct: true });
check("availability requires search", () => assert.equal(planRequiresSearch(availPlan), true));
check("availability forces product display (never suppress card)", () => assert.equal(planForcesProductDisplay(availPlan), true));
check("availability display policy is show_availability", () => assert.equal(availPlan.productDisplayPolicy, "show_availability"));

const policyPlan = planTurn({ message: "What is your return policy?" });
check("policy does NOT require search", () => assert.equal(planRequiresSearch(policyPlan), false));
check("policy does NOT force product display (suppress)", () => assert.equal(planForcesProductDisplay(policyPlan), false));

// ── 3. clarifierGateDecision — the known gender-gate failure ──────────
check("PF + gender stall + products → repair", () => {
  const d = clarifierGateDecision(pfPlan, GENDER_STALL, true);
  assert.equal(d.action, "repair");
});
check("PF + gender stall + NO products → block_no_products", () => {
  const d = clarifierGateDecision(pfPlan, GENDER_STALL, false);
  assert.equal(d.action, "block_no_products");
});
check("PF + real substantive answer → allow", () => {
  const d = clarifierGateDecision(pfPlan, REAL_ANSWER, true);
  assert.equal(d.action, "allow");
});
check("availability + style stall + products → repair", () => {
  const d = clarifierGateDecision(availPlan, STYLE_STALL, true);
  assert.equal(d.action, "repair");
});

// A workflow that permits clarification must never be repaired.
const clarifyPlan = planTurn({ message: "do you have shoes?" });
check("bare 'shoes' allows clarification (gate stays out of the way)", () => {
  assert.equal(clarifyPlan.clarificationAllowed, true);
  const d = clarifierGateDecision(clarifyPlan, GENDER_STALL, false);
  assert.equal(d.action, "allow");
});
const vaguePlan = planTurn({ message: "hi there" });
check("vague hello allows clarification", () => {
  const d = clarifierGateDecision(vaguePlan, VAGUE_STALL, false);
  assert.equal(d.action, "allow");
});

// ── 4. repair text actually frames products, doesn't re-ask gender ────
check("women-default repair frames women's line + offers men's, no '?'-only stall", () => {
  const r = buildPlanClarifierRepair(pfPlan);
  assert.match(r, /women's/i);
  assert.match(r, /men's/i);
  assert.equal(isGenericClarifierReply(r), false, "repair text must not itself be a generic clarifier");
});
check("men-default repair frames men's line + offers women's", () => {
  const menPlan = planTurn({ message: "my husband has plantar fasciitis, what do you recommend?", attrs: { condition: "plantar_fasciitis" } });
  assert.equal(menPlan.gender, "men");
  const r = buildPlanClarifierRepair(menPlan);
  assert.match(r, /men's/i);
});
check("genderless repair is a neutral framing, not a clarifier", () => {
  const r = buildPlanClarifierRepair({ productDisplayPolicy: "show" });
  assert.equal(isGenericClarifierReply(r), false);
});

// ── 5. end-to-end known failures (message → plan → gate verdicts) ─────
function endToEnd(name, input, reply, hasProducts, expect) {
  check(name, () => {
    const plan = planTurn(input);
    const got = {
      workflow: plan.workflow,
      searchRequired: planRequiresSearch(plan),
      forcesDisplay: planForcesProductDisplay(plan),
      clarifier: clarifierGateDecision(plan, reply, hasProducts).action,
    };
    for (const [k, v] of Object.entries(expect)) {
      assert.deepEqual(got[k], v, `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
    }
  });
}

endToEnd("known fail: PF sandals vacation must not ask gender",
  { message: "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?", attrs: { condition: "plantar_fasciitis", useCase: "walking" } },
  GENDER_STALL, true,
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, forcesDisplay: true, clarifier: "repair" });

endToEnd("known fail: 'Jillian in black size 8' forces lookup + keeps card",
  { message: "Do you have the Jillian in black size 8?", namedProduct: true },
  "Take a look at these!", true,
  { workflow: W.AVAILABILITY, searchRequired: true, forcesDisplay: true, clarifier: "allow" });

endToEnd("condition rec + vague stall with no products is flagged",
  { message: "I'm on my feet all day, what should I get?", attrs: { useCase: "standing" } },
  VAGUE_STALL, false,
  { workflow: W.CONDITION_RECOMMENDATION, searchRequired: true, forcesDisplay: true, clarifier: "block_no_products" });

endToEnd("policy turn never forces display or search",
  { message: "Where is my order?" },
  "Let me check — what's your order number?", false,
  { workflow: W.POLICY_ACCOUNT, searchRequired: false, forcesDisplay: false });

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
