// True Fit in the chat — the server side: what the widget may report, and
// the tool Claude gets (shoes only, real products only, a button event).
//
// Run: node scripts/eval-size-finder.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const { sanitizeSizeFinder, trueFitTool } = await import("../app/lib/lean/size-finder.server.js");
const { productKind } = await import("../app/lib/lean/catalog.js");
const { toCard } = await import("../app/lib/lean/engine.js");
const { finderToolDef } = await import("../app/lib/orthotic-finder.server.js");
const { trueFitIntro, TRUE_FIT_INTRO_TEXT, TRUE_FIT_PICK_NOTE } = await import("../app/lib/lean/true-fit-intro.js");
const { normalizeProduct } = await import("../app/lib/lean/catalog.js");
const { describeExtras } = await import("../app/lib/chat-recording.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const PRODUCTS = {
  "jillian-black": { handle: "jillian-black", title: "Jillian Sandal - Black", productType: "Footwear" },
  "l2300w-m": { handle: "l2300w-m", title: "Premium Memory Foam Orthotics", productType: "Orthotics" },
};
const lookup = async (_shop, handle) => PRODUCTS[handle] || null;
// A small store for "pick a shoe first": shoes of several kinds in two lines.
const row = (handle, title, cat, gender, { qty = 4, rating = "4.5", reviews = "40", image = `https://cdn.shopify.com/s/files/${handle}.jpg?v=1`, type = "Footwear" } = {}) => normalizeProduct({
  handle, title, productType: type, featuredImageUrl: image, tags: [], description: "",
  attributesJson: { category_for_filter: cat, ...(gender ? { gender } : {}), rating, review_count: reviews },
  variants: [{ price: "120", compareAtPrice: null, inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }],
});
const STORE = { products: [
  row("danika-white", "Danika Sneaker - White", "Sneakers", "women", { rating: "4.8", reviews: "900" }),
  row("danika-navy", "Danika Sneaker - Navy", "Sneakers", "women", { rating: "4.1", reviews: "12" }),
  row("carly-white", "Carly Sneaker - White", "Sneakers", "women"),
  row("janey-black", "Janey Sneaker - Black", "Sneakers", "women", { rating: "4.2", reviews: "30" }),
  row("jillian-black", "Jillian Sandal - Black", "Sandals", "women"),
  row("savannah-red", "Savannah Sandal - Red", "Sandals", "women"),
  row("chase-black", "Chase Sneaker - Black", "Sneakers", "men"),
  row("cooper-brown", "Cooper Boot - Brown", "Boots", "unisex"),
  row("cozy-grey", "Cozy Slipper - Grey", "Slippers", ""),
  row("sold-out-wedge", "Sold Out Wedge - Tan", "Wedges", "women", { qty: 0 }),
  row("l2300", "Premium Memory Foam Orthotics", "Orthotics", "women", { type: "Orthotics" }),
] };
const tool = (sizeFinder) => trueFitTool({ shop: "s.myshopify.com", sizeFinder, lookup, loadCatalog: async () => STORE });

console.log("\nwhat the widget may report");
await test("only True Fit is accepted; the page handle is kept only when it's a real handle", () => {
  assert.equal(sanitizeSizeFinder(null), null);
  assert.equal(sanitizeSizeFinder({ provider: "other" }), null);
  assert.deepEqual(sanitizeSizeFinder({ provider: "truefit", page_handle: "Jillian-Black" }), { provider: "truefit", pageHandle: "jillian-black" });
  assert.deepEqual(sanitizeSizeFinder({ provider: "truefit", page_handle: "<script>" }), { provider: "truefit", pageHandle: "" });
});

console.log("\nthe tool Claude gets");
await test("no True Fit on the store → no tool", () => {
  assert.equal(tool(null), null);
});
await test("on a shoe's page the page note names that shoe; the tool's own text is the same everywhere", () => {
  const onPage = tool({ provider: "truefit", pageHandle: "jillian-black" });
  const elsewhere = tool({ provider: "truefit", pageHandle: "" });
  assert.match(onPage.pageNote, /"jillian-black"/);
  assert.equal(elsewhere.pageNote, "");
  assert.equal(onPage.definition.description, elsewhere.definition.description, "cached prompt stays the same across pages");
});
await test("a shoe → a Find my size button event with its real title", async () => {
  const r = await tool({ provider: "truefit", pageHandle: "" }).run({ handle: "jillian-black" });
  assert.equal(r.ok, true);
  assert.deepEqual(r._events, [{ type: "size_finder", provider: "truefit", handle: "jillian-black", title: "Jillian Sandal - Black" }]);
});
await test("orthotics, unknown handles and junk are refused with a reason Claude can act on", async () => {
  const t = tool({ provider: "truefit", pageHandle: "" });
  assert.match((await t.run({ handle: "l2300w-m" })).error, /for shoes/);
  assert.match((await t.run({ handle: "made-up-shoe" })).error, /search for the shoe first/);
  assert.match((await t.run({ handle: "../../admin" })).error, /handle/);
});
await test("no shoe picked yet → how True Fit works, with the store's kinds of shoes (never a guessed size)", async () => {
  const t = tool({ provider: "truefit", pageHandle: "" });
  const r = await t.run({});
  assert.equal(r.ok, true);
  assert.equal(r._events.length, 1);
  assert.equal(r._events[0].type, "size_intro");
  assert.match(r.note, /pick the shoe first/);
  assert.match(r.note, /Don't list the kinds of shoe, show products or guess a size/);
  assert.deepEqual((await t.run({ handle: "" }))._events[0], r._events[0], "an empty handle is the same as none");
  const d = t.definition;
  assert.match(d.description, /True Fit sizes one shoe at a time/);
  assert.match(d.description, /real fit data from shoppers who bought that shoe/);
  assert.match(d.description, /call it without a handle/);
  assert.match(d.description, /tap the True Fit button on the one they like/);
  assert.deepEqual(d.input_schema.required, undefined, "the handle is optional");
});
await test("a store with no kinds of shoe to offer → the tool asks which shoe instead", async () => {
  const t = trueFitTool({ shop: "s", sizeFinder: { provider: "truefit", pageHandle: "" }, lookup, loadCatalog: async () => ({ products: [STORE.products[0]] }) });
  assert.match((await t.run({})).error, /one shoe at a time/);
});

console.log("\n\"Find my shoe size\" with no shoe picked: the store's own kinds of shoe");
const intro = trueFitIntro(STORE, { primaryLine: "women" });
const tilesOf = (k) => intro.lines.find((l) => l.k === k).tiles;
await test("one line per line the store sells, in order, starting on the store's main line", () => {
  assert.equal(intro.type, "size_intro");
  assert.equal(intro.provider, "truefit");
  assert.deepEqual(intro.lines.map((l) => [l.k, l.l]), [["women", "Women's"], ["men", "Men's"]]);
  assert.equal(intro.line, "women");
});
await test("styles are counted once across colorways; in-stock shoes only; never orthotics", () => {
  assert.deepEqual(tilesOf("women").map((t) => `${t.l}:${t.n}`), ["Sneakers:3", "Sandals:2", "Boots:1", "Slippers:1"]);
  assert.ok(!JSON.stringify(intro).includes("Wedges"), "sold out");
  assert.ok(!JSON.stringify(intro).includes("Orthotics"));
});
await test("unisex shoes are in both lines, and shoes with no line given in every line", () => {
  assert.deepEqual(tilesOf("men").map((t) => `${t.l}:${t.n}`), ["Boots:1", "Slippers:1", "Sneakers:1"]);
});
await test("each kind shows its best seller's photo, sized small on Shopify's CDN", () => {
  assert.equal(tilesOf("women")[0].img, "https://cdn.shopify.com/s/files/danika-white.jpg?v=1&width=320");
});
await test("at most six kinds per line, the biggest first", () => {
  const many = { products: ["A", "B", "C", "D", "E", "F", "G", "H"].flatMap((c, i) => Array.from({ length: 8 - i }, (_, j) => row(`${c}-${j}`, `${c} Shoe ${j}`, `${c} Shoes`, "women"))) };
  const t = trueFitIntro(many).lines[0].tiles;
  assert.deepEqual(t.map((x) => `${x.l}:${x.n}`), ["A Shoes:8", "B Shoes:7", "C Shoes:6", "D Shoes:5", "E Shoes:4", "F Shoes:3"]);
});
await test("no lines in the catalog: one list, no switch; fewer than two kinds: nothing (the assistant answers)", () => {
  const plain = trueFitIntro({ products: [row("a", "A Sneaker", "Sneakers", ""), row("b", "B Sandal", "Sandals", "")] });
  assert.deepEqual(plain.lines.map((l) => [l.k, l.l, l.tiles.length]), [["all", "", 2]]);
  assert.equal(trueFitIntro({ products: [row("a", "A Sneaker", "Sneakers", "women"), row("b", "B Sneaker", "Sneakers", "women")] }), null);
  assert.equal(trueFitIntro({ products: [] }), null);
  assert.equal(trueFitIntro(null), null);
});
await test("a non-https photo is left out; another CDN's photo is kept as it is", () => {
  const t = trueFitIntro({ products: [row("a", "A Sneaker", "Sneakers", "", { image: "http://x.test/a.jpg" }), row("b", "B Sandal", "Sandals", "", { image: "https://img.example/b.jpg" })] }).lines[0].tiles;
  assert.deepEqual(t.map((x) => x.img).sort(), ["", "https://img.example/b.jpg"]);
});
await test("the reply's words say why: one shoe at a time, the shoe first; a style tile asks for shoes with True Fit", () => {
  assert.match(TRUE_FIT_INTRO_TEXT, /True Fit sizes one shoe at a time, so pick the shoe first/);
  assert.match(TRUE_FIT_PICK_NOTE, /tap the True Fit button on the shoe they like/);
  assert.match(TRUE_FIT_PICK_NOTE, /Don't guess a size/);
});
await test("test recordings name it, with the kinds of shoe offered", () => {
  assert.equal(describeExtras([intro]), "True Fit — pick a shoe: Sneakers, Sandals, Boots, Slippers");
});

console.log("\neach fit tool only on its own products");
await test("products are told apart: shoes, orthotics, everything else", () => {
  assert.equal(productKind({ productType: "Footwear", category: "Sandals" }), "footwear");
  assert.equal(productKind({ productType: "Orthotics" }), "orthotic");
  assert.equal(productKind({ productType: "", category: "Insoles" }), "orthotic");
  assert.equal(productKind({ productType: "Accessories", category: "Socks" }), "other");
});
await test("every card says what it is, so the widget offers the right tool", () => {
  assert.equal(toCard({ title: "Jillian", handle: "j", url: "/products/j", productType: "Footwear", category: "Sandals", options: {} }).kind, "footwear");
  assert.equal(toCard({ title: "L2300", handle: "l", url: "/products/l", productType: "Orthotics", options: {} }).kind, "orthotic");
});
await test("the orthotic finder says it never sizes or picks shoes", () => {
  const def = finderToolDef({ intent: "orthotic", definition: { finder: { lines: [] } } }, { fitfinder: null });
  assert.match(def.description, /Orthotics only: it never sizes or picks shoes/);
  assert.match(tool({ provider: "truefit", pageHandle: "" }).definition.description, /Shoes only — never for orthotics/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
