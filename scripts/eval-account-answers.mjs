// Questions about the shopper's own account are looked into, not passed on:
// their rewards account (balance, tier and points history from Yotpo), read
// safely whatever shape the history comes in, for the signed-in shopper only,
// and said plainly when it can't be seen.
//
// Run: node scripts/eval-account-answers.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// The app's extension-less imports, and no database (nothing here reads one).
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
const { loyaltyHistory, fetchYotpoLoyalty } = await import("../app/lib/yotpo-loyalty.server.js");
const { rewardsTool, REWARDS_TOOL } = await import("../app/lib/lean/store-tools.server.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

console.log("\npoints history");
await test("Yotpo's history items: day, what for, points, status, order — newest first", () => {
  const h = loyaltyHistory({ history_items: [
    { date: "2026-09-02T10:00:00Z", action: "Made a purchase", points: 930, status: "Approved", order_id: "1160741" },
    { date: "2026-10-20T15:00:00Z", action: "Refund", points: -930, status: "Approved", order_id: "1160741" },
    { date: "2026-09-01T09:00:00Z", action: "Redeemed $10 off", points: -2000, status: "Approved" },
  ] });
  assert.deepEqual(h.map((x) => [x.date, x.action, x.points, x.status, x.order]), [
    ["2026-10-20", "Refund", -930, "Approved", "1160741"],
    ["2026-09-02", "Made a purchase", 930, "Approved", "1160741"],
    ["2026-09-01", "Redeemed $10 off", -2000, "Approved", undefined],
  ]);
});
await test("other field names and formats are read too; junk entries are skipped", () => {
  const h = loyaltyHistory({ history: [
    { created_at: "Oct 3, 2026", action_name: "Pending purchase points", points_earned: "1,250", state: "Pending", order_ids: ["1170001", "1170002"] },
    { date: "2026-10-01", points: "n/a", action: "bad points" },
    { date: "someday", points: 5, action: "bad date" },
    null, "x",
    { date: "2026-09-30", points: 50 },
  ] });
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { date: "2026-10-03", action: "Pending purchase points", points: 1250, status: "Pending", order: "1170001, 1170002" });
  assert.equal(h[1].action, "Points added", "an entry without a label says what it did");
  assert.deepEqual(loyaltyHistory({}), []);
  assert.deepEqual(loyaltyHistory(null), []);
  assert.equal(loyaltyHistory({ history_items: Array.from({ length: 50 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, points: i })) }).length, 30, "at most 30");
});
await test("the lookup asks for the history, keeps it apart from the plain balance, and tells a failure from no account", async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ points_balance: 4200, vip_tier_name: "Gold", history_items: [{ date: "2026-10-20", action: "Refund", points: -930, status: "Approved" }] }), { status: 200 }); };
    const r = await quietly(() => fetchYotpoLoyalty({ apiKey: "k1-histo-key", email: "jo@x.com", history: true }));
    assert.match(urls[0], /customer_email=jo%40x\.com&with_history=true$/);
    assert.equal(r.pointsBalance, 4200);
    assert.equal(r.historyListed, true);
    assert.deepEqual(r.history, [{ date: "2026-10-20", action: "Refund", points: -930, status: "Approved" }]);
    const plain = await quietly(() => fetchYotpoLoyalty({ apiKey: "k1-histo-key", email: "jo@x.com" }));
    assert.doesNotMatch(urls[1], /with_history/, "the plain balance is its own lookup");
    assert.equal(plain.history, undefined);
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    assert.equal(await quietly(() => fetchYotpoLoyalty({ apiKey: "k2-histo-key", email: "no@x.com", history: true })), null, "no account");
    globalThis.fetch = async () => { throw new Error("down"); };
    assert.deepEqual(await quietly(() => fetchYotpoLoyalty({ apiKey: "k3-histo-key", email: "jo@x.com", history: true })), { unavailable: true }, "the lookup failed");
  } finally { globalThis.fetch = realFetch; }
});

console.log("\nthe rewards tool");
const member = { pointsBalance: 4200, tier: "Gold", creditBalance: 0, historyListed: true, history: [{ date: "2026-10-20", action: "Refund", points: -930, status: "Approved", order: "1160741" }] };
const tool = (over = {}) => rewardsTool({ shop: "s", accessToken: "t", loggedInCustomerId: "77", config: { yotpoLoyaltyApiKey: "k" }, emailOf: async () => "jo@x.com", fetchLoyalty: async () => member, ...over });
await test("signed in: balance, tier and the history — in points, or points with dollars when the store shows dollars", async () => {
  const r = await tool().run();
  assert.equal(r.signed_in, true); assert.equal(r.member, true);
  assert.equal(r.balance, "4200 points"); assert.equal(r.tier, "Gold");
  assert.deepEqual(r.history, [{ date: "2026-10-20", action: "Refund", points: "-930 points", status: "Approved", order: "1160741" }]);
  assert.match(r.note, /Answer from these entries/);
  assert.match(r.note, /say plainly that it isn't in their history — don't guess why/);
  assert.ok(!JSON.stringify(r).includes("@"), "never the email");
  const d = await tool({ config: { yotpoLoyaltyApiKey: "k", loyaltyDisplay: "dollars", loyaltyPointsPerDollar: 200 } }).run();
  assert.equal(d.balance, "4200 points ($21.00)");
  assert.equal(d.history[0].points, "-930 points ($-4.65)");
});
await test("the lookup is for the signed-in shopper's own email, with the history", async () => {
  let got = null;
  await tool({ fetchLoyalty: async (a) => { got = a; return member; } }).run();
  assert.deepEqual({ email: got.email, history: got.history, apiKey: got.apiKey }, { email: "jo@x.com", history: true, apiKey: "k" });
});
await test("signed out: a sign-in card for points — no email asked, not passed to customer service", async () => {
  let looked = false;
  const r = await tool({ loggedInCustomerId: null, fetchLoyalty: async () => { looked = true; return member; } }).run();
  assert.equal(r.signed_in, false);
  assert.deepEqual(r._events, [{ type: "login_prompt", intent: "rewards" }]);
  assert.match(r.note, /Don't ask for their email, and don't send them to customer service for this/);
  assert.equal(looked, false);
});
await test("no account, a failed lookup, no email, only a balance, an empty history: each said plainly", async () => {
  assert.match((await tool({ fetchLoyalty: async () => null }).run()).note, /No rewards account was found/);
  assert.match((await tool({ fetchLoyalty: async () => ({ unavailable: true }) }).run()).error, /don't guess a balance/);
  assert.match((await tool({ emailOf: async () => "" }).run()).error, /can't be looked up right now/);
  assert.match((await tool({ emailOf: async () => { throw new Error("x"); } }).run()).error, /can't be looked up right now/);
  const bal = await tool({ fetchLoyalty: async () => ({ pointsBalance: 10, historyListed: false, history: [] }) }).run();
  assert.equal(bal.history, undefined); assert.match(bal.note, /can't see the individual entries/);
  assert.match((await tool({ fetchLoyalty: async () => ({ pointsBalance: 0, historyListed: true, history: [] }) }).run()).note, /no points entries yet/);
});
await test("the tool says when to use it and to look into orders and policy together", () => {
  assert.equal(REWARDS_TOOL.name, "get_my_rewards");
  assert.match(REWARDS_TOOL.description, /whether points came back after a return/);
  assert.match(REWARDS_TOOL.description, /get_my_orders, intent \\?"refunds\\?"/);
  assert.match(REWARDS_TOOL.description, /search_store_info/);
});

console.log("\nthe rules");
await test("account questions are an investigation: orders, rewards, the store's policy — then facts, then (only then) customer service", () => {
  const p = buildLeanSystemPrompt({ config: {}, vocab: {}, shop: "s" });
  assert.match(p, /is an investigation, not a hand-off/);
  assert.match(p, /get_my_orders; intent \\?"refunds\\?"/);
  assert.match(p, /get_my_rewards, if you have it/);
  assert.match(p, /what happens to points when an order is returned/);
  assert.match(p, /never guess or fill a gap/);
  assert.match(p, /say what you checked and found, so they don't have to explain it again/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
