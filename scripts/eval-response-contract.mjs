import assert from "node:assert/strict";
import {
  filterProductCardsToCatalogScope,
  ensureCompleteCustomerText,
  productPoolSatisfiesCatalogScope,
  buildCodeOwnedProductListingText,
  buildCodeOwnedComparisonText,
  buildSoftBrowseFallbackText,
  repairProductTurnAssembly,
  repairProductResponseText,
  stripMissingSkus,
  createTurnResult,
  extractGenericCTA,
  verifyClaimsAgainstCards,
} from "../app/lib/response-contract.server.js";
import {
  buildProductClaimFacts,
  attachClaimFactsToCard,
  lookupSkuToCanonical,
  recommenderProductToCanonical,
} from "../app/lib/product-claim-facts.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Response contract eval\n");

const whiteMensSneakerPool = [
  {
    title: "Dash Arch Support Men's Sneaker - White",
    productType: "Walking Shoes",
    _gender: "Men",
    _category: "Sneakers",
    _attributes: { Color: "White", Gender: "Men", Category: "Sneakers" },
  },
];

const ctx = {
  sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } },
  classifiedIntent: { attributes: {} },
  resolverState: { type: "resolver_state", matched_constraints: {}, inferred_constraints: {} },
};

test("R1 — exact-scope card pool satisfies current scope", () => {
  assert.equal(productPoolSatisfiesCatalogScope(whiteMensSneakerPool, ctx.sessionMemory.explicit), true);
});

test("R2 — contradictory denial is stripped when exact products are present", () => {
  const text = "We don't have any white men's sneakers in stock right now. Good news — we actually do carry white men's sneakers! Here are two styles.";
  const out = repairProductResponseText({ text, pool: whiteMensSneakerPool, ctx });
  assert.equal(out.changed, true);
  assert.equal(/don't have|in stock right now/i.test(out.text), false);
  assert.match(out.text, /actually do carry|matching styles/i);
  assert.equal(out.contract.status, "exact_match");
});

test("R3 — unrelated product pool does not erase a true denial", () => {
  const text = "We don't have white men's sneakers in stock right now.";
  const out = repairProductResponseText({
    text,
    pool: [{ title: "Black Sandal", _gender: "Women", _category: "Sandals", _attributes: { Color: "Black" } }],
    ctx,
  });
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R4 — product turn strips clarifying chips instead of showing ask+answer", () => {
  const text = "What type of men's footwear are you looking for? Here are our men's black sandals — two good options. <<Sandals>><<Sneakers>><<Clogs>><<Accessories>>";
  const pool = [
    {
      title: "Maui Men's Sandal - Black",
      _gender: "men",
      _category: "sandals",
      _attributes: { Color: "Black", Gender: "Men", Category: "Sandals" },
    },
  ];
  const out = repairProductTurnAssembly({ text, pool });
  assert.equal(out.changed, true);
  assert.equal(/<</.test(out.text), false);
  assert.equal(/^what type/i.test(out.text), false);
  assert.match(out.text, /men's black sandals/i);
});

test("R5 — scoped card filter drops off-category semantic cards", () => {
  const mixedPool = [
    {
      title: "Danika Arch Support Sneaker - Pink",
      _gender: "women",
      _category: "sneakers",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sneakers" },
    },
    {
      title: "Vicki Braided Thong Sandal - Light Pink",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(mixedPool, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } },
  });
  assert.equal(scoped.products.length, 1);
  assert.equal(scoped.products[0].title, "Vicki Braided Thong Sandal - Light Pink");
  assert.equal(scoped.dropped, 1);
  assert.equal(scoped.enforcedColor, true);
});

test("R6 — scoped card filter keeps same-category alternatives when exact color is unavailable", () => {
  const alternatives = [
    {
      title: "Kendall Sandal - Burgundy",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Burgundy", Gender: "Women", Category: "Sandals" },
    },
    {
      title: "Vania Sandal - Wine",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Wine", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(alternatives, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "red" } },
  });
  assert.equal(scoped.products.length, 2);
  assert.equal(scoped.dropped, 0);
  assert.equal(scoped.enforcedColor, false);
});

test("R7 — listing text is code-owned and strips checkable claims", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are six pink women's sandals, all with arch support and under $80.",
    cards: [
      { title: "Vicki Braided Thong Sandal - Light Pink Gloss", _gender: "women", _category: "sandals", _attributes: { Color: "Pink" } },
      { title: "Jillian Sport Sandal - Shimmer Blush", _gender: "women", _category: "sandals", _attributes: { Color: "Pink" } },
    ],
    ctx: { latestUserMessage: "show me pink sandals", sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /pink and similar women's sandals/i);
  assert.doesNotMatch(out.text, /\b(?:six|two|all|both|every|under|\$|arch support|size)\b/i);
});

test("R8 — relaxed color listing line tells the truth", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are brown men's sneakers.",
    cards: [
      { title: "Chase Arch Support Sneaker - Silver", _gender: "men", _category: "sneakers", _attributes: { Color: "Silver" } },
      { title: "Dash Arch Support Men's Sneaker - Black", _gender: "men", _category: "sneakers", _attributes: { Color: "Black" } },
    ],
    ctx: { latestUserMessage: "do you have brown sneakers for men?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "brown" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /couldn'?t find brown men's sneakers/i);
  assert.match(out.text, /other colors/i);
  assert.doesNotMatch(out.text, /^here are (?:the )?brown/i);
});

test("R8b — listing line does not call family-color matches exact colors", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are red women's sneakers.",
    cards: [
      { title: "Dani Arch Support Sneaker - Burgundy", _gender: "women", _category: "sneakers", _attributes: { Color: "Burgundy", color_family: "Red" } },
      { title: "Runner Arch Support Sneaker - Terracotta", _gender: "women", _category: "sneakers", _attributes: { Color: "Terracotta", color_family: "Red" } },
    ],
    ctx: { latestUserMessage: "any in red?", sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "red" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /couldn'?t find exact red women's sneakers/i);
  assert.match(out.text, /similar colors/i);
  assert.doesNotMatch(out.text, /^here are (?:the )?red/i);
});

test("R8c — listing line keeps exact named colors when present", () => {
  const out = buildCodeOwnedProductListingText({
    text: "I couldn't find black sandals.",
    cards: [
      { title: "Jess Adjustable Quarter Strap Sandal - Black Sparkle", _gender: "women", _category: "sandals", _attributes: { Color: "Black Sparkle" } },
      { title: "Charli Thong Sandal - Black", _gender: "women", _category: "sandals", _attributes: { Color: "Black" } },
    ],
    ctx: { latestUserMessage: "black sandals?", sessionMemory: { explicit: { gender: "women", category: "sandals", color: "black" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /black women's sandals/i);
  assert.doesNotMatch(out.text, /couldn'?t find/i);
});

test("R8d — scoped card filter prefers literal color cards over color-family cards", () => {
  const scoped = filterProductCardsToCatalogScope([
    {
      title: "Danika Arch Support Sneaker - Peach",
      _gender: "women",
      _category: "sneakers",
      _attributes: { Color: "Peach", color_family: "Pink" },
    },
    {
      title: "Kinsley Arch Support Sneaker - Light Pink",
      _gender: "women",
      _category: "sneakers",
      _attributes: { Color: "Light Pink", color_family: "Pink" },
    },
  ], {
    sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "pink" } },
  });
  assert.equal(scoped.products.length, 1);
  assert.match(scoped.products[0].title, /Light Pink/);
  assert.equal(scoped.enforcedColor, true);
});

test("R8e — Eggplant counts as a literal purple match (shade identity)", () => {
  const out = buildCodeOwnedProductListingText({
    text: "I couldn't find purple sneakers, but here are similar colors.",
    cards: [
      { title: "Dani Arch Support Sneaker - Eggplant", _gender: "women", _category: "sneakers", _attributes: { Color: "Eggplant", color_family: "Purple" } },
    ],
    ctx: { latestUserMessage: "any in purple?", sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "purple" } } },
  });
  assert.match(out.text, /purple women's sneakers/i);
  assert.doesNotMatch(out.text, /couldn'?t find exact purple/i);
});

test("R8f — Coral stays 'similar', never called literal pink (family adjacency)", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are pink sandals.",
    cards: [
      { title: "Julia Arch Support Sandal - Coral", _gender: "women", _category: "sandals", _attributes: { Color: "Coral", color_family: "Pink" } },
    ],
    ctx: { latestUserMessage: "any in pink?", sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } } },
  });
  assert.doesNotMatch(out.text, /^here are (?:the )?pink/i);
  assert.match(out.text, /couldn'?t find exact pink|similar/i);
});

test("R9 — direct variant fact questions keep LLM text path", () => {
  const text = "Chase also comes in black, navy, and silver.";
  const out = buildCodeOwnedProductListingText({
    text,
    cards: [{
      title: "Chase Arch Support Sneaker - White",
      _gender: "men",
      _category: "sneakers",
      _attributes: { Color: "White" },
      _variantFacts: { availableColors: ["White", "Black", "Navy", "Silver"] },
    }],
    ctx: { latestUserMessage: "are there other colors?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R10 — coherence guard trims dangling strip-chain fragments", () => {
  const out = ensureCompleteCustomerText({
    text: "Good news — across these sneakers, the widest option available is medium width. None of these styles offer a dedicated wide width option, so the width options are.",
  });
  assert.equal(out.changed, true);
  assert.equal(/width options are\.$/i.test(out.text), false);
  assert.match(out.text, /medium width\./i);
});

test("R11 — missing SKU strip repairs orphaned article", () => {
  const out = stripMissingSkus("I don't see an L9999 in our catalog.", ["L9999"]);
  assert.equal(out, "I don't see that in our catalog.");
});

test("R12 — color availability denial is repaired from variant facts", () => {
  const out = repairProductTurnAssembly({
    text: "These are only available in White.",
    pool: [{
      title: "Chase Arch Support Sneaker - White",
      handle: "chase-white-am210m",
      _attributes: { Color: "White", Category: "Sneakers", Gender: "Men" },
      _variantFacts: {
        availableColors: ["White", "Black", "Navy", "Silver"],
        byColor: [
          { color: "White" },
          { color: "Black" },
          { color: "Navy" },
          { color: "Silver" },
        ],
      },
    }],
    ctx: { sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, true);
  assert.equal(/only available|only white|no other colors/i.test(out.text), false);
  assert.match(out.text, /Black/i);
  assert.match(out.text, /Navy/i);
  assert.match(out.text, /Silver/i);
});

test("R13 — direct color-range answer is completed from variant facts", () => {
  const out = repairProductTurnAssembly({
    text: "Both styles come in quite a range of colors. Here's what's available for each.",
    pool: [{
      title: "Chase Arch Support Sneaker - White",
      handle: "chase-white-am210m",
      _attributes: { Color: "White", Category: "Sneakers", Gender: "Men" },
      _variantFacts: {
        availableColors: ["White", "Black", "Navy", "Silver"],
        styleAvailableColors: ["White", "Black", "Navy", "Silver"],
      },
    }],
    ctx: { latestUserMessage: "are there other colors?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /Black/i);
  assert.match(out.text, /Navy/i);
  assert.match(out.text, /Silver/i);
});

test("R14 — product pitch without cards is repaired before emit", () => {
  const out = createTurnResult({
    text: "Take a look — these are the closest matches I've got.",
    products: [],
    flags: { productSearchAttempted: true },
  });
  assert.equal(out.products.length, 0);
  assert.doesNotMatch(out.text, /closest matches|take a look|here are/i);
  assert.match(out.text, /exact request/i);
});

test("R15 — broad browse text does not infer gender from an accidental card skew", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are some women's shoes.",
    cards: [
      { title: "Women's Sandal - Black", _gender: "women", _category: "sandals" },
      { title: "Women's Sneaker - Navy", _gender: "women", _category: "sneakers" },
    ],
    ctx: { latestUserMessage: "idk just show me some shoes", sessionMemory: { explicit: {} } },
  });
  assert.equal(out.changed, true);
  assert.doesNotMatch(out.text, /women/i);
  assert.match(out.text, /styles/i);
});

test("R16 — size and width scope require verified variant-matched cards", () => {
  const cards = [
    {
      title: "Wide Verified Sneaker - Black",
      _gender: "women",
      _category: "sneakers",
      _variantScope: { size: "9", width: "wide" },
      _variantFacts: { availableSizes: ["9"], availableWidths: ["wide"] },
    },
    {
      title: "Unverified Sneaker - Black",
      _gender: "women",
      _category: "sneakers",
      _variantFacts: { availableSizes: ["9"], availableWidths: ["wide"] },
    },
  ];
  const ctx = {
    latestUserMessage: "do you have women's sneakers in size 9 wide?",
    sessionMemory: { explicit: { gender: "women", category: "sneakers", size: "9", width: "wide" } },
  };
  const scoped = filterProductCardsToCatalogScope(cards, ctx);
  assert.equal(scoped.products.length, 1);
  assert.equal(scoped.products[0].title, "Wide Verified Sneaker - Black");

  const out = buildCodeOwnedProductListingText({ text: "Here are women's sneakers.", cards: scoped.products, ctx });
  assert.match(out.text, /size 9 and wide width available/i);
});

test("R17 — broad-browse fallback reflects price refinement instead of repeating generic copy", () => {
  const out = buildSoftBrowseFallbackText({
    input: { query: "sale shoes", priceMax: 50 },
    hasProducts: true,
  });
  assert.match(out, /under \$50/i);
  assert.doesNotMatch(out, /color, or price from here/i);
});

test("R18 — impossible gender/category listing is honest about alternatives", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Found these women's boots for you.",
    cards: [
      { title: "Chrissy Boot - Black", _gender: "women", _category: "boots", _attributes: { Gender: "Women", Category: "Boots" } },
      { title: "Vera Boot - Brown", _gender: "women", _category: "boots", _attributes: { Gender: "Women", Category: "Boots" } },
    ],
    ctx: {
      latestUserMessage: "boots for my dad",
      sessionMemory: { explicit: { gender: "men", category: "boots" } },
      resolverState: {
        type: "resolver_state",
        matched_constraints: { category: "boots" },
        inferred_constraints: {},
        impossible_constraints: [{ field: "gender", value: "men", reason: "boots only exists in women" }],
      },
    },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /don't carry men's boots/i);
  assert.match(out.text, /women's boots/i);
  assert.doesNotMatch(out.text, /^found these women's boots/i);
});

test("R19 — comparison renderer answers compare-the-first-two without generic relisting", () => {
  const out = buildCodeOwnedComparisonText({
    text: "Found these women's sneakers for you.",
    cards: [
      { title: "Danika Arch Support Sneaker - Pink", _gender: "women", _category: "sneakers", _attributes: { Color: "Pink" }, price_formatted: "$99.95" },
      { title: "Kinsley Arch Support Sneaker - Blush", _gender: "women", _category: "sneakers", _attributes: { Color: "Blush" }, price_formatted: "$119.95" },
    ],
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /Quick comparison/i);
  assert.match(out.text, /Danika/i);
  assert.match(out.text, /Kinsley/i);
  assert.doesNotMatch(out.text, /^Found these/i);
});

test("R20 — positive color over-claim is corrected from variant facts (contradicts-self)", () => {
  // Hunter (color-iteration persona): bot free-texted "Charlotte ...
  // also comes in red, white, Tan, blue, yellow, and black" while the
  // actual product only carries Terracotta — a trust-killing
  // hallucination. The verifier must replace the ungrounded list with
  // the card's real colors.
  const out = repairProductTurnAssembly({
    text: "Charlotte Lace-Up Sneaker also comes in red, white, Tan, blue, yellow, and black.",
    pool: [{
      title: "Charlotte Lace-Up Sneaker - Terracotta",
      handle: "charlotte-terracotta",
      _attributes: { Color: "Terracotta" },
      _variantFacts: { availableColors: ["Terracotta", "Black"] },
    }],
    ctx: { latestUserMessage: "do you have these in different colors?" },
  });
  assert.equal(out.changed, true);
  // The false colors (red, blue, yellow) must be gone.
  assert.doesNotMatch(out.text, /\b(?:red|blue|yellow|tan)\b/i);
  // The real colors must be present.
  assert.match(out.text, /Terracotta/i);
  assert.match(out.text, /Black/i);
});

test("R21 — accurate positive color claim is left untouched", () => {
  // Guard against over-correction: a TRUE color claim must survive.
  const out = repairProductTurnAssembly({
    text: "Chase Arch Support Sneaker also comes in Black and Navy.",
    pool: [{
      title: "Chase Arch Support Sneaker - White",
      handle: "chase-white",
      _attributes: { Color: "White" },
      _variantFacts: { availableColors: ["White", "Black", "Navy", "Silver"] },
    }],
    ctx: { latestUserMessage: "any other colors?" },
  });
  // No false colors claimed → no correction.
  assert.equal(/red|yellow|pink/i.test(out.text), false);
  assert.match(out.text, /Black/i);
  assert.match(out.text, /Navy/i);
});

test("R20c — partial per-product color enumeration is collapsed (mismatch with displayed cards)", () => {
  // Hunter trace (color-iteration): bot wrote "Danika comes in X.
  // Carly comes in Y." but cards also included Ivy / Charlotte / Blake.
  // The prose enumerated only a subset, which reads as contradictory
  // next to the displayed cards. Collapse to a neutral line.
  const out = repairProductTurnAssembly({
    text: "Danika Arch Support Sneaker also comes in black and navy. Carly Arch Support Sneaker also comes in grey and white.",
    pool: [
      { title: "Danika Arch Support Sneaker - Navy", handle: "danika-navy", _variantFacts: { availableColors: ["Navy", "Black"] } },
      { title: "Carly Arch Support Sneaker - Grey", handle: "carly-grey", _variantFacts: { availableColors: ["Grey", "White"] } },
      { title: "Ivy Arch Support Sneaker - Tan", handle: "ivy-tan", _variantFacts: { availableColors: ["Tan"] } },
      { title: "Charlotte Lace-Up Sneaker - Terracotta", handle: "charlotte", _variantFacts: { availableColors: ["Terracotta"] } },
    ],
    ctx: { latestUserMessage: "what colors are available?" },
  });
  assert.equal(out.changed, true);
  // Per-product enumeration should be gone OR replaced with a neutral line.
  assert.doesNotMatch(out.text, /Danika .* also comes in/i);
});

test("R20b — long color enumeration on a single-variant card is capped (range-vs-variant)", () => {
  // Hunter (gender-pivot-shopper, run #2): card displayed Jillian in
  // Snake, prose said "comes in Navy, Cognac, White, Walnut, Sage,
  // Leopard, Ivory, Gunmetal, Denim, Champagne, Cork, Butter, Brushed
  // Silver, and Antique Rose". All colors are real, but the prose
  // contradicts the single variant shown. Cap to ~4 + include the
  // displayed variant.
  const out = repairProductTurnAssembly({
    text: "Jillian comes in Navy, Cognac, White, Walnut, Sage, Ivory, Gunmetal, Champagne, Cork, Butter, Brushed Silver, and Antique Rose.",
    pool: [{
      title: "Jillian Braided Quarter Strap Sandal - Snake",
      handle: "jillian-snake",
      _attributes: { Color: "Snake" },
      _variantFacts: {
        availableColors: [
          "Snake", "Navy", "Cognac", "White", "Walnut", "Sage", "Ivory",
          "Gunmetal", "Champagne", "Cork", "Butter", "Brushed Silver", "Antique Rose",
        ],
      },
    }],
    ctx: { latestUserMessage: "any other colors?" },
  });
  assert.equal(out.changed, true);
  // The displayed variant must appear in the prose.
  assert.match(out.text, /Snake/i);
  // The enumeration must be capped (not >7 colors named).
  const colorWords = (out.text.match(/\b(?:Snake|Navy|Cognac|White|Walnut|Sage|Ivory|Gunmetal|Champagne|Cork|Butter|Brushed Silver|Antique Rose)\b/gi) || []);
  assert.ok(colorWords.length <= 7, `expected capped enumeration, got ${colorWords.length} color tokens`);
});

test("R22 — repeated soft-browse varies the text instead of repeating verbatim", () => {
  const first = buildSoftBrowseFallbackText({ input: {}, hasProducts: true, repeated: false });
  const again = buildSoftBrowseFallbackText({ input: {}, hasProducts: true, repeated: true });
  assert.notEqual(first, again, "repeated browse must not be identical to the first browse");
  assert.match(again, /different set/i);
  // Still steers toward a concrete narrowing dimension.
  assert.match(again, /style|color|price|men's|women's/i);
});

test("R22b — third+ browse rotates through distinct variants, never the same line twice", () => {
  // Hunter trace (confused-first-timer): customer said "something else"
  // repeatedly and the bot returned the SAME varied line each time. The
  // rotation needs distinct phrasings at each index.
  const v1 = buildSoftBrowseFallbackText({ input: {}, hasProducts: true, repeated: true, repeatIndex: 1 });
  const v2 = buildSoftBrowseFallbackText({ input: {}, hasProducts: true, repeated: true, repeatIndex: 2 });
  const v3 = buildSoftBrowseFallbackText({ input: {}, hasProducts: true, repeated: true, repeatIndex: 3 });
  assert.notEqual(v1, v2, "index 1 and 2 must produce distinct text");
  assert.notEqual(v2, v3, "index 2 and 3 must produce distinct text");
  assert.notEqual(v1, v3, "index 1 and 3 must produce distinct text");
});

test("R23 — non-repeated browse keeps the original starter copy", () => {
  const first = buildSoftBrowseFallbackText({ input: {}, hasProducts: true });
  assert.match(first, /here are a few styles/i);
});

test("R24 — orphan markdown markers around a link are stripped from text", () => {
  // Production trace (Store Locator** bug): LLM wrote
  // "check **[Store Locator](https://...)** today" — the link was
  // extracted but the surrounding ** stayed in the prose, rendering as
  // visible asterisks to the customer.
  const out = extractGenericCTA("check **[Store Locator](https://example.com)** today");
  assert.equal(out.cta.label, "Store Locator");
  assert.doesNotMatch(out.text, /\*\*/, `orphan ** must be cleaned from text; got "${out.text}"`);
});

test("R25 — link extraction collapses double spaces and dangling punctuation", () => {
  const out = extractGenericCTA("pickup info: [Help](https://example.com) Would you like more?");
  assert.equal(out.cta.label, "Help");
  assert.doesNotMatch(out.text, /\s{2,}/, "no double spaces");
  assert.match(out.text, /pickup info: Would you like more\?/);
});

// ---------------------------------------------------------------------------
// Shared intent signal: response-contract reads latestTurnIntent off
// session-memory instead of re-detecting meta / stale-color from text.
// ---------------------------------------------------------------------------

// (1) "compare the first two" — META intent → listing template MUST NOT
// overwrite a substantive AI reply. This is the comparison/meta path.
test("R26 — 'compare the first two' (meta intent) keeps AI text; no listing rewrite", () => {
  const aiText = "Both styles share the Aetrex Lynco footbed and arch support. " +
    "The Vania has a slightly higher heel; the Maui sits flatter to the ground. " +
    "Same width range, same price. Either is a comfortable all-day pick.";
  const cards = [
    { handle: "vania-black", title: "Vania - Black", _gender: "women", _category: "sandals" },
    { handle: "maui-charcoal", title: "Maui - Charcoal", _gender: "women", _category: "sandals" },
  ];
  const out = buildCodeOwnedProductListingText({
    text: aiText,
    cards,
    ctx: {
      latestUserMessage: "compare the first two",
      sessionMemory: {
        explicit: { gender: "women", category: "sandals" },
        latestTurnIntent: {
          label: "meta",
          confidence: 0.9,
          reason: "compare_request",
          staleKeysToDrop: [],
          extractedThisTurn: {},
        },
      },
    },
  });
  assert.equal(out.changed, false, `meta turn must keep AI text; got changed=${out.changed} reason=${out.reason}`);
  assert.equal(out.reason, "meta_conversational_turn");
});

// (2) "are there other colors?" stays in the direct product fact path —
// stale scope.color must NOT drive a listing rewrite. The direct-fact
// gate fires before listing logic; verify it.
test("R27 — 'are there other colors?' stays direct product fact path (no stale-color rewrite)", () => {
  const aiText = "These come in Pewter, Black, and Bronze. Pewter and Black are in stock; Bronze is on backorder.";
  const cards = [
    { handle: "x", title: "X - Pewter", _gender: "women", _category: "sandals" },
  ];
  const out = buildCodeOwnedProductListingText({
    text: aiText,
    cards,
    ctx: {
      // Stale scope.color from an earlier turn.
      latestUserMessage: "are there other colors?",
      sessionMemory: {
        explicit: { gender: "women", category: "sandals", color: "white" },
        latestTurnIntent: {
          label: "meta", // the question asks about variants, not a search
          confidence: 0.85,
          reason: "yes_no_fact_question",
          staleKeysToDrop: [],
          extractedThisTurn: {},
        },
      },
    },
  });
  // Either path is acceptable as long as the AI's variant-fact answer
  // is NOT replaced with a stale-white-color listing line.
  assert.ok(
    out.changed === false ||
      out.reason === "direct_product_fact_question",
    `expected AI text preserved or direct-fact short-circuit; got changed=${out.changed} reason=${out.reason}`,
  );
  assert.doesNotMatch(
    out.text,
    /couldn'?t\s+find\s+(?:exact\s+)?white/i,
    "must not emit stale-white denial",
  );
});

// (3) "do you even understand?" — META intent → AI text preserved.
test("R28 — 'do you even understand?' (meta) is not overwritten by product listing", () => {
  const aiText = "I apologize for the confusion. Let me re-read what you've told me and start over.";
  const cards = [{ handle: "p1", title: "Tatiana - Ivory", _gender: "women", _category: "wedges-heels" }];
  const out = buildCodeOwnedProductListingText({
    text: aiText,
    cards,
    ctx: {
      latestUserMessage: "do you even understand what i'm saying?",
      sessionMemory: {
        explicit: { gender: "women", category: "wedges-heels", color: "white" },
        latestTurnIntent: {
          label: "meta",
          confidence: 0.9,
          reason: "meta_conversational",
          staleKeysToDrop: [],
          extractedThisTurn: {},
        },
      },
    },
  });
  assert.equal(out.changed, false, `meta keeps AI text; got reason=${out.reason}`);
  assert.equal(out.reason, "meta_conversational_turn");
  assert.doesNotMatch(out.text, /couldn'?t\s+find\s+exact\s+white/i);
});

// (4) "any pink ones?" — color extracted THIS turn → normal color-aware
// listing fires (color refinement). The same prior-scope shape that
// would have produced a stale-color rewrite for an unrelated turn
// here legitimately produces a pink listing because the customer
// actually mentioned pink.
test("R29 — 'any pink ones?' (color refinement) still produces color-aware listing", () => {
  const aiText = ""; // empty AI text forces listing template
  const cards = [
    { handle: "p", title: "Vania - Pink", _gender: "women", _category: "sandals", _colors: ["pink"] },
  ];
  const out = buildCodeOwnedProductListingText({
    text: aiText,
    cards,
    ctx: {
      latestUserMessage: "any pink ones?",
      sessionMemory: {
        explicit: { gender: "women", category: "sandals", color: "pink" },
        latestTurnIntent: {
          label: "pivot_color",
          confidence: 0.9,
          reason: "color_pivot",
          staleKeysToDrop: ["color"],
          extractedThisTurn: { color: "pink" },
        },
      },
    },
  });
  // Color-aware listing should mention pink.
  assert.match(out.text, /pink/i, `expected color-aware listing to mention pink; got "${out.text}"`);
});

// ---------------------------------------------------------------------------
// Claim-accuracy verifier — visible product text must match per-card facts.
// ---------------------------------------------------------------------------

// Helper: build a card with the fact fields the verifier reads.
const card = ({
  title = "X",
  conditionTags = [],
  useCaseTags = [],
  onSale = false,
  removableInsole = null,
  archSupport = false,
  waterFriendly = false,
  footbed = null,
  badge = null,
  productLine = null,
} = {}) => ({
  title,
  _conditionTags: conditionTags,
  _useCaseTags: useCaseTags,
  _onSale: onSale,
  _removableInsole: removableInsole,
  _archSupport: archSupport,
  _waterFriendly: waterFriendly,
  _footbed: footbed,
  _badge: badge,
  _productLine: productLine,
});

test("R30 — universal PF claim is softened when not every card is PF-tagged (noisy corpus → safe)", () => {
  // Production trace: corpus regex tags 95% of Aetrex with PF
  // (boilerplate description). Merchant tags only 77%. When the AI
  // says "all of these are tagged for plantar fasciitis" but one
  // shown card actually isn't, that universal claim must drop.
  const cards = [
    card({ title: "A", conditionTags: ["plantar_fasciitis"] }),
    card({ title: "B", conditionTags: ["plantar_fasciitis"] }),
    card({ title: "C", conditionTags: ["bunions"] }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Great options. All of these are tagged for plantar fasciitis and feature arch support.",
    cards,
  });
  assert.ok(out.changed, "verifier must change the text");
  assert.doesNotMatch(out.text, /all of these are tagged for plantar fasciitis/i,
    `universal PF claim should have been stripped; got "${out.text}"`);
});

test("R31 — merchant Bunions tag allows per-product bunion claim", () => {
  const cards = [card({ title: "Maui", conditionTags: ["bunions"] })];
  const out = verifyClaimsAgainstCards({
    text: "The Maui is a great pick for bunions.",
    cards,
  });
  assert.equal(out.changed, false, `per-product claim should stand; logs=${out.logs.join(",")}`);
  assert.match(out.text, /bunions/i);
});

test("R32 — 'hiking' claim with no merchant tag is stripped", () => {
  // No card has hiking in _useCaseTags — even though corpus might
  // pick up "outdoor" in the description, the structured signal
  // doesn't support it.
  const cards = [
    card({ title: "Boot", useCaseTags: ["walking"] }),
    card({ title: "Boot2", useCaseTags: ["walking"] }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "These are great for hiking on rocky trails.",
    cards,
  });
  assert.ok(out.changed, "hiking claim must be stripped");
  assert.doesNotMatch(out.text, /hiking/i);
});

test("R33 — 'travel' / 'Italy' claim with no merchant travel tag is stripped", () => {
  const cards = [
    card({ title: "X", useCaseTags: ["walking", "casual"] }),
    card({ title: "Y", useCaseTags: ["beach"] }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Perfect for travel and your Italy trip.",
    cards,
  });
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /travel|trip/i);
});

test("R34 — 'waterproof' / 'roomy toe box' / 'rocker bottom' are stripped (catalog has no field)", () => {
  const cards = [
    card({ title: "X", conditionTags: ["bunions"], useCaseTags: ["walking"] }),
    card({ title: "Y", conditionTags: ["bunions"], useCaseTags: ["walking"] }),
  ];
  for (const phrase of ["waterproof", "roomy toe box", "rocker bottom", "orthotic-compatible"]) {
    const out = verifyClaimsAgainstCards({
      text: `These are ${phrase} and great for bunions.`,
      cards,
    });
    assert.ok(out.changed, `${phrase} sentence must be stripped`);
    assert.doesNotMatch(out.text, new RegExp(phrase, "i"), `"${phrase}" leaked`);
  }
});

test("R35 — universal sale claim is stripped when not every card is on sale", () => {
  const cards = [
    card({ title: "A", onSale: true }),
    card({ title: "B", onSale: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Both are currently on sale.",
    cards,
  });
  assert.ok(out.changed, "false universal sale claim must be stripped");
  assert.doesNotMatch(out.text, /on sale/i);
});

test("R36 — universal sale claim survives when every card is on sale", () => {
  const cards = [
    card({ title: "A", onSale: true }),
    card({ title: "B", onSale: true }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Both are currently on sale.",
    cards,
  });
  assert.equal(out.changed, false);
});

test("R37 — verifier is no-op when cards have no fact fields (degrades to legacy)", () => {
  const out = verifyClaimsAgainstCards({
    text: "All of these are great for hiking and waterproof.",
    cards: [{ title: "X" }, { title: "Y" }],
  });
  assert.equal(out.changed, false, "no fact fields → no change");
});

test("R38 — per-product 'great for hiking' is still stripped if NO card has hiking tag", () => {
  const cards = [
    card({ title: "Hannah Boot", useCaseTags: ["walking"] }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "The Hannah is great for hiking.",
    cards,
  });
  assert.ok(out.changed);
});

// ---------------------------------------------------------------------------
// Arch support verification (new in this PR)
// ---------------------------------------------------------------------------
test("R39 — universal arch-support claim survives when every card has _archSupport", () => {
  const cards = [
    card({ title: "A", archSupport: true }),
    card({ title: "B", archSupport: true }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "All of these have arch support.",
    cards,
  });
  assert.equal(out.changed, false, `arch support claim should survive when every card has it`);
});

test("R40 — universal arch-support claim is stripped when one card lacks it", () => {
  const cards = [
    card({ title: "A", archSupport: true }),
    card({ title: "B", archSupport: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "All of these have arch support.",
    cards,
  });
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /all of these have arch support/i);
});

test("R41 — per-product arch-support claim passes when at least one card has it", () => {
  const cards = [
    card({ title: "Maui", archSupport: true }),
    card({ title: "Vania", archSupport: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "The Maui has arch support built in.",
    cards,
  });
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// Bare per-product sale verification (new in this PR)
// ---------------------------------------------------------------------------
test("R42 — bare 'on sale' claim stripped when no card is _onSale", () => {
  const cards = [
    card({ title: "Maui", onSale: false }),
    card({ title: "Vania", onSale: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "The Maui is currently on sale.",
    cards,
  });
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /on sale/i);
});

test("R43 — bare 'on sale' claim survives when at least one card is _onSale", () => {
  const cards = [
    card({ title: "Maui", onSale: true }),
    card({ title: "Vania", onSale: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "The Maui is on sale right now.",
    cards,
  });
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// Footbed verification (new in this PR — nullable field, passes when unset)
// ---------------------------------------------------------------------------
test("R44 — 'memory foam footbed' claim passes when at least one card._footbed includes 'memory'", () => {
  const cards = [
    card({ title: "A", footbed: "memory foam premium" }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Features a memory foam footbed for all-day comfort.",
    cards,
  });
  assert.equal(out.changed, false);
});

test("R45 — 'memory foam footbed' claim is stripped when card._footbed contradicts ('cork')", () => {
  const cards = [
    card({ title: "A", footbed: "cork natural" }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Features a memory foam footbed for all-day comfort.",
    cards,
  });
  assert.ok(out.changed, `expected the unsupported footbed claim to be stripped`);
});

test("R46 — footbed claim is passed through when NO card has _footbed populated", () => {
  // Merchant doesn't use the footbed field — verifier must not
  // penalize the AI for talking about footbeds.
  const cards = [
    card({ title: "A" }), // footbed: null
    card({ title: "B" }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "Features a memory foam footbed for all-day comfort.",
    cards,
  });
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// Badge verification (new in this PR — nullable field, passes when unset)
// ---------------------------------------------------------------------------
test("R47 — 'best seller' passes when card._badge includes 'best'", () => {
  const cards = [card({ title: "A", badge: "best seller" })];
  const out = verifyClaimsAgainstCards({
    text: "This style is a best seller in our women's lineup.",
    cards,
  });
  assert.equal(out.changed, false);
});

test("R48 — 'best seller' is stripped when card._badge is some unrelated value", () => {
  const cards = [card({ title: "A", badge: "new" })];
  const out = verifyClaimsAgainstCards({
    text: "This is a best seller.",
    cards,
  });
  assert.ok(out.changed);
});

test("R49 — 'best seller' passes through when NO card has _badge populated", () => {
  const cards = [card({ title: "A" }), card({ title: "B" })];
  const out = verifyClaimsAgainstCards({
    text: "This style is a best seller.",
    cards,
  });
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// Lookup_sku-style cards must NOT early-bail the verifier (P0-1 audit fix)
// ---------------------------------------------------------------------------
test("R50 — lookup_sku-shaped cards (with fact fields) trip haveAnyFacts; verifier runs", () => {
  // Lookup_sku synthesizes a claimSource and spreads claimFacts(...)
  // on each card. As long as the fact fields are populated, the
  // verifier must NOT take the haveAnyFacts early-bail.
  const cards = [
    card({ title: "Maui Charcoal", conditionTags: ["bunions"], archSupport: true }),
    card({ title: "Susie Black", conditionTags: ["bunions"], archSupport: false }),
  ];
  // Mixed pool — universal arch-support claim must be stripped.
  const out = verifyClaimsAgainstCards({
    text: "Both have arch support and run wide.",
    cards,
  });
  assert.ok(out.changed, `lookup_sku-shape cards should still be verified; got logs=${out.logs.join(",")}`);
});

test("R51 — verifier early-bails only when truly no fact fields are present", () => {
  // Bare cards (legacy/test fixture only) — early-bail expected.
  const out = verifyClaimsAgainstCards({
    text: "All of these are tagged for plantar fasciitis.",
    cards: [{ title: "X" }, { title: "Y" }],
  });
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// Water-friendly verification (P2)
// ---------------------------------------------------------------------------
test("R52 — 'water-friendly' claim survives when displayed card has _waterFriendly=true", () => {
  const cards = [card({ title: "Maui", waterFriendly: true })];
  const out = verifyClaimsAgainstCards({
    text: "The Maui features water-friendly construction.",
    cards,
  });
  assert.equal(out.changed, false);
});

test("R53 — 'water-friendly' claim is stripped when no displayed card has the flag", () => {
  const cards = [
    card({ title: "A", waterFriendly: false }),
    card({ title: "B", waterFriendly: false }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "These are water-friendly for the beach.",
    cards,
  });
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /water[\s-]?friendly/i);
});

test("R54 — 'waterproof' still strips even with _waterFriendly=true cards (distinct claims)", () => {
  // _waterFriendly does NOT imply waterproof. Verifier must not
  // accept a "waterproof" claim against a water-friendly card.
  const cards = [card({ title: "Maui", waterFriendly: true })];
  const out = verifyClaimsAgainstCards({
    text: "This is fully waterproof for rainy days.",
    cards,
  });
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /waterproof/i);
});

// ---------------------------------------------------------------------------
// Empty-text-with-pool fallback (production failure: verifier stripped 81→0
// chars, emit shipped textLen=0 poolSize=6).
// ---------------------------------------------------------------------------
test("R55 — verifier zeroing every sentence returns next='' (caller must fallback)", () => {
  // Single sentence carrying an absent-feature claim — the verifier
  // drops it, and there is nothing left to keep.
  const cards = [
    card({ title: "A", useCaseTags: ["dress"] }),
    card({ title: "B", useCaseTags: ["dress"] }),
  ];
  const out = verifyClaimsAgainstCards({
    text: "All of these are great for hiking.",
    cards,
  });
  assert.equal(out.changed, true);
  assert.equal(out.text, "");
  assert.ok(out.logs.length > 0, `expected reasons for the zeroed text; got ${JSON.stringify(out.logs)}`);
});

test("R56 — ensureCompleteCustomerText turns empty text into pool fallback line", () => {
  const out = ensureCompleteCustomerText({
    text: "",
    fallback: "Here are the matching styles I found.",
  });
  assert.equal(out.changed, true);
  assert.equal(out.reason, "empty");
  assert.equal(out.text, "Here are the matching styles I found.");
});

test("R57 — ensureCompleteCustomerText rescues whitespace-only input via fallback", () => {
  const out = ensureCompleteCustomerText({
    text: "   \n  ",
    fallback: "Here are the matching styles I found.",
  });
  assert.equal(out.changed, true);
  assert.equal(out.reason, "empty");
  assert.equal(out.text, "Here are the matching styles I found.");
});

// ---------------------------------------------------------------------------
// Production ordering: repairProductTurnAssembly internally invokes
// verifyClaimsAgainstCards and can leave text="" with a non-empty pool.
// The last-resort guard in chat.jsx then calls buildCodeOwnedProductListingText
// with text="" and must produce a non-empty string from the pool alone.
// R58 reproduces that exact call so the next defender can write the
// invariant `pool>0 ⟹ textLen>0` without re-reading the chain.
// ---------------------------------------------------------------------------
test("R58 — repairProductTurnAssembly + verifier can zero text under pool>0 (matches live failure)", () => {
  // Live trace: "Both have arch support and run wide." → 149→0 chars
  // under unverified_universal:arch support against a mixed pool.
  const cards = [
    card({ title: "A", archSupport: true }),
    card({ title: "B", archSupport: false }),
    card({ title: "C", archSupport: true }),
    card({ title: "D", archSupport: false }),
    card({ title: "E", archSupport: true }),
    card({ title: "F", archSupport: false }),
  ];
  const repair = repairProductTurnAssembly({
    text: "All of these have arch support.",
    pool: cards,
    ctx: { sessionMemory: {} },
  });
  // Verifier strips the only sentence → text is empty.
  assert.equal(String(repair.text || "").trim(), "");
});

test("R59 — buildCodeOwnedProductListingText('', pool) produces a non-empty listing line", () => {
  // Mirrors the last-resort guard in chat.jsx after the verifier has
  // zeroed text. With no AI prose AND no requested color, it must
  // fall through to the neutral listing templates (NOT return text:'').
  const cards = [
    card({ title: "A" }),
    card({ title: "B" }),
    card({ title: "C" }),
  ];
  const out = buildCodeOwnedProductListingText({
    text: "",
    cards,
    ctx: { sessionMemory: {} },
    recommenderInvoked: false,
  });
  assert.ok(out.text && out.text.trim().length > 0,
    `expected non-empty listing line; got text="${out.text}" reason=${out.reason}`);
  assert.equal(out.changed, true);
});

// ---------------------------------------------------------------------------
// Canonical ProductClaimFacts builder — single source of truth for the
// verifier-side per-card facts. Every emit path funnels through this.
// ---------------------------------------------------------------------------

const aetrexShop = { shop: "aetrex.myshopify.com" };

// Helper: a Shopify-shaped product fixture as it would arrive on
// search_products / get_product_details / find_similar_products /
// recommender. lookup_sku uses different keys — see lookupSkuToCanonical.
const product = ({
  title = "Maui Charcoal",
  handle = "maui-charcoal",
  productType = "Sandals",
  description = "Aetrex Maui women's sandals with Built-In Arch Support.",
  descriptionSnippet = "",
  tags = ["Bunions", "Plantar Fasciitis"],
  attributes = {
    category: "Sandals",
    gender: "Women",
    activity: ["Walking", "Beach"],
    footbed: "Memory Foam",
    badge: "Best Seller",
  },
  price = "129.95",
  compareAtPrice = null,
} = {}) => ({
  title, handle, productType, description, descriptionSnippet,
  tags, attributes, price, compareAtPrice,
});

test("R60 — buildProductClaimFacts returns value+source+evidence per fact", () => {
  const facts = buildProductClaimFacts(product(), aetrexShop);
  assert.deepEqual(facts.conditionTags.value.sort(), ["bunions", "plantar_fasciitis"]);
  assert.equal(facts.conditionTags.source, "merchant_tags");
  assert.deepEqual(facts.useCaseTags.value.sort(), ["beach", "walking"]);
  assert.equal(facts.useCaseTags.source, "activity_attribute");
  assert.equal(facts.archSupport.value, true);
  assert.equal(facts.archSupport.source, "title_description_scan");
  assert.equal(facts.footbed.value, "memory foam");
  assert.equal(facts.footbed.source, "attribute:footbed");
  assert.equal(facts.badge.value, "best seller");
  assert.equal(facts.category.value, "sandals");
});

test("R61 — Aetrex brand rule: footwear category proves archSupport when description omits it", () => {
  // Card with NO "arch support" in description and NO footbed attribute —
  // legacy logic would mark _archSupport=false. Brand rule (Aetrex shop +
  // footwear category) must promote it to true.
  const p = product({
    description: "Comfortable sandal with cushioned sole.",
    attributes: { category: "Sandals", gender: "Women", activity: ["Walking"] },
  });
  const facts = buildProductClaimFacts(p, aetrexShop);
  assert.equal(facts.archSupport.value, true);
  assert.equal(facts.archSupport.source, "brand_rule_footwear_category");
  assert.equal(facts.archSupport.evidence.category, "sandals");
});

test("R62 — Aetrex brand rule: Wedges Heels category proves archSupport", () => {
  // Spec callout: "For Aetrex, footwear categories including Wedges Heels
  // should prove archSupport=true from a global/category rule".
  const p = product({
    title: "Aetrex Finley Heels",
    handle: "finley",
    description: "Stylish wedge heel.",
    productType: "Wedges Heels",
    attributes: { category: "Wedges Heels", gender: "Women" },
  });
  const facts = buildProductClaimFacts(p, aetrexShop);
  assert.equal(facts.archSupport.value, true);
  assert.equal(facts.archSupport.source, "brand_rule_footwear_category");
  assert.equal(facts.archSupport.evidence.category, "wedges-heels");
});

test("R63 — non-Aetrex shop: brand rule does NOT fire (no inheritance)", () => {
  // Spec: brand rule must be opt-in per shop. A non-Aetrex shop's
  // sandal with no description proof must NOT be promoted to archSupport=true.
  const p = product({
    description: "Comfortable sandal.",
    attributes: { category: "Sandals", gender: "Women" },
  });
  const facts = buildProductClaimFacts(p, { shop: "other-brand.myshopify.com" });
  assert.equal(facts.archSupport.value, false);
  assert.equal(facts.archSupport.source, "none");
});

test("R64 — orthotics category does NOT inherit footwear brand archSupport", () => {
  // The product IS an orthotic insole — not a shoe. Brand rule excludes it.
  const p = product({
    title: "L1 Orthotic",
    handle: "l1-orthotic",
    description: "Premium orthotic insole.",
    productType: "Orthotics",
    attributes: { category: "Orthotics" },
  });
  const facts = buildProductClaimFacts(p, aetrexShop);
  assert.equal(facts.archSupport.value, false);
  assert.equal(facts.archSupport.source, "brand_rule_non_footwear_category");
});

test("R65 — helps_with attribute contributes condition tags alongside tags array", () => {
  const p = product({
    tags: ["Bunions"],
    attributes: {
      category: "Sandals",
      gender: "Women",
      helps_with: ["Plantar Fasciitis", "Heel Pain"],
    },
  });
  const facts = buildProductClaimFacts(p, aetrexShop);
  assert.ok(facts.conditionTags.value.includes("bunions"));
  assert.ok(facts.conditionTags.value.includes("plantar_fasciitis"));
  assert.ok(facts.conditionTags.value.includes("heel_pain"));
  assert.equal(facts.conditionTags.source, "merchant_tags+helps_with");
});

// ---------------------------------------------------------------------------
// Path parity — same product through every emit path produces identical facts.
// The original bug class: lookup_sku and recommender paths used different
// shapes than search_products, so the verifier saw inconsistent fact bags
// for the same product. This test locks in the invariant.
// ---------------------------------------------------------------------------

test("R66 — path parity: shape adapters produce identical canonical input across paths", () => {
  // The actual invariant: same product, regardless of which tool
  // result shape it arrived in, must produce identical claim facts.
  // We assert this at the adapter level (no chat-tools.server.js
  // import — that pulls prisma transitively which isn't available
  // in an offline node script). Each adapter projects its shape
  // onto the canonical product, and buildProductClaimFacts then
  // produces the verifier fact bag. If the adapters drift, this
  // test catches it before the verifier's missing-proof log does.
  const shared = product({
    title: "Maui Charcoal",
    handle: "maui-charcoal-am1234",
    description: "Aetrex Maui sandal with Built-In Arch Support.",
    tags: ["Bunions"],
    attributes: {
      category: "Sandals",
      gender: "Women",
      activity: ["Walking", "Beach"],
      footbed: "Memory Foam",
    },
    price: "129.95",
    compareAtPrice: null,
  });

  // search_products / find_similar_products / get_product_details
  // arrive in the canonical shape directly.
  const searchCanonical = shared;
  // find_similar_products differs only in that descriptionSnippet
  // is forced to "" at the card emit layer — mirror that here.
  const similarCanonical = { ...shared, descriptionSnippet: "" };
  // get_product_details is the canonical shape too.
  const detailsCanonical = shared;
  // lookup_sku is non-canonical → adapted.
  const lookupCanonical = lookupSkuToCanonical({
    productHandle: shared.handle,
    productTitle: shared.title,
    productType: shared.productType,
    productDescription: shared.description,
    productTags: shared.tags,
    productAttributes: shared.attributes,
    price: shared.price,
    compareAtPrice: shared.compareAtPrice,
  });
  // recommender result shape → adapted.
  const recoCanonical = recommenderProductToCanonical(shared);

  const ctx = { shop: "aetrex.myshopify.com" };
  const paths = {
    search:  attachClaimFactsToCard(searchCanonical,  ctx),
    similar: attachClaimFactsToCard(similarCanonical, ctx),
    details: attachClaimFactsToCard(detailsCanonical, ctx),
    lookup:  attachClaimFactsToCard(lookupCanonical,  ctx),
    reco:    attachClaimFactsToCard(recoCanonical,    ctx),
  };
  const pick = (c) => ({
    _conditionTags: [...(c._conditionTags || [])].sort(),
    _useCaseTags: [...(c._useCaseTags || [])].sort(),
    _onSale: c._onSale,
    _removableInsole: c._removableInsole,
    _archSupport: c._archSupport,
    _waterFriendly: c._waterFriendly,
    _footbed: c._footbed,
    _badge: c._badge,
    _productLine: c._productLine,
  });
  const ref = pick(paths.search);
  for (const [name, c] of Object.entries(paths)) {
    assert.deepEqual(pick(c), ref, `path ${name} diverges from search fact bag`);
  }
  // Sanity: every path got the brand-rule-driven archSupport=true
  // even when the canonical shape's description was sparse.
  assert.equal(ref._archSupport, true);
});

test("R67 — recommender adapter carries claim facts (previously missing entirely)", () => {
  const canonical = recommenderProductToCanonical(product({
    description: "Aetrex Maui sandal with Built-In Arch Support.",
  }));
  const card = attachClaimFactsToCard(canonical, { shop: "aetrex.myshopify.com" });
  assert.ok(card._claimFacts, "recommender adapter must produce _claimFacts");
  assert.equal(card._archSupport, true);
  assert.ok(Array.isArray(card._conditionTags));
});

test("R68 — lookupSkuToCanonical adapter shape lines up with builder expectations", () => {
  const lookupEntry = {
    productHandle: "maui",
    productTitle: "Maui",
    productType: "Sandals",
    productDescription: "Aetrex Maui sandal.",
    productTags: ["Bunions"],
    productAttributes: { category: "Sandals", activity: ["Walking"] },
    price: "100.00",
    compareAtPrice: "150.00",
  };
  const canonical = lookupSkuToCanonical(lookupEntry);
  assert.equal(canonical.title, "Maui");
  assert.equal(canonical.handle, "maui");
  assert.equal(canonical.description, "Aetrex Maui sandal.");
  assert.deepEqual(canonical.tags, ["Bunions"]);
  assert.deepEqual(canonical.attributes, lookupEntry.productAttributes);
  const facts = buildProductClaimFacts(canonical, aetrexShop);
  assert.deepEqual(facts.conditionTags.value, ["bunions"]);
  assert.equal(facts.onSale.value, true);
});

test("R69 — recommenderProductToCanonical adapter preserves shape", () => {
  const p = product();
  const canonical = recommenderProductToCanonical(p);
  // Identity-ish: the recommender shape IS already canonical, so the
  // adapter just normalizes optional fields.
  assert.equal(canonical.title, p.title);
  assert.equal(canonical.handle, p.handle);
  assert.deepEqual(canonical.tags, p.tags);
  assert.deepEqual(canonical.attributes, p.attributes);
});

test("R70 — attachClaimFactsToCard projects facts onto legacy _field keys", () => {
  const card = attachClaimFactsToCard(product(), aetrexShop);
  assert.ok(Array.isArray(card._conditionTags));
  assert.equal(typeof card._archSupport, "boolean");
  assert.ok(card._claimFacts, "must also expose the canonical fact bag");
  assert.equal(card._claimFacts.archSupport.value, card._archSupport);
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nResponse contract eval: ${passed}/${passed + failed} passed`);
