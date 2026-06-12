import assert from "node:assert/strict";
import {
  catalogFieldOptions,
  catalogScopeHasMatches,
  catalogScopedNavigationQuestionVerdict,
  canonicalizeCatalogConstraints,
  colorExistsInCatalogScope,
  computeCatalogConstraintDomains,
  deriveCatalogMatchContract,
  productMatchesCategoryConstraint,
  readAttributeCI,
  umbrellaCategoryTermsFromGroups,
} from "../app/lib/catalog-matcher.server.js";

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

console.log("Catalog matcher eval\n");

const facetIndex = {
  categoryByGender: {
    sneakers: ["men", "women"],
    orthotics: ["men", "women", "unisex"],
    sandals: ["women"],
  },
  colorByGenderCategory: {
    "men:sneakers": ["white", "black", "navy"],
    "women:sneakers": ["white", "pink"],
    "women:sandals": ["red", "tan"],
    "unisex:orthotics": ["black"],
  },
};

test("M1 — canonicalizes mixed-case filter aliases", () => {
  const out = canonicalizeCatalogConstraints({
    Gender: "Men",
    Category: "Walking Shoes",
    Color: "Off White",
    width: "Wide",
  });
  assert.equal(out.gender, "men");
  assert.equal(out.category, "sneakers");
  assert.equal(out.color, "white");
  assert.equal(out.width, "Wide");
  assert.equal(out.Gender, undefined);
  assert.equal(out.Category, undefined);
});

test("M2 — color existence honors gender/category tuple scope", () => {
  assert.equal(colorExistsInCatalogScope("White", "Men", "Walking Shoes", facetIndex), true);
  assert.equal(colorExistsInCatalogScope("Red", "Men", "Sneakers", facetIndex), false);
  assert.equal(colorExistsInCatalogScope("Red", "Women", "Sandals", facetIndex), true);
});

test("M2b — zero color facts in scope is UNPROVEN (null), never an impossibility claim", () => {
  // A tuple only carries a color when extraction found one; a real
  // product with an untagged color contributes color:null. A scope
  // with no color data must not let the resolver assert "no <color>
  // products" (the unnamed-search half of the false-denial class).
  const colorlessIndex = {
    categoryByGender: { sandals: ["women"] },
    colorByGenderCategory: {},
  };
  assert.equal(colorExistsInCatalogScope("Pink", "Women", "Sandals", colorlessIndex), null);
  // But a scope WITH color facts still proves absence.
  assert.equal(colorExistsInCatalogScope("Red", "Men", "Sneakers", facetIndex), false);
});

test("M3 — domain inference uses the shared tuple space", () => {
  const domains = computeCatalogConstraintDomains({ color: "red", category: "sandals" }, facetIndex);
  assert.equal(domains.gender.inferred, "women");
  assert.deepEqual(domains.gender.domain, ["women"]);
});

test("M4 — case-insensitive attribute lookup accepts merchant metafield shapes", () => {
  const bag = { Color: "White", "Category For Filter": "Sneakers", Gender: "Men" };
  assert.equal(readAttributeCI(bag, "color"), "White");
  assert.equal(readAttributeCI(bag, "category"), "Sneakers");
  assert.equal(readAttributeCI(bag, "gender"), "Men");
});

test("M5 — response contract distinguishes exact, near, and true no-match", () => {
  assert.equal(
    deriveCatalogMatchContract({ products: [{ handle: "dash" }], constraints: { gender: "Men" } }).status,
    "exact_match",
  );
  assert.equal(
    deriveCatalogMatchContract({
      products: [{ handle: "dash" }],
      constraints: { gender: "Men", color: "Red" },
      relaxedFilters: { color: "red" },
    }).status,
    "near_match",
  );
  assert.equal(
    deriveCatalogMatchContract({
      constraints: { gender: "Men", color: "Red" },
      impossibleConstraints: [{ field: "color", value: "red" }],
    }).status,
    "true_no_match",
  );
});

test("M6 — category constraint rejects adjacent-category semantic matches", () => {
  assert.equal(
    productMatchesCategoryConstraint({
      title: "Danika Arch Support Sneaker - Pink",
      productType: "Footwear",
      attributes: { Category: "Sneakers" },
    }, "sandals"),
    false,
  );
  assert.equal(
    productMatchesCategoryConstraint({
      title: "Vicki Braided Thong Sandal - Blush",
      productType: "Footwear",
      attributes: { Category: "Sandals" },
    }, "sandals"),
    true,
  );
});

test("M7 — category constraint can recover from missing category attrs via title", () => {
  assert.equal(
    productMatchesCategoryConstraint({
      title: "Maui Orthotic Men's Slides",
      productType: "Footwear",
      attributes: {},
    }, "sandals"),
    true,
  );
});

test("M8 — missing color data is not proof of a requested color", () => {
  const unknownColorFacetIndex = {
    categoryByGender: { sneakers: ["men", "women"] },
    colorByGenderCategory: { "women:sneakers": ["pink"] },
  };
  assert.equal(
    catalogScopeHasMatches(unknownColorFacetIndex, { gender: "men", color: "pink" }),
    false,
  );
  assert.equal(
    catalogScopeHasMatches(unknownColorFacetIndex, { gender: "women", color: "pink" }),
    true,
  );
});

test("M9 — scoped field options project only catalog-proven choices", () => {
  const scopedFacetIndex = {
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
  };
  const allowedCategories = ["Sneakers", "Sandals"];
  assert.deepEqual(
    catalogFieldOptions(scopedFacetIndex, { color: "pink" }, "gender", { allowedCategories }),
    ["women"],
  );
  assert.equal(
    catalogScopeHasMatches(
      scopedFacetIndex,
      { gender: "kids", color: "pink" },
      { allowedCategories },
    ),
    false,
  );
});

test("M10 — adult unisex is not proof of kids availability", () => {
  const unisexFacetIndex = {
    categoryByGender: { sneakers: ["unisex"], orthotics: ["kids", "unisex"] },
    colorByGenderCategory: {
      "unisex:sneakers": ["pink"],
      "kids:orthotics": ["pink"],
      "unisex:orthotics": ["pink"],
    },
  };
  assert.equal(
    catalogScopeHasMatches(unisexFacetIndex, { gender: "kids", category: "sneakers", color: "pink" }),
    false,
  );
  assert.equal(
    catalogScopeHasMatches(unisexFacetIndex, { gender: "women", category: "sneakers", color: "pink" }),
    true,
  );
  assert.equal(
    catalogScopeHasMatches(unisexFacetIndex, { gender: "kids", category: "orthotics", color: "pink" }),
    true,
  );
});

// ── catalogScopedNavigationQuestionVerdict — base-scope sanitization ──
//
// 2026-06-12 production trace: customer "I have plantar fasciitis and
// going on a trip to Italy, what shoes do you recommend?" → memory
// carried category="footwear" — the merchant's umbrella "Footwear"
// CATEGORY-GROUP name, not a tuple category (tuples carry
// sandals/sneakers/boots/…). Every <<Men's>>/<<Women's>> chip merged
// with that base scope evaluated impossible and was stripped; the
// customer saw NO chips. Out-of-vocabulary base values must be dropped,
// not used as proof of impossibility.

const traceFacetIndex = {
  categoryByGender: {
    sneakers: ["men", "women"],
    sandals: ["men", "women"],
    boots: ["women"],
  },
  colorByGenderCategory: {
    "men:sneakers": ["black", "navy"],
    "women:sneakers": ["white", "pink"],
  },
};

test("M11 — out-of-domain base category (umbrella group name) no longer blocks gender chips", () => {
  for (const gender of ["men", "women"]) {
    const verdict = catalogScopedNavigationQuestionVerdict({
      question: gender === "men" ? "Men's" : "Women's",
      choice: { gender },
      constraints: { category: "footwear", condition: "plantar_fasciitis" },
      facetIndex: traceFacetIndex,
      allowedCategories: ["Sneakers", "Sandals", "Boots"],
    });
    assert.equal(verdict.possible, true, `${gender}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.reason, "catalog_match");
    // The umbrella value is dropped from the effective conjunction.
    assert.equal(verdict.effectiveConstraints.category, undefined);
  }

  // An IN-domain base category still constrains strictly: boots are
  // women-only here, so the Men's chip stays catalog-impossible.
  const strict = catalogScopedNavigationQuestionVerdict({
    question: "Men's",
    choice: { gender: "men" },
    constraints: { category: "boots" },
    facetIndex: traceFacetIndex,
    allowedCategories: ["Sneakers", "Sandals", "Boots"],
  });
  assert.equal(strict.possible, false);
  assert.equal(strict.reason, "catalog_intersection_empty");
});

test("M12 — facetChoice color stays strict: missing color facts never make pink look available", () => {
  // The chip's OWN facets are never sanitized — fail closed. A bucket
  // with no color data must not make "pink" look available.
  const noColorFacetIndex = {
    categoryByGender: { sneakers: ["men"] },
    colorByGenderCategory: {},
  };
  const out = catalogScopedNavigationQuestionVerdict({
    question: "Pink",
    choice: { color: "pink" },
    constraints: {},
    facetIndex: noColorFacetIndex,
  });
  assert.equal(out.possible, false);
  assert.equal(out.reason, "catalog_intersection_empty");

  // And a color the catalog DOES prove still passes under its scope.
  const proven = catalogScopedNavigationQuestionVerdict({
    question: "Pink",
    choice: { color: "pink" },
    constraints: { gender: "women" },
    facetIndex: traceFacetIndex,
  });
  assert.equal(proven.possible, true);
  assert.equal(proven.reason, "catalog_match");
});

test("M13 — umbrella facetChoice.category is dropped via merchant group terms, not failed", () => {
  const merchantGroups = [
    { name: "Footwear", categories: ["Sneakers", "Sandals"], triggers: ["shoes", "footwear"] },
    { name: "Orthotics", categories: ["Orthotics"], triggers: ["insoles"] },
  ];
  const terms = umbrellaCategoryTermsFromGroups(merchantGroups);
  assert.ok(terms.includes("footwear"));
  assert.ok(terms.includes("shoes"));
  assert.ok(terms.includes("shoe"), "light singular variant of trigger 'shoes'");

  // 2026-06-12 trace: follow-up "What's your budget for travel shoes?"
  // parsed category "shoes" — an umbrella trigger, not a tuple category.
  const common = {
    question: "What's your budget for travel shoes?",
    choice: { category: "shoes" },
    constraints: {},
    facetIndex: traceFacetIndex,
    allowedCategories: ["Sneakers", "Sandals"],
  };
  const withoutTerms = catalogScopedNavigationQuestionVerdict(common);
  assert.equal(withoutTerms.possible, false, "pre-fix shape: umbrella choice fails closed without the terms");

  const withTerms = catalogScopedNavigationQuestionVerdict({
    ...common,
    umbrellaCategoryTerms: terms,
  });
  assert.equal(withTerms.possible, true, JSON.stringify(withTerms));

  // A REAL tuple category is never treated as umbrella, even when a
  // group happens to name it: men's boots don't exist here, so the
  // verdict stays catalog-impossible.
  const real = catalogScopedNavigationQuestionVerdict({
    question: "Show me men's boots",
    choice: { category: "boots", gender: "men" },
    constraints: {},
    facetIndex: traceFacetIndex,
    allowedCategories: ["Sneakers", "Sandals", "Boots"],
    umbrellaCategoryTerms: [...terms, "boots"],
  });
  assert.equal(real.possible, false);
  assert.equal(real.reason, "catalog_intersection_empty");
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nCatalog matcher eval: ${passed}/${passed + failed} passed`);
