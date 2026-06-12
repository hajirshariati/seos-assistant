// Chip filter eval — exercises filterForbiddenCategoryChips +
// narrowChipAllowListForGroup. All assertions are merchant-data-
// driven: tests supply synthetic merchantGroups + allow-lists,
// then assert the filter behavior matches the spec.
//
// Live 2026-06-03 failure being locked in by C1-C4:
//   AI: "What type of men's shoes are you looking for?"
//   Chips emitted: Sneakers, Sandals, Clogs, Accessories, Orthotics
//   Expected: Sneakers, Sandals, Clogs (Footwear group only)
//   filterForbiddenCategoryChips alone couldn't strip Accessories
//   and Orthotics because both ARE valid catalog categories — they
//   live in different groups. The fix narrows the allow-list to
//   the Footwear group's categories first.

import assert from "node:assert/strict";
import {
  filterCatalogScopedNavigationChips,
  filterForbiddenCategoryChips,
  narrowChipAllowListForGroup,
  looksLikeShoeTypeQuestion,
  decorateGenderNavigationChips,
} from "../app/lib/chip-filter.server.js";
import { catalogScopedNavigationQuestionVerdict } from "../app/lib/catalog-matcher.server.js";

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

console.log("Chip filter eval\n");

// Synthetic merchant config — same shape ctx.merchantGroups gets at
// runtime. The test fixture uses "Footwear" / "Orthotics" /
// "Accessories" because that's the live shape, but the test asserts
// NOTHING is hardcoded shop-side: the categories below are arbitrary
// strings the merchant uploaded.
const MERCHANT_GROUPS = [
  {
    name: "Footwear",
    categories: ["Sneakers", "Sandals", "Boots", "Clogs", "Loafers", "Oxfords", "Slip Ons", "Slippers", "Mary Janes", "Wedges Heels"],
  },
  { name: "Orthotics", categories: ["Orthotics"] },
  { name: "Accessories", categories: ["Accessories"] },
];

// Gender-scoped allow-list — what ctx.catalogCategories would be
// for men's: Aetrex stocks Sneakers, Sandals, Clogs, Accessories,
// Orthotics for men.
const MENS_ALLOW = ["Sneakers", "Sandals", "Clogs", "Accessories", "Orthotics"];

// ─── intent detection ──────────────────────────────────────────

await test("C1 — looksLikeShoeTypeQuestion detects 'what type/kind/style of shoes/footwear'", () => {
  const positive = [
    "What type of men's shoes are you looking for?",
    "What kind of shoes do you want?",
    "What style of footwear?",
    "Which type of shoes?",
    "What footwear are you looking for?",
    "Which shoes are you after?",
  ];
  for (const q of positive) {
    assert.equal(looksLikeShoeTypeQuestion(q), true, `failed positive: "${q}"`);
  }
});

await test("C2 — looksLikeShoeTypeQuestion does NOT match generic-product questions", () => {
  const negative = [
    "What type of product are you looking for?",
    "Who are these for?",
    "Are you shopping for men's or women's?",
    "Do you need an orthotic insole or footwear with arch support?",
    "What's your arch type?",
  ];
  for (const q of negative) {
    assert.equal(looksLikeShoeTypeQuestion(q), false, `false positive: "${q}"`);
  }
});

// ─── narrow allow-list to Footwear group ───────────────────────

await test("C3 — shoe-type question narrows allow-list to Footwear group categories", () => {
  const narrowed = narrowChipAllowListForGroup(
    "What type of men's shoes are you looking for?",
    MENS_ALLOW,
    MERCHANT_GROUPS,
    "Footwear",
  );
  // Accessories + Orthotics removed; remaining Footwear-group
  // categories preserved.
  assert.deepEqual(narrowed.sort(), ["Clogs", "Sandals", "Sneakers"].sort(),
    `expected Footwear-only intersection; got ${JSON.stringify(narrowed)}`);
});

await test("C4 — narrow + filterForbiddenCategoryChips strips <<Accessories>> / <<Orthotics>> from shoe-type prompt", () => {
  const text =
    "What type of men's shoes are you looking for? <<Sneakers>><<Sandals>><<Clogs>><<Accessories>><<Orthotics>>";
  // Simulate the chat.jsx flow: narrow first, then filter.
  const scopedAllow = narrowChipAllowListForGroup(text, MENS_ALLOW, MERCHANT_GROUPS, "Footwear");
  const out = filterForbiddenCategoryChips(text, scopedAllow, MENS_ALLOW);
  // Stripped should include Accessories and Orthotics.
  assert.ok(out.stripped.includes("Accessories"), `expected Accessories stripped; got ${JSON.stringify(out.stripped)}`);
  assert.ok(out.stripped.includes("Orthotics"), `expected Orthotics stripped; got ${JSON.stringify(out.stripped)}`);
  // Sneakers/Sandals/Clogs preserved.
  assert.match(out.text, /<<Sneakers>>/);
  assert.match(out.text, /<<Sandals>>/);
  assert.match(out.text, /<<Clogs>>/);
  assert.doesNotMatch(out.text, /<<Accessories>>/);
  assert.doesNotMatch(out.text, /<<Orthotics>>/);
});

// ─── inverse: orthotic / accessory intents preserved ────────────

await test("C5 — generic-product question does NOT narrow (Accessories/Orthotics still allowed)", () => {
  // When AI asks "What type of product are you looking for?" the
  // chips legitimately include all merchant categories.
  const text =
    "What type of product are you looking for? <<Sneakers>><<Sandals>><<Accessories>><<Orthotics>>";
  const scopedAllow = narrowChipAllowListForGroup(text, MENS_ALLOW, MERCHANT_GROUPS, "Footwear");
  // No-op — generic-product question doesn't trigger narrowing.
  assert.equal(scopedAllow, MENS_ALLOW);
  const out = filterForbiddenCategoryChips(text, scopedAllow, MENS_ALLOW);
  // Nothing stripped — all chips remain.
  assert.equal(out.stripped.length, 0);
  assert.match(out.text, /<<Accessories>>/);
  assert.match(out.text, /<<Orthotics>>/);
});

await test("C6 — orthotic-specific question keeps Orthotics chip", () => {
  const text =
    "Which orthotic do you need? <<L600>><<L700>><<L2200>>";
  const scopedAllow = narrowChipAllowListForGroup(text, MENS_ALLOW, MERCHANT_GROUPS, "Footwear");
  // No-op (text doesn't match shoe-question pattern).
  assert.equal(scopedAllow, MENS_ALLOW);
});

await test("C7 — Footwear group missing from merchantGroups → no-op (don't break shops without that group)", () => {
  const narrowed = narrowChipAllowListForGroup(
    "What type of shoes are you looking for?",
    MENS_ALLOW,
    [{ name: "Apparel", categories: ["Shirts", "Pants"] }],
    "Footwear",
  );
  assert.equal(narrowed, MENS_ALLOW, "missing target group must no-op");
});

await test("C8 — no merchantGroups configured → no-op (no data, no narrowing)", () => {
  const narrowed = narrowChipAllowListForGroup(
    "What type of shoes are you looking for?",
    MENS_ALLOW,
    null,
    "Footwear",
  );
  assert.equal(narrowed, MENS_ALLOW);
});

await test("C9 — Footwear group has zero overlap with current allow → no-op (better to show something)", () => {
  // Shop has Footwear group declared but the gender-scoped allow
  // (e.g. kids) doesn't include any of those categories. Returning
  // an empty allow-list would erase all chips — worse than the
  // bug we're fixing. No-op instead.
  const narrowed = narrowChipAllowListForGroup(
    "What type of shoes are you looking for?",
    ["Kids Insole"],
    MERCHANT_GROUPS,
    "Footwear",
  );
  assert.deepEqual(narrowed, ["Kids Insole"]);
});

await test("C10 — different merchant: jewelry shop with custom 'Rings' group still works", () => {
  // Proves no Aetrex hardcoding. Another shop has a 'Rings' group
  // and asks "what type of rings". Narrow works the same way.
  const groups = [
    { name: "Rings", categories: ["Engagement", "Wedding", "Fashion"] },
    { name: "Watches", categories: ["Watches"] },
  ];
  const allow = ["Engagement", "Wedding", "Fashion", "Watches"];
  const narrowed = narrowChipAllowListForGroup(
    "What kind of rings are you looking for?",
    allow,
    groups,
    "Rings",
  );
  // "rings" isn't in the SHOE_QUESTION_RE so the helper doesn't
  // narrow — correctly. This documents the explicit-shoe-scope
  // current behavior: callers extend the detector if they want
  // other groups to be narrowable.
  assert.equal(narrowed, allow);
});

await test("C11 — product-navigation chips survive only when the current catalog intersection proves them", () => {
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
  };
  const out = filterCatalogScopedNavigationChips(
    "Which styles would you like to browse? <<Men's>><<Women's>><<Kids>>",
    {
      constraints: { color: "pink" },
      facetIndex,
      allowedCategories: ["Sneakers", "Sandals"],
      catalogCategories: ["Sneakers", "Sandals", "Orthotics", "Accessories"],
    },
  );
  assert.deepEqual(out.stripped.sort(), ["Kids", "Men's"].sort());
  assert.doesNotMatch(out.text, /<<Men's>>|<<Kids>>/);
  assert.match(out.text, /<<Women's>>/);
});

await test("C12 — custom merchant categories are grounded without a code-list change", () => {
  const facetIndex = {
    categoryByGender: { tunics: ["women"], scarves: ["women"] },
    colorByGenderCategory: {
      "women:tunics": ["pink"],
      "women:scarves": ["blue"],
    },
  };
  const out = filterCatalogScopedNavigationChips(
    "Choose one: <<Tunics>><<Scarves>>",
    {
      constraints: { color: "pink", gender: "women" },
      facetIndex,
      catalogCategories: ["Tunics", "Scarves"],
    },
  );
  assert.match(out.text, /<<Tunics>>/);
  assert.doesNotMatch(out.text, /<<Scarves>>/);
  assert.deepEqual(out.stripped, ["Scarves"]);
});

await test("C13 — catalog grounding leaves clinical orthotic choices untouched", () => {
  const facetIndex = {
    categoryByGender: { orthotics: ["men", "women", "kids"] },
    colorByGenderCategory: {},
  };
  const text = "What's your arch type? <<Flat / Low>><<Medium>><<High>><<I don't know>>";
  const out = filterCatalogScopedNavigationChips(text, {
    constraints: { gender: "women", category: "orthotics" },
    facetIndex,
    allowedCategories: ["Orthotics"],
    catalogCategories: ["Orthotics"],
  });
  assert.equal(out.text, text);
  assert.deepEqual(out.stripped, []);
});

await test("C14 — exact no-match quick replies require a real catalog intersection", () => {
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["men", "women"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black", "navy"],
      "men:sandals": ["brown"],
      "women:sneakers": ["pink"],
      "women:sandals": ["pink"],
    },
  };
  const common = {
    constraints: { gender: "men", color: "pink" },
    facetIndex,
    allowedCategories: ["Sneakers", "Sandals"],
    requireProof: true,
  };

  const impossible = catalogScopedNavigationQuestionVerdict({
    ...common,
    question: "Can you show me pink sneakers instead?",
    choice: { category: "sneakers", color: "pink" },
  });
  const valid = catalogScopedNavigationQuestionVerdict({
    ...common,
    question: "Can you show me black sneakers instead?",
    choice: { category: "sneakers", color: "black" },
  });

  assert.equal(impossible.possible, false);
  assert.equal(impossible.reason, "catalog_intersection_empty");
  assert.deepEqual(impossible.effectiveConstraints, {
    gender: "men",
    color: "pink",
    category: "sneakers",
  });
  assert.equal(valid.possible, true);
  assert.equal(valid.reason, "catalog_match");
});

await test("C15 — exact no-match product navigation fails closed without catalog proof", () => {
  const out = catalogScopedNavigationQuestionVerdict({
    question: "Can you show me pink sneakers instead?",
    choice: { category: "sneakers", color: "pink" },
    constraints: { gender: "men", color: "pink" },
    facetIndex: null,
    allowedCategories: ["Sneakers", "Sandals"],
    requireProof: true,
  });
  assert.equal(out.possible, false);
  assert.equal(out.reason, "catalog_proof_required");
});

await test("C16 — suggestions cannot resurrect a resolver-proven impossible constraint", () => {
  const common = {
    constraints: { gender: "men", color: "pink" },
    impossibleConstraints: [{ field: "color", value: "pink" }],
    // Deliberately contradictory/stale proof: resolver verdict must still win.
    facetIndex: {
      categoryByGender: { sneakers: ["men"] },
      colorByGenderCategory: { "men:sneakers": ["pink", "black"] },
    },
    requireProof: true,
  };

  const repeated = catalogScopedNavigationQuestionVerdict({
    ...common,
    question: "Do you have pink sneakers?",
    choice: { category: "sneakers", color: "pink" },
  });
  const changed = catalogScopedNavigationQuestionVerdict({
    ...common,
    question: "Do you have black sneakers?",
    choice: { category: "sneakers", color: "black" },
  });

  assert.equal(repeated.possible, false);
  assert.equal(repeated.reason, "repeats_resolver_impossible_constraint");
  assert.deepEqual(repeated.impossibleConstraint, { field: "color", value: "pink" });
  assert.equal(changed.possible, true);
  assert.equal(changed.reason, "catalog_match");
});

await test("C17 — resolver impossibility does not suppress unrelated follow-up questions", () => {
  const out = catalogScopedNavigationQuestionVerdict({
    question: "Would you like help choosing a size?",
    choice: {},
    constraints: { gender: "men", color: "pink" },
    impossibleConstraints: [{ field: "color", value: "pink" }],
    facetIndex: null,
    requireProof: true,
  });

  assert.equal(out.possible, true);
  assert.equal(out.reason, "not_product_navigation");
});

await test("C18 — umbrella base scope from memory no longer strips gender chips (2026-06-12 trace)", () => {
  // Production trace: scope carried category="footwear" — the
  // merchant's umbrella CATEGORY-GROUP name, never a tuple category —
  // and both <<Men's>>/<<Women's>> chips were stripped as
  // catalog-impossible. The base value must be sanitized away; the
  // group restriction already arrives via allowedCategories.
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["men", "women"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black"],
      "women:sneakers": ["white"],
    },
  };
  const text = "Would you prefer men's or women's styles? <<Men's>><<Women's>>";
  const out = filterCatalogScopedNavigationChips(text, {
    constraints: { category: "footwear", condition: "plantar_fasciitis" },
    facetIndex,
    allowedCategories: ["Sneakers", "Sandals"],
    catalogCategories: ["Sneakers", "Sandals"],
    umbrellaCategoryTerms: ["footwear", "shoes", "shoe"],
  });
  assert.deepEqual(out.stripped, []);
  assert.match(out.text, /<<Men's>>/);
  assert.match(out.text, /<<Women's>>/);
});

// ─── context-carrying gender navigation chips ───────────────────

await test("C19 — decorateGenderNavigationChips rewrites bare gender chips with the category noun", () => {
  const out = decorateGenderNavigationChips(
    "Got it — let me help you find the right fit. Are you shopping for men's or women's?\n\n<<Men's>><<Women's>>",
    { categoryNoun: "shoes" },
  );
  assert.match(out.text, /<<Men's shoes>>/);
  assert.match(out.text, /<<Women's shoes>>/);
  assert.doesNotMatch(out.text, /<<Men's>>/);
  assert.doesNotMatch(out.text, /<<Women's>>/);
  assert.deepEqual(out.decorated.sort(), ["Men's shoes", "Women's shoes"].sort());
});

await test("C20 — decorates bare non-possessive tokens too (<<Men>>/<<women>>) into the possessive compound", () => {
  const out = decorateGenderNavigationChips(
    "Which would you like? <<Men>><<women>>",
    { categoryNoun: "sneakers" },
  );
  assert.match(out.text, /<<Men's sneakers>>/);
  assert.match(out.text, /<<Women's sneakers>>/);
});

await test("C21 — no-op without a categoryNoun", () => {
  const text = "Are you shopping for men's or women's? <<Men's>><<Women's>>";
  const out = decorateGenderNavigationChips(text, { categoryNoun: "" });
  assert.equal(out.text, text);
  assert.deepEqual(out.decorated, []);
  const out2 = decorateGenderNavigationChips(text, {});
  assert.equal(out2.text, text);
});

await test("C22 — no-op on already-compound chips and non-gender chips (gender + ONE noun, never more)", () => {
  const text = "Pick one: <<Men's shoes>><<Women's sneakers>><<Sneakers>><<Kids>>";
  const out = decorateGenderNavigationChips(text, { categoryNoun: "boots" });
  assert.equal(out.text, text, "compound and non-Men/Women chips must pass through untouched");
  assert.deepEqual(out.decorated, []);
});

await test("C23 — decorated output passes filterCatalogScopedNavigationChips with the group umbrella term", () => {
  // The compound chip is catalog-validated downstream: "shoes" is the
  // Footwear group's trigger word (umbrella term), so <<Men's shoes>> /
  // <<Women's shoes>> must survive the catalog-scoped boundary the
  // same way the 2026-06-12 umbrella fix lets bare scope values pass.
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["men", "women"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black"],
      "women:sneakers": ["white"],
    },
  };
  const decorated = decorateGenderNavigationChips(
    "Are you shopping for men's or women's? <<Men's>><<Women's>>",
    { categoryNoun: "shoes" },
  );
  const out = filterCatalogScopedNavigationChips(decorated.text, {
    constraints: { category: "footwear", condition: "plantar_fasciitis" },
    facetIndex,
    allowedCategories: ["Sneakers", "Sandals"],
    catalogCategories: ["Sneakers", "Sandals"],
    umbrellaCategoryTerms: ["footwear", "shoes", "shoe"],
  });
  assert.deepEqual(out.stripped, []);
  assert.match(out.text, /<<Men's shoes>>/);
  assert.match(out.text, /<<Women's shoes>>/);
});

await test("C24 — compound with a REAL category validates as a true conjunction (<<Men's sneakers>>)", () => {
  // When the noun is a tuple category (not an umbrella), the compound
  // must be validated as gender+category conjunction — and stripped
  // when the catalog can't prove it.
  const facetIndex = {
    categoryByGender: {
      sneakers: ["men", "women"],
      sandals: ["women"],
    },
    colorByGenderCategory: {
      "men:sneakers": ["black"],
      "women:sneakers": ["white"],
      "women:sandals": ["pink"],
    },
  };
  const decorated = decorateGenderNavigationChips(
    "Are you shopping for men's or women's? <<Men's>><<Women's>>",
    { categoryNoun: "sandals" },
  );
  const out = filterCatalogScopedNavigationChips(decorated.text, {
    constraints: {},
    facetIndex,
    allowedCategories: ["Sneakers", "Sandals"],
    catalogCategories: ["Sneakers", "Sandals"],
  });
  // Men's sandals don't exist in this catalog → stripped; Women's survive.
  assert.deepEqual(out.stripped, ["Men's sandals"]);
  assert.match(out.text, /<<Women's sandals>>/);
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
