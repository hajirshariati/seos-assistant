// Deals (app/lib/deals.js): the products on sale ranked honestly, campaigns
// and page lines as offers, the model's structuring checked word by word
// against the page — nothing the store didn't write.
//
// Run: node scripts/eval-deals.mjs
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
process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";

const { dealsConfig, saleProducts, offerFromCampaign, offersFromLines, validateOffers, structurePrompt, parseStructured, endsWords, discountShare } = await import("../app/lib/deals.js");
const { structureOffers, clearDealsCache } = await import("../app/lib/deals.server.js");
const { buildLeanCatalog } = await import("../app/lib/lean/catalog.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const quietly = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

const row = (title, price, compareAt, { stock = 3 } = {}) => ({
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, productType: "Footwear", tags: [], description: "", status: "ACTIVE", featuredImageUrl: "https://img/x.jpg",
  attributesJson: { category_for_filter: "Sandals", gender: "women" },
  variants: [{ price: String(price), compareAtPrice: compareAt == null ? null : String(compareAt), inventoryQty: stock, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }],
});
const catalog = buildLeanCatalog([
  row("Savannah Sandal - Red", 99.95, 129.95),
  row("Savannah Sandal - Black", 89.95, 129.95),
  row("Maeve Slip-On - Taupe", 59.95, 99.95),
  row("Blake Sandal - Tan", 49.95, 99.95, { stock: 0 }),
  row("Chase Sneaker - Red", 149.95, null),
  row("Ashley Wedge - Navy", 119.95, 139.95),
], { shop: "s.myshopify.com" });

console.log("\nthe products on sale");
await test("best savings first, one card per style, in stock only, full-price products left out", () => {
  const list = saleProducts(catalog);
  assert.deepEqual(list.map((p) => p.title), ["Maeve Slip-On - Taupe", "Savannah Sandal - Black", "Ashley Wedge - Navy"]);
  assert.ok(discountShare(list[0]) > 0.39 && discountShare(list[0]) < 0.41);
  assert.equal(saleProducts(catalog, { limit: 1 }).length, 1);
  assert.deepEqual(saleProducts({ products: [] }), []);
});

console.log("\noffers");
await test("a campaign becomes an offer: its name, its first line, its end; a name-only campaign has no detail", () => {
  const o = offerFromCampaign({ name: "Labor Day Sale", content: "# Labor Day Sale\n25% off sitewide with code LABOR25\nExcludes gift cards", endsAt: "2026-09-08T23:59:00-04:00" });
  assert.equal(o.title, "Labor Day Sale"); assert.equal(o.detail, "25% off sitewide with code LABOR25"); assert.match(o.ends, /^2026-09-09T/);
  assert.equal(offerFromCampaign({ name: "Free socks", content: "Free socks", endsAt: null }).detail, "");
  assert.equal(endsWords("2026-11-09T04:59:00.000Z"), "Nov 8"); assert.equal(endsWords("Sunday night"), "Sunday night"); assert.equal(endsWords(""), "");
});
const PAGE = ["20% off all boots with code FALL20 — ends 11/2.", "Free shipping on orders over $75 (lower 48 states).", "Buy an orthotic, get a free pair of socks."];
await test("the model's lines are kept only when the page backs them: numbers, codes and dates must be on the page; invented offers are dropped", () => {
  const out = validateOffers([
    { title: "20% off all boots", detail: "Use code at checkout", code: "FALL20", ends: "11/2" },
    { title: "Free shipping over $75", detail: "Lower 48 states", code: "", ends: "" },
    { title: "30% off sandals", detail: "", code: "", ends: "" },
    { title: "Free socks with an orthotic", detail: "", code: "SOCKS", ends: "" },
    { title: "Free socks with an orthotic", detail: "", code: "", ends: "" },
    { title: "20% off all boots", detail: "", code: "FALL20", ends: "" },
  ], PAGE.join("\n"));
  assert.deepEqual(out.map((o) => o.title), ["20% off all boots", "Free shipping over $75", "Free socks with an orthotic"]);
  assert.equal(out[0].code, "FALL20"); assert.equal(out[0].ends, "11/2");
  assert.equal(validateOffers([{ title: "20% off all boots", detail: "Save $50 today", code: "", ends: "" }], PAGE.join("\n"))[0].detail, "", "a detail with a number the page lacks is dropped");
  assert.equal(validateOffers([{ title: "20% off all boots", detail: "", code: "", ends: "Nov 30" }], PAGE.join("\n"))[0].ends, "", "an end the page doesn't give is dropped");
  assert.deepEqual(validateOffers("nonsense", PAGE.join("\n")), []);
});
await test("without a model the page's own lines stand; the prompt forbids inventing; the answer is read as JSON only", () => {
  assert.deepEqual(offersFromLines(PAGE).map((o) => o.title), PAGE);
  assert.match(structurePrompt("x"), /never add an offer, a code, an amount or a date that isn't in the text/);
  assert.deepEqual(parseStructured('Sure! [{"title":"a"}] thanks'), [{ title: "a" }]);
  assert.deepEqual(parseStructured("no json here"), []);
});
await test("the structuring runs the model once per text (cached by the text), checks its answer, and falls back to the lines when it fails", async () => {
  clearDealsCache();
  let calls = 0;
  const client = { messages: { create: async () => { calls += 1; return { content: [{ type: "text", text: '[{"title":"20% off all boots","detail":"Code at checkout","code":"FALL20","ends":"11/2"},{"title":"50% off everything","code":"","detail":"","ends":""}]' }] }; } } };
  const a = await structureOffers({ text: PAGE.join("\n"), apiKey: "k", client });
  assert.deepEqual(a.map((o) => o.title), ["20% off all boots"]);
  const b = await structureOffers({ text: PAGE.join("\n"), apiKey: "k", client });
  assert.equal(calls, 1, "the second read is the cache"); assert.deepEqual(b, a);
  clearDealsCache();
  const broken = { messages: { create: async () => { throw new Error("down"); } } };
  const c = await quietly(() => structureOffers({ text: PAGE.join("\n"), apiKey: "k", client: broken }));
  assert.deepEqual(c.map((o) => o.title), PAGE, "the lines as they are");
  assert.deepEqual(await structureOffers({ text: "", apiKey: "k", client }), []);
});
await test("the setting: on by default with an optional see-all link; off → no pill", () => {
  assert.deepEqual(dealsConfig({}), { on: true, label: "Deals", url: "" });
  assert.equal(dealsConfig({ dealsUrl: "/collections/sale" }).url, "/collections/sale");
  assert.equal(dealsConfig({ dealsUrl: "javascript:alert(1)" }).url, "");
  assert.equal(dealsConfig({ dealsCardOn: false }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
