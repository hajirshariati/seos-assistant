// "Visualize My Look" CTA gating eval. The CTA must appear ONLY when:
// the feature is enabled, a supported provider + its key are set, and
// the turn ends with exactly ONE product that has an image.
//
// Run: node scripts/eval-visualize-cta.mjs

import assert from "node:assert/strict";
import { buildVisualizeCtaEvent, visualizeSceneGroup, VISUALIZE_SCENE_GROUPS } from "../app/lib/visualize-cta.server.js";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

const enabledGemini = { visualizeLookEnabled: true, imageProvider: "gemini", geminiApiKey: "k", visualizeLookLabel: "Visualize My Look" };
const enabledOpenai = { visualizeLookEnabled: true, imageProvider: "openai", openaiApiKey: "k", visualizeLookLabel: "See It Styled" };
const product = { handle: "maui-black", title: "Maui Sandal", image: "https://cdn.example/x.jpg" };
const messages = [{ role: "user", content: "heels to go with my blue dress" }];

console.log("\nvisualize-cta gating eval\n");

test("fires for enabled + gemini key + single product with image", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledGemini, product, messages });
  assert.ok(ev && ev.type === "visualize_cta");
  assert.equal(ev.productHandle, "maui-black");
  assert.equal(ev.label, "Visualize My Look");
  assert.match(ev.styleContext, /blue dress/);
});

test("fires for openai provider with its key + custom label", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledOpenai, product, messages });
  assert.ok(ev && ev.label === "See It Styled");
});

test("falls back to the 'See It Styled' default label when blank", () => {
  const ev = buildVisualizeCtaEvent({ config: { ...enabledGemini, visualizeLookLabel: "" }, product, messages });
  assert.equal(ev.label, "See It Styled");
});

test("null when feature disabled", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, visualizeLookEnabled: false }, product, messages }), null);
});

test("null when provider unsupported / unset", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, imageProvider: "" }, product, messages }), null);
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, imageProvider: "midjourney" }, product, messages }), null);
});

test("null when the selected provider's key is missing", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, geminiApiKey: "" }, product, messages }), null);
  assert.equal(buildVisualizeCtaEvent({ config: { visualizeLookEnabled: true, imageProvider: "openai", openaiApiKey: "" }, product, messages }), null);
});

test("null when product has no image (can't style what we can't see)", () => {
  assert.equal(buildVisualizeCtaEvent({ config: enabledGemini, product: { handle: "x", title: "X" }, messages }), null);
});

test("null when product has no handle", () => {
  assert.equal(buildVisualizeCtaEvent({ config: enabledGemini, product: { image: "https://x/y.jpg" }, messages }), null);
});

test("accepts featuredImageUrl as the image source", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledGemini, product: { handle: "h", title: "T", featuredImageUrl: "https://x/y.jpg" }, messages });
  assert.ok(ev && ev.productImage === "https://x/y.jpg");
});

// ── Aetrex polish: only visible footwear gets the styling CTA ──
const styleable = { handle: "h", image: "https://x/y.jpg" };
const fires = (extra) => buildVisualizeCtaEvent({ config: enabledGemini, product: { ...styleable, ...extra }, messages });

test("footwear categories DO get the styling CTA", () => {
  for (const category of ["Sandals", "Sneakers", "Loafers", "Boots", "Wedges Heels"]) {
    const ev = fires({ category, title: `Maui ${category}` });
    assert.ok(ev && ev.type === "visualize_cta", `expected CTA for ${category}`);
  }
});

test("non-style products do NOT get the styling CTA", () => {
  const blocked = [
    { category: "Orthotics", title: "Premium Memory Foam Orthotics" },
    { category: "Insoles", title: "Cushion Insole" },
    { category: "Inserts", title: "Gel Insert" },
    { category: "Footbeds", title: "Replacement Footbed" },
    { category: "Accessories", title: "Leather Protector Spray" },
    { category: "Accessories", title: "Aetrex Foot Roller" },
    { category: "Socks", title: "Compression Socks" },
    { category: "Shoe Care", title: "Cleaning Care Kit" },
  ];
  for (const p of blocked) {
    assert.equal(fires(p), null, `expected NO CTA for ${p.title}`);
  }
});

test("UNDER-TAGGED insole (no Orthotics category) is blocked by the TITLE check", () => {
  // Prod trace 2026-06-29: "Men's Speed Orthotics - Insole For Running" (l700m-m)
  // was NOT category-tagged Orthotics — only productType=Footwear — so the
  // category check missed it and it got a "Style the look" preview of an insole.
  // The title contains "Insole" → must be blocked regardless of tagging.
  assert.equal(fires({ productType: "Footwear", title: "Men's Speed Orthotics - Insole For Running" }), null);
  assert.equal(fires({ title: "Speed Orthotic Insert" }), null);
  assert.equal(fires({ category: "", title: "Replacement Footbeds" }), null);
});

test("orthotic-recommender turn is NEVER visualize-eligible (structural guarantee)", () => {
  // recommend_orthotic only ever returns insoles; the turn flag suppresses the
  // CTA even if the product name has no insole word and no orthotic category.
  const product = { handle: "x", image: "https://cdn.example/x.jpg", price: 50, title: "Premium Support" };
  assert.equal(buildVisualizeCtaEvent({ config: enabledGemini, product, messages, isInsoleRecommendation: true }), null);
  // ...but the SAME product on a non-recommender turn (a real shoe) still fires.
  assert.ok(buildVisualizeCtaEvent({ config: enabledGemini, product: { ...product, title: "Premium Sneaker", category: "Sneakers" }, messages, isInsoleRecommendation: false }));
});

test("a wearable sandal whose NAME contains 'Orthotic' stays eligible", () => {
  const ev = fires({ category: "Sandals", title: "Maui Orthotic Flip" });
  assert.ok(ev && ev.type === "visualize_cta");
  // Plural-title footwear too (Railway 2026-07-08: "Flips" missed the old noun guard).
  const ev2 = fires({ category: "Sandals", title: "Maui Orthotic Women's Flips - Mocha" });
  assert.ok(ev2 && ev2.type === "visualize_cta");
});

test("category-tagged Orthotics stay blocked even when the title names target footwear", () => {
  // Adversarial-review finding (2026-07-08): real insole titles name their
  // TARGET footwear ("for Heels, Pumps, Flats") or a condition ("Heel Spurs").
  // Those words must never re-enable the styling CTA — an insole on a bare
  // foot is the exact AI-image bug this guard exists to prevent.
  assert.equal(fires({ category: "Orthotics", title: "Men's Orthotics for Heel Spurs" }), null);
  assert.equal(fires({ category: "Orthotics", title: "Aetrex Womens Fashion Orthotics:For Heels, Pumps, Flats: Comfort & Arch Support" }), null);
  assert.equal(fires({ category: "Orthotics", title: "Aetrex Men's Casual Memory Foam Orthotics: Plantar Fasciitis, Flat Feet Relief" }), null);
  // Untagged variants block too.
  assert.equal(fires({ title: "Women's Fashion Orthotics - Insole for Heels" }), null);
  assert.equal(fires({ title: "Men's Orthotics for Heel Spurs" }), null);
});

test("an ORTHOTIC product (title 'Orthotics', no footwear noun) is blocked even when un-tagged", () => {
  // Prod trace 2026-06-30: a resolver-candidate "Men's Orthotics for Overpronation"
  // was NOT category-tagged Orthotics, so the category check missed it and it got
  // a "See It Styled" preview. The title "Orthotics for …" (no wearable footwear
  // noun) must block; "Maui Orthotic Flip" (a real sandal) stays eligible.
  assert.equal(fires({ title: "Men's Orthotics for Overpronation" }), null);
  assert.equal(fires({ productType: "Footwear", title: "Men's Work Posted Orthotics" }), null);
  assert.ok(fires({ category: "Sandals", title: "Maui Orthotic Flip" }));
});

// ── Aetrex polish: scene labels change by product category ──
test("visualizeSceneGroup maps category → group", () => {
  assert.equal(visualizeSceneGroup("Sandals", "Maui Sandal"), "sandals");
  assert.equal(visualizeSceneGroup("Wedges Heels", "Finley Wedge"), "sandals");
  assert.equal(visualizeSceneGroup("Sneakers", "Danika Sneaker"), "sneakers");
  assert.equal(visualizeSceneGroup("Loafers", "Kenzie Loafer"), "dress");
  assert.equal(visualizeSceneGroup("Boots", "Chelsea Boot"), "dress");
  assert.equal(visualizeSceneGroup("", "Mystery Footwear"), "sneakers"); // sensible default
});

test("the event carries the category-matched scene set", () => {
  const sandalEv = fires({ category: "Sandals", title: "Maui Sandal" });
  assert.equal(sandalEv.sceneGroup, "sandals");
  assert.deepEqual(sandalEv.scenes.map((s) => s.label), ["Vacation", "Weekend", "Dinner", "Workday"]);

  const sneakerEv = fires({ category: "Sneakers", title: "Danika Sneaker" });
  assert.deepEqual(sneakerEv.scenes.map((s) => s.label), ["Walking", "Travel", "Errands", "Workday"]);

  const dressEv = fires({ category: "Loafers", title: "Kenzie Loafer" });
  assert.deepEqual(dressEv.scenes.map((s) => s.label), ["Office", "Dinner", "Travel", "Weekend"]);
});

test("every scene group has 4 labelled, context-bearing presets", () => {
  for (const group of Object.values(VISUALIZE_SCENE_GROUPS)) {
    assert.equal(group.length, 4);
    for (const s of group) {
      assert.ok(s.label && s.ctx, "each scene needs a label + ctx");
    }
  }
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
