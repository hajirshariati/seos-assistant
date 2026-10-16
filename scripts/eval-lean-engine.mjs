// Lean engine eval — "Claude decides, code checks facts".
//
// Runs the lean engine against a scripted (stub) model so the CODE contract is
// tested offline: search applies exactly what the model asked for, nothing is
// injected, cards are exactly what the model chose, the fact check catches
// invented products/prices and triggers one rewrite. Model QUALITY is judged
// on the admin Compare page against the live model.
//
// Run: node scripts/eval-lean-engine.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const noop = new Proxy(async () => [], { get: (t, k) => (k === "then" ? undefined : noop), apply: async () => [] });
global.prismaGlobal = new Proxy({}, { get: () => noop });

const { buildLeanCatalog } = await import("../app/lib/lean/catalog.js");
const { leanSearch, productDetails } = await import("../app/lib/lean/search.js");
const { buildLeanTools } = await import("../app/lib/lean/tools.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");
const { verifyLeanAnswer, buildFamilyIndex } = await import("../app/lib/lean/verify.js");
const { runLeanTurn, extractPriorShownTitles, normalizeConversation } = await import("../app/lib/lean/engine.js");
const { leanEngineSelected } = await import("../app/lib/lean/respond.server.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.log(`  ✗ ${name} — ${err.message}`); }
}

const row = (title, { type = "Footwear", cat, gender = "Women", color, activity = [], helps = [], price = "119.95", compareAt = null, sizes = ["7 US", "8 US"], tags = [], description = "Arch support all day." } = {}) => ({
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""),
  title, productType: type, tags, description, status: "ACTIVE", featuredImageUrl: "https://img/x.jpg",
  attributesJson: {
    ...(cat ? { category_for_filter: cat } : {}),
    ...(gender ? { gender: gender.toLowerCase() } : {}),
    ...(color ? { color } : {}),
    ...(activity.length ? { activity } : {}),
    ...(helps.length ? { helps_with: helps } : {}),
  },
  variants: sizes.map((s) => ({ price, compareAtPrice: compareAt, inventoryQty: 3, optionsJson: JSON.stringify([{ name: "Size", value: s }]) })),
});

const ROWS = [
  row("Savannah Adjustable Quarter Strap Sandal - Red", { cat: "Sandals", helps: ["plantar fasciitis", "bunions"], price: "129.95" }),
  row("Savannah Adjustable Quarter Strap Sandal - Black", { cat: "Sandals", helps: ["plantar fasciitis", "bunions"], price: "129.95" }),
  row("Margot Lace-Up Boot - Dark Red", { cat: "Boots", helps: ["plantar fasciitis"], price: "179.95" }),
  row("Ashley Arch Support Wedge - Navy", { cat: "Wedges/Heels", activity: ["social", "office work"], helps: ["arch pain"], price: "139.95" }),
  row("Ashley Arch Support Wedge - Champagne", { cat: "Wedges/Heels", activity: ["social", "office work"], helps: ["arch pain"], price: "139.95" }),
  row("Joanne Mary Jane - Brushed Silver", { cat: "Mary Janes", activity: ["social"], price: "149.95" }),
  row("Maeve Casual Slip-On - Taupe", { cat: "Slip-Ons", description: "A casual slip-on to dress up or down.", price: "99.95" }),
  row("Fiji Orthotic Women's Flips - Charcoal", { cat: "Sandals", price: "23.98", compareAt: "59.95" }),
  row("Chase Arch Support Sneaker - Red", { cat: "Sneakers", gender: "Men", price: "149.95" }),
  row("Women's Train Orthotics W/ Metatarsal Support", { type: "Orthotics", cat: "Orthotics", helps: ["plantar fasciitis"], price: "69.95", tags: ["Plantar Fasciitis"] }),
  row("Silicone Heel Cradles", { type: "Accessories", cat: "Accessories", gender: "Unisex", price: "19.95" }),
];
const catalog = buildLeanCatalog(ROWS, { shop: "s.myshopify.com" });
const H = Object.fromEntries(catalog.products.map((p) => [p.title, p.handle]));

console.log("Lean engine eval\n");

console.log("catalog facts + vocabulary");
await test("colors come from data (metafield or title suffix), categories from category_for_filter", () => {
  const savannah = catalog.products.find((p) => p.handle === H["Savannah Adjustable Quarter Strap Sandal - Red"]);
  assert.deepEqual(savannah.colors, ["red"]);
  assert.equal(savannah.category, "Sandals");
  const fiji = catalog.products.find((p) => p.handle === H["Fiji Orthotic Women's Flips - Charcoal"]);
  assert.equal(fiji.onSale, true);
  const cats = catalog.vocab.categories.map((c) => c.value);
  assert.ok(cats.includes("wedges/heels") && cats.includes("sandals"), JSON.stringify(cats));
  assert.ok(catalog.vocab.activities.some((a) => a.value === "social"));
});

console.log("\nsearch does exactly what it's asked");
await test("color filter = product color; one card per style; other colors listed", () => {
  const r = leanSearch(catalog, { query: "sandal", colors: ["red"], gender: "women" });
  assert.deepEqual(r.products.map((p) => p.title), ["Savannah Adjustable Quarter Strap Sandal - Red"]);
  assert.deepEqual(r.products[0].same_style_other_colors, ["black"]);
});
await test("no color requested → no color filter (outfit colors are Claude's call, not code's)", () => {
  const r = leanSearch(catalog, { query: "dressy wedge", categories: ["wedges/heels"], gender: "women" });
  assert.equal(r.filters_applied.colors, undefined);
  assert.deepEqual(r.products.map((p) => p.title), ["Ashley Arch Support Wedge - Navy"]);
  assert.deepEqual(r.products[0].same_style_other_colors, ["champagne"]);
});
await test('"red wedges to go with my blue dress" → the red wedge, never other colors or thong sandals', () => {
  // Live store, 2026-10: the one red wedge is the Sydney espadrille; the old
  // engine lost the category, dropped the color and showed thong sandals.
  const live = buildLeanCatalog([
    ...ROWS,
    row("Sydney Quarter Strap Espadrille Wedge - Red", { cat: "Wedges/Heels", activity: ["social"], price: "47.99" }),
    row("Charli Thong Sandal - White", { cat: "Sandals", price: "99.95" }),
    row("Charli Thong Sandal - Black", { cat: "Sandals", price: "99.95" }),
  ], { shop: "s.myshopify.com" });
  assert.ok(live.vocab.categories.some((c) => c.value === "wedges/heels"));
  const r = leanSearch(live, { query: "wedge", categories: ["wedges/heels"], colors: ["red"], gender: "women" });
  const titles = r.products.map((x) => x.title);
  assert.ok(titles.includes("Sydney Quarter Strap Espadrille Wedge - Red"), JSON.stringify(titles));
  assert.ok(!titles.some((t) => /Charli|Navy|Champagne/.test(t)), JSON.stringify(titles));
});

await test("gender includes unisex; men's line excluded from a women's search", () => {
  const r = leanSearch(catalog, { query: "heel cradles sneaker", gender: "women" });
  const titles = r.products.map((p) => p.title);
  assert.ok(titles.includes("Silicone Heel Cradles"));
  assert.ok(!titles.includes("Chase Arch Support Sneaker - Red"));
});
await test("filters-only fallback is flagged to Claude when the query words match nothing", () => {
  const r = leanSearch(catalog, { query: "stiletto", categories: ["sandals"], gender: "women" });
  assert.ok(r.products.length > 0);
  assert.match(r.note, /No product matched the words "stiletto"/);
  assert.equal(leanSearch(catalog, { query: "sandal", gender: "women" }).note, undefined);
});
await test("zero matches → if_relaxed counts instead of silently dropping filters", () => {
  const r = leanSearch(catalog, { query: "wedge", categories: ["wedges/heels"], colors: ["red"], gender: "women" });
  assert.equal(r.products.length, 0);
  assert.equal(r.if_relaxed.without_colors, 2);
  assert.ok(r.if_relaxed.without_categories >= 2);
});
await test("conditions filter + query never substring-matches ('red' ≠ 'tired')", () => {
  const r = leanSearch(catalog, { query: "red", conditions: ["plantar fasciitis"], gender: "women", categories: ["sandals", "boots"] });
  assert.deepEqual(r.products.map((p) => p.title).sort(), ["Margot Lace-Up Boot - Dark Red", "Savannah Adjustable Quarter Strap Sandal - Red"]);
});
await test("product details include sizes and colorways", () => {
  const d = productDetails(catalog, H["Ashley Arch Support Wedge - Navy"]);
  assert.deepEqual(d.sizes_in_stock, ["7 us", "8 us"]);
  assert.equal(d.style_colorways.length, 2);
});

console.log("\ntools + prompt");
await test("search tool offers the catalog's own values; color field warns about outfits", () => {
  const search = buildLeanTools(catalog.vocab).find((t) => t.name === "search_products");
  assert.ok(search.input_schema.properties.categories.items.enum.includes("mary janes"));
  assert.match(search.input_schema.properties.colors.description, /never the color of their outfit/);
  assert.deepEqual(search.input_schema.properties.gender.enum.sort(), ["men", "unisex", "women"]);
});
await test("prompt carries principles + vocabulary, no hidden routing", () => {
  const p = buildLeanSystemPrompt({ config: { assistantName: "Aetrex Assistant", supportUrl: "https://help" }, vocab: catalog.vocab, shop: "aetrex" });
  assert.match(p, /blue dress/);
  assert.match(p, /Categories: .*wedges\/heels/);
  assert.match(p, /https:\/\/help/);
});

console.log("\nfact check");
const familyIndex = buildFamilyIndex(catalog.products);
const P = (title) => catalog.products.find((p) => p.title === title);
await test("flags a product named without being found", () => {
  const issues = verifyLeanAnswer({ text: "Try the Savannah sandal.", seenProducts: [P("Ashley Arch Support Wedge - Navy")], shownHandles: ["x"], familyIndex });
  assert.deepEqual(issues.map((i) => i.code), ["unverified_product"]);
});
await test("flags invented prices; allows real ones and store-info amounts", () => {
  const seen = [P("Ashley Arch Support Wedge - Navy")];
  assert.deepEqual(verifyLeanAnswer({ text: "The Ashley is $119.00.", seenProducts: seen, shownHandles: [seen[0].handle], familyIndex }).map((i) => i.code), ["unverified_price"]);
  assert.deepEqual(verifyLeanAnswer({ text: "The Ashley is $139.95, and shipping is free over $75.", seenProducts: seen, shownHandles: [seen[0].handle], familyIndex, knowledgeText: "Free shipping on orders over $75." }), []);
});
await test("flags recommended products with no cards", () => {
  const seen = [P("Ashley Arch Support Wedge - Navy")];
  assert.deepEqual(verifyLeanAnswer({ text: "The Ashley wedge in navy is lovely.", seenProducts: seen, shownHandles: [], familyIndex }).map((i) => i.code), ["missing_cards"]);
});
await test("products shown in earlier turns count as found", () => {
  const issues = verifyLeanAnswer({ text: "The Maeve is a casual slip-on.", seenProducts: [], priorTitles: ["Maeve Casual Slip-On - Taupe ($99.95)"], shownHandles: [], familyIndex });
  assert.deepEqual(issues, []);
});

console.log("\nengine turn (scripted model)");
const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const txt = (text) => ({ type: "text", text });
function scripted(responses) {
  const requests = [];
  let i = 0;
  return {
    requests,
    callModel: async (req) => {
      requests.push(JSON.parse(JSON.stringify(req)));
      const r = responses[i++];
      if (!r) throw new Error("script exhausted");
      return { usage: { input_tokens: 10, output_tokens: 5 }, ...r };
    },
  };
}
const quiet = () => {};

await test("dress-shoe turn: search params reach the catalog untouched; cards = what Claude showed", async () => {
  const search = { query: "dressy", categories: ["wedges/heels", "mary janes"], gender: "women" };
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", search)] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"], H["Joanne Mary Jane - Brushed Silver"]] })] },
    { stop_reason: "end_turn", content: [txt("For a blue dress, the Ashley wedge in navy is a polished match, and the Joanne Mary Jane in brushed silver adds a little shine.")] },
  ]);
  const logs = [];
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "i need a good dress shoe for my blue dress" }], latestUserMessage: "i need a good dress shoe for my blue dress", callModel: s.callModel, log: (l) => logs.push(l) });
  assert.ok(logs.some((l) => l.startsWith(`[lean] search ${JSON.stringify(search)}`)), "search input must be exactly the model's");
  assert.deepEqual(r.cards.map((c) => c.title), ["Ashley Arch Support Wedge - Navy", "Joanne Mary Jane - Brushed Silver"]);
  assert.equal(r.retried, false);
  assert.deepEqual(r.issues, []);
  assert.equal(r.cards[0].price_formatted, "$139.95");
});
await test("invented product → fact check → Claude rewrites once", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "wedge", categories: ["wedges/heels"] })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"]] })] },
    { stop_reason: "end_turn", content: [txt("The Ashley in navy, or the Savannah sandal.")] },
    { stop_reason: "end_turn", content: [txt("The Ashley wedge in navy is the dressiest match.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "dressy wedge" }], callModel: s.callModel, log: quiet });
  assert.equal(r.retried, true);
  assert.equal(r.text, "The Ashley wedge in navy is the dressiest match.");
  assert.match(JSON.stringify(s.requests[3].messages.at(-1)), /Automatic fact check/);
});
await test("show_products rejects a product no tool returned", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "show_products", { handles: [H["Margot Lace-Up Boot - Dark Red"]] })] },
    { stop_reason: "end_turn", content: [txt("Here you go.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "boots" }], callModel: s.callModel, log: quiet });
  assert.deepEqual(r.cards, []);
  assert.match(JSON.stringify(s.requests[1].messages.at(-1)), /Rejected handles/);
});
await test("follow-up can re-show cards from the previous turn ('are these dress shoes?')", async () => {
  const history = [
    { role: "user", content: "dress shoe for my blue dress" },
    { role: "assistant", content: "Here are some options.\n\n[Product cards displayed with this reply: 1. Maeve Casual Slip-On - Taupe ($99.95)]" },
    { role: "user", content: "are these dress shoes?" },
  ];
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "dressy", categories: ["wedges/heels"], gender: "women" })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"]] })] },
    { stop_reason: "end_turn", content: [txt("Not really — the Maeve is a casual slip-on. For a blue dress, the Ashley wedge in navy is much dressier.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: history, latestUserMessage: "are these dress shoes?", callModel: s.callModel, log: quiet });
  assert.deepEqual(r.issues, [], "mentioning the previously shown Maeve is allowed");
  assert.deepEqual(r.cards.map((c) => c.title), ["Ashley Arch Support Wedge - Navy"]);
});
await test("medical note appended by code on condition turns", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "sandal", colors: ["red"], conditions: ["plantar fasciitis"], gender: "women" })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Savannah Adjustable Quarter Strap Sandal - Red"]] })] },
    { stop_reason: "end_turn", content: [txt("The Savannah sandal in red is built for plantar fasciitis support.")] },
  ]);
  const msg = "show me shoes in red good for plantar fasciitis";
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: msg }], latestUserMessage: msg, callModel: s.callModel, log: quiet });
  assert.match(r.text, /podiatrist/);
  assert.deepEqual(r.cards.map((c) => c.title), ["Savannah Adjustable Quarter Strap Sandal - Red"]);
});
await test("no medical note on a fashion question, even if the reply mentions orthotics", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "wedge", categories: ["wedges/heels"], gender: "women" })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"]] })] },
    { stop_reason: "end_turn", content: [txt("The Ashley wedge in navy is a lovely match — and it works with our dress orthotics too.")] },
  ]);
  const msg = "do you have any red wedges that i can set with my blue dress?";
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: msg }], latestUserMessage: msg, callModel: s.callModel, log: quiet });
  assert.doesNotMatch(r.text, /podiatrist/);
});

console.log("\nplumbing");
await test("conversation normalization: starts with user, merges repeats", () => {
  const c = normalizeConversation([{ role: "assistant", content: "hi" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "c" }]);
  assert.deepEqual(c.map((m) => m.role), ["user", "assistant"]);
  assert.equal(c[0].content, "a\n\nb");
  assert.deepEqual(extractPriorShownTitles([{ role: "assistant", content: "x [Product cards displayed with this reply: 1. A - Red ($9.00); 2. B]" }]), ["A - Red ($9.00)", "B"]);
});
await test("engine switch: admin picks per request; storefront only via LEAN_CHAT_SHOPS", () => {
  delete process.env.LEAN_CHAT_SHOPS;
  assert.equal(leanEngineSelected({ shop: "s", internal: true, body: { engine: "lean" } }), true);
  assert.equal(leanEngineSelected({ shop: "s", internal: false, body: { engine: "lean" } }), false);
  process.env.LEAN_CHAT_SHOPS = "s,t";
  assert.equal(leanEngineSelected({ shop: "s" }), true);
  assert.equal(leanEngineSelected({ shop: "s", internal: true, body: { engine: "current" } }), false);
  assert.equal(leanEngineSelected({ shop: "u" }), false);
  delete process.env.LEAN_CHAT_SHOPS;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
