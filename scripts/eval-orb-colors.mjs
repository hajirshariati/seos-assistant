// The assistant mark's colors (Settings → Assistant look) and its shader.
// The Settings preview draws with app/lib/orb-shader.js; it must be the very
// shader the storefront widget runs, and every stored value must read as five
// valid colors.
//
// Run: node scripts/eval-orb-colors.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { ORB_FRAG } from "../app/lib/orb-shader.js";
import { ORB_DEFAULT_COLORS, ORB_DEFAULT_BG, normalizeHex, parseOrbColors, serializeOrbColors, isDefaultOrbColors, parseOrbBackground, serializeOrbBackground } from "../app/lib/orb-colors.js";
import { launcherMark, cleanLauncherText, defaultLauncherText, launcherMarkConfig, cleanAvatarUrl, avatarPreviewUrl, LAUNCHER_TEXT_MAX } from "../app/lib/launcher-mark.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const widget = fs.readFileSync(new URL("../extensions/hajirai-chat-widget/assets/hajirai-chat-widget.js", import.meta.url), "utf8");

console.log("\nshader");
test("the Settings preview runs the storefront's shader exactly", () => {
  const m = widget.match(/var GLOW_FRAG=(\[[\s\S]*?\])\.join\('\\n'\);/);
  assert.ok(m, "GLOW_FRAG not found in the widget");
  const frag = new Function(`return ${m[1]}`)().join("\n");
  assert.equal(ORB_FRAG, frag, "app/lib/orb-shader.js is out of date — regenerate it from the widget's GLOW_FRAG");
});
test("the shader takes the five colors as c0…c4", () => {
  for (let i = 0; i < 5; i++) assert.match(ORB_FRAG, new RegExp(`uniform vec3 c${i};`));
  assert.match(ORB_FRAG, /vec3 red=c0,blue=c1,cyan=c2,green=c3,pink=c4;/);
});
test("widget and Settings share the same default colors", () => {
  const m = widget.match(/var ORB_DEFAULT=(\[[^\]]+\])/);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), ORB_DEFAULT_COLORS);
});

console.log("\ncolors");
test("hex input is normalized", () => {
  assert.equal(normalizeHex("#1A4DFF"), "#1a4dff");
  assert.equal(normalizeHex("1a4dff"), "#1a4dff");
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  assert.equal(normalizeHex(" #1a4dff "), "#1a4dff");
  assert.equal(normalizeHex("red"), null);
  assert.equal(normalizeHex("#12345"), null);
  assert.equal(normalizeHex(""), null);
});
test("stored values always read as five valid colors", () => {
  assert.deepEqual(parseOrbColors(""), ORB_DEFAULT_COLORS);
  assert.deepEqual(parseOrbColors(null), ORB_DEFAULT_COLORS);
  assert.deepEqual(parseOrbColors("#111111,#222222"), ORB_DEFAULT_COLORS, "too few");
  assert.deepEqual(parseOrbColors("#111111,#222222,red,#444444,#555555"), ORB_DEFAULT_COLORS, "one bad");
  assert.deepEqual(parseOrbColors("#111111,#222222,#333333,#444444,#555555"), ["#111111", "#222222", "#333333", "#444444", "#555555"]);
});
test("saving: the defaults store as empty, invalid input is refused", () => {
  assert.equal(serializeOrbColors(ORB_DEFAULT_COLORS.map((c) => c.toUpperCase())), "");
  assert.equal(serializeOrbColors(["#111", "#222222", "#333333", "#444444", "#555555"]), "#111111,#222222,#333333,#444444,#555555");
  assert.equal(serializeOrbColors(["#111111", "nope", "#333333", "#444444", "#555555"]), null);
  assert.equal(serializeOrbColors(["#111111"]), null);
  assert.ok(isDefaultOrbColors(ORB_DEFAULT_COLORS));
});

test("the globe color: same default in widget and Settings, always a valid color", () => {
  assert.match(ORB_FRAG, /uniform vec3 cbg;/, "the shader takes the globe color");
  const m = widget.match(/var ORB_BG_DEFAULT='(#[0-9a-f]{6})'/);
  assert.ok(m, "widget default present");
  assert.equal(m[1], ORB_DEFAULT_BG);
  assert.equal(parseOrbBackground(""), ORB_DEFAULT_BG);
  assert.equal(parseOrbBackground("nope"), ORB_DEFAULT_BG);
  assert.equal(parseOrbBackground("#FFFFFF"), "#ffffff");
  assert.equal(serializeOrbBackground(ORB_DEFAULT_BG), "", "default stores as empty");
  assert.equal(serializeOrbBackground("#fff"), "#ffffff");
  assert.equal(serializeOrbBackground("blue"), null, "invalid refused");
});

console.log("\nlauncher mark (the light or the photo)");
test("only \"avatar\" picks the photo; anything else is the light", () => {
  assert.equal(launcherMark("avatar"), "avatar");
  for (const v of ["orb", "", null, undefined, "AVATAR", "photo"]) assert.equal(launcherMark(v), "orb");
});
test("the button's words are cleaned and kept short", () => {
  assert.equal(cleanLauncherText("  Ask   Ava! "), "Ask Ava!");
  assert.equal(cleanLauncherText("<b>Hi</b>"), "bHi/b");
  assert.equal(cleanLauncherText("x".repeat(40)).length, LAUNCHER_TEXT_MAX);
  assert.equal(cleanLauncherText(null), "");
});
test("default words: \"Ask Ava!\" on the AVA app only", () => {
  assert.equal(defaultLauncherText("AVA"), "Ask Ava!");
  assert.equal(defaultLauncherText("SEoS"), "Ask AI");
});
test("widget-config gets the mark and the words", () => {
  assert.deepEqual(launcherMarkConfig({ launcherMark: "avatar", launcherText: " Ask Ava! " }), { mark: "avatar", text: "Ask Ava!" });
  assert.deepEqual(launcherMarkConfig({}), { mark: "orb", text: "" });
});
test("the widget keeps the same rules (default words, length, what turns the photo on)", () => {
  assert.match(widget, /MARK_TEXT='Ask AI'/);
  assert.match(widget, /\.slice\(0,24\)/);
  assert.match(widget, /m\.mark==='avatar'/);
  assert.equal(LAUNCHER_TEXT_MAX, 24);
});
test("the reported avatar: a photo address, \"\" for none, anything else dropped", () => {
  assert.equal(cleanAvatarUrl("//aetrex.com/cdn/shop/files/ava.png?v=1&width=200"), "//aetrex.com/cdn/shop/files/ava.png?v=1&width=200");
  assert.equal(cleanAvatarUrl("https://cdn.shopify.com/s/files/1/0001/files/a.jpg"), "https://cdn.shopify.com/s/files/1/0001/files/a.jpg");
  assert.equal(cleanAvatarUrl(""), "");
  assert.equal(cleanAvatarUrl(null), null);
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAA", "/relative.png", "http://x.com/a.png", "//x.com/a\"onerror=1", "//" + "a".repeat(600) + ".com/x"]) assert.equal(cleanAvatarUrl(bad), null, bad);
});
test("Settings shows the photo only from the store's own domains or Shopify's CDN", () => {
  const hosts = ["www.aetrex.com", "aetrex.myshopify.com"];
  assert.equal(avatarPreviewUrl("//www.aetrex.com/cdn/shop/files/ava.png?v=1&width=200", hosts), "https://www.aetrex.com/cdn/shop/files/ava.png?v=1&width=200");
  assert.equal(avatarPreviewUrl("https://cdn.shopify.com/s/files/1/0001/files/a.jpg", hosts), "https://cdn.shopify.com/s/files/1/0001/files/a.jpg");
  assert.equal(avatarPreviewUrl("//evil.example/cdn/shop/files/x.png", hosts), "", "another site");
  assert.equal(avatarPreviewUrl("//www.aetrex.com/pages/x.png", hosts), "", "not a files path");
  assert.equal(avatarPreviewUrl("", hosts), "");
  assert.equal(avatarPreviewUrl(null, hosts), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
