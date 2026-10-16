// Recommender ID repair — an orthotic finder saved with a placeholder ID
// ("a-z", copied from the old help text) must still reach the chat, which
// looks for intent "orthotic".
//
// Run: node scripts/eval-recommender-intent.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));

let rows = [];
const pick = (r, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r);
global.prismaGlobal = {
  decisionTree: {
    findMany: async ({ where, select }) => rows.filter((r) => r.shop === where.shop && (where.enabled == null || r.enabled === where.enabled)).map((r) => pick(r, select)),
    findUnique: async ({ where }) => rows.find((r) => r.shop === where.shop_intent.shop && r.intent === where.shop_intent.intent) || null,
    update: async ({ where, data }) => { const r = rows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    create: async ({ data }) => { const r = { id: `t${rows.length + 1}`, ...data }; rows.push(r); return r; },
  },
};
const origLog = console.log;

const { getDecisionTreeByIntent, getEnabledDecisionTrees, saveDecisionTree, isPlaceholderIntent } = await import("../app/models/DecisionTree.server.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  console.log = () => {};
  try { await fn(); passed += 1; origLog(`  ✓ ${name}`); }
  catch (err) { failed += 1; origLog(`  ✗ ${name} — ${err.message}`); }
  finally { console.log = origLog; }
}
const SHOP = "demo.myshopify.com";
const finder = (intent, extra = {}) => ({ id: "t1", shop: SHOP, name: "Aetrex Orthotic Finder", intent, enabled: true, triggerPhrases: "[]", triggerCategoryGroup: null, definition: {}, ...extra });

console.log("\nrecommender ID");

await test("placeholder IDs are recognised, real ones are not", () => {
  for (const v of ["a-z", "a-z0-9", "A-Z", "slug", "test"]) assert.ok(isPlaceholderIntent(v), v);
  for (const v of ["orthotic", "footwear", "mattress", "insole_finder"]) assert.ok(!isPlaceholderIntent(v), v);
});

await test('"Sync from Shopify" finds an orthotic finder saved as "a-z" and fixes it', async () => {
  rows = [finder("a-z")];
  const t = await getDecisionTreeByIntent(SHOP, "orthotic");
  assert.ok(t, "found");
  assert.equal(rows[0].intent, "orthotic");
});

await test("the chat sees it as the orthotic finder", async () => {
  rows = [finder("a-z")];
  const trees = await getEnabledDecisionTrees(SHOP);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].intent, "orthotic");
});

await test("never renames when a real orthotic tree already exists, or for unrelated trees", async () => {
  rows = [finder("orthotic"), finder("a-z", { id: "t2", name: "Old orthotic copy" })];
  await getEnabledDecisionTrees(SHOP);
  assert.equal(rows[1].intent, "a-z");
  rows = [finder("a-z", { name: "Mattress Finder" })];
  assert.equal(await getDecisionTreeByIntent(SHOP, "orthotic"), null);
  assert.equal(rows[0].intent, "a-z");
});

await test("saving with a placeholder ID: orthotic finder is corrected, others get a clear error", async () => {
  rows = [];
  const saved = await saveDecisionTree(SHOP, { name: "Aetrex Orthotic Finder", intent: "a-z", definition: {}, enabled: true });
  assert.equal(saved.intent, "orthotic");
  await assert.rejects(() => saveDecisionTree(SHOP, { name: "Mattress Finder", intent: "a-z", definition: {} }), /isn't a usable ID/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
