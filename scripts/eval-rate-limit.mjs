// Rate limits: the per-shopper bucket and the store-wide chat ceilings that
// bound spend however requests are spread across addresses.
import assert from "node:assert/strict";

const { checkIpShopRate, checkStoreChatRate, clientIp } = await import("../app/lib/rate-limit.server.js");
const { storeChatLimits, peakState, dailyCapApplies, nightlySyncPaused, busyMessage, cleanLimit, NORMAL_LIMITS, PEAK_LIMITS } = await import("../app/lib/peak-mode.js");
const { createLimiter } = await import("../app/lib/concurrency.js");
const { withAnthropicRetry, retryAfterMs, classifyAnthropicError, customerFacingFailureMessage } = await import("../app/lib/anthropic-resilience.server.js");
const LIMITS = { perMin: 5, perHour: 8 };

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
  for (let i = 0; i < 5; i++) assert.equal(checkStoreChatRate("b.myshopify.com", LIMITS).ok, true);
  const r = checkStoreChatRate("b.myshopify.com", LIMITS);
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
});
await test("store-wide: each store has its own allowance", () => {
  assert.equal(checkStoreChatRate("c.myshopify.com", LIMITS).ok, true);
});
await test("store-wide: the hour ceiling (retry within the hour)", () => {
  const shop = "d.myshopify.com";
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    let ok = 0;
    for (let i = 0; i < 20; i++) { if (checkStoreChatRate(shop, LIMITS).ok) ok += 1; t += 61_000; }
    assert.equal(ok, 8);
    t += 1000;
    const r = checkStoreChatRate(shop, LIMITS);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfter > 60 && r.retryAfter <= 3600, String(r.retryAfter));
  } finally { Date.now = realNow; }
});
await test("store-wide: a message turned away by the hour limit doesn't use up the minute", () => {
  const shop = "e.myshopify.com";
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 2; i++) assert.equal(checkStoreChatRate(shop, { perMin: 2, perHour: 2 }).ok, true);
    t += 61_000;
    assert.equal(checkStoreChatRate(shop, { perMin: 2, perHour: 2 }).ok, false, "hour full");
    // Raise the hour limit: the minute still has both slots.
    assert.equal(checkStoreChatRate(shop, { perMin: 2, perHour: 10 }).ok, true);
    assert.equal(checkStoreChatRate(shop, { perMin: 2, perHour: 10 }).ok, true);
    assert.equal(checkStoreChatRate(shop, { perMin: 2, perHour: 10 }).ok, false);
  } finally { Date.now = realNow; }
});
await test("store-wide: 0 means no limit, and a raised limit takes effect at once", () => {
  for (let i = 0; i < 500; i++) assert.equal(checkStoreChatRate("f.myshopify.com", { perMin: 0, perHour: 0 }).ok, true);
  for (let i = 0; i < 3; i++) checkStoreChatRate("g.myshopify.com", { perMin: 3, perHour: 0 });
  assert.equal(checkStoreChatRate("g.myshopify.com", { perMin: 3, perHour: 0 }).ok, false);
  assert.equal(checkStoreChatRate("g.myshopify.com", { perMin: 6, perHour: 0 }).ok, true);
});

console.log("\nPeak Mode");
const at = (iso) => new Date(iso);
await test("limits: normal by default, peak while on; a server setting overrides", () => {
  assert.deepEqual(storeChatLimits({}), { peak: false, ...NORMAL_LIMITS, overridden: false });
  assert.deepEqual(storeChatLimits({ peakMode: "on" }), { peak: true, ...PEAK_LIMITS, overridden: false });
  assert.deepEqual(storeChatLimits({ chatLimitPerMin: 40, chatLimitPerHour: 0 }), { peak: false, perMin: 40, perHour: 0, overridden: false });
  const env = storeChatLimits({ peakMode: "on" }, { env: { CHAT_STORE_PER_MIN: "100000", CHAT_STORE_PER_HOUR: "" } });
  assert.equal(env.perMin, 100000);
  assert.equal(env.perHour, PEAK_LIMITS.perHour);
  assert.equal(env.overridden, true);
});
await test("schedule: on from the start up to the end, then back to normal", () => {
  const cfg = { peakMode: "scheduled", peakStartsAt: "2026-11-26T05:00:00Z", peakEndsAt: "2026-12-02T05:00:00Z" };
  assert.equal(peakState(cfg, at("2026-11-25T12:00:00Z")).upcoming, true);
  assert.equal(peakState(cfg, at("2026-11-25T12:00:00Z")).active, false);
  assert.equal(peakState(cfg, at("2026-11-27T12:00:00Z")).active, true);
  assert.equal(peakState(cfg, at("2026-12-02T05:00:00Z")).active, false, "the end is not included");
  assert.equal(peakState(cfg, at("2026-12-03T00:00:00Z")).ended, true);
  assert.equal(storeChatLimits(cfg, { now: at("2026-11-27T12:00:00Z") }).peak, true);
  assert.equal(peakState({ peakMode: "scheduled" }).active, false, "no start date → not on");
  assert.equal(peakState({ peakMode: "bogus" }).mode, "off");
});
await test("daily cap: lifted while Peak Mode is on (unless the store keeps it); sync pause", () => {
  const cap = { dailyCapEnabled: true, dailyCapMessages: 200 };
  assert.equal(dailyCapApplies(cap), true);
  assert.equal(dailyCapApplies({ ...cap, peakMode: "on" }), false);
  assert.equal(dailyCapApplies({ ...cap, peakMode: "on", peakLiftDailyCap: false }), true);
  assert.equal(dailyCapApplies({ dailyCapEnabled: false, peakMode: "off" }), false);
  assert.equal(nightlySyncPaused({ peakMode: "on" }), true);
  assert.equal(nightlySyncPaused({ peakMode: "on", peakPauseSync: false }), false);
  assert.equal(nightlySyncPaused({}), false);
});
await test("busy message and limit input", () => {
  assert.match(busyMessage(20), /in a minute/);
  assert.match(busyMessage(300), /in a few minutes/);
  assert.match(busyMessage(2000), /a little later/);
  assert.equal(cleanLimit("250", 5000, 120), 250);
  assert.equal(cleanLimit("0", 5000, 120), 0);
  assert.equal(cleanLimit("99999", 5000, 120), 5000);
  assert.equal(cleanLimit("-3", 5000, 120), 120);
  assert.equal(cleanLimit("abc", 5000, 120), 120);
});

console.log("\nAI calls");
await test("concurrency: at most N run at once; the rest wait their turn or give up", async () => {
  const lim = createLimiter(2);
  let running = 0, peak = 0;
  const task = () => lim.run(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; return "ok"; });
  const results = await Promise.all([task(), task(), task(), task(), task()]);
  assert.deepEqual(results, ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(peak, 2);
  assert.equal(lim.active, 0);
  const slow = createLimiter(1);
  const hold = slow.run(() => new Promise((r) => setTimeout(r, 80)));
  await assert.rejects(slow.run(async () => "x", { waitMs: 10 }), (e) => e.code === "AI_BUSY");
  await hold;
  assert.equal(await slow.run(async () => "after"), "after", "a slot frees up after a give-up");
  assert.equal(classifyAnthropicError({ code: "AI_BUSY" }).kind, "busy");
  assert.match(customerFacingFailureMessage("busy"), /lot of questions/);
});
await test("retries: 529 is retried; retry-after is honored, but never past the wait cap or the turn's end", async () => {
  assert.equal(retryAfterMs({ headers: { "retry-after": "2" } }), 2000);
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after-ms": "750" }) }), 750);
  assert.equal(retryAfterMs({}), null);
  let calls = 0;
  const r = await withAnthropicRetry(async () => { calls++; if (calls === 1) throw Object.assign(new Error("Overloaded"), { status: 529 }); return "ok"; }, { baseDelayMs: 1 });
  assert.equal(r, "ok");
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(withAnthropicRetry(async () => { calls++; throw Object.assign(new Error("rate"), { status: 429, headers: { "retry-after": "60" } }); }, { baseDelayMs: 1 }));
  assert.equal(calls, 1, "a 60s wait is longer than a shopper should wait → no retry");
  calls = 0;
  await assert.rejects(withAnthropicRetry(async () => { calls++; throw Object.assign(new Error("boom"), { status: 500 }); }, { baseDelayMs: 1, deadlineAt: Date.now() + 1000 }));
  assert.equal(calls, 1, "no retry when the turn is about to end");
  calls = 0;
  const started = Date.now();
  await withAnthropicRetry(async () => { calls++; if (calls === 1) throw Object.assign(new Error("rate"), { status: 429, headers: { "retry-after-ms": "120" } }); return "ok"; }, { baseDelayMs: 1 });
  assert.ok(Date.now() - started >= 110, "waited as asked");
});

console.log("\nrequests");
await test("client IP: first X-Forwarded-For entry, then X-Real-IP", () => {
  assert.equal(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } })), "9.9.9.9");
  assert.equal(clientIp(new Request("http://x", { headers: { "x-real-ip": "8.8.8.8" } })), "8.8.8.8");
  assert.equal(clientIp(new Request("http://x")), "unknown");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
