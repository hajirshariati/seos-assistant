// Rate limits: the per-shopper bucket and the store-wide chat ceilings that
// bound spend however requests are spread across addresses.
import assert from "node:assert/strict";

process.env.CHAT_STORE_PER_MIN = "5";
process.env.CHAT_STORE_PER_HOUR = "8";
const { checkIpShopRate, checkStoreChatRate, clientIp } = await import("../app/lib/rate-limit.server.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};

await test("per-shopper bucket: 20 a minute, then a retry time", () => {
  for (let i = 0; i < 20; i++) assert.equal(checkIpShopRate("a.myshopify.com", "1.1.1.1").ok, true);
  const r = checkIpShopRate("a.myshopify.com", "1.1.1.1");
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
  assert.equal(checkIpShopRate("a.myshopify.com", "2.2.2.2").ok, true, "another shopper is unaffected");
});
await test("store-wide: the minute ceiling holds no matter how many addresses", () => {
  for (let i = 0; i < 5; i++) assert.equal(checkStoreChatRate("b.myshopify.com").ok, true);
  const r = checkStoreChatRate("b.myshopify.com");
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
});
await test("store-wide: each store has its own allowance", () => {
  assert.equal(checkStoreChatRate("c.myshopify.com").ok, true);
});
await test("store-wide: the hour ceiling (retry within the hour)", () => {
  const shop = "d.myshopify.com";
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    let ok = 0;
    for (let i = 0; i < 20; i++) { if (checkStoreChatRate(shop).ok) ok += 1; t += 61_000; }
    assert.equal(ok, 8);
    t += 1000;
    const r = checkStoreChatRate(shop);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfter > 60 && r.retryAfter <= 3600, String(r.retryAfter));
  } finally { Date.now = realNow; }
});
await test("client IP: first X-Forwarded-For entry, then X-Real-IP", () => {
  assert.equal(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } })), "9.9.9.9");
  assert.equal(clientIp(new Request("http://x", { headers: { "x-real-ip": "8.8.8.8" } })), "8.8.8.8");
  assert.equal(clientIp(new Request("http://x")), "unknown");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
