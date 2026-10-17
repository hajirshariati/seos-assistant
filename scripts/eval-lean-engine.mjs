// Lean engine eval — "Claude decides, code checks facts".
//
// Runs the lean engine against a scripted (stub) model so the CODE contract is
// tested offline: search applies exactly what the model asked for, nothing is
// injected, cards are exactly what the model chose, the fact check catches
// invented products/prices and triggers one rewrite. Model QUALITY is judged
// against the live model with scripts/eval-chat-transcripts.mjs.
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
const { leanSearch, productDetails, similarProducts } = await import("../app/lib/lean/search.js");
const { buildLeanTools } = await import("../app/lib/lean/tools.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");
const { verifyLeanAnswer, buildFamilyIndex } = await import("../app/lib/lean/verify.js");
const { runLeanTurn, extractPriorShownTitles, normalizeConversation } = await import("../app/lib/lean/engine.js");
const { buildShopAllLink } = await import("../app/lib/lean/shop-all.js");
const { summarizeWeek } = await import("../app/lib/weekly-summary.js");

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
  assert.deepEqual(r.shopAllSearch, search, "the View-all link repeats the search that found the cards");
});
await test("View-all link: built from the search filters, store pattern honored, vague searches get none", () => {
  assert.deepEqual(
    buildShopAllLink({ query: "x", gender: "women", colors: ["Pink"], categories: ["sandals"] }),
    { url: "/search?q=women+pink+sandals&type=product", label: "View all Women's Pink Sandals" },
  );
  assert.deepEqual(
    buildShopAllLink({ query: "x", gender: "men", on_sale: true }, { pattern: "https://www.aetrex.com/collections/shop?q={q}&tab=products" }),
    { url: "https://www.aetrex.com/collections/shop?q=sale+men&tab=products", label: "View all Sale Men's Styles" },
  );
  assert.equal(buildShopAllLink({ query: "comfy shoes" }), null);
  assert.equal(buildShopAllLink({ query: "x", colors: ["Black", "Navy"] }), null, "two colors can't be one search");
  assert.equal(buildShopAllLink(null), null);
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
await test("store-chosen product fields reach Claude and are searchable", () => {
  const rows = [
    { ...row("Lexa Quarter Strap Wedge - Black", { cat: "Wedges/Heels" }), attributesJson: { category_for_filter: "Wedges/Heels", gender: "women", footbed: "Cork", materials: "Leather upper" } },
    { ...row("Lexa Quarter Strap Wedge - Ivory", { cat: "Wedges/Heels" }), attributesJson: { category_for_filter: "Wedges/Heels", gender: "women", footbed: "Cork" } },
    { ...row("Noelle Arch Support Wedge - Navy", { cat: "Wedges/Heels" }), attributesJson: { category_for_filter: "Wedges/Heels", gender: "women", footbed: "Memory foam" } },
    { ...row("Ashley Arch Support Wedge - Rose", { cat: "Wedges/Heels" }), attributesJson: { category_for_filter: "Wedges/Heels", gender: "women", footbed: "Cork" } },
    { ...row("Savannah Adjustable Quarter Strap Sandal - Red", { cat: "Sandals" }), attributesJson: { category_for_filter: "Sandals", gender: "women", footbed: "Cork" } },
  ];
  const c = buildLeanCatalog(rows, { shop: "s.myshopify.com" });
  const r = leanSearch(c, { query: "cork", categories: ["wedges/heels"], gender: "women" });
  assert.deepEqual(r.products.map((p) => p.title).sort(), ["Ashley Arch Support Wedge - Rose", "Lexa Quarter Strap Wedge - Black"].sort());
  assert.equal(r.products.find((p) => p.title.startsWith("Lexa")).details.footbed, "Cork");
  const d = productDetails(c, c.products[0].handle);
  assert.equal(d.details.materials, "Leather upper");

  const sim = similarProducts(c, { handle: c.products[0].handle, attributes: ["footbed"] });
  assert.deepEqual(sim.products.map((p) => p.title), ["Ashley Arch Support Wedge - Rose"], "same category + footbed, other styles only");
});
await test("many store fields: search results stay small, long text only in details, duplicates dropped", () => {
  const comfort = "Memory foam footbed with built-in arch support that cushions every step and relieves pressure on the heel and ball of the foot.";
  const rows = [
    { ...row("Lexa Quarter Strap Wedge - Black", { cat: "Wedges/Heels" }), attributesJson: {
      category_for_filter: "Wedges/Heels", attr_category: "Wedges/Heels", gender: "women", attr_gender: "women",
      footbed: "Cork", comfort_details: comfort, features: ["Arch support", "Cushioned"], highlights: ["Arch support", "Cushioned"],
    } },
  ];
  const c = buildLeanCatalog(rows, { shop: "s.myshopify.com" });
  const p = c.products[0];
  assert.equal(p.attributes.attr_category, undefined, "copy of the category");
  assert.equal(p.attributes.attr_gender, undefined, "copy of the line");
  assert.equal(Object.keys(p.attributes).filter((k) => k === "features" || k === "highlights").length, 1, "two fields, same values");
  const r = leanSearch(c, { query: "relieves pressure heel" });
  assert.equal(r.products.length, 1, "long text is still searchable");
  assert.equal(r.products[0].details.comfort_details, undefined, "long text left out of search results");
  assert.equal(r.products[0].details.footbed, "Cork");
  assert.equal(productDetails(c, p.handle).details.comfort_details, comfort, "full text when Claude opens the product");
});

console.log("\nstore tools + safety");
const orderTool = {
  definition: { name: "get_customer_orders", description: "orders", input_schema: { type: "object", properties: {} } },
  run: async () => ({ orders: [{ name: "#1042", status: "In transit", total: "$129.95", items: [{ title: "Savannah Adjustable Quarter Strap Sandal - Red", quantity: 1 }], tracking: [{ carrier: "UPS", url: "https://ups.example/1Z" }] }] }),
};
await test("order lookup: products and prices from the order are facts, not inventions", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "get_customer_orders", {})] },
    { stop_reason: "end_turn", content: [txt("Your order #1042 ($129.95) with the Savannah sandal is in transit with UPS.")] },
  ]);
  const msg = "where is my order?";
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: msg }], latestUserMessage: msg, extraTools: [orderTool], callModel: s.callModel, log: quiet });
  assert.deepEqual(r.issues, []);
  assert.equal(r.retried, false);
  assert.ok(s.requests[0].tools.some((t) => t.name === "get_customer_orders"));
});
await test("guided finder result can be shown as a card; widget events pass through", async () => {
  const finder = {
    definition: { name: "recommend_orthotic", description: "finder", input_schema: { type: "object", properties: {} } },
    run: async () => ({ masterSku: "L100W", product: { handle: H["Women's Train Orthotics W/ Metatarsal Support"], title: "Women's Train Orthotics W/ Metatarsal Support" }, _events: [{ type: "fit_report", recommendedSize: "W8" }] }),
  };
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "recommend_orthotic", { gender: "women" })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Women's Train Orthotics W/ Metatarsal Support"]] })] },
    { stop_reason: "end_turn", content: [txt("This orthotic is your match for training with ball-of-foot pain.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "which orthotic for training?" }], latestUserMessage: "which orthotic for training?", extraTools: [finder], callModel: s.callModel, log: quiet });
  assert.deepEqual(r.cards.map((c) => c.title), ["Women's Train Orthotics W/ Metatarsal Support"]);
  assert.deepEqual(r.events, [{ type: "fit_report", recommendedSize: "W8" }]);
  assert.ok(!JSON.stringify(s.requests[1].messages).includes("_events"), "internal events never reach the model");
});
await test("a crashing store tool becomes an error result, never a failed turn", async () => {
  const broken = { definition: { name: "get_product_reviews", description: "r", input_schema: { type: "object", properties: {} } }, run: async () => { throw new Error("yotpo down"); } };
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "get_product_reviews", { handle: "x" })] },
    { stop_reason: "end_turn", content: [txt("I couldn't pull reviews right now.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "reviews?" }], latestUserMessage: "reviews?", extraTools: [broken], callModel: s.callModel, log: quiet });
  assert.equal(r.text, "I couldn't pull reviews right now.");
  assert.match(JSON.stringify(s.requests[1].messages.at(-1)), /yotpo down/);
});
await test("contact_support → support button; follow-ups only with cards, cleaned", async () => {
  const s1 = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "contact_support", { reason: "damaged item" })] },
    { stop_reason: "end_turn", content: [txt("I'm sorry about that — our team can sort out a replacement; tap below to reach them.")] },
  ]);
  const r1 = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "my shoe arrived broken" }], latestUserMessage: "my shoe arrived broken", callModel: s1.callModel, log: quiet });
  assert.equal(r1.supportRequested, "damaged item");
  assert.deepEqual(r1.followUps, []);
  const s2 = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "sandal", colors: ["red"], gender: "women" })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Savannah Adjustable Quarter Strap Sandal - Red"]], follow_ups: ["Does it come in wide?", "**Show black**", "Does it come in wide?", "x", "Any on sale?"] })] },
    { stop_reason: "end_turn", content: [txt("The Savannah in red is a great pick.")] },
  ]);
  const r2 = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "red sandals" }], latestUserMessage: "red sandals", callModel: s2.callModel, log: quiet });
  assert.deepEqual(r2.followUps, ["Does it come in wide?", "Show black", "Any on sale?"]);
});
await test("analytics: a turn records what it was about (never the customer's words) and which products were found", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "sandal", colors: ["red"], gender: "women", conditions: ["plantar fasciitis"] }), tu("t2", "search_store_info", { query: "Return Policy" })] },
    { stop_reason: "tool_use", content: [tu("t3", "contact_support", { reason: "refund for jane@example.com" })] },
    { stop_reason: "end_turn", content: [txt("Here's how returns work.")] },
  ]);
  const r = await runLeanTurn({
    catalog, model: "m", messages: [{ role: "user", content: "my email is jane@example.com, red sandals?" }], latestUserMessage: "x",
    callModel: s.callModel, lookupStoreInfo: async () => ({ found: false }), log: quiet,
  });
  assert.deepEqual(r.topics.map((t) => t.kind).sort(), ["color", "condition", "support", "unanswered"]);
  assert.ok(r.topics.find((t) => t.kind === "unanswered").value === "return policy");
  assert.ok(!JSON.stringify(r.topics).includes("jane"), "no customer text in topics");
  assert.ok(r.mentions.length > 0 && r.mentions.every((m) => m.tool === "search_products"));
  const week = summarizeWeek([...r.topics, ...r.topics, { kind: "category", value: "sandals" }, { kind: "tool", value: "recommend_orthotic" }]);
  assert.deepEqual(week.unanswered, [{ label: "Return policy", count: 2 }]);
  assert.equal(week.supportHandoffs, 2);
  assert.deepEqual(week.tools, [{ label: "Guided finder", count: 1 }]);
  assert.equal(summarizeWeek([]).empty, true);
});
await test("production 2026-10-16: reply written with the cards, then an empty last step → that reply is sent (not 'Sorry')", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "wedge", categories: ["wedges/heels"] })] },
    { stop_reason: "end_turn", content: [txt("The Ashley wedge comes in wide.")] }, // named a product, no cards → rewrite
    { stop_reason: "tool_use", content: [tu("t2", "search_products", { query: "wide wedge", categories: ["wedges/heels"] })] },
    { stop_reason: "tool_use", content: [txt("Yes — the Ashley in navy comes in wide."), tu("t3", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"]] })] },
    { stop_reason: "end_turn", content: [] },
  ]);
  const logs = [];
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "Does it come in wide width?" }], latestUserMessage: "Does it come in wide width?", callModel: s.callModel, log: (l) => logs.push(l) });
  assert.equal(r.text, "Yes — the Ashley in navy comes in wide.");
  assert.equal(r.cards.length, 1);
  assert.ok(!logs.some((l) => l.includes("fallback")), logs.join("\n"));
});
await test("narration next to a search ('Let me check…') is never sent as the reply; Claude is asked once instead", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [txt("Let me check that for you."), tu("t1", "search_products", { query: "wedge", categories: ["wedges/heels"] })] },
    { stop_reason: "tool_use", content: [tu("t2", "show_products", { handles: [H["Ashley Arch Support Wedge - Navy"]] })] },
    { stop_reason: "end_turn", content: [] },
    { stop_reason: "end_turn", content: [txt("The Ashley wedge in navy is a great dressy pick.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "dressy wedge" }], latestUserMessage: "dressy wedge", callModel: s.callModel, log: quiet });
  assert.equal(r.text, "The Ashley wedge in navy is a great dressy pick.");
  const lastReq = s.requests.at(-1).messages;
  assert.equal(lastReq.at(-1).role, "user");
  assert.match(JSON.stringify(lastReq.at(-1)), /write your reply/);
  assert.ok(lastReq.every((m) => !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0)), "no empty assistant turn sent to the API");
});
await test("hop limit: the last call forbids tools so the customer always gets an answer", async () => {
  const loop = Array.from({ length: 7 }, (_, i) => ({ stop_reason: "tool_use", content: [tu(`t${i}`, "search_products", { query: "sandal" })] }));
  const s = scripted([...loop, { stop_reason: "end_turn", content: [txt("Here's what I found in sandals.")] }]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "sandals" }], latestUserMessage: "sandals", callModel: s.callModel, log: quiet });
  assert.equal(s.requests.length, 8);
  assert.deepEqual(s.requests[7].tool_choice, { type: "none" });
  assert.equal(s.requests[0].tool_choice, undefined);
  assert.equal(r.text, "Here's what I found in sandals.");
});
await test("time limit: past the deadline the next call must answer", async () => {
  const s = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "search_products", { query: "sandal" })] },
    { stop_reason: "end_turn", content: [txt("Here are sandals.")] },
  ]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "sandals" }], latestUserMessage: "sandals", deadlineMs: -1, callModel: s.callModel, log: quiet });
  assert.deepEqual(s.requests[0].tool_choice, { type: "none" });
  assert.ok(r.text.length > 0);
});
await test("store context (rules, promotions, customer) is a separate, uncached system block; promo prices verify", async () => {
  const { buildStoreContextBlock } = await import("../app/lib/lean/store-tools.server.js");
  const block = buildStoreContextBlock({
    rules: ["Never recommend kids' products."],
    campaigns: [{ name: "Fall Sale", content: "25% off sneakers with code FALL25. Free shipping over $75.", startsAt: "2026-10-01", endsAt: "2026-10-31" }],
    customer: { firstName: "Dana", numberOfOrders: 3 },
  });
  assert.match(block, /INSTRUCTIONS FROM THE STORE TEAM\nNever recommend kids/);
  assert.match(block, /Fall Sale .*FALL25/);
  assert.match(block, /First name: Dana/);
  assert.match(buildStoreContextBlock({}), /None are running/);
  const s = scripted([{ stop_reason: "end_turn", content: [txt("Yes — 25% off sneakers with code FALL25, and free shipping over $75.")] }]);
  const r = await runLeanTurn({ catalog, model: "m", messages: [{ role: "user", content: "any sales?" }], latestUserMessage: "any sales?", extraSystem: block, callModel: s.callModel, log: quiet });
  assert.equal(s.requests[0].system.length, 2);
  assert.ok(s.requests[0].system[0].cache_control && !s.requests[0].system[1].cache_control);
  assert.deepEqual(r.issues, [], "$75 comes from the promotion");
});
await test("long conversations are trimmed to the recent turns", async () => {
  const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));
  const s = scripted([{ stop_reason: "end_turn", content: [txt("Sure.")] }]);
  await runLeanTurn({ catalog, model: "m", messages: [...long, { role: "user", content: "hi" }], latestUserMessage: "hi", callModel: s.callModel, log: quiet });
  assert.ok(s.requests[0].messages.length <= 24);
  assert.equal(s.requests[0].messages[0].role, "user");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
