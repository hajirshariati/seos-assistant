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
  variantTextCardMismatch, cardNotInAnswerEvidence, answerAllowsAlternatives, enforceCommerceTruth,
} from "../app/lib/commerce-truth.server.js";
import { answerNamesProductNotInEvidence, KNOWN_INVARIANT_CODES } from "../app/lib/turn-invariant.server.js";
import { planTurn, WORKFLOWS, textPresentsProducts, classifyCatalogItemType } from "../app/lib/turn-plan.server.js";
import { applyAnswerSourceContract } from "../app/lib/support-handoff.js";
import { lexicalRetrieveChunks } from "../app/lib/knowledge-chunks.server.js";
import { cardHasColor } from "../app/lib/availability-truth.js";

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
  assert.ok(["rag", "lexical"].includes(r.source), "answered from knowledge (rag/lexical)");
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

// ── COLOR MATCHING (no substring bugs) ───────────────────────────────────────
check("color match is word-boundary, not substring (Tan∉Titan, Rose∉Primrose)", () => {
  assert.equal(cardHasColor({ title: "Titan Trail Runner" }, "tan"), false, "Tan must not match Titan");
  assert.equal(cardHasColor({ title: "Primrose Wedge" }, "rose"), false, "Rose must not match Primrose");
  assert.equal(cardHasColor({ title: "Shredded Knit Sneaker" }, "red"), false, "red must not match shredded");
  assert.equal(cardHasColor({ title: "Jillian Braided Sandal - Rose" }, "rose"), true);
  assert.equal(cardHasColor({ title: "X", color: "Champagne" }, "champagne"), true);
});

// ── ENFORCEMENT — repairs actually happen (not just detection) ────────────────
const COLORS = ["rose", "champagne", "denim", "black", "tan"];
const JILLIAN_ROSE = { title: "Jillian Braided Sandal - Rose", category: "Sandals", handle: "jillian-rose", _family: "jillian" };
const SAVANNAH = { title: "Savannah Quarter Strap Sandal - Tan", category: "Sandals", handle: "savannah-tan", _family: "savannah" };

check("REPAIR: 'rose or champagne' — text says Rose but card is Denim → shown card becomes Rose", () => {
  const r = enforceCommerceTruth({
    message: "Does the Jillian come in rose or champagne?",
    text: "Yes — the Jillian is available in Rose.",
    cards: [SANDAL_DENIM],
    evidencePool: [SANDAL_DENIM, JILLIAN_ROSE],
    knownColors: COLORS,
  });
  assert.equal(r.cards.length, 1);
  assert.equal(cardHasColor(r.cards[0], "rose"), true, "the shown card is now Rose");
  assert.equal(cardHasColor(r.cards[0], "denim"), false, "no longer showing Denim");
  assert.ok(r.repairs.some((x) => x.code === "variant_text_card_mismatch" && x.repair === "swapped_card"));
});

check("REPAIR: text says a color no pool card has → text rewritten to the shown color", () => {
  const r = enforceCommerceTruth({
    message: "Is the Jillian in black?",
    text: "Yes — the Jillian is available in Black.",
    cards: [JILLIAN_ROSE], evidencePool: [JILLIAN_ROSE], knownColors: COLORS,
  });
  assert.equal(cardHasColor(r.cards[0], "rose"), true, "still the Rose card (only one we have)");
  assert.match(r.text, /Rose/i, "text rewritten to the actually-shown color");
  assert.doesNotMatch(r.text, /available in Black/i, "no longer claims Black");
  assert.ok(r.repairs.some((x) => x.code === "variant_text_card_mismatch" && x.repair === "rewrote_text"));
});

check("REPAIR: 'help me choose the right Aetrex orthotic' → sneaker dropped, only orthotic remains", () => {
  const r = enforceCommerceTruth({
    message: "Help me choose the right Aetrex orthotic",
    text: "Here are a couple of options.", cards: [SNEAKER, ORTHOTIC], evidencePool: [SNEAKER, ORTHOTIC, INSOLE],
  });
  assert.deepEqual(r.cards.map((c) => c.handle), ["l700"], "only the orthotic survives");
  assert.ok(r.repairs.some((x) => x.code === "product_type_mismatch"));
});

check("REPAIR: 'not orthotics, shoes instead' → orthotic dropped; empty → no product-listing copy", () => {
  const r = enforceCommerceTruth({
    message: "Wait, show me shoes instead, not orthotics",
    text: "Here are some great orthotics for you.", cards: [ORTHOTIC], evidencePool: [ORTHOTIC],
  });
  assert.deepEqual(r.cards, [], "the orthotic is dropped");
  assert.equal(textPresentsProducts(r.text), false, "no 'here are…' with zero cards");
  assert.ok(r.repairs.some((x) => x.code === "product_type_mismatch"));
  assert.ok(r.repairs.some((x) => x.code === "product_listing_without_cards"));
});

check("REPAIR: answer names Savannah but shows Jillian → Savannah card is shown (it's in the pool)", () => {
  const r = enforceCommerceTruth({
    message: "which sandal is best for walking?",
    text: "I'd go with the Savannah for all-day walking.",
    cards: [JILLIAN_ROSE], evidencePool: [JILLIAN_ROSE, SAVANNAH], knownFamilies: ["jillian", "savannah"],
    knownColors: COLORS,
  });
  assert.ok(r.cards.some((c) => c.handle === "savannah-tan"), "the named Savannah is now shown");
  assert.ok(r.repairs.some((x) => x.code === "answer_names_product_not_in_evidence" && x.repair === "showed_named"));
});

check("REPAIR: names a product NOT in the pool → the naming sentence is stripped", () => {
  const r = enforceCommerceTruth({
    message: "which sandal is best?",
    text: "The Jillian is lovely. I'd also suggest the Savannah for support.",
    cards: [JILLIAN_ROSE], evidencePool: [JILLIAN_ROSE], knownFamilies: ["jillian", "savannah"],
    knownColors: COLORS,
  });
  assert.doesNotMatch(r.text, /Savannah/i, "the Savannah sentence is stripped (not in evidence)");
  assert.match(r.text, /Jillian/i, "the shown product is still named");
  assert.ok(r.repairs.some((x) => x.code === "answer_names_product_not_in_evidence" && x.repair === "stripped_sentence"));
});

check("REPAIR: a card not in the evidence pool is dropped before response", () => {
  const ghost = { title: "Reagan Boot", handle: "reagan", category: "Boots" };
  const r = enforceCommerceTruth({
    message: "show me sandals", text: "Here are a couple of sandals.",
    cards: [JILLIAN_ROSE, ghost], evidencePool: [JILLIAN_ROSE], knownColors: COLORS,
  });
  assert.deepEqual(r.cards.map((c) => c.handle), ["jillian-rose"], "the ghost card is dropped");
  assert.ok(r.repairs.some((x) => x.code === "card_not_in_answer_evidence"));
});

check("REPAIR: all cards dropped → final text is not product-listing copy", () => {
  const ghost = { title: "Reagan Boot", handle: "reagan" };
  const r = enforceCommerceTruth({
    message: "show me sandals", text: "Here are some great sandals for you!",
    cards: [ghost], evidencePool: [JILLIAN_ROSE],
  });
  assert.deepEqual(r.cards, []);
  assert.equal(textPresentsProducts(r.text), false, "listing copy replaced with a truthful no-card answer");
  assert.ok(r.repairs.some((x) => x.code === "product_listing_without_cards"));
});

check("NO-OP: a clean, truthful turn is left untouched", () => {
  const r = enforceCommerceTruth({
    message: "show me sandals", text: "Here are a couple of sandals I found.",
    cards: [JILLIAN_ROSE], evidencePool: [JILLIAN_ROSE, SAVANNAH], knownColors: COLORS, knownFamilies: ["jillian", "savannah"],
  });
  assert.deepEqual(r.repairs, [], "no repairs on a truthful turn");
  assert.deepEqual(r.cards.map((c) => c.handle), ["jillian-rose"]);
});

// ── QA STABILIZATION (Railway 2026-07-08) ─────────────────────────────────────
// A sandal/flip with "Orthotic" in the title is FOOTWEAR — classification comes
// from the central classifier (structured fields + footwear-noun override),
// never a bare title substring.
const MAUI_FLIPS = { title: "Maui Orthotic Women's Flips - Mocha", category: "Sandals", handle: "maui-mocha", _family: "maui" };

check("classifier: 'Maui Orthotic Women's Flips' is footwear; 'Orthotics for Overpronation' is an insole", () => {
  assert.equal(classifyCatalogItemType(MAUI_FLIPS), "footwear");
  assert.equal(classifyCatalogItemType({ title: "Maui Orthotic Women's Flips - Mocha" }), "footwear", "footwear even with no category tag");
  assert.equal(classifyCatalogItemType({ title: "Men's Orthotics for Overpronation" }), "orthotic_insole");
  assert.equal(classifyCatalogItemType({ productType: "Footwear", title: "Men's Work Posted Orthotics" }), "orthotic_insole", "generic 'Footwear' section tag can't prove wearability");
  assert.equal(classifyCatalogItemType({ title: "Men's Speed Orthotics - Insole For Running" }), "orthotic_insole");
  assert.equal(classifyCatalogItemType({ title: "Copper Sole Socks" }), "accessory");
});

check("classifier: real insole titles with target/condition footwear words stay orthotic_insole", () => {
  // Adversarial-review finding (2026-07-08): real Aetrex insole titles name
  // their TARGET footwear or a foot condition — those words must never flip the
  // classification to footwear, tagged or untagged.
  const realInsoles = [
    "Men's Orthotics for Heel Spurs",
    "Aetrex Womens Fashion Orthotics:For Heels, Pumps, Flats: Comfort & Arch Support",
    "Aetrex Men's Casual Memory Foam Orthotics: Plantar Fasciitis, Flat Feet Relief",
    "Aetrex Mens Instyle Orthotics:Comfort For Dress Shoes with non removable insoles",
    "Children's Dress FLAT/LOW Arch Orthotics-C045",
    "Men's Speed Orthotics for Running Shoes",
  ];
  for (const title of realInsoles) {
    assert.equal(classifyCatalogItemType({ _category: "Orthotics", title }), "orthotic_insole", `tagged: ${title}`);
    assert.equal(classifyCatalogItemType({ title }), "orthotic_insole", `untagged: ${title}`);
  }
  // A DEDICATED orthotic category is decisive over any title noun; a footwear
  // category ("Orthotic Sandals") stays footwear.
  assert.equal(classifyCatalogItemType({ category: "Orthotic Sandals", title: "Maui" }), "footwear");
});

check("orthotic request with a heel-spurs insole card is NOT dropped as a mismatch", () => {
  const card = { _category: "Orthotics", title: "Aetrex Men's Casual Memory Foam Orthotics: Plantar Fasciitis, Flat Feet Relief", handle: "l2305m" };
  const m = "which orthotics do you recommend for plantar fasciitis?";
  assert.equal(productTypeMismatch({ message: m, cards: [card] }), null, "the correct insole card is never flagged");
  const r = enforceCommerceTruth({ message: m, text: "These memory foam orthotics are a great pick.", cards: [card], evidencePool: [card], knownColors: COLORS, knownFamilies: [] });
  assert.equal(r.cards.length, 1, "the only correct card ships");
  assert.ok(!r.repairs.some((x) => x.code === "product_type_mismatch"));
});

check("pivot 'shoes instead, not orthotics' keeps the Maui Flips sandal — only true insoles drop", () => {
  const m = "Wait, show me shoes instead, not orthotics.";
  const cards = [SNEAKER, MAUI_FLIPS, ORTHOTIC];
  // The detector flags the TRUE insole, not the orthotic-named sandal.
  const reason = productTypeMismatch({ message: m, cards });
  assert.ok(reason && /orthotic_card_on_footwear_request/.test(reason), `flags the insole (${reason})`);
  assert.doesNotMatch(String(reason), /Maui/i, "the Maui sandal is never the flagged card");
  const kept = filterCardsToRequestedType({ message: m, cards });
  assert.deepEqual(kept.map((c) => c.handle), ["danika", "maui-mocha"], "sneaker + orthotic-named sandal survive; insole drops");
  // Full enforcement: no repair drops the Maui card.
  const r = enforceCommerceTruth({ message: m, text: "Here are some great shoe options.", cards, evidencePool: cards, knownColors: COLORS, knownFamilies: [] });
  assert.ok(r.cards.some((c) => c.handle === "maui-mocha"), "Maui Flips ships");
});

check("ADVISORY: naming an unpinned product strips the sentence — never adds a 4th card", () => {
  const PINNED = [JILLIAN_ROSE, SAVANNAH, SANDAL_DENIM];
  const r = enforceCommerceTruth({
    workflow: "condition_recommendation",
    message: "I'm going on vacation and walking a lot, but still want something cute. What should I look at?",
    text: "The Jillian and Savannah are my top picks for all-day walking. The Danika is another cute option.",
    cards: PINNED,
    evidencePool: [...PINNED, SNEAKER], // the named Danika IS in the pool — advisory still must not add it
    knownColors: COLORS,
    knownFamilies: ["jillian", "savannah", "danika"],
  });
  assert.equal(r.cards.length, 3, "finalCards stays at the pinned 3 — no post-hoc expansion");
  assert.deepEqual(r.cards.map((c) => c.handle), PINNED.map((c) => c.handle), "the pinned cards are unchanged");
  assert.doesNotMatch(r.text, /Danika/i, "the unpinned-product sentence is stripped");
  assert.match(r.text, /Jillian|Savannah/i, "the pinned recommendation survives");
  assert.ok(r.repairs.some((x) => x.code === "advisory_named_unpinned_product" && x.repair === "stripped_sentence"));
  assert.ok(!r.repairs.some((x) => x.repair === "showed_named"), "showed_named never fires on advisory turns");
});

check("non-advisory turns still repair by showing the named pool card", () => {
  const r = enforceCommerceTruth({
    workflow: "browse",
    message: "which sandal is best for walking?",
    text: "I'd go with the Savannah for all-day walking.",
    cards: [JILLIAN_ROSE], evidencePool: [JILLIAN_ROSE, SAVANNAH], knownFamilies: ["jillian", "savannah"],
    knownColors: COLORS,
  });
  assert.ok(r.cards.some((c) => c.handle === "savannah-tan"));
  assert.ok(r.repairs.some((x) => x.code === "answer_names_product_not_in_evidence" && x.repair === "showed_named"));
});

check("registry: QA-stabilization invariant codes are registered", () => {
  for (const c of ["advisory_named_unpinned_product", "answer_source_misattributed"]) {
    assert.ok(KNOWN_INVARIANT_CODES.has(c), `${c} registered`);
  }
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
