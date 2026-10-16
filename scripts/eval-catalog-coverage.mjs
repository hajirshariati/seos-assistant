// Catalog data coverage report (admin "What the assistant can filter on").
// The red-shoe failure (2026-10-16) was invisible until a shopper hit it; this
// report must flag missing color/gender/condition data and name its source.
//
// Run: node scripts/eval-catalog-coverage.mjs

import assert from "node:assert/strict";
import { computeCatalogCoverage } from "../app/lib/catalog-coverage.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.log(`  ✗ ${name} — ${err.message}`); }
}

const conditionTagsOf = (p) => (p.tags || []).filter((t) => /plantar fasciitis|bunions|heel pain/i.test(t));
const p = (title, extra = {}) => ({ title, status: "ACTIVE", productType: "Footwear", tags: [], attributesJson: null, variants: [], ...extra });
const row = (cov, key) => cov.rows.find((r) => r.key === key);

console.log("Catalog coverage eval\n");

test("unmapped Aetrex-shaped catalog: color from titles, gender missing, conditions from tags", () => {
  const cov = computeCatalogCoverage({
    products: [
      p("Savannah Sandal - Red", { tags: ["Plantar Fasciitis"] }),
      p("Carly Sneaker - Navy", { tags: ["Bunions"] }),
      p("Women's Train Orthotics", { productType: "Orthotics", tags: ["Heel Pain"] }),
      p("Hidden Draft - Red", { status: "DRAFT" }),
    ],
    mappings: [],
    conditionTagsOf,
  });
  assert.equal(cov.total, 3, "draft products are excluded");
  assert.deepEqual(row(cov, "color").sources, { title: 2 });
  assert.equal(row(cov, "gender").covered, 1);
  assert.equal(row(cov, "gender").status, "missing");
  assert.deepEqual(row(cov, "category").sources, { productType: 3 });
  assert.equal(row(cov, "conditions").pct, 100);
  assert.ok(cov.gaps.includes("Gender"));
  // Title-only color is usable but weak — flagged partial, not ready.
  assert.equal(row(cov, "color").status, "partial");
});

test("auto-detected metafields count as strong data; mappings are attributed to the merchant", () => {
  const cov = computeCatalogCoverage({
    products: [
      p("Savannah Sandal - Red", { attributesJson: { color: "red", gender: "women", category_for_filter: "sandals", helps_with: ["plantar fasciitis"] } }),
      p("Reagan Boot - Red", { attributesJson: { color: "red", gender: "women", category_for_filter: "boots", helps_with: ["heel pain"] } }),
    ],
    mappings: [{ attribute: "gender", sourceType: "metafield", namespace: "custom", key: "g" }],
    conditionTagsOf,
  });
  assert.deepEqual(row(cov, "color").sources, { auto: 2 });
  assert.deepEqual(row(cov, "gender").sources, { mapped: 2 });
  for (const k of ["color", "gender", "category", "conditions"]) assert.equal(row(cov, k).status, "good", k);
  assert.deepEqual(cov.gaps, []);
});

test("variant Color option counts as color data", () => {
  const cov = computeCatalogCoverage({
    products: [p("Chase Sneaker", { variants: [{ optionsJson: JSON.stringify([{ name: "Color", value: "Black" }]) }] })],
  });
  assert.deepEqual(row(cov, "color").sources, { variant: 1 });
});

test("badge is optional — none set is informational, never a gap", () => {
  const cov = computeCatalogCoverage({ products: [p("Carly Sneaker - Navy")] });
  assert.equal(row(cov, "badge").status, "info");
  assert.ok(!cov.gaps.includes("Badge"));
});

test("empty catalog does not divide by zero", () => {
  const cov = computeCatalogCoverage({ products: [] });
  assert.equal(cov.total, 0);
  assert.ok(cov.rows.every((r) => r.pct === 0));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
