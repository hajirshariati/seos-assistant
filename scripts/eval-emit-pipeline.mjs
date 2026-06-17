// Emit-pipeline integration eval — drives the REAL production finalize
// chain (app/lib/emit-finalize.server.js, extracted verbatim from
// chat.jsx) end-to-end, not a simulator. Two layers:
//
//   1. Recorded-incident fixtures: every production escape this app has
//      shipped gets replayed through the full chain with the real ctx
//      shape, asserting the final customer-visible text + chips.
//   2. Cross-cutting invariants, checked on EVERY fixture's output:
//        I1  final text is never empty (< 3 chars)
//        I2  poolSize > 0 ⟹ textLen > 0
//        I3  no internal syntax reaches the customer (directives,
//            tool-call syntax, role markers, HTML tags, unbalanced
//            chip markup)
//        I4  DEAD-END INVARIANT: if the model's reply solicited an
//            answer with chips, the emitted reply must still be
//            answerable — it keeps chips or asks a question. A reply
//            with neither is a dead end (live 2026-06-12: narration
//            strip ate the question, chip gate then stripped the
//            chips, customer got a greeting and nothing to tap).
//
// Unlike eval-chat-pipeline.mjs (a hand-maintained simulator kept for
// its module-interaction scenarios), this file cannot drift from
// production order: it executes the same function chat.jsx calls.
//
// Run: node scripts/eval-emit-pipeline.mjs

import assert from "node:assert/strict";
import { finalizeOutboundReply } from "../app/lib/emit-finalize.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(err.message).split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Shared catalog fixture — a small footwear store with a merchant
// "Footwear" umbrella group (group name is NOT a facet category; its
// triggers are the customer vocabulary). Mirrors the live Aetrex shape
// that produced the 2026-06-12 traces.
// ---------------------------------------------------------------------------

const MERCHANT_GROUPS = [
  {
    name: "Footwear",
    triggers: ["shoe", "shoes", "sneaker", "sneakers"],
    categories: ["Sneakers", "Sandals", "Boots"],
  },
  { name: "Orthotics", triggers: ["orthotic", "orthotics", "insole", "insoles"], categories: ["Orthotics"] },
];

const FACET_INDEX = {
  categoryByGender: {
    sneakers: ["men", "women"],
    sandals: ["women"],
    boots: ["men", "women"],
    orthotics: ["men", "women", "kids"],
  },
  colorByGenderCategory: {
    "men:sneakers": ["black", "white"],
    "women:sneakers": ["pink", "black"],
    "women:sandals": ["pink", "tan"],
    "men:boots": ["brown"],
    "women:boots": ["black"],
  },
};

// Production shape: { category: { genders: [...] } } (see
// getCategoryGenderAvailability / filterContradictingGenderChips).
const CATEGORY_GENDER_MAP = {
  sneakers: { genders: ["men", "women"] },
  sandals: { genders: ["women"] },
  boots: { genders: ["men", "women"] },
  orthotics: { genders: ["men", "women", "kids"] },
};

function baseCtx(overrides = {}) {
  return {
    shop: "eval-shop.myshopify.com",
    latestUserMessage: "hi",
    conversationText: "",
    merchantGroups: MERCHANT_GROUPS,
    catalogFacetIndex: FACET_INDEX,
    categoryGenderMap: CATEGORY_GENDER_MAP,
    catalogCategories: ["Sneakers", "Sandals", "Boots", "Orthotics"],
    fullCatalogCategories: ["Sneakers", "Sandals", "Boots", "Orthotics"],
    catalogScopeCategories: ["Sneakers", "Sandals", "Boots", "Orthotics"],
    ...overrides,
  };
}

function card(title, extra = {}) {
  return { title, handle: title.toLowerCase().replace(/\s+/g, "-"), price: "$129.95", ...extra };
}

// ---------------------------------------------------------------------------
// Invariants — run against every fixture's output.
// ---------------------------------------------------------------------------

function chipLabels(text) {
  return [...String(text || "").matchAll(/<<\s*([^<>]+?)\s*>>/g)].map((m) => m[1].trim());
}

function checkInvariants(name, input, out) {
  const text = String(out.text || "");

  // I1: never emit (near-)empty prose.
  assert.ok(text.trim().length >= 3, `[${name}] I1: emitted near-empty text: ${JSON.stringify(text)}`);

  // I2: poolSize>0 ⟹ textLen>0.
  if (out.pool.length > 0) {
    assert.ok(text.trim().length > 0, `[${name}] I2: cards with empty text`);
  }

  // I3: no internal syntax.
  assert.doesNotMatch(text, /:::/, `[${name}] I3: directive markup leaked`);
  assert.doesNotMatch(text, /<\/?(?:function_calls|invoke|parameter)\b/i, `[${name}] I3: tool-call syntax leaked`);
  assert.doesNotMatch(text, /(?:^|\n)\s*(?:Human|Assistant)\s*:/, `[${name}] I3: role marker leaked`);
  assert.doesNotMatch(text, /<\/?(?:p|div|span|br|ul|ol|li)\b/i, `[${name}] I3: HTML tag leaked`);
  const opens = (text.match(/<</g) || []).length;
  const closes = (text.match(/>>/g) || []).length;
  assert.equal(opens, closes, `[${name}] I3: unbalanced chip markup`);

  // I4: dead-end invariant. The model solicited an answer with chips;
  // the emitted reply must remain answerable (chips survive, or a
  // question survives, or product cards carry the turn). Exception:
  // an answer-with-menu denial ("we don't carry X — alternatives…")
  // is an ANSWER whose chip menu is the known-bad shape the gate
  // strips on purpose; stripping it doesn't create a dead end.
  const DENIAL_MENU_RE = /\b(?:we\s+don'?t\s+(?:carry|have)|only\s+available|alternatives?|instead|closest|not\s+available)\b/i;
  const inputHadChips = chipLabels(input.text).length > 0;
  if (inputHadChips && out.pool.length === 0 && !DENIAL_MENU_RE.test(input.text)) {
    const stillAnswerable = chipLabels(text).length > 0 || /\?/.test(text);
    assert.ok(
      stillAnswerable,
      `[${name}] I4 DEAD-END: input solicited via chips but emit has no chips and no question: ${JSON.stringify(text)}`,
    );
  }
}

function run(name, input, extraAssertions = null) {
  test(name, () => {
    const out = finalizeOutboundReply({
      text: input.text,
      pool: input.pool || [],
      ctx: input.ctx || baseCtx(),
      toolsCalledThisTurn: input.toolsCalledThisTurn || new Set(),
      supportCTA: input.supportCTA || null,
      recommenderAskedForMoreInfo: input.recommenderAskedForMoreInfo || false,
      productSearchAttempted: input.productSearchAttempted || false,
      qualitySignals: input.qualitySignals || {},
    });
    checkInvariants(name, input, out);
    if (extraAssertions) extraAssertions(out);
  });
}

console.log("\nemit-pipeline integration eval (real production chain)\n");

// ---------------------------------------------------------------------------
// 1. Recorded incidents
// ---------------------------------------------------------------------------
console.log("— recorded production incidents —");

// 2026-06-12: first-message dead-end greeting. The model's narration
// sentence ("Let me see …") is eaten by stripBannedNarration INCLUDING
// the gender question it contained; the unsafe-inline-chip gate then
// sees "greeting + chips". The gender-set exemption must keep the
// chips, the umbrella scope category ("footwear" — a GROUP name) must
// not catalog-strip them, and they must decorate with the group's
// plural trigger ("shoes").
run(
  "incident 2026-06-12: narration strip eats question — gender chips survive + decorate",
  {
    text: "Hi! Welcome to Aetrex. Let me see which styles fit best — are you shopping for men or women? <<Men's>> <<Women's>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "hi",
      conversationText: "hi",
      sessionMemory: { explicit: { category: "footwear" } },
    }),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(labels.includes("Men's shoes"), `expected decorated <<Men's shoes>>, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Women's shoes"), `expected decorated <<Women's shoes>>, got ${JSON.stringify(labels)}`);
  },
);

// Same incident, apostrophe-less spelling. choice-events and the gender
// detectors accept "Mens"/"Womens"; the chip-gate exemption must too,
// or the dead-end recurs for a sibling label spelling (audit P0-1).
run(
  "incident class: apostrophe-less <<Mens>>/<<Womens>> survive the chip gate",
  {
    text: "Hi! Welcome to Aetrex. <<Mens>> <<Womens>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    assert.equal(chipLabels(out.text).length, 2, `chips stripped: ${JSON.stringify(out.text)}`);
  },
);

// Same incident, generalized beyond gender (audit P0-2): when the
// question sentence is gone and the chips are CATEGORY clarifiers, the
// chips are the only remaining question — stripping them produces a
// dead end. They must survive.
run(
  "incident class: question eaten, category clarifier chips survive (no dead end)",
  {
    text: "Welcome to the store. <<Sneakers>> <<Sandals>> <<Boots>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    assert.ok(chipLabels(out.text).length >= 3, `clarifier chips stripped: ${JSON.stringify(out.text)}`);
  },
);

// The answer-with-menu denial — the failure stripUnsafeInlineChips
// exists for — must STILL strip. ("We don't carry X" dressed up as a
// chip menu.)
run(
  "guard intact: denial dressed as chip menu still strips",
  {
    text: "We don't carry slippers — closest alternatives below. <<Sneakers>> <<Sandals>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    assert.equal(chipLabels(out.text).length, 0, `denial-menu chips kept: ${JSON.stringify(out.text)}`);
  },
);

// 2026-06-12 (second trace of the day): a carried-over umbrella scope
// (category="footwear", a merchant GROUP name, not a facet value) must
// not make every gender chip look catalog-impossible.
run(
  "incident 2026-06-12: umbrella scope category does not catalog-strip gender chips",
  {
    text: "Which would you like to browse? <<Men's>> <<Women's>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "shoes",
      conversationText: "shoes",
      sessionMemory: { explicit: { category: "footwear" } },
    }),
  },
  (out) => {
    assert.equal(chipLabels(out.text).length, 2, `gender chips stripped under umbrella scope: ${JSON.stringify(out.text)}`);
  },
);

// False category denial (Tamara class, category variant): the model
// claims the store doesn't carry a real catalog category — replaced
// with honest framing.
run(
  "incident class: false category denial rewritten to honest framing",
  {
    text: "We focus on orthotics here — we don't carry sneakers.",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "do you have sneakers?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.match(out.text, /we do carry sneakers/i, `false denial not repaired: ${JSON.stringify(out.text)}`);
  },
);

// 2026-06-02 14:21 UTC: repair cascade reduced text to 0 chars with a
// 6-card pool; emit shipped textLen=0 poolSize=6. The final invariant
// guard must produce prose.
run(
  "incident 2026-06-02: empty text with card pool gets rescued prose",
  {
    text: "",
    pool: [card("Jillian Sandal"), card("Danika Sandal"), card("Vicki Sandal")],
    ctx: baseCtx({ latestUserMessage: "show me sandals" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.ok(out.text.trim().length > 0, "no rescue text");
    assert.equal(out.pool.length, 3, "pool dropped during rescue");
  },
);

// 2026-06-10: 915-char structured compare must NOT be truncated under
// llm-owns (the cap amputated "which is better, Vicki or Jillian?" to
// 295 chars mid-word in production).
{
  const longCompare =
    "Both are strong picks, but they serve different feet. " +
    "**Vicki Adjustable Slide — $129.95** " +
    "The Vicki uses a cork footbed with a deep heel cup, and customers with plantar fasciitis tend to favor it. " +
    "Its adjustable strap means you can dial in the fit across the instep, which matters if one foot runs slightly wider. " +
    "The outsole is a firm rubber that holds up well outdoors, and the arch profile is on the structured side. " +
    "Reviewers consistently mention all-day comfort on hard floors, though a few found the footbed firm for the first week. " +
    "**Jillian Braided Quarter Strap Sandal — $139.95** " +
    "The Jillian adds a braided strap and a memory-foam topcover for a softer first step. " +
    "It leans dressier, with a quarter strap that locks the heel without rubbing, and the topcover softens impact noticeably. " +
    "Customers who want cushioning over structure tend to pick this one, and the braided upper stretches slightly as it breaks in. " +
    "If you want structure, take the Vicki; if you want cushioning, the Jillian.";
  run(
    "incident 2026-06-10: long compare answer is not truncated under llm-owns",
    {
      text: longCompare,
      pool: [card("Vicki Adjustable Slide"), card("Jillian Braided Quarter Strap Sandal")],
      ctx: baseCtx({ latestUserMessage: "which is better, Vicki or Jillian?" }),
      productSearchAttempted: true,
    },
    (out) => {
      assert.ok(
        out.text.length > longCompare.length * 0.8,
        `compare text amputated: ${longCompare.length} → ${out.text.length} chars`,
      );
    },
  );
}

// 2026-06-10: RAG-grounded return-policy prose must not be wiped by the
// legacy pitch regex under llm-owns.
run(
  "incident 2026-06-10: return-policy prose survives (no pitch wipe under llm-owns)",
  {
    text:
      "Aetrex accepts returns on unworn items in their original packaging within 30 days of delivery. " +
      "Once the warehouse receives the return, the refund goes back to the original payment method within 5-7 business days. " +
      "Exchanges follow the same window — start either from the returns portal linked in your order email.",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "what is your return policy?" }),
  },
  (out) => {
    assert.match(out.text, /30 days/, `policy prose damaged: ${JSON.stringify(out.text)}`);
  },
);

// ---------------------------------------------------------------------------
// 2. Leak/scrub stages (each is unit-tested elsewhere; here we prove
//    they hold INSIDE the full chain, where ordering bugs live)
// ---------------------------------------------------------------------------
console.log("\n— leak scrubbing inside the full chain —");

run(
  "directive blocks are stripped",
  {
    text: "Here are two great options.\n:::product-list\njillian-sandal|danika-sandal\n:::",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "show me sandals" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.doesNotMatch(out.text, /product-list|\|/, `directive leaked: ${JSON.stringify(out.text)}`);
  },
);

run(
  "role markers are scrubbed",
  {
    text: "Great choice! The Jillian runs true to size.\nHuman: what about width?\nAssistant: It comes in medium and wide.",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "does the Jillian run true to size?" }),
  },
  null, // I3 covers the assertion
);

run(
  "tool-call syntax leak is scrubbed",
  {
    text: 'search_products {"query": "black sneakers"} Here are the black sneakers we carry.',
    pool: [card("Chase Sneaker")],
    ctx: baseCtx({ latestUserMessage: "black sneakers" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.doesNotMatch(out.text, /search_products|\{/, `tool syntax leaked: ${JSON.stringify(out.text)}`);
  },
);

run(
  "literal HTML tags are stripped, chips survive",
  {
    text: "<p>Happy to help!</p><br>Which style? <<Sneakers>> <<Sandals>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    assert.equal(chipLabels(out.text).length, 2, `chips lost during HTML strip: ${JSON.stringify(out.text)}`);
  },
);

run(
  "stock claim without get_product_details is stripped",
  {
    text: "Yes! The Jillian is currently available in size 9.",
    pool: [card("Jillian Sandal")],
    ctx: baseCtx({ latestUserMessage: "do you have the Jillian in size 9?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.doesNotMatch(out.text, /currently available in size 9/i, `unverified stock claim leaked: ${JSON.stringify(out.text)}`);
  },
);

run(
  "stock claim WITH get_product_details passes through",
  {
    text: "Yes! The Jillian is currently available in size 9.",
    pool: [card("Jillian Sandal")],
    ctx: baseCtx({ latestUserMessage: "do you have the Jillian in size 9?" }),
    toolsCalledThisTurn: new Set(["get_product_details"]),
    productSearchAttempted: true,
  },
  (out) => {
    assert.match(out.text, /available in size 9/i, `verified stock claim wrongly stripped: ${JSON.stringify(out.text)}`);
  },
);

// ---------------------------------------------------------------------------
// 3. Chip pipeline stages in composition
// ---------------------------------------------------------------------------
console.log("\n— chip stages in composition —");

run(
  "<<Unisex>> pseudo-gender chip is dropped, real gender chips kept",
  {
    text: "Who are these for? <<Men's>> <<Women's>> <<Unisex>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(!labels.some((l) => /unisex/i.test(l)), `Unisex chip survived: ${JSON.stringify(labels)}`);
    assert.equal(labels.length, 2, `expected 2 gender chips, got ${JSON.stringify(labels)}`);
  },
);

run(
  "repeated chip labels are deduped (first occurrence wins)",
  {
    text: "What kind of style do you want? <<Sneakers>> <<Sandals>> Or pick a type to start: <<Sneakers>> <<Boots>>",
    pool: [],
    ctx: baseCtx(),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.equal(labels.filter((l) => l === "Sneakers").length, 1, `dupe chip survived: ${JSON.stringify(labels)}`);
  },
);

run(
  "contradicting gender chip is stripped for a single-gender category",
  {
    text: "Are you shopping for men or women? <<Men's>> <<Women's>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "I need sandals",
      conversationText: "I need sandals",
    }),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(!labels.some((l) => /^men/i.test(l)), `Men's chip survived for women-only sandals: ${JSON.stringify(labels)}`);
  },
);

// Carried session scope must reach the catalog filter even when the
// latest message restates nothing ("hi"). Before the
// overlayDefinedConstraints fix, the latest-message extraction's
// undefined keys wiped the carried gender and the women-only Sandals
// chip survived for a men-scope session.
run(
  "carried session gender reaches the catalog filter on a no-facet turn",
  {
    text: "Which would you like to see? <<Sneakers>> <<Sandals>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "hi",
      conversationText: "hi",
      sessionMemory: { explicit: { gender: "men" } },
    }),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(!labels.includes("Sandals"), `women-only Sandals chip survived men scope: ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Sneakers"), `valid Sneakers chip lost: ${JSON.stringify(labels)}`);
  },
);

run(
  "<<Kids>> gender chip is stripped (catalog has no kids facet); Men's/Women's survive and decorate",
  {
    text: "Who am I fitting today? <<Men's>> <<Women's>> <<Kids>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "orthotics",
      conversationText: "orthotics",
    }),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(!labels.some((l) => /kid/i.test(l)), `Kids chip should be stripped: ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Men's orthotics"), `Men's chip missing: ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Women's orthotics"), `Women's chip missing: ${JSON.stringify(labels)}`);
  },
);

run(
  "customer-rejected category chips are stripped",
  {
    text: "Got it. Which of these instead? <<Sneakers>> <<Boots>>",
    pool: [],
    ctx: baseCtx({
      latestUserMessage: "no sneakers please",
      conversationText: "no sneakers please",
    }),
  },
  (out) => {
    const labels = chipLabels(out.text);
    assert.ok(!labels.includes("Sneakers"), `rejected category chip survived: ${JSON.stringify(labels)}`);
  },
);

// ---------------------------------------------------------------------------
// 4. Pool suppressions + repairs in composition
// ---------------------------------------------------------------------------
console.log("\n— pool suppressions and repairs —");

run(
  "yes/no question answered yes/no suppresses the card pool",
  {
    text: "Yes, we do carry wide widths.",
    pool: [card("Chase Sneaker"), card("Jillian Sandal")],
    ctx: baseCtx({ latestUserMessage: "do you carry wide widths?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.equal(out.pool.length, 0, `pool not suppressed on yes/no turn (size=${out.pool.length})`);
  },
);

run(
  "policy question without product noun drops the card pool",
  {
    text: "Returns are accepted within 30 days of delivery on unworn items.",
    pool: [card("Chase Sneaker")],
    ctx: baseCtx({ latestUserMessage: "what is your return policy?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.equal(out.pool.length, 0, `pool kept under a policy answer (size=${out.pool.length})`);
  },
);

run(
  "empty text + no pool + search attempted yields a clarify ask",
  {
    text: "",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "asdf qwerty" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.ok(out.text.trim().length > 0, "no fallback text");
  },
);

run(
  "false gender-category affirmation is rewritten to honest framing",
  {
    text: "Yes, we absolutely carry men's sandals — great picks below!",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "do you carry men's sandals?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.match(out.text, /don'?t carry men'?s sandals/i, `false affirmation not corrected: ${JSON.stringify(out.text)}`);
  },
);

run(
  "affirmation guard defers to real cards (no denial rendered above proof)",
  {
    text: "Yes, we carry men's sandals — here are the current picks.",
    pool: [card("Maui Sandal"), card("Bali Sandal")],
    ctx: baseCtx({ latestUserMessage: "do you carry men's sandals?" }),
    productSearchAttempted: true,
  },
  (out) => {
    assert.doesNotMatch(out.text, /don'?t carry/i, `card-bearing reply replaced with denial: ${JSON.stringify(out.text)}`);
  },
);

// ---------------------------------------------------------------------------
// 5. Adversarial model-output shapes
// ---------------------------------------------------------------------------
console.log("\n— adversarial model outputs —");

run(
  "chip-only reply (no prose at all) does not become a dead end",
  {
    text: "<<Sneakers>> <<Sandals>>",
    pool: [],
    ctx: baseCtx(),
  },
  null, // I1 + I4 are the assertions
);

run(
  "whitespace-only reply with no pool yields a clarify ask",
  {
    text: "   \n  ",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "hello?" }),
  },
  (out) => {
    assert.ok(out.text.trim().length >= 3, "no fallback for whitespace reply");
  },
);

run(
  "dangling-connector fragment is repaired or replaced",
  {
    text: "The Jillian pairs well with",
    pool: [],
    ctx: baseCtx({ latestUserMessage: "what goes with the Jillian?" }),
  },
  (out) => {
    assert.notEqual(out.text.trim(), "The Jillian pairs well with", "dangling fragment emitted verbatim");
  },
);

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) {
    console.error(`FAIL: ${f.name}\n${f.err.stack}\n`);
  }
  process.exit(1);
}
