// Core-flows regression QA suite.
//
// 50 core scenarios across every workflow the chatbot must get right, asserting
// the DETERMINISTIC owners (TurnPlan + Availability Truth — the parts that don't
// need a live LLM) plus the cross-cutting invariants from
// docs/chatbot-ownership-map.md:
//   - expected workflow
//   - search required yes/no
//   - clarification allowed (proxy for "no gender question when info suffices")
//   - card count expected
//   - no handle / SKU / internal-field leak in answer text
//   - no broad CTA / URL in an exact-availability answer
//   - answer text and cards mention the same product family
//
// Pure modules only, so this runs in either repo with no DB. The live LLM
// phrasing is out of scope here — that's covered by manual PRD live-testing.
//
// Run: node scripts/eval-live-core-flows.mjs

import assert from "node:assert/strict";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";
import {
  classifyAvailability,
  buildAvailabilityAnswer,
  AVAILABILITY_RESULT as R,
} from "../app/lib/availability-truth.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// ── cross-cutting invariant helpers ───────────────────────────────────
const LEAK_PATTERNS = [
  /gid:\/\//i, /\.myshopify\.com/i, /\bhandle\s*[:=]/i, /optionsJson/i,
  /inventoryQty/i, /\bSKU\s*[:=]/i, /variant(_|\s)?id/i, /attributesJson/i,
];
function assertNoLeak(text, label) {
  for (const re of LEAK_PATTERNS) {
    assert.ok(!re.test(String(text || "")), `${label}: internal leak matched ${re}`);
  }
}
function assertNoBroadCTA(text, label) {
  assert.doesNotMatch(String(text || ""), /\bview all\b/i, `${label}: broad "View All" CTA in availability answer`);
  assert.doesNotMatch(String(text || ""), /https?:\/\//i, `${label}: URL in availability answer`);
}
function assertMentionsFamily(text, family, label) {
  assert.match(String(text || "").toLowerCase(), new RegExp(`\\b${family}\\b`), `${label}: text omits family "${family}"`);
}
// Card-count contract for an availability verdict (mirrors the chat.jsx pin):
// NOT_FOUND → 0, DISAMBIGUATION → one card per style, otherwise the family card.
function expectedAvailabilityCards(v) {
  if (v.result === R.NOT_FOUND) return 0;
  if (v.result === R.DISAMBIGUATION) return (v.styles || []).length;
  return 1;
}

// ══ Part 1 — workflow classification + search/clarify/gender ══════════
// Each row asserts the workflow owner's decision. `clarify` doubles as the
// "no gender question when enough info exists" check: clarify=false means the
// turn must act (search/answer), not stall with a question.
const PLAN = [
  // policy / account
  { name: "return policy → policy_account, no search", in: { message: "What's your return policy?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false, clarify: false },
  { name: "where is my order → policy_account", in: { message: "Where is my order #1234?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },
  { name: "do you offer exchanges → policy_account", in: { message: "Do you offer exchanges?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },
  { name: "shipping cost → policy_account", in: { message: "How much is shipping?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },

  // availability (named product in message)
  { name: "Jillian black size 8 → availability, search", in: { message: "Do you have the Jillian in black size 8?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true, clarify: false },
  { name: "Jillian in pink (soft color) → availability", in: { message: "Do you have the Jillian in pink?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true },
  { name: "Savannah champagne 7 wide → availability", in: { message: "Do you have Savannah in champagne size 7 wide?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true },
  // availability follow-ups (no named product, but prior cards / focus)
  { name: "'what about size 9?' w/ prior cards → availability", in: { message: "What about size 9?", hasPriorCards: true }, wf: WORKFLOWS.AVAILABILITY, search: true, clarify: false },
  { name: "'and in black?' w/ focus product → availability", in: { message: "And in black?", focusProduct: { title: "Jillian Braided Sandal - Navy" } }, wf: WORKFLOWS.AVAILABILITY, search: true },
  { name: "'do you have it in wide?' w/ focus → availability", in: { message: "Do you have it in wide?", focusProduct: { title: "Savannah Sandal - Champagne" } }, wf: WORKFLOWS.AVAILABILITY, search: true },

  // comparison
  { name: "Jillian vs Savannah → comparison", in: { message: "Jillian vs Savannah, which is better?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true, clarify: false },
  { name: "'Jillian or Savannah?' → comparison", in: { message: "Jillian or Savannah?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true },

  // named-product advisory
  { name: "is the Jillian good for wide feet → advisory", in: { message: "Is the Jillian good for wide feet?", namedProduct: true }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true, clarify: false },
  { name: "is the Lina worth it → advisory", in: { message: "Is the Lina worth it?", namedProduct: true }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true },

  // condition / use-case recommendation — MUST NOT ask gender first
  { name: "plantar fasciitis rec → condition, search, no clarify", in: { message: "What do you recommend for plantar fasciitis?" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false },
  { name: "standing all day → condition_recommendation", in: { message: "I need something for standing all day" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false },
  { name: "flat feet rec → condition_recommendation", in: { message: "what's good for flat feet?" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true },
  { name: "condition rec, gender unstated → default women, no clarify", in: { message: "recommend something for heel pain" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false, gender: "women" },
  { name: "condition rec for husband → men", in: { message: "shoes for my husband with plantar fasciitis" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, gender: "men" },

  // browse
  { name: "women's sandals browse → browse, search", in: { message: "show me women's sandals" }, wf: WORKFLOWS.BROWSE, search: true, clarify: false, gender: "women" },
  { name: "black wedges browse → browse, no clarify", in: { message: "show me black wedges" }, wf: WORKFLOWS.BROWSE, search: true, clarify: false },
  { name: "men's sneakers browse → men", in: { message: "do you have men's sneakers?" }, wf: WORKFLOWS.BROWSE, search: true, gender: "men" },
  { name: "bare 'do you have shoes?' → browse, MAY clarify", in: { message: "do you have shoes?" }, wf: WORKFLOWS.BROWSE, search: true, clarify: true },

  // clarification / non-product / bad input
  { name: "'hi' → clarification, no search", in: { message: "hi" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "'help' → clarification", in: { message: "help" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "weather (off-topic) → clarification", in: { message: "what's the weather today?" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "keyboard mash → clarification", in: { message: "asdfghjkl qwerty" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "empty message → clarification", in: { message: "" }, wf: WORKFLOWS.CLARIFICATION, search: false },
];

for (const t of PLAN) {
  check(t.name, () => {
    const plan = planTurn(t.in);
    assert.equal(plan.workflow, t.wf, `workflow: got ${plan.workflow}`);
    assert.equal(plan.searchRequired, t.search, `searchRequired: got ${plan.searchRequired}`);
    if (typeof t.clarify === "boolean") {
      assert.equal(plan.clarificationAllowed, t.clarify, `clarificationAllowed: got ${plan.clarificationAllowed}`);
    }
    if (t.gender) assert.equal(plan.gender, t.gender, `gender: got ${plan.gender}`);
  });
}

// ── same-session pivots: each turn re-planned independently ───────────
check("pivot: condition turn then a fresh policy turn re-classifies", () => {
  assert.equal(planTurn({ message: "what helps plantar fasciitis?" }).workflow, WORKFLOWS.CONDITION_RECOMMENDATION);
  assert.equal(planTurn({ message: "what's your return policy?" }).workflow, WORKFLOWS.POLICY_ACCOUNT);
});
check("pivot: browse then availability follow-up re-classifies", () => {
  assert.equal(planTurn({ message: "show me women's sandals" }).workflow, WORKFLOWS.BROWSE);
  assert.equal(planTurn({ message: "what about size 9?", hasPriorCards: true }).workflow, WORKFLOWS.AVAILABILITY);
});
check("pivot: availability then off-topic re-classifies to clarification", () => {
  assert.equal(planTurn({ message: "Do you have the Jillian in black size 8?", namedProduct: true }).workflow, WORKFLOWS.AVAILABILITY);
  assert.equal(planTurn({ message: "lol thanks anyway" }).workflow, WORKFLOWS.CLARIFICATION);
});

// ══ Part 2 — Availability Truth: result, card count, leak/CTA/family ══
const variant = (size, color, qty, width) => {
  const opts = [{ name: "Color", value: color }];
  if (size != null) opts.push({ name: "Size", value: `${size} US` });
  if (width) opts.push({ name: "Width", value: width === "wide" ? "Wide" : "Medium" });
  return { sku: `${color}-${size}${width || ""}`, inventoryQty: qty, optionsJson: JSON.stringify(opts) };
};
const JILLIAN_BLACK = { handle: "jil-blk", title: "Jillian Braided Quarter Strap Sandal - Black", variants: [variant(7, "Black", 3), variant(8, "Black", 5), variant(9, "Black", 0)] };
const JILLIAN_ROSE = { handle: "jil-rose", title: "Jillian Braided Quarter Strap Sandal - Rose", variants: [variant(7, "Rose", 2), variant(8, "Rose", 3)] };
const JILLIAN_SPORT_BLACK = { handle: "jil-sport-blk", title: "Jillian Sport Sandal - Black", variants: [variant(8, "Black", 4)] };
const SAVANNAH_CHAMP = { handle: "sav-champ", title: "Savannah Adjustable Quarter Strap Sandal - Champagne", variants: [variant(7, "Champagne", 4), variant("9 - 9.5", "Champagne", 2)] };
const ROMY = { handle: "romy", title: "Romy Wedge Sandal - Tan", variants: [variant(8, "Tan", 5)] };
const ONE_STYLE = [JILLIAN_BLACK, JILLIAN_ROSE, SAVANNAH_CHAMP, ROMY];
const MULTI_STYLE = [JILLIAN_BLACK, JILLIAN_ROSE, JILLIAN_SPORT_BLACK, SAVANNAH_CHAMP];

const AVAIL = [
  { name: "Jillian black 8 → AVAILABLE, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "black", size: "8" }, result: R.AVAILABLE, family: "jillian" },
  { name: "Jillian black 9 (OOS) → UNAVAILABLE, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "black", size: "9" }, result: R.UNAVAILABLE, family: "jillian" },
  { name: "Jillian pink (soft) → AVAILABLE Rose, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "pink" }, result: R.AVAILABLE, family: "jillian", mentions: /rose/i },
  { name: "Savannah champagne 7 → AVAILABLE, 1 card", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "7" }, result: R.AVAILABLE, family: "savannah" },
  { name: "Savannah champagne 9 (range label) → AVAILABLE", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "9" }, result: R.AVAILABLE, family: "savannah" },
  { name: "Savannah champagne 7 wide (no width data) → UNKNOWN, 1 card", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "7", width: "wide" }, result: R.UNKNOWN, family: "savannah" },
  { name: "Jillian orange (not carried) → UNAVAILABLE", products: ONE_STYLE, args: { family: "jillian", color: "orange" }, result: R.UNAVAILABLE, family: "jillian" },
  { name: "Tamara (absent) → NOT_FOUND, 0 cards", products: ONE_STYLE, args: { family: "tamara", color: "black", size: "8" }, result: R.NOT_FOUND, family: "tamara" },
  { name: "ambiguous 'Jillian black 8' across styles → DISAMBIGUATION, 2 cards", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian in black size 8?" }, result: R.DISAMBIGUATION, family: "jillian" },
  { name: "'Jillian Braided black 8' → AVAILABLE Braided, 1 card", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian braided in black size 8?" }, result: R.AVAILABLE, family: "jillian" },
  { name: "'Jillian Sport black 8' → AVAILABLE Sport, 1 card", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian sport in black size 8?" }, result: R.AVAILABLE, family: "jillian" },
];

for (const t of AVAIL) {
  check(t.name, () => {
    const v = classifyAvailability({ products: t.products, ...t.args });
    assert.equal(v.result, t.result, `result: got ${v.result} reason=${v.reason}`);
    const text = buildAvailabilityAnswer(v);
    // card count contract
    assert.equal(expectedAvailabilityCards(v), t.result === R.NOT_FOUND ? 0 : t.result === R.DISAMBIGUATION ? 2 : 1, "card count");
    // cross-cutting invariants
    assertNoLeak(text, t.name);
    assertNoBroadCTA(text, t.name);
    if (t.result !== R.NOT_FOUND) assertMentionsFamily(text, t.family, t.name);
    if (t.mentions) assert.match(text, t.mentions, `${t.name}: text missing ${t.mentions}`);
    // never lie: soft color must not claim the literal requested color
    if (v.softColor) assert.doesNotMatch(text, new RegExp(`available in ${t.args.color}\\b`, "i"), `${t.name}: claimed unavailable color`);
    // the verdict's product (when present) is always the named family — never a random family
    if (v.product) assertMentionsFamily(v.product.title, t.family, `${t.name} (verdict product family)`);
  });
}

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
