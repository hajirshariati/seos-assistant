// Ratings on the analytics page: what a rated chat was about, from the
// shopper's own words, so repeat trouble can be flagged — and the flags
// only when a subject or reason has more than one thumbs down.
//
// Run: node scripts/eval-feedback-subjects.mjs
import assert from "node:assert/strict";

const { feedbackSubject, FEEDBACK_SUBJECTS, FEEDBACK_REASONS } = await import("../app/lib/chat-rating.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

await test("the shopper's words name the subject", () => {
  const cases = [
    ["Where is my order? It shipped last week", "orders"],
    ["please unscribe these messages", "other"],
    ["please unsubscribe me from these emails", "account"],
    ["I need the L405 size 8", "sizing"],
    ["Do these run big? Should I size up?", "sizing"],
    ["Can I return the sandals I bought?", "returns"],
    ["Is there a promo code for first orders?", "orders"],
    ["Is there a discount for nurses?", "price"],
    ["How long does shipping take to Canada?", "shipping"],
    ["Is the Jillian in stock in store near me?", "stores"],
    ["Show me sneakers for plantar fasciitis", "products"],
    ["hello", "other"],
  ];
  for (const [text, want] of cases) assert.equal(feedbackSubject(text), want, text);
  assert.equal(feedbackSubject(""), null);
  assert.equal(feedbackSubject(null), null);
  for (const key of Object.values(FEEDBACK_SUBJECTS)) assert.equal(typeof key, "string");
});

await test("every subject a rule can return has a label", () => {
  for (const text of ["order", "return", "email", "size", "price", "shipping", "stock", "sneakers", "zzz"]) {
    const key = feedbackSubject(text);
    assert.ok(FEEDBACK_SUBJECTS[key], `${text} → ${key}`);
  }
});

// The flag rule, as the page applies it: more than one thumbs down.
function flags(rows) {
  const subjects = {}, reasons = {};
  for (const r of rows) {
    if (r.vote !== "down") continue;
    if (r.subject && FEEDBACK_SUBJECTS[r.subject]) subjects[r.subject] = (subjects[r.subject] || 0) + 1;
    if (r.reason && FEEDBACK_REASONS[r.reason]) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const pick = (o, kind) => Object.entries(o).filter(([, n]) => n > 1).sort((x, y) => y[1] - x[1]).map(([key, n]) => ({ kind, key, n }));
  return [...pick(subjects, "subject"), ...pick(reasons, "reason")];
}
await test("flags: only subjects and reasons with more than one thumbs down, most first; thumbs up never count", () => {
  const rows = [
    { vote: "down", subject: "orders", reason: "not_answered" },
    { vote: "down", subject: "orders", reason: "other" },
    { vote: "down", subject: "orders", reason: "not_answered" },
    { vote: "down", subject: "sizing", reason: "wrong_info" },
    { vote: "down", subject: "sizing", reason: null },
    { vote: "down", subject: "price", reason: "wrong_product" },
    { vote: "up", subject: "price", reason: null },
    { vote: "up", subject: "price", reason: null },
  ];
  assert.deepEqual(flags(rows), [
    { kind: "subject", key: "orders", n: 3 },
    { kind: "subject", key: "sizing", n: 2 },
    { kind: "reason", key: "not_answered", n: 2 },
  ]);
  assert.deepEqual(flags([{ vote: "down", subject: "orders", reason: "other" }]), [], "one thumbs down flags nothing");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
