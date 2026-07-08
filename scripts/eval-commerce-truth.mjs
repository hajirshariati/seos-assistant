// COMMERCE TRUTH — root-class truth regressions (not screenshot patches).
// Every product/card/fact answer must be truthful and aligned with the request:
//   1. product-type truth (orthotics vs footwear, pivots, "only X")
//   2. availability/variant truth (text color == shown card color)
//   3. card/text alignment (shown cards in evidence; named products shown)
//   4. policy/account truth (zero product cards; RAG/lexical before support)
//
// Run: node scripts/eval-commerce-truth.mjs

import assert from "node:assert/strict";
import {
  requestedProductType, productTypeMismatch, filterCardsToRequestedType,
  variantTextCardMismatch, cardNotInAnswerEvidence, answerAllowsAlternatives,
} from "../app/lib/commerce-truth.server.js";
import { answerNamesProductNotInEvidence, KNOWN_INVARIANT_CODES } from "../app/lib/turn-invariant.server.js";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";
import { applyAnswerSourceContract } from "../app/lib/support-handoff.js";
import { lexicalRetrieveChunks } from "../app/lib/knowledge-chunks.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const W = WORKFLOWS;
// Card fixtures.
const ORTHOTIC = { title: "Aetrex L700 Speed Orthotic", category: "Orthotics", handle: "l700" };
const INSOLE = { title: "Aetrex Memory Foam Insole", category: "Insoles", handle: "mf" };
const SNEAKER = { title: "Danika Arch Support Sneaker", category: "Sneakers", handle: "danika" };
const SANDAL = { title: "Jillian Braided Sandal - Rose", category: "Sandals", handle: "jillian-rose", _family: "jillian" };
const SANDAL_DENIM = { title: "Jillian Braided Sandal - Denim", category: "Sandals", handle: "jillian-denim", _family: "jillian" };

console.log("\ncommerce-truth — truthful, request-aligned product/card/fact answers\n");

// ── registry ─────────────────────────────────────────────────────────────────
check("registry: commerce-truth invariant codes are registered", () => {
  for (const c of ["product_type_mismatch", "variant_text_card_mismatch", "card_not_in_answer_evidence", "policy_cards_leak"]) {
    assert.ok(KNOWN_INVARIANT_CODES.has(c), `missing ${c}`);
  }
});

// ── CLASS 1: PRODUCT-TYPE TRUTH ───────────────────────────────────────────────
check("orthotic request must not show sneakers (footwear card on orthotic request)", () => {
  const m = "i need an insole for my dad";
  assert.equal(requestedProductType(m).orthoticPositive, true);
  assert.match(productTypeMismatch({ message: m, cards: [SNEAKER] }), /footwear_card_on_orthotic_request/);
  // clean when only orthotics are shown
  assert.equal(productTypeMismatch({ message: m, cards: [ORTHOTIC, INSOLE] }), null);
  // repair drops the sneaker
  assert.deepEqual(filterCardsToRequestedType({ message: m, cards: [SNEAKER, ORTHOTIC] }).map((c) => c.handle), ["l700"]);
});

check("shoe request must not show orthotics (orthotic card on footwear request)", () => {
  const m = "show me some sandals for the summer";
  assert.equal(requestedProductType(m).footwearPositive, true);
  assert.match(productTypeMismatch({ message: m, cards: [SANDAL, ORTHOTIC] }), /orthotic_card_on_footwear_request/);
  assert.equal(productTypeMismatch({ message: m, cards: [SANDAL] }), null);
  assert.deepEqual(filterCardsToRequestedType({ message: m, cards: [ORTHOTIC, SANDAL] }).map((c) => c.handle), ["jillian-rose"]);
});

check("pivot: 'not orthotics, show shoes instead' clears orthotic scope → footwear expected", () => {
  const m = "not orthotics, show shoes instead";
  const req = requestedProductType(m);
  assert.equal(req.orthoticRejected, true);
  assert.equal(req.footwearPositive, true);
  // an orthotic card now is a mismatch
  assert.match(productTypeMismatch({ message: m, cards: [ORTHOTIC] }), /orthotic_card_on_footwear_request/);
  assert.equal(productTypeMismatch({ message: m, cards: [SNEAKER] }), null);
});

check("pivot: 'now only sandals' clears sneakers/shoes/orthotics → sandals only", () => {
  const m = "now only sandals";
  const req = requestedProductType(m);
  assert.equal(req.exclusive, true);
  assert.ok(req.footwearCategories.size > 0, "sandals captured as a positive category");
  // orthotic + sneaker are both wrong; only the sandal survives
  assert.match(productTypeMismatch({ message: m, cards: [ORTHOTIC] }), /orthotic_card_on_footwear_request/);
  assert.match(productTypeMismatch({ message: m, cards: [SNEAKER] }), /wrong_footwear_category/);
  assert.equal(productTypeMismatch({ message: m, cards: [SANDAL] }), null);
  assert.deepEqual(
    filterCardsToRequestedType({ message: m, cards: [ORTHOTIC, SNEAKER, SANDAL] }).map((c) => c.handle),
    ["jillian-rose"],
  );
});

check("mixed request ('shoes and orthotics') asserts nothing (no false mismatch)", () => {
  assert.equal(productTypeMismatch({ message: "show me shoes and orthotics", cards: [SNEAKER, ORTHOTIC] }), null);
  // no cards → nothing to mis-show
  assert.equal(productTypeMismatch({ message: "i need an insole", cards: [] }), null);
});

// ── CLASS 2: AVAILABILITY / VARIANT TRUTH ─────────────────────────────────────
check("Jillian Rose answer must show Rose, not Denim (variant_text_card_mismatch)", () => {
  const colors = ["rose", "champagne", "denim", "black"];
  // text says Rose, card is Denim → mismatch on "rose"
  assert.equal(variantTextCardMismatch({ text: "Yes — the Jillian is available in Rose.", cards: [SANDAL_DENIM], knownColors: colors }), "rose");
  // text says Rose, card IS Rose → clean
  assert.equal(variantTextCardMismatch({ text: "Yes — the Jillian is available in Rose.", cards: [SANDAL], knownColors: colors }), null);
});

// ── CLASS 3: CARD / TEXT ALIGNMENT ────────────────────────────────────────────
check("every shown card must be in the turn's evidence pool (no random alternative)", () => {
  const pool = [SANDAL, SNEAKER];
  const ghost = { title: "Reagan Boot", handle: "reagan" };
  assert.deepEqual(cardNotInAnswerEvidence({ finalCards: [SANDAL, ghost], evidencePool: pool }).map((c) => c.handle), ["reagan"]);
  assert.deepEqual(cardNotInAnswerEvidence({ finalCards: [SANDAL], evidencePool: pool }), []);
});

check("a product NAMED in the answer must be shown as a card (unless text-only)", () => {
  // names Savannah but only Jillian is shown → flagged
  assert.equal(
    answerNamesProductNotInEvidence({ text: "I'd pick the Savannah for walking.", cards: [SANDAL], knownFamilies: ["jillian", "savannah"] }),
    "savannah",
  );
  // no cards shown → text-only recommendation is allowed
  assert.equal(answerNamesProductNotInEvidence({ text: "Consider the Savannah.", cards: [], knownFamilies: ["savannah"] }), null);
});

check("'similar alternatives' phrasing marks extra cards as intentional", () => {
  assert.equal(answerAllowsAlternatives("Here are some similar alternatives you might like."), true);
  assert.equal(answerAllowsAlternatives("Here is the Jillian in Rose."), false);
});

// ── CLASS 4: POLICY / ACCOUNT / SERVICE TRUTH ─────────────────────────────────
check("teacher verification answers from knowledge, shows no products, no premature handoff", () => {
  const q = "What information do I need to provide to verify I'm a teacher?";
  const plan = planTurn({ message: q });
  assert.equal(plan.workflow, W.POLICY_KNOWLEDGE, "routes to policy_knowledge");
  assert.equal(plan.productDisplayPolicy, "suppress", "zero product cards");
  // knowledge HAS the answer → lexical surfaces it → answered from knowledge
  const knowledge = [{ fileType: "faqs", content:
    "Teacher & Student Discounts\nTo verify you're a teacher, upload your school-issued ID through SheerID at checkout for 15% off." }];
  const lex = lexicalRetrieveChunks(knowledge, q, { limit: 3 });
  assert.ok(lex.length > 0, "lexical retrieval finds the teacher section");
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q,
    text: "To verify as a teacher, upload your school-issued ID through SheerID at checkout.",
    ctx: { supportUrl: "https://x/support" }, retrievedChunks: lex, knowledgeText: knowledge[0].content,
  });
  assert.equal(r.source, "rag", "answered from knowledge");
  assert.equal(r.handoff, false, "no generic support handoff");
  assert.deepEqual(r.cards, [], "no product cards on a policy turn");
});

check("order/return/discount/account turns show zero product cards", () => {
  const cases = [
    ["My order says delivered but I didn't get it.", W.ACCOUNT_PRIVATE_HANDOFF],
    ["Can someone help me with my account?", W.ACCOUNT_PRIVATE_HANDOFF],
    ["What is your return policy?", W.POLICY_KNOWLEDGE],
    ["Do you offer teacher discounts?", W.POLICY_KNOWLEDGE],
    ["What's your warranty?", W.POLICY_KNOWLEDGE],
  ];
  for (const [msg, expectWf] of cases) {
    const plan = planTurn({ message: msg });
    assert.equal(plan.workflow, expectWf, `"${msg}" → ${expectWf} (got ${plan.workflow})`);
    assert.equal(plan.productDisplayPolicy, "suppress", `"${msg}" must suppress product cards`);
    assert.equal(plan.searchRequired, false, `"${msg}" must not search`);
  }
});

check("policy turn hands off ONLY when knowledge has no answer", () => {
  const q = "Do you deliver to the international space station?";
  const knowledge = [{ fileType: "faqs", content: "We ship within the US and Canada within 5 business days." }];
  assert.deepEqual(lexicalRetrieveChunks(knowledge, q, { limit: 3 }), [], "no knowledge match");
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q, text: "I don't have that information.",
    ctx: { supportUrl: "https://x/support" }, retrievedChunks: [], knowledgeText: knowledge[0].content,
  });
  assert.equal(r.handoff, true, "genuine no-knowledge → support handoff");
  assert.ok(r.supportCta, "real support CTA");
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
