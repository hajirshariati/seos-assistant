// Engagement (app/lib/engagement.js): the rate is chats over Shopify's
// sessions to one decimal, days without sessions have no rate, and no
// sessions at all means "no rate", never 0%.
//
// Run: node scripts/eval-engagement.mjs
import assert from "node:assert/strict";
import { rateOf, sessionsByDayFrom, engagementSeries, engagementNote } from "../app/lib/engagement.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };

console.log("\nrateOf");
test("chats over sessions, one decimal", () => { assert.equal(rateOf(2612, 187168), 1.4); assert.equal(rateOf(391, 23491), 1.7); });
test("nothing to divide by → null, not 0", () => { assert.equal(rateOf(5, 0), null); assert.equal(rateOf(0, 0), null); assert.equal(rateOf(0, 100), 0); });
test("strings and junk are read as numbers", () => { assert.equal(rateOf("10", "1000"), 1); assert.equal(rateOf(null, "x"), null); });

console.log("\nsessionsByDayFrom");
test("ShopifyQL rows become a day → sessions map (the day trimmed to its date)", () => {
  assert.deepEqual(sessionsByDayFrom([{ day: "2026-10-29T00:00:00", sessions: "23673" }, { day: "2026-10-30", sessions: 24836 }]), { "2026-10-29": 23673, "2026-10-30": 24836 });
});
test("rows without a day are skipped; a repeated day adds up", () => {
  assert.deepEqual(sessionsByDayFrom([{ sessions: 5 }, { day: "x", sessions: 5 }, { day: "2026-11-01", sessions: 1 }, { day: "2026-11-01", sessions: 2 }]), { "2026-11-01": 3 });
});

console.log("\nengagementSeries");
const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
test("each day with its chats, sessions and rate; totals across the range", () => {
  const e = engagementSeries(days, { "2026-11-01": 300, "2026-11-02": 250 }, { "2026-11-01": 20000, "2026-11-02": 25000, "2026-11-03": 5000 });
  assert.deepEqual(e.days, [
    { date: "2026-11-01", chats: 300, sessions: 20000, rate: 1.5 },
    { date: "2026-11-02", chats: 250, sessions: 25000, rate: 1 },
    { date: "2026-11-03", chats: 0, sessions: 5000, rate: 0 },
  ]);
  assert.equal(e.chats, 550); assert.equal(e.sessions, 50000); assert.equal(e.rate, 1.1);
});
test("a day Shopify hasn't reported has no rate, and doesn't count in the total's sessions", () => {
  const e = engagementSeries(days, { "2026-11-03": 10 }, { "2026-11-01": 1000 });
  assert.equal(e.days[2].sessions, 0); assert.equal(e.days[2].rate, null);
  assert.equal(e.sessions, 1000); assert.equal(e.rate, 1);
});
test("no session counts at all: chats still counted, every rate null, sessions null", () => {
  const e = engagementSeries(days, { "2026-11-01": 7 }, null);
  assert.equal(e.chats, 7); assert.equal(e.sessions, null); assert.equal(e.rate, null);
  assert.ok(e.days.every((d) => d.rate === null && d.sessions === null));
});
test("an empty range is harmless", () => { assert.deepEqual(engagementSeries([], {}, {}), { days: [], chats: 0, sessions: 0, rate: null }); });

console.log("\nengagementNote");
test("names the missing permission, or Shopify not answering; nothing when all is well", () => {
  assert.match(engagementNote("permission"), /reports permission/);
  assert.match(engagementNote("not available"), /aren't available/);
  assert.equal(engagementNote(""), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
