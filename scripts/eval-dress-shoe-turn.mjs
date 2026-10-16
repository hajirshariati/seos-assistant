// Dress-shoe conversation regression (live trace 2026-10-16, HAJIR TEST theme).
//
//   Customer: "i need a good dress shoe for my blue dress, what do you recommend?"
//   Bot:      "I found 3 footwear…" + Fiji Orthotic Flips + Maeve Casual Slip-Ons
//   Customer: "are these dress shoes?"
//   Bot:      "You're right — those aren't dress shoes."   (and nothing else)
//
// Root causes covered:
//   1. color=blue was injected onto the SHOE search from "my blue dress"
//   2. the forced/fallback search dropped the use case → query="footwear"
//   3. "dress" never matched the catalog's dressy vocabulary (wedges, Mary
//      Janes, loafers, oxfords, ballet flats, "Social" activity)
//   4. "are these dress shoes?" after cards → clarification + cards suppressed
//
// Run: node scripts/eval-dress-shoe-turn.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));

let catalog = [];
const noop = new Proxy(async () => [], { get: (t, k) => (k === "then" ? undefined : noop), apply: async () => [] });
global.prismaGlobal = new Proxy({}, {
  get: (t, model) => {
    if (model === "product") return { findMany: async () => catalog, findFirst: async () => null, count: async () => catalog.length };
    if (model === "$queryRawUnsafe" || model === "$queryRaw") return async () => [];
    return noop;
  },
});

const { executeTool } = await import("../app/lib/chat-tools.server.js");
const { rewriteToolCall, injectStructuredColorFilter } = await import("../app/lib/chat-tool-rewrite.server.js");
const { scopedProductSearchInput, buildAnswerWorkflowForcedSearch } = await import("../app/lib/emit-finalize.server.js");
const { planTurn } = await import("../app/lib/turn-plan.server.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.log(`  ✗ ${name} — ${err.message}`); }
}

const product = (title, category, { activity = [], tags = ["Arch Pain"], description = "Arch support all day." } = {}) => ({
  id: title,
  shop: "s",
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  productType: "Footwear",
  tags,
  description,
  status: "ACTIVE",
  attributesJson: { gender: "women", category_for_filter: category.toLowerCase(), activity },
  featuredImageUrl: "https://example.com/x.jpg",
  updatedAt: new Date(),
  variants: [{ sku: `${title}-8`, title: "8", price: "119.95", compareAtPrice: null, inventoryQty: 4, attributesJson: null, optionsJson: JSON.stringify([{ name: "Size", value: "8" }]) }],
});

// Shaped like the live Aetrex catalog: dressy styles never say "dress shoe";
// casual styles' copy says "dress it up or down".
const CATALOG = [
  product("Fiji Orthotic Women's Flips - Charcoal", "Sandals", { description: "Easy flip you can dress up or down.", tags: ["Heel Pain", "Plantar Fasciitis"] }),
  product("Maeve Casual Slip-On - Taupe", "Slip-Ons", { description: "A casual slip-on to dress up or down.", tags: ["Heel Pain"] }),
  product("Maeve Casual Slip-On - Bronze", "Slip-Ons", { description: "A casual slip-on to dress up or down.", tags: ["Heel Pain"] }),
  product("Ashley Arch Support Wedge - Navy", "Wedges/Heels", { activity: ["everyday comfort", "social", "office work"] }),
  product("Joanne Mary Jane - Black", "Mary Janes"),
  product("Collette Arch Support Loafer - Brushed Silver", "Loafers"),
  product("Brianna Ballet Flat - Pewter", "Slip-Ons", { activity: ["social", "office work"] }),
];
const CASUAL = /Fiji|Maeve/;

const FIRST = "i need a good dress shoe for my blue dress, what do you recommened?";
const SECOND = "are these dress shoes?";
const rctx = (msg, extra = {}) => ({
  shop: "s",
  latestUserMessage: msg,
  messages: [{ role: "user", content: msg }],
  catalogCategories: ["Accessories", "Footwear", "Orthotics"],
  _merchantColors: ["navy", "blue", "black", "pewter", "brushed silver", "taupe", "bronze", "charcoal"],
  shopConfig: {},
  ...extra,
});
const search = async (input, msg) => {
  const r = await executeTool("search_products", input, rctx(msg));
  return (r.products || []).map((p) => p.title);
};

console.log("Dress-shoe turn eval\n");

console.log("outfit color is not a shoe filter");
await test('"for my blue dress" never injects color=blue onto the shoe search', () => {
  const out = injectStructuredColorFilter({ name: "search_products", input: { query: "dress shoes", filters: {} } }, rctx(FIRST));
  assert.equal(out.input.filters.color, undefined);
});
await test('"blue dress shoes" still means blue shoes', () => {
  const out = injectStructuredColorFilter({ name: "search_products", input: { query: "dress shoes", filters: {} } }, rctx("do you have blue dress shoes?"));
  assert.equal(out.input.filters.color, "blue");
});

console.log("\ndress use case reaches the search");
await test("forced scoped search keeps the dress use case (not just \"footwear\")", () => {
  const { input } = scopedProductSearchInput(rctx(FIRST));
  assert.match(input.query, /dressy/);
  assert.match(input.query, /wedge/);
  assert.equal(input.filters.color, undefined);
});
await test("answer-workflow forced search expands dress too", () => {
  const { input } = buildAnswerWorkflowForcedSearch({ ctx: rctx(SECOND, { turnPlan: { workflow: "browse", gender: "women" } }) });
  assert.match(input.query, /mary jane/);
});
await test("the model's own dress search is expanded with dressy catalog terms", () => {
  const out = rewriteToolCall(
    { name: "search_products", input: { query: "dress shoe plantar fasciitis", filters: {} } },
    rctx(FIRST, { turnPlan: { workflow: "browse", gender: "women" } }),
  );
  assert.match(out.input.query, /dressy wedge mary jane loafer oxford ballet social/);
  assert.equal(out.input.filters.category, "footwear");
  assert.equal(out.input.filters.color, undefined);
});
await test("a plain walking request is not expanded", () => {
  const out = rewriteToolCall({ name: "search_products", input: { query: "walking sneakers", filters: {} } }, rctx("walking sneakers please"));
  assert.equal(out.input.query, "walking sneakers");
});

console.log("\nsearch ranks dressy styles first");
await test("expanded dress query returns wedges / Mary Janes / loafers / ballet flats before casual styles", async () => {
  catalog = CATALOG;
  const titles = await search({ query: "dress shoe dressy wedge mary jane loafer oxford ballet social", filters: { category: "footwear", gender: "women" } }, FIRST);
  const top = titles.slice(0, 3);
  assert.ok(top.length === 3 && top.every((t) => !CASUAL.test(t)), `casual style in top 3: ${JSON.stringify(titles)}`);
  assert.ok(titles.includes("Ashley Arch Support Wedge - Navy"), JSON.stringify(titles));
});
await test("the old bare query is what surfaced casual styles (documents the bug)", async () => {
  catalog = CATALOG;
  const titles = await search({ query: "footwear", filters: { category: "footwear", gender: "women" } }, FIRST);
  assert.ok(titles.some((t) => CASUAL.test(t)), JSON.stringify(titles));
});

console.log("\n\"are these dress shoes?\" after cards");
await test("routes to browse with cards shown and search required — not clarification", () => {
  const plan = planTurn({ message: SECOND, hasPriorCards: true });
  assert.equal(plan.workflow, "browse");
  assert.equal(plan.productDisplayPolicy, "show");
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.clarificationAllowed, false);
  assert.ok(plan.directives.some((d) => /Never just agree and stop/.test(d)));
});
await test("same for \"is this a sandal?\" / \"are they really wedges?\"", () => {
  for (const m of ["is this a sandal?", "are they really wedges?"]) {
    assert.equal(planTurn({ message: m, hasPriorCards: true }).workflow, "browse", m);
  }
});
await test("spec / stock / sale / suitability questions keep their own workflows", () => {
  assert.equal(planTurn({ message: "are these waterproof?", hasPriorCards: true }).workflow, "product_spec");
  assert.equal(planTurn({ message: "is it on sale?", hasPriorCards: true }).workflow, "sale_browse");
  assert.equal(planTurn({ message: "are these good for running?", hasPriorCards: true }).workflow, "condition_recommendation");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
