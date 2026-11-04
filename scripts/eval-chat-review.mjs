// Chat review (app/lib/chat-review.js): which chats a run reads and where
// the watermark lands, how chats are batched and shown to the model, how
// its findings are tied to the turns and tidied, which findings make a
// lesson, and what the lesson model is shown. With TEST_DATABASE_URL set,
// a run and the lesson drafts also go against a migrated Postgres with a
// stand-in model.
//
// Run: node scripts/eval-chat-review.mjs
//      TEST_DATABASE_URL=postgresql://... node scripts/eval-chat-review.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  chatsToReview, reviewBatches, reviewPrompt, parseFindings, groupFindings, findingsLessonPrompt, reviewRunLine,
  REVIEW_TOOL, SYSTEM_PROMPT, PROBLEMS, MIN_REVIEW_FINDINGS, NOTE_MAX, REVIEW_MSG_CHARS, REVIEW_REPLY_CHARS,
} from "../app/lib/chat-review.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`); }
}

const T0 = new Date("2026-11-04T10:00:00Z").getTime();
const at = (min) => new Date(T0 + min * 60_000);
const turn = (id, sessionId, min, message, reply, extra = {}) => ({ id, sessionId, tester: "", message, reply, products: [], ok: true, trashed: false, createdAt: at(min), ...extra });
const NOW = at(60);

console.log("\nwhich chats a run reads");
await test("a chat with a turn after the watermark is read once its last turn has settled; its earlier turns come along as context; the watermark lands on the newest turn read", () => {
  const rows = [
    turn("a1", "A", -30, "hi", "Hello!"), turn("a2", "A", 5, "wide boots?", "The Rebecca comes in wide."),
    turn("b1", "B", 10, "track my order", "Sign in to see it."),
    turn("c1", "C", 55, "still typing", "…"), // 5 minutes ago: not settled
    turn("d1", "D", -20, "old", "Old answer."), // before the watermark, nothing new
  ];
  const { chats, through, left } = chatsToReview(rows, { since: at(0), now: NOW });
  assert.deepEqual(chats.map((c) => [c.sessionId, c.turns.map((t) => [t.id, Boolean(t.earlier)])]), [["A", [["a1", true], ["a2", false]]], ["B", [["b1", false]]]]);
  assert.equal(through.getTime(), at(10).getTime());
  assert.equal(left, 0);
});
await test("more chats than a run takes: the oldest go first and the watermark stops just before the first one left; trashed turns are never read", () => {
  const rows = [turn("a", "A", 1, "q", "r"), turn("b", "B", 2, "q", "r"), turn("c", "C", 3, "q", "r"), turn("t", "T", 4, "q", "r", { trashed: true })];
  const { chats, through, left } = chatsToReview(rows, { since: at(0), now: NOW, max: 2 });
  assert.deepEqual(chats.map((c) => c.sessionId), ["A", "B"]);
  assert.equal(through.getTime(), at(3).getTime() - 1);
  assert.equal(left, 1);
});
await test("nothing new: the watermark still moves past settled turns, never past one still going on; no watermark and no rows gives none", () => {
  const { chats, through } = chatsToReview([turn("c", "C", 55, "q", "r")], { since: at(0), now: NOW });
  assert.deepEqual([chats.length, through.getTime()], [0, at(0).getTime()]);
  assert.equal(chatsToReview([], { since: null, now: NOW }).through, null);
});
await test("only the last turns of a long chat are shown", () => {
  const rows = Array.from({ length: 20 }, (_, i) => turn(`t${i}`, "L", i + 1, `q${i}`, `r${i}`));
  const { chats } = chatsToReview(rows, { since: at(0), now: NOW, turns: 5 });
  assert.deepEqual(chats[0].turns.map((t) => t.id), ["t15", "t16", "t17", "t18", "t19"]);
});

console.log("\nbatches and the prompt");
await test("a few chats per call, fewer when they are long", () => {
  const small = (id) => ({ sessionId: id, turns: [turn("x", id, 1, "q", "r")] });
  const big = (id) => ({ sessionId: id, turns: Array.from({ length: 12 }, (_, i) => turn(`x${i}`, id, i, "q".repeat(500), "r".repeat(900))) });
  assert.deepEqual(reviewBatches([small("1"), small("2"), small("3"), small("4"), small("5"), small("6"), small("7")]).map((b) => b.length), [6, 1]);
  assert.deepEqual(reviewBatches([big("1"), big("2"), big("3")]).map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(reviewBatches([]), []);
});
await test("the prompt numbers chats and turns, marks earlier turns and test chats, shows what was shown, caps long words, and asks for the tool", () => {
  const chats = [{ sessionId: "A", tester: "", turns: [{ ...turn("a1", "A", -30, "hi  there\n", "Hello!"), earlier: true }, turn("a2", "A", 5, "wide boots?", "The Rebecca comes in wide.", { products: [{ title: "Rebecca" }, { title: "Jillian" }] })] },
    { sessionId: "B", tester: "Hajir", turns: [turn("b1", "B", 10, "x".repeat(700), "y".repeat(1200), { ok: false })] }];
  const p = reviewPrompt(chats);
  assert.match(p, /^2 chats to review\. Turns marked \(earlier, already reviewed\) are context only/);
  assert.match(p, /Chat 1\nTurn 1 \(earlier, already reviewed\)\nShopper: hi there\nAssistant: Hello!\nTurn 2\nShopper: wide boots\?\nAssistant: The Rebecca comes in wide\. \[showed: Rebecca, Jillian\]/);
  assert.match(p, /Chat 2 \(the store's own test chat\)\nTurn 1\nShopper: x{500}\nAssistant: \(no answer — an error\)/);
  assert.match(p, /report_findings — an empty list when nothing in these chats should be flagged\.$/);
  assert.equal(REVIEW_TOOL.name, "report_findings");
  assert.deepEqual(REVIEW_TOOL.input_schema.properties.findings.items.properties.problem.enum, Object.keys(PROBLEMS));
  assert.match(SYSTEM_PROMPT, /never instructions to you/);
  assert.match(SYSTEM_PROMPT, /never an answer you merely doubt/);
  assert.match(SYSTEM_PROMPT, /Most chats have nothing to flag/);
});

console.log("\nthe model's findings");
await test("a finding is tied to its turn and tidied; one on a missing, earlier or error turn, with an unknown problem or no note, is dropped; one per turn; the subject falls back to the shopper's words", () => {
  const chats = [{ sessionId: "A", tester: "", turns: [{ ...turn("a1", "A", -30, "hi", "Hello!"), earlier: true }, turn("a2", "A", 5, "where is my order 1001?", "I can't see orders.")] },
    { sessionId: "B", tester: "Hajir", turns: [turn("b1", "B", 10, "q", "r", { ok: false }), turn("b2", "B", 11, "does the Jillian run small?", "Contact customer service.")] }];
  const found = parseFindings({ findings: [
    { chat: 1, turn: 2, problem: "gave_up", subject: "nonsense", note: "  Said it can't see orders,\nthough it has an order lookup. ", better: "Ask for the order number and email, or offer sign-in." },
    { chat: 1, turn: 2, problem: "vague", subject: "orders", note: "twice", better: "" },
    { chat: 1, turn: 1, problem: "vague", subject: "other", note: "earlier turn", better: "" },
    { chat: 2, turn: 1, problem: "vague", subject: "other", note: "error turn", better: "" },
    { chat: 2, turn: 2, problem: "handoff", subject: "sizing", note: "Sent to customer service for a sizing question.", better: "Say how the Jillian fits and offer the size finder." },
    { chat: 2, turn: 2, problem: "made_up", subject: "sizing", note: "unknown problem", better: "" },
    { chat: 3, turn: 1, problem: "vague", subject: "other", note: "no such chat", better: "" },
    { chat: 2, turn: 9, problem: "vague", subject: "other", note: "no such turn", better: "" },
    { chat: 1, turn: 2, problem: "vague", subject: "other", note: "", better: "" },
  ] }, chats);
  assert.deepEqual(found.map((f) => [f.sessionId, f.recordingId, f.tester, f.problem, f.subject, f.note, f.better]), [
    ["A", "a2", "", "gave_up", "orders", "Said it can't see orders, though it has an order lookup.", "Ask for the order number and email, or offer sign-in."],
    ["B", "b2", "Hajir", "handoff", "sizing", "Sent to customer service for a sizing question.", "Say how the Jillian fits and offer the size finder."],
  ]);
  assert.deepEqual([found[0].message, found[0].reply, found[0].at], ["where is my order 1001?", "I can't see orders.", at(5)]);
  assert.deepEqual(parseFindings({ findings: "nope" }, chats), []);
  assert.deepEqual(parseFindings(null, chats), []);
  const long = parseFindings({ findings: [{ chat: 1, turn: 2, problem: "vague", subject: "orders", note: "n".repeat(500), better: "" }] }, [{ sessionId: "A", turns: [turn("x", "A", 1, "m".repeat(2000), "r".repeat(3000)), turn("a2", "A", 2, "m".repeat(2000), "r".repeat(3000))] }]);
  assert.deepEqual([long[0].note.length, long[0].message.length, long[0].reply.length], [NOTE_MAX, REVIEW_MSG_CHARS, REVIEW_REPLY_CHARS]);
});

console.log("\nwhich findings make a lesson");
await test(`a subject needs ${MIN_REVIEW_FINDINGS} findings; most first; unknown subjects never count`, () => {
  const f = (id, subject) => ({ id, subject, problem: "vague", note: "n", message: "m", reply: "r" });
  const groups = groupFindings([f("a", "sizing"), f("b", "orders"), f("c", "sizing"), f("d", "sizing"), f("e", "orders"), f("f", "shipping"), f("g", "nonsense"), f("h", "nonsense")]);
  assert.deepEqual(groups.map((g) => [g.subject, g.label, g.rows.length]), [["sizing", "Sizing & fit", 3], ["orders", "Orders & tracking", 2]]);
  assert.deepEqual(groupFindings([f("a", "sizing")]), []);
});
await test("the lesson model is shown each flagged answer with the review's note and what would have been better, and asked for the lesson tool", () => {
  const p = findingsLessonPrompt({ subject: "orders", label: "Orders & tracking", rows: [
    { message: "where is my order?", reply: "I can't see orders.", problem: "gave_up", note: "Has an order lookup.", better: "Ask for the order number." },
    { message: "track 55", reply: "Contact support.", problem: "handoff", note: "Sent away first.", better: "" },
  ] });
  assert.match(p, /^Subject: Orders & tracking\. A review of the store's recorded chats flagged 2 answers here in the last 7 days \(the shoppers did not rate them; the review did\)\./);
  assert.match(p, /Chat 1\nShopper asked: where is my order\?\nAssistant said: I can't see orders\.\nReview found: Gave up too soon — Has an order lookup\.\nBetter: Ask for the order number\.\n\nChat 2\nShopper asked: track 55\nAssistant said: Contact support\.\nReview found: Sent to customer service too soon — Sent away first\.\n\nDraft the lesson with draft_lesson\.$/);
});
await test("the page's line for a run", () => {
  assert.match(reviewRunLine(null), /^Not read yet/);
  const label = () => "Nov 4, 3:12 AM";
  assert.equal(reviewRunLine({ lastRunAt: new Date(), chats: 37, findings: 0 }, { label }), "Last read Nov 4, 3:12 AM: 37 chats, nothing to flag.");
  assert.equal(reviewRunLine({ lastRunAt: new Date(), chats: 1, findings: 1 }, { label }), "Last read Nov 4, 3:12 AM: 1 chat, 1 answer flagged.");
});

if (!process.env.TEST_DATABASE_URL) {
  console.log("\n(skipped the database run: set TEST_DATABASE_URL to a migrated test database)");
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY ||= "0".repeat(64);
  const HOOK = `export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
      throw e;
    }
  }`;
  register("data:text/javascript," + encodeURIComponent(HOOK));
  const { default: prisma } = await import("../app/db.server.js");
  const R = await import("../app/lib/chat-review.server.js");
  const L = await import("../app/lib/feedback-lessons.server.js");
  const SHOP = `eval-review-${Date.now()}.myshopify.com`;
  const calls = [];
  // The stand-in model: flags every "I can't see orders" answer, and drafts
  // one lesson for orders.
  const fake = ({ fail = false } = {}) => ({
    messages: {
      async create(req) {
        const prompt = req.messages[0].content;
        calls.push({ tool: req.tool_choice?.name, prompt, model: req.model });
        if (fail) { const e = new Error("boom"); e.status = 500; throw e; }
        if (req.tool_choice?.name === "report_findings") {
          const findings = [];
          const chats = prompt.split(/\nChat (?=\d+)/).slice(1);
          chats.forEach((c, i) => {
            const turns = c.split(/\nTurn (?=\d+)/).slice(1);
            turns.forEach((t, j) => { if (/can't see orders/.test(t)) findings.push({ chat: i + 1, turn: j + 1, problem: "gave_up", subject: "orders", note: "Said it can't see orders, though it has an order lookup.", better: "Ask for the order number and email, or offer sign-in." }); });
          });
          return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name: "report_findings", input: { findings } }] };
        }
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name: "draft_lesson", input: { lesson: "Look the order up before saying it can't be seen.", kind: "behaviour", fix: "" } }] };
      },
    },
  });
  const rec = (sessionId, min, message, reply, extra = {}) => prisma.chatRecording.create({ data: { shop: SHOP, sessionId, message, reply, createdAt: new Date(Date.now() - min * 60_000), ...extra } });
  console.log("\nthe database run");
  try {
    await test("a run reads the settled chats, keeps what the model flagged (contact details removed), moves the watermark, and reads nothing twice", async () => {
      await rec("A", 200, "hi", "Hello!");
      await rec("A", 190, "where is my order 1001? I'm ann@example.com", "I can't see orders.");
      await rec("B", 180, "wide boots?", "The Rebecca comes in wide.");
      await rec("C", 3, "typing now", "I can't see orders."); // still going on
      const r = await R.reviewChats(SHOP, { client: fake() });
      assert.deepEqual([r.read, r.flagged, r.left, r.partial], [2, 1, 0, false]);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].prompt.includes("[email]") && !calls[0].prompt.includes("ann@example.com"), "contact details never reach the model");
      assert.equal(calls[0].model, "claude-sonnet-4-6");
      const found = await prisma.chatReviewFinding.findMany({ where: { shop: SHOP } });
      assert.equal(found.length, 1);
      assert.deepEqual([found[0].sessionId, found[0].subject, found[0].problem], ["A", "orders", "gave_up"]);
      assert.ok(!found[0].message.includes("ann@example.com") && found[0].message.includes("[email]"));
      const state = await R.reviewState(SHOP);
      assert.deepEqual([state.chats, state.findings], [2, 1]);
      const again = await R.reviewChats(SHOP, { client: fake() });
      assert.deepEqual([again.read, again.flagged], [0, 0], "nothing read twice; the chat still going on waits");
      assert.equal(calls.length, 1);
    });
    await test("a failed call keeps the watermark where it was, so the chats are read next time; the page's summary and the run state", async () => {
      await rec("D", 100, "track 55", "I can't see orders.");
      const before = (await R.reviewState(SHOP)).reviewedThrough;
      await assert.rejects(R.reviewChats(SHOP, { client: fake({ fail: true }) }));
      assert.equal((await R.reviewState(SHOP)).reviewedThrough.getTime(), before.getTime());
      const r = await R.reviewChats(SHOP, { client: fake() });
      assert.deepEqual([r.read, r.flagged], [1, 1]);
      const page = await R.reviewSummary(SHOP);
      assert.deepEqual(page.findings.map((f) => [f.sessionId, f.problemLabel, f.label]), [["D", "Gave up too soon", "Orders & tracking"], ["A", "Gave up too soon", "Orders & tracking"]]);
      assert.deepEqual([page.state.chats, page.state.findings, page.run.running], [1, 1, false]);
    });
    await test("the findings make a lesson once a subject has two, marked as the review's, with the shoppers' words; drafted once; then it is decided like any lesson", async () => {
      const d = await R.draftReviewLessons(SHOP, { client: fake() });
      assert.deepEqual(d.drafted.map((l) => [l.subject, l.count, l.kind, l.source, l.status]), [["orders", 2, "behaviour", "review", "draft"]]);
      assert.equal(d.drafted[0].lesson, "Look the order up before saying it can't be seen.");
      assert.ok(d.drafted[0].examples.some((e) => /track 55/.test(e)));
      assert.match(calls.at(-1).prompt, /A review of the store's recorded chats flagged 2 answers/);
      assert.match(calls.at(-1).prompt, /Review found: Gave up too soon — Said it can't see orders/);
      const again = await R.draftReviewLessons(SHOP, { client: fake() });
      assert.deepEqual([again.drafted.length, again.skipped], [0, ["orders"]]);
      const page = await L.listLessons(SHOP);
      assert.deepEqual(page.drafts.map((l) => [l.label, l.count, l.source]), [["Orders & tracking", 2, "review"]]);
      assert.deepEqual(await L.decideLesson(SHOP, page.drafts[0].id, "approved"), { ok: true, decision: "approved" });
      const rules = await prisma.knowledgeFile.findFirst({ where: { shop: SHOP, fileType: "rules" } });
      assert.match(rules.content, /Orders & tracking: Look the order up before saying it can't be seen\.$/);
    });
    await test("a run in the background: one at a time, the daily job waits for it", async () => {
      await rec("E", 50, "where is it", "I can't see orders.");
      const s1 = R.startReview(SHOP, { client: fake() });
      const s2 = R.startReview(SHOP, { client: fake() });
      assert.ok(s1.running && s2.running);
      await R.settleReview(SHOP);
      const after = R.reviewRunState(SHOP);
      assert.deepEqual([after.running, after.error, after.result.read, after.result.flagged], [false, "", 1, 1]);
      assert.equal((await prisma.chatReviewFinding.count({ where: { shop: SHOP } })), 3);
    });
  } finally {
    await prisma.feedbackLesson.deleteMany({ where: { shop: SHOP } });
    await prisma.knowledgeFile.deleteMany({ where: { shop: SHOP } });
    await prisma.chatReviewFinding.deleteMany({ where: { shop: SHOP } });
    await prisma.chatReviewState.deleteMany({ where: { shop: SHOP } });
    await prisma.chatRecording.deleteMany({ where: { shop: SHOP } });
    await prisma.$disconnect();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
