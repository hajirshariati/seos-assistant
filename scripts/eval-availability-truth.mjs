// Availability Truth eval — classify a family + color/size/width request
// against real variant inventory and produce AVAILABLE / UNAVAILABLE /
// UNKNOWN / NOT_FOUND plus the contract answer text.
//
// Run: node scripts/eval-availability-truth.mjs

import assert from "node:assert/strict";
import {
  classifyAvailability,
  buildAvailabilityAnswer,
  resolveAvailabilityRequest,
  isAvailabilityFollowUp,
  variantDataDiagnostics,
  AVAILABILITY_RESULT as R,
} from "../app/lib/availability-truth.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// REAL Shopify shape: optionsJson is JSON.stringify(selectedOptions) — an
// ARRAY of { name, value }. (The earlier object-shape fixtures hid the bug.)
const variant = (size, color, qty, width) => {
  const opts = [{ name: "Color", value: color }];
  if (size != null) opts.push({ name: "Size", value: String(size) });
  if (width) opts.push({ name: "Width", value: width === "wide" ? "Wide" : width === "narrow" ? "Narrow" : "Medium" });
  return { sku: `${color}-${size}${width || ""}`, inventoryQty: qty, optionsJson: JSON.stringify(opts) };
};

// Catalog fixture (Shopify-style products with variants).
const JILLIAN_BLACK = {
  handle: "jillian-black", title: "Jillian Braided Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 3), variant(8, "Black", 5), variant(9, "Black", 0)],
};
const JILLIAN_NAVY = {
  handle: "jillian-navy", title: "Jillian Braided Quarter Strap Sandal - Navy",
  variants: [variant(7, "Navy", 2), variant(8, "Navy", 4)],
};
// Savannah Champagne: variants carry NO size data (untracked) → UNKNOWN.
const SAVANNAH_CHAMPAGNE = {
  handle: "savannah-champ", title: "Savannah Adjustable Quarter Strap Sandal - Champagne",
  variants: [{ sku: "champ", inventoryQty: null, optionsJson: JSON.stringify([{ name: "Color", value: "Champagne" }]) }],
};
const SAVANNAH_BLACK = {
  handle: "savannah-black", title: "Savannah Adjustable Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 4), variant(8, "Black", 2)],
};
const ROMY = { handle: "romy", title: "Romy Wedge Sandal - Tan", variants: [variant(8, "Tan", 5)] };
const CATALOG = [JILLIAN_BLACK, JILLIAN_NAVY, SAVANNAH_CHAMPAGNE, SAVANNAH_BLACK, ROMY];

const classify = (family, color, size, width) => classifyAvailability({ products: CATALOG, family, color, size, width });

// ── single-turn classification ────────────────────────────────────────
check("Jillian black size 8 → AVAILABLE", () => {
  const v = classify("jillian", "black", "8");
  assert.equal(v.result, R.AVAILABLE);
  assert.match(buildAvailabilityAnswer(v), /Yes — the Jillian is available in Black, size 8\./);
});
check("Jillian black size 9 (OOS) → UNAVAILABLE", () => {
  const v = classify("jillian", "black", "9");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.match(buildAvailabilityAnswer(v), /not seeing the Jillian available in Black, size 9/i);
});
check("Jillian size 8.5 (not carried, sizes known) → UNAVAILABLE", () => {
  assert.equal(classify("jillian", null, "8.5").result, R.UNAVAILABLE);
});
check("Jillian in pink (color not carried) → UNAVAILABLE", () => {
  const v = classify("jillian", "pink");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.equal(v.reason, "color_not_carried");
});
check("Jillian in black (color only, in stock) → AVAILABLE", () => {
  assert.equal(classify("jillian", "black").result, R.AVAILABLE);
});
check("Savannah champagne size 7 wide (no variant data) → UNKNOWN", () => {
  const v = classify("savannah", "champagne", "7", "wide");
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "no_variant_inventory");
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /I can find the Savannah in Champagne/);
  assert.match(txt, /can't verify size 7 wide/);
  assert.match(txt, /product page/);
});
check("Savannah black size 7 → AVAILABLE (different color has data)", () => {
  assert.equal(classify("savannah", "black", "7").result, R.AVAILABLE);
});
check("Is Savannah available in champagne (color only, untracked=available) → AVAILABLE", () => {
  // untracked inventory (qty null) is treated as available
  assert.equal(classify("savannah", "champagne").result, R.AVAILABLE);
});
check("Savannah in wide (width only, no width data on champagne/black) → UNAVAILABLE or UNKNOWN", () => {
  const v = classify("savannah", null, null, "wide");
  assert.ok([R.UNAVAILABLE, R.UNKNOWN].includes(v.result));
});
check("Tamara (not in catalog) → NOT_FOUND", () => {
  const v = classify("tamara", "black", "8");
  assert.equal(v.result, R.NOT_FOUND);
  assert.match(buildAvailabilityAnswer(v), /not finding that exact Tamara style/);
});

// ── answer text never contains banned phrases ─────────────────────────
check("no availability answer says 'take a look' / 'tell me more'", () => {
  for (const r of [R.AVAILABLE, R.UNAVAILABLE, R.UNKNOWN, R.NOT_FOUND]) {
    const txt = buildAvailabilityAnswer({ result: r, family: "jillian", color: "black", size: "8", product: JILLIAN_BLACK });
    assert.doesNotMatch(txt, /take a look|tell me more|closest match/i);
  }
});

// ── display: the verdict always carries the one family product ─────────
check("verdict.product is the named family product (for card display)", () => {
  const v = classify("jillian", "black", "8");
  assert.equal(v.product.handle, "jillian-black");
});

// ── A. constraint parsing straight from the message ───────────────────
import { parseAvailabilityConstraints, constraintIntent } from "../app/lib/availability-truth.js";
const parse = (msg, known = []) => parseAvailabilityConstraints(msg, known);
check("'Savannah in champagne size 7 wide' parses champagne/7/wide", () => {
  const c = parse("Do you have Savannah in champagne size 7 wide?", ["champagne"]);
  assert.equal(c.color, "champagne"); assert.equal(c.size, "7"); assert.equal(c.width, "wide");
});
check("'Jillian in black size 8' parses black/8", () => {
  const c = parse("Do you have Jillian in black size 8?");
  assert.equal(c.color, "black"); assert.equal(c.size, "8"); assert.equal(c.width, null);
});
check("'Jillian in pink' parses pink, no size", () => {
  const c = parse("Do you have Jillian in pink?");
  assert.equal(c.color, "pink"); assert.equal(c.size, null);
});
check("'in an 8' / 'do you have a 9' parse the size", () => {
  assert.equal(parse("Do you have it in an 8?").size, "8");
  assert.equal(parse("do you have a 9?").size, "9");
  assert.equal(parse("size 8.5").size, "8.5");
});
check("'7 wide' parses size 7 + width wide", () => {
  const c = parse("do you have a 7 wide?");
  assert.equal(c.size, "7"); assert.equal(c.width, "wide");
});
check("champagne counts even when only in catalog (knownColors)", () => {
  assert.equal(parse("is it available in champagne?", ["champagne"]).color, "champagne");
});
check("'under $100' / '10 miles' are NOT parsed as sizes", () => {
  assert.equal(parse("cute black sandals under $100").size, null);
  assert.equal(parse("walking 10 miles a day").size, null);
});
check("constraintIntent flags requested size/width/color", () => {
  const i = constraintIntent("Savannah in champagne size 7 wide", ["champagne"]);
  assert.equal(i.color, true); assert.equal(i.size, true); assert.equal(i.width, true);
});

// ── C. follow-up state inheritance from the prior message ─────────────
check("'what about size 9?' after Savannah champagne 7 wide → savannah/champagne/9/wide", () => {
  const req = resolveAvailabilityRequest({
    message: "What about size 9?",
    priorMessage: "Do you have Savannah in champagne size 7 wide?",
    namedFamilies: [],
    focusProduct: { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" },
    isFollowUp: true,
    knownColors: ["champagne"],
  });
  assert.equal(req.family, "savannah");
  assert.equal(req.color, "champagne"); // inherited from focus/prior
  assert.equal(req.size, "9");          // new size overrides prior 7
  assert.equal(req.width, "wide");      // inherited prior width
});
check("'and in black?' after Jillian size 8 → jillian/black/8", () => {
  const req = resolveAvailabilityRequest({
    message: "And in black?",
    priorMessage: "Do you have Jillian in size 8?",
    namedFamilies: [],
    focusProduct: { title: "Jillian Braided Quarter Strap Sandal - Navy" },
    isFollowUp: true,
  });
  assert.equal(req.family, "jillian");
  assert.equal(req.color, "black"); // new color replaces prior/focus navy
  assert.equal(req.size, "8");      // inherited prior size
});
check("fresh named question does NOT inherit from a stale focus", () => {
  const req = resolveAvailabilityRequest({
    message: "Do you have Savannah in champagne size 7 wide?",
    priorMessage: "Show me cute black sandals under $100",
    namedFamilies: ["savannah"],
    focusProduct: { title: "Some Sandal - Black" },
    isFollowUp: false,
    knownColors: ["champagne"],
  });
  assert.equal(req.family, "savannah");
  assert.equal(req.color, "champagne"); // NOT inherited black
  assert.equal(req.size, "7");
  assert.equal(req.width, "wide");
});
check("non-follow-up with no named family does not guess a family", () => {
  const req = resolveAvailabilityRequest({
    message: "what size?",
    namedFamilies: [],
    focusProduct: { title: "Jillian Braided Quarter Strap Sandal - Black" },
    isFollowUp: false,
  });
  assert.equal(req.family, null);
});

// ── B. unparsed requested constraint → UNKNOWN, never false AVAILABLE ──
check("requested size present but unparsed → UNKNOWN (not AVAILABLE)", () => {
  const v = classifyAvailability({ products: CATALOG, family: "jillian", color: "black", size: null, width: null, unverifiedConstraints: ["size"] });
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "unparsed_requested_constraints");
});

// ── #1 width inherited on a size-only follow-up (real message array) ──
import { priorAvailabilityMessage } from "../app/lib/availability-truth.js";
check("priorAvailabilityMessage finds the prior availability question", () => {
  const messages = [
    { role: "user", content: "Do you have Savannah in champagne size 7 wide?" },
    { role: "assistant", content: "I can find the Savannah in Champagne…" },
    { role: "user", content: "What about size 9?" },
  ];
  assert.match(priorAvailabilityMessage(messages, ["champagne"]), /champagne size 7 wide/);
});
check("'what about size 9?' inherits champagne + wide from the conversation", () => {
  const messages = [
    { role: "user", content: "Do you have Savannah in champagne size 7 wide?" },
    { role: "assistant", content: "…" },
    { role: "user", content: "What about size 9?" },
  ];
  const knownColors = ["champagne"];
  const req = resolveAvailabilityRequest({
    message: "What about size 9?",
    priorMessage: priorAvailabilityMessage(messages, knownColors),
    namedFamilies: [],
    focusProduct: { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" },
    isFollowUp: true,
    knownColors,
  });
  assert.equal(req.family, "savannah");
  assert.equal(req.color, "champagne");
  assert.equal(req.size, "9");
  assert.equal(req.width, "wide"); // inherited from the prior availability turn
});
check("priorAvailabilityMessage handles content blocks + ignores tool results", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Do you have Jillian in black size 8 wide?" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "[]" }] },
    { role: "user", content: "What about size 9?" },
  ];
  assert.match(priorAvailabilityMessage(messages), /black size 8 wide/);
});

// ── #3 UNKNOWN wording is explicit about the data limit + names size/width ──
check("UNKNOWN no_variant_inventory text says can't verify + names size/width", () => {
  const v = classify("savannah", "champagne", "7", "wide");
  assert.equal(v.result, R.UNKNOWN);
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /can't verify size 7 wide/);
  assert.match(txt, /product page/);
  assert.doesNotMatch(txt, /^yes —/i);
});

// ── #4 unavailable color → the verdict carries ONLY the named family ──
check("Jillian in pink → product is Jillian (never an alternative family)", () => {
  const v = classify("jillian", "pink");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.match(v.product.title, /Jillian/);
});

// ── Shopify selectedOptions ARRAY shape (the real sync) reads correctly ──
import { inStockSizes, inStockWidths } from "../app/lib/variant-matcher.server.js";
const JILLIAN_REAL = {
  handle: "jillian-real", title: "Jillian Braided Quarter Strap Sandal - Black",
  variants: [{
    sku: "jil-blk-8w", inventoryQty: 3,
    optionsJson: JSON.stringify([
      { name: "Color", value: "Black" },
      { name: "Size", value: "8" },
      { name: "Width", value: "Wide" },
    ]),
  }],
};
check("array-shape: Jillian black size 8 → AVAILABLE (was UNKNOWN before fix)", () => {
  const v = classifyAvailability({ products: [JILLIAN_REAL], family: "jillian", color: "black", size: "8" });
  assert.equal(v.result, R.AVAILABLE);
});
check("array-shape: Jillian black size 8 wide → AVAILABLE", () => {
  const v = classifyAvailability({ products: [JILLIAN_REAL], family: "jillian", color: "black", size: "8", width: "wide" });
  assert.equal(v.result, R.AVAILABLE);
});
check("array-shape: inStockSizes({width:wide}) includes '8'", () => {
  assert.ok(inStockSizes(JILLIAN_REAL, { width: "wide" }).includes("8"));
});
check("array-shape: inStockWidths({size:'8'}) includes 'wide'", () => {
  assert.ok(inStockWidths(JILLIAN_REAL, { size: "8" }).includes("wide"));
});
check("array-shape: variantDataDiagnostics reports optionShape=array + sizes/widths", () => {
  const d = variantDataDiagnostics([JILLIAN_REAL], "jillian");
  assert.equal(d.optionShape, "array");
  assert.equal(d.variants, 1);
  assert.ok(d.sizes.includes("8"));
  assert.ok(d.widths.includes("wide"));
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
