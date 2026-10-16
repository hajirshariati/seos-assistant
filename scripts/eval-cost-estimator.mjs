// Cost estimator accuracy.
//
// Usage summaries count chat replies only (image previews separate); the
// estimator uses real Shopify sessions, a per-reply cost measured from
// recorded replies (cold cache writes normalised) or priced from the store's
// real setup, and the cache-warmth effect of traffic volume. Pure modules →
// no DB, no React render.
//
// Run: node scripts/eval-cost-estimator.mjs

import assert from "node:assert/strict";
import { summarizeUsageRecords } from "../app/lib/usage-summary.js";
import { register } from "node:module";
import {
  CALC_MIN_SAMPLE,
  resolvePerReply,
  warmAverage,
  coldShare,
  monthlyEstimate,
  summarizeTraffic,
} from "../app/lib/cost-estimator-math.js";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const { buildLeanCatalog } = await import("../app/lib/lean/catalog.js");
const { measureStore, replyCost, coldStartExtra } = await import("../app/lib/lean/cost-model.js");
const { withConversationCache } = await import("../app/lib/lean/engine.js");
const { MODEL_PRICING } = await import("../app/lib/pricing.server.js");

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

const day = (d) => new Date(`2026-06-0${d}T10:00:00Z`);
const chatRow = (cost, emb = 0) => ({ model: "claude-sonnet", costUsd: cost, embeddingCostUsd: emb, inputTokens: 100, outputTokens: 50, toolCalls: 1, createdAt: day(1) });
const imageRow = (cost) => ({ model: "image:gemini", imageCostUsd: cost, imageCount: 1, costUsd: 0, createdAt: day(2) });

console.log("\ncost-estimator accuracy eval\n");

// ── Problem 2: chat-only cost excludes image previews ──
test("chatOnlyCost = Anthropic chat + embeddings, image previews excluded", () => {
  const s = summarizeUsageRecords([chatRow(0.006, 0.0005), chatRow(0.006, 0.0005), imageRow(0.04)], "a", "b");
  assert.equal(s.totalMessages, 2, "image rows are not chat messages");
  assert.ok(Math.abs(s.chatOnlyCost - 0.013) < 1e-9, `chatOnlyCost=${s.chatOnlyCost}`);
  assert.ok(Math.abs(s.imageCost - 0.04) < 1e-9, "image cost kept separate");
  assert.ok(Math.abs(s.totalCost - 0.053) < 1e-9, "totalCost still includes image");
});

test("avgChatCostPerMessage = chatOnlyCost / totalMessages (not total avg)", () => {
  const s = summarizeUsageRecords([chatRow(0.006), chatRow(0.006), imageRow(0.04)], "a", "b");
  assert.ok(Math.abs(s.avgChatCostPerMessage - 0.006) < 1e-9, `avgChat=${s.avgChatCostPerMessage}`);
  // The all-in average is inflated by the image preview — and is NOT what the
  // estimator uses.
  assert.ok(s.avgCostPerMessage > s.avgChatCostPerMessage, "all-in avg is higher");
  assert.ok(Math.abs(s.avgCostPerMessage - 0.026) < 1e-9, `avgAll=${s.avgCostPerMessage}`);
});

test("adding image previews does NOT change avgChatCostPerMessage", () => {
  const base = summarizeUsageRecords([chatRow(0.006), chatRow(0.008)], "a", "b");
  const withImages = summarizeUsageRecords([chatRow(0.006), chatRow(0.008), imageRow(0.04), imageRow(0.04)], "a", "b");
  assert.ok(Math.abs(base.avgChatCostPerMessage - withImages.avgChatCostPerMessage) < 1e-12, "image clicks must not move the chat rate");
  assert.equal(withImages.imageCount, 2, "image count tracked separately");
});

test("empty / no-message window → safe zeros", () => {
  const s = summarizeUsageRecords([], "a", "b");
  assert.equal(s.avgChatCostPerMessage, 0);
  assert.equal(s.chatOnlyCost, 0);
});

// ── Per-reply cost: measured beats modeled once there are enough replies ──
test("measured average is used from 25 replies; before that the store's modeled cost", () => {
  const modeled = { perReply: 0.017 };
  assert.deepEqual(resolvePerReply({ measured: { replies: CALC_MIN_SAMPLE, avgCost: 0.012 }, modeled }), { perReply: 0.012, source: "measured" });
  assert.deepEqual(resolvePerReply({ measured: { replies: CALC_MIN_SAMPLE - 1, avgCost: 0.012 }, modeled }), { perReply: 0.017, source: "modeled" });
  assert.equal(resolvePerReply({}).source, "none");
});

test("cold replies (instructions re-cached) are normalised so test chats don't overstate cost", () => {
  const rows = [
    { cost: 0.03, cacheWriteTokens: 3200, internal: true },  // cold: wrote the 3,100-token instructions
    { cost: 0.018, cacheWriteTokens: 1300, internal: false }, // warm
  ];
  const w = warmAverage(rows, { prefixTokens: 3100, coldStartExtra: 0.012 });
  assert.equal(w.coldReplies, 1);
  assert.equal(w.testReplies, 1);
  assert.ok(Math.abs(w.avgCost - 0.018) < 1e-9, `avg=${w.avgCost}`);
});

test("cache warmth follows traffic: busy stores almost never pay the cold write", () => {
  assert.ok(coldShare(50000) < 0.01, `50k replies/mo → ${coldShare(50000)}`);
  assert.ok(coldShare(300) > 0.9, `300 replies/mo → ${coldShare(300)}`);
});

test("monthly estimate = sessions × chat share × replies × rate (+ cold share)", () => {
  const e = monthlyEstimate({ sessions: 787000, engagementPct: 2, repliesPerChat: 3, perReply: 0.017, coldStartExtra: 0.012 });
  assert.equal(Math.round(e.chats), 15740);
  assert.equal(Math.round(e.replies), 47220);
  assert.ok(e.rate > 0.017 && e.rate < 0.0171, `rate=${e.rate}`);
  assert.ok(Math.abs(e.cost - e.replies * e.rate) < 1e-6);
});

// ── Real traffic from Shopify Analytics ──
test("traffic: last 12 full months only (current month and partial first month dropped)", () => {
  const rows = [
    ["2025-09", 120000], ["2025-10", 251515], ["2025-11", 681817], ["2025-12", 393645], ["2026-01", 579344],
    ["2026-02", 637463], ["2026-03", 656404], ["2026-04", 772474], ["2026-05", 1119309], ["2026-06", 870958],
    ["2026-07", 902696], ["2026-08", 1035418], ["2026-09", 1012183], ["2026-10", 416234],
  ].map(([month, sessions]) => ({ month, sessions }));
  const t = summarizeTraffic(rows, new Date("2026-10-16T12:00:00Z"));
  assert.equal(t.months.length, 12);
  assert.equal(t.months[0].month, "2025-10");
  assert.equal(t.months.at(-1).month, "2026-09");
  assert.equal(t.peak.month, "2026-05");
  assert.equal(t.low.month, "2025-10");
  assert.equal(t.average, Math.round(t.yearTotal / 12));
  assert.equal(summarizeTraffic([], new Date()).error, "no data");
});

// ── Pricing a reply from the store's real setup ──
const rows = Array.from({ length: 60 }, (_, i) => ({
  handle: `p-${i}`, title: `Style${i} Arch Support Sandal - ${["Black", "Navy", "Rose"][i % 3]}`, productType: "Footwear",
  tags: ["Plantar Fasciitis", "Arch Pain"], description: "Arch support all day. ".repeat(20), status: "ACTIVE",
  attributesJson: { category_for_filter: ["Sandals", "Sneakers", "Wedges/Heels"][i % 3], gender: i % 2 ? "Women" : "Men", helps_with: ["Plantar Fasciitis", "Heel Pain"] },
  variants: [{ price: "99.95", inventoryQty: 4, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }],
}));
const catalog = buildLeanCatalog(rows, { shop: "s.myshopify.com" });
const measured = measureStore({ catalog, shop: "s.myshopify.com", extraSystemText: "ACTIVE PROMOTIONS\nNone." });

test("the cost model measures the store's real instructions and search results", () => {
  assert.ok(measured.prefixTokens > 1500, `prefix=${measured.prefixTokens}`);
  assert.ok(measured.searchTokens > 300, `search=${measured.searchTokens}`);
  assert.equal(measured.products, 60);
});

test("per-reply cost is in a sane range and follows the model's price", () => {
  const sonnet = replyCost(MODEL_PRICING["claude-sonnet-4-6"], measured).perReply;
  const haiku = replyCost(MODEL_PRICING["claude-haiku-4-5-20251001"], measured).perReply;
  assert.ok(sonnet > 0.005 && sonnet < 0.05, `sonnet=${sonnet}`);
  assert.ok(Math.abs(haiku / sonnet - 1 / 3) < 0.01, `haiku/sonnet=${haiku / sonnet}`);
  assert.ok(coldStartExtra(MODEL_PRICING["claude-sonnet-4-6"], measured) > 0);
});

test("the engine caches the growing conversation: only the newest message is marked", () => {
  const conv = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_products", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
  ];
  const out = withConversationCache(conv);
  assert.equal(JSON.stringify(out).match(/cache_control/g).length, 1);
  assert.deepEqual(out[2].content[0].cache_control, { type: "ephemeral" });
  assert.equal(conv[2].content[0].cache_control, undefined, "input not mutated");
  assert.deepEqual(withConversationCache([{ role: "user", content: "hello" }])[0].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
