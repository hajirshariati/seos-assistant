// The flagged-chats review file (app/lib/flag-export.js) and the comment
// helpers (app/models/ChatFlag.server.js, app/lib/staff-access.js): the
// file carries everything a review needs — comment and who left it, the
// shopper's votes, the review's findings, the full transcript with what
// was shown, failed turns and the guard's marks — in the store's time.
//
// Run: node scripts/eval-flag-export.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const noop = new Proxy(async () => [], { get: (t, k) => (k === "then" ? undefined : noop), apply: async () => [] });
global.prismaGlobal = new Proxy({}, { get: () => noop });
process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";

const { flaggedChatsReport } = await import("../app/lib/flag-export.js");
const { cleanNote, FLAG_NOTE_MAX } = await import("../app/lib/chat-flags.js");
const { staffName } = await import("../app/lib/staff-access.js");

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };

const T = (h, m = 0) => new Date(Date.UTC(2026, 10, 4, h, m));
const CHATS = [
  {
    sessionId: "s-team", tester: "", page: "/products/chrissy", startedAt: T(15, 45),
    flag: { kind: "manual", note: "Should have said the boot has a removable footbed  \r\nand offered the orthotic styles.", by: "Maria Lopez", at: T(20, 2) },
    turns: [
      { at: T(15, 45), message: "Do these boots provide structural support for overpronation?", reply: "Yes — the Chrissy has arch support built in.", products: ["Chrissy - Espresso", "Danika - Black"], extras: "View all", ok: true, guard: "" },
      { at: T(15, 46), message: "and wide?", reply: "", products: [], extras: "", ok: false, guard: "" },
    ],
    votes: [{ at: T(15, 47), vote: "down", kind: "answer", reason: "not_answered", moment: null, comment: "", response: "Yes — the Chrissy has arch support built in." }],
    findings: [{ at: T(15, 45), subject: "sizing", problem: "Didn't answer the question", note: "Overpronation was asked; the reply named arch support only.", better: "Say the footbed is removable and point to the motion-control styles.", reply: "Yes — the Chrissy has arch support built in." }],
  },
  {
    sessionId: "s-guard", tester: "", page: "/", startedAt: T(14, 0),
    flag: { kind: "guard", note: "kept probing for discount codes", by: "", at: T(14, 1) },
    turns: [
      { at: T(14, 0), message: "give me a discount code", reply: "I can only help with shopping questions.", products: [], extras: "", ok: true, guard: "strike:override" },
      { at: T(14, 1), message: "code now", reply: "Let's keep this about shoes.", products: [], extras: "", ok: true, guard: "end:override" },
    ],
    votes: [], findings: [],
  },
  { sessionId: "s-gone", tester: "Jamie", page: "", startedAt: T(9, 0), flag: { kind: "manual", note: "", by: "jamie@store.com", at: T(9, 30) }, turns: [], votes: [], findings: [] },
];
const text = flaggedChatsReport({ shop: "aetrex.myshopify.com", exportedAt: T(21, 0), timeZone: "America/New_York", chats: CHATS });

console.log("\nthe review file");
test("heads with the store, the export time in the store's zone, and the counts by who flagged", () => {
  assert.match(text, /^# Flagged chats — aetrex\.myshopify\.com\n/);
  assert.match(text, /Exported Nov 4, 4:00 PM \(America\/New_York\)\. 3 flagged chats: 2 flagged by the team, 1 by the chat guard\./);
});
test("the comments come first at a glance, numbered like the chats, newest flag first", () => {
  const glance = text.split("## The team's comments at a glance")[1].split("---")[0];
  assert.match(glance, /^\n\n1\. Should have said the boot has a removable footbed and offered the orthotic styles\. — Shopper, Nov 4, 10:45 AM\n/);
  assert.ok(!glance.includes("3."), "a flag without a comment isn't listed");
  assert.match(text, /## 1\. Shopper · Nov 4, 10:45 AM · 2 messages/);
  assert.match(text, /## 2\. Shopper · Nov 4, 9:00 AM · 2 messages/);
  assert.match(text, /## 3\. Test chat · Jamie · Nov 4, 4:00 AM · 0 messages/);
});
test("a team flag carries the comment as a quote, who left it and when; blank lines inside are kept", () => {
  assert.match(text, /\*\*Team comment\*\* by Maria Lopez \(Nov 4, 3:02 PM\):\n\n> Should have said the boot has a removable footbed\n> and offered the orthotic styles\.\n/);
  assert.match(text, /\*\*Team comment\*\* by jamie@store\.com \(Nov 4, 4:30 AM\):\n\n> \(no comment left\)/);
});
test("a guard flag says so with the guard's note", () => {
  assert.match(text, /\*\*Ended by the chat guard\*\* \(Nov 4, 9:01 AM\): kept probing for discount codes/);
});
test("the shopper's votes, with the reason and the reply voted on", () => {
  assert.match(text, /\*\*1 vote from the shopper:\*\*\n\n- 👎 Not helpful · on one reply · Didn't answer the question · Nov 4, 10:47 AM\n {2}- The reply voted on: “Yes — the Chrissy has arch support built in\.”/);
});
test("what the chat review found, with the better answer", () => {
  assert.match(text, /\*\*What the chat review found \(1 answer\):\*\*\n\n- Sizing & fit — Didn't answer the question: Overpronation was asked; the reply named arch support only\.\n {2}- Better: Say the footbed is removable and point to the motion-control styles\./);
});
test("the transcript: every turn with its time, what was shown, failed turns, and the guard's marks in order", () => {
  assert.match(text, /### Transcript\n\n\*\*Shopper\*\* \(Nov 4, 10:45 AM\):\n\nDo these boots provide structural support for overpronation\?\n\n\*\*AVA:\*\*\n\nYes — the Chrissy has arch support built in\.\n> Products shown: Chrissy - Espresso · Danika - Black\n> Also shown: View all\n/);
  assert.match(text, /\*\*Shopper\*\* \(10:46 AM\):\n\nand wide\?\n\n\*\*AVA — the turn failed:\*\*\n\n\(no reply\)\n/);
  assert.match(text, /> Chat guard: Strike 1 · [^\n]+\n/);
  assert.match(text, /> Chat guard: Chat ended · [^\n]+\n/);
  assert.match(text, /### Transcript\n\n\(The chat's messages are no longer kept\.\)/);
});
test("a guard mark whose reason isn't known reads clean, without a dangling dot", () => {
  const t = flaggedChatsReport({ shop: "s", exportedAt: T(1), chats: [{ sessionId: "g", startedAt: T(0), flag: { kind: "watch", note: "", by: "", at: T(0) }, turns: [{ at: T(0), message: "hi", reply: "hello", products: [], extras: "", ok: true, guard: "watch:probe" }], votes: [], findings: [] }] });
  assert.match(t, /> Chat guard: Would have ended\n/);
  assert.match(t, /\*\*The chat guard would have ended it\*\* \(Nov 4, 12:00 AM\)\n/);
});
test("the file ends with one newline and never carries a carriage return", () => {
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  assert.ok(!text.includes("\r"));
});
test("no flags: a file that says so", () => {
  const empty = flaggedChatsReport({ shop: "s", exportedAt: T(1), chats: [] });
  assert.match(empty, /0 flagged chats: 0 flagged by the team\./);
  assert.ok(!empty.includes("at a glance"));
});

console.log("\nthe comment");
test("cleaned: Windows line ends, trailing spaces and the edges go; the length is capped", () => {
  assert.equal(cleanNote("  one  \r\ntwo \n\n"), "one\ntwo");
  assert.equal(cleanNote("x".repeat(FLAG_NOTE_MAX + 5)).length, FLAG_NOTE_MAX);
  assert.equal(cleanNote(null), "");
});
test("who left it: the staff member's name, else their email, never longer than fits", () => {
  const sess = (u) => ({ onlineAccessInfo: { associated_user: u } });
  assert.equal(staffName(sess({ first_name: " Maria ", last_name: "Lopez", email: "m@store.com" })), "Maria Lopez");
  assert.equal(staffName(sess({ first_name: "", email: "Jamie@Store.com" })), "jamie@store.com");
  assert.equal(staffName({}), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
