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
  styleKeyOfTitle,
  styleNameOfTitle,
  AVAILABILITY_RESULT as R,
} from "../app/lib/availability-truth.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// REAL Aetrex/Shopify shape: optionsJson is JSON.stringify(selectedOptions) —
// an ARRAY of { name, value } — and Size values carry a "US" unit, e.g.
// "8 US" or the range "9 - 9.5 US". `size` here may be a number/string ("8")
// or a raw label ("9 - 9.5"). Width is only added when given.
const variant = (size, color, qty, width) => {
  const opts = [{ name: "Color", value: color }];
  if (size != null) opts.push({ name: "Size", value: `${size} US` });
  if (width) opts.push({ name: "Width", value: width === "wide" ? "Wide" : width === "narrow" ? "Narrow" : "Medium" });
  return { sku: `${color}-${size}${width || ""}`, inventoryQty: qty, optionsJson: JSON.stringify(opts) };
};

// Catalog fixture (Shopify-style products with variants).
const JILLIAN_BLACK = {
  handle: "jillian-black", title: "Jillian Braided Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 3), variant(8, "Black", 5), variant(9, "Black", 0)],
};
// Jillian comes in ROSE, not Pink — the soft-color path should surface it.
const JILLIAN_ROSE = {
  handle: "jillian-rose", title: "Jillian Braided Quarter Strap Sandal - Rose",
  variants: [variant(7, "Rose", 2), variant(8, "Rose", 3)],
};
const JILLIAN_NAVY = {
  handle: "jillian-navy", title: "Jillian Braided Quarter Strap Sandal - Navy",
  variants: [variant(7, "Navy", 2), variant(8, "Navy", 4)],
};
// Savannah Champagne: REAL sizes (incl a "9 - 9.5 US" range label), NO Width
// option — exactly the live shape that broke before.
const SAVANNAH_CHAMPAGNE = {
  handle: "savannah-champ", title: "Savannah Adjustable Quarter Strap Sandal - Champagne",
  variants: [variant(7, "Champagne", 4), variant("9 - 9.5", "Champagne", 2)],
};
const SAVANNAH_BLACK = {
  handle: "savannah-black", title: "Savannah Adjustable Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 4), variant(8, "Black", 2)],
};
// Untracked / no-size product for the genuine no_variant_inventory case.
const LINA_NAVY = {
  handle: "lina-navy", title: "Lina Slide Sandal - Navy",
  variants: [{ sku: "lina", inventoryQty: null, optionsJson: JSON.stringify([{ name: "Color", value: "Navy" }]) }],
};
const ROMY = { handle: "romy", title: "Romy Wedge Sandal - Tan", variants: [variant(8, "Tan", 5)] };
const CATALOG = [JILLIAN_BLACK, JILLIAN_ROSE, JILLIAN_NAVY, SAVANNAH_CHAMPAGNE, SAVANNAH_BLACK, LINA_NAVY, ROMY];

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
// ── #2 soft color: "Jillian in pink" surfaces Rose, never denies it ──
check("Jillian in pink → AVAILABLE soft-color, matchedColor=rose", () => {
  const v = classify("jillian", "pink");
  assert.equal(v.result, R.AVAILABLE);
  assert.equal(v.softColor, true);
  assert.equal(v.matchedColor, "rose");
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /don't see a color called Pink/i);
  assert.match(txt, /available in Rose/i);
  assert.doesNotMatch(txt, /available in Pink/i);
});
check("Jillian in black (color only, in stock) → AVAILABLE", () => {
  assert.equal(classify("jillian", "black").result, R.AVAILABLE);
});
// ── #1 Aetrex size labels: "7 US" and ranges parse + match ──
check("Savannah champagne size 7 (label '7 US') → AVAILABLE", () => {
  assert.equal(classify("savannah", "champagne", "7").result, R.AVAILABLE);
});
check("Savannah champagne size 9 (range '9 - 9.5 US') → AVAILABLE", () => {
  assert.equal(classify("savannah", "champagne", "9").result, R.AVAILABLE);
});
check("Savannah champagne size 9.5 (range '9 - 9.5 US') → AVAILABLE", () => {
  assert.equal(classify("savannah", "champagne", "9.5").result, R.AVAILABLE);
});
check("Jillian black size 8 (label '8 US') → AVAILABLE", () => {
  assert.equal(classify("jillian", "black", "8").result, R.AVAILABLE);
});
// ── #4 width split: size exists, width not a tracked option ──
check("Savannah champagne size 7 wide → UNKNOWN width_not_in_options + names size 7", () => {
  const v = classify("savannah", "champagne", "7", "wide");
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "width_not_in_options");
  assert.equal(v.sizeAvailable, true);
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /I can find the Savannah in Champagne in size 7/);
  assert.match(txt, /don't see Wide listed as a separate width option/i);
});
check("Savannah champagne size 6 wide (size not carried) → UNAVAILABLE names size", () => {
  const v = classify("savannah", "champagne", "6", "wide");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.match(buildAvailabilityAnswer(v), /not seeing the Savannah in Champagne in size 6/i);
});
check("Savannah black size 7 → AVAILABLE", () => {
  assert.equal(classify("savannah", "black", "7").result, R.AVAILABLE);
});
check("Is Savannah available in champagne (color only) → AVAILABLE", () => {
  assert.equal(classify("savannah", "champagne").result, R.AVAILABLE);
});
check("genuine no-size product (Lina) size 8 → UNKNOWN no_variant_inventory", () => {
  const v = classify("lina", "navy", "8");
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "no_variant_inventory");
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

// ── Color-only follow-up inherits a SIZE set on an earlier turn ──
// 3-turn conversation: "...Jillian non sport in sage?" → "what about size 8?"
// → "and in black?". The color-only follow-up must keep size=8 even though the
// immediately-prior message ("what about size 8?") restated only the size and
// the size-bearing turn is two back from the color request.
import { priorAvailabilityConstraints } from "../app/lib/availability-truth.js";
check("priorAvailabilityConstraints accumulates size + color across prior turns", () => {
  const messages = [
    { role: "user", content: "do you have the Jillian non sport in sage?" },
    { role: "assistant", content: "yes" },
    { role: "user", content: "what about size 8?" },
    { role: "assistant", content: "yes" },
    { role: "user", content: "and in black?" },
  ];
  const acc = priorAvailabilityConstraints(messages, ["sage", "black"]);
  assert.equal(acc.size, "8");
  assert.equal(acc.color, "sage"); // most-recent prior color (overridden by current "black" downstream)
});
check("'and in black?' color-only follow-up → family=jillian, color=black, size=8", () => {
  const messages = [
    { role: "user", content: "do you have the Jillian non sport in sage?" },
    { role: "assistant", content: "yes" },
    { role: "user", content: "what about size 8?" },
    { role: "assistant", content: "yes" },
    { role: "user", content: "and in black?" },
  ];
  const knownColors = ["sage", "black", "rose", "tan"];
  const req = resolveAvailabilityRequest({
    message: "and in black?",
    priorConstraints: priorAvailabilityConstraints(messages, knownColors),
    namedFamilies: ["jillian"], // resolved upstream from focus / family scan
    isFollowUp: true,
    knownColors,
  });
  assert.equal(req.family, "jillian");
  assert.equal(req.color, "black");
  assert.equal(req.size, "8"); // inherited from "what about size 8?" two turns back
});

// ── #3 UNKNOWN wording is explicit about the data limit + names size/width ──
check("UNKNOWN no_variant_inventory (no size data) text says can't verify + product page", () => {
  const v = classify("lina", "navy", "7"); // Lina has no size variants at all
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "no_variant_inventory");
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /can't verify size 7/);
  assert.match(txt, /product page/);
  assert.doesNotMatch(txt, /^yes —/i);
});

// ── verdict carries ONLY the named family (never an alternative) ──
check("Jillian soft-color verdict product is a Jillian (Rose), never another family", () => {
  const v = classify("jillian", "pink");
  assert.match(v.product.title, /Jillian/);
});
check("color with NO family alias (e.g. orange) not carried → UNAVAILABLE color_not_carried", () => {
  const v = classify("jillian", "orange");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.equal(v.reason, "color_not_carried");
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

// ── #1 STYLE disambiguation: "Jillian" covers multiple styles ─────────
// Catalog carrying TWO Jillian styles (Braided + Sport). The bare family token
// must NOT silently pick one.
const JILLIAN_SPORT_BLACK = {
  handle: "jillian-sport-black", title: "Jillian Sport Sandal - Black",
  variants: [variant(7, "Black", 3), variant(8, "Black", 4)],
};
const JILLIAN_SPORT_ROSE = {
  handle: "jillian-sport-rose", title: "Jillian Sport Sandal - Rose",
  variants: [variant(8, "Rose", 2)],
};
const MULTI = [JILLIAN_BLACK, JILLIAN_ROSE, JILLIAN_NAVY, JILLIAN_SPORT_BLACK, JILLIAN_SPORT_ROSE];
const classifyMulti = (color, size, width, styleQuery = "", focusStyleKey = null) =>
  classifyAvailability({ products: MULTI, family: "jillian", color, size, width, styleQuery, focusStyleKey });

check("styleKeyOfTitle distinguishes Braided vs Sport, groups same style", () => {
  assert.equal(styleKeyOfTitle("Jillian Braided Quarter Strap Sandal - Black"), "jillian braided quarter strap");
  assert.equal(styleKeyOfTitle("Jillian Sport Sandal - Black"), "jillian sport");
  assert.equal(styleKeyOfTitle("Jillian Braided Quarter Strap Sandal - Rose"), styleKeyOfTitle("Jillian Braided Quarter Strap Sandal - Black"));
  assert.equal(styleNameOfTitle("Jillian Sport Sandal - Black"), "Jillian Sport Sandal");
});
check("'Jillian in black size 8' w/ Braided+Sport → DISAMBIGUATION (no silent pick)", () => {
  const v = classifyMulti("black", "8", null, "do you have jillian in black size 8?");
  assert.equal(v.result, R.DISAMBIGUATION);
  assert.ok(v.styles.some((s) => /Braided/.test(s)));
  assert.ok(v.styles.some((s) => /Sport/.test(s)));
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /more than one Jillian style/i);
  assert.match(txt, /Did you mean/i);
});
check("'Jillian Braided in black size 8' → Braided only, AVAILABLE", () => {
  const v = classifyMulti("black", "8", null, "do you have jillian braided in black size 8?");
  assert.equal(v.result, R.AVAILABLE);
  assert.match(v.product.title, /Braided/);
});
check("'Jillian Sport in black size 8' → Sport only, AVAILABLE", () => {
  const v = classifyMulti("black", "8", null, "do you have jillian sport in black size 8?");
  assert.equal(v.result, R.AVAILABLE);
  assert.match(v.product.title, /Sport/);
});
check("follow-up inherits focus style (Braided) → Braided only, no disambiguation", () => {
  const fk = styleKeyOfTitle("Jillian Braided Quarter Strap Sandal - Black");
  const v = classifyMulti("black", "8", null, "what about size 8?", fk);
  assert.equal(v.result, R.AVAILABLE);
  assert.match(v.product.title, /Braided/);
});
check("'Jillian in pink' multi-style → DISAMBIGUATION among Rose styles, mentions Rose", () => {
  const v = classifyMulti("pink", null, null, "do you have jillian in pink?");
  assert.equal(v.result, R.DISAMBIGUATION);
  assert.equal(v.softColor, true);
  assert.equal(v.matchedColor, "rose");
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /don't see a color called Pink/i);
  assert.match(txt, /Rose/);
  assert.match(txt, /Did you mean/i);
});
check("single-style family (CATALOG Jillian = Braided only) still resolves, no disambiguation", () => {
  const v = classify("jillian", "black", "8");
  assert.equal(v.result, R.AVAILABLE);
});

// ── Bug: same-session memory pollution — a follow-up must inherit from the
// PRIOR availability turn, never a stale earlier family/color ──────────
check("3-turn sequence: Jillian pink → Savannah champ 7 wide → 'what about 9' stays Savannah/champagne/wide", () => {
  const messages = [
    { role: "user", content: "Do you have Jillian in pink?" },
    { role: "assistant", content: "I don't see Pink, but the Jillian comes in Rose." },
    { role: "user", content: "Do you have Savannah in champagne size 7 wide?" },
    { role: "assistant", content: "I can find the Savannah in Champagne in size 7…" },
    { role: "user", content: "What about size 9?" },
  ];
  const knownColors = ["champagne"];
  // The prior availability message must be the SAVANNAH turn, not the Jillian one.
  const prior = priorAvailabilityMessage(messages, knownColors);
  assert.match(prior, /Savannah in champagne size 7 wide/);
  assert.doesNotMatch(prior, /Jillian/i);
  const req = resolveAvailabilityRequest({
    message: "What about size 9?",
    priorMessage: prior,
    namedFamilies: [],
    focusProduct: { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" }, // consistent focus
    isFollowUp: true,
    knownColors,
  });
  assert.equal(req.family, "savannah"); // NOT jillian
  assert.equal(req.color, "champagne"); // NOT pink/rose
  assert.equal(req.size, "9");
  assert.equal(req.width, "wide");
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
