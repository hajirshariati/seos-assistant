// Orthotic finder — checked against a read-only snapshot of the live Aetrex
// orthotic catalog (scripts/fixtures/aetrex-orthotics.json, 117 products).
//
// Expected picks follow Aetrex's published rule: style numbers ending 00/05
// are for medium-high arches, 20/25 for flat-low arches (posted), and 05/25
// add a metatarsal pad.
//
// Run: node scripts/eval-orthotic-finder.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOrthoticCatalog, pickOrthotic, productFromNode, skuParts, describeLine, sanitizeFitfinder } from "../app/lib/orthotic-finder.js";
import { finderToolDef } from "../app/lib/orthotic-finder.server.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/aetrex-orthotics.json", import.meta.url), "utf8"));
const catalog = buildOrthoticCatalog(fixture.products.map(productFromNode));
const bySku = (prefix) => catalog.items.find((i) => i.sku.toUpperCase().startsWith(prefix));

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const pick = (answers, opts) => pickOrthotic(catalog, answers, opts);
const pickedSku = (answers, opts) => {
  const r = pick(answers, opts);
  assert.ok(r.pick, `no pick: ${r.error}`);
  return catalog.items.find((i) => i.handle === r.pick.handle).sku;
};

console.log("\ncatalog");
test("every active orthotic is placed in a line — none left out", () => {
  assert.equal(catalog.items.length, fixture.products.length);
  assert.deepEqual(catalog.skipped, []);
});
test("arch and metatarsal pad match the SKU code for every product", () => {
  for (const i of catalog.items) {
    const { code } = skuParts(i.sku);
    if (!["00", "05", "20", "25"].includes(code)) continue;
    assert.equal(i.arch, code === "20" || code === "25" ? "flat_low" : "medium_high", i.sku);
    assert.equal(i.metSupport, code === "05" || code === "25", i.sku);
  }
});
test("products without a style code read the title (Overpronation → flat-low; kit → any arch)", () => {
  assert.equal(bySku("L4640W").arch, "flat_low");
  assert.equal(bySku("PFKW").arch, null);
});
test("one line per product family, named like the store names it", () => {
  const names = catalog.lines.map((l) => l.name);
  for (const n of ["Speed", "Train", "Active", "Casual Comfort", "Compete", "Dress", "Fashion / In-Style", "Thinsoles",
    "Conform", "Memory Foam", "Premium Memory Foam", "Cleats", "Skate", "Shearling", "Work", "Overpronation", "Kids",
    "Edge", "Customizable", "Plantar Fasciitis Kit"]) {
    assert.ok(names.includes(n), `missing line ${n} (have: ${names.join(", ")})`);
  }
  assert.equal(new Set(catalog.lines.map((l) => l.id)).size, catalog.lines.length, "line ids are unique");
});
test("Work and Overpronation share a style number but stay separate lines", () => {
  assert.notEqual(bySku("L4600M").line, bySku("L4640M").line);
});
test("kids orthotics are Kids, not adult unisex", () => {
  assert.equal(bySku("L1700C").gender, "Kids");
});
test("each line's 'Best for' is the store's own words, without usage tips", () => {
  const speed = catalog.lines.find((l) => l.name === "Speed");
  assert.equal(speed.bestFor, "Running shoes, Athletic sneakers, Tennis shoes");
  for (const l of catalog.lines) assert.ok(!/how to use|begin by/i.test(l.bestFor), `${l.name}: ${l.bestFor}`);
});
test("the line list Claude reads stays compact", () => {
  const text = catalog.lines.map(describeLine).join("\n");
  assert.ok(text.length < 9000, `${text.length} chars`);
});

console.log("\npicks (Aetrex SKU rule)");
const cases = [
  [{ line: "speed", gender: "women", arch: "flat_low", ball_of_foot_pain: "yes" }, "L725W"],
  [{ line: "speed", gender: "men", arch: "medium_high", ball_of_foot_pain: "no" }, "L700M"],
  [{ line: "train", gender: "women", arch: "flat_low", ball_of_foot_pain: "no" }, "L820W"],
  [{ line: "dress", gender: "men", arch: "medium_high", ball_of_foot_pain: "yes" }, "L505M"],
  [{ line: "fashion-in-style", gender: "women", arch: "medium_high", ball_of_foot_pain: "no" }, "L100W"],
  [{ line: "fashion-in-style", gender: "men", arch: "flat_low", ball_of_foot_pain: "no" }, "L120M"],
  [{ line: "conform", gender: "women", arch: "flat_low", ball_of_foot_pain: "yes" }, "L225W"],
  [{ line: "casual-comfort", gender: "men", arch: "flat_low", ball_of_foot_pain: "no" }, "L620M"],
  [{ line: "cleats", gender: "men", arch: "flat_low", ball_of_foot_pain: "no" }, "L1220"],
  [{ line: "kids", gender: "kids", arch: "flat_low", ball_of_foot_pain: "no" }, "L1720C"],
  [{ line: "work", gender: "men", arch: "medium_high", ball_of_foot_pain: "yes" }, "L4605M"],
  [{ line: "plantar-fasciitis-kit", gender: "women", arch: "flat_low", ball_of_foot_pain: "no" }, "PFKW"],
];
for (const [answers, want] of cases) {
  test(`${answers.gender} · ${answers.line} · ${answers.arch} · met ${answers.ball_of_foot_pain} → ${want}`, () => {
    assert.ok(pickedSku(answers).toUpperCase().startsWith(want));
  });
}
test("arch unknown → the medium-high version, and the posted one is pointed out", () => {
  const r = pick({ line: "casual-comfort", gender: "women", arch: "not_sure", ball_of_foot_pain: "no" });
  assert.ok(pickedSku({ line: "casual-comfort", gender: "women", arch: "not_sure", ball_of_foot_pain: "no" }).startsWith("L600W"));
  assert.ok(r.notes.some((n) => /posted version/i.test(n)));
});
test("a line not made for them → honest error with lines that are", () => {
  const r = pick({ line: "work", gender: "women", arch: "flat_low", ball_of_foot_pain: "no" });
  assert.ok(r.error && /isn't made for women/.test(r.error));
  assert.ok(!r.linesForThisCustomer.includes("work"));
  assert.ok(r.linesForThisCustomer.includes("casual-comfort"));
});
test("kids never get an adult orthotic", () => {
  const r = pick({ line: "speed", gender: "kids", arch: "flat_low", ball_of_foot_pain: "no" });
  assert.ok(r.error);
  assert.deepEqual(r.linesForThisCustomer, ["kids"]);
});
test("a version that doesn't exist is said plainly (women's Metatarsalgia is medium-high only)", () => {
  const r = pick({ line: "metatarsalgia", gender: "women", arch: "flat_low", ball_of_foot_pain: "yes" });
  assert.ok(r.pick.title.includes("Metatarsalgia"));
  assert.ok(r.notes.some((n) => /no low arches/i.test(n)));
});
test("a product that isn't for sale is never picked — the closest one is", () => {
  const off = bySku("L725W").handle;
  const sku = pickedSku({ line: "speed", gender: "women", arch: "flat_low", ball_of_foot_pain: "yes" }, { available: (h) => h !== off });
  assert.ok(sku.startsWith("L720W"), sku); // same arch, no met pad — arch matters more
});
test("men's pick prefers the men's product over a unisex one when both exist", () => {
  const r = pick({ line: "edge", gender: "men", arch: "medium_high", ball_of_foot_pain: "no" });
  assert.ok(r.pick.title.includes("Edge"));
});
test("missing gender or unknown line → asks instead of guessing", () => {
  assert.ok(pick({ line: "speed", arch: "flat_low", ball_of_foot_pain: "no" }).error);
  assert.ok(pick({ line: "nope", gender: "men" }).error);
});

test("orthotics are never offered for sandals", () => {
  const def = finderToolDef({ intent: "orthotic", definition: { finder: catalog } });
  assert.match(def.description, /can't be worn in sandals/);
  assert.match(def.description, /Never suggest, offer or pair an orthotic with sandals/);
  assert.doesNotMatch(def.description, /can only hold an insert/);
});

console.log("\nFITs (FITFinder)");
// FITFinder's default FITs, as its storefront config returns them.
const FF = sanitizeFitfinder({
  fits: [
    { key: "A", label: "FIT A", code: "20", name: "Posted Support", description: "An angled (posted) heel that supports flat feet." },
    { key: "B", label: "FIT B", code: "00", name: "Cushioned Support", description: "Neutral, cushioned arch support." },
    { key: "C", label: "FIT C", code: "05", name: "Cushioned + Metatarsal Support", description: "Neutral support with a metatarsal pad." },
    { key: "D", label: "FIT D", code: "25", name: "Maximum Support — Posted + Metatarsal", description: "Flat-foot support plus a metatarsal pad." },
  ],
  questions: [{ text: "Do you have flat feet?", helpText: "Look at a wet footprint.", options: [{ label: "Yes", sublabel: "Flat feet" }, { label: "No / Unsure" }] }],
  saved: { key: "d", label: "FIT D", code: "25" },
});
const fpick = (answers) => pickOrthotic(catalog, answers, { fits: FF.fits });
test("FITFinder data is cleaned and the saved FIT kept", () => {
  assert.equal(FF.fits.length, 4);
  assert.equal(FF.saved, "D");
  assert.equal(sanitizeFitfinder({ fits: [{ key: "<x>", label: "", code: "abc" }] }), null);
  assert.ok(!JSON.stringify(sanitizeFitfinder({ fits: [{ key: "A", label: "FIT A", code: "20", name: "<script>x</script>" }] })).includes("<"));
});
test("flat feet + ball-of-foot pain → FIT D, without needing a product yet", () => {
  const r = fpick({ arch: "flat_low", ball_of_foot_pain: "yes" });
  assert.equal(r.fit.label, "FIT D");
  assert.ok(!r.pick);
});
test("each answer pair gives the FIT FITFinder would give", () => {
  const want = { "flat_low|no": "A", "medium_high|no": "B", "medium_high|yes": "C", "flat_low|yes": "D" };
  for (const [k, v] of Object.entries(want)) {
    const [arch, met] = k.split("|");
    assert.equal(fpick({ arch, ball_of_foot_pain: met }).fit.key, v, k);
  }
});
test("a saved FIT stands in for the arch and ball-of-foot questions", () => {
  const r = fpick({ line: "speed", gender: "women", fit: "D" });
  assert.ok(r.pick.title.includes("Speed Posted") && r.pick.title.includes("Metatarsal"), r.pick.title);
  assert.equal(r.pick.fit, "FIT D");
});
test("the pick names its FIT", () => {
  assert.equal(fpick({ line: "train", gender: "men", arch: "medium_high", ball_of_foot_pain: "yes" }).pick.fit, "FIT C");
});
test("no FIT yet → asks the two questions instead of guessing", () => {
  assert.ok(fpick({ arch: "flat_low" }).error);
});
test("Claude's tool knows the FITs, the store's questions and the saved FIT", () => {
  const tree = { intent: "orthotic", definition: { finder: catalog } };
  const def = finderToolDef(tree, { fitfinder: FF });
  assert.match(def.description, /FIT D — Maximum Support/);
  assert.match(def.description, /Do you have flat feet\?/);
  assert.match(def.description, /ALREADY HAS A FIT: FIT D/);
  assert.match(def.description, /A FIT describes an orthotic insert only/, "FITs never describe shoes or sandals");
  assert.deepEqual(def.input_schema.properties.fit.enum, ["A", "B", "C", "D"]);
  const plain = finderToolDef(tree);
  assert.ok(!/FIT D/.test(plain.description) && !plain.input_schema.properties.fit, "no FIT talk without FITFinder");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
