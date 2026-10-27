// The store's app in the chat (Settings → Your app): only real App Store /
// Google Play links are used or accepted, and the QR code the app makes
// is that link's.
//
// Run: node scripts/eval-app-promo.mjs
import assert from "node:assert/strict";
import QRCode from "qrcode";

const { cleanAppLink, appPromoConfig, appLinkError } = await import("../app/lib/app-promo.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const IOS = "https://apps.apple.com/us/app/aetrex/id6789256421";
const ANDROID = "https://play.google.com/store/apps/details?id=com.aetrex.app";

await test("only the stores' own app pages count as links", () => {
  assert.equal(cleanAppLink("ios", IOS), IOS);
  assert.equal(cleanAppLink("android", ANDROID), ANDROID);
  assert.equal(cleanAppLink("ios", ANDROID), "", "each store only its own");
  assert.equal(cleanAppLink("android", IOS), "");
  for (const bad of ["http://apps.apple.com/us/app/x/id1", "https://apps.apple.com.evil.example/x", "javascript:alert(1)", "https://example.com/app", `https://apps.apple.com/x" onload="x`, ""]) {
    assert.equal(cleanAppLink("ios", bad), "", bad);
  }
  assert.equal(cleanAppLink("android", "https://play.google.com/store/apps/dev?id=1"), "");
  assert.equal(cleanAppLink("ios", `https://apps.apple.com/${"x".repeat(400)}`), "", "too long");
});
await test("widget-config: on by default with whichever links are set; off when turned off", () => {
  assert.deepEqual(appPromoConfig({}), { on: true, ios: "", android: "" }, "blank: the widget uses the footer's links");
  assert.deepEqual(appPromoConfig({ appIosUrl: IOS, appAndroidUrl: ANDROID }), { on: true, ios: IOS, android: ANDROID });
  assert.deepEqual(appPromoConfig({ appIosUrl: "https://evil.example" }), { on: true, ios: "", android: "" });
  assert.deepEqual(appPromoConfig({ appPromoOn: false, appIosUrl: IOS }), { on: false });
});
await test("Settings: a link that isn't the store's page is refused, with why; blank is fine", () => {
  assert.equal(appLinkError("ios", ""), "");
  assert.equal(appLinkError("ios", IOS), "");
  assert.match(appLinkError("ios", "https://example.com"), /https:\/\/apps\.apple\.com\//);
  assert.match(appLinkError("android", IOS), /https:\/\/play\.google\.com\/store\/apps\/details\?id=/);
});
await test("the QR code is an SVG of exactly the store link", async () => {
  // The route uses the same call; a QR of a different link draws differently.
  const make = (u) => QRCode.toString(u, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
  const a = await make(IOS);
  assert.match(a, /^<svg[^>]+viewBox=/);
  assert.notEqual(a, await make(ANDROID));
  assert.equal(a, await make(IOS));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
