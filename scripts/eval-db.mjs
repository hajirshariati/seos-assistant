// Database-backed checks — run against a real, migrated Postgres (pgvector).
// Skipped unless TEST_DATABASE_URL is set (CI provides one; locally:
// `TEST_DATABASE_URL=postgresql://... npm run eval:ci`). Uses throwaway
// shop names and deletes what it creates.
//
// Run: TEST_DATABASE_URL=postgresql://user@localhost:5432/test node scripts/eval-db.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

if (!process.env.TEST_DATABASE_URL) {
  console.log("\nskipped: set TEST_DATABASE_URL to a migrated test database\n\n0 passed, 0 failed");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY ||= "0".repeat(64);

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));

const { default: prisma } = await import("../app/db.server.js");
const { recordHealth, getHealthSummary, cleanupOldHealth } = await import("../app/models/ChatHealth.server.js");
const { saveCampaign } = await import("../app/models/Campaign.server.js");
const { saveDecisionTree, incrementCompletedCount } = await import("../app/models/DecisionTree.server.js");
const { getShopConfig, getShopConfigCached, updateShopConfig, saveKnowledgeFile, deleteKnowledgeFile, incrementRateLimitHits } = await import("../app/models/ShopConfig.server.js");
const { getChatPulse } = await import("../app/models/ChatHealth.server.js");
const { getUsageSummary } = await import("../app/models/ChatUsage.server.js");
const { recordFeedback, recordChatRating } = await import("../app/models/ChatFeedback.server.js");
const { syncCatalog } = await import("../app/models/Product.server.js");
const { healthCheck: healthz } = await import("../app/lib/health-check.server.js");
const { syncStoreKnowledge } = await import("../app/lib/store-knowledge/sync.server.js");

const A = `eval-a-${Date.now()}.myshopify.com`;
const B = `eval-b-${Date.now()}.myshopify.com`;
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
// Health rows are written fire-and-forget: wait until they've landed.
async function settle(shop = A, expected = 8) {
  for (let i = 0; i < 60; i++) {
    if ((await prisma.chatHealthEvent.count({ where: { shop } })) >= expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

console.log("\nhealth");
await test("/healthz reports the database up", async () => {
  const res = await healthz();
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.db, "ok");
});
await test("turn outcomes summarize into error rate and latency (test chats and shoppers who left excluded)", async () => {
  for (const ms of [800, 1200, 2000, 4000]) recordHealth({ shop: A, ok: true, latencyMs: ms });
  recordHealth({ shop: A, ok: false, errorKind: "upstream", latencyMs: 300 });
  recordHealth({ shop: A, ok: false, errorKind: "client_left", latencyMs: 9000 });
  recordHealth({ shop: A, ok: false, errorKind: "unknown", internal: true });
  recordHealth({ shop: A, route: "visualize", ok: true, latencyMs: 12000 });
  await settle();
  const s = await getHealthSummary(A, { hours: 1 });
  assert.equal(s.chat.total, 6);
  assert.equal(s.chat.failed, 1);
  assert.equal(s.chat.ok, 4);
  assert.equal(s.chat.errorRate, 1 / 5);
  assert.deepEqual(s.chat.errorsByKind, { upstream: 1 });
  assert.equal(s.chat.p50Ms, 2000);
  assert.equal(s.chat.p95Ms, 4000);
  assert.equal(s.visualize.ok, 1);
  await cleanupOldHealth();
  assert.equal((await getHealthSummary(A, { hours: 1 })).chat.total, 6, "recent rows survive cleanup");
});

console.log("\none store can't touch another's records");
await test("saving a campaign with another store's id fails and changes nothing", async () => {
  const day = 24 * 3600e3;
  const theirs = await saveCampaign(A, { name: "A sale", content: "10% off", startsAt: new Date(), endsAt: new Date(Date.now() + day) });
  await assert.rejects(saveCampaign(B, { id: theirs.id, name: "hijack", content: "100% off", startsAt: new Date(), endsAt: new Date(Date.now() + day) }));
  const row = await prisma.campaign.findUnique({ where: { id: theirs.id } });
  assert.equal(row.name, "A sale");
  assert.equal(row.shop, A);
});
await test("saving a recommender with another store's id fails and changes nothing", async () => {
  const theirs = await saveDecisionTree(A, { name: "Finder", intent: "orthotic", definition: {}, enabled: true });
  await assert.rejects(saveDecisionTree(B, { id: theirs.id, name: "hijack", intent: "orthotic", definition: {}, enabled: false }));
  await incrementCompletedCount(B, theirs.id);
  const row = await prisma.decisionTree.findUnique({ where: { id: theirs.id } });
  assert.equal(row.name, "Finder");
  assert.equal(row.completedCount, 0, "another store can't bump the counter");
});
await test("deleting a knowledge file with another store's id deletes nothing", async () => {
  const f = await saveKnowledgeFile(A, { fileName: "faq.txt", fileType: "faq", fileSize: 3, content: "abc" });
  await deleteKnowledgeFile(B, f.id);
  assert.ok(await prisma.knowledgeFile.findUnique({ where: { id: f.id } }));
  await deleteKnowledgeFile(A, f.id);
  assert.equal(await prisma.knowledgeFile.findUnique({ where: { id: f.id } }), null);
});

console.log("\ncounters and stored feedback");
await test("AI rate-limit hits are counted per month", async () => {
  await getShopConfig(A);
  await incrementRateLimitHits(A);
  await incrementRateLimitHits(A);
  const c = await prisma.shopConfig.findUnique({ where: { shop: A } });
  assert.equal(c.rateLimitHits, 2);
  assert.match(c.rateLimitHitsMonth, /^\d{4}-\d{2}$/);
});
await test("a new store gets the current default model", async () => {
  const c = await getShopConfig(B);
  assert.equal(c.anthropicModel, "claude-sonnet-4-6");
});
await test("feedback transcripts drop emails and phone numbers; the IP is a keyed hash", async () => {
  const row = await recordFeedback({
    shop: A, sessionId: "s1", vote: "down", botResponse: "ok", products: ["Jillian", { title: "Savannah" }],
    conversation: [{ role: "user", content: "email me at jane.doe@gmail.com or (201) 555-0134" }, { role: "system", content: "x" }],
    ip: "203.0.113.9",
  });
  assert.doesNotMatch(row.conversation, /jane\.doe|555-0134/);
  assert.equal(JSON.parse(row.conversation).length, 1, "only user/assistant turns kept");
  assert.deepEqual(row.products, ["Jillian", "Savannah"]);
  assert.match(row.userHash, /^[0-9a-f]{16}$/);
});

await test("chat check-in: one rating per conversation; the comment updates it, contact details removed", async () => {
  const conv = [{ role: "user", content: "boots in 9" }, { role: "assistant", content: "Here are three." }];
  const first = await recordChatRating({ shop: A, sessionId: "rate-1", vote: "up", conversation: conv, ip: "203.0.113.9" });
  assert.equal(first.kind, "chat");
  assert.equal(first.comment, null);
  assert.equal(first.botResponse, "Here are three.");
  const again = await recordChatRating({ shop: A, sessionId: "rate-1", vote: "up", comment: "Great — mail me at jane@x.com", conversation: conv, ip: "203.0.113.9" });
  assert.equal(again.id, first.id, "the same row");
  assert.match(again.comment, /Great — mail me at \[email\]/);
  assert.equal(await prisma.chatFeedback.count({ where: { shop: A, sessionId: "rate-1" } }), 1);
  const answer = await recordFeedback({ shop: A, sessionId: "rate-1", vote: "down", botResponse: "x", products: [], conversation: null, ip: "" });
  assert.equal(answer.kind, "answer", "Helpful / Not helpful stays its own kind");
});

await test("thumbs on one answer: the reason picked after a thumbs-down updates the same vote (by its key)", async () => {
  const conv = [{ role: "user", content: "where is my order" }, { role: "assistant", content: "Here are your recent orders." }];
  const vote = await recordFeedback({ shop: A, sessionId: "why-1", vote: "down", moment: "order", clientKey: "v_abc12345", botResponse: "Here are your recent orders.", products: [], conversation: conv, ip: "203.0.113.9" });
  assert.equal(vote.reason, null);
  assert.equal(vote.moment, "order");
  const why = await recordFeedback({ shop: A, sessionId: "why-1", vote: "down", reason: "wrong_info", moment: "order", clientKey: "v_abc12345", botResponse: "Here are your recent orders.", products: [], conversation: conv, ip: "203.0.113.9" });
  assert.equal(why.id, vote.id, "the same row");
  assert.equal(why.reason, "wrong_info");
  assert.equal(await prisma.chatFeedback.count({ where: { shop: A, sessionId: "why-1" } }), 1);
  // Only the reason arrived (the vote was lost): it stands in.
  const alone = await recordFeedback({ shop: A, sessionId: "why-1", vote: "down", reason: "too_slow", clientKey: "v_other999", botResponse: "x", products: [], conversation: null, ip: "" });
  assert.notEqual(alone.id, vote.id);
  assert.equal(alone.reason, "too_slow");
  // Another answer's vote, no key: a row of its own.
  const plain = await recordFeedback({ shop: A, sessionId: "why-1", vote: "up", botResponse: "y", products: [], conversation: null, ip: "" });
  assert.equal(plain.reason, null);
  assert.equal(await prisma.chatFeedback.count({ where: { shop: A, sessionId: "why-1" } }), 3);
  const { getFeedbackSummary, getRecentQuestions } = await import("../app/models/ChatFeedback.server.js");
  const sum = await getFeedbackSummary(A, 30);
  assert.equal(sum.reasons.wrong_info >= 1 && sum.reasons.too_slow >= 1, true, JSON.stringify(sum.reasons));
  const rows = await getRecentQuestions(A, 30, 50);
  const r = rows.find((q) => q.id === vote.id);
  assert.equal(r.reason, "wrong_info");
  assert.equal(r.moment, "order");
});

await test("chat check-in: when it was asked, the reason after a thumbs-down, kept when the comment follows", async () => {
  const conv = [{ role: "user", content: "boots" }, { role: "assistant", content: "Here are three." }];
  const down = await recordChatRating({ shop: A, sessionId: "rate-cart", vote: "down", moment: "cart", conversation: conv, ip: "" });
  assert.equal(down.moment, "cart");
  const why = await recordChatRating({ shop: A, sessionId: "rate-cart", vote: "down", reason: "wrong_product", moment: "cart", conversation: conv, ip: "" });
  assert.equal(why.id, down.id);
  assert.equal(why.reason, "wrong_product");
  const note = await recordChatRating({ shop: A, sessionId: "rate-cart", vote: "down", comment: "wrong color", moment: "cart", conversation: conv, ip: "" });
  assert.equal(note.reason, "wrong_product", "the comment keeps the reason");
  assert.equal(note.comment, "wrong color");
  const changed = await recordChatRating({ shop: A, sessionId: "rate-cart", vote: "up", moment: "cart", conversation: conv, ip: "" });
  assert.equal(changed.reason, null, "a thumbs-up has no reason");
});

console.log("\ncatalog sync");
const node = (id, title) => ({
  id: `gid://shopify/Product/${id}`, handle: title.toLowerCase().replace(/\W+/g, "-"), title, vendor: "Aetrex",
  productType: "Footwear", tags: [], descriptionHtml: "<p>x</p>", status: "ACTIVE", featuredImage: { url: "https://cdn/x.jpg" },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}1`, sku: `S${id}`, title: "7", price: "99.95", compareAtPrice: null, inventoryQuantity: 3, selectedOptions: [{ name: "Size", value: "7" }] }] },
});
function fakeAdmin(products, { delayMs = 0 } = {}) {
  return {
    graphql: async (query) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const data = /SyncProducts/.test(query)
        ? { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products } }
        : {};
      return { json: async () => ({ data }) };
    },
  };
}
await test("a full sync removes products deleted in Shopify and keeps the rest", async () => {
  await prisma.product.create({ data: { shop: A, shopifyId: "gid://shopify/Product/999", handle: "gone", title: "Gone Shoe", tags: [] } });
  const r = await syncCatalog(fakeAdmin([node(1, "Jillian Sandal - Black"), node(2, "Savannah Sandal - Red")]), A);
  assert.equal(r.ok, true, r.error);
  const handles = (await prisma.product.findMany({ where: { shop: A }, select: { handle: true } })).map((p) => p.handle).sort();
  assert.deepEqual(handles, ["jillian-sandal-black", "savannah-sandal-red"]);
});
await test("two syncs started together: one runs, the other steps aside", async () => {
  const admin = fakeAdmin([node(1, "Jillian Sandal - Black")], { delayMs: 200 });
  const [x, y] = await Promise.all([syncCatalog(admin, B), syncCatalog(admin, B)]);
  assert.equal([x, y].filter((r) => r.alreadyRunning).length, 1);
  assert.equal((await prisma.catalogSyncState.findUnique({ where: { shop: B } })).status, "idle");
});

console.log("\nstore knowledge");
await test("re-syncing the website keeps unchanged chunks and replaces only what changed", async () => {
  const body = (extra = "") => `<h2>Returns</h2><p>We offer no hassle returns and exchanges within 30 days of purchase if you are not satisfied with your purchase.${extra}</p>`;
  const admin = (pageBody) => ({
    graphql: async (query) => {
      const data = /primaryDomain/.test(query) ? { shop: { primaryDomain: { url: "https://www.aetrex.test" } } }
        : /pages\(/.test(query) ? { pages: { pageInfo: { hasNextPage: false }, nodes: [{ title: "Returns", handle: "returns", body: pageBody, isPublished: true, templateSuffix: null }] } }
          : /articles\(/.test(query) ? { articles: { pageInfo: { hasNextPage: false }, nodes: [] } }
            : /shopPolicies/.test(query) ? { shop: { shopPolicies: [] } } : {};
      return { json: async () => ({ data }) };
    },
  });
  const quiet = { fetchImpl: async () => ({ ok: false }), log: () => {} };
  const first = await syncStoreKnowledge({ admin: admin(body()), shop: A, ...quiet });
  assert.equal(first.ok, true);
  const ids = (await prisma.knowledgeChunk.findMany({ where: { shop: A }, select: { id: true } })).map((r) => r.id).sort();
  const again = await syncStoreKnowledge({ admin: admin(body()), shop: A, ...quiet });
  assert.equal(again.added, 0);
  assert.deepEqual((await prisma.knowledgeChunk.findMany({ where: { shop: A }, select: { id: true } })).map((r) => r.id).sort(), ids);
  const changed = await syncStoreKnowledge({ admin: admin(body(" Orthotics carry a 60-day guarantee.")), shop: A, ...quiet });
  assert.ok(changed.added >= 1 && changed.removed >= 1);
  const rows = await prisma.knowledgeChunk.findMany({ where: { shop: A } });
  assert.ok(rows.some((r) => /60-day guarantee/.test(r.content)));
  assert.equal(rows.length, changed.chunks);
});

console.log("\nbusy days");
await test("Peak Mode settings: a new store gets the everyday and peak limits", async () => {
  const c = await getShopConfig(B);
  assert.equal(c.chatLimitPerMin, 120);
  assert.equal(c.chatLimitPerHour, 3000);
  assert.equal(c.peakMode, "off");
  assert.equal(c.peakLimitPerMin, 300);
  assert.equal(c.peakLimitPerHour, 8000);
  assert.equal(c.peakLiftDailyCap, true);
  assert.equal(c.peakPauseSync, true);
});
await test("the storefront's config cache: one read for a burst, cleared the moment settings are saved", async () => {
  const first = await Promise.all(Array.from({ length: 20 }, () => getShopConfigCached(B)));
  assert.ok(first.every((c) => c === first[0]), "a burst shares one read");
  await updateShopConfig(B, { peakMode: "on", peakLimitPerMin: 450 });
  const after = await getShopConfigCached(B);
  assert.equal(after.peakMode, "on");
  assert.equal(after.peakLimitPerMin, 450);
});
await test("Peak Mode's live numbers: messages now, busiest minute and hour, cost, shoppers turned away", async () => {
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms);
  await prisma.chatUsage.createMany({ data: [
    ...Array.from({ length: 3 }, () => ({ shop: B, model: "m", costUsd: 0.04, createdAt: ago(20_000) })),
    ...Array.from({ length: 5 }, () => ({ shop: B, model: "m", costUsd: 0.02, createdAt: ago(2 * 60 * 60_000) })),
    { shop: B, model: "m", costUsd: 9, internal: true, createdAt: ago(10_000) },
  ] });
  await prisma.chatHealthEvent.createMany({ data: [
    { shop: B, ok: false, errorKind: "store_rate_limited" },
    { shop: B, ok: false, errorKind: "store_rate_limited" },
    { shop: B, ok: false, errorKind: "daily_cap" },
    { shop: B, ok: false, errorKind: "rate_limit" },
    { shop: B, ok: false, errorKind: "client_left" },
  ] });
  const p = await getChatPulse(B, now);
  assert.equal(p.lastMinute, 3, "test chats aren't counted");
  assert.equal(p.lastHour, 3);
  assert.equal(p.busiestHour, 5);
  assert.ok(p.busiestMinute >= 3 && p.busiestMinute <= 5);
  assert.ok(Math.abs(p.avgCostUsd - 0.0275) < 1e-6, String(p.avgCostUsd));
  assert.deepEqual(p.turnedAway, { storeLimit: 2, dailyCap: 1, aiBusy: 1 });
  const usage = await getUsageSummary(B, 7);
  assert.equal(usage.totalMessages, 8, "dashboard summary reads only real chats");
  assert.ok(Math.abs(usage.totalCost - 0.22) < 1e-6, String(usage.totalCost));
});

// Cleanup — every row this run created.
for (const shop of [A, B]) {
  await prisma.product.deleteMany({ where: { shop } });
  for (const m of ["chatHealthEvent", "chatUsage", "knowledgeChunk", "campaign", "decisionTree", "knowledgeFile", "chatFeedback", "catalogSyncState", "shopConfig"]) {
    await prisma[m].deleteMany({ where: { shop } });
  }
}
await prisma.$disconnect();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
