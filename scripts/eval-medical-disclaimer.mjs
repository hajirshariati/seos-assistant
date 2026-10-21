// The health note goes under replies to pain/condition questions — including
// everyday phrasings — and not under plain style questions.
import assert from "node:assert/strict";
import { medicalDisclaimerRequired } from "../app/lib/medical-disclaimer.js";

const needs = (message) => medicalDisclaimerRequired({ workflow: "condition_recommendation", message });
let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};

test("clinical terms", () => {
  for (const m of ["plantar fasciitis", "I have bunions", "diabetic shoes", "flat feet", "heel spurs"]) assert.equal(needs(m), true, m);
});
test("everyday pain phrasings", () => {
  for (const m of ["my heels hurt", "sore feet after work", "my feet are so sore", "pain in my arch", "my toes ache", "the balls of my feet hurt"]) assert.equal(needs(m), true, m);
});
test("other conditions shoppers name", () => {
  for (const m of ["neuropathy in my toes", "I have hammer toes", "gout", "morton's neuroma", "achilles tendonitis", "shin splints"]) assert.equal(needs(m), true, m);
});
test("style questions get no note", () => {
  for (const m of ["cute sandals for vacation", "best sneakers for walking", "do you have this in black?", "what's your return policy?"]) assert.equal(needs(m), false, m);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
