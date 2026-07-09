// SALES / ADVISORY phase — the bot must answer like a professional Aetrex
// salesperson: a direct recommendation first, concise, no process narration
// ("let me pull up…", "I'm seeing…"), no clarifying stall when the customer
// already gave enough, no medical cure/treat claims, and cards that match the
// product type the customer actually asked for.
//
// This is an ENFORCEMENT/EVAL layer, NOT a new owner: it exercises the pure
// advisory-quality detectors (sales-voice.js), the grounding validator's
// blocking behavior on advisory workflows, planTurn routing, and the
// commerce-truth product-type filter — the pieces that keep the live answer
// honest and on-voice.
//
// Run: node scripts/eval-sales-advisory.mjs

import assert from "node:assert/strict";
import {
  detectProcessNarration,
  detectUnsupportedMedicalClaim,
  detectWeakNonAnswer,
  customerGaveEnoughToRecommend,
  ADVISORY_QUALITY_WORKFLOWS,
} from "../app/lib/sales-voice.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";
import { runWithGroundingRetry } from "../app/lib/llm-owns-turn.server.js";
import { planTurn, WORKFLOWS, buildTurnPlanPromptBlock } from "../app/lib/turn-plan.server.js";
import { requestedProductType, filterCardsToRequestedType } from "../app/lib/commerce-truth.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const W = WORKFLOWS;

// A validator helper: run a draft through the advisory-workflow validator and
// return the blocking kinds it produced.
function validateKinds({ text, message, workflow, pool = [{ title: "Jillian", price: 120 }, { title: "Gabby", price: 130 }] }) {
  const v = validateGrounding({ text, pool, workflow, userMessage: message });
  return { ok: v.ok, kinds: v.errors.map((e) => e.kind) };
}
// A clean, on-voice advisory answer for a given lead — recommendation-first, no
// narration, no medical claim, ends with an optional light follow-up.
const CLEAN = "I'd start with the Jillian — its contoured arch support keeps you comfortable through a long day without looking bulky, and it's a great everyday pick. If you want a dressier look, the Gabby is a strong alternative.";

console.log("\nsales / advisory voice + quality\n");

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

check("process narration now catches 'pull up' phrasing (not just 'pulling up')", () => {
  assert.equal(detectProcessNarration("Let me pull up a few options for you.").hit, true);
  assert.equal(detectProcessNarration("I'll pull up some sandals that fit.").hit, true);
  assert.equal(detectProcessNarration("Give me a sec to pull that up.").hit, true);
  // benign shopper/product language is untouched
  assert.equal(detectProcessNarration("These pull-on boots are easy to wear.").hit, false);
  assert.equal(detectProcessNarration("I'd start with the Jillian for all-day comfort.").hit, false);
});

check("unsupported medical claim: cure/heal/fix/relieve/treat a condition is flagged", () => {
  for (const s of [
    "This shoe will cure your plantar fasciitis.",
    "The Jillian fixes your foot pain for good.",
    "It heals bunions over time.",
    "These orthotics relieve plantar fasciitis.",
    "This is the cure for foot pain.",
    "Clinically proven to eliminate heel pain.",
  ]) {
    assert.equal(detectUnsupportedMedicalClaim(s).hit, true, `should flag: ${s}`);
  }
});

check("medical detector does NOT flag honest comfort/support language", () => {
  for (const s of [
    "The contoured footbed supports your arch for all-day comfort.",
    "Great cushioning helps relieve pressure on long days.",
    "Designed for plantar fasciitis sufferers who want more arch support.",
    "It's supportive and comfortable, and fit matters more than price.",
  ]) {
    assert.equal(detectUnsupportedMedicalClaim(s).hit, false, `should NOT flag: ${s}`);
  }
});

check("weak-non-answer: needs BOTH a stall reply AND enough customer context", () => {
  // enough context, stall reply → weak
  assert.equal(
    detectWeakNonAnswer({
      text: "Happy to help! Can you tell me a bit more about the style you want?",
      message: "I'm on my feet 10 hours in a clinic and want supportive shoes.",
    }).hit,
    true,
  );
  // stall reply but NOT enough context → not weak (a real clarifier is fine)
  assert.equal(
    detectWeakNonAnswer({ text: "What's the occasion you're shopping for?", message: "hi there" }).hit,
    false,
  );
  // enough context but a real recommendation lead (even with a trailing question) → not weak
  assert.equal(
    detectWeakNonAnswer({
      text: "I'd start with the Jillian for all-day clinic support. Want it in black or white?",
      message: "I'm on my feet 10 hours in a clinic and want supportive shoes.",
    }).hit,
    false,
  );
});

check("customerGaveEnoughToRecommend: use case + (category OR condition)", () => {
  assert.equal(customerGaveEnoughToRecommend("walking a lot on vacation, want cute shoes"), true);
  assert.equal(customerGaveEnoughToRecommend("plantar fasciitis and standing all day"), true);
  assert.equal(customerGaveEnoughToRecommend("just browsing"), false);
  assert.equal(customerGaveEnoughToRecommend("what colors do you have"), false);
});

check("advisory-quality kinds block on advisory workflows only", () => {
  // medical claim blocks on condition_recommendation
  assert.equal(validateKinds({
    text: "The Jillian will cure your plantar fasciitis.",
    message: "I have plantar fasciitis, what should I get?",
    workflow: W.CONDITION_RECOMMENDATION,
  }).kinds.includes("unsupported_medical_claim"), true);
  // the SAME text on a non-advisory browse turn is not this blocking check's job
  const browse = validateGrounding({
    text: "The Jillian will cure your plantar fasciitis.",
    pool: [{ title: "Jillian", price: 120 }],
    workflow: W.BROWSE,
    userMessage: "show me shoes",
  });
  assert.equal(browse.errors.map((e) => e.kind).includes("unsupported_medical_claim"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 REGRESSION SCENARIOS
// ─────────────────────────────────────────────────────────────────────────────

// 1 — vacation + walking + "cute": advisory turn; a stall is a non-answer, a
// real recommendation passes clean.
check("1. vacation walking + cute → advisory; stall blocked, recommendation passes", () => {
  const m = "I'm going on vacation and walking a lot, but still want something cute. What should I look at?";
  const plan = planTurn({ message: m });
  assert.ok(ADVISORY_QUALITY_WORKFLOWS.has(plan.workflow), `advisory workflow, got ${plan.workflow}`);
  assert.equal(plan.clarificationAllowed, false, "enough info — do not stall");
  assert.equal(validateKinds({ text: "Sure! Tell me a bit more — what's the occasion?", message: m, workflow: plan.workflow }).ok, false);
  assert.equal(validateKinds({ text: CLEAN, message: m, workflow: plan.workflow }).ok, true);
});

// 2 — 10-hour clinic, supportive not bulky: an advisory turn where the customer
// named an occasion + a trait ("supportive, not bulky") but no explicit category
// — the planner still forbids a stall (clarificationAllowed=false), and the
// answer-workflow non-answer guard blocks a clarifying question. A direct pick
// passes clean.
check("2. clinic 10h supportive-not-bulky → advisory; 'what would you pick first' gets a real pick", () => {
  const m = "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?";
  const plan = planTurn({ message: m });
  assert.ok(ADVISORY_QUALITY_WORKFLOWS.has(plan.workflow));
  assert.equal(plan.clarificationAllowed, false, "an occasion + a direct 'what would you pick' — do not stall");
  assert.equal(validateKinds({ text: "Can you tell me more about the look you're going for?", message: m, workflow: plan.workflow }).ok, false, "a clarifying stall is a non-answer here");
  assert.equal(validateKinds({ text: CLEAN, message: m, workflow: plan.workflow }).ok, true);
});

// 3 — wedding + standing all day + "Jillian or something else": advisory; no
// stall, and a medical overreach on this turn is blocked.
check("3. wedding standing all day, Jillian-or-else → advisory; medical overreach blocked", () => {
  const m = "I want something cute for a wedding but I'll be standing all day. Should I get Jillian or something else?";
  const plan = planTurn({ message: m });
  assert.ok(ADVISORY_QUALITY_WORKFLOWS.has(plan.workflow));
  assert.equal(validateKinds({
    text: "The Jillian is perfect and will cure your foot pain by the end of the night.",
    message: m, workflow: plan.workflow,
  }).kinds.includes("unsupported_medical_claim"), true);
  assert.equal(validateKinds({ text: CLEAN, message: m, workflow: plan.workflow }).ok, true);
});

// 4 — plantar fasciitis + flat feet, "shoes, orthotics, or both": advisory-first
// (no stall), and a cure claim is blocked; honest support language passes.
check("4. plantar fasciitis + flat feet, shoes/orthotics/both → advisory-first, no cure claim", () => {
  const m = "I have plantar fasciitis and flat feet. Should I buy shoes, orthotics, or both?";
  const plan = planTurn({ message: m });
  assert.ok(ADVISORY_QUALITY_WORKFLOWS.has(plan.workflow), `advisory, got ${plan.workflow}`);
  assert.equal(plan.clarificationAllowed, false, "advisory-first — do not loop asking use-case");
  assert.equal(validateKinds({
    text: "Buy both — the orthotics will heal your plantar fasciitis and the shoes fix flat feet.",
    message: m, workflow: plan.workflow,
  }).kinds.includes("unsupported_medical_claim"), true);
  const honest = "For plantar fasciitis with flat feet I'd do both: a supportive Aetrex shoe with a contoured footbed for daily wear, plus an orthotic for extra arch support in shoes you already own. Fit matters more than price here, so start with the shoe that feels most supported.";
  assert.equal(detectUnsupportedMedicalClaim(honest).hit, false);
  assert.equal(validateKinds({ text: honest, message: m, workflow: plan.workflow }).ok, true);
});

// 5 — "I use Hoka for walking, pick the right Aetrex orthotic": advisory; a real
// orthotic recommendation passes, a stall is blocked.
check("5. Hoka user wants right Aetrex orthotic → advisory recommendation, not a stall", () => {
  const m = "I use Hoka sneakers for walking. Help me choose the right Aetrex orthotic.";
  const plan = planTurn({ message: m });
  assert.ok(ADVISORY_QUALITY_WORKFLOWS.has(plan.workflow));
  assert.equal(validateKinds({ text: "Sure — can you tell me a bit more about what you need so I can narrow it down?", message: m, workflow: plan.workflow }).ok, false);
  const rec = "For walking in your Hokas I'd reach for the L2200 — it's a full-length support that drops into a roomy walking shoe and adds firm arch support without crowding your toes.";
  assert.equal(validateKinds({ text: rec, message: m, workflow: plan.workflow, pool: [{ title: "L2200", price: 45 }] }).ok, true);
});

// 6 — "orthotics inside sandals?": compatibility; the FAKE removable-footbed
// claim is blocked, the honest closed-shoe answer passes. (No fabricated
// "orthotics drop into sandals" unless catalog evidence supports it.)
check("6. orthotics-in-sandals → compatibility; fake removable-footbed claim blocked", () => {
  const m = "Can I wear orthotics inside sandals, or do I need closed shoes?";
  const plan = planTurn({ message: m });
  assert.equal(plan.workflow, W.COMPATIBILITY);
  assert.equal(plan.productDisplayPolicy, "suppress");
  const fake = validateGrounding({
    text: "Yes! Aetrex sandals have a removable footbed so your orthotics drop right in.",
    pool: [{ title: "Maya Sandal", price: 89 }],
    workflow: W.COMPATIBILITY, userMessage: m,
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.errors.map((e) => e.kind).includes("unsupported_compatibility_claim"), true);
  const honest = validateGrounding({
    text: "Orthotics belong in closed shoes or footwear with a removable insole and enough depth — not open sandals. If you want sandal comfort, Aetrex sandals have built-in arch support instead.",
    pool: [{ title: "Maya Sandal", price: 89 }],
    workflow: W.COMPATIBILITY, userMessage: m,
  });
  assert.equal(honest.ok, true);
});

// 7 — "comfortable shoes for standing at work that don't look like sneakers":
// advisory/browse footwear turn; the recommendation must NOT narrate process.
check("7. work shoes 'not sneakers' → footwear turn, no process narration", () => {
  const m = "Show me comfortable shoes for standing at work that don't look like sneakers.";
  const plan = planTurn({ message: m });
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.productDisplayPolicy, "show");
  // a narrated reply is scrubbed/blocked; the clean one passes
  assert.equal(detectProcessNarration("Let me pull up some options that aren't sneakers.").hit, true);
  assert.equal(detectProcessNarration("Here are polished flats that give you all-day support at work.").hit, false);
});

// 8 — "wear Gabby with a short white dress with big red flowers": a styling turn
// that searches products (never a stall, never a medical claim path).
check("8. 'wear Gabby with a dress' → product/styling turn, searches, shows cards", () => {
  const m = "I want to wear Gabby with a short white dress with big red flowers.";
  const plan = planTurn({ message: m });
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.productDisplayPolicy, "show");
  assert.equal(detectUnsupportedMedicalClaim("The Gabby pairs beautifully with a red-and-white dress.").hit, false);
});

// 9 — "show me shoes instead, not orthotics": a pivot to footwear-only; orthotic
// cards must be dropped from the shown set.
check("9. pivot 'shoes instead, not orthotics' → footwear requested, orthotics filtered out", () => {
  const m = "Wait, show me shoes instead, not orthotics.";
  const plan = planTurn({ message: m });
  assert.equal(plan.searchRequired, true);
  const rt = requestedProductType(m);
  assert.equal(rt.footwearPositive, true);
  assert.equal(rt.orthoticRejected, true, "orthotics explicitly rejected on the pivot");
  const kept = filterCardsToRequestedType({
    message: m,
    cards: [{ title: "Jillian Sneaker" }, { title: "Lynco Orthotic" }, { title: "Maya Sandal" }],
  });
  assert.equal(kept.some((c) => /orthotic|lynco/i.test(c.title)), false, "no orthotic cards after a shoes-only pivot");
  assert.ok(kept.length >= 1, "keeps the footwear");
});

// 10 — "only show me sandals": exclusive sandal filter — sneakers/orthotics drop.
check("10. 'only show me sandals' → exclusive sandal filter, non-sandals dropped", () => {
  const m = "Only show me sandals.";
  const plan = planTurn({ message: m });
  assert.equal(plan.searchRequired, true);
  const rt = requestedProductType(m);
  assert.equal(rt.exclusive, true, "exclusive category request");
  assert.ok(rt.footwearCategories.has("sandal"));
  const kept = filterCardsToRequestedType({
    message: m,
    cards: [{ title: "Jillian Sneaker" }, { title: "Lynco Orthotic" }, { title: "Maya Sandal" }],
  });
  assert.deepEqual(kept.map((c) => c.title), ["Maya Sandal"], "only the sandal survives");
});

// ── QA STABILIZATION (Railway 2026-07-08): advisory verbosity at the source ──
// condition_recommendation is governed to 2-3 short sentences. The prompt
// carries the contract per-turn, and too_long BLOCKS (forces a rewrite) instead
// of relying on a post-hoc trim layer.
check("advisory verbosity: the turn-plan prompt carries the strict 2-3 sentence contract", () => {
  for (const m of [
    "I'm going on vacation and walking a lot, but still want something cute. What should I look at?",
    "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?",
  ]) {
    const plan = planTurn({ message: m });
    assert.equal(plan.workflow, W.CONDITION_RECOMMENDATION);
    const block = buildTurnPlanPromptBlock(plan);
    assert.match(block, /ADVISORY VOICE \(strict\): 2-3 short sentences/, `"${m.slice(0, 40)}…" prompt block carries the contract`);
    assert.match(block, /never reference a product you aren't showing/i);
  }
});

check("advisory verbosity: too_long BLOCKS a rambling condition_recommendation draft", () => {
  const m = "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?";
  const pool = [{ title: "Jillian", price: 120 }, { title: "Gabby", price: 130 }];
  // A ~120-word advisory essay (over the 90-word governed cap) must be rejected.
  const rambling =
    "I'd start with the Jillian because it has fantastic contoured arch support that keeps you comfortable through " +
    "a long clinic shift, and it also comes in several versatile colors that pair well with scrubs or casual outfits. " +
    "Beyond that, the cushioning is genuinely impressive for the price point, and many customers with long hospital " +
    "shifts report that their feet feel noticeably better at the end of the day compared to ordinary flats or generic " +
    "sneakers they wore before. The Gabby is another wonderful option to consider carefully as well, offering a slightly " +
    "dressier silhouette with the same supportive footbed technology, memory foam layering, and a secure fit that stays " +
    "comfortable from your first patient to your last, hour after hour, without feeling bulky or clinical at all.";
  const v = validateGrounding({ text: rambling, pool, workflow: "condition_recommendation", userMessage: m });
  assert.equal(v.ok, false, "the rambling draft is rejected, not trimmed later");
  assert.ok(v.errors.some((e) => e.kind === "too_long"), "blocked specifically as too_long");
  assert.match(v.errors.find((e) => e.kind === "too_long").message, /2-3 short sentences/);
  // The concise contract-following answer passes with NO too_long warning.
  const concise = validateGrounding({ text: CLEAN, pool, workflow: "condition_recommendation", userMessage: m });
  assert.equal(concise.ok, true);
  assert.ok(!(concise.warnings || []).some((e) => e.kind === "too_long"), "no quality_warning=too_long on the concise answer");
});

check("advisory verbosity: too_long stays a WARNING (not blocking) outside condition_recommendation", () => {
  const longBrowse = Array.from({ length: 40 }, (_, i) => `Sentence ${i} about sandals and comfort here.`).join(" ");
  const v = validateGrounding({ text: longBrowse, pool: [{ title: "Jillian" }], workflow: "browse", userMessage: "show me sandals for walking" });
  assert.ok(!v.errors.some((e) => e.kind === "too_long"), "browse turns are not blocked on length");
});

check("advisory verbosity: 'explain in detail' advisory turns are exempt from the cap", () => {
  const m = "I have plantar fasciitis — explain in detail what I should look at and why.";
  const long = Array.from({ length: 20 }, () => "The Jillian offers contoured arch support and cushioning for all-day comfort.").join(" ");
  const v = validateGrounding({ text: long, pool: [{ title: "Jillian" }], workflow: "condition_recommendation", userMessage: m });
  assert.ok(!v.errors.some((e) => e.kind === "too_long"), "detail requests are never length-blocked");
});

await checkAsync("exhaustion valve: a too_long-only exhaustion ships the TRIMMED draft with cards — never a handoff", async () => {
  // Adversarial-review finding (2026-07-08): blocking too_long must not ship a
  // WORSE answer at retry exhaustion. Mock a model that returns the same
  // over-cap (but grounded) advisory draft on every attempt.
  const m = "I'm going on vacation and walking a lot, but still want something cute. What should I look at?";
  const longDraft =
    "I'd start with the Jillian because it has fantastic contoured arch support that keeps you comfortable through " +
    "long vacation days, and it also comes in several versatile colors that pair well with dresses or casual outfits. " +
    "Beyond that, the cushioning is genuinely impressive for the price point, and many customers with long travel days " +
    "report their feet feel noticeably better at the end of the day compared to ordinary flats they wore before. " +
    "The Gabby is another wonderful option offering a dressier silhouette with the same supportive footbed technology " +
    "and a secure fit that stays comfortable from your first mile to your last, hour after hour, without feeling bulky.";
  const cards = [{ title: "Jillian", price: 120 }, { title: "Gabby", price: 130 }];
  const runLoop = async () => ({
    fullResponseText: longDraft,
    finalProductCards: cards,
    turnResult: { products: cards },
    evidencePool: cards,
    qualitySignals: {},
    totalUsage: {},
  });
  const r = await runWithGroundingRetry({
    runLoop,
    initialMessages: [{ role: "user", content: m }],
    userMessage: m,
    turnPlan: { workflow: "condition_recommendation", productDisplayPolicy: "show" },
    maxRetries: 2,
  });
  assert.equal(r.validation.ok, true, "the turn ships ok — not validator-exhausted");
  assert.equal(r.validation.lengthTrimmed, true, "shipped via the too_long-only trim valve");
  assert.ok(!r.needsSupportHandoff, "NEVER a support handoff for a length-only failure");
  assert.ok(r.fullResponseText.length < longDraft.length, "the draft was trimmed, not discarded");
  assert.match(r.fullResponseText, /Jillian/i, "the substantive recommendation survives");
  assert.equal((r.turnResult?.products || r.finalProductCards).length, 2, "cards survive");
  assert.equal(r.qualitySignals?.qualityRepairUsed, true, "the trim is counted as a quality repair");
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
