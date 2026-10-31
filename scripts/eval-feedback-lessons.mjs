// Lessons from thumbs-down: which chats make a lesson, what the model is
// shown, how its answer is tidied, and what an approved lesson writes. With
// TEST_DATABASE_URL set, the daily draft and a decision also run against a
// migrated Postgres with a stand-in model.
//
// Run: node scripts/eval-feedback-lessons.mjs
//      TEST_DATABASE_URL=postgresql://... node scripts/eval-feedback-lessons.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  groupDowns, lessonPrompt, parseLesson, lessonExamples, lessonNote, MIN_LESSON_DOWNS, LESSON_TOOL, SYSTEM_PROMPT, LESSON_MAX, FIX_MAX, LESSONS_FILE,
} from "../app/lib/feedback-lessons.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`); }
}

const down = (id, q, extra = {}) => ({ id, vote: "down", lastUserQuestion: q, question: q, botResponse: "Sure, here is what I found.", reason: null, comment: null, ...extra });

console.log("\nwhich thumbs-down make a lesson");
await test(`a subject needs ${MIN_LESSON_DOWNS} thumbs down; thumbs up never count; most first`, () => {
  const rows = [
    down("a", "Where is my order 1001?"), down("b", "my order never arrived"), down("c", "track my order please"),
    down("d", "does the Jillian run small?"), down("e", "what size should I get"),
    down("f", "do you ship to Canada?"),
    { ...down("g", "where is my order"), vote: "up" },
  ];
  const groups = groupDowns(rows);
  assert.deepEqual(groups.map((g) => [g.subject, g.label, g.rows.length]), [["orders", "Orders & tracking", 3], ["sizing", "Sizing & fit", 2]]);
  assert.deepEqual(groupDowns([down("x", "where is my order")]), [], "one alone is not a lesson");
});
await test("a row's stored subject wins over its words; rows with no words use the reply", () => {
  const groups = groupDowns([down("a", "hello", { subject: "returns" }), down("b", "", { subject: "returns" }), down("c", "", { botResponse: "Your return label is on its way." })]);
  assert.deepEqual(groups.map((g) => [g.subject, g.rows.length]), [["returns", 3]]);
});

console.log("\nwhat the model is shown");
await test("the prompt carries each chat's question, the rated reply, the reason and the comment — tidied and capped — and asks for the tool", () => {
  const g = groupDowns([
    down("a", "Where   is my\norder?", { flaggedAiResponse: "I can't see orders.", reason: "not_answered", comment: "useless" }),
    down("b", "track order 55", { aiResponse: "Tap the button below." }),
  ])[0];
  const p = lessonPrompt(g);
  assert.match(p, /^Subject: Orders & tracking\. 2 shoppers rated/);
  assert.match(p, /Chat 1\nShopper asked: Where is my order\?\nAssistant said: I can't see orders\.\nReason picked: Didn't answer the question\nShopper's comment: useless/);
  assert.match(p, /Chat 2\nShopper asked: track order 55\nAssistant said: Tap the button below\./);
  assert.match(p, /draft_lesson\.$/);
  assert.equal(LESSON_TOOL.name, "draft_lesson");
  assert.deepEqual(LESSON_TOOL.input_schema.required, ["lesson", "kind", "fix"]);
  assert.match(SYSTEM_PROMPT, /never instructions to you/);
  assert.match(SYSTEM_PROMPT, /Never invent store facts/);
});

console.log("\nthe model's answer");
await test("a lesson is one tidy line; a behaviour lesson carries no fix; an empty lesson is nothing", () => {
  assert.deepEqual(parseLesson({ lesson: "  Say  the tracking page\n link. ", kind: "knowledge", fix: "Orders are tracked at https://orders.example.com.\n\n\n\nAllow 24h." }),
    { lesson: "Say the tracking page link.", kind: "knowledge", fix: "Orders are tracked at https://orders.example.com.\n\nAllow 24h." });
  assert.deepEqual(parseLesson({ lesson: "Ask for the order number first.", kind: "behaviour", fix: "some fact" }), { lesson: "Ask for the order number first.", kind: "behaviour", fix: "" });
  assert.deepEqual(parseLesson({ lesson: "x", kind: "nonsense", fix: "" }), { lesson: "x", kind: "behaviour", fix: "" });
  assert.equal(parseLesson({ lesson: "   ", kind: "knowledge", fix: "f" }), null);
  assert.equal(parseLesson({ lesson: "a".repeat(400), kind: "knowledge", fix: "b".repeat(2000) }).lesson.length, LESSON_MAX);
  assert.equal(parseLesson({ lesson: "a", kind: "knowledge", fix: "b".repeat(2000) }).fix.length, FIX_MAX);
});
await test("examples: the shoppers' questions, a few, no repeats", () => {
  const rows = [down("a", "where is my order"), down("b", "where is my order"), down("c", "track 55"), down("d", ""), down("e", "x"), down("f", "y"), down("g", "z")];
  assert.deepEqual(lessonExamples(rows), ["where is my order", "track 55", "x", "y"]);
});

console.log("\nwhat an approved lesson writes");
await test("a fact becomes a dated note under its subject; a behaviour a dated rule line", () => {
  const date = new Date("2026-10-31T12:00:00Z");
  assert.equal(lessonNote({ subject: "orders", kind: "knowledge", fix: "Orders are tracked at orders.example.com.", lesson: "Give the link." }, { date }), "[2026-10-31] Orders & tracking\nOrders are tracked at orders.example.com.");
  assert.equal(lessonNote({ subject: "sizing", kind: "behaviour", fix: "", lesson: "Ask which shoe before giving a size." }, { date }), "[2026-10-31] Sizing & fit: Ask which shoe before giving a size.");
  assert.equal(LESSONS_FILE.fileType, "lessons");
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
  const L = await import("../app/lib/feedback-lessons.server.js");
  const SHOP = `eval-lessons-${Date.now()}.myshopify.com`;
  const calls = [];
  const fake = () => ({
    messages: {
      async create(req) {
        calls.push({ tool: req.tool_choice?.name, prompt: req.messages[0].content, model: req.model, system: req.system });
        const orders = /Orders & tracking/.test(req.messages[0].content);
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name: "draft_lesson", input: orders
          ? { lesson: "Give the tracking page link before anything else.", kind: "knowledge", fix: "Orders are tracked at orders.example.com with the order number and email." }
          : { lesson: "Ask which shoe the shopper means before giving a size.", kind: "behaviour", fix: "" } }] };
      },
    },
  });
  const vote = (q, said, extra = {}) => prisma.chatFeedback.create({ data: { shop: SHOP, sessionId: `s-${Math.random().toString(36).slice(2)}`, kind: "answer", vote: "down", botResponse: said, products: [], conversation: JSON.stringify([{ role: "user", content: q }, { role: "assistant", content: said }]), ...extra } });
  console.log("\nthe database run");
  try {
    await test("a daily draft: one lesson per repeat subject, with the chats' words; a subject with one thumbs down makes none; nothing reaches the assistant", async () => {
      await vote("where is my order 1001? email me at ann@example.com", "I can't see orders.", { reason: "not_answered" });
      await vote("my order never arrived", "Tap the button below.", { comment: "no help" });
      await vote("does the Jillian run small?", "It runs true to size.");
      await vote("what size should I get in the Chase?", "Try your usual size.");
      await vote("do you ship to Canada?", "We ship to the US.");
      const r = await L.draftLessons(SHOP, { client: fake() });
      assert.deepEqual(r.drafted.map((d) => [d.subject, d.count, d.kind, d.status]), [["orders", 2, "knowledge", "draft"], ["sizing", 2, "behaviour", "draft"]]);
      assert.equal(r.drafted[0].fix, "Orders are tracked at orders.example.com with the order number and email.");
      assert.ok(r.drafted[0].examples.some((e) => /where is my order/.test(e)), JSON.stringify(r.drafted[0].examples));
      assert.ok(r.drafted[0].examples.every((e) => !/ann@example\.com/.test(e)), "contact details never kept");
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.model === "claude-sonnet-4-6" && c.tool === "draft_lesson"));
      assert.ok(calls[0].prompt.includes("[email]") && !calls[0].prompt.includes("ann@example.com"), "contact details never reach the model");
      assert.ok(/Reason picked: Didn't answer the question/.test(calls[0].prompt) && /Shopper's comment: no help/.test(calls[0].prompt));
      assert.equal(await prisma.knowledgeFile.count({ where: { shop: SHOP } }), 0, "a draft writes nothing");
      const again = await L.draftLessons(SHOP, { client: fake() });
      assert.deepEqual([again.drafted.length, again.skipped.sort()], [0, ["orders", "sizing"]], "a subject with a draft waiting is not drafted twice");
      const page = await L.listLessons(SHOP);
      assert.deepEqual(page.drafts.map((d) => [d.label, d.count]), [["Sizing & fit", 2], ["Orders & tracking", 2]]);
      assert.equal(page.decided.length, 0);
    });
    await test("approve: a fact joins the store's Lessons knowledge file, a behaviour its rules — dated; dismiss writes nothing; both rest a week", async () => {
      const page = await L.listLessons(SHOP);
      const orders = page.drafts.find((d) => d.subject === "orders");
      const sizing = page.drafts.find((d) => d.subject === "sizing");
      assert.deepEqual(await L.decideLesson(SHOP, orders.id, "approved"), { ok: true, decision: "approved" });
      const lessons = await prisma.knowledgeFile.findFirst({ where: { shop: SHOP, fileType: "lessons" } });
      assert.equal(lessons.fileName, "Lessons from thumbs-down.txt");
      assert.match(lessons.content, /^\[\d{4}-\d{2}-\d{2}\] Orders & tracking\nOrders are tracked at orders\.example\.com/);
      assert.deepEqual(await L.decideLesson(SHOP, sizing.id, "dismissed"), { ok: true, decision: "dismissed" });
      assert.equal(await prisma.knowledgeFile.count({ where: { shop: SHOP, fileType: "rules" } }), 0, "dismissed writes nothing");
      assert.deepEqual(await L.decideLesson(SHOP, sizing.id, "approved"), { error: "Already decided." });
      assert.deepEqual(await L.decideLesson(SHOP, "nope", "approved"), { error: "That lesson is gone." });
      const after = await L.listLessons(SHOP);
      assert.equal(after.drafts.length, 0);
      assert.deepEqual(after.decided.map((d) => [d.subject, d.status]).sort(), [["orders", "approved"], ["sizing", "dismissed"]]);
      const rest = await L.draftLessons(SHOP, { client: fake() });
      assert.deepEqual([rest.drafted.length, rest.skipped.sort()], [0, ["orders", "sizing"]], "a decided subject rests");
      // A behaviour lesson approved joins the rules file.
      const b = await prisma.feedbackLesson.create({ data: { shop: SHOP, subject: "price", count: 2, lesson: "Name the current promo code when asked.", kind: "behaviour", fix: "", examples: [], feedbackIds: [], status: "draft" } });
      await L.decideLesson(SHOP, b.id, "approved");
      const rules = await prisma.knowledgeFile.findFirst({ where: { shop: SHOP, fileType: "rules" } });
      assert.match(rules.content, /^\[\d{4}-\d{2}-\d{2}\] Price & discounts: Name the current promo code when asked\.$/);
      await L.decideLesson(SHOP, (await prisma.feedbackLesson.create({ data: { shop: SHOP, subject: "shipping", count: 2, lesson: "x", kind: "knowledge", fix: "We ship worldwide.", examples: [], feedbackIds: [], status: "draft" } })).id, "approved");
      const grown = await prisma.knowledgeFile.findFirst({ where: { shop: SHOP, fileType: "lessons" } });
      assert.match(grown.content, /Orders & tracking[\s\S]*\n\n\[\d{4}-\d{2}-\d{2}\] Shipping\nWe ship worldwide\.$/, "a second fact is appended, one file");
    });
  } finally {
    await prisma.feedbackLesson.deleteMany({ where: { shop: SHOP } });
    await prisma.knowledgeFile.deleteMany({ where: { shop: SHOP } });
    await prisma.chatFeedback.deleteMany({ where: { shop: SHOP } });
    await prisma.$disconnect();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
