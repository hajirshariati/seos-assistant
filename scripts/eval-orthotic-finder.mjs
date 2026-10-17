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
import { buildOrthoticCatalog, pickOrthotic, productFromNode, skuParts, describeLine } from "../app/lib/orthotic-finder.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
