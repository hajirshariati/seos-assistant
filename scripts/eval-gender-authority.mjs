// Gender-authority reconciliation eval.
//
// The bot has historically derived "session gender" from a positional
// regex scan of history (detectGenderFromHistory) which, after a
// recipient pivot ("...actually a gift for my mom" following an earlier
// "men's"), can re-land on the stale earlier mention and lock the
// search to the wrong gender — the "forgot my mom / we don't have
// men's" failure.
//
// reconcileSessionGender makes the LLM classifier authoritative for
// adult gender: the classifier only emits a gender the customer
// EXPLICITLY stated, so a confident Men/Women beats the regex guess.
// It abstains (keeps the regex value) when the classifier returns null,
// low confidence, or Kids (kids has its own lowercase-token path we
// don't disturb here).
//
// Pure-function tests — no DB, no Anthropic.

import assert from "node:assert/strict";
import { reconcileSessionGender } from "../app/lib/chat-helpers.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

test("A1 — classifier Women overrides stale regex men (the 'forgot my mom' fix)", () => {
  assert.equal(reconcileSessionGender("men", "Women", "high"), "women");
});

test("A2 — classifier Men overrides stale regex women", () => {
  assert.equal(reconcileSessionGender("women", "Men", "medium"), "men");
});

test("A3 — classifier abstains (null) → keep regex value", () => {
  assert.equal(reconcileSessionGender("men", null, "medium"), "men");
});

test("A4 — classifier low confidence → do NOT override, keep regex", () => {
  assert.equal(reconcileSessionGender("men", "Women", "low"), "men");
});

test("A5 — classifier Kids → keep regex value (kids path untouched)", () => {
  assert.equal(reconcileSessionGender("women", "Kids", "high"), "women");
});

test("A6 — classifier agrees with regex → unchanged", () => {
  assert.equal(reconcileSessionGender("women", "Women", "high"), "women");
});

test("A7 — no regex value, classifier confident → classifier fills it", () => {
  assert.equal(reconcileSessionGender(null, "Men", "high"), "men");
});

test("A8 — no regex, classifier abstains → null (nothing established)", () => {
  assert.equal(reconcileSessionGender(null, null, "medium"), null);
});

test("A9 — missing confidence defaults to non-low (treated as usable)", () => {
  assert.equal(reconcileSessionGender("men", "Women", undefined), "women");
});

test("A10 — regex kid value preserved when classifier abstains", () => {
  assert.equal(reconcileSessionGender("kid", null, "medium"), "kid");
});

console.log("");
if (failed > 0) {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err.stack || f.err.message}`);
  process.exit(1);
} else {
  console.log(`PASS  ${passed} passed, 0 failed`);
}
