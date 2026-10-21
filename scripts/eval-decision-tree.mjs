// Eval suite for Smart Recommenders.
//
// The previous decision-tree dispatcher and engine state machine
// were removed in favor of registering each enabled DecisionTree as
// a tool the LLM can call. These tests cover the only two pieces
// that matter at runtime:
//
//   1. resolveTree (deterministic SKU lookup).
//   2. recommenderToToolDef (DB row → Claude tool definition).
//
// The end-to-end "did the LLM call the tool" assertion lives in the
// existing eval-e2e.mjs scenario harness (where Anthropic is
// available); these checks are pure functions of code + seed data
// and run without any external service.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTree } from "../app/lib/decision-tree-resolver.server.js";
import { validateDecisionTree, fingerprintTree } from "../app/lib/decision-tree-schema.server.js";
import { recommenderToToolDef } from "../app/lib/recommender-tools.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"));
const tree = { id: "aetrex-orthotic", name: "Aetrex Orthotic Finder", intent: "orthotic", definition };

let pass = 0;
let fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (err) { console.log(`  ✗ ${label}\n      ${err?.message || err}`); fail++; }
}

console.log("\nschema");
check("seed validates", () => {
  const v = validateDecisionTree(definition);
  assert(v.ok, v.errors.join("; "));
});
check("fingerprint stable", () => {
  assert.equal(fingerprintTree(definition), fingerprintTree(definition));
});

console.log("\nresolver determinism");
check("3x same attributes yield same SKU", () => {
  const attrs = { gender: "Men", useCase: "dress", arch: "Medium / High Arch", posted: false, metSupport: false };
  const r1 = resolveTree(attrs, definition.resolver);
  const r2 = resolveTree(attrs, definition.resolver);
  const r3 = resolveTree(attrs, definition.resolver);
  assert.equal(r1.resolved?.masterSku, r2.resolved?.masterSku);
  assert.equal(r2.resolved?.masterSku, r3.resolved?.masterSku);
  assert(r1.resolved?.masterSku);
});

console.log("\nclinical scenarios (resolver only)");
function sku(attrs) {
  return resolveTree(attrs, definition.resolver).resolved?.masterSku;
}
check("Plantar fasciitis kit (Men) → PFKM",
  () => assert.equal(sku({ gender: "Men", useCase: "comfort", condition: "plantar_fasciitis" }), "PFKM"));
check("Heel spurs (Women) → L2460W",
  () => assert.equal(sku({ gender: "Women", useCase: "casual", condition: "heel_spurs" }), "L2460W"));
check("Cleats + ball-of-foot → L1205U (Unisex met)",
  () => assert.equal(sku({ gender: "Men", useCase: "cleats", condition: "metatarsalgia", metSupport: true }), "L1205U"));
check("Skates (any gender) → L2500X (Unisex)",
  () => assert.equal(sku({ gender: "Women", useCase: "skates" }), "L2500X"));
check("Diabetic + casual (Men) → Conform family (L20*)",
  () => assert(sku({ gender: "Men", useCase: "casual", condition: "diabetic" })?.startsWith("L20")));
check("Athletic running + flat-arch + posted (Women) → Posted Speed SKU",
  () => assert(/posted/i.test(
    resolveTree(
      { gender: "Women", useCase: "athletic_running", arch: "Flat / Low Arch", posted: true },
      definition.resolver,
    ).resolved?.title || "",
  )));
check("condition=overpronation_flat_feet (Women athletic) → derivation makes posted=true → Posted SKU", async () => {
  const { executeRecommenderTool } = await import("../app/lib/recommender-tools.server.js");
  const r = await executeRecommenderTool({
    toolName: "recommend_orthotic",
    input: { gender: "Women", useCase: "athletic_running", condition: "overpronation_flat_feet" },
    shop: null,
    trees: [tree],
  });
  assert(r.attributesUsed?.posted === true,
    `expected posted=true after derivation; got ${JSON.stringify(r.attributesUsed)}`);
  // With shop=null in the eval env, Prisma can't fetch a product so
  // executeRecommenderTool returns its missing-product error shape.
  // The masterSku + title are surfaced under r.missingProduct (or
  // r.title on the success path when running with a real shop).
  const title = r.title || r.missingProduct?.title || "";
  const sku = r.masterSku || r.missingProduct?.masterSku || "";
  assert(/posted/i.test(title),
    `expected a Posted SKU; got ${sku} (${title})`);
});
check("No matching cell falls back gracefully (uses fallback or Unisex)",
  () => assert(sku({ gender: "Men", useCase: "skates" }), "skates is Unisex-only; resolver should still return"));
// Strict Kids: a Kids customer must only get a Kids-tagged product.
// Unisex (adult unisex in this catalog) is NOT acceptable for a
// child. The gate hides the Kids chip when the merchant's
// masterIndex has no Kids items, so this strict guard rarely fires
// in the golden path.
check("Kids + cleats (no Kids SKU) returns no match — refuses Unisex",
  () => assert(sku({ gender: "Kids", useCase: "cleats" }) === undefined,
    "Kids must NOT resolve to the Unisex cleats SKU"));
check("Kids + skates (no Kids SKU) returns no match — refuses Unisex",
  () => assert(sku({ gender: "Kids", useCase: "skates" }) === undefined,
    "Kids must NOT resolve to the Unisex skates SKU"));
check("Kids + kids-useCase → Kids SKU still resolves",
  () => {
    const r = sku({ gender: "Kids", useCase: "kids" });
    assert(typeof r === "string" && r.startsWith("L17"),
      `expected a Kids L17* SKU, got ${r}`);
  });
check("Kids + ball-of-foot pain → L1705Y (Kids met support, not the no-met variant)",
  () => {
    // The customer has metatarsalgia / ball-of-foot pain. The
    // specialty filter must accept L1705Y because metSupport=true
    // even though the title says 'Metatarsal' (no 'gia').
    const r = resolveTree(
      { gender: "Kids", useCase: "kids", condition: "metatarsalgia" },
      definition.resolver,
    ).resolved;
    assert(r && r.metSupport === true,
      `expected a Kids met-support SKU; got ${r?.masterSku} (${r?.title})`);
  });

console.log("\nrecommender → tool definition");
check("recommenderToToolDef returns a Claude-shaped tool", () => {
  const td = recommenderToToolDef(tree);
  assert(td, "tool def is null");
  assert.equal(td.name, "recommend_orthotic");
  assert(td.description && td.description.length > 20, "description too short");
  assert.equal(td.input_schema.type, "object");
  assert(td.input_schema.properties && Object.keys(td.input_schema.properties).length > 0,
    "no properties discovered");
});

check("Discovered properties cover the load-bearing attributes", () => {
  const td = recommenderToToolDef(tree);
  const keys = Object.keys(td.input_schema.properties);
  for (const expected of ["gender", "useCase", "arch"]) {
    assert(keys.includes(expected), `missing ${expected}: got ${keys.join(",")}`);
  }
});

check("Small attribute value sets become typed enums", () => {
  const td = recommenderToToolDef(tree);
  const gender = td.input_schema.properties.gender;
  assert(Array.isArray(gender.enum), "gender should be an enum");
  assert(gender.enum.includes("Men") && gender.enum.includes("Women"),
    `gender enum missing Men/Women: ${JSON.stringify(gender.enum)}`);
});

check("Malformed definition returns null instead of throwing", () => {
  const td = recommenderToToolDef({ id: "x", intent: "y", definition: { /* missing rootNodeId, etc. */ } });
  assert.equal(td, null, "should return null on malformed input");
});

console.log("\nrequired-attributes gate");
check("seed declares gender + useCase + condition as required", () => {
  assert(Array.isArray(definition.requiredAttributes), "missing requiredAttributes array");
  assert(definition.requiredAttributes.includes("gender"), "gender should be required");
  assert(definition.requiredAttributes.includes("useCase"), "useCase should be required");
  assert(definition.requiredAttributes.includes("condition"), "condition should be required");
});

check("seed has merchant-supplied attributePrompts for required fields", () => {
  assert(definition.attributePrompts && typeof definition.attributePrompts === "object",
    "missing attributePrompts");
  for (const k of definition.requiredAttributes) {
    assert(typeof definition.attributePrompts[k] === "string" && definition.attributePrompts[k].trim(),
      `missing prompt text for required attribute "${k}"`);
  }
});

check("tool description tells AI to call tool always, and lists required attrs", () => {
  const td = recommenderToToolDef(tree);
  assert(td.description.includes("gender"), "tool description should mention 'gender'");
  assert(td.description.includes("useCase"), "tool description should mention 'useCase'");
  assert(/always call/i.test(td.description),
    "description should tell AI to call the tool always (the tool collects info via needMoreInfo)");
  assert(/needmoreinfo|need more info|missing/i.test(td.description),
    "description should mention the needMoreInfo / missing-attribute response path");
});

// Runtime gate: when a required attribute is missing in the tool
// input, the executor returns needMoreInfo with the missing list
// and a per-attribute prompt question, instead of resolving a SKU.
check("executor returns needMoreInfo when only arch is provided", async () => {
  const { executeRecommenderTool } = await import("../app/lib/recommender-tools.server.js");
  const r = await executeRecommenderTool({
    toolName: "recommend_orthotic",
    input: { arch: "Medium / High Arch" }, // missing gender + useCase + condition
    shop: null, // shop irrelevant — the gate fires before the catalog filter
    trees: [tree],
  });
  assert.equal(r.needMoreInfo, true, "should return needMoreInfo");
  assert.deepEqual(r.missingAttributes.sort(), ["condition", "gender", "useCase"]);
  assert(typeof r.instruction === "string" && /ask/i.test(r.instruction),
    "instruction should tell the LLM to ask the customer");
  assert(r.masterSku === undefined, "should NOT resolve a SKU when required attrs are missing");
});

check("derivations fire: condition=metatarsalgia → resolver picks W/ Met Support SKU", async () => {
  const { executeRecommenderTool } = await import("../app/lib/recommender-tools.server.js");
  const r = await executeRecommenderTool({
    toolName: "recommend_orthotic",
    input: {
      gender: "Men",
      useCase: "athletic_running",
      condition: "metatarsalgia",
      arch: "Medium / High Arch",
    },
    shop: null,
    trees: [tree],
  });
  // L705M = Men's Speed Orthotics W/ Metatarsal Support
  // L700M = Men's Speed Orthotics (no met)
  // Without derivations the resolver picks L700M (wrong);
  // with derivations applied, condition=metatarsalgia sets
  // metSupport=true and L705M wins.
  // When shop=null and the product isn't in any catalog, the executor
  // returns the resolver's pick under r.missingProduct rather than at
  // the top level. Either shape proves the derivation fired.
  const picked = r.masterSku || r.missingProduct?.masterSku;
  assert.equal(picked, "L705M",
    `derivation must fire — expected L705M (W/ Met Support), got ${picked}`);
});

check("derivations fire: arch=Flat → posted=true → resolver picks Posted SKU", async () => {
  const { executeRecommenderTool } = await import("../app/lib/recommender-tools.server.js");
  const r = await executeRecommenderTool({
    toolName: "recommend_orthotic",
    input: {
      gender: "Women",
      useCase: "athletic_running",
      condition: "none",
      arch: "Flat / Low Arch",
    },
    shop: null,
    trees: [tree],
  });
  // arch=Flat triggers the posted=true derivation → Speed Posted
  // SKUs (L720W, L725W) score higher than the non-posted L700W/L705W.
  const title = r.title || r.missingProduct?.title || "";
  const sku = r.masterSku || r.missingProduct?.masterSku || "";
  assert(/posted/i.test(title),
    `derivation must set posted=true for flat arch; got ${sku} (${title})`);
});

check("executor proceeds normally when all required attributes are present", async () => {
  const { executeRecommenderTool } = await import("../app/lib/recommender-tools.server.js");
  const r = await executeRecommenderTool({
    toolName: "recommend_orthotic",
    input: { gender: "Women", useCase: "casual", condition: "none" },
    shop: null, // catalog-filter falls through gracefully when shop is null
    trees: [tree],
  });
  // Either resolves (catalog-filter no-op) or returns the catalog
  // empty error — but in NEITHER case does it return needMoreInfo.
  assert(!r.needMoreInfo, "should not gate when required attrs are present");
});

console.log("\nmerchant policy: no Active, Conform only for diabetes/neuropathy, Premium Memory Foam leads");
{
  const GENDERS = ["Men", "Women"];
  const USE_CASES = ["dress", "dress_no_removable", "dress_premium", "casual", "athletic_running", "athletic_training", "athletic_general", "cleats", "skates", "winter_boots", "work_all_day", "comfort"];
  const CONDITIONS = ["none", "plantar_fasciitis", "heel_spurs", "metatarsalgia", "mortons_neuroma", "overpronation_flat_feet", "diabetic", "neuropathy"];
  const PROFILES = [{ arch: "Medium / High Arch", posted: false }, { arch: "Flat / Low Arch", posted: true }];
  const every = [];
  for (const gender of GENDERS) for (const useCase of USE_CASES) for (const condition of CONDITIONS) for (const p of PROFILES) {
    const metSupport = condition === "metatarsalgia" || condition === "mortons_neuroma";
    const r = resolveTree({ gender, useCase, condition, metSupport, ...p }, definition.resolver);
    every.push({ condition, title: r.resolved?.title || "", runnerUp: r.runnerUp?.title || "" });
  }
  check("Active orthotics never recommended (winner or runner-up), any answers", () => {
    const hit = every.find((x) => /\bactive\s+(posted\s+)?orthotics?\b/i.test(`${x.title} ${x.runnerUp}`));
    assert(!hit, `got ${hit?.title} / ${hit?.runnerUp}`);
  });
  check("Conform only when the shopper said diabetes or neuropathy", () => {
    const hit = every.find((x) => !["diabetic", "neuropathy"].includes(x.condition) && /conform/i.test(`${x.title} ${x.runnerUp}`));
    assert(!hit, `condition=${hit?.condition} got ${hit?.title} / ${hit?.runnerUp}`);
  });
  check("Neuropathy (Women, casual) → Conform", () => assert.match(
    resolveTree({ gender: "Women", useCase: "casual", condition: "neuropathy", arch: "Medium / High Arch", posted: false }, definition.resolver).resolved?.title || "", /conform/i));
  check("Athletic court/general (Men) → Compete, not Active", () =>
    assert.equal(sku({ gender: "Men", useCase: "athletic_general", arch: "Medium / High Arch", posted: false, metSupport: false }), "L400M"));
  check("Just comfort (Women, medium arch) → Premium Memory Foam L2300W", () =>
    assert.equal(sku({ gender: "Women", useCase: "comfort", condition: "none", arch: "Medium / High Arch", posted: false, metSupport: false }), "L2300W"));
  check("Just comfort (Men, flat arch, posted) → Premium Memory Foam Posted L2320M", () =>
    assert.equal(sku({ gender: "Men", useCase: "comfort", condition: "none", arch: "Flat / Low Arch", posted: true, metSupport: false }), "L2320M"));
  check("Work all day (Women, medium arch) → Premium Memory Foam at Work A2300W", () =>
    assert.equal(sku({ gender: "Women", useCase: "work_all_day", arch: "Medium / High Arch", posted: false, metSupport: false }), "A2300W"));
  check("Premium Memory Foam leads over regular Memory Foam at the same fit", () => {
    const r = resolveTree({ gender: "Men", useCase: "comfort_memory_foam_everyday", arch: "Flat / Low Arch", posted: true, metSupport: true }, definition.resolver);
    assert.equal(r.resolved?.masterSku, "L2325M");
  });
  check("Premium Memory Foam never beats a better clinical fit (heel spurs keeps L2460W)", () =>
    assert.equal(sku({ gender: "Women", useCase: "comfort", condition: "heel_spurs" }), "L2460W"));
  check("Kids comfort never gets an adult Premium Memory Foam", () =>
    assert(!/premium memory foam/i.test(resolveTree({ gender: "Kids", useCase: "comfort" }, definition.resolver).resolved?.title || "")));
}

console.log("\nbackward compat");
check("Old funnel-shaped seeds still work — only resolver.masterIndex is read at runtime", () => {
  // Even though the seed has q_use_case / q_gender / chips etc., the
  // recommender path ignores them. Only resolveTree(answers, definition.resolver)
  // is the runtime path. Old rows in production keep working without migration.
  const td = recommenderToToolDef(tree);
  assert(td, "old-shape seed still produces a tool def");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
