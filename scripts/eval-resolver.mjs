// Resolver eval suite (Milestone 1).
//
// Tests catalog-resolver.server.js against fixture catalog facets
// via dependency injection (the resolver accepts _testFacetIndex /
// _testFetchCandidates / _testFindOos params for this purpose).
// We avoid touching the DB so the suite runs in CI without setup.
//
// Covers the 7 scenarios the merchant specified plus regression
// coverage:
//   R1  navy → infer men's, no gender ask
//   R2  pink men's → impossible
//   R3  flat feet from session memory remembered
//   R4  Vania + 11W OOS → controlled_oos
//   R5  too-broad intent → ask with chip_options
//   R6  facet index missing → resolver skips
//   R7  capability check helper is correctly exported
//   R8  red sandals exist only in women's → inferred
//   R9  orange sandals → impossible + alternatives
//   R10 multi-turn narrowing
//   R11 latest explicit constraint overrides stale session memory
//   R12 no cards while asking

import assert from "node:assert/strict";
import { resolveCatalogTurn, buildResolverStatePromptBlock, extractUserConstraints } from "../app/lib/catalog-resolver.server.js";

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

// Build a fixture candidate-fetcher that filters in-memory product
// rows by the where clause shape the resolver passes.
function makeFetcher(products) {
  return async function ({ gender, category, color, condition, includeOos = false, limit = 6 }) {
    let result = products.filter((p) => {
      if (!includeOos && !p.available) return false;
      if (category && p.category !== category) return false;
      if (gender && !(p.gender || []).includes(gender)) return false;
      if (color && !(p.colors || []).includes(color)) return false;
      if (condition && !(p.conditionTags || []).includes(condition)) return false;
      return true;
    });
    if (limit) result = result.slice(0, limit);
    return result.map((p) => ({
      handle: p.handle,
      title: p.title,
      availability: p.available ? (p.totalInventory > 5 ? "in_stock" : "low_stock") : "out_of_stock",
      why_recommended: [
        ...(color && (p.colors || []).includes(color) ? [`matches ${color}`] : []),
        ...(condition && (p.conditionTags || []).includes(condition) ? [`good for ${condition.replace(/_/g, " ")}`] : []),
        p.available ? "in stock" : "out of stock",
      ],
    }));
  };
}

const SHOP = "test.myshopify.com";

console.log("Resolver eval (Milestone 1)\n");

await test("R0 — extractor maps common Spanish color words", async () => {
  assert.equal(extractUserConstraints("en color rojo?").color, "red");
  assert.equal(extractUserConstraints("tienes botas negras?").color, "black");
  assert.equal(extractUserConstraints("en azul").color, "blue");
});

await test("R0a — color attached to a garment word is NOT a footwear filter", () => {
  // Production trace: "do you have any wedge that goes well with my
  // blue dress?" → extractor grabbed color=blue from "blue dress" and
  // forced a blue-wedge search. The customer's OUTFIT color is not a
  // filter for the shoes they want.
  assert.equal(extractUserConstraints("do you have any wedge that goes well with my blue dress?").color, undefined);
  assert.equal(extractUserConstraints("shoes to match my blue dress").color, undefined);
  assert.equal(extractUserConstraints("looking for something to wear with a red gown").color, undefined);
});

await test("R0b — color directly on a footwear noun IS extracted", () => {
  assert.equal(extractUserConstraints("show me blue sandals").color, "blue");
  assert.equal(extractUserConstraints("i need pink sandals").color, "pink");
  assert.equal(extractUserConstraints("do you have jillian in red?").color, "red");
});

await test("R0c — multi-color sentence picks the footwear color, drops the garment color", () => {
  const out = extractUserConstraints("red heels for my black dress");
  assert.equal(out.color, "red", `expected footwear color red; got ${out.color}`);
});

await test("R0d — 'pink dress shoes' keeps the color because 'dress' is the occasion", () => {
  // "[color] dress [footwear]" → dress is an occasion modifier here.
  assert.equal(extractUserConstraints("pink dress shoes").color, "pink");
});

await test("R0e — rejected categories never become the positive category", () => {
  const out = extractUserConstraints("anything besides sneakers and sandals — show me boots");
  assert.equal(out.category, "boots");
});

await test("R0f — product-navigation quick reply extracts both requested color and category", () => {
  assert.deepEqual(
    extractUserConstraints("Can you show me pink sneakers instead?"),
    { category: "sneakers", color: "pink" },
  );
});

await test("R0g — broad shopping nouns become footwear umbrella scope", () => {
  assert.deepEqual(
    extractUserConstraints("i need pink shoes"),
    { category: "footwear", color: "pink" },
  );
  assert.deepEqual(
    extractUserConstraints("show me black footwear"),
    { category: "footwear", color: "black" },
  );
});

await test("R1 — navy color infers men's, gender goes in do_not_ask", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"], sandals: ["women"] },
    colorByGenderCategory: {
      "men:sneakers": ["navy", "black"],
      "women:sneakers": ["white"],
      "women:sandals": ["red", "tan"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "dash", title: "Dash Navy Sneaker", category: "sneakers", gender: ["men"], colors: ["navy"], available: true, conditionTags: [] },
  ];

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "navy sneakers",
    userConstraints: { color: "navy" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });

  assert.equal(out.type, "resolver_state");
  assert.equal(out.matched_constraints.color, "navy");
  assert.equal(out.inferred_constraints.gender?.value, "men");
  assert.ok(out.do_not_ask.includes("gender"), `do_not_ask must include gender, got ${JSON.stringify(out.do_not_ask)}`);
});

await test("R2 — pink men's request → impossible (no pink in men's)", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"] },
    colorByGenderCategory: {
      "men:sneakers": ["navy", "black"],
      "women:sneakers": ["pink", "white"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "ada", title: "Ada Pink Sneaker", category: "sneakers", gender: ["women"], colors: ["pink"], available: true, conditionTags: [] },
  ];

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "pink men's shoes",
    userConstraints: { color: "pink", gender: "men", category: "sneakers" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });

  const impColors = out.impossible_constraints.filter((c) => c.field === "color");
  assert.ok(impColors.length > 0, `expected color in impossible_constraints; got ${JSON.stringify(out.impossible_constraints)}`);
  assert.equal(out.recommended_next_action.type, "no_match");
});

await test("R3 — flat feet from session memory carries through", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"] },
    colorByGenderCategory: { "women:sneakers": ["white"] },
    conditionByCategory: { sneakers: ["flat_feet"] },
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "carly", title: "Carly Sneaker", category: "sneakers", gender: ["women"], colors: ["white"], conditionTags: ["flat_feet"], available: true, totalInventory: 8 },
  ];

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me sneakers",
    userConstraints: { gender: "women", category: "sneakers" },
    sessionMemory: { explicit: { condition: "flat_feet" } },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });

  assert.equal(out.matched_constraints.condition, "flat_feet");
  assert.ok(out.do_not_ask.includes("condition"));
  assert.equal(out.recommended_next_action.type, "recommend");
  assert.ok(out.candidate_products.length > 0);
});

await test("R4 — Vania + 11W OOS → controlled_oos", async () => {
  const facetIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: { "women:sandals": ["red", "tan"] },
    conditionByCategory: {},
    sizeByGenderCategory: { "women:sandals": ["8", "9", "10"] },
  };
  const products = [];   // no available sizes match request

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me vania in 11W",
    userConstraints: { specificProduct: "vania", gender: "women", category: "sandals", size: "11W" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
    _testFindOos: async (handle) => ({ productHandle: handle, title: "Vania Platform Sandal" }),
  });

  assert.equal(out.recommended_next_action.type, "controlled_oos");
  assert.equal(out.recommended_next_action.product_handle, "vania");
  assert.ok(out.recommended_next_action.pdp_url.includes("vania"));
});

await test("R5 — too-broad intent → ask with chip_options", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"], sandals: ["women"], boots: ["women"] },
    colorByGenderCategory: {},
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me shoes",
    userConstraints: {},
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher([]),
  });

  assert.equal(out.recommended_next_action.type, "ask");
  assert.equal(out.candidate_products.length, 0);
  assert.ok(out.recommended_next_action.chip_options.length > 0);
});

await test("R6 — facet index missing → resolver skips (graceful)", async () => {
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "tell me about aetrex",
    userConstraints: {},
    _testFacetIndex: null,
  });

  assert.equal(out.type, "skip");
  assert.equal(out.reason, "facet_index_not_built");
});

await test("R7 — capability check helper is correctly exported", async () => {
  const { isCapabilityCheckAboutPriorProducts } = await import("../app/lib/chat-helpers.server.js");
  assert.equal(isCapabilityCheckAboutPriorProducts("are they good for hiking?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("show me sneakers"), false);
});

await test("R8 — red sandals exist only in women's → infer gender", async () => {
  const facetIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: { "women:sandals": ["red", "tan"] },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "kendall", title: "Kendall Red Sandal", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
  ];

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "red sandals",
    userConstraints: { color: "red", category: "sandals" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });

  assert.equal(out.matched_constraints.color, "red");
  assert.equal(out.matched_constraints.category, "sandals");
  assert.equal(out.inferred_constraints.gender?.value, "women");
  assert.ok(out.do_not_ask.includes("gender"));
});

await test("R9 — orange sandals don't exist → impossible + alternatives", async () => {
  const facetIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: { "women:sandals": ["red", "tan", "black"] },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "kendall", title: "Kendall Sandal - Red", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
    { handle: "jillian", title: "Jillian Sandal - Tan", category: "sandals", gender: ["women"], colors: ["tan"], available: true, conditionTags: [], totalInventory: 8 },
  ];

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "orange sandals",
    userConstraints: { color: "orange", category: "sandals" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });

  const impColor = out.impossible_constraints.find((c) => c.field === "color");
  assert.ok(impColor, "expected color in impossible_constraints");
  assert.equal(out.recommended_next_action.type, "no_match");
  assert.ok(out.candidate_products.length > 0, "should still offer alternatives in the same category");
});

await test("R10 — multi-turn narrowing: do_not_ask grows monotonically", async () => {
  const facetIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: { "women:sandals": ["red"] },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "kendall", title: "Kendall Sandal", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
  ];
  const fetcher = makeFetcher(products);

  const turn1 = await resolveCatalogTurn({ shop: SHOP, query: "show me shoes", userConstraints: {}, _testFacetIndex: facetIndex, _testFetchCandidates: fetcher });
  const turn2 = await resolveCatalogTurn({ shop: SHOP, query: "sandals", userConstraints: { category: "sandals" }, _testFacetIndex: facetIndex, _testFetchCandidates: fetcher });
  const turn3 = await resolveCatalogTurn({ shop: SHOP, query: "women's", userConstraints: { category: "sandals", gender: "women" }, _testFacetIndex: facetIndex, _testFetchCandidates: fetcher });

  // turn2 must include category (turn 1 had nothing). turn3 must include category + gender.
  assert.ok(turn2.do_not_ask.includes("category"), "turn 2 should know category");
  assert.ok(turn3.do_not_ask.includes("category"), "turn 3 should still know category");
  assert.ok(turn3.do_not_ask.includes("gender"), "turn 3 should know gender (both matched and inferred)");
});

await test("R11 — explicit user constraint overrides stale session memory", async () => {
  const facetIndex = {
    categoryByGender: { clogs: ["men", "women"] },
    colorByGenderCategory: {},
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me men's clogs",
    userConstraints: { gender: "men", category: "clogs" },
    sessionMemory: { explicit: { gender: "women" } },  // stale
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher([
      { handle: "bondi", title: "Bondi Clog", category: "clogs", gender: ["men"], colors: [], available: true, conditionTags: [], totalInventory: 8 },
    ]),
  });

  assert.equal(out.matched_constraints.gender, "men");
});

await test("R12 — when action is 'ask', candidate_products is empty (no cards while asking)", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"], sandals: ["women"] },
    colorByGenderCategory: {},
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me shoes",
    userConstraints: {},
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher([]),
  });

  assert.equal(out.recommended_next_action.type, "ask");
  assert.equal(out.candidate_products.length, 0, "candidate_products MUST be empty when action is ask");
});

// Generic constraint-propagation fixture: red+sandals only exists in
// women's, but "red" alone exists in men's sneakers too. Old code
// looked at color in isolation and failed to infer gender; the
// constraint-propagation resolver must intersect the known
// constraints to compute the possible domain for gender.
const PROPAGATION_FACET_INDEX = {
  categoryByGender: { sandals: ["men", "women"], sneakers: ["men"] },
  colorByGenderCategory: {
    "men:sandals": ["black", "brown"],
    "women:sandals": ["red", "tan"],
    "men:sneakers": ["red"],
  },
  conditionByCategory: {},
  sizeByGenderCategory: {},
};

await test("R13 — propagation: red+sandals narrows to women's even when red exists in men's sneakers", async () => {
  const products = [
    { handle: "kendall", title: "Kendall Red Sandal", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
  ];
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "red sandals",
    userConstraints: { color: "red", category: "sandals" },
    _testFacetIndex: PROPAGATION_FACET_INDEX,
    _testFetchCandidates: makeFetcher(products),
  });
  assert.equal(out.matched_constraints.color, "red");
  assert.equal(out.matched_constraints.category, "sandals");
  assert.equal(
    out.inferred_constraints.gender?.value,
    "women",
    `expected gender=women inferred from {color:red, category:sandals}; got ${JSON.stringify(out.inferred_constraints)}`,
  );
  assert.ok(out.do_not_ask.includes("gender"), `do_not_ask must include gender, got ${JSON.stringify(out.do_not_ask)}`);
  assert.equal(out.recommended_next_action.type, "recommend");
});

await test("R14 — propagation: men's red sandals → impossible + no_match", async () => {
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "men's red sandals",
    userConstraints: { gender: "men", color: "red", category: "sandals" },
    _testFacetIndex: PROPAGATION_FACET_INDEX,
    _testFetchCandidates: makeFetcher([]),
  });
  const impColor = out.impossible_constraints.find((c) => c.field === "color");
  assert.ok(impColor, `expected color in impossible_constraints; got ${JSON.stringify(out.impossible_constraints)}`);
  assert.equal(out.recommended_next_action.type, "no_match");
});

await test("R15 — propagation: gender+category → does NOT over-infer when multiple colors exist", async () => {
  // women:sandals has both red and tan, so with {gender:women,
  // category:sandals} the color domain should be {red,tan} — NOT a
  // singleton. Resolver must not invent a color inference here.
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "women's sandals",
    userConstraints: { gender: "women", category: "sandals" },
    _testFacetIndex: PROPAGATION_FACET_INDEX,
    _testFetchCandidates: makeFetcher([
      { handle: "kendall", title: "Kendall Red Sandal", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
      { handle: "jillian", title: "Jillian Tan Sandal", category: "sandals", gender: ["women"], colors: ["tan"], available: true, conditionTags: [], totalInventory: 8 },
    ]),
  });
  assert.equal(out.inferred_constraints.color, undefined, `color should NOT be inferred when domain has >1 value; got ${JSON.stringify(out.inferred_constraints)}`);
});

await test("R16 — propagation: gender+color → infers category when only one category carries it", async () => {
  // men's red exists only in sneakers (men:sandals is black/brown).
  // {gender:men, color:red} should infer category=sneakers.
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "men's red",
    userConstraints: { gender: "men", color: "red" },
    _testFacetIndex: PROPAGATION_FACET_INDEX,
    _testFetchCandidates: makeFetcher([
      { handle: "dash", title: "Dash Red Sneaker", category: "sneakers", gender: ["men"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
    ]),
  });
  assert.equal(
    out.inferred_constraints.category?.value,
    "sneakers",
    `expected category=sneakers inferred from {gender:men, color:red}; got ${JSON.stringify(out.inferred_constraints)}`,
  );
  assert.ok(out.do_not_ask.includes("category"), `do_not_ask must include category, got ${JSON.stringify(out.do_not_ask)}`);
});

// ── M2 routing-correctness invariants ─────────────────────────
//
// Empty candidate_products with impossible_constraints=[] is NOT
// authoritative. The resolver must NOT emit no_match in that
// shape — instead it must ask for more attributes or, for
// orthotic-scope turns, skip and defer to the orthotic
// recommender.

await test("R17 — orthotics with no preview candidates → skip (defer to recommender), NOT no_match", async () => {
  const facetIndex = {
    categoryByGender: { orthotics: ["women", "men"] },
    colorByGenderCategory: {}, // orthotics often have no color matrix
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "how about women orthotics?",
    userConstraints: { gender: "women", category: "orthotics" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: async () => [], // empty preview
  });
  assert.notEqual(out.recommended_next_action.type, "no_match", `must NOT no_match with impossible=0; got ${JSON.stringify(out.recommended_next_action)}`);
  assert.equal(out.recommended_next_action.type, "skip");
  assert.equal(out.recommended_next_action.reason, "orthotic_recommender_owns_clinical_attrs");
  assert.equal(out.impossible_constraints.length, 0);
});

await test("R18 — non-orthotic empty preview with impossible=0 → ask, NOT no_match", async () => {
  // gender+category resolved but the facet index returned zero candidates
  // (could be facet-index lag, untracked inventory, etc.). Resolver must
  // not claim no_match in this shape.
  const facetIndex = {
    categoryByGender: { sneakers: ["women", "men"] },
    colorByGenderCategory: { "women:sneakers": ["white"] },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "show me women's sneakers",
    userConstraints: { gender: "women", category: "sneakers" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: async () => [],
  });
  assert.notEqual(out.recommended_next_action.type, "no_match", `must NOT no_match with impossible=0; got ${JSON.stringify(out.recommended_next_action)}`);
  assert.equal(out.recommended_next_action.type, "ask");
  assert.equal(out.impossible_constraints.length, 0);
});

await test("R19 — real impossibility still produces no_match (men's red sandals where impossible)", async () => {
  // men's:sandals exists but not in red. impossible_constraints
  // names color → no_match is still authoritative.
  const facetIndex = {
    categoryByGender: { sandals: ["men", "women"] },
    colorByGenderCategory: {
      "men:sandals": ["black", "brown"],
      "women:sandals": ["red", "tan"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "men's red sandals",
    userConstraints: { gender: "men", color: "red", category: "sandals" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: async () => [],
  });
  assert.equal(out.recommended_next_action.type, "no_match", `impossible color must still produce no_match`);
  assert.ok(out.impossible_constraints.length > 0, "must have impossible_constraints");
  assert.ok(out.impossible_constraints.some((c) => c.field === "color"));
});

await test("R20 — classifier-style capitalized constraints are canonicalized before facet checks", async () => {
  // Production trace: classifier emitted gender="Men" while the facet
  // index stores "men". The resolver compared them case-sensitively,
  // marked gender impossible, then gave the LLM a false no_match even
  // while candidate_products contained real men's sneakers.
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"] },
    colorByGenderCategory: {
      "men:sneakers": ["white", "black"],
      "women:sneakers": ["white"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const products = [
    { handle: "chase-white", title: "Chase Arch Support Sneaker - White", category: "sneakers", gender: ["men"], colors: ["white"], available: true, conditionTags: [] },
    { handle: "dash-white", title: "Dash Arch Support Men's Sneaker - White", category: "sneakers", gender: ["men"], colors: ["white"], available: true, conditionTags: [] },
  ];
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "in white",
    userConstraints: { gender: "Men", category: "Sneakers", color: "White" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher(products),
  });
  assert.equal(out.matched_constraints.gender, "men");
  assert.equal(out.matched_constraints.category, "sneakers");
  assert.equal(out.matched_constraints.color, "white");
  assert.equal(out.impossible_constraints.length, 0);
  assert.equal(out.recommended_next_action.type, "recommend", `must recommend, got ${JSON.stringify(out.recommended_next_action)}`);
  assert.equal(out.candidate_products.length, 2);
});

await test("R21 — pink footwear scope infers women and never offers men or kids", async () => {
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["women"],
      orthotics: ["kids"],
      accessories: ["men"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black"],
      "women:sneakers": ["pink"],
      "women:sandals": ["pink"],
      "kids:orthotics": ["pink"],
      "men:accessories": ["pink"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "i need pink shoes",
    userConstraints: extractUserConstraints("i need pink shoes"),
    allowedCategories: ["Sneakers", "Sandals"],
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher([]),
  });
  assert.equal(out.inferred_constraints.gender?.value, "women");
  assert.ok(out.do_not_ask.includes("gender"));
  assert.equal(out.recommended_next_action.type, "ask");
  assert.equal(out.recommended_next_action.field, "category");
  assert.deepEqual(out.recommended_next_action.chip_options.sort(), ["sandals", "sneakers"]);
});

await test("R22 — broad no-match alternatives stay inside the active product group", async () => {
  const seen = [];
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["men", "women"],
      orthotics: ["men", "women"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black"],
      "men:sandals": ["brown"],
      "men:orthotics": ["brown"],
      "women:sneakers": ["pink"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "i need pink shoes",
    userConstraints: { ...extractUserConstraints("i need pink shoes"), gender: "men" },
    allowedCategories: ["Sneakers", "Sandals"],
    _testFacetIndex: facetIndex,
    _testFetchCandidates: async (input) => {
      seen.push(input);
      return [{ handle: "chase-black", title: "Chase Sneaker - Black" }];
    },
  });

  assert.equal(out.recommended_next_action.type, "no_match");
  assert.deepEqual(seen[0].allowedCategories, ["Sneakers", "Sandals"]);
  assert.deepEqual(out.candidate_products.map((p) => p.handle), ["chase-black"]);
  assert.equal(out.candidate_products.some((p) => /orthotic/i.test(p.title)), false);
});

await test("buildResolverStatePromptBlock — produces non-empty block for resolver_state output", async () => {
  const facetIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: { "women:sandals": ["red"] },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };

  const out = await resolveCatalogTurn({
    shop: SHOP,
    query: "red sandals",
    userConstraints: { color: "red", category: "sandals" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: makeFetcher([
      { handle: "x", title: "X Sandal", category: "sandals", gender: ["women"], colors: ["red"], available: true, conditionTags: [], totalInventory: 8 },
    ]),
  });
  const block = buildResolverStatePromptBlock(out);
  assert.ok(block.length > 100, "block should be non-trivial");
  assert.ok(block.includes("RESOLVER STATE"), "block should contain header");
  assert.ok(block.includes("do_not_ask"), "block should include do_not_ask line");
});

await test("buildResolverStatePromptBlock — returns empty string for skip output", () => {
  const block = buildResolverStatePromptBlock({ type: "skip", reason: "facet_index_not_built" });
  assert.equal(block, "");
});

console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) {
    console.log(`  ${f.name}:`);
    console.log(`    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}
