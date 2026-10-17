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

test("CTA is a SECONDARY outline action (not the buy CTA)", () => {
  const body = fnBody("injectVizButton");
  assert.match(body, /createElement\('button'\)/, "a real button");
  assert.match(body, /ai-chat-viz-btn/, "styled by the stylesheet class");
  assert.doesNotMatch(body, /cssText|box-shadow|linear-gradient/, "no inline, heavy or loud styling");
  const css = readFileSync(new URL("../extensions/hajirai-chat-widget/assets/hajirai-chat-widget.css", import.meta.url), "utf8");
  const start = css.indexOf("\n.ai-chat-msg-bubble .ai-chat-viz-btn {");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /background: #fff/, "white fill");
  assert.match(rule, /border: 1px solid/, "thin outline");
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
test("layout is TWO COLUMNS: a narrow compact left rail + flexible hero column", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-expanded\{display:grid/, "grid container");
  // Narrow ~220px left rail (minmax can't be blown wide), right column fills.
  assert.match(style, /\.ai-chat-viz-expanded\{display:grid;grid-template-columns:minmax\(0,220px\) minmax\(0,1fr\)/, "narrow compact left column, hero right fills");
  assert.doesNotMatch(style, /grid-template-columns:240px/, "the old wider 240px left column is gone");
  assert.doesNotMatch(style, /minmax\(0,300px\)/, "the old 300px left column is gone");
});

test("desktop columns are EQUAL HEIGHT via grid stretch (right matches the left stack)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-expanded\{[^}]*align-items:stretch/, "grid items share the row → equal height");
  // The right preview + image host fill the grid-row height so the result card
  // can resolve height:100% against a definite height.
  assert.match(style, /\.ai-chat-viz-preview\{[^}]*height:100%/, "right column fills the row height");
  assert.match(style, /\.ai-chat-viz-image\{[^}]*height:100%/, "image host fills the row height");
});

test("the left product card is COMPACT (max 220px), not the hero", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*max-width:220px!important/, "card capped at 220px");
  assert.doesNotMatch(style, /minmax\(220px,260px\)/, "the old stretch-column layout is gone");
});

test("the right preview card FILLS the row height; image wrapper grows, caption pinned", () => {
  const style = fnBody("injectVizStyleOnce");
  // Desktop result fills the row (height:100%/min-height:100%), NOT a fixed ratio.
  assert.match(style, /\.ai-chat-viz-result\{[^}]*height:100%/, "result card fills the grid row height");
  assert.match(style, /\.ai-chat-viz-result\{[^}]*min-height:100%/, "never shorter than the row");
  assert.match(style, /\.ai-chat-viz-result\{[^}]*display:flex[^}]*flex-direction:column/, "column: image area then caption");
  // The image area is its own wrapper that grows (flex:1); caption is flex:0.
  assert.match(style, /\.ai-chat-viz-result-imgwrap\{[^}]*flex:1 1 auto/, "image wrapper grows to fill");
  assert.match(style, /\.ai-chat-viz-result-img\{[^}]*object-fit:cover/, "image covers the wrapper");
  assert.match(style, /\.ai-chat-viz-result-img\{[^}]*object-position:center bottom/, "keep the shoe in frame when tall");
  assert.match(style, /\.ai-chat-viz-disclaimer\{[^}]*flex:0 0 auto/, "caption pinned at the bottom, separate flex row");
  // Desktop must NOT pin a fixed aspect ratio (that breaks equal-height stretch).
  // aspect-ratio appears ONLY inside the mobile @media block, never in the base rule.
  const desktopResult = (style.split("@media")[0].match(/\.ai-chat-viz-result\{[^}]*\}/) || [""])[0];
  assert.doesNotMatch(desktopResult, /aspect-ratio/, "no fixed aspect ratio on the desktop result");
});

test("the caption lives OUTSIDE the image wrapper (never overlaid on the image)", () => {
  const result = fnBody("vizResultHtml");
  assert.match(result, /class="ai-chat-viz-result-imgwrap"><img class="ai-chat-viz-result-img"/, "image is inside its own wrapper");
  // The image wrapper closes (/></div>) BEFORE the caption node — caption is a
  // sibling, not nested in the image area. (Source is string-concatenated, so we
  // check ordering rather than an adjacency regex.)
  const closeIdx = result.indexOf("/></div>");
  const discIdx = result.indexOf("ai-chat-viz-disclaimer");
  assert.ok(closeIdx !== -1 && discIdx !== -1 && closeIdx < discIdx, "caption comes after the closed image wrapper");
});

test("the result/loading HTML uses the stable layout classes (not just inline styles)", () => {
  const result = fnBody("vizResultHtml");
  assert.match(result, /class="ai-chat-viz-result"/, "result wrapper class");
  assert.match(result, /class="ai-chat-viz-result-img"/, "result image class");
  assert.match(result, /class="ai-chat-viz-disclaimer"/, "disclaimer class");
  const loading = fnBody("vizLoadingHtml");
  // Loading reuses the SAME result shell → same row-filling height, no jump when
  // the image replaces the skeleton.
  assert.match(loading, /ai-chat-viz-result/, "loading reuses the result shell — same height, no jump");
});

test("the settings panel is injected at host build (loading left stack is full height, no jump)", () => {
  const run = fnBody("runVisualize");
  assert.match(run, /injectVizOptions\(host,cta,card\)/, "Style the look panel injected before/at load, not only on success");
});

test("the left PRODUCT image is contain (never cropped) and compact (fixed height)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*height:130px!important/, "compact fixed-height card image (~120-140px)");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*aspect-ratio:auto!important/, "no forced square");
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img img\{[^}]*object-fit:contain!important/, "product photos use contain — shoes never cropped");
  // The product image must NEVER be set to cover (crops the shoe).
  assert.doesNotMatch(style, /\.ai-chat-viz-controls \.ai-chat-product-img img\{[^}]*object-fit:cover/, "no cover on the product image");
});

test("scene pills are QUIET small controls (~30px), not big CTA blocks", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*min-height:30px!important/, "compact ~30px pill, not 40px+ CTA");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*padding:5px 10px!important/, "tight padding");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*border-radius:999px!important/, "fully rounded quiet pill");
  assert.match(style, /\.ai-chat-viz-opt\{[^}]*font-size:12px!important/, "small label");
});

test("mobile (<700px) stacks AND drops the forced equal-height (natural 4/5 ratio)", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /@media \(max-width:699px\)\{[^@]*\.ai-chat-viz-expanded\{grid-template-columns:1fr;align-items:start\}/, "single column, top-aligned below 700px");
  // Equal-height is removed: preview/image/result no longer fill a row; the
  // result uses a natural aspect ratio instead.
  assert.match(style, /@media \(max-width:699px\)\{[^@]*\.ai-chat-viz-preview\{height:auto\}/, "preview no longer fills a row on mobile");
  assert.match(style, /@media \(max-width:699px\)\{[^@]*\.ai-chat-viz-result\{height:auto;min-height:0;aspect-ratio:4\/5\}/, "mobile result uses a natural 4/5 ratio, not row height");
});

// ── PRD 2026-06-29: mobile = compact HORIZONTAL product row (less whitespace) ──
test("mobile product card is a compact HORIZONTAL row (image left, text right)", () => {
  const style = fnBody("injectVizStyleOnce");
  const mobile = style.slice(style.indexOf("@media (max-width:699px)"));
  // The mobile card is a 2-col grid: a fixed image column + a flexible text column.
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*display:grid!important/, "horizontal grid row on mobile");
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*grid-template-columns:96px 1fr!important/, "fixed image column + flexible text column");
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*align-items:center!important/, "vertically centered row");
});

test("mobile product IMAGE is compact (~96px) and still object-fit:contain", () => {
  const style = fnBody("injectVizStyleOnce");
  const mobile = style.slice(style.indexOf("@media (max-width:699px)"));
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*width:96px!important[^}]*height:96px!important/, "compact fixed image box, no tall area");
  // contain comes from the base rule (not overridden on mobile), so the shoe isn't cropped.
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img img\{[^}]*object-fit:contain!important/, "image stays contain on mobile too");
  assert.doesNotMatch(mobile, /\.ai-chat-product-img\{[^}]*aspect-ratio:4\/5/, "no forced desktop aspect ratio on the mobile card image");
});

test("mobile CTA is compact-but-tappable (~40px, capped width), not a full-width block", () => {
  const style = fnBody("injectVizStyleOnce");
  const mobile = style.slice(style.indexOf("@media (max-width:699px)"));
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-cta\{[^}]*min-height:40px!important/, "tappable ~40px");
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-cta\{[^}]*max-width:160px!important/, "sized to content, not full-width");
});

test("mobile introduces NO horizontal overflow (box-sizing + min-width:0 on the text column)", () => {
  const style = fnBody("injectVizStyleOnce");
  const mobile = style.slice(style.indexOf("@media (max-width:699px)"));
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*box-sizing:border-box!important/, "padding doesn't widen the card past 100%");
  assert.match(mobile, /\.ai-chat-viz-controls \.ai-chat-product-info\{[^}]*min-width:0!important/, "text column can shrink — no min-content overflow");
  // No scrollbars / viewport-width hacks anywhere in the visualizer CSS.
  assert.doesNotMatch(style, /overflow-x:(auto|scroll)/, "no horizontal scroll introduced");
  assert.doesNotMatch(style, /100vw/, "no viewport-width rule that could overflow the bubble");
});

test("the mobile changes are SCOPED to the media query — desktop card stays vertical", () => {
  const style = fnBody("injectVizStyleOnce");
  // The base (non-media) card rule is still display:block (vertical stack).
  const base = style.split("@media")[0];
  assert.match(base, /\.ai-chat-viz-controls \.ai-chat-product-card\{[^}]*display:block!important/, "desktop card unchanged (vertical block)");
  assert.doesNotMatch(base, /grid-template-columns:96px 1fr/, "the horizontal row is mobile-only");
});

test("the widget carries a current build marker (so the live version is verifiable)", () => {
  assert.match(SRC, /\[hajirai-widget\] build 2026-10-17 fitfinder-compact/, "console build marker bumped for this change");
});

// ── PRD 2026-06-29: stability — single-flight, cancellation, no runaway repaint ──
test("runVisualize is SINGLE-FLIGHT — a repeat CTA tap never builds a second host/request", () => {
  const run = fnBody("runVisualize");
  // Guard checks an existing host / loading|ready state and bails early.
  assert.match(run, /card\._aiVizHost\|\|card\.dataset\.vizState==='loading'\|\|card\.dataset\.vizState==='ready'/, "early-return guard on existing host / state");
  assert.match(run, /scrollIntoView/, "a repeat tap scrolls to the existing preview instead of refetching");
  assert.match(run, /card\.dataset\.vizState='loading'/, "marks the card loading before building the host");
  assert.match(run, /card\._aiVizHost=host/, "remembers the host on the card for re-entry");
});

test("vizFetch CANCELS prior work before a new scene request (no stacked fetches/timers)", () => {
  const fetchBody = fnBody("vizFetch");
  assert.match(fetchBody, /vizFetchCleanup\(host\)/, "tears down prior request/timers first");
  const cleanup = fnBody("vizFetchCleanup");
  assert.match(cleanup, /clearInterval\(host\._vizIv\)/, "clears the prior step interval");
  assert.match(cleanup, /clearTimeout\(host\._vizTo\)/, "clears the prior timeout");
  assert.match(cleanup, /host\._vizAbort\.abort\(\)/, "aborts the prior in-flight fetch");
});

test("vizFetch tags each request and renders ONLY the latest (stale responses dropped)", () => {
  const fetchBody = fnBody("vizFetch");
  assert.match(fetchBody, /host\._vizReqId=\(host\._vizReqId\|\|0\)\+1/, "monotonic request id per call");
  // Both the success and error paths bail when superseded.
  assert.equal((fetchBody.match(/if\(reqId!==host\._vizReqId\)return/g) || []).length, 2, "latest-only guard on both then/catch");
});

test("scene buttons are DISABLED while a request is in flight, re-enabled after", () => {
  const fetchBody = fnBody("vizFetch");
  assert.match(fetchBody, /vizSetSceneDisabled\(host,true\)/, "disabled at request start");
  assert.match(fetchBody, /vizSetSceneDisabled\(host,false\)/, "re-enabled on settle");
  const setter = fnBody("vizSetSceneDisabled");
  assert.match(setter, /\.ai-chat-viz-opt/, "targets the scene pills");
  assert.match(setter, /disabled/, "toggles the disabled state");
  // CSS makes a disabled pill non-interactive.
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-opt\[disabled\]\{[^}]*pointer-events:none!important/, "disabled pill ignores clicks");
});

test("loading is LIGHTWEIGHT — no full-card infinite shimmer repaint loop", () => {
  const loading = fnBody("vizLoadingHtml");
  // The old heavy shimmer (animated background-position over a big block) is gone.
  assert.doesNotMatch(loading, /animation:aiChatViz /, "no big shimmer animation in the loading card");
  assert.match(loading, /ai-chat-viz-loading-fill/, "static fill class");
  assert.match(loading, /ai-chat-viz-spin/, "a single small spinner");
  const style = fnBody("injectVizStyleOnce");
  assert.match(style, /\.ai-chat-viz-loading-fill\{[^}]*background:#f4f4f5/, "the fill is STATIC, not animated");
  assert.match(style, /@media \(prefers-reduced-motion:reduce\)\{\.ai-chat-viz-spin\{animation:none!important\}\}/, "reduced-motion stops the spinner");
});

test("the visualizer never lays a full-page/fixed overlay that blocks the chat", () => {
  const style = fnBody("injectVizStyleOnce");
  assert.doesNotMatch(style, /position:fixed/, "no fixed overlay layer in the injected CSS");
  const run = fnBody("runVisualize");
  assert.doesNotMatch(run, /z-index/, "no high-z-index layer created");
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
  assert.match(style, /\.ai-chat-viz-controls \.ai-chat-product-img\{[^}]*height:130px!important/, "compact fixed-height product image");
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

test("the bubble is pinned to a STABLE width so loading and final image match", () => {
  const run = fnBody("runVisualize");
  // The shrink-to-fit chat bubble must be forced full-width when the visualizer
  // mounts, so the 1fr preview column doesn't jump wider when the image loads.
  assert.match(run, /closest\('\.ai-chat-msg-bubble'\)/, "reaches the message bubble");
  assert.match(run, /vizBubble\.style\.width='100%'/, "bubble pinned to full width");
  assert.match(run, /closest\('\.ai-chat-msg'\)/, "reaches the message");
  assert.match(run, /vizMsg\.style\.width='100%'/, "message pinned to full width (capped by max-width)");
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

test("scene pills are quiet, compact (~30px) and wrap cleanly", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /min-height:30px/, "quiet small pill, not a big CTA");
  assert.match(body, /border-radius:999px/, "fully rounded pill");
  assert.match(body, /flex-wrap:wrap/, "pills wrap into rows");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
