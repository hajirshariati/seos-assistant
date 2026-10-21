// Dashboard days follow the store's time zone: "today" turns over at the
// store's midnight, not UTC midnight (8pm in New York during EDT).
import assert from "node:assert/strict";
import { dayKeyIn, dayKeysBetween } from "../app/lib/store-day.js";

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};

const ny = dayKeyIn("America/New_York");
test("8:30pm in New York is still the same day there (it's past midnight UTC)", () => {
  const t = new Date("2026-10-21T00:30:00Z");
  assert.equal(ny(t), "2026-10-20");
  assert.equal(dayKeyIn("")(t), "2026-10-21", "no zone → UTC");
});
test("an unknown zone falls back to UTC instead of failing", () => {
  assert.equal(dayKeyIn("Not/AZone")(new Date("2026-10-21T00:30:00Z")), "2026-10-21");
});
test("the day list ends with the store's today and never skips or repeats a day across a DST change", () => {
  const end = new Date("2026-11-03T03:00:00Z"); // 10pm Nov 2 in New York, after DST ended Nov 1
  const keys = dayKeysBetween(new Date(end.getTime() - 5 * 86400000), end, ny);
  assert.equal(keys.at(-1), "2026-11-02");
  assert.deepEqual(keys, ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
