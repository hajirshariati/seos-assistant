// Product attributes picker — the store's metafield definitions become a
// simple "Add" list. Fixture is a slice of the live Aetrex definitions.
//
// Run: node scripts/eval-metafield-picker.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
global.prismaGlobal = {};

const { buildMetafieldChoices, suggestAttributeName, slugAttribute } = await import("../app/lib/metafield-picker.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.log(`  ✗ ${name} — ${err.message}`); }
}

const d = (name, namespace, key, type, metafieldsCount, extra = {}) => ({ name, namespace, key, type: { name: type }, metafieldsCount, description: "", ...extra });
const DEFS = [
  d("Gender Filter", "custom", "gender_text", "single_line_text_field", 959),
  d("Color Family", "custom", "attr_color_family", "single_line_text_field", 797),
  d("Footbed", "custom", "footbed", "single_line_text_field", 742),
  d("Heel Height", "custom", "attr_heel_height", "multi_line_text_field", 0),
  d("Materials", "custom", "materials_details", "multi_line_text_field", 874),
  d("PIMID", "custom", "pimid", "single_line_text_field", 959),
  d("Avalara Tax Code", "avalara", "taxcode", "single_line_text_field", 963),
  d("Related products", "shopify--discovery--product_recommendation", "related_products", "list.product_reference", 3),
  d("Product Reference", "custom", "product_reference", "list.product_reference", 809),
  d("Activity & Shoe Type", "custom", "attr_activity_shoe_type", "list.metaobject_reference", 943),
  d("Width", "custom", "width", "single_line_text_field", 120, { target: "variant" }),
  d("Fabric", "custom", "fabric", "single_line_text_field", 300),
];

console.log("\nmetafield picker");

test("auto-detected fields show as 'used automatically'", () => {
  const rows = buildMetafieldChoices({ definitions: DEFS, mappings: [] });
  const gender = rows.find((r) => r.key === "gender_text");
  assert.equal(gender.status, "automatic");
  assert.equal(gender.attribute, "gender");
  assert.equal(gender.group, "in_use");
});

test("useful filled-in fields are recommended with a friendly name", () => {
  const rows = buildMetafieldChoices({ definitions: DEFS, mappings: [] });
  const footbed = rows.find((r) => r.key === "footbed");
  assert.equal(footbed.group, "recommended");
  assert.equal(footbed.attribute, "footbed");
  const width = rows.find((r) => r.key === "width");
  assert.equal(width.target, "variant");
  assert.equal(width.group, "recommended");
});

test("noise is hidden or tucked away: empty, app, link and internal-ID fields; long text is recommended", () => {
  const rows = buildMetafieldChoices({ definitions: DEFS, mappings: [] });
  const by = (k) => rows.find((r) => r.key === k);
  assert.equal(by("attr_heel_height").group, "hidden", "empty everywhere");
  assert.equal(by("taxcode").group, "hidden", "app namespace");
  assert.equal(by("related_products").group, "hidden");
  assert.equal(by("product_reference").group, "hidden", "links to other records");
  assert.equal(by("pimid").group, "other", "internal id");
  assert.equal(by("materials_details").group, "recommended", "long text — only read for one product, so it costs no speed");
  assert.equal(by("materials_details").attribute, "materials");
});

test("already-added fields show as added with their name; recommended list sorted by usage", () => {
  const rows = buildMetafieldChoices({
    definitions: DEFS,
    mappings: [{ attribute: "footbed", sourceType: "metafield", namespace: "custom", key: "footbed", target: "product" }],
  });
  const footbed = rows.find((r) => r.key === "footbed");
  assert.equal(footbed.status, "added");
  assert.equal(footbed.group, "in_use");
  const rec = rows.filter((r) => r.group === "recommended").map((r) => r.count);
  assert.deepEqual(rec, [...rec].sort((a, b) => b - a));
});

test("suggested names never collide with names already in use", () => {
  const taken = new Set(["color", "fabric"]);
  assert.equal(suggestAttributeName({ key: "fabric", name: "Upper Fabric" }, taken), "upper_fabric");
  assert.equal(suggestAttributeName({ key: "colour", name: "Colour" }, new Set(["color", "colour"])), "color_2");
  assert.equal(slugAttribute("attr_activity_shoe_type_for_filter"), "activity_shoe_type");
  assert.equal(suggestAttributeName({ key: "attr_activity_shoe_type_for_filter" }, new Set()), "activity");
});

// The live Aetrex product fields (Oct 2026).
const AETREX = [
  ["Product Highlights", "product", "features", "list.metaobject_reference", 955],
  ["Details Icons", "product", "details_icons", "list.metaobject_reference", 955],
  ["Recommended For Filter", "product", "reccomended_for", "list.single_line_text_field", 944],
  ["Product rating count", "reviews", "rating_count", "number_integer", 896],
  ["Category", "custom", "attr_category", "list.metaobject_reference", 961],
  ["PIMID", "custom", "pimid", "single_line_text_field", 959],
  ["Product rating", "reviews", "rating", "rating", 893],
  ["Activity & Shoe Type", "custom", "attr_activity_shoe_type", "list.metaobject_reference", 943],
  ["Activity & Shoe Type For Filter", "custom", "attr_activity_shoe_type_for_filter", "list.single_line_text_field", 944],
  ["Gender Filter", "custom", "gender_text", "single_line_text_field", 959],
  ["Category For Filter", "custom", "category_for_filter", "single_line_text_field", 961],
  ["Gender", "custom", "attr_gender", "list.metaobject_reference", 961],
  ["Yotpo Gallery ID", "product", "yotpo_gallery_id", "single_line_text_field", 253],
  ["Color Family", "custom", "attr_color_family", "single_line_text_field", 797],
  ["Color", "custom", "color", "single_line_text_field", 805],
  ["Avalara Tax Code", "avalara", "taxcode", "single_line_text_field", 963],
  ["Badge", "custom", "badge", "single_line_text_field", 504],
  ["subcategory", "custom", "subcategory", "single_line_text_field", 368],
  ["Short Description", "custom", "short_description", "multi_line_text_field", 899],
  ["Care Instructions", "custom", "care_instructions", "single_line_text_field", 893],
  ["Comfort", "custom", "comfort_details", "multi_line_text_field", 876],
  ["Materials", "custom", "materials_details", "multi_line_text_field", 874],
  ["Measurements", "custom", "measurements_details", "multi_line_text_field", 864],
  ["Primary Category", "custom", "primary_category", "collection_reference", 885],
  ["frontrow", "custom", "frontrow", "single_line_text_field", 549],
  ["Footbed", "custom", "footbed", "single_line_text_field", 742],
  ["UGC Gallery ID", "custom", "galleryid", "single_line_text_field", 710],
].map(([n, ns, k, t, c]) => d(n, ns, k, t, c));

test("Aetrex: 'Add all recommended' takes the customer-facing fields, never twins or plumbing", () => {
  const rows = buildMetafieldChoices({ definitions: AETREX, mappings: [] });
  const rec = rows.filter((r) => r.group === "recommended").map((r) => r.key).sort();
  assert.deepEqual(rec, [
    "attr_category", "care_instructions", "comfort_details", "details_icons", "features", "footbed",
    "materials_details", "measurements_details", "rating", "rating_count", "short_description",
  ].sort().filter((k) => k !== "attr_category"));
  const by = (k) => rows.find((r) => r.key === k);
  assert.equal(by("attr_activity_shoe_type").group, "other", "twin of the _for_filter field read automatically");
  assert.match(by("attr_activity_shoe_type").why, /Same information/);
  assert.equal(by("attr_gender").group, "other", "twin of gender_text");
  assert.equal(by("attr_category").group, "other", "twin of category_for_filter");
  for (const k of ["pimid", "galleryid", "yotpo_gallery_id", "frontrow"]) assert.notEqual(by(k).group, "recommended", k);
  for (const k of ["taxcode", "primary_category"]) assert.equal(by(k).group, "hidden", k);
});

test("suggested names are unique, so adding several fields at once never overwrites one", () => {
  const rows = buildMetafieldChoices({ definitions: AETREX, mappings: [] }).filter((r) => r.status === "available" && r.group !== "hidden");
  const names = rows.map((r) => r.attribute);
  assert.equal(new Set(names).size, names.length, names.join(","));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
