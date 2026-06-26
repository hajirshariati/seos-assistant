// Regression eval for the three PRD failures:
//   1. condition_recommendation must BLOCK personal/gender clarifier stalls
//      ("Are these for you or a partner?").
//   3. named-product detector must not fire on question words ("what"), and
//      relaxCategoryOnNamedProduct only runs on a real extracted catalog family.
// (Failure 2 — availability card restriction — is covered in
//  scripts/eval-evidence-alignment.mjs.)
//
// Run: node scripts/eval-clarifier-and-detector.mjs

import assert from "node:assert/strict";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";
import { extractCatalogProductFamilies } from "../app/lib/catalog-resolver.server.js";
import { relaxCategoryOnNamedProduct } from "../app/lib/chat-tool-rewrite.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}
const run = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; } };

const POOL = [{ title: "Lynco Arch Support Sandal" }];

// ── FAILURE 1: personal/gender clarifier stalls BLOCK on answer workflows ──
const STALLS = [
  "Are these for you or a partner?",
  "Are they for you or someone else?",
  "Are you shopping for yourself or someone else?",
  "Who are these for?",
  "Is this for you?",
  "Sure! Are you shopping for men's or women's?",
  "Happy to help — could you tell me a bit more about what you're after?",
  "What style, color, or budget did you have in mind?",
];
for (const wf of ["condition_recommendation", "availability", "comparison", "named_product_advisory"]) {
  for (const text of STALLS) {
    check(`block [${wf}] "${text.slice(0, 32)}…"`, () => {
      const v = validateGrounding({ text, pool: POOL, userMessage: "I have plantar fasciitis, what would you recommend?", workflow: wf });
      assert.equal(v.ok, false, "must not be ok");
      assert.ok(v.errors.some((e) => e.kind === "answer_workflow_non_answer"), "must flag answer_workflow_non_answer");
    });
  }
}
// A real recommendation that happens to mention a partner casually is NOT a stall.
check("real recommendation is NOT blocked (no clarifier)", () => {
  const v = validateGrounding({
    text: "For plantar fasciitis, look for arch support and cushioning — sandals help comfort but aren't a cure. The Lynco is a solid supportive pick to start with.",
    pool: POOL,
    userMessage: "I have plantar fasciitis, what would you recommend?",
    workflow: "condition_recommendation",
  });
  assert.equal(v.ok, true);
});
// Browse turns may still ask a clarifier.
check("browse turn clarifier is NOT blocked", () => {
  const v = validateGrounding({ text: "Are you shopping for men's or women's?", pool: POOL, userMessage: "do you have shoes?", workflow: "browse" });
  assert.equal(v.ok, true);
});

// ── FAILURE 3: detector / family extraction ───────────────────────────
const FACTS = [
  { title: "Jillian Braided Quarter Strap Sandal" },
  { title: "Savannah Adjustable Quarter Strap Sandal" },
  { title: "Romy Wedge Sandal" },
  { title: "Men Plantar Fasciitis Kit" },
];
const families = (msg) => extractCatalogProductFamilies("shop", msg, { _testFacts: FACTS });

await run("'What would you recommend?' → no family", async () => {
  assert.deepEqual(await families("What would you recommend?"), []);
});
await run("PF vacation → no family (named=false)", async () => {
  assert.deepEqual(await families("I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?"), []);
});
await run("'Which is better, Jillian or Savannah?' → [jillian, savannah]", async () => {
  assert.deepEqual(await families("Which is better, Jillian or Savannah?"), ["jillian", "savannah"]);
});
await run("'Do you have Savannah in champagne size 7 wide?' → [savannah]", async () => {
  assert.deepEqual(await families("Do you have Savannah in champagne size 7 wide?"), ["savannah"]);
});
// Generic everyday words must NEVER be product families — even when a SKU title
// happens to start with one. "What's the weather?" logged families=[weather] in
// PRD (a "Weatherproof…" style made "weather" a token). The denylist stops it.
await run("'What's the weather?' → no family (generic word, even with a Weatherproof SKU)", async () => {
  const factsWithWeather = [...FACTS, { title: "Weatherproof Trail Sandal" }];
  const out = await extractCatalogProductFamilies("shop", "What's the weather?", { _testFacts: factsWithWeather });
  assert.deepEqual(out, []);
});

// relaxCategoryOnNamedProduct must NOT fire on "What" (no real family), and
// MUST fire on a real extracted family (Jillian).
check("relax does NOT drop filters for 'What would you recommend' (no named family)", () => {
  const call = { name: "search_products", input: { query: "What would you recommend arch support", filters: { category: "sandals", gender: "women" } } };
  const ctx = { latestUserMessage: "I have plantar fasciitis... What would you recommend?", turnPlan: { namedFamilies: [] } };
  const out = relaxCategoryOnNamedProduct(call, ctx);
  assert.deepEqual(out.input.filters, { category: "sandals", gender: "women" }, "filters unchanged — 'what' is not a named product");
});
check("relax DOES drop stale gender for a real named family (Jillian)", () => {
  const call = { name: "search_products", input: { query: "Jillian sandal", filters: { gender: "men" } } };
  const ctx = { latestUserMessage: "do you have the Jillian?", turnPlan: { namedFamilies: ["jillian"] } };
  const out = relaxCategoryOnNamedProduct(call, ctx);
  assert.ok(!out.input.filters || out.input.filters.gender == null, "stale gender dropped for the named product");
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
