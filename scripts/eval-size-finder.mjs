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
const tool = (sizeFinder) => trueFitTool({ shop: "s.myshopify.com", sizeFinder, lookup });

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
  assert.match((await t.run({ handle: "" })).error, /handle/);
  assert.match((await t.run({ handle: "../../admin" })).error, /handle/);
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
