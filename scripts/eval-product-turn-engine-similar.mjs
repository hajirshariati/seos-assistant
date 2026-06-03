// Product Turn Engine — Phase 2 similar-product path
//
// Asserts the engine REUSES the existing find_similar_products
// handler + catalog-resolver named-anchor detector via injected
// `similarFn` and `resolveNamedProductFn`. No parallel similarity
// engine; no hardcoded "footbed" / "cushioning" / Aetrex attribute
// lists in production code.
//
// Pure offline. similarFn and resolveNamedProductFn are spies so
// each test can assert WHAT was called (handle anchor + limit)
// AND that the engine's output composes around the merchant's
// admin-configured similarMatchAttributes.

import assert from "node:assert/strict";
import {
  runProductTurn,
  detectSimilarProductIntent,
  composeSimilarAnswer,
} from "../app/lib/product-turn-engine.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Product Turn Engine — Phase 2 similar-product eval\n");

const FIXTURE_CLAIM_CONFIG = {
  rules: [
    { claim: "archSupport", ruleType: "category_group", appliesToGroup: "Footwear", excludeGroups: ["Orthotics", "Accessories"] },
  ],
  categoryGroups: [
    { name: "Footwear", categories: ["sneakers", "sandals", "boots", "loafers", "oxfords", "clogs", "slip-ons", "slippers", "mary-janes", "wedges-heels"] },
    { name: "Accessories", categories: ["accessories"] },
    { name: "Orthotics", categories: ["orthotics"] },
  ],
  colorFamilies: [],
};

// Admin-configured similarity attributes. Mirrors the production
// ShopConfig.similarMatchAttributes — currently ["footbed"], but
// tests must NOT depend on that list. Phase 2 tests pass it via
// ctx.similarMatchAttributes and verify the composer reflects it.
const ADMIN_CONFIGURED_ATTRS = ["footbed"];

const ctxBase = {
  shop: "fixture.myshopify.com",
  similarMatchAttributes: ADMIN_CONFIGURED_ATTRS,
};

// Spy factory — records the calls the engine made so the test can
// assert it reused the injected handler (not a re-implementation).
function spy(returns) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return typeof returns === "function" ? returns(...args) : returns;
  };
  fn.calls = calls;
  return fn;
}

const SIMILAR_RESULT = {
  reference: { handle: "jillian-sport-black-l8000w", title: "Jillian Sport Sandal - Black" },
  products: [
    {
      title: "Whit Sport Sandal - Champagne",
      handle: "whit-champagne-ss303w",
      productType: "Sandals",
      description: "Sport sandal with arch support.",
      tags: [],
      attributes: { category: "Sandals", gender: "Women", footbed: "Memory Foam" },
      price: "139.95",
      image: "https://cdn/whit.jpg",
      url: "https://shop/products/whit",
    },
    {
      title: "Jess Adjustable Quarter Strap Sandal - Pewter",
      handle: "jess-pewter-se206w",
      productType: "Sandals",
      description: "Adjustable sandal with arch support.",
      tags: [],
      attributes: { category: "Sandals", gender: "Women", footbed: "Memory Foam" },
      price: "149.95",
      image: "https://cdn/jess.jpg",
      url: "https://shop/products/jess",
    },
  ],
};

// ─── intent detection ──────────────────────────────────────────

await test("P2-1 — detects 'similar to Jillian' as a similar-product intent", () => {
  const intent = detectSimilarProductIntent({
    rawMessage: "show me styles similar to the Jillian",
  }, {});
  assert.ok(intent, "intent should not be null");
  assert.equal(intent.anchorInMessage, true);
  assert.equal(intent.rankingCriterion, null);
});

await test("P2-2 — detects 'same support as Danika' with anchor + no ranking criterion", () => {
  const intent = detectSimilarProductIntent({
    rawMessage: "what other shoes have the same support as Danika?",
  }, {});
  assert.ok(intent);
  assert.equal(intent.anchorInMessage, true);
  assert.equal(intent.rankingCriterion, null);
});

await test("P2-3 — detects 'most cushioning like Jillian' with ranking criterion=cushioning", () => {
  const intent = detectSimilarProductIntent({
    rawMessage: "Which of these has the most cushioning like the Jillian?",
  }, {});
  assert.ok(intent);
  assert.equal(intent.anchorInMessage, true);
  assert.equal(intent.rankingCriterion, "cushioning");
});

await test("P2-4 — 'show me sandals for plantar fasciitis' is NOT a similar-product intent", () => {
  // Standard retrieval — engine's main pipeline handles it.
  const intent = detectSimilarProductIntent({
    rawMessage: "show me sandals for plantar fasciitis",
  }, {});
  assert.equal(intent, null);
});

await test("P2-5 — 'same support' WITHOUT a named anchor inherits sessionMemory.specificProduct", () => {
  const intent = detectSimilarProductIntent(
    { rawMessage: "what other shoes have the same support?" },
    { sessionMemory: { explicit: { specificProduct: "danika-handle-123" } } },
  );
  assert.ok(intent);
  // anchorInMessage is false (no named product word). priorAnchorHandle
  // surfaces from session memory.
  assert.equal(intent.priorAnchorHandle, "danika-handle-123");
});

// ─── REUSE existing find_similar_products ───────────────────────

await test("P2-6 — engine calls similarFn (REUSES find_similar_products) with resolved anchor handle", async () => {
  const resolveSpy = spy("jillian-sport-black-l8000w");
  const similarSpy = spy(SIMILAR_RESULT);
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "show me styles similar to the Jillian Sport Sandal",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: similarSpy,
    resolveNamedProductFn: resolveSpy,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline, `engine should handle; got decline=${out.decline} rungs=${JSON.stringify(out.diagnostics?.rungs)}`);
  assert.equal(resolveSpy.calls.length, 1, "resolveNamedProductFn must be called once");
  assert.equal(similarSpy.calls.length, 1, "similarFn must be called once");
  assert.equal(similarSpy.calls[0][0].handle, "jillian-sport-black-l8000w",
    `engine must forward the resolved handle; got ${similarSpy.calls[0][0].handle}`);
  // Output is built from similarFn results, not from a parallel impl.
  assert.equal(out.products.length, 2);
  assert.equal(out.products[0].title, "Whit Sport Sandal - Champagne");
});

await test("P2-7 — engine output products preserve UI fields from similarFn (title/handle/image/url/price)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "similar to the Jillian please",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(SIMILAR_RESULT),
    resolveNamedProductFn: spy("jillian-sport-black-l8000w"),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  for (const card of out.products) {
    assert.ok(card.title, "title preserved");
    assert.ok(card.handle, "handle preserved");
    assert.ok(card.image, "image preserved");
    assert.ok(card.url, "url preserved");
    assert.ok(card.price, "price preserved");
    assert.ok(card.price_formatted, "price_formatted normalized for widget display");
    assert.ok(card._claimFacts, "_claimFacts attached");
  }
});

// ─── HONESTY about unconfigured ranking criteria ────────────────

await test("P2-8 — 'most cushioning' admits the limit when cushioning isn't in admin similarMatchAttributes", async () => {
  // ADMIN_CONFIGURED_ATTRS = ["footbed"]. The customer asked for
  // "most cushioning" — cushioning is NOT a configured attribute.
  // Composer must NOT pretend to rank; it must say so honestly.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Which of these has the most cushioning like the Jillian?",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(SIMILAR_RESULT),
    resolveNamedProductFn: spy("jillian-sport-black-l8000w"),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  // Honesty: admit the ranking limit.
  assert.match(out.answerText, /don't have catalog data to rank.*cushioning/i,
    `composer must admit ranking limit when cushioning isn't configured; got "${out.answerText}"`);
  // And it should name what IS configured so the customer can recalibrate.
  assert.match(out.answerText, /footbed/i,
    `composer should name the configured attrs; got "${out.answerText}"`);
});

await test("P2-9 — 'most footbed' does NOT trigger the caveat (footbed IS configured)", async () => {
  // "most footbed" is awkward phrasing but it's a test that the
  // composer doesn't over-fire. If the ranking token IS in the
  // configured attrs, no caveat.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Which has the best footbed like the Jillian?",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(SIMILAR_RESULT),
    resolveNamedProductFn: spy("jillian-sport-black-l8000w"),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.doesNotMatch(out.answerText, /don't have catalog data to rank/i,
    `composer should NOT add the ranking caveat when criterion is configured; got "${out.answerText}"`);
});

// ─── CONFIG / DATA gaps surface as decline ──────────────────────

await test("P2-10 — declines when admin similarMatchAttributes is empty (config missing)", async () => {
  // similarFn returns the production error shape.
  const out = await runProductTurn({
    ...ctxBase,
    similarMatchAttributes: [],
    latestUserMessage: "similar to the Jillian",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy({
      error: "Similar-product matching is not configured for this store.",
      products: [],
    }),
    resolveNamedProductFn: spy("jillian-handle"),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline, "config-missing surface must decline so the agent path can answer");
  assert.ok(
    out.diagnostics.rungs.some((r) => r.startsWith("similar:config_or_data_missing")),
    `decline rung should explain why; got ${JSON.stringify(out.diagnostics.rungs)}`,
  );
});

await test("P2-11 — declines when the named anchor can't be resolved", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "similar to the Xyzzy",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(SIMILAR_RESULT),
    resolveNamedProductFn: spy(null),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline);
  assert.ok(out.diagnostics.rungs.includes("similar:declined_no_anchor"));
});

// ─── NO Aetrex hardcoding ───────────────────────────────────────

await test("P2-12 — different merchant's similarMatchAttributes change the composer text", async () => {
  // Different shop, different admin config. Composer must reflect
  // THEIR configured attributes, not a fixed Aetrex list.
  const customAttrs = ["material", "outsole_grip"];
  const out = await runProductTurn({
    shop: "other-merchant.myshopify.com",
    similarMatchAttributes: customAttrs,
    latestUserMessage: "similar to the Jillian",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(SIMILAR_RESULT),
    resolveNamedProductFn: spy("jillian-handle"),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.match(out.answerText, /material/i, `composer should reflect merchant attrs; got "${out.answerText}"`);
  assert.match(out.answerText, /outsole_grip/i, `composer should reflect merchant attrs; got "${out.answerText}"`);
  assert.doesNotMatch(out.answerText, /footbed/i,
    `composer must not leak attrs from a different merchant; got "${out.answerText}"`);
});

// ─── composer: empty result phrasing ────────────────────────────

await test("P2-13 — empty similar-product result composes a helpful 'try widening' line", () => {
  const out = composeSimilarAnswer({
    scope: { rawMessage: "similar to the Jillian" },
    similarIntent: { rankingCriterion: null },
    anchorHandle: "jillian",
    anchorTitle: "Jillian Sport Sandal",
    families: [],
    configuredAttrs: ["footbed"],
  });
  assert.match(out.text, /couldn't find/i);
  assert.match(out.text, /Jillian Sport Sandal/i);
  assert.equal(out.reason, "similar_empty");
});

// ─── live 2026-06-03 regressions ────────────────────────────────
//
// The strict detectSpecificProduct returned null for both anchors
// because Aetrex carries multiple Jillian / multiple Danika
// products. The new findProductHandleForSimilarAnchor (permissive)
// picks ANY handle from the family — find_similar_products will
// then exclude the entire style family on the return side.

import {
  findProductHandleForSimilarAnchor,
  detectSpecificProduct,
} from "../app/lib/catalog-resolver.server.js";

const AETREX_CATALOG_FIXTURE = [
  { productHandle: "jillian-sport-black-l8000w",     title: "Jillian Sport Sandal - Black" },
  { productHandle: "jillian-antique-rose-sc443w",    title: "Jillian Braided Quarter Strap Sandal - Antique Rose" },
  { productHandle: "jillian-shimmer-blush-sc440w",   title: "Jillian Shimmer Blush" },
  { productHandle: "danika-white-ap101w",            title: "Danika Sneaker - White" },
  { productHandle: "danika-navy-ap105w",             title: "Danika Sneaker - Navy" },
  { productHandle: "maui-charcoal-l3100m",           title: "Maui Sandal - Charcoal" },
];

await test("P2-14 — live failure: 'most cushioning like the Jillian?' — strict resolver returns null", async () => {
  // detectSpecificProduct returns null because "jillian" matches 3
  // products → not unique. Lock this behavior so we don't
  // accidentally regress to a wrong-product match.
  const strict = await detectSpecificProduct(
    "fixture.myshopify.com",
    "Which of these has the most cushioning like the Jillian?",
    { _testFacts: AETREX_CATALOG_FIXTURE },
  );
  assert.equal(strict, null, "strict resolver intentionally returns null for ambiguous Jillian");
});

await test("P2-15 — live failure: 'most cushioning like the Jillian?' — permissive resolver returns a Jillian handle", async () => {
  const handle = await findProductHandleForSimilarAnchor(
    "fixture.myshopify.com",
    "Which of these has the most cushioning like the Jillian?",
    { _testFacts: AETREX_CATALOG_FIXTURE },
  );
  assert.ok(handle, "permissive resolver must return a handle, not null");
  assert.match(handle, /^jillian-/,
    `expected a Jillian-family handle; got "${handle}"`);
});

await test("P2-16 — live failure: 'what other shoes have same support as Danika' — permissive returns a Danika handle", async () => {
  const handle = await findProductHandleForSimilarAnchor(
    "fixture.myshopify.com",
    "what other shoes have same support as Danika",
    { _testFacts: AETREX_CATALOG_FIXTURE },
  );
  assert.ok(handle, "permissive resolver must return a handle, not null");
  assert.match(handle, /^danika-/,
    `expected a Danika-family handle; got "${handle}"`);
});

await test("P2-17 — permissive resolver returns null when no catalog match exists", async () => {
  const handle = await findProductHandleForSimilarAnchor(
    "fixture.myshopify.com",
    "similar to the Xyzzyzz",
    { _testFacts: AETREX_CATALOG_FIXTURE },
  );
  assert.equal(handle, null);
});

await test("P2-18 — live failure end-to-end: Jillian turn now HANDLES via permissive resolver + similarFn", async () => {
  // Simulate the dispatcher's two-stage resolver: strict → permissive.
  const resolveFn = async (message) => {
    const strict = await detectSpecificProduct(
      "fixture.myshopify.com", message,
      { _testFacts: AETREX_CATALOG_FIXTURE },
    );
    if (strict) return strict;
    return findProductHandleForSimilarAnchor(
      "fixture.myshopify.com", message,
      { _testFacts: AETREX_CATALOG_FIXTURE },
    );
  };
  const similar = spy({
    reference: { handle: "jillian-sport-black-l8000w", title: "Jillian Sport Sandal - Black" },
    products: SIMILAR_RESULT.products,
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Which of these has the most cushioning like the Jillian?",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: similar,
    resolveNamedProductFn: resolveFn,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline,
    `engine must handle Jillian similar-product turn; got rungs=${JSON.stringify(out.diagnostics?.rungs)}`);
  assert.equal(similar.calls.length, 1, "similarFn must be called once");
  assert.match(similar.calls[0][0].handle, /^jillian-/,
    `expected a Jillian handle forwarded to similarFn; got "${similar.calls[0][0].handle}"`);
  // The composer's caveat must still fire — cushioning isn't a
  // configured attribute even with the resolver working.
  assert.match(out.answerText, /don't have catalog data to rank.*cushioning/i,
    `expected ranking caveat; got "${out.answerText}"`);
});

await test("P2-19 — live failure end-to-end: Danika turn handles + returns matched sneakers", async () => {
  const resolveFn = async (message) => {
    const strict = await detectSpecificProduct(
      "fixture.myshopify.com", message,
      { _testFacts: AETREX_CATALOG_FIXTURE },
    );
    if (strict) return strict;
    return findProductHandleForSimilarAnchor(
      "fixture.myshopify.com", message,
      { _testFacts: AETREX_CATALOG_FIXTURE },
    );
  };
  // Mirror the live log:
  //   [similar] ref=danika-white-ap101w family=danika attrs=[footbed=ap] category=sneakers gender=women → 4
  const danikaSimilar = {
    reference: { handle: "danika-white-ap101w", title: "Danika Sneaker - White" },
    products: [
      {
        title: "Chase Sneaker - Navy",
        handle: "chase-navy-am206w",
        productType: "Sneakers",
        description: "Sneaker with arch support.",
        tags: [],
        attributes: { category: "Sneakers", gender: "Women", footbed: "ap" },
        price: "139.95",
        image: "https://cdn/chase.jpg",
        url: "https://shop/products/chase",
      },
    ],
  };
  const similar = spy(danikaSimilar);
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what other shoes have same support as Danika",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: similar,
    resolveNamedProductFn: resolveFn,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline,
    `engine must handle Danika similar-product turn; got rungs=${JSON.stringify(out.diagnostics?.rungs)}`);
  assert.match(similar.calls[0][0].handle, /^danika-/,
    `expected Danika handle forwarded; got "${similar.calls[0][0].handle}"`);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].title, "Chase Sneaker - Navy");
});

await test("P2-20 — CTA is derived from the ANCHOR product, never from stale session memory", async () => {
  // Live failure 4: prior turns set sessionMemory.gender=men, and
  // the auto-search CTA shipped "View All Men's Footwear" on a
  // Danika women-only result. Engine CTA must be anchor-rooted.
  const danikaSimilar = {
    reference: { handle: "danika-white-ap101w", title: "Danika Sneaker - White" },
    products: [
      {
        title: "Chase Sneaker - Navy",
        handle: "chase-navy-am206w",
        productType: "Sneakers",
        description: "Sneaker with arch support.",
        tags: [],
        attributes: { category: "Sneakers", gender: "Women", footbed: "ap" },
        price: "139.95",
        image: "https://cdn/chase.jpg",
        url: "https://shop/products/chase",
      },
    ],
  };
  const out = await runProductTurn({
    ...ctxBase,
    // STALE gender=men in session memory — engine must ignore it
    // for CTA derivation when the anchor product is women's.
    sessionMemory: { explicit: { gender: "men", category: "footwear" }, inferred: {} },
    latestUserMessage: "what other shoes have same support as Danika",
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy(danikaSimilar),
    resolveNamedProductFn: async () => "danika-white-ap101w",
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.ok(out.cta, `expected an engine CTA; got ${JSON.stringify(out.cta)}`);
  assert.equal(out.cta.gender, "women",
    `CTA gender must come from anchor product (women), not stale memory (men); got ${out.cta.gender}`);
  assert.equal(out.cta.category, "sneakers",
    `CTA category must come from anchor (sneakers), not stale (footwear); got ${out.cta.category}`);
  assert.equal(out.cta.scopeSource, "anchor_product");
  // The kind tells the dispatcher to convert via buildStorefrontSearchCTA.
  assert.equal(out.cta.kind, "storefront_search");
});

await test("P2-21 — raw similar prices are normalized to widget price_formatted", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what other shoes have same support as Danika",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy({
      reference: {
        handle: "danika-navy-ap105w",
        title: "Danika Arch Support Sneaker - Navy",
        category: "sneakers",
        gender: "women",
      },
      products: [
        {
          title: "Chase Arch Support Sneaker - Navy",
          handle: "chase-navy-ap907m",
          productType: "Sneakers",
          description: "Sneaker with arch support.",
          tags: [],
          attributes: { category: "Sneakers", gender: "Men", footbed: "ap" },
          price: "160",
          image: "https://cdn/chase.jpg",
          url: "https://shop/products/chase",
        },
      ],
    }),
    resolveNamedProductFn: async () => "danika-navy-ap105w",
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.products[0].price_formatted, "$160.00",
    `raw decimal price must display as $160.00, not $1.60; got ${out.products[0].price_formatted}`);
});

await test("P2-22 — similar CTA uses reference gender/category when cards disagree", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what other shoes have same support as Danika",
    sessionMemory: { explicit: { gender: "men", category: "footwear" }, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    similarFn: spy({
      reference: {
        handle: "danika-navy-ap105w",
        title: "Danika Arch Support Sneaker - Navy",
        category: "sneakers",
        gender: "women",
      },
      products: [
        {
          title: "Chase Arch Support Sneaker - Navy",
          handle: "chase-navy-ap907m",
          productType: "Sneakers",
          description: "Sneaker with arch support.",
          tags: [],
          attributes: { category: "Sneakers", gender: "Men", footbed: "ap" },
          price: "160",
          image: "https://cdn/chase.jpg",
          url: "https://shop/products/chase",
        },
      ],
    }),
    resolveNamedProductFn: async () => "danika-navy-ap105w",
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.cta?.gender, "women",
    `CTA must use reference gender=women over first card/stale gender; got ${out.cta?.gender}`);
  assert.equal(out.cta?.category, "sneakers",
    `CTA must use reference category=sneakers over stale category; got ${out.cta?.category}`);
});

// ──────────────────────────────────────────────────────────────
console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  process.exit(1);
}
