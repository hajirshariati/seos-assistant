// Mobile compact product-card invariants (Aetrex theme extension stylesheet).
//
// The normal chat product cards (carousel + single/featured) live in the
// widget's CSS file, separate from the visualizer JS. On mobile the product
// IMAGE used to dominate the card (1/1 square at full card width). These
// assertions lock in the compact mobile carousel, the single-card tile
// (the same card as in a carousel, alone) and contained product photos.
//
// Run: node scripts/eval-product-card-css.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  join(here, "..", "extensions", "hajirai-chat-widget", "assets", "hajirai-chat-widget.css"),
  "utf8",
);

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

// Return the body text of the FIRST `@media (max-width: 600px)` block (the one
// that holds the showcase product-card rules), brace-balanced.
function mobileBlock() {
  const start = CSS.indexOf("@media (max-width: 600px)");
  assert.notEqual(start, -1, "mobile @media block not found");
  let i = CSS.indexOf("{", start), depth = 0;
  for (let j = i; j < CSS.length; j++) {
    if (CSS[j] === "{") depth += 1;
    else if (CSS[j] === "}") { depth -= 1; if (depth === 0) return CSS.slice(i, j + 1); }
  }
  throw new Error("could not bound the mobile @media block");
}


console.log("\nmobile compact product-card invariants\n");

const MOBILE = mobileBlock();

test("mobile image WELLS are clean WHITE (no gray gutters/bars)", () => {
  // Catch-all base override kills the #f3f4f6 placeholder fill on mobile.
  assert.match(MOBILE, /\.ai-chat-product-img \{\s*background: #fff/, "base image well is white on mobile");
  // Carousel + single wells are explicitly white.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*background: #fff/, "carousel well white");
  // No gray fill anywhere in the mobile block.
  assert.doesNotMatch(MOBILE, /background:\s*#f[0-9a-f]{2,5}\b(?<!#fff)/i, "no light-gray background on mobile");
  assert.doesNotMatch(MOBILE, /#f3f4f6|#f7f7f7|#eee|#ececec/i, "no known gray placeholder colors");
});

test("mobile CAROUSEL well is TIGHT (~112px) and drops the 1/1 square", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*aspect-ratio: auto/, "no forced 1/1 on mobile");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*height: 112px/, "carousel well is tight, not a tall empty box");
  // The well centers the image (flex), so the photo sits on white, not stretched.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*display: flex[^}]*(align-items: center|justify-content: center)/, "well flex-centers the photo");
});

test("mobile CAROUSEL photo FILLS the well (less empty space) + contain, never cover", () => {
  // Photo fills the well height (minus the small padding) instead of floating.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-width: 90%/, "photo uses most of the width");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-height: 100%/, "photo fills the well height — no big empty margins");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*object-fit: contain/, "contain, not cover");
  // Crucially the image is auto-sized, NOT forced to fill (which would gutter).
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*width: auto[^}]*height: auto/, "image is auto-sized, ratio preserved");
  assert.doesNotMatch(MOBILE, /\.ai-chat-product-img img \{[^}]*object-fit: cover/, "no cover on mobile product images");
});

test("mobile SINGLE card: BOTH CTAs (View product + See It Styled) occupy the cta row", () => {
  // With viz → the actions row is the cta area; without viz → the bare CTA is.
  assert.match(MOBILE, /:only-child \.ai-chat-viz-actions \{[^}]*grid-area: cta/, "actions row spans the bottom");
  assert.match(MOBILE, /:only-child \.ai-chat-viz-actions \{[^}]*width: 100%/, "full-width row");
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*grid-area: cta/, "no-viz View product takes the same row");
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*justify-self: start/, "no-viz CTA is content-sized, left-aligned (not a full-width bar)");
});

// The single recommendation is the same tile as a carousel card, alone —
// defined once, in the design block at the end of the stylesheet.
const SINGLE = CSS.slice(CSS.lastIndexOf("A single recommendation is the same tile as in a carousel"));

test("SINGLE card is a carousel-style tile: fixed width, column, never wider than the reply", () => {
  assert.match(SINGLE, /:only-child \{[^}]*display: flex !important[^}]*flex-direction: column !important/, "image on top, details below");
  assert.match(SINGLE, /:only-child \{[^}]*width: 272px !important[^}]*max-width: 100% !important/, "272px tile, shrinks on narrow screens");
});

test("SINGLE card photo is contained in its well, never cropped", () => {
  assert.match(SINGLE, /:only-child \.ai-chat-product-img \{[^}]*aspect-ratio: 16 \/ 11/, "fixed well shape");
  assert.match(SINGLE, /:only-child \.ai-chat-product-img img \{[^}]*object-fit: contain !important/, "contain, not cover");
});

test("SINGLE card buttons stack full width (Add to cart, then See It Styled)", () => {
  assert.match(SINGLE, /:only-child \.ai-chat-viz-actions \{[^}]*flex-direction: column !important/, "stacked");
});

test("no horizontal-overflow / viewport-width hacks on mobile", () => {
  assert.doesNotMatch(MOBILE, /overflow-x: (auto|scroll)/, "no horizontal scrollbars");
  assert.doesNotMatch(MOBILE, /100vw/, "no viewport-width rule that could overflow the bubble");
});

test("message box is 16px on touch screens (no zoom-on-focus on iPhone or iPad)", () => {
  assert.match(CSS, /@media \(pointer: coarse\) \{[^}]*\.ai-chat-input \{[^}]*font-size: 16px/, "16px on touch");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
