// Test recordings: who is recorded, for how long, and how transcripts read.
// Recording is off unless the store turns it on; it lapses after two weeks;
// by default only testers (the tester link) are recorded — never ordinary
// shoppers — and the app's own Test chat is recorded while it's on.
//
// Run: node scripts/eval-chat-recording.mjs
import assert from "node:assert/strict";
import { recordingState, shouldRecord, cleanTester, describeExtras, groupSessions, recordingLabels, RECORD_DAYS, KEEP_DAYS } from "../app/lib/chat-recording.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const now = new Date("2026-10-20T12:00:00Z");
const later = new Date(now.getTime() + 3 * 864e5);
const past = new Date(now.getTime() - 1000);

console.log("\nwho is recorded");
test("off by default, and off once the end date passes", () => {
  assert.equal(shouldRecord({}, { tester: "Ann", now }), false);
  assert.equal(shouldRecord({ recordChatsUntil: null }, { tester: "Ann", now }), false);
  assert.equal(shouldRecord({ recordChatsUntil: past }, { tester: "Ann", now }), false);
  assert.equal(recordingState({ recordChatsUntil: past }, now).on, false);
});
test("testers only (default): the tester link is recorded, ordinary shoppers aren't", () => {
  const cfg = { recordChatsUntil: later };
  assert.equal(recordingState(cfg, now).scope, "testers");
  assert.equal(shouldRecord(cfg, { tester: "Ann", now }), true);
  assert.equal(shouldRecord(cfg, { tester: "", now }), false);
  assert.equal(shouldRecord(cfg, { tester: "<>!!", now }), false, "a name that cleans to nothing isn't a tester");
});
test("everyone: every chat is recorded while it's on", () => {
  const cfg = { recordChatsUntil: later, recordChatsScope: "everyone" };
  assert.equal(shouldRecord(cfg, { tester: "", now }), true);
  assert.equal(shouldRecord({ ...cfg, recordChatsUntil: past }, { tester: "", now }), false);
});
test("the app's own Test chat is recorded while it's on", () => {
  assert.equal(shouldRecord({ recordChatsUntil: later }, { internal: true, now }), true);
  assert.equal(shouldRecord({}, { internal: true, now }), false);
});
test("two weeks on, thirty days kept", () => {
  assert.equal(RECORD_DAYS, 14);
  assert.equal(KEEP_DAYS, 30);
});

console.log("\ntranscripts");
test("tester names are cleaned and capped", () => {
  assert.equal(cleanTester("  Sarah  K. "), "Sarah K.");
  assert.equal(cleanTester("<script>x</script>"), "scriptxscript");
  assert.equal(cleanTester("Zoë_QA-2"), "Zoë_QA-2");
  assert.equal(cleanTester("x".repeat(80)).length, 40);
});
test("what came with a reply is listed in one line", () => {
  assert.equal(describeExtras([{ type: "map_cta", mapId: "15ecd30bd8acd4", label: "Find a store near you" }]), "store map button: Find a store near you");
  assert.equal(describeExtras([{ type: "form_cta", form: "ojyWbTvZ", label: "Identify my orthotic" }]), "quiz button: Identify my orthotic");
  const line = describeExtras([{ type: "support_cta" }, { type: "visualize_cta" }, { type: "fitfinder_fit", key: "D" }, { type: "suggestions", questions: ["Wide?", "Returns?"] }, { type: "nonsense" }]);
  assert.equal(line, "support button · See It Styled · FIT D · suggested: Wide? | Returns?");
});
test("turns group into chats, newest chat first, turns in order", () => {
  const t = (id, s, mins, ok = true) => ({ id, sessionId: s, tester: s === "a" ? "Ann" : "", createdAt: new Date(now.getTime() + mins * 60000), ok, message: id, reply: id });
  const g = groupSessions([t("a2", "a", 2), t("b1", "b", 10), t("a1", "a", 1), t("a3", "a", 3, false)]);
  assert.deepEqual(g.map((s) => s.sessionId), ["b", "a"]);
  assert.deepEqual(g[1].turns.map((x) => x.id), ["a1", "a2", "a3"]);
  assert.equal(g[1].tester, "Ann");
  assert.equal(g[1].failed, 1);
});

console.log("\nthe admin page's days and weeks");
test("days in the store's time zone: Today, Yesterday, then the date", () => {
  // Tue Oct 20, 2026, 9am in New York (13:00 UTC).
  const L = recordingLabels({ timeZone: "America/New_York", now: new Date("2026-10-20T13:00:00Z") });
  assert.deepEqual(L.day(new Date("2026-10-20T03:30:00Z")), { key: "2026-10-19", label: "Yesterday" }); // 11:30pm Oct 19 NY
  assert.deepEqual(L.day(new Date("2026-10-20T04:30:00Z")), { key: "2026-10-20", label: "Today" });
  assert.deepEqual(L.day(new Date("2026-10-16T15:00:00Z")), { key: "2026-10-16", label: "Fri, Oct 16" });
});
test("weeks start Monday: This week, Last week, Week of …", () => {
  const L = recordingLabels({ timeZone: "America/New_York", now: new Date("2026-10-20T13:00:00Z") });
  assert.deepEqual(L.week(new Date("2026-10-19T15:00:00Z")), { key: "2026-10-19", label: "This week" });
  assert.deepEqual(L.week(new Date("2026-10-18T15:00:00Z")), { key: "2026-10-12", label: "Last week" });
  assert.deepEqual(L.week(new Date("2026-10-04T15:00:00Z")), { key: "2026-09-28", label: "Week of Sep 28" });
});
test("times read in the store's zone; an unknown zone falls back to UTC", () => {
  assert.equal(recordingLabels({ timeZone: "America/New_York" }).time(new Date("2026-10-20T19:05:00Z")), "3:05 PM");
  const bad = recordingLabels({ timeZone: "Mars/Olympus", now: new Date("2026-10-20T13:00:00Z") });
  assert.equal(bad.time(new Date("2026-10-20T19:05:00Z")), "7:05 PM");
  assert.equal(bad.day(new Date("2026-10-20T01:00:00Z")).label, "Today");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
