// The health note goes under replies to pain/condition questions — including
// everyday phrasings — and not under plain style questions.
import assert from "node:assert/strict";
import { medicalDisclaimerRequired, footConditionQuestion } from "../app/lib/medical-disclaimer.js";

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
test("product names alone get no note — returns, orders, shipping, features", () => {
  for (const m of [
    "i am returing a pair of inserts and spoke to customer service about getting the same price on a newmpair",
    "where is my orthotic order",
    "can I return my insoles",
    "do you ship insoles to canada",
    "do these boots have a removable insert",
    "do you sell arch supports for kids?",
  ]) assert.equal(needs(m), false, m);
});
test("a condition named with a product still gets the note", () => {
  for (const m of ["orthotics for my flat feet", "insoles for plantar fasciitis", "inserts for heel pain"]) assert.equal(needs(m), true, m);
});
test("the check question carries the message and rules out orders", () => {
  const q = footConditionQuestion("Which shoes?", "my plantar fasciitis kit hasn't arrived");
  assert.match(q, /my plantar fasciitis kit hasn't arrived/);
  assert.match(q, /order, return, exchange, shipping or price question/);
  assert.match(q, /YES or NO only/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
