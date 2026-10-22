// The rotating welcome line: the default phrases use hand-written
// translations (natural Persian, with the zero-width non-joiner), whatever
// the casing or punctuation the store typed them with.
import assert from "node:assert/strict";
import { curatedTranslations, TARGET_LANGUAGES } from "../app/lib/greeting-curated.js";

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const fa = (p) => curatedTranslations(p)?.find((t) => t.code === "fa")?.text;

test("both default lines have every language, with the right direction", () => {
  for (const p of ["What can I help you find today?", "How can I help you today?"]) {
    const t = curatedTranslations(p);
    assert.equal(t.length, TARGET_LANGUAGES.length);
    for (const { code, dir } of TARGET_LANGUAGES) assert.ok(t.find((x) => x.code === code && x.dir === dir && x.text.length > 3), code);
  }
});
test("Persian reads naturally (with the ZWNJ in می‌توانم)", () => {
  assert.equal(fa("How can I help you today?"), "امروز چطور می‌توانم کمکتان کنم؟");
  assert.equal(fa("What can I help you find today?"), "امروز دنبال چه می\u200cگردید؟");
});
test("the other common welcome lines are hand-translated too", () => {
  assert.equal(fa("What can I help you with today?"), "امروز چه کمکی از دستم برمی\u200cآید؟");
  for (const p of ["What are you looking for today?", "How can I help you?", "How may I help you today?", "What can I help you find?", "What can I help you with?"]) assert.ok(curatedTranslations(p), p);
});
test("Persian uses Persian letters (ی ک), not Arabic (ي ك)", () => {
  for (const p of ["How can I help you today?", "What can I help you find today?", "What can I help you with today?", "What are you looking for today?"]) assert.ok(!/[يك]/.test(fa(p)), fa(p));
});
test("casing, spacing and punctuation don't matter", () => {
  assert.ok(curatedTranslations("  how can I help you today "));
  assert.ok(curatedTranslations("What can I help you find today"));
  assert.ok(curatedTranslations("WHAT CAN I HELP YOU FIND TODAY?!"));
});
test("a store's own phrase isn't hand-translated (the model does it)", () => {
  assert.equal(curatedTranslations("Looking for the perfect walking shoe?"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
