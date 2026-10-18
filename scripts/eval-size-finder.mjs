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
await test("on a shoe's page the tool names that shoe; elsewhere it doesn't", () => {
  assert.match(tool({ provider: "truefit", pageHandle: "jillian-black" }).definition.description, /"jillian-black"/);
  assert.doesNotMatch(tool({ provider: "truefit", pageHandle: "" }).definition.description, /right now/);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
