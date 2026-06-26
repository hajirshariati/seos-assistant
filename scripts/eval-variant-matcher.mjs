// Variant-matcher eval (Phase B continuation).
//
// Pins variant-level canonicalization so size/width/inventory truth
// stays consistent across search, getProductDetails, fit-predictor,
// and any future consumer.

import assert from "node:assert/strict";
import {
  canonicalizeVariantConstraints,
  normalizeVariantSize,
  normalizeVariantWidth,
  variantSatisfiesScope,
  findVariantSatisfying,
  inStockSizes,
  inStockWidths,
  variantInventoryStatus,
  isSizeAvailable,
} from "../app/lib/variant-matcher.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); failures.push({ name, err }); failed++; }
}

const v = (overrides = {}) => ({
  sku: overrides.sku ?? null,
  optionsJson: JSON.stringify(overrides.options ?? {}),
  inventoryQty: overrides.inventoryQty,
});

console.log("Variant-matcher eval (Phase B)\n");

// ── normalizeVariantSize ──────────────────────────────────────
await test("normalizeVariantSize — plain integers/decimals pass through", () => {
  assert.equal(normalizeVariantSize("9"), "9");
  assert.equal(normalizeVariantSize("9.5"), "9.5");
  assert.equal(normalizeVariantSize(10), "10");
});

await test("normalizeVariantSize — strips 'size' prefix", () => {
  assert.equal(normalizeVariantSize("Size 10"), "10");
  assert.equal(normalizeVariantSize("size 10.5"), "10.5");
});

await test("normalizeVariantSize — 11W combined → 11 (width is separate)", () => {
  assert.equal(normalizeVariantSize("11W"), "11");
  assert.equal(normalizeVariantSize("10.5N"), "10.5");
  assert.equal(normalizeVariantSize("9 M"), "9");
});

await test("normalizeVariantSize — '10.5 wide' → 10.5", () => {
  assert.equal(normalizeVariantSize("10.5 wide"), "10.5");
});

await test("normalizeVariantSize — empty / null → null", () => {
  assert.equal(normalizeVariantSize(null), null);
  assert.equal(normalizeVariantSize(""), null);
  assert.equal(normalizeVariantSize("  "), null);
});

// ── normalizeVariantWidth ─────────────────────────────────────
await test("normalizeVariantWidth — wide aliases", () => {
  for (const s of ["W", "Wide", "WIDE", "Extra Wide", "XW", "wide width"]) {
    assert.equal(normalizeVariantWidth(s), "wide", `'${s}' should be wide`);
  }
});

await test("normalizeVariantWidth — narrow aliases", () => {
  for (const s of ["N", "Narrow", "Slim"]) {
    assert.equal(normalizeVariantWidth(s), "narrow", `'${s}' should be narrow`);
  }
});

await test("normalizeVariantWidth — medium aliases (incl. B for women's standard)", () => {
  for (const s of ["M", "Medium", "Regular", "Standard", "B"]) {
    assert.equal(normalizeVariantWidth(s), "medium", `'${s}' should be medium`);
  }
});

await test("normalizeVariantWidth — '11W' combined → wide", () => {
  assert.equal(normalizeVariantWidth("11W"), "wide");
  assert.equal(normalizeVariantWidth("10.5N"), "narrow");
});

await test("normalizeVariantWidth — unknown → null", () => {
  assert.equal(normalizeVariantWidth("???"), null);
  assert.equal(normalizeVariantWidth(""), null);
  assert.equal(normalizeVariantWidth(null), null);
});

// ── canonicalizeVariantConstraints ────────────────────────────
await test("canonicalize — handles Size/Width/SKU + lowercase variants", () => {
  const out = canonicalizeVariantConstraints({
    Size: "11W",
    Width: "Wide",
    SKU: "EW732W35",
  });
  assert.equal(out.size, "11");
  assert.equal(out.width, "wide");
  assert.equal(out.sku, "ew732w35");
});

await test("canonicalize — missing fields → nulls", () => {
  const out = canonicalizeVariantConstraints({});
  assert.equal(out.size, null);
  assert.equal(out.width, null);
  assert.equal(out.sku, null);
});

// ── variantInventoryStatus ────────────────────────────────────
await test("variantInventoryStatus — qty=0 → out_of_stock", () => {
  assert.equal(variantInventoryStatus({ inventoryQty: 0 }), "out_of_stock");
});

await test("variantInventoryStatus — qty=5 → in_stock", () => {
  assert.equal(variantInventoryStatus({ inventoryQty: 5 }), "in_stock");
});

await test("variantInventoryStatus — qty=null (untracked) → untracked", () => {
  assert.equal(variantInventoryStatus({ inventoryQty: null }), "untracked");
});

// ── variantSatisfiesScope ─────────────────────────────────────
await test("variantSatisfiesScope — exact size + width match", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 3 });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide" }), true);
});

await test("variantSatisfiesScope — wrong size → false", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 3 });
  assert.equal(variantSatisfiesScope(variant, { size: "10", width: "wide" }), false);
});

await test("variantSatisfiesScope — wrong width → false", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 3 });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "narrow" }), false);
});

await test("variantSatisfiesScope — OOS → false (default)", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 0 });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide" }), false);
});

await test("variantSatisfiesScope — OOS but includeOos=true → true", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 0 });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide", includeOos: true }), true);
});

await test("variantSatisfiesScope — untracked qty counts as available", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: null });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide" }), true);
});

await test("variantSatisfiesScope — variant has no Width option, scope wants wide → true (no contradiction)", () => {
  // Many catalogs only set Width on wide/narrow variants. A variant
  // without a width option must not be excluded.
  const variant = v({ options: { Size: "11" }, inventoryQty: 5 });
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide" }), true);
});

await test("variantSatisfiesScope — combined '11W' user input matches variant Size=11 Width=Wide", () => {
  const variant = v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 5 });
  assert.equal(variantSatisfiesScope(variant, { Size: "11W" }), true);
});

await test("variantSatisfiesScope — reads Size/Width from variant attributesJson when optionsJson is missing", () => {
  const variant = {
    sku: "ATTR-11W",
    inventoryQty: 2,
    attributesJson: { Size: "11", Width: "Wide" },
  };
  assert.equal(variantSatisfiesScope(variant, { size: "11", width: "wide" }), true);
});

await test("variantSatisfiesScope — SKU match works", () => {
  const variant = v({ sku: "EW732W35", options: { Size: "11" }, inventoryQty: 5 });
  assert.equal(variantSatisfiesScope(variant, { sku: "ew732w35" }), true);
  assert.equal(variantSatisfiesScope(variant, { sku: "different-sku" }), false);
});

// ── findVariantSatisfying ─────────────────────────────────────
await test("findVariantSatisfying — finds the in-stock variant", () => {
  const product = {
    variants: [
      v({ options: { Size: "9", Width: "Medium" }, inventoryQty: 0 }),
      v({ options: { Size: "10", Width: "Medium" }, inventoryQty: 3 }),
      v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 5 }),
    ],
  };
  const r = findVariantSatisfying(product, { size: "11", width: "wide" });
  assert.ok(r.found);
  assert.equal(r.reason, null);
});

await test("findVariantSatisfying — size exists but OOS → reason=out_of_stock", () => {
  const product = {
    variants: [
      v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 0 }),
    ],
  };
  const r = findVariantSatisfying(product, { size: "11", width: "wide" });
  assert.equal(r.found, null);
  assert.equal(r.reason, "out_of_stock");
});

await test("findVariantSatisfying — size simply not carried → reason=missing_variant", () => {
  const product = {
    variants: [
      v({ options: { Size: "9", Width: "Medium" }, inventoryQty: 3 }),
      v({ options: { Size: "10", Width: "Medium" }, inventoryQty: 3 }),
    ],
  };
  const r = findVariantSatisfying(product, { size: "13", width: "wide" });
  assert.equal(r.found, null);
  assert.equal(r.reason, "missing_variant");
});

// ── inStockSizes / inStockWidths ──────────────────────────────
await test("inStockSizes — returns only in-stock sizes, sorted", () => {
  const product = {
    variants: [
      v({ options: { Size: "9" }, inventoryQty: 0 }),
      v({ options: { Size: "10" }, inventoryQty: 5 }),
      v({ options: { Size: "10.5" }, inventoryQty: 2 }),
      v({ options: { Size: "11" }, inventoryQty: 0 }),
    ],
  };
  const sizes = inStockSizes(product);
  assert.deepEqual(sizes, ["10", "10.5"]);
});

await test("inStockSizes — filtered by width returns only sizes in that width", () => {
  const product = {
    variants: [
      v({ options: { Size: "10", Width: "Medium" }, inventoryQty: 5 }),
      v({ options: { Size: "10", Width: "Wide" }, inventoryQty: 3 }),
      v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 4 }),
    ],
  };
  assert.deepEqual(inStockSizes(product, { width: "wide" }), ["10", "11"]);
  assert.deepEqual(inStockSizes(product, { width: "medium" }), ["10"]);
});

await test("inStockWidths — distinct widths for a given size", () => {
  const product = {
    variants: [
      v({ options: { Size: "10", Width: "Medium" }, inventoryQty: 5 }),
      v({ options: { Size: "10", Width: "Wide" }, inventoryQty: 3 }),
      v({ options: { Size: "11", Width: "Wide" }, inventoryQty: 4 }),
    ],
  };
  const widths = inStockWidths(product, { size: "10" });
  assert.ok(widths.includes("medium") && widths.includes("wide"));
  assert.equal(widths.length, 2);
});

// ── isSizeAvailable — text-claim verifier ─────────────────────
await test("isSizeAvailable — true when size in stock", () => {
  const product = {
    variants: [v({ options: { Size: "9.5" }, inventoryQty: 4 })],
  };
  assert.equal(isSizeAvailable(product, "9.5"), true);
  assert.equal(isSizeAvailable(product, "10"), false);
});

await test("isSizeAvailable — OOS variant → false", () => {
  const product = {
    variants: [v({ options: { Size: "9.5" }, inventoryQty: 0 })],
  };
  assert.equal(isSizeAvailable(product, "9.5"), false);
});

await test("isSizeAvailable — width-filtered check", () => {
  const product = {
    variants: [
      v({ options: { Size: "9.5", Width: "Medium" }, inventoryQty: 4 }),
      v({ options: { Size: "9.5", Width: "Wide" }, inventoryQty: 0 }),
    ],
  };
  assert.equal(isSizeAvailable(product, "9.5", { width: "medium" }), true);
  assert.equal(isSizeAvailable(product, "9.5", { width: "wide" }), false);
});

// ── Shopify selectedOptions ARRAY shape (the real synced optionsJson) ──
// optionsJson = JSON.stringify(v.selectedOptions) → [{name,value}, …]. Before
// normalizeOptionBag, readVariantOption returned undefined for every real
// variant (it looped the array and produced "0"/"1" keys → size 8 = UNKNOWN).
const arrayVariant = (opts, qty) => ({ sku: "x", inventoryQty: qty, optionsJson: JSON.stringify(opts) });
const ARRAY_PRODUCT = {
  variants: [
    arrayVariant([{ name: "Color", value: "Black" }, { name: "Size", value: "8" }, { name: "Width", value: "Wide" }], 3),
    arrayVariant([{ name: "Color", value: "Black" }, { name: "Size", value: "9" }, { name: "Width", value: "Medium" }], 5),
  ],
};
await test("array shape — inStockSizes reads Size from selectedOptions array", () => {
  assert.deepEqual(inStockSizes(ARRAY_PRODUCT).sort(), ["8", "9"]);
});
await test("array shape — inStockSizes({width:wide}) filters by Width option", () => {
  assert.deepEqual(inStockSizes(ARRAY_PRODUCT, { width: "wide" }), ["8"]);
});
await test("array shape — inStockWidths({size:'8'}) → ['wide']", () => {
  assert.deepEqual(inStockWidths(ARRAY_PRODUCT, { size: "8" }), ["wide"]);
});
await test("array shape — findVariantSatisfying matches size 8 wide", () => {
  assert.ok(findVariantSatisfying(ARRAY_PRODUCT, { size: "8", width: "wide" }).found);
});
await test("array shape — isSizeAvailable size 8 wide = true, size 9 wide = false", () => {
  assert.equal(isSizeAvailable(ARRAY_PRODUCT, "8", { width: "wide" }), true);
  assert.equal(isSizeAvailable(ARRAY_PRODUCT, "9", { width: "wide" }), false);
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
