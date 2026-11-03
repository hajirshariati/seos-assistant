// My rewards (rewards-card.js), Talk to a person (human-help.js) and the
// customer service log's yearly numbers (service-log.js). Pure rules.
//
// Run: node scripts/eval-rewards-and-human.mjs
import assert from "node:assert/strict";
import { parseRewardsCard, rewardsDefaults, rewardsCardConfig, rewardsBalanceWords, REWARDS_ROWS, REWARDS_NOTES } from "../app/lib/rewards-card.js";
import { humanHelpFields, humanHelpConfig, humanHelpLines } from "../app/lib/human-help.js";
import { yearlySummary, durationSeconds, interactionRow, summaryRow, INTERACTION_HEADERS, SUMMARY_HEADERS } from "../app/lib/service-log.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log("\nMy rewards: the card");
test("AVA's defaults are the Aetrex Access program, on, with the store's lockup", () => {
  const c = rewardsDefaults("AVA");
  assert.equal(c.on, true);
  assert.equal(c.brand, "Aetrex Access");
  assert.equal(c.earn.length, 4);
  assert.equal(c.use.length, 4);
  assert.equal(c.notes.length, 4);
  assert.match(c.notes[1], /come back on their own/);
  assert.equal(c.ctaUrl, "https://www.aetrex.com/pages/rewards");
  assert.match(c.logo, /^https:\/\/www\.aetrex\.com\/cdn\/shop\/files\/aetrex_access\.jpg$/);
  assert.equal(rewardsDefaults("SEoS").on, false, "any other store starts with the card off");
});
test("an empty store means the brand's defaults; a saved card is taken as it is", () => {
  assert.deepEqual(parseRewardsCard("", { brand: "AVA" }), rewardsDefaults("AVA"));
  assert.deepEqual(parseRewardsCard("{}", { brand: "AVA" }), rewardsDefaults("AVA"));
  assert.deepEqual(parseRewardsCard("not json", { brand: "AVA" }), rewardsDefaults("AVA"));
  const saved = parseRewardsCard(JSON.stringify({ on: true, title: "Points", earn: [{ label: "a", value: "b" }] }), { brand: "AVA" });
  assert.equal(saved.brand, "", "a saved blank stays blank");
  assert.deepEqual(saved.earn, [{ label: "a", value: "b" }]);
  assert.deepEqual(saved.use, []);
});
test("words are trimmed and capped; rows need both halves; the link must be a real one", () => {
  const c = parseRewardsCard({ on: true, title: " T ".padEnd(80, "x"), earn: [{ label: "a", value: "" }, { label: " b ", value: " c " }, {}, { label: "d", value: "e" }, { label: "f", value: "g" }, { label: "h", value: "i" }, { label: "j", value: "k" }], notes: ["", " n ", 5, "m", "o", "p", "q"], ctaUrl: "javascript:alert(1)", logo: "http://x/a.png" });
  assert.equal(c.title.length, 40);
  assert.deepEqual(c.earn, [{ label: "b", value: "c" }, { label: "d", value: "e" }, { label: "f", value: "g" }, { label: "h", value: "i" }]);
  assert.equal(c.earn.length, REWARDS_ROWS);
  assert.deepEqual(c.notes, ["n", "5", "m", "o"]);
  assert.equal(c.notes.length, REWARDS_NOTES);
  assert.equal(c.ctaUrl, "", "a script link is dropped");
  assert.equal(c.logo, "", "a plain-http picture is dropped");
  assert.equal(parseRewardsCard({ on: true, ctaUrl: "/pages/rewards" }).ctaUrl, "/pages/rewards");
  assert.equal(parseRewardsCard({ on: true, logo: "https://cdn.example.com/a.PNG?v=2" }).logo, "https://cdn.example.com/a.PNG?v=2");
  assert.equal(parseRewardsCard({ on: true, logo: "data:image/png;base64,AAAA" }).logo, "data:image/png;base64,AAAA");
});
test("the widget gets nothing when the card is off or empty", () => {
  assert.equal(rewardsCardConfig({ rewardsCard: "" }, { brand: "SEoS" }), null);
  assert.equal(rewardsCardConfig({ rewardsCard: JSON.stringify({ on: false }) }, { brand: "AVA" }), null);
  assert.equal(rewardsCardConfig({ rewardsCard: JSON.stringify({ on: true, title: "x" }) }, { brand: "AVA" }), null, "nothing to show");
  assert.equal(rewardsCardConfig({ rewardsCard: "" }, { brand: "AVA" })?.brand, "Aetrex Access");
});
test("the balance line: points, with dollars when the store shows them", () => {
  assert.equal(rewardsBalanceWords(2350, {}), "2,350 points");
  assert.equal(rewardsBalanceWords(1, {}), "1 point");
  assert.equal(rewardsBalanceWords(2350, { loyaltyDisplay: "dollars", loyaltyPointsPerDollar: "200" }), "2,350 points · $11.75");
  assert.equal(rewardsBalanceWords(2350, { loyaltyDisplay: "dollars", loyaltyPointsPerDollar: "200", loyaltyRounding: "down" }), "2,350 points · $11");
  assert.equal(rewardsBalanceWords("x", {}), "");
  assert.equal(rewardsBalanceWords(-5, {}), "");
});

console.log("\nTalk to a person");
test("AVA's defaults are Aetrex customer service; blanks fall back, bad values are dropped", () => {
  const f = humanHelpFields({}, { brand: "AVA" });
  assert.equal(f.phone, "1-888-526-2739");
  assert.equal(f.email, "help@aetrex.com");
  assert.match(f.hours, /Mon–Fri/);
  assert.deepEqual(humanHelpFields({}, { brand: "SEoS" }), { hours: "", phone: "", email: "", reply: "" });
  const own = humanHelpFields({ supportHours: "9–5", supportPhone: "not a phone", supportEmail: "nope", supportReplyTime: "in a day" }, { brand: "AVA" });
  assert.equal(own.hours, "9–5");
  assert.equal(own.phone, "1-888-526-2739", "a bad phone falls back");
  assert.equal(own.email, "help@aetrex.com", "a bad email falls back");
  assert.equal(own.reply, "in a day");
});
test("the widget's rows: live chat first (the store's label and page), then phone with a tel link, then email", () => {
  const h = humanHelpConfig({ supportPhone: "+1 (888) 526-2739 ext. 3" }, { brand: "AVA", supportUrl: "https://help.example.com", supportLabel: "Chat with Aetrex Support" });
  assert.equal(h.liveLabel, "Chat with Aetrex Support");
  assert.equal(h.liveUrl, "https://help.example.com");
  assert.equal(h.telHref, "tel:+18885262739");
  const lines = humanHelpLines(h);
  assert.deepEqual(lines.map((l) => l.kind), ["live_chat", "phone", "email"]);
  assert.match(lines[2].sub, /we reply within 1 business day/);
  assert.equal(humanHelpConfig({}, { brand: "SEoS" }).liveLabel, "Live chat");
});

console.log("\nCustomer service log: the yearly numbers");
const at = (s) => new Date(s);
const row = (sessionId, startedAt, mins, extra = {}) => ({ sessionId, visitor: "", startedAt: at(startedAt), lastAt: new Date(at(startedAt).getTime() + mins * 60000), messages: 3, signedIn: false, humanOffered: true, humanActivated: false, outcome: "", disclosureId: "", ...extra });
test("totals, resolved without a transfer, transfers used, repeat visitors within 72 hours, average duration — per year", () => {
  const rows = [
    row("a", "2026-01-05T10:00:00Z", 4, { visitor: "v1" }),
    row("b", "2026-01-06T09:00:00Z", 2, { visitor: "v1", humanActivated: true, outcome: "phone" }),
    row("c", "2026-01-10T09:00:00Z", 6, { visitor: "v1" }),
    row("d", "2026-03-01T09:00:00Z", 8, { visitor: "v2", humanActivated: true, outcome: "live_chat" }),
    row("e", "2025-12-31T23:00:00Z", 10),
  ];
  const y = yearlySummary(rows);
  assert.deepEqual(y.map((x) => x.year), [2025, 2026]);
  const y26 = y[1];
  assert.equal(y26.total, 4);
  assert.equal(y26.transfersActivated, 2);
  assert.equal(y26.resolvedWithoutTransfer, 2);
  assert.equal(y26.noTransferAtAll, 2);
  assert.equal(y26.repeatWithin72h, 1, "b is within 72h of a; c is 4 days after b; d is another visitor");
  assert.equal(y26.averageDurationSeconds, Math.round(((4 + 2 + 6 + 8) * 60) / 4));
  assert.equal(y[0].total, 1);
});
test("durations never go negative; a chat with no visitor id never counts as a repeat", () => {
  assert.equal(durationSeconds({ startedAt: "2026-01-01T00:00:10Z", lastAt: "2026-01-01T00:00:00Z" }), 0);
  const y = yearlySummary([row("a", "2026-01-05T10:00:00Z", 1), row("b", "2026-01-05T11:00:00Z", 1)]);
  assert.equal(y[0].repeatWithin72h, 0);
});
test("the CSV rows: one per chat with its opening words, and one per year", () => {
  const r = interactionRow(row("s1", "2026-01-05T10:00:00Z", 2, { visitor: "abc", humanActivated: true, outcome: "email", disclosureId: "d1" }), new Map([["d1", "Hi! I'm Ava."]]));
  assert.equal(r.length, INTERACTION_HEADERS.length);
  assert.deepEqual(r.slice(2, 10), [120, "s1", "abc", 3, "no", "yes", "yes", "email"]);
  assert.equal(r[10], "Hi! I'm Ava.");
  const s = summaryRow(yearlySummary([row("a", "2026-01-05T10:00:00Z", 1)])[0]);
  assert.equal(s.length, SUMMARY_HEADERS.length);
  assert.deepEqual(s, [2026, 1, 1, 0, 0, 1, 60]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
