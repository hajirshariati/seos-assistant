// Buy now (Settings → Shopping tools): off unless the store turns it on; the
// code goes into a link as it is or is refused with why; and an order the
// chat sold is credited exactly as before — "SEoS" ("AVA" on the Aetrex
// app, named AVA…) — with "… Buy now" added only when it came through Buy now.
//
// Run: node scripts/eval-buy-now.mjs
import assert from "node:assert/strict";

const { buyNowConfig, cleanBuyNowCode, buyNowCodeError, chatOrderFlags, chatOrderTags, BUY_NOW_CODE_MAX } = await import("../app/lib/buy-now.js");
const { appName, appBrand, appNames } = await import("../app/lib/app-brand.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

await test("off unless the store turns it on; the code only travels when it's on", () => {
  assert.deepEqual(buyNowConfig({}), { on: false, code: "" });
  assert.deepEqual(buyNowConfig(null), { on: false, code: "" });
  assert.deepEqual(buyNowConfig({ buyNowEnabled: "true", buyNowCode: "CHAT10" }), { on: false, code: "" });
  assert.deepEqual(buyNowConfig({ buyNowEnabled: false, buyNowCode: "CHAT10" }), { on: false, code: "" });
  assert.deepEqual(buyNowConfig({ buyNowEnabled: true, buyNowCode: " CHAT10 " }), { on: true, code: "CHAT10" });
  assert.deepEqual(buyNowConfig({ buyNowEnabled: true }), { on: true, code: "" });
});
await test("a code goes into the link as it is, or not at all", () => {
  for (const ok of ["CHAT10", "welcome-15", "AVA_2026", "fall.sale", "A"]) assert.equal(cleanBuyNowCode(ok), ok);
  for (const bad of ["", " ", "two words", "a&b=c", "x?y", "<b>", "-LEADING", "100%OFF", "x".repeat(BUY_NOW_CODE_MAX + 1)]) assert.equal(cleanBuyNowCode(bad), "", bad);
  assert.equal(buyNowConfig({ buyNowEnabled: true, buyNowCode: "a&discount=EVIL" }).code, "");
});
await test("Settings says why a code can't be used; a blank one is fine", () => {
  assert.equal(buyNowCodeError(""), "");
  assert.equal(buyNowCodeError("CHAT10"), "");
  assert.match(buyNowCodeError("two words"), /letters, numbers/);
  assert.match(buyNowCodeError("x".repeat(BUY_NOW_CODE_MAX + 1)), /too long/);
});
await test("an order the chat sold is tagged SEoS exactly as before; Buy now adds its own tag", () => {
  const attrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  assert.deepEqual(chatOrderTags(chatOrderFlags(attrs({ _seos_attributed: "1" }))), ["SEoS"]);
  assert.deepEqual(chatOrderTags(chatOrderFlags(attrs({ _seos_attributed: "1", _seos_buy_now: "1" }))), ["SEoS", "SEoS Buy now"]);
  assert.deepEqual(chatOrderTags(chatOrderFlags(attrs({ _SEOS_ATTRIBUTED: "true" }))), ["SEoS"]);
  // Not from the chat: nothing, whatever else is there.
  for (const o of [{}, { _seos_attributed: "0" }, { _seos_attributed: "false" }, { _seos_attributed: "" }, { _seos_buy_now: "1" }, { gift: "yes" }]) {
    assert.deepEqual(chatOrderTags(chatOrderFlags(attrs(o))), [], JSON.stringify(o));
  }
  assert.deepEqual(chatOrderFlags(null), { chat: false, buyNow: false });
  assert.deepEqual(chatOrderFlags([{ name: "_seos_attributed", value: 0 }]), { chat: false, buyNow: false });
});
await test("the Aetrex app (named AVA…) tags AVA and AVA Buy now; any other name keeps SEoS", () => {
  const attrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const sold = chatOrderFlags(attrs({ _seos_attributed: "1" }));
  const bought = chatOrderFlags(attrs({ _seos_attributed: "1", _seos_buy_now: "1" }));
  assert.equal(appBrand(appName({ title: "AVA Aetrex Virtual Assistant" })), "AVA");
  assert.deepEqual(chatOrderTags(sold, "AVA"), ["AVA"]);
  assert.deepEqual(chatOrderTags(bought, "AVA"), ["AVA", "AVA Buy now"]);
  for (const name of ["SEoS Assistant", "Avalon Helper", "My AVA app", "", null]) {
    assert.equal(appBrand(appName({ title: name })), "SEoS", String(name));
  }
  assert.equal(appName(null), "SEoS Assistant", "Shopify not read yet → the old name");
  assert.deepEqual(chatOrderTags(bought, "anything"), ["SEoS", "SEoS Buy now"], "only AVA or SEoS, never a made-up tag");
  assert.deepEqual(chatOrderTags(chatOrderFlags(attrs({ gift: "1" })), "AVA"), [], "not from the chat → no tag");
});
await test("pages call the Aetrex app just AVA; the other keeps its full name", () => {
  assert.deepEqual(appNames("AVA Aetrex Virtual Assistant"), { name: "AVA Aetrex Virtual Assistant", short: "AVA", brand: "AVA" });
  assert.deepEqual(appNames("SEoS Assistant"), { name: "SEoS Assistant", short: "SEoS Assistant", brand: "SEoS" });
  assert.deepEqual(appNames(""), { name: "SEoS Assistant", short: "SEoS Assistant", brand: "SEoS" }, "not known yet → as before");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
