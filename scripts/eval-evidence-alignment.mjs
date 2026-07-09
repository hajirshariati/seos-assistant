// Evidence/display alignment eval — the same-session contamination class.
//
// Root bug: in a continuing session, stale memory (a prior Disney/sneakers
// turn) leaked into a later "Do you have Savannah in champagne?" availability
// turn, so the forced-card search became query="sneakers" and the displayed
// cards (Danika/Kinsley/Carly) diverged from the answer text (Savannah).
//
// These assert the deterministic alignment layers with no network:
//   - buildAnswerWorkflowForcedSearch: current-turn family query, never memory
//   - alignCardsToAnswerText: text + cards must share a family, else suppress
//   - validateGrounding(workflow): fragment / sizing / generic block on
//     answer workflows (a 16-char reply can't be ok for a sizing question)
//   - planTurn + namedProduct: B/C from the prior layer still hold per-turn
//
// Run: node scripts/eval-evidence-alignment.mjs

import assert from "node:assert/strict";
import {
  buildAnswerWorkflowForcedSearch,
  alignCardsToAnswerText,
  familyFromQuery,
} from "../app/lib/emit-finalize.server.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";
import { planTurn, WORKFLOWS as W } from "../app/lib/turn-plan.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// A ctx mid-session: prior Disney/sneakers turn left category=sneakers in
// every memory surface; the LATEST message is the Savannah availability turn.
const contaminatedCtx = (latestMsg, planGender = null) => ({
  latestUserMessage: latestMsg,
  turnPlan: { workflow: "availability", gender: planGender },
  sessionMemory: { explicit: { category: "sneakers", color: "black", size: "8.5", condition: "plantar_fasciitis" } },
  classifiedIntent: { attributes: { category: "sneakers", condition: "plantar_fasciitis" } },
  resolverState: { matched_constraints: { category: "sneakers", size: "8.5" } },
  sessionGender: "women",
});

const SAVANNAH_Q = "Do you have Savannah in champagne size 7 wide?";
const SNEAKER_CARDS = [
  { title: "Danika Arch Support Sneaker", handle: "danika" },
  { title: "Kinsley Sneaker", handle: "kinsley" },
  { title: "Carly Sneaker", handle: "carly" },
];
const SAVANNAH_CARD = { title: "Savannah Adjustable Quarter Strap Sandal", handle: "savannah-champagne" };

// ── 3/4. Forced search builds from current turn, NEVER stale memory ───
check("forced search for Savannah availability is NOT query=sneakers", () => {
  const captured = { query: "Savannah adjustable quarter strap sandal", filters: { gender: "women" } };
  const out = buildAnswerWorkflowForcedSearch({ ctx: contaminatedCtx(SAVANNAH_Q), capturedInput: captured });
  assert.match(out.input.query, /savannah/i, "query keeps the family");
  assert.doesNotMatch(out.input.query, /sneaker/i, "query is never sneakers");
  assert.equal(out.input.filters.category, undefined, "no stale category=sneakers filter");
});
check("forced search uses latest message when no captured query (still no sneakers)", () => {
  const out = buildAnswerWorkflowForcedSearch({ ctx: contaminatedCtx(SAVANNAH_Q), capturedInput: null });
  assert.match(out.input.query, /savannah/i);
  assert.doesNotMatch(out.input.query, /sneaker/i);
  assert.equal(out.input.filters.category, undefined);
});
check("forced search keeps champagne color from latest, drops stale black", () => {
  const out = buildAnswerWorkflowForcedSearch({ ctx: contaminatedCtx("Do you have Savannah in champagne?"), capturedInput: null });
  // color only if the latest message named it; stale black must not appear.
  assert.notEqual(out.input.filters.color, "black");
});
check("forced search applies plan gender", () => {
  const out = buildAnswerWorkflowForcedSearch({ ctx: contaminatedCtx(SAVANNAH_Q, "women"), capturedInput: { query: "Savannah" } });
  assert.equal(out.input.filters.gender, "women");
});

// ── 8. Product/text alignment validator ──────────────────────────────
check("text=Savannah + sneaker cards (Savannah NOT in evidence) → suppress", () => {
  const r = alignCardsToAnswerText({
    text: "The Savannah does come in Champagne — it's one of our dressier sandals.",
    cards: SNEAKER_CARDS,
    evidencePool: SNEAKER_CARDS, // exact variant search returned nothing; only stale sneakers around
    namedFamilyHint: familyFromQuery("Savannah adjustable quarter strap sandal"),
  });
  assert.equal(r.changed, true);
  assert.equal(r.cards.length, 0, "mismatched sneaker cards suppressed");
});
check("text=Savannah + Savannah IS in evidence → recover Savannah card (availability)", () => {
  const r = alignCardsToAnswerText({
    text: "Yes — the Savannah comes in Champagne. Here it is.",
    cards: SNEAKER_CARDS,
    evidencePool: [...SNEAKER_CARDS, SAVANNAH_CARD],
    namedFamilyHint: "savannah",
    namedFamilies: ["savannah"],
    keepAlternatives: false, // availability shows only the named family
  });
  assert.equal(r.changed, true);
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].title, /Savannah/);
});
check("availability restricts to named family even when it's already shown (drop Romy)", () => {
  const r = alignCardsToAnswerText({
    text: "I can't confirm that exact size/color — here's the Savannah so you can check.",
    cards: [SAVANNAH_CARD, { title: "Romy Wedge Sandal", handle: "romy" }],
    evidencePool: [SAVANNAH_CARD, { title: "Romy Wedge Sandal", handle: "romy" }],
    namedFamilies: ["savannah"],
    keepAlternatives: false,
  });
  assert.equal(r.changed, true);
  assert.equal(r.reason, "restricted-to-named");
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].title, /Savannah/);
});
check("aligned text+cards are left untouched", () => {
  const r = alignCardsToAnswerText({
    text: "The Danika is a great arch-support sneaker for all-day walking.",
    cards: [SNEAKER_CARDS[0]],
    evidencePool: SNEAKER_CARDS,
    namedFamilyHint: "danika",
  });
  assert.equal(r.changed, false);
});
check("generic answer naming no family leaves cards alone (no false suppress)", () => {
  const r = alignCardsToAnswerText({
    text: "For plantar fasciitis, look for arch support and cushioning — here are some options.",
    cards: SNEAKER_CARDS,
    evidencePool: SNEAKER_CARDS,
    namedFamilyHint: "",
  });
  assert.equal(r.changed, false);
});

// ── 5. Fragment / sizing / generic block on answer workflows ─────────
check("16-char fragment is BLOCKING for a Jillian sizing turn", () => {
  const v = validateGrounding({
    text: "Take a look!",
    pool: [{ title: "Jillian Sandal" }],
    userMessage: "What size should I get in Jillian?",
    workflow: "named_product_advisory",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "fragment_non_answer" || e.kind === "answer_workflow_non_answer"));
});
check("sizing_not_addressed BLOCKS when the customer asked sizing (answer workflow)", () => {
  const v = validateGrounding({
    text: "The Jillian is a lovely sandal that many customers adore for its style and craftsmanship.",
    pool: [{ title: "Jillian Sandal" }],
    userMessage: "What size should I get in the Jillian?",
    workflow: "named_product_advisory",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "sizing_not_addressed"));
});
check("live B: sizing_help after prior cards must not ship stale color answer", () => {
  const v = validateGrounding({
    text: "I couldn't find champagne in our current catalog. Try a different color or style?",
    pool: [],
    userMessage: "What size should I get if I'm usually an 8.5?",
    workflow: "sizing_help",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "sizing_not_addressed" || e.kind === "fragment_non_answer"));
});
check("prior_evidence_availability generic fallback BLOCKS on answer workflow", () => {
  const v = validateGrounding({
    text: "Take a look!",
    pool: [{ title: "Jillian Braided Quarter Strap Sandal - Champagne" }],
    userMessage: "Does either come in champagne or rose?",
    workflow: "prior_evidence_availability",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "fragment_non_answer" || e.kind === "answer_workflow_non_answer"));
});
check("same fragment is NON-blocking on a plain browse turn (warning only)", () => {
  const v = validateGrounding({
    text: "Take a look!",
    pool: [{ title: "Jillian Sandal" }],
    userMessage: "show me sandals",
    workflow: "browse",
  });
  assert.equal(v.ok, true);
});
check("a real sizing answer passes on the answer workflow", () => {
  const v = validateGrounding({
    text: "Start with your usual 8.5 — since your feet swell in heat, the adjustable strap gives extra room, and returns are easy if it runs snug.",
    pool: [{ title: "Jillian Sandal" }],
    userMessage: "What size should I get in the Jillian?",
    workflow: "named_product_advisory",
  });
  assert.equal(v.ok, true);
});

// ── 7. Single-session sequence A → B → C (per-turn planning holds) ────
// A. Disney sneakers turn — sneakers are fine here.
check("A: Disney 10mi sandals-or-sneakers → recommendation, sneakers allowed", () => {
  const plan = planTurn({ message: "I'm going to Disney and walking 10 miles a day. I want sandals, but should I actually get sneakers instead?", attrs: { useCase: "walking" } });
  assert.ok([W.CONDITION_RECOMMENDATION, W.COMPARISON, W.BROWSE].includes(plan.workflow));
});
// B. Savannah availability — must NOT inherit sneakers.
check("B: Savannah availability is its own turn (availability, family query, no sneakers)", () => {
  const plan = planTurn({ message: SAVANNAH_Q, namedProduct: true });
  assert.equal(plan.workflow, W.AVAILABILITY);
  const out = buildAnswerWorkflowForcedSearch({ ctx: { ...contaminatedCtx(SAVANNAH_Q, "women"), turnPlan: plan }, capturedInput: { query: "Savannah" } });
  assert.doesNotMatch(out.input.query, /sneaker/i);
  assert.equal(out.input.filters.category, undefined);
});
// C. Jillian sizing — no stale black / PF, no fragment.
check("C: Jillian sizing turn is advisory, no stale color leaks into forced search", () => {
  const msg = "I usually wear size 8.5 but my feet swell in hot weather. What size should I get in Jillian?";
  const plan = planTurn({ message: msg, namedProduct: true });
  // "what size should I GET" on a named product is a fit/sizing ADVICE turn —
  // an answer workflow that focuses the product (not an availability stock check).
  assert.equal(plan.workflow, W.NAMED_PRODUCT_ADVISORY);
  const out = buildAnswerWorkflowForcedSearch({ ctx: { ...contaminatedCtx(msg, "women"), turnPlan: plan }, capturedInput: { query: "Jillian" } });
  assert.notEqual(out.input.filters.color, "black", "stale black not applied");
  assert.equal(out.input.filters.category, undefined, "stale category not applied");
});

// ── condition/advisory forced search builds a STRUCTURED query (not raw) ──
const conditionCtx = (msg) => ({
  latestUserMessage: msg,
  turnPlan: { workflow: "condition_recommendation", gender: "women" },
  // Deliberately stale memory — must NOT leak into the structured search.
  sessionMemory: { explicit: { category: "sneakers", size: "9", width: "wide", onSale: true } },
  resolverState: { matched_constraints: { category: "sneakers", size: "9", width: "wide" } },
  sessionGender: "women",
});
check("condition: 'supportive sandals for vacation walking, cute' → structured query + category", () => {
  const msg = "I need supportive sandals for vacation walking, but I also want something cute. What would you pick?";
  const out = buildAnswerWorkflowForcedSearch({ ctx: conditionCtx(msg), capturedInput: null });
  const q = String(out.input.query).toLowerCase();
  assert.match(q, /supportive/);
  assert.match(q, /cute/);
  assert.match(q, /walking/);
  assert.match(q, /sandals/);
  assert.notEqual(q, msg.toLowerCase(), "must NOT raw-query the whole sentence");
  assert.ok(q.length < 40, `query should be compact, got: ${q}`);
  assert.equal(out.input.filters.category, "sandals");
  assert.equal(out.input.filters.gender, "women");
});
check("condition: no stale sale/size/width leaks into the forced search", () => {
  const out = buildAnswerWorkflowForcedSearch({ ctx: conditionCtx("I need supportive sandals for walking"), capturedInput: null });
  assert.ok(!out.input.onSale, "stale onSale leaked");
  assert.equal(out.input.filters.size, undefined, "stale size leaked");
  assert.equal(out.input.filters.width, undefined, "stale width leaked");
  assert.notEqual(out.input.filters.category, "sneakers", "stale sneakers category leaked");
});
check("condition: 'cute shoes for standing all day at a wedding' → structured comfort query", () => {
  const msg = "I need cute shoes for standing all day at a wedding";
  const out = buildAnswerWorkflowForcedSearch({ ctx: conditionCtx(msg), capturedInput: null });
  const q = String(out.input.query).toLowerCase();
  assert.match(q, /cute/);
  assert.notEqual(q, msg.toLowerCase(), "must NOT raw-query the whole sentence");
  assert.ok(q.length < 40, `query should be compact, got: ${q}`);
  // a structured comfort/occasion/category term should surface (wedding→dress,
  // shoes→footwear, etc.) — never the raw sentence.
  assert.ok(/standing|wedding|dress|shoes|footwear|sandal|loafer|comfort/.test(q), `expected a structured term, got: ${q}`);
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
