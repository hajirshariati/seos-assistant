// Product comparison — every value in the table is the store's own data, the
// differences are found correctly, and nothing is filled in that isn't there.
//
// Run: node scripts/eval-compare.mjs

import assert from "node:assert/strict";
import { normalizeProduct } from "../app/lib/lean/catalog.js";
import { buildComparison, comparisonIntro, comparisonFacts, displayCase } from "../app/lib/lean/compare.js";
import { sanitizeHistory } from "../app/lib/lean/history.js";
import { extractPriorShownTitles } from "../app/lib/lean/engine.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const v = (size, width, price, qty = 5, compareAt = null) => ({ price: String(price), compareAtPrice: compareAt == null ? null : String(compareAt), inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: width }]) });
// As the sync stores them (lower-cased values, store text kept as written).
const row = (handle, title, attrs, variants, type = "Footwear") => ({ handle, title, productType: type, featuredImageUrl: `https://cdn.example/${handle}.jpg`, tags: [], description: "", attributesJson: attrs, variants });
const ROWS = [
  row("maui-black-l3000m", "Maui Flips - Black", {
    category_for_filter: "sandals", subcategory: "flip flops", gender: "men", color: "black",
    activity: ["everyday comfort", "beach"], helps_with: ["plantar fasciitis", "flat feet", "high arch"],
    rating: "4.4", review_count: "116",
    comfort: "<ul><li>Metatarsal support to help reduce ball-of-foot discomfort</li><li>Soft toe post for extra comfort</li></ul>",
    materials: "<ul><li>Water-friendly construction, so light they float</li><li>Material: Light-weight UltraSKY™ EVA</li></ul>",
    measurements: "<ul><li>Heel Height: 1.125\"</li></ul>",
  }, [v("8", "M", 54.95), v("9", "M", 54.95), v("12", "M", 54.95, 0)]),
  row("maui-army-l3400m", "Maui Flips - Army", {
    category_for_filter: "sandals", subcategory: "flip flops", gender: "men", color: "army",
    activity: ["everyday comfort", "beach"], helps_with: ["plantar fasciitis", "flat feet", "high arch"],
    rating: "4.4", review_count: "116",
    comfort: "<ul><li>Metatarsal support to help reduce ball-of-foot discomfort</li><li>Soft toe post for extra comfort</li></ul>",
    materials: "<ul><li>Water-friendly construction, so light they float</li><li>Material: Light-weight UltraSKY™ EVA</li></ul>",
    measurements: "<ul><li>Heel Height: 1.125\"</li></ul>",
  }, [v("8", "M", 54.95), v("10", "M", 54.95)]),
  row("bondi-white-l5003m", "Bondi Clogs - White", {
    category_for_filter: "clogs", gender: "men", color: "white", badge: "Aetrex.com Exclusive",
    activity: ["everyday comfort", "social", "beach"], helps_with: ["plantar fasciitis", "morton's neuroma", "flat feet"],
    rating: "{\"scale_min\":\"1.0\",\"scale_max\":\"5.0\",\"value\":\"4.1\"}", review_count: "41",
    comfort: "<ul><li>Metatarsal support to help reduce ball-of-foot discomfort</li><li>Roomy toe box</li></ul>",
    materials: "<ul><li>Water-friendly construction, so light they float</li><li>Material: Light-weight UltraSKY™ EVA</li></ul>",
    measurements: "<ul><li>Heel Height: 1.5\"</li><li>Weight: 7 oz</li></ul>",
  }, [v("7", "M", 64.95, 3, 79.95), v("11", "W", 64.95, 3, 79.95)]),
  row("plain-sock", "Plain Sock", {}, [v("M", "-", 12)], "Socks"),
];
const catalog = { products: ROWS.map((r) => normalizeProduct(r, { shop: "aetrex.myshopify.com" })) };
const cmp = buildComparison(catalog, ["maui-black-l3000m", "bondi-white-l5003m"]);
const rowOf = (c, key) => c.rows.find((r) => r.key === key);

console.log("\nthe table holds the store's data, as listed");
test("both products, with name, color, photo, link and price", () => {
  assert.equal(cmp.products.length, 2);
  assert.deepEqual(cmp.products.map((p) => p.name), ["Maui Flips", "Bondi Clogs"]);
  assert.deepEqual(cmp.products.map((p) => p.color), ["Black", "White"]);
  assert.equal(cmp.products[1].image, "https://cdn.example/bondi-white-l5003m.jpg");
  assert.match(cmp.products[0].url, /\/products\/maui-black-l3000m/);
  assert.equal(cmp.products[1].priceLabel, "$64.95");
  assert.equal(cmp.products[1].compareAtLabel, "$79.95");
});
test("price: the lower one is marked, a sale shows what it was", () => {
  const r = rowOf(cmp, "price");
  assert.equal(r.differ, true);
  assert.equal(r.best, 0);
  assert.deepEqual(r.values[1], { label: "$64.95", compareAt: "$79.95", onSale: true });
});
test("rating: read from either kind of store field, higher one marked", () => {
  const r = rowOf(cmp, "rating");
  assert.deepEqual(r.values, [{ avg: 4.4, count: 116 }, { avg: 4.1, count: 41 }]);
  assert.equal(r.best, 0);
});
test("lists: what they share, and what only one has", () => {
  const r = rowOf(cmp, "helps_with");
  assert.deepEqual(r.shared, ["Plantar Fasciitis", "Flat Feet"]);
  assert.deepEqual(r.unique, [["High Arch"], ["Morton's Neuroma"]]);
  assert.equal(r.differ, true);
  const c = rowOf(cmp, "comfort");
  assert.deepEqual(c.shared, ["Metatarsal support to help reduce ball-of-foot discomfort"]);
  assert.deepEqual(c.unique, [["Soft toe post for extra comfort"], ["Roomy toe box"]]);
});
test("store wording is kept (UltraSKY™), and an identical row isn't a difference", () => {
  const m = rowOf(cmp, "materials");
  assert.ok(m.shared.includes("Material: Light-weight UltraSKY™ EVA"));
  assert.equal(m.differ, false);
});
test("measurements become their own rows; one only a product lists shows a gap, not a value", () => {
  assert.deepEqual(rowOf(cmp, "m_heel_height").values, ["1.125\"", "1.5\""]);
  assert.deepEqual(rowOf(cmp, "m_weight").values, [null, "7 oz"]);
});
test("type, stock and highlights from the catalog", () => {
  assert.deepEqual(rowOf(cmp, "kind").values, ["Flip Flops", "Clogs"]);
  assert.deepEqual(rowOf(cmp, "sizes").values, ["8–9", "7–11"], "sold-out sizes aren't counted");
  assert.deepEqual(rowOf(cmp, "widths").values, [["M"], ["M", "W"]]);
  assert.deepEqual(rowOf(cmp, "badge").values, [null, "Aetrex.com Exclusive"]);
  assert.deepEqual(rowOf(cmp, "colors").values[0], ["Black", "Army"]);
});
test("a row nobody has data for isn't shown; nothing is invented for a bare product", () => {
  const c = buildComparison(catalog, ["plain-sock", "maui-black-l3000m"]);
  assert.equal(rowOf(c, "rating").values[0], null);
  assert.equal(rowOf(c, "rating").best, null, "can't call one higher rated when the other has no rating");
  assert.equal(rowOf(c, "helps_with").values[0].length, 0);
  assert.ok(!c.rows.some((r) => r.key === "nonexistent"));
});

console.log("\nchoosing what to compare");
test("needs two real products; three at most; unknown handles reported", () => {
  assert.ok(buildComparison(catalog, ["maui-black-l3000m"]).error);
  assert.ok(buildComparison(catalog, ["nope", "nada"]).error);
  const c = buildComparison(catalog, ["maui-black-l3000m", "bondi-white-l5003m", "maui-army-l3400m", "plain-sock", "nope"]);
  assert.equal(c.products.length, 3);
  assert.deepEqual(c.missing, ["nope"]);
  assert.ok(c.note);
  assert.ok(buildComparison(catalog, ["maui-black-l3000m", "maui-black-l3000m"]).error, "the same product twice isn't a comparison");
});
test("three products also come as pairs (first vs each other), each compared on its own", () => {
  const c = buildComparison(catalog, ["maui-black-l3000m", "bondi-white-l5003m", "maui-army-l3400m"]);
  assert.equal(c.pairs.length, 2);
  assert.deepEqual(c.pairs.map((x) => x.products.map((p) => p.handle)), [["maui-black-l3000m", "bondi-white-l5003m"], ["maui-black-l3000m", "maui-army-l3400m"]]);
  assert.equal(rowOf(c.pairs[0], "price").best, 0, "Maui is the lower price against Bondi");
  assert.equal(rowOf(c.pairs[1], "price").best, null, "same price as the Army: neither is marked");
  assert.equal(c.pairs[1].sameStyle, true);
  assert.ok(!c.pairs[0].pairs && !cmp.pairs, "pairs only for three, and not nested");
});
test("same style in two colors: said plainly, nothing but color differs", () => {
  const c = buildComparison(catalog, ["maui-black-l3000m", "maui-army-l3400m"]);
  assert.equal(c.sameStyle, true);
  assert.deepEqual(c.rows.filter((r) => r.differ).map((r) => r.key), ["sizes"]);
  assert.match(comparisonIntro(c), /^Same style, different colors: the Black and Army/);
});

console.log("\nwords around the table");
test("the intro names the products and their biggest differences", () => {
  assert.equal(comparisonIntro(cmp), "Here's the Maui Flips and Bondi Clogs side by side. They differ most in price, rating and type.");
});
test("facts for the model: every difference, with real values only", () => {
  const f = comparisonFacts(cmp);
  assert.match(f, /Price \(differs\) — Maui Flips - Black: \$54\.95 \| Bondi Clogs - White: \$64\.95 \(was \$79\.95\)/);
  assert.match(f, /Helps with \(differs\) — shared: Plantar Fasciitis, Flat Feet \| Maui Flips - Black: only this one: High Arch/);
  assert.match(f, /Weight \(differs\) — Maui Flips - Black: not listed \| Bondi Clogs - White: 7 oz/);
  assert.ok(f.indexOf("(differs)") < f.indexOf("(same)"), "differences first");
});
test("labels read naturally", () => {
  assert.equal(displayCase("morton's neuroma"), "Morton's Neuroma");
  assert.equal(displayCase("arch support for the office"), "Arch Support for the Office");
  assert.equal(displayCase("UltraSKY™ EVA"), "UltraSKY™ EVA");
});

console.log("\nthe conversation remembers what was compared");
test("compared products count as shown for follow-ups", () => {
  const h = sanitizeHistory([
    { role: "user", content: "compare maui and bondi" },
    { role: "assistant", content: "The Maui is lighter on price.", compared: [{ title: "Maui Flips - Black", price: "$54.95" }, { title: "Bondi Clogs - White [x]; y", price: "$64.95" }] },
  ]);
  assert.match(h[1].content, /\[Products compared side by side with this reply: Maui Flips - Black \(\$54\.95\); Bondi Clogs - White x y \(\$64\.95\)\]/);
  assert.deepEqual(extractPriorShownTitles(h), ["Maui Flips - Black ($54.95)", "Bondi Clogs - White x y ($64.95)"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
