// "See It Styled" widget-source invariants (Aetrex theme extension).
//
// The widget is a browser IIFE with no module exports and the repo has no DOM
// test harness, so we assert the structural guarantees the UX spec depends on
// directly against the source. These catch the regressions that matter:
// the styling action staying secondary, scene controls living OUTSIDE the
// clickable card, clicks never navigating, and the preview never auto-opening.
//
// Run: node scripts/eval-visualize-widget.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(here, "..", "extensions", "hajirai-chat-widget", "assets", "hajirai-chat-widget.js"),
  "utf8",
);

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

// Pull out a function body by name so assertions are scoped, not global.
function fnBody(name) {
  const start = SRC.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}") { depth -= 1; if (depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error(`could not bound function ${name}`);
}

console.log("\nvisualize widget-source invariants\n");

test("CTA is renamed to 'See It Styled' (old name migrated, not shown)", () => {
  assert.match(SRC, /'See It Styled'/);
  const label = fnBody("vizLabel");
  assert.match(label, /!==\s*'Visualize My Look'/, "old default must migrate to the new name");
});

test("CTA is styled as a SECONDARY warm-outline action (not the buy CTA)", () => {
  const body = fnBody("injectVizButton");
  assert.match(body, /#F4E8D3/, "soft warm fill");
  assert.match(body, /1px solid #C9A76D/, "subtle warm border");
  assert.match(body, /#8A6632/, "warm text");
  assert.match(body, /#EAD8B8/, "hover fill");
  assert.doesNotMatch(body, /box-shadow/, "no heavy shadow on the secondary CTA");
  assert.doesNotMatch(body, /linear-gradient/, "no loud gradient fill");
});

test("clicking 'See It Styled' stops propagation (never navigates the card)", () => {
  const body = fnBody("injectVizButton");
  assert.match(body, /e\.preventDefault\(\);e\.stopPropagation\(\);/);
  assert.match(body, /runVisualize\(cta,card\)/);
});

test("preview opens only ON CLICK — injectVizButton wires a handler, never auto-runs", () => {
  const body = fnBody("injectVizButton");
  // runVisualize is reached ONLY through the click/keydown handler `go`.
  assert.ok(
    body.includes("var go=function(e){if(e){e.preventDefault();e.stopPropagation();}runVisualize(cta,card)}"),
    "runVisualize must be wrapped in the propagation-stopping click handler",
  );
  assert.ok(body.includes("addEventListener('click',go)"), "click handler wired");
  // The only runVisualize call in injectVizButton is inside `go`.
  assert.equal(body.split("runVisualize(").length - 1, 1, "no second, bare runVisualize call");
});

test("scene selector lives in the LEFT controls column, not the product card", () => {
  const body = fnBody("injectVizOptions");
  assert.match(SRC, /function injectVizOptions\(host,cta,card\)/, "signature takes host first, not the card");
  assert.match(body, /ai-chat-viz-controls/, "mounts into the left controls column");
  assert.match(body, /mount\.appendChild\(wrap\)/, "options appended to the controls column, not the card");
  assert.doesNotMatch(body, /ai-chat-product-info/, "options must NOT be injected into the card body");
});

test("scene pills stop propagation (clicking a scene never opens the product page)", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /e\.preventDefault\(\);e\.stopPropagation\(\);/);
});

test("scene selector wording is 'Choose a setting' (not 'Try another setting')", () => {
  assert.match(SRC, /Choose a setting/);
  assert.doesNotMatch(SRC, /Try another setting/);
});

test("scene labels are data-driven from the server-sent set (per category)", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /cta\.scenes/, "uses the category-matched scenes from the event");
  assert.match(SRC, /var DEFAULT_VIZ_SCENES=/, "has a fallback set");
});

test("disclaimer reads 'AI style preview. Product details may vary.'", () => {
  assert.match(SRC, /AI style preview\. Product details may vary\./);
  assert.doesNotMatch(SRC, /AI-generated — may not exactly match/);
});

test("the generated image renders in the right column, separate from the card", () => {
  const run = fnBody("runVisualize");
  assert.match(run, /ai-chat-viz-image/, "image host element created");
  assert.match(run, /rightCol\.appendChild\(imgWrap\)/, "image lives in the right column");
});

// ── PRD 2026-06-29: hero-image layout — compact card left, big preview right ──
// Direction: DON'T equalize column heights. The product card is small reference
// content; the generated image is the hero with its own stable portrait ratio.
test("layout is TWO COLUMNS: a FIXED compact left rail + flexible hero column", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-expanded\{display:grid/, "grid container");
  // Fixed 240px left rail, right column fills the rest.
  assert.match(style, /\.ai-chat-viz-expanded\{display:grid;grid-template-columns:240px minmax\(0,1fr\)/, "fixed compact left column, hero right fills");
});

test("columns are TOP-ALIGNED, NOT stretched (card keeps its compact height)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-expanded\{[^}]*align-items:start/, "grid items top-aligned, not equal-height");
  assert.doesNotMatch(style, /align-items:stretch/, "must NOT stretch the card to the image height");
  // No height:100% pinning the card/preview to the row height anymore.
  assert.doesNotMatch(style, /\.ai-chat-viz-controls\{[^}]*height:100%/, "left column is not forced to fill the row");
});

test("the left product card is COMPACT (max 240px), not the hero", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*max-width:240px!important/, "card capped at 240px");
  assert.doesNotMatch(style, /minmax\(220px,260px\)/, "the old stretch-column layout is gone");
});

test("the generated image is the HERO: stable 4/5 portrait ratio, object-fit:cover", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-result\{[^}]*aspect-ratio:4\/5/, "stable portrait ratio, not tied to left column height");
  assert.match(style, /\.ai-chat-viz-result\{[^}]*min-height:420px/, "stays large");
  assert.match(style, /\.ai-chat-viz-result\{[^}]*max-height:620px/, "bounded so it never gets absurd");
  assert.match(style, /\.ai-chat-viz-result-img\{[^}]*object-fit:cover/, "generated image fills as the hero");
  assert.match(style, /\.ai-chat-viz-result-img\{[^}]*flex:1 1 auto/, "image grows to fill");
  assert.match(style, /\.ai-chat-viz-disclaimer\{[^}]*flex:0 0 auto/, "disclaimer pinned at the bottom, doesn't shrink the image");
});

test("the result/loading HTML uses the stable layout classes (not just inline styles)", () => {
  const result = fnBody("vizResultHtml");
  assert.match(result, /class="ai-chat-viz-result"/, "result wrapper class");
  assert.match(result, /class="ai-chat-viz-result-img"/, "result image class");
  assert.match(result, /class="ai-chat-viz-disclaimer"/, "disclaimer class");
  const loading = fnBody("vizLoadingHtml");
  assert.match(loading, /ai-chat-viz-result/, "loading reuses the result shell — same footprint, no giant gray block");
});

test("the left PRODUCT image is contain (never cropped) and compact (fixed height)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*height:150px!important/, "compact fixed-height card image");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*aspect-ratio:auto!important/, "no forced square");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img img\{[^}]*object-fit:contain!important/, "product photos use contain — shoes never cropped");
  // The product image must NEVER be set to cover (crops the shoe).
  assert.doesNotMatch(style, /\.ai-chat-viz-controls \.ai-chat-product-img img\{[^}]*object-fit:cover/, "no cover on the product image");
});

test("scene pills are QUIET small controls (~32px), not big CTA blocks", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*min-height:32px!important/, "compact ~32px pill, not 40px+ CTA");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*border-radius:999px!important/, "fully rounded quiet pill");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*font-size:12px!important/, "small label");
});

test("mobile stacks ONLY under 700px (card full-width, preview drops the max cap)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /@media \(max-width:699px\)\{\.ai-chat-viz-expanded\{grid-template-columns:1fr\}/, "single column only below 700px, valid @media syntax");
  assert.match(style, /@media \(max-width:699px\)\{[^@]*\.ai-chat-viz-result\{min-height:320px;max-height:none\}/, "mobile preview keeps a floor but drops the desktop cap");
  assert.match(style, /@media \(max-width:699px\)\{[^@]*\.ai-chat-product-card\{max-width:100%!important\}/, "card may go full-width on mobile");
});

test("the widget carries a current build marker (so the live version is verifiable)", () => {
  assert.match(SRC, /\[hajirai-widget\] build 2026-06-29 see-it-styled-hero-image/, "console build marker bumped for this change");
});

// ── PRD 2026-06-29: the keyframes/layout <style> ids must NOT collide ──
// The startup keyframe <style> and injectVizStyleOnce() used the SAME id
// (`ai-chat-viz-style`). The keyframes element wins the race, so the
// getElementById guard in injectVizStyleOnce() short-circuited and the LAYOUT
// CSS (grid + card reset) never got injected — desktop stacked. Distinct ids fix it.
test("keyframes and layout styles use DISTINCT ids (no collision)", () => {
  assert.match(SRC, /id='ai-chat-viz-keyframes-style'/, "startup keyframes use their own id");
  assert.match(SRC, /id='ai-chat-viz-layout-style'/, "expanded layout CSS uses its own id");
  // The old shared id must be gone entirely.
  assert.doesNotMatch(SRC, /'ai-chat-viz-style'/, "the colliding shared id must be removed");
});

test("injectVizStyleOnce guards on the LAYOUT id, never the keyframes id", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /getElementById\('ai-chat-viz-layout-style'\)/, "idempotency check uses the layout id");
  assert.doesNotMatch(style, /ai-chat-viz-keyframes-style/, "must not short-circuit on the keyframes element");
});

test("the card override beats the showcase carousel CSS (!important, compact block)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*display:block!important/, "vertical block card");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*width:100%!important/, "fills the compact column, not wider");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*min-width:0!important/, "can shrink — no min-content blowout");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*height:150px!important/, "compact fixed-height product image");
  // View product stays the visible black primary button.
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-cta\{[^}]*background:#000!important/, "View product stays the black primary button");
});

test("the CSS travels WITH the JS (injected <style>, no separate stylesheet to cache)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /getElementById\('ai-chat-viz-layout-style'\)/, "injected once, idempotent");
  assert.match(style, /document\.createElement\('style'\)/, "a <style> element carried with the JS");
  const run = fnBody("runVisualize");
  assert.match(run, /injectVizStyleOnce\(\)/, "runVisualize injects the styles");
});

test("the product card is MOVED into the left controls column", () => {
  const run = fnBody("runVisualize");
  assert.match(run, /leftCol\.appendChild\(card\)/, "card moved into the left column");
  assert.match(run, /ai-chat-viz-controls/, "left controls column");
});

test("the expanded layout is anchored OUTSIDE the products carousel container", () => {
  const run = fnBody("runVisualize");
  assert.match(run, /closest\('\.ai-chat-products-wrap'\)/, "escapes the showcase scroll/scope");
  assert.match(run, /insertBefore\(host,anchor\.nextSibling\)/, "wrapper placed after the products container");
  // The emptied products container is hidden so no blank gap remains.
  assert.match(run, /\.style\.display='none'/, "empty products container hidden");
});

test("scene panel is a distinct 'Style the look' panel with a 'Choose a setting' helper", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /Style the look/, "panel header");
  assert.match(body, /Choose a setting/, "helper text");
  assert.match(body, /border:1px solid #E7DAC1/, "subtle bordered panel, visually separate from the card");
  assert.doesNotMatch(body, /box-shadow/, "no heavy shadow");
});

test("scene pills are quiet, compact (~32px) and wrap cleanly", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /min-height:32px/, "quiet small pill, not a big CTA");
  assert.match(body, /border-radius:999px/, "fully rounded pill");
  assert.match(body, /flex-wrap:wrap/, "pills wrap into rows");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
