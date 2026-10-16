// Red-shoe search regression (live trace 2026-10-16, HAJIR TEST theme).
//
// "Hi, can you show me shoes in red good for plantar faciatis ?" returned two
// ORTHOTIC cards and "we don't currently have red shoes" while Savannah / Emmy /
// Margot / Reagan / Susie / Sydney all exist in red. Root causes covered here:
//   1. color filter read only attributesJson.color (empty without Attribute
//      Mappings) — Aetrex keeps color in the " - Red" title suffix
//   2. a filter key no product carries (condition="plantar fasciitis", which
//      Aetrex keeps in TAGS) wiped every filter, color included
//   3. strict gender on an untagged catalog kept only "Women's …" titles —
//      the orthotics
//   4. the model searched with category=undefined on a "shoes" message
//   5. cards dropped by commerce-truth still rendered (products SSE was
//      buffered before the repair; the widget appends products events)
//   6. sync never read the color/gender/category metafields the store has
//
// Run: node scripts/eval-red-shoe-search.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

// Server modules use extensionless relative imports (bundler style) — resolve
// them for plain node. Prisma is faked in-process; nothing touches a database.
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
const { matchColorValues, titleSuffixColor, containsColorWord } = await import("../app/lib/color-match.js");
const { resolveAutoAttributes, buildAutoMetafieldFragment } = await import("../app/models/AttributeMapping.server.js");
const { injectCurrentTurnFootwearCategory, rewriteToolCall } = await import("../app/lib/chat-tool-rewrite.server.js");
const { reconcileBufferedCardEvents } = await import("../app/lib/card-emission.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

const product = (title, productType, { attrs = null, tags = [] } = {}) => ({
  id: title,
  shop: "s",
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  productType,
  tags,
  description: "Arch support and cushioning for plantar fasciitis and heel pain, so feet never feel tired.",
  status: "ACTIVE",
  attributesJson: attrs,
  featuredImageUrl: "https://example.com/x.jpg",
  updatedAt: new Date(),
  variants: [{
    sku: `${title}-8`, title: "8", price: "99.95", compareAtPrice: null, inventoryQty: 5, attributesJson: null,
    optionsJson: JSON.stringify([{ name: "Size", value: "8" }]),
  }],
});

// Untagged catalog — the state of a store with no Attribute Mappings configured.
const UNTAGGED = [
  product("Savannah Adjustable Quarter Strap Sandal - Red", "Footwear", { tags: ["Plantar Fasciitis", "Arch Pain"] }),
  product("Emmy Braided Thong Sandal - Red", "Footwear", { tags: ["Plantar Fasciitis"] }),
  product("Margot Lace-Up Boot - Dark Red", "Footwear", { tags: ["Plantar Fasciitis"] }),
  product("Carly Arch Support Sneaker - Navy", "Footwear", { tags: ["Plantar Fasciitis"] }),
  product("Chase Arch Support Sneaker - Black", "Footwear", { tags: ["Plantar Fasciitis"] }),
  product("Women's Train Orthotics W/ Metatarsal Support", "Orthotics", { tags: ["Plantar Fasciitis"] }),
  product("Women's Premium Memory Foam Posted Orthotics W/ Metatarsal Support", "Orthotics", { tags: ["Plantar Fasciitis"] }),
];

const MESSAGE = "Hi, can you show me shoes in red good for plantar faciatis ?";
const ctx = () => ({
  shop: "s",
  latestUserMessage: MESSAGE,
  messages: [{ role: "user", content: MESSAGE }],
  shopConfig: {},
});
const search = async (input) => {
  const r = await executeTool("search_products", input, ctx());
  return { titles: (r.products || []).map((p) => p.title), relaxed: r.relaxedFilters || null };
};
const isOrthotic = (t) => /orthotic|insole/i.test(t);
const isRed = (t) => /\bred\b/i.test(t);

console.log("Red-shoe search eval\n");

console.log("color-match");
await test("title suffix is a color only when it reads as one", () => {
  assert.equal(titleSuffixColor("Savannah Adjustable Quarter Strap Sandal - Red"), "Red");
  assert.equal(titleSuffixColor("Margot Lace-Up Boot - Dark Red"), "Dark Red");
  assert.equal(titleSuffixColor("Women's Active Orthotics - Insole for Athletic Footwear"), null);
  assert.equal(containsColorWord("Terracotta Multi"), true);
});
await test("word-boundary exact match, close-shade family, never substrings", () => {
  assert.equal(matchColorValues(["Dark Red"], ["red"]), "exact");
  assert.equal(matchColorValues(["Burgundy"], ["red"]), "family");
  assert.equal(matchColorValues(["Tired Grey"], ["red"]), null);
  assert.equal(matchColorValues(["Shredded"], ["red"]), null);
});

console.log("\nsearch_products (untagged catalog)");
await test("the exact live call — color=red + condition + gender=women — returns red SHOES, no orthotics", async () => {
  catalog = UNTAGGED;
  const { titles } = await search({ query: "plantar fasciitis shoes", filters: { color: "red", condition: "plantar fasciitis", gender: "women" } });
  assert.ok(titles.length >= 3, `expected the 3 red styles, got ${JSON.stringify(titles)}`);
  assert.ok(titles.every(isRed), `non-red card: ${JSON.stringify(titles)}`);
  assert.ok(!titles.some(isOrthotic), `orthotic leaked: ${JSON.stringify(titles)}`);
});
await test("color=red + category=footwear returns only red footwear", async () => {
  catalog = UNTAGGED;
  const { titles } = await search({ query: "plantar fasciitis shoes", filters: { color: "red", category: "footwear" } });
  assert.deepEqual(titles.sort(), [
    "Emmy Braided Thong Sandal - Red",
    "Margot Lace-Up Boot - Dark Red",
    "Savannah Adjustable Quarter Strap Sandal - Red",
  ]);
});
await test("a filter key no product carries is ignored — it must not wipe color", async () => {
  catalog = UNTAGGED;
  const { titles } = await search({ query: "plantar fasciitis shoes", filters: { color: "red", activity: "pickleball" } });
  assert.ok(titles.length > 0 && titles.every(isRed), JSON.stringify(titles));
});
await test("no exact red → closest shades, honestly flagged", async () => {
  catalog = [
    product("Jillian Sport Sandal - Burgundy", "Footwear", { tags: ["Plantar Fasciitis"] }),
    product("Carly Arch Support Sneaker - Navy", "Footwear", { tags: ["Plantar Fasciitis"] }),
  ];
  const { titles, relaxed } = await search({ query: "sandals", filters: { color: "red", category: "footwear" } });
  assert.deepEqual(titles, ["Jillian Sport Sandal - Burgundy"]);
  assert.match(String(relaxed?._reason || ""), /closest shades/);
});

console.log("\nsearch_products (tagged catalog — after sync auto-discovery)");
await test("tagged catalog keeps strict gender: an ungendered product is still dropped", async () => {
  catalog = [
    product("Savannah Adjustable Quarter Strap Sandal - Red", "Footwear", { attrs: { gender: "women", color: "red" } }),
    product("Mystery Sandal - Red", "Footwear"),
    product("Men's Chase Sneaker - Red", "Footwear", { attrs: { gender: "men", color: "red" } }),
  ];
  const { titles } = await search({ query: "sandals", filters: { color: "red", gender: "women" } });
  assert.deepEqual(titles, ["Savannah Adjustable Quarter Strap Sandal - Red"]);
});
await test("metafield color attribute matches even without a title suffix", async () => {
  catalog = [
    product("Reagan Ankle Boot", "Footwear", { attrs: { gender: "women", color: "red", color_family: "red" } }),
    product("Kinsley Boot", "Footwear", { attrs: { gender: "women", color: "black" } }),
  ];
  const { titles } = await search({ query: "boots", filters: { color: "red", gender: "women" } });
  assert.deepEqual(titles, ["Reagan Ankle Boot"]);
});

console.log("\nsync auto-discovery");
await test("reads color / gender / category metafields when nothing is mapped", () => {
  const frag = buildAutoMetafieldFragment([]);
  assert.match(frag, /metafield\(namespace: "custom", key: "gender_text"\)/);
  // Candidate order: color, colour, color_family, attr_color_family, gender, gender_text, category_for_filter, subcategory
  const node = {
    auto_0: { value: "dark red" },
    auto_3: { value: "red" },
    auto_5: { value: "Women" },
    auto_6: { value: "Boots" },
    auto_7: { value: '["gid://shopify/Metaobject/1"]' },
  };
  assert.deepEqual(resolveAutoAttributes(node, []), {
    color: "dark red", color_family: "red", gender: "women", category_for_filter: "boots",
  });
});
await test("a configured mapping wins — its attribute is not auto-discovered", () => {
  const frag = buildAutoMetafieldFragment([{ attribute: "gender", sourceType: "metafield", namespace: "custom", key: "g" }]);
  assert.doesNotMatch(frag, /gender/);
});

await test("conditions / activity / badge metafields are auto-discovered; empty lists fall through", () => {
  const frag = buildAutoMetafieldFragment([]);
  const keys = [...frag.matchAll(/(auto_\d+): metafield\(namespace: "([^"]+)", key: "([^"]+)"\)/g)]
    .map((m) => ({ alias: m[1], ref: `${m[2]}.${m[3]}` }));
  const alias = (ref) => keys.find((k) => k.ref === ref).alias;
  const node = {
    [alias("product.recommended_for")]: { value: "[]" },
    [alias("product.reccomended_for")]: { value: '["Plantar Fasciitis","Heel Pain"]' },
    [alias("custom.attr_activity_shoe_type_for_filter")]: { value: '["Everyday Comfort","Beach"]' },
    [alias("custom.badge")]: { value: "Limited Release" },
  };
  assert.deepEqual(resolveAutoAttributes(node, []), {
    helps_with: ["plantar fasciitis", "heel pain"],
    activity: ["everyday comfort", "beach"],
    badge: "limited release",
  });
});

console.log("\nfacet aliases (model filter names → catalog attributes)");
await test("condition filter matches the helps_with attribute when tags are absent", async () => {
  catalog = [
    product("Savannah Adjustable Quarter Strap Sandal - Red", "Footwear", { attrs: { gender: "women", color: "red", helps_with: ["plantar fasciitis", "bunions"] } }),
    product("Reagan Ankle Boot - Red", "Footwear", { attrs: { gender: "women", color: "red", helps_with: ["heel pain"] } }),
  ];
  const { titles } = await search({ query: "plantar fasciitis", filters: { color: "red", condition: "plantar_fasciitis", gender: "women" } });
  assert.deepEqual(titles, ["Savannah Adjustable Quarter Strap Sandal - Red"]);
});
await test("use_case filter matches the activity attribute", async () => {
  catalog = [
    product("Emmy Braided Thong Sandal - Red", "Footwear", { attrs: { gender: "women", color: "red", activity: ["everyday comfort", "beach"] } }),
    product("Margot Lace-Up Boot - Dark Red", "Footwear", { attrs: { gender: "women", color: "dark red", activity: ["office work"] } }),
  ];
  const { titles } = await search({ query: "sandals", filters: { color: "red", use_case: "beach" } });
  assert.deepEqual(titles, ["Emmy Braided Thong Sandal - Red"]);
});

console.log("\nfootwear scope on the model's own search");
const rctx = (msg, extra = {}) => ({ latestUserMessage: msg, catalogCategories: ["Accessories", "Footwear", "Orthotics"], ...extra });
const call = (filters = {}) => ({ name: "search_products", input: { query: "plantar fasciitis shoes", filters } });
await test('"shoes" this turn → category=footwear', () => {
  const out = injectCurrentTurnFootwearCategory(call({ color: "red" }), rctx(MESSAGE));
  assert.equal(out.input.filters.category, "footwear");
  assert.equal(out.input.filters.color, "red");
});
await test("insole / orthotic messages are never forced to footwear", () => {
  const out = injectCurrentTurnFootwearCategory(call(), rctx("I need insoles for my shoes"));
  assert.equal(out.input.filters.category, undefined);
});
await test("the model's own category wins; named-product workflows untouched", () => {
  assert.equal(injectCurrentTurnFootwearCategory(call({ category: "sandals" }), rctx(MESSAGE)).input.filters.category, "sandals");
  const avail = injectCurrentTurnFootwearCategory(call(), rctx("do the Jillian shoes come in red?", { turnPlan: { workflow: "availability" } }));
  assert.equal(avail.input.filters.category, undefined);
});
await test("full rewrite pipeline scopes the live call to footwear", () => {
  const out = rewriteToolCall(call({ color: "red" }), { ...rctx(MESSAGE), turnPlan: { workflow: "condition_recommendation", gender: "women" } });
  assert.equal(out.input.filters.category, "footwear");
});

console.log("\ncard emission truth");
const enc = new TextEncoder();
const chunk = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
const dec = (c) => JSON.parse(new TextDecoder().decode(c).slice(6));
await test("cards dropped by commerce-truth never reach the widget", () => {
  const orthotics = [{ handle: "l1900w-m", title: "Women's Train Orthotics" }, { handle: "l805w-m", title: "Women's Premium Orthotics" }];
  const buf = [chunk({ type: "products", products: [] }), chunk({ type: "products", products: orthotics }), chunk({ type: "link", url: "/x", label: "View" })];
  const rec = reconcileBufferedCardEvents(buf, [], chunk);
  const events = rec.chunks.map(dec);
  const products = events.filter((e) => e.type === "products");
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].products, []);
  assert.equal(rec.changed, true);
});
await test("one products event with the accepted cards; stale visualize CTA dropped", () => {
  const red = [{ handle: "savannah-red", title: "Savannah Sandal - Red" }];
  const buf = [chunk({ type: "products", products: [{ handle: "l1900w-m", title: "Orthotic" }] }), chunk({ type: "visualize_cta", productHandle: "l1900w-m" })];
  const rec = reconcileBufferedCardEvents(buf, red, chunk);
  const events = rec.chunks.map(dec);
  assert.deepEqual(events.map((e) => e.type), ["products"]);
  assert.deepEqual(events[0].products, red);
});
await test("unchanged buffers are left as-is (changed=false)", () => {
  const red = [{ handle: "savannah-red", title: "Savannah Sandal - Red" }];
  const rec = reconcileBufferedCardEvents([chunk({ type: "products", products: red })], red, chunk);
  assert.equal(rec.changed, false);
  assert.equal(reconcileBufferedCardEvents([chunk({ type: "products", products: red })], null, chunk).changed, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
