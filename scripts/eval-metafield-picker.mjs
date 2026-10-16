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

test("noise is hidden or tucked away: empty, app, link, internal-ID and long-text fields", () => {
  const rows = buildMetafieldChoices({ definitions: DEFS, mappings: [] });
  const by = (k) => rows.find((r) => r.key === k);
  assert.equal(by("attr_heel_height").group, "hidden", "empty everywhere");
  assert.equal(by("taxcode").group, "hidden", "app namespace");
  assert.equal(by("related_products").group, "hidden");
  assert.equal(by("product_reference").group, "hidden", "links to other records");
  assert.equal(by("pimid").group, "other", "internal id");
  assert.equal(by("materials_details").group, "other", "long text");
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
