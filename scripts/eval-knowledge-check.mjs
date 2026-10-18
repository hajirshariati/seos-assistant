// Knowledge check — the lines in uploaded notes that can steer the assistant
// wrong are flagged on the Knowledge page; ordinary facts are left alone.
//
// Run: node scripts/eval-knowledge-check.mjs
import assert from "node:assert/strict";
import { checkKnowledge, MAX_RULES_CHARS } from "../app/lib/knowledge-check.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const codes = (content, fileType = "rules", opts = {}) =>
  checkKnowledge([{ id: "f", fileName: "f.txt", fileType, content }], opts).byFile.f.map((x) => x.code);

console.log("\nkeyword rules (the live \"boots\" failure)");
test("the old Aetrex rule keyed on words is flagged", () => {
  assert.deepEqual(codes("If the customer's message contains ANY of these words/phrases, they want shoes: shoes, boots, sandals."), ["word_trigger"]);
  assert.deepEqual(codes("- If the customer starts with a footwear word (shoes, sneakers, sandals, boots), they want shoes."), ["word_trigger"]);
  assert.deepEqual(codes("- Recommend orthotics only when the customer says orthotic, insert, insole."), ["word_trigger"]);
});
test("the same rule written by intent passes", () => {
  assert.deepEqual(codes("- Shopping for new shoes (shoes, sandals, boots or another style): recommend shoes with built-in support."), []);
  assert.deepEqual(codes("- Already choosing an orthotic: a shoe type names the shoes the orthotic goes in (\"boots\" = orthotics for boots)."), []);
  assert.deepEqual(codes("- A foot condition with no hint which one they want (\"I have bunions\", \"anything for arch pain?\"): ask."), []);
});
test("in a notes file it's a tip, in the rules file a warning", () => {
  const line = "If the customer mentions the words \"wide\" or \"narrow\", show wide shoes.";
  const r = checkKnowledge([
    { id: "r", fileType: "rules", content: line },
    { id: "n", fileType: "faqs", content: line },
  ]);
  assert.equal(r.byFile.r[0].level, "warning");
  assert.equal(r.byFile.n[0].level, "notice");
  assert.equal(r.byFile.n[0].line, 1);
});

console.log("\nother things that go wrong");
test("rules past the length limit: the ignored part is named", () => {
  const r = checkKnowledge([
    { id: "a", fileType: "rules", content: "x".repeat(5000) },
    { id: "b", fileType: "rules", content: "y".repeat(2000) },
    { id: "c", fileType: "rules", content: "z".repeat(100) },
  ]);
  assert.deepEqual(r.byFile.a, []);
  assert.equal(r.byFile.b[0].code, "rules_cut");
  assert.match(r.byFile.b[0].message, /last 1,002 characters/);
  assert.match(r.byFile.c[0].message, /none of this file is used/);
  assert.equal(r.counts.critical, 2);
  assert.equal(MAX_RULES_CHARS, 6000);
});
test("dated promotions in notes are flagged; ordinary discounts aren't", () => {
  assert.deepEqual(codes("Use code FALL25 for 25% off until Oct 31.", "faqs"), ["dated_promo"]);
  assert.deepEqual(codes("Sale ends 11/30 — everything 20% off.", "faqs"), ["dated_promo"]);
  assert.deepEqual(codes("Aetrex offers 15% off through GovX verification.", "faqs"), []);
  assert.deepEqual(codes("Points expire after 12 months without a purchase.", "faqs"), []);
});
test("\"always recommend\" and prices in rules", () => {
  assert.deepEqual(codes("- Always recommend the Plantar Fasciitis Kit."), ["always_push"]);
  assert.deepEqual(codes("- The Speed orthotic is $69.95."), ["rules_price"]);
  assert.deepEqual(codes("- U.S. return fee: $5.95.", "faqs"), [], "policy amounts in notes are facts");
});
test("a shouted rule inside a notes file is a tip to move it", () => {
  assert.deepEqual(codes("NEVER:\n- say trimmable", "brand"), ["rule_in_notes"]);
  assert.deepEqual(codes("Never soak them in water.", "faqs"), [], "ordinary advice isn't a rule");
});
test("links to the store's own pages that weren't read from the site", () => {
  const storeUrls = ["https://www.aetrex.com/pages/rewards", "https://www.aetrex.com/blogs/news/heel-pain"];
  assert.deepEqual(codes("Details: https://www.aetrex.com/pages/rewards.", "faqs", { storeUrls }), []);
  assert.deepEqual(codes("See https://aetrex.com/pages/rewards/ and https://returns.aetrex.com", "faqs", { storeUrls }), []);
  assert.deepEqual(codes("See https://www.aetrex.com/pages/old-rewards-page", "faqs", { storeUrls }), ["link_not_found"]);
  assert.deepEqual(codes("See https://www.aetrex.com/pages/old-rewards-page", "faqs"), [], "no site read yet → no link check");
});
test("plain facts produce nothing", () => {
  const facts = [
    "SHIPPING COST — IS SHIPPING FREE?",
    "═══════════════════════════",
    "Standard shipping is not free. Within the U.S., \"No Rush\" ground shipping is a $5.95 flat rate per order.",
    "- Fit C, \"05\": cupped with a metatarsal pad, for high arches or high forefoot pressure.",
    "Aetrex shoes run true to size. Between sizes? Aetrex recommends sizing up.",
  ].join("\n");
  assert.deepEqual(codes(facts, "faqs"), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
