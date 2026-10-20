// The assistant mark's colors (Settings → Assistant look) and its shader.
// The Settings preview draws with app/lib/orb-shader.js; it must be the very
// shader the storefront widget runs, and every stored value must read as five
// valid colors.
//
// Run: node scripts/eval-orb-colors.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { ORB_FRAG } from "../app/lib/orb-shader.js";
import { ORB_DEFAULT_COLORS, normalizeHex, parseOrbColors, serializeOrbColors, isDefaultOrbColors } from "../app/lib/orb-colors.js";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
