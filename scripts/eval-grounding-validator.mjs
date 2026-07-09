// Grounding validator — locks down the contract that every load-
// bearing claim in the model's reply is supported by tool results
// from THIS turn. Mirrors the live-trace bugs we've hit:
//   - "Noelle has both technologies built in" (no Noelle in tool result)
//   - "Reagan boot is $89.95" (wrong price)
//   - "the Maui has BioRocker" (Maui has no BioRocker evidence)
//
// On every failure the validator returns a structured error the agent
// loop hands BACK to the model with a retry instruction. The
// validator never rewrites text silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGrounding,
  buildRetryInstruction,
  __TEST__,
} from "../app/lib/grounding-validator.server.js";

const { titleFamily, extractBoldedProductFamilies, extractFeatureClaims } = __TEST__;

// ─── Fixtures ──────────────────────────────────────────────────

const NOELLE = {
  title: "Noelle Arch Support Wedge - Navy",
  handle: "noelle-navy",
  price_formatted: "$90.97",
  _description: "Wedge sandal with arch support",
  _tags: ["wedge", "arch-support"],
  _attributes: { category: "Wedges Heels" },
  _claimFacts: { archSupport: { value: true, source: "tag" } },
};

const REAGAN = {
  title: "Reagan Boot - Black",
  handle: "reagan-black",
  price_formatted: "$179.95",
  _description: "Leather ankle boot built for everyday wear",
  _tags: ["boot", "leather"],
  _attributes: { category: "Boots" },
  _claimFacts: { leather: { value: true, source: "tag" } },
};

const DARCY = {
  title: "Darcy Slip-On Sneaker - Black",
  handle: "darcy-black",
  price_formatted: "$129.95",
  _description: "Slip-on sneaker with BioRocker rocker-bottom outsole and built-in arch support",
  _tags: ["sneaker", "biorocker"],
  _attributes: { category: "Sneakers" },
  _claimFacts: { archSupport: { value: true, source: "tag" } },
};

// ─── Title family ──────────────────────────────────────────────

test("titleFamily extracts the first non-stop-word token", () => {
  assert.equal(titleFamily("Noelle Arch Support Wedge - Navy"), "noelle");
  assert.equal(titleFamily("Reagan Boot - Black"), "reagan");
  assert.equal(titleFamily("The Whit Sport Sandal"), "whit");
});

// ─── Bolded product extraction filters tech/feature names ──────

test("bolded tech names (BioRocker™ Technology) are not treated as products", () => {
  const text = "Both **BioRocker™ Technology** and **UltraSKY™ Technology** are built into select styles.";
  const families = extractBoldedProductFamilies(text);
  assert.equal(families.length, 0, `tech bolds must not count as products; got ${JSON.stringify(families)}`);
});

test("compare-turn section labels (Heel Height, Removable Insole) are NOT products", () => {
  // Live trace 2026-06-10: Reagan/Jillian compare emitted "**Heel
  // Height**" and "**Removable Insole**" as alternating section
  // labels between Reagan: x / Jillian: y rows. The validator flagged
  // each as an ungrounded product family and burned 3 retries (~30s)
  // on the same turn.
  const text =
    "Here's how the two compare:\n\n**Heel Height**\nReagan: 2\"\nJillian: 1.1\"\n\n**Removable Insole**\nReagan: Yes\nJillian: No\n\n**Closure**\nReagan: Side zip\nJillian: Hook & loop.";
  const families = extractBoldedProductFamilies(text);
  assert.equal(
    families.length,
    0,
    `compare-turn section labels must not count as products; got ${JSON.stringify(families)}`,
  );
});

test("bolded actual product names ARE captured", () => {
  const text = "The **Noelle Arch Support Wedge** is a great pick for foot pain.";
  const families = extractBoldedProductFamilies(text);
  assert.equal(families.length, 1);
  assert.equal(families[0].family, "noelle");
});

// ─── Rule 1: named-product grounding ───────────────────────────

test("ungrounded product name (no card with that family) → error", () => {
  // Live trace 2026-06-09: bot claimed Noelle has both technologies
  // but Noelle wasn't in the tool result (pool was Darcy/Savannah/etc.)
  const text = "The **Noelle Arch Support Wedge** has both technologies built in.";
  const out = validateGrounding({ text, pool: [DARCY] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "ungrounded_product_name" && /noelle/i.test(e.claim)),
    `expected ungrounded_product_name for Noelle; got ${JSON.stringify(out.errors)}`);
});

test("grounded product name (card with matching family) → ok", () => {
  const text = "The **Noelle Arch Support Wedge** is built for everyday wear.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true, `expected ok; got errors=${JSON.stringify(out.errors)}`);
});

test("variant color in reply (Noelle Arch Support Wedge - Navy) matches base card (Noelle ...) by family", () => {
  const text = "**Noelle Arch Support Wedge — Navy** at $90.97 — a wedge with arch support.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true, `family-level match should be enough; got ${JSON.stringify(out.errors)}`);
});

// ─── Rule 2: price grounding ───────────────────────────────────

test("wrong price quoted next to product name → error", () => {
  const text = "The **Reagan Boot** is $89.95 in black.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "wrong_price"),
    `expected wrong_price; got ${JSON.stringify(out.errors)}`);
});

test("correct price quoted next to product name → ok", () => {
  const text = "The **Reagan Boot** is $179.95 in black.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true, `expected ok; got ${JSON.stringify(out.errors)}`);
});

test("price within 50-cent rounding tolerance is accepted", () => {
  const text = "The **Reagan Boot** is $180.00.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true);
});

// ─── Rule 3: feature/material grounding ────────────────────────

test("'Noelle has BioRocker' is rejected when Noelle's card has no BioRocker evidence", () => {
  const text = "The **Noelle Arch Support Wedge** has BioRocker technology built in.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "unsupported_feature_claim" && /biorocker/i.test(e.claim)),
    `expected unsupported_feature_claim for BioRocker; got ${JSON.stringify(out.errors)}`);
});

test("'Darcy has BioRocker' is accepted when Darcy's card description mentions BioRocker", () => {
  const text = "The **Darcy Slip-On Sneaker** has BioRocker for joint-friendly walking.";
  const out = validateGrounding({ text, pool: [DARCY] });
  assert.equal(out.ok, true, `expected ok; got ${JSON.stringify(out.errors)}`);
});

test("'Reagan has memory foam' is rejected when card has no memory foam evidence", () => {
  const text = "The **Reagan Boot** has memory foam for all-day comfort.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "unsupported_feature_claim" && /memory foam/i.test(e.claim)));
});

test("'Reagan has leather' is accepted because card description says leather", () => {
  const text = "The **Reagan Boot** is a leather ankle boot.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true);
});

test("arch support claim is accepted when claim facts confirm it", () => {
  const text = "The **Noelle Arch Support Wedge** has arch support built in.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true);
});

// ─── Multiple errors at once ───────────────────────────────────

test("two ungrounded products produce two errors", () => {
  const text = "**Phantom Sneaker** and **Mirage Sandal** are both great.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, false);
  assert.equal(
    out.errors.filter((e) => e.kind === "ungrounded_product_name").length,
    2,
  );
});

// ─── No-op cases (pure prose, generic descriptions) ────────────

test("plain prose with no product/price/feature claims → ok regardless of pool", () => {
  const text = "Happy to help! Tell me more about what you're looking for and I'll narrow it down.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true);
});

test("generic adjectives (comfortable, stylish) without specific feature words → ok", () => {
  const text = "The **Noelle Arch Support Wedge** is comfortable and stylish for daily wear.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true);
});

test("empty inputs → ok (no false positives)", () => {
  assert.equal(validateGrounding({ text: "", pool: [] }).ok, true);
  assert.equal(validateGrounding({ text: null, pool: null }).ok, true);
});

// ─── False-positive guards (live-trace fixes) ─────────────────

test("heading-style bold '**The key difference:**' is NOT extracted as a product", () => {
  // Live trace 2026-06-10: BioRocker compare burned 10s on a wasted
  // retry because the validator extracted "key" from "**The key
  // difference:**" — a sentence heading, not a product name. Bolds
  // ending in colon, em/en dash, or sentence punctuation are headings.
  const text =
    "**The key difference:** BioRocker is the rocker-bottom outsole, " +
    "UltraSKY is the EVA midsole foam — different layers of the same shoe.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true,
    `heading-style bold should not be flagged as a product; got ${JSON.stringify(out.errors)}`);
});

test("'**Quick take —**' style bold is treated as heading, not product", () => {
  const text = "**Quick take —** these are our top three sellers.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true);
});

test("brand-prefixed tech bolds ('Aetrex Signature Arch Support') are NOT products", () => {
  // Live trace 2026-06-10: the model bolded the brand technology
  // "**Aetrex Signature Arch Support**" in a grounded BioRocker
  // answer; the validator extracted "aetrex" as a product family and
  // burned a retry. Product titles never start with the brand name.
  const text = "Both styles feature **Aetrex Signature Arch Support** and the **Aetrex Orthotic System**.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true,
    `brand-tech bolds must not be flagged; got ${JSON.stringify(out.errors)}`);
});

test("spec-section headings (Style & Materials, Comfort Features, Fit & Sizing) are NOT products", () => {
  // Live trace 2026-06-10 evening: the Reagan spec answer used
  // "**Style & Materials**" as a section heading and burned TWO
  // retries (~25s) — "Materials" didn't match the singular \bMaterial\b
  // and "Style" wasn't in the vocabulary. Plural-tolerant suffixes +
  // ampersand-heading rule fix the class.
  const text =
    "**Style & Materials**\nGenuine leather upper.\n\n" +
    "**Comfort Features**\nBuilt-in arch support.\n\n" +
    "**Fit & Sizing**\nRuns true to size.\n\n" +
    "**Key Details**\n2-inch stacked heel.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true,
    `section headings must not be flagged as products; got ${JSON.stringify(out.errors)}`);
});

test("real product name (no trailing punctuation in bold) still extracted", () => {
  // Belt-and-suspenders — make sure the heading-end guard doesn't
  // accidentally swallow legitimate product names.
  // Pool is non-empty (a search ran) but doesn't contain Phantom → the
  // extractor must still surface it as ungrounded. (Empty-pool/info turns
  // are intentionally NOT flagged — see the dedicated test below.)
  const text = "**Phantom Sneaker** is our pick.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "ungrounded_product_name"));
});

test("bolded product on an info turn (empty pool / no search) is NOT flagged", () => {
  // prod 2026-06-25: "**Plantar Fasciitis Kit**" in a "do insoles help?"
  // answer wrongly forced a Sonnet retry. No pool ⇒ nothing to ground ⇒ skip.
  const out = validateGrounding({ text: "The **Plantar Fasciitis Kit** can help with that.", pool: [] });
  assert.equal(out.ok, true);
});

// ─── Retry instruction is well-formed ──────────────────────────

test("buildRetryInstruction lists each error and ends with the honesty cue", () => {
  const errors = [
    { kind: "ungrounded_product_name", claim: "Phantom", message: "Phantom isn't in any tool result." },
    { kind: "unsupported_feature_claim", claim: "Noelle has BioRocker", message: "Noelle has no BioRocker evidence." },
  ];
  const out = buildRetryInstruction(errors);
  assert.ok(out.includes("Phantom isn't in any tool result."));
  assert.ok(out.includes("Noelle has no BioRocker evidence."));
  assert.ok(/can't verify|that's a correct answer/i.test(out),
    `expected the honesty cue inviting "I can't verify"; got:\n${out}`);
});

test("buildRetryInstruction includes the failed draft so the model can see what it wrote", () => {
  // runAgenticLoop doesn't return its messages array, so the retry
  // conversation can't show the model its own failed assistant turn.
  // The draft must therefore ride inside the correction message.
  const errors = [
    { kind: "ungrounded_product_name", claim: "Phantom", message: "Phantom isn't in any tool result." },
  ];
  const out = buildRetryInstruction(errors, "The **Phantom Sneaker** is our best pick at $99.");
  assert.ok(out.includes("The **Phantom Sneaker** is our best pick at $99."),
    `failed draft must be quoted in the instruction; got:\n${out}`);
  assert.ok(/previous draft/i.test(out));
  assert.ok(/never shown to the customer/i.test(out),
    "must reassure the model the draft never reached the customer");
});

test("buildRetryInstruction truncates very long drafts at 1500 chars", () => {
  const errors = [{ kind: "x", claim: "y", message: "z." }];
  const longDraft = "A".repeat(5000);
  const out = buildRetryInstruction(errors, longDraft);
  assert.ok(out.length < 2500, `instruction should stay bounded; got len=${out.length}`);
});

test("empty errors → empty instruction", () => {
  assert.equal(buildRetryInstruction([]), "");
});

// ─── Rule 4: false catalog denial ──────────────────────────────
const { detectFalseCatalogDenial } = __TEST__;
// Aetrex-like men+women catalog: men have sneakers/sandals (= footwear),
// boots are women-only, orthotics both.
const CGMAP = {
  sneakers: { genders: ["men", "women"] },
  sandals: { genders: ["men", "women"] },
  boots: { genders: ["women"] },
  orthotics: { genders: ["men", "women"] },
  accessories: { genders: ["unisex"] },
};

test("rule4: false denial of men's footwear (umbrella) → error", () => {
  const out = validateGrounding({
    text: "I couldn't find men's footwear in our current catalog. Try a different color or style?",
    pool: [],
    categoryGenderMap: CGMAP,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].kind, "false_catalog_denial");
  assert.match(out.errors[0].message, /men's footwear/i);
});

test("rule4: false denial of a specific category that exists → error", () => {
  const out = validateGrounding({
    text: "We don't carry men's sandals right now.",
    pool: [],
    categoryGenderMap: CGMAP,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].kind, "false_catalog_denial");
});

test("rule4: GENUINE denial (men's boots — men have none) is NOT flagged", () => {
  const out = validateGrounding({
    text: "We don't carry men's boots — we only stock them in women's.",
    pool: [],
    categoryGenderMap: CGMAP,
  });
  assert.equal(out.ok, true);
});

test("rule4: honest COLOR relaxation ('no red sandals') is NOT flagged", () => {
  const out = validateGrounding({
    text: "We don't carry red sandals, but here are our warmer tones.",
    pool: [],
    categoryGenderMap: CGMAP,
  });
  assert.equal(out.ok, true);
});

test("rule4: no categoryGenderMap → rule is inert", () => {
  const out = validateGrounding({
    text: "I couldn't find men's footwear in our current catalog.",
    pool: [],
  });
  assert.equal(out.ok, true);
});

test("rule4 helper: returns the matched gender+category", () => {
  const d = detectFalseCatalogDenial("we don't carry men's sneakers", CGMAP);
  assert.equal(d.gender, "men");
  assert.equal(d.category, "sneakers");
});

// ─── Feature-header bolds are not products ──────────────────────
test("'**Built-in Arch Support**' header is NOT extracted as a product", () => {
  const fams = extractBoldedProductFamilies("The Danika has **Built-in Arch Support** and a cushioned footbed.");
  assert.equal(fams.length, 0, `expected no product family; got ${JSON.stringify(fams)}`);
});

test("feature bolds (Memory Foam, Heel Cup, Removable Insole) are NOT products", () => {
  for (const h of ["**Memory Foam**", "**Heel Cup**", "**Removable Insole**", "**Metatarsal Support**"]) {
    assert.equal(extractBoldedProductFamilies(`Compare: ${h} vs the others.`).length, 0, `${h} should not extract`);
  }
});

test("a real product whose title contains a feature word still extracts", () => {
  const fams = extractBoldedProductFamilies("The **Danika Arch Support Sneaker** is a great pick.");
  assert.equal(fams.length, 1);
  assert.equal(fams[0].family, "danika");
});

// ─── Rule 5: false color denial ────────────────────────────────
const JILLIAN_COLORS = {
  title: "Jillian Braided Quarter Strap Sandal - Navy",
  handle: "jillian-navy",
  price_formatted: "$94.95",
  _variantFacts: { availableColors: ["Navy", "Black", "White"] },
  _attributes: { category: "Sandals" },
  _tags: ["sandal"],
};

test("rule5: denying a color the product DOES stock is rejected", () => {
  const out = validateGrounding({
    text: "The **Jillian Braided Quarter Strap Sandal** doesn't come in black, sorry.",
    pool: [JILLIAN_COLORS],
  });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "false_color_denial" && /black/i.test(e.claim)));
});

test("rule5: HONEST denial of a genuinely-absent color is NOT flagged", () => {
  // Jillian has no red — saying so is correct and must pass.
  const out = validateGrounding({
    text: "The **Jillian Braided Quarter Strap Sandal** doesn't come in red.",
    pool: [JILLIAN_COLORS],
  });
  assert.equal(out.ok, true);
});

test("rule5: single-card pool resolves the denial without a bold", () => {
  const out = validateGrounding({ text: "Unfortunately it isn't available in white.", pool: [JILLIAN_COLORS] });
  assert.ok(out.errors.some((e) => e.kind === "false_color_denial" && /white/i.test(e.claim)));
});

test("rule5: grey/gray equivalence — deny 'grey', card stores 'Gray'", () => {
  const reagan = { title: "Reagan Sneaker - Gray", _variantFacts: { availableColors: ["Gray", "Rose Gold"] } };
  const out = validateGrounding({ text: "The **Reagan Sneaker** doesn't come in grey.", pool: [reagan] });
  assert.ok(out.errors.some((e) => e.kind === "false_color_denial"));
});

test("rule5: 'no black option' phrasing is caught", () => {
  const out = validateGrounding({
    text: "For the **Jillian Braided Quarter Strap Sandal**, there's no black option.",
    pool: [JILLIAN_COLORS],
  });
  assert.ok(out.errors.some((e) => e.kind === "false_color_denial" && /black/i.test(e.claim)));
});

test("rule5: 'tan' denial does NOT false-match 'Titanium' evidence", () => {
  const titan = { title: "Apex Runner - Titanium", _variantFacts: { availableColors: ["Titanium"] } };
  const out = validateGrounding({ text: "The **Apex Runner** doesn't come in tan.", pool: [titan] });
  assert.equal(out.ok, true);
});

test("rule5: a positive color mention is NOT flagged", () => {
  const out = validateGrounding({
    text: "The **Jillian Braided Quarter Strap Sandal** comes in navy and black.",
    pool: [JILLIAN_COLORS],
  });
  assert.equal(out.ok, true);
});

// ─── Rule 6: raw handle / slug leak ────────────────────────────

test("rule6: a bare product handle as the whole reply is rejected", () => {
  // Live trace 2026-06-25: cleanup gutted a draft to the handle, twice.
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - White", handle: "jillian-cork-sc364w" }];
  const out = validateGrounding({ text: "Jillian-cork-sc364w jillian-cork-sc364w", pool });
  assert.equal(out.ok, false, "raw handle must fail validation");
  assert.ok(out.errors.some((e) => e.kind === "raw_handle_leak"), "must flag raw_handle_leak");
});

test("rule6: a handle-like SKU slug not in the pool is still rejected", () => {
  const out = validateGrounding({ text: "Try the jillian-sport-black-ins-8000w model.", pool: [] });
  assert.ok(out.errors.some((e) => e.kind === "raw_handle_leak"));
});

test("rule6: ordinary hyphenated words are NOT flagged", () => {
  const pool = [{ title: "Darcy Slip-On Sneaker - Black", handle: "darcy-black" }];
  const out = validateGrounding({ text: "These are great slip-on, anti-fatigue, lace-up options.", pool });
  assert.equal(out.ok, true, "slip-on / anti-fatigue / lace-up must pass");
});

test("rule6: a clean reply using the real display name passes", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - White", handle: "jillian-cork-sc364w" }];
  const out = validateGrounding({
    text: "The Jillian Braided Quarter Strap Sandal has solid arch support for all-day walking.",
    pool,
  });
  assert.equal(out.ok, true);
});

// ─── Rules 7 & 8: retail answer contract (Jillian screenshots) ──

const JILLIAN_POOL = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
const Q_WALKING =
  "I have a week-long family reunion in a hot climate where I'll be walking through theme parks all day. I'm deciding whether to order the Aetrex Jillian Braided Quarter Strap Sandal — will it hold up for that much active walking or is it more of a casual stroll sandal?";
const Q_VALUE =
  "everyone keeps recommending the Aetrex Jillian sandal for plantar fasciitis, I can find it for around a hundred dollars — is it actually worth that compared to supportive sandals I've already tried at half the price that haven't made a difference";

test("rule7: decision question opened with generic browse copy is flagged (warning, not blocking)", () => {
  const out = validateGrounding({ text: "Here are some sandals that might work for you.", pool: JILLIAN_POOL, userMessage: Q_WALKING });
  assert.equal(out.ok, true, "quality issues are observability warnings, not blockers");
  assert.ok(out.warnings.some((e) => e.kind === "answer_first"));
});

test("rule7: a concise answer-first reply passes (walking suitability)", () => {
  const out = validateGrounding({
    text: "The Jillian holds up well for casual all-day wear, but it's a comfort sandal, not a performance walking shoe — for nonstop theme-park miles I'd pair it with a sportier option like the Savannah. Want me to show that?",
    pool: JILLIAN_POOL,
    userMessage: Q_WALKING,
  });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
});

test("rule8: an essay-length product answer is rejected as too_long", () => {
  const essay = "The Jillian is a comfortable and supportive sandal. ".repeat(40);
  const out = validateGrounding({ text: essay, pool: JILLIAN_POOL, userMessage: Q_VALUE });
  assert.ok(out.warnings.some((e) => e.kind === "too_long"));
});

test("rule8: length cap is exempt when the customer asked to compare in detail", () => {
  const essay = "The Jillian is a comfortable and supportive sandal. ".repeat(40);
  const out = validateGrounding({ text: essay, pool: JILLIAN_POOL, userMessage: "compare the Jillian vs the Savannah in detail" });
  assert.equal(out.warnings.some((e) => e.kind === "too_long"), false);
});

test("rule8: a concise value answer passes (plantar-fasciitis worth-it)", () => {
  const out = validateGrounding({
    text: "Worth it if past sandals failed on fit, not just price — the Jillian adds real arch support and a contoured footbed that flat half-price pairs lack. If support was the gap, it'll feel different. Want me to compare it to the Savannah?",
    pool: JILLIAN_POOL,
    userMessage: Q_VALUE,
  });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
});

test("rules 7/8: skip entirely when no userMessage is supplied (truth-only callers)", () => {
  const essay = "The Jillian is a comfortable and supportive sandal. ".repeat(40);
  const out = validateGrounding({ text: essay, pool: JILLIAN_POOL });
  assert.equal(out.ok, true);
});

// ─── Rule 9: force product lookup on named-product data questions ──

test("rule9: named product + condition question with no search forces a lookup", () => {
  const out = validateGrounding({
    text: "The Jillian is generally supportive and many people find it helpful.",
    pool: [],
    userMessage: "is the Jillian good for plantar fasciitis?",
    namedProductMentioned: true,
    searchAttempted: false,
  });
  assert.ok(out.warnings.some((e) => e.kind === "missing_product_lookup"));
});

test("rule9: educational question (no named product) does NOT force a lookup", () => {
  const out = validateGrounding({
    text: "Arch support helps distribute pressure and can ease plantar fasciitis for many people.",
    pool: [],
    userMessage: "is arch support necessary for plantar fasciitis?",
    namedProductMentioned: false,
    searchAttempted: false,
  });
  assert.equal(out.warnings.some((e) => e.kind === "missing_product_lookup"), false);
});

test("rule9: a named product already searched (but not found) does NOT loop", () => {
  const out = validateGrounding({
    text: "I couldn't find that exact pair in stock, but here's a close option.",
    pool: [],
    userMessage: "do you have the Jillian in black size 8?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.equal(out.warnings.some((e) => e.kind === "missing_product_lookup"), false);
});

// ─── Rule 10: generic fallback is a non-answer on specific questions ──

test("rule10: 'Take a look' fallback fails on a value/suitability question", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({
    text: "Take a look — these are the closest matches I've got.",
    pool,
    userMessage: "is the Jillian worth it for plantar fasciitis?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.ok(out.warnings.some((e) => e.kind === "generic_fallback_non_answer"));
});

test("rule10: the same fallback is allowed for a plain browse request", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({
    text: "Take a look — these are the closest matches I've got.",
    pool,
    userMessage: "show me some sandals",
    namedProductMentioned: false,
    searchAttempted: true,
  });
  assert.equal(out.ok, true);
});

// ─── Evidence in the retry instruction (rewrite-only retries) ──

test("buildRetryInstruction injects compact product evidence (no handles)", () => {
  const pool = [{
    title: "Jillian Braided Quarter Strap Sandal - Black",
    handle: "jillian-black-sc450w",
    price_formatted: "$139.95",
    _variantFacts: { availableColors: ["Black", "White"] },
    _claimFacts: { archSupport: { value: true } },
  }];
  const out = buildRetryInstruction([{ kind: "too_long", message: "shorten it" }], "a long draft", pool);
  assert.ok(/Product evidence/i.test(out), "evidence block present");
  assert.ok(out.includes("Jillian Braided Quarter Strap Sandal - Black"), "title present");
  assert.ok(out.includes("$139.95"), "price present");
  assert.ok(out.includes("archSupport"), "key fact present");
  assert.equal(out.includes("jillian-black-sc450w"), false, "handle must be hidden");
});

test("buildRetryInstruction with empty pool omits the evidence block", () => {
  const out = buildRetryInstruction([{ kind: "too_long", message: "shorten it" }], "draft", []);
  assert.equal(/Product evidence/i.test(out), false);
});

test("rule9: 'Are the Jillian sandals good for plantar fasciitis?' forces a lookup", () => {
  const out = validateGrounding({
    text: "The Jillian is a supportive option many shoppers like.",
    pool: [],
    userMessage: "Are the Jillian sandals good for plantar fasciitis?",
    namedProductMentioned: true,
    searchAttempted: false,
  });
  assert.ok(out.warnings.some((e) => e.kind === "missing_product_lookup"));
});

// ─── Rule 11: fragment / non-answer ────────────────────────────

test("rule11: interjection-only fragments are rejected ('Great question —')", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  for (const frag of ["Great question —", "Absolutely —", "I'd say —"]) {
    const out = validateGrounding({ text: frag, pool, userMessage: "is the Jillian good for walking?" });
    assert.ok(out.warnings.some((e) => e.kind === "fragment_non_answer"), `should flag: ${frag}`);
  }
});

test("rule11: cards alone do NOT make a fragment valid", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({ text: "Here you go!", pool, userMessage: "show me sandals" });
  assert.ok(out.warnings.some((e) => e.kind === "fragment_non_answer"));
});

test("rule11: a normal short browse sentence with cards passes", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({ text: "Here are some supportive sandals great for all-day wear.", pool, userMessage: "show me sandals" });
  assert.equal(out.warnings.some((e) => e.kind === "fragment_non_answer"), false);
});

// ─── Rule 12: sizing/availability answered in text ─────────────

test("rule12: a card-only reply to a sizing question is rejected", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({
    text: "Here's the Jillian for you.",
    pool,
    userMessage: "what size should I get in Jillian?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.ok(out.warnings.some((e) => e.kind === "sizing_not_addressed"));
});

test("rule12: real sizing guidance in text passes", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({
    text: "Aetrex sandals run true to size, so start with your usual 8.5 — and since your feet swell, the adjustable straps give extra room. Easy returns if the fit's off.",
    pool,
    userMessage: "what size should I get in Jillian? my feet swell",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.equal(out.warnings.some((e) => e.kind === "sizing_not_addressed"), false);
});

test("rule12: a color-availability question is NOT treated as sizing", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const out = validateGrounding({
    text: "The Jillian comes in black, white, and cork.",
    pool,
    userMessage: "what colors does the Jillian come in?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.equal(out.warnings.some((e) => e.kind === "sizing_not_addressed"), false);
});

test("rule13: prior-evidence multi-color answer must address every requested color", () => {
  const pool = [
    { title: "Jillian Braided Quarter Strap Sandal - Champagne", handle: "jillian-champagne" },
    { title: "Savannah Adjustable Quarter Strap Sandal - Taupe", handle: "savannah-taupe" },
  ];
  const out = validateGrounding({
    text: "I couldn't find champagne in our current catalog. Try a different color or style?",
    pool,
    userMessage: "Does either come in champagne or rose?",
    workflow: "prior_evidence_availability",
  });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "multi_color_not_addressed" && /rose/i.test(e.claim)));
});

test("rule13: prior-evidence multi-color answer passes when both colors are addressed", () => {
  const pool = [
    { title: "Jillian Braided Quarter Strap Sandal - Champagne", handle: "jillian-champagne" },
    { title: "Savannah Adjustable Quarter Strap Sandal - Taupe", handle: "savannah-taupe" },
  ];
  const out = validateGrounding({
    text: "Jillian comes in Champagne, but I'm not seeing Rose. Savannah does not come in Champagne or Rose.",
    pool,
    userMessage: "Does either come in champagne or rose?",
    workflow: "prior_evidence_availability",
  });
  assert.equal(out.ok, true);
});

// ─── Rule 8 (Fix #5): character cap + comparison stays concise ──

test("rule8: an answer over ~500 chars is rejected even if under 160 words", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const long = "The Jillian is a comfortable supportive sandal with a contoured footbed and adjustable straps. ".repeat(7);
  const out = validateGrounding({ text: long, pool, userMessage: "is the Jillian good for walking?" });
  assert.ok(out.warnings.some((e) => e.kind === "too_long"));
});

test("Fix #3: a concise Jillian-vs-Savannah comparison passes in one shot", () => {
  const pool = [
    { title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" },
    { title: "Savannah Adjustable Quarter Strap Sandal - Taupe", handle: "savannah-taupe-ss500w" },
  ];
  const out = validateGrounding({
    text: "For all-day walking, the Savannah is the stronger pick — more stable support and a sturdier sole. The Jillian is better for style and lighter casual days. Want me to show the Savannah?",
    pool,
    userMessage: "Which is better for all-day walking, Jillian or Savannah?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
});

test("Fix #3: a 1000-char comparison wall is rejected as too_long", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const wall = "The Jillian and the Savannah are both excellent supportive sandals with contoured footbeds. ".repeat(12);
  const out = validateGrounding({
    text: wall,
    pool,
    userMessage: "Which is better for all-day walking, Jillian or Savannah?",
    namedProductMentioned: true,
    searchAttempted: true,
  });
  assert.ok(out.warnings.some((e) => e.kind === "too_long"));
});

test("workflow=comparison caps length even when 'compare' reads as a detail request", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black", handle: "jillian-black-sc450w" }];
  const wall = "The Jillian and the Savannah are both excellent supportive sandals with contoured footbeds. ".repeat(12);
  // "Compare X and Y" matches DETAIL_REQUEST_RE, but the comparison CONTRACT
  // still caps it — otherwise comparisons become review essays.
  const out = validateGrounding({
    text: wall,
    pool,
    userMessage: "Compare Jillian and Savannah for plantar fasciitis",
    namedProductMentioned: true,
    searchAttempted: true,
    workflow: "comparison",
  });
  assert.ok(out.warnings.some((e) => e.kind === "too_long"), "long comparison should warn too_long");
});

test("workflow=comparison: a concise (<120 word) verdict does NOT warn too_long", () => {
  const pool = [{ title: "Savannah Adjustable Quarter Strap Sandal - Champagne", handle: "sav-champ-sc450w" }];
  const concise =
    "For all-day walking I'd lean Savannah — it has a more active, supportive build. " +
    "Jillian is prettier and fine for casual all-day wear, but Savannah is the safer pick " +
    "if you'll be on your feet for hours. Choose Jillian if style matters most; Savannah if comfort mileage does.";
  const out = validateGrounding({
    text: concise,
    pool,
    userMessage: "Which is better for all-day walking, Jillian or Savannah?",
    namedProductMentioned: true,
    searchAttempted: true,
    workflow: "comparison",
  });
  assert.ok(!out.warnings.some((e) => e.kind === "too_long"), "concise comparison must not warn too_long");
});

test("workflow=comparison: 'take a close look / tell me what matters' stalls are blocking", () => {
  const out = validateGrounding({
    text: "Here are Jillian and Savannah side by side — take a close look at each, and tell me what matters most so I can call a winner.",
    pool: [{ title: "Jillian Sandal" }, { title: "Savannah Sandal" }],
    userMessage: "Compare the Jillian and Savannah for vacation walking.",
    workflow: "comparison",
  });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "comparison_no_verdict"));
});

console.log("\nAll grounding-validator tests done.");
