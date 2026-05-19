// Catalog truth eval (Phase A — Milestone 1+ hardening).
//
// Production blocker: customer asked "show me men's sneakers" then
// "in white". Store has white men's sneakers, but logs showed:
//   [router] action=no_match impossible=2
//   [search] filter-wipeout: dropping attrFilters={"gender":"Men","color":"white"}
//
// Memory pivoted correctly; the failure was the catalog-truth layer
// — extractors didn't pull "white" or "men" out of real product
// shapes, so the facet index lacked colorByGenderCategory["men:sneakers"]
// = ["white", ...], the resolver said no_match impossible, and the
// search filter wiped color=white because productAttrs["color"] was
// undefined (the merchant stored it as "Color":"White").
//
// This eval pins the extraction so the blocker can't regress.

import assert from "node:assert/strict";
import { __internals } from "../app/lib/catalog-facts.server.js";
import { resolveCatalogTurn } from "../app/lib/catalog-resolver.server.js";

const {
  normalizeColor,
  normalizeCategory,
  normalizeGender,
  extractColors,
  extractGender,
  extractCategory,
} = __internals;

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

console.log("Catalog truth eval (Phase A)\n");

// ─── normalizeColor: substring poisoning + multi-word ─────────
await test("normalizeColor — 'white' tag → white", () => {
  assert.equal(normalizeColor("white"), "white");
  assert.equal(normalizeColor("White"), "white");
  assert.equal(normalizeColor("WHITE"), "white");
});

await test("normalizeColor — 'off-white' / 'off white' → white", () => {
  assert.equal(normalizeColor("off-white"), "white");
  assert.equal(normalizeColor("off white"), "white");
  assert.equal(normalizeColor("Off-White"), "white");
});

await test("normalizeColor — does NOT match 'blackberry' as black (word-boundary)", () => {
  assert.equal(normalizeColor("blackberry"), null);
  assert.equal(normalizeColor("whiteboard"), null);
  assert.equal(normalizeColor("redwood"), null);
});

await test("normalizeColor — phrase containing color word still matches", () => {
  assert.equal(normalizeColor("white leather"), "white");
  assert.equal(normalizeColor("red suede"), "red");
});

// ─── normalizeCategory: compound categories ───────────────────
await test("normalizeCategory — 'Walking Shoes' → sneakers", () => {
  assert.equal(normalizeCategory("Walking Shoes"), "sneakers");
  assert.equal(normalizeCategory("walking shoes"), "sneakers");
  assert.equal(normalizeCategory("Walking Shoe"), "sneakers");
});

await test("normalizeCategory — 'Running Shoes' → sneakers", () => {
  assert.equal(normalizeCategory("Running Shoes"), "sneakers");
  assert.equal(normalizeCategory("Athletic Shoes"), "sneakers");
});

// ─── extractGender: attributesJson direct read ────────────────
await test("extractGender — reads attributesJson.Gender (capital G)", () => {
  const product = {
    title: "Daphne",
    description: "",
    productType: "Sneakers",
    tags: [],
    attributesJson: { Gender: "Men" },
    variants: [],
  };
  const gs = extractGender(product);
  assert.ok(gs.includes("men"), `expected gender=men from attributesJson.Gender; got ${JSON.stringify(gs)}`);
});

await test("extractGender — reads variant attributesJson.gender (lowercase, variant-level)", () => {
  const product = {
    title: "Daphne",
    description: "",
    productType: "Sneakers",
    tags: [],
    attributesJson: {},
    variants: [{ attributesJson: { gender: "men" } }],
  };
  const gs = extractGender(product);
  assert.ok(gs.includes("men"));
});

await test("extractGender — corpus fallback still works", () => {
  const product = {
    title: "Men's Daphne Sneaker",
    description: "",
    productType: "Sneakers",
    tags: ["mens"],
    variants: [],
  };
  const gs = extractGender(product);
  assert.ok(gs.includes("men"));
});

// ─── extractCategory: walking shoes → sneakers ────────────────
await test("extractCategory — productType 'Walking Shoes' → sneakers", () => {
  const product = {
    title: "Some product",
    description: "",
    productType: "Walking Shoes",
    tags: [],
    variants: [],
  };
  assert.equal(extractCategory(product), "sneakers");
});

await test("extractCategory — attributesJson.Category beats productType when set", () => {
  const product = {
    title: "Aetrex",
    description: "",
    productType: "Footwear",
    tags: [],
    attributesJson: { Category: "Sneakers" },
    variants: [],
  };
  assert.equal(extractCategory(product), "sneakers");
});

await test("extractCategory — longest synonym wins ('Walking Shoes' over 'shoes')", () => {
  const product = {
    title: "Aetrex Walking Shoes - White",
    description: "Premium walking shoes",
    productType: null,
    tags: [],
    variants: [],
  };
  assert.equal(extractCategory(product), "sneakers");
});

// ─── extractColors: multiple title patterns + attributesJson ──
await test("extractColors — title 'Daphne White' (trailing word, no hyphen) → white", () => {
  const product = {
    title: "Aetrex Daphne White",
    description: "",
    productType: "Sneakers",
    tags: [],
    variants: [],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"), `expected white; got ${JSON.stringify(cs)}`);
});

await test("extractColors — title 'White Daphne Sneaker' (leading word) → white", () => {
  const product = {
    title: "White Daphne Sneaker",
    description: "",
    productType: "Sneakers",
    tags: [],
    variants: [],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"));
});

await test("extractColors — title 'Daphne in Off-White' → white", () => {
  const product = {
    title: "Daphne in Off-White",
    description: "",
    productType: "Sneakers",
    tags: [],
    variants: [],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"));
});

await test("extractColors — attributesJson.Color (capital) → white", () => {
  const product = {
    title: "Daphne",
    description: "",
    productType: "Sneakers",
    tags: [],
    attributesJson: { Color: "White" },
    variants: [],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"));
});

await test("extractColors — variant.attributesJson.color (lowercase) → white", () => {
  const product = {
    title: "Daphne",
    description: "",
    productType: "Sneakers",
    tags: [],
    variants: [{ attributesJson: { color: "White" } }],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"));
});

await test("extractColors — variant optionsJson Color (existing path still works)", () => {
  const product = {
    title: "Daphne",
    description: "",
    productType: "Sneakers",
    tags: [],
    variants: [{ optionsJson: JSON.stringify({ Color: "White", Size: "10" }) }],
  };
  const cs = extractColors(product);
  assert.ok(cs.includes("white"));
});

await test("extractColors — title 'whiteboard' must NOT match (word-boundary)", () => {
  const product = {
    title: "Aetrex Whiteboard Holder",
    description: "",
    productType: "Accessories",
    tags: [],
    variants: [],
  };
  const cs = extractColors(product);
  assert.ok(!cs.includes("white"), `'whiteboard' must not produce color=white; got ${JSON.stringify(cs)}`);
});

// ─── End-to-end blocker regression ────────────────────────────
// A white men's sneaker product, in the shape we see in production:
// - productType "Walking Shoes" (the merchant's actual term)
// - attributesJson { Gender: "Men", Color: "White", Category: "Sneakers" }
// - variants with optionsJson Color/Size
//
// Build extractors output → simulated facet index → resolve a
// "men's white sneakers" query and assert the resolver does NOT
// return no_match.

await test("BLOCKER — white men's sneaker product extracts gender=men, category=sneakers, color=white", () => {
  const product = {
    title: "Aetrex Daphne — White",
    description: "Premium men's walking shoe with arch support",
    productType: "Walking Shoes",
    tags: ["Mens", "Sneakers", "Arch Support"],
    attributesJson: { Gender: "Men", Color: "White", Category: "Sneakers" },
    variants: [
      { optionsJson: JSON.stringify({ Color: "White", Size: "10" }), inventoryQty: 5 },
      { optionsJson: JSON.stringify({ Color: "White", Size: "10.5" }), inventoryQty: 3 },
    ],
  };
  const cs = extractColors(product);
  const gs = extractGender(product);
  const cat = extractCategory(product);
  assert.ok(cs.includes("white"), `CatalogFact.colors must include white; got ${JSON.stringify(cs)}`);
  assert.ok(gs.includes("men"), `CatalogFact.gender must include men; got ${JSON.stringify(gs)}`);
  assert.equal(cat, "sneakers", `CatalogFact.category must be sneakers; got ${cat}`);
});

await test("BLOCKER — facet index built from white men's sneaker → colorByGenderCategory['men:sneakers'] includes white", () => {
  // Simulate the facet-index aggregation step (mirrors
  // rebuildCatalogFacetIndex).
  const fact = {
    category: "sneakers",
    gender: ["men"],
    colors: ["white"],
    available: true,
  };
  const colorByGenderCategory = {};
  const cat = fact.category;
  const genders = fact.gender.length > 0 ? fact.gender : ["unisex"];
  for (const g of genders) {
    const gck = `${g}:${cat}`;
    if (fact.colors.length > 0) {
      if (!colorByGenderCategory[gck]) colorByGenderCategory[gck] = [];
      for (const c of fact.colors) {
        if (!colorByGenderCategory[gck].includes(c)) colorByGenderCategory[gck].push(c);
      }
    }
  }
  assert.deepEqual(colorByGenderCategory["men:sneakers"], ["white"]);
});

await test("BLOCKER — resolver does NOT no_match for men's white sneakers when the facet index knows about them", async () => {
  const facetIndex = {
    categoryByGender: { sneakers: ["men", "women"] },
    colorByGenderCategory: {
      "men:sneakers": ["white", "navy", "black"],
      "women:sneakers": ["white", "pink"],
    },
    conditionByCategory: {},
    sizeByGenderCategory: {},
  };
  const out = await resolveCatalogTurn({
    shop: "test.myshopify.com",
    query: "white",
    userConstraints: { gender: "men", category: "sneakers", color: "white" },
    _testFacetIndex: facetIndex,
    _testFetchCandidates: async () => [
      { handle: "daphne-white", title: "Daphne — White", availability: "in_stock", why_recommended: ["matches white"] },
    ],
  });
  assert.notEqual(out.recommended_next_action.type, "no_match", `must NOT no_match; got ${JSON.stringify(out.recommended_next_action)}`);
  assert.equal(out.recommended_next_action.type, "recommend");
  assert.equal(out.matched_constraints.color, "white");
  assert.equal(out.matched_constraints.gender, "men");
  assert.equal(out.matched_constraints.category, "sneakers");
  assert.equal(out.impossible_constraints.length, 0);
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
