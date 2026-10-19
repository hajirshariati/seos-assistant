// Admin settings → what shoppers see: the rules that decide which setting
// wins when the same thing can be set in two places, and that the admin
// shows the same text the storefront uses.
//
// Run: node scripts/eval-settings-mapping.mjs
import assert from "node:assert/strict";
import { resolveSupport } from "../app/lib/support-handoff.js";
import { visualizeLabel, buildVisualizeCtaEvent } from "../app/lib/visualize-cta.server.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log("\nSee It Styled button");
test("the label is the admin's text exactly; blank or the old default reads See It Styled", () => {
  assert.equal(visualizeLabel({ visualizeLookLabel: "Try it on" }), "Try it on");
  assert.equal(visualizeLabel({ visualizeLookLabel: "Visualize My Look" }), "See It Styled");
  assert.equal(visualizeLabel({ visualizeLookLabel: "  " }), "See It Styled");
  assert.equal(visualizeLabel({}), "See It Styled");
});
test("the storefront event carries that same label", () => {
  const ev = buildVisualizeCtaEvent({
    config: { visualizeLookEnabled: true, imageProvider: "gemini", geminiApiKey: "k", visualizeLookLabel: "Try it on" },
    product: { handle: "jillian", title: "Jillian Sandal", image: "https://x/i.jpg", category: "Sandals", productType: "Footwear" },
    messages: [{ role: "user", content: "sandals for my trip" }],
  });
  assert.equal(ev?.label, "Try it on");
});

console.log("\nSupport button (Settings → Support link vs theme editor)");
test("Settings wins, then the theme editor, then the default", () => {
  assert.deepEqual(resolveSupport({ adminUrl: "https://a/help", adminLabel: "Talk to us", themeUrl: "https://t/x", themeLabel: "Theme label" }), { url: "https://a/help", label: "Talk to us" });
  assert.deepEqual(resolveSupport({ themeUrl: "https://t/x", themeLabel: "Theme label" }), { url: "https://t/x", label: "Theme label" });
  assert.deepEqual(resolveSupport({ themeLabel: "Contact customer service" }), { url: "", label: "Chat with Aetrex Support" });
});
test("a label is shown exactly as typed (no hidden rewrites)", () => {
  assert.equal(resolveSupport({ adminLabel: "Visit Support Hub" }).label, "Visit Support Hub");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
