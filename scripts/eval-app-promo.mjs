// The store's app in the chat (Settings → Your app): only real App Store /
// Google Play links are used or accepted, and the QR code the app makes
// is that link's.
//
// Run: node scripts/eval-app-promo.mjs
import assert from "node:assert/strict";
import QRCode from "qrcode";

const { cleanAppLink, appPromoConfig, appLinkError, cleanAppText, defaultAppText, APP_TEXT_MAX, APP_BUTTON_MAX } = await import("../app/lib/app-promo.js");

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
  const blank = { text: "", button: "" };
  assert.deepEqual(appPromoConfig({}), { on: true, ios: "", android: "", ...blank }, "blank: the widget uses the footer's links");
  assert.deepEqual(appPromoConfig({ appIosUrl: IOS, appAndroidUrl: ANDROID }), { on: true, ios: IOS, android: ANDROID, ...blank });
  assert.deepEqual(appPromoConfig({ appIosUrl: "https://evil.example" }), { on: true, ios: "", android: "", ...blank });
  assert.deepEqual(appPromoConfig({ appPromoOn: false, appIosUrl: IOS }), { on: false });
});
await test("its message and button: as set, tidied and capped; blank → the widget's defaults", () => {
  const c = appPromoConfig({ appPromoText: "  Love   Aetrex?\n You’ll love our app ", appPromoButton: " Get it " });
  assert.equal(c.text, "Love Aetrex? You’ll love our app");
  assert.equal(c.button, "Get it");
  assert.equal(appPromoConfig({ appPromoText: "x".repeat(200) }).text.length, APP_TEXT_MAX);
  assert.equal(appPromoConfig({ appPromoButton: "Download the app today" }).button.length <= APP_BUTTON_MAX, true);
  assert.equal(cleanAppText(null), "");
  assert.equal(defaultAppText("Aetrex"), "Love Aetrex? You\u2019ll love our app");
  assert.equal(defaultAppText(""), "You\u2019ll love our app");
});
await test("the app's picture: PNG / WebP / JPEG up to its size; a new picture gets a new link", async () => {
  const { appImageData, appImageError, APP_IMAGE_MAX_BYTES } = await import("../app/lib/app-promo.js");
  const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64")}`;
  const webp = `data:image/webp;base64,${Buffer.from("RIFFxxxxWEBP").toString("base64")}`;
  assert.equal(appImageData(png).type, "image/png");
  assert.equal(appImageData(webp).type, "image/webp");
  assert.deepEqual([...Buffer.from(appImageData(png).base64, "base64")], [137, 80, 78, 71, 1, 2, 3]);
  for (const bad of ["", "data:image/gif;base64,AAAA", "data:image/svg+xml;base64,PHN2Zz4=", "https://x.com/a.png", "data:image/png;base64,***"]) assert.equal(appImageData(bad), null, bad);
  assert.equal(appImageData(`data:image/png;base64,${Buffer.alloc(APP_IMAGE_MAX_BYTES + 1).toString("base64")}`), null, "too large");
  assert.equal(appImageError(""), "");
  assert.equal(appImageError(png), "");
  assert.match(appImageError("data:image/gif;base64,AAAA"), /PNG, WebP or JPEG/);
  assert.match(appImageError(`data:image/png;base64,${Buffer.alloc(APP_IMAGE_MAX_BYTES + 1).toString("base64")}`), /too large/);
  const a = appPromoConfig({ appPromoImage: png }).image, b = appPromoConfig({ appPromoImage: webp }).image;
  assert.match(a, /^\/apps\/hajirai\/app-image\?v=[a-z0-9]+$/);
  assert.notEqual(a, b, "a new picture, a new link");
  assert.equal(appPromoConfig({}).image, undefined, "no picture → none (the phone icon)");
  assert.deepEqual(appPromoConfig({ appPromoOn: false, appPromoImage: png }), { on: false });
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
