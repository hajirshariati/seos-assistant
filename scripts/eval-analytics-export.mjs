// Analytics exports: the Summary CSV carries every number the page leaves
// off, and the Topics CSV every topic of the week (not just the top few).
import assert from "node:assert/strict";
import { summaryRows, topicRows, modelLabel } from "../app/lib/analytics-export.js";
import { summarizeWeek } from "../app/lib/weekly-summary.js";
import { toCsv } from "../app/lib/csv-export.server.js";

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const usage = { totalMessages: 120, totalCost: 3.456789, avgCostPerMessage: 0.0288, embeddingCost: 0.12, imageCount: 4, imageCost: 0.16, totalToolCalls: 310, totalInputTokens: 1_200_000, totalOutputTokens: 90_000 };
const rows = summaryRows({
  range: { startDate: new Date("2026-09-27T12:00:00Z"), endDate: new Date("2026-10-27T12:00:00Z") },
  usage, feedback: { total: 10, up: 8, down: 2, satisfactionRate: 80, reasons: { wrong_product: 1, too_slow: 1 } },
  conversions: { count: 3, revenue: 412.5, aov: 137.5, currency: "USD" },
  interest: { searches: 200, views: 60, shown: 150, total: 410 },
  daily: [{ messages: 5 }, { messages: 0 }, { messages: 7 }],
});
const get = (m) => rows.find((r) => r[0] === m)?.[1];

test("summary: the range's dates", () => { assert.equal(get("From"), "2026-09-27"); assert.equal(get("To"), "2026-10-27"); });
test("summary: headline numbers", () => {
  assert.equal(get("Conversations"), 120);
  assert.equal(get("Chat-driven orders"), 3);
  assert.equal(get("Chat-driven revenue (USD)"), "412.50");
  assert.equal(get("Satisfaction (%)"), 80);
  assert.equal(get("AI cost (USD)"), "3.4568");
});
test("summary: what left the page is all there", () => {
  for (const m of ["Product details opened", "Product cards shown", "Products found", "Input tokens", "Output tokens", "Semantic search cost (USD)", "See It Styled images", "AI actions", "Active days", "Helpful votes", "Not helpful votes"]) {
    assert.ok(rows.some((r) => r[0] === m), m);
  }
  assert.equal(get("Active days"), "2 of 3");
  assert.equal(get("Input tokens"), 1_200_000);
});
test("summary: why not helpful, every reason (none picked → 0)", () => {
  assert.equal(get("Not helpful: Wrong product"), 1);
  assert.equal(get("Not helpful: Too slow"), 1);
  assert.equal(get("Not helpful: Info was wrong"), 0);
  assert.equal(get("Not helpful: Didn't answer the question"), 0);
  assert.equal(get("Not helpful: Something else"), 0);
});
test("summary: no votes → blank satisfaction, said why", () => {
  const r = summaryRows({ range: {}, usage: {}, feedback: { total: 0 }, conversions: {}, interest: {}, daily: [] });
  const row = r.find((x) => x[0] === "Satisfaction (%)");
  assert.equal(row[1], ""); assert.equal(row[2], "No votes yet");
});
test("summary: every row has three cells and makes a CSV", () => {
  assert.ok(rows.every((r) => r.length === 3));
  const csv = toCsv(["Metric", "Value", "Notes"], rows);
  assert.ok(csv.startsWith("Metric,Value,Notes\nFrom,2026-09-27,"));
});

const topics = [];
for (let i = 0; i < 9; i++) topics.push({ kind: "category", value: `cat ${i}` }, { kind: "category", value: `cat ${i}` });
topics.push({ kind: "condition", value: "bunions" }, { kind: "unanswered", value: "gift wrapping" }, { kind: "support", value: "" }, { kind: "sale", value: "" }, { kind: "sale", value: "" });
test("week: the page still gets the top 5", () => assert.equal(summarizeWeek(topics).categories.length, 5));
test("topics: the export gets every one", () => {
  const t = topicRows(summarizeWeek(topics, { all: true }));
  assert.equal(t.filter((r) => r[0] === "Shopping for").length, 9);
  assert.deepEqual(t.find((r) => r[0] === "Couldn't answer from your store info"), ["Couldn't answer from your store info", "Gift wrapping", 1]);
  assert.deepEqual(t.find((r) => r[1] === "Sale searches"), ["Totals", "Sale searches", 2]);
  assert.deepEqual(t.find((r) => r[1] === "Sent to customer service"), ["Totals", "Sent to customer service", 1]);
});
test("models: named plainly", () => { assert.equal(modelLabel("claude-haiku-4-5"), "Fast"); assert.equal(modelLabel("x-model"), "x-model"); });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
