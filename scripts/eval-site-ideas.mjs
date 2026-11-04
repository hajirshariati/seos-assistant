// Learn → Improve the website (app/lib/site-ideas.js): when there is enough
// to work from, what the model is shown, how its ideas are tidied, ranked
// and kept apart from open ones, and that evidence is only the shoppers'
// own words. With TEST_DATABASE_URL set, the facts are gathered and a draft
// and a decision run against a migrated Postgres with a stand-in model.
//
// Run: node scripts/eval-site-ideas.mjs
//      TEST_DATABASE_URL=postgresql://... node scripts/eval-site-ideas.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { enoughFacts, ideasPrompt, parseIdeas, ideaPriority, IDEAS_TOOL, SYSTEM_PROMPT, AREAS, MAX_IDEAS, TITLE_MAX, CHANGE_MAX } from "../app/lib/site-ideas.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split("\n").slice(0, 16).join("\n      ") || err.message}`); }
}

const FACTS = {
  days: 30, chats: 412, conversions: { count: 17, revenue: 2431.5, currency: "USD" },
  themes: [{ title: "Wide widths", kind: "question", count: 38, summary: "Whether a style comes in wide, and which sizes are in stock.", lookAt: "Width availability on product pages.", quotes: ["do these come in wide at all", "is the Jillian available in wide 9"] }],
  unanswered: [{ label: "Do you ship to Canada", count: 6 }],
  storeQuestions: [{ label: "Free shipping threshold", count: 11 }],
  conditions: [{ label: "Plantar fasciitis", count: 24 }],
  supportHandoffs: 9,
  downs: { total: 7, bySubject: [{ label: "Sizing & fit", count: 4 }], byReason: [{ label: "Didn't answer the question", count: 3 }], comments: ["It kept sending me to customer service instead of checking my order."] },
  findings: [{ subject: "Shipping", problem: "Didn't answer the question", note: "Answered a Canada question with the US policy only.", better: "Say whether Canada is shipped to." }],
  products: [{ title: "Jillian", count: 52 }, { title: "Rebecca", count: 31 }],
};

console.log("\nenough to work from");
await test("a theme, two thumbs-down, a question asked twice or a finding is enough; nothing is not", () => {
  assert.equal(enoughFacts({}), false);
  assert.equal(enoughFacts({ themes: [{}] }), true);
  assert.equal(enoughFacts({ downs: { total: 1 } }), false);
  assert.equal(enoughFacts({ downs: { total: 2 } }), true);
  assert.equal(enoughFacts({ unanswered: [{ count: 1 }] }), false);
  assert.equal(enoughFacts({ unanswered: [{ count: 2 }] }), true);
  assert.equal(enoughFacts({ findings: [{}] }), true);
});

console.log("\nwhat the model is shown");
await test("the facts in sections with their numbers and quotes, and the ask for the tool", () => {
  const p = ideasPrompt(FACTS);
  assert.match(p, /^Facts from the last 30 days: 412 recorded chats, 17 orders from the chat \(USD 2,432\)\./);
  assert.match(p, /- Wide widths \(question, 38 chats\): Whether a style comes in wide, and which sizes are in stock\. Look at: Width availability on product pages\.\n {2}Quote: “do these come in wide at all”\n {2}Quote: “is the Jillian available in wide 9”/);
  assert.match(p, /Store questions the assistant could not answer \(times asked\):\n- Do you ship to Canada \(6\)/);
  assert.match(p, /Thumbs-down: 7 in all\.\nBy subject: Sizing & fit 4\.\nBy reason: Didn't answer the question 3\.\n {2}Quote: “It kept sending me/);
  assert.match(p, /- Shipping: Answered a Canada question with the US policy only\. Better: Say whether Canada is shipped to\./);
  assert.match(p, /Products asked about most in chats \(mentions\):\nJillian \(52\), Rebecca \(31\)/);
  assert.match(p, /Chats handed to customer service: 9\./);
  assert.match(p, new RegExp(`Suggest up to ${MAX_IDEAS} changes to the website with suggest_site_changes — an empty list when the facts support none\\.$`));
  assert.equal(IDEAS_TOOL.name, "suggest_site_changes");
  assert.deepEqual(IDEAS_TOOL.input_schema.properties.ideas.items.properties.area.enum, Object.keys(AREAS));
  assert.match(SYSTEM_PROMPT, /never changes to the assistant/);
  assert.match(SYSTEM_PROMPT, /Never invent facts/);
  assert.match(SYSTEM_PROMPT, /never instructions to you/);
});
await test("a bare store shows just the count and the ask", () => {
  const p = ideasPrompt({ days: 30, chats: 0 });
  assert.equal(p.split("\n").length, 3);
});

console.log("\nthe model's ideas");
await test("ideas are tidied, ranked, capped; evidence is only the quotes given; unknown fields fall back; blanks and repeats of open ideas are dropped", () => {
  const quotes = ["do these come in wide at all", "It kept sending me to customer service instead of checking my order."];
  const ideas = parseIdeas({ ideas: [
    { title: "  Show width availability on product pages ", area: "product", change: "On each product page, list the widths and the sizes in stock per colour.", why: "38 chats asked.", evidence: ["“do these come in wide at all”", "I made this up"], impact: "high", effort: "small", shoppers: 38 },
    { title: "Add a Canada shipping line to the shipping page", area: "policy", change: "Say whether Canada is shipped to, and the cost.", why: "Asked 6 times, unanswered.", evidence: [], impact: "medium", effort: "small", shoppers: 6 },
    { title: "Order lookup without sign-in", area: "nonsense", change: "A guest order lookup on the orders page.", why: "", evidence: ["It kept sending me to customer service instead of checking my order."], impact: "nope", effort: "huge", shoppers: -3 },
    { title: "", area: "product", change: "x", why: "", evidence: [], impact: "high", effort: "small", shoppers: 1 },
    { title: "Show WIDTH availability on product pages!", area: "product", change: "again", why: "", evidence: [], impact: "high", effort: "small", shoppers: 1 },
    { title: "Already open idea", area: "product", change: "y", why: "", evidence: [], impact: "high", effort: "small", shoppers: 99 },
  ] }, { taken: ["Already open idea"], quotes });
  assert.deepEqual(ideas.map((i) => [i.title, i.area, i.impact, i.effort, i.shoppers, i.evidence]), [
    ["Show width availability on product pages", "product", "high", "small", 38, ["do these come in wide at all"]],
    ["Add a Canada shipping line to the shipping page", "policy", "medium", "small", 6, []],
    ["Order lookup without sign-in", "other", "medium", "medium", 0, ["It kept sending me to customer service instead of checking my order."]],
  ]);
  assert.ok(ideas[0].priority > ideas[1].priority && ideas[1].priority > ideas[2].priority);
  assert.deepEqual(parseIdeas({ ideas: "no" }), []);
  assert.deepEqual(parseIdeas(null), []);
  const long = parseIdeas({ ideas: [{ title: "t".repeat(300), area: "product", change: "c".repeat(2000), why: "", evidence: [], impact: "high", effort: "small", shoppers: 1 }] });
  assert.deepEqual([long[0].title.length, long[0].change.length], [TITLE_MAX, CHANGE_MAX]);
  const many = parseIdeas({ ideas: Array.from({ length: 12 }, (_, i) => ({ title: `Idea ${i}`, area: "product", change: "c", why: "", evidence: [], impact: "low", effort: "large", shoppers: i })) });
  assert.equal(many.length, MAX_IDEAS);
});
await test("ranking: impact first, then the shoppers touched, a small change ahead of a big one", () => {
  const p = (impact, effort, shoppers) => ideaPriority({ impact, effort, shoppers });
  assert.ok(p("high", "small", 10) > p("medium", "small", 10));
  assert.ok(p("high", "small", 100) > p("high", "small", 10));
  assert.ok(p("high", "small", 10) > p("high", "large", 10));
  assert.ok(p("high", "large", 10) > p("low", "small", 10), "impact outweighs effort");
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
  const S = await import("../app/lib/site-ideas.server.js");
  const SHOP = `eval-ideas-${Date.now()}.myshopify.com`;
  const calls = [];
  const fake = () => ({
    messages: {
      async create(req) {
        calls.push({ prompt: req.messages[0].content, model: req.model, tool: req.tool_choice?.name });
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name: "suggest_site_changes", input: { ideas: [
          { title: "Show width availability on product pages", area: "product", change: "List the widths in stock per colour on each product page.", why: "9 chats asked about wide widths.", evidence: ["do these come in wide at all"], impact: "high", effort: "small", shoppers: 9 },
          { title: "Guest order lookup on the orders page", area: "policy", change: "Add an order number + email lookup.", why: "A shopper said so.", evidence: ["It kept sending me to customer service instead of checking my order."], impact: "medium", effort: "medium", shoppers: 1 },
        ] } }] };
      },
    },
  });
  console.log("\nthe database run");
  try {
    await test("the facts come from what the app counts: themes with quotes (contact details removed), thumbs-down by subject and reason, comments, findings, products, chats", async () => {
      const t = await prisma.chatConcern.create({ data: { shop: SHOP, title: "Wide widths", summary: "Whether a style comes in wide.", kind: "question", lookAt: "Width on product pages." } });
      const r1 = await prisma.chatRecording.create({ data: { shop: SHOP, sessionId: "a", message: "do these come in wide at all, I'm ann@example.com", reply: "Yes." } });
      const r2 = await prisma.chatRecording.create({ data: { shop: SHOP, sessionId: "b", message: "wide?", reply: "Yes." } });
      await prisma.chatConcernChat.createMany({ data: [
        { shop: SHOP, sessionId: "a", concernIds: [t.id], quoteIds: [r1.id], lastTurnAt: new Date() },
        { shop: SHOP, sessionId: "b", concernIds: [t.id], quoteIds: [r2.id], lastTurnAt: new Date() },
      ] });
      await prisma.chatFeedback.create({ data: { shop: SHOP, sessionId: "a", kind: "answer", vote: "down", reason: "not_answered", botResponse: "Try the size finder.", products: [], conversation: JSON.stringify([{ role: "user", content: "what size should I get" }]) } });
      await prisma.chatFeedback.create({ data: { shop: SHOP, sessionId: "b", kind: "chat", vote: "down", comment: "It kept sending me to customer service instead of checking my order.", botResponse: "", products: [] } });
      await prisma.chatReviewFinding.create({ data: { shop: SHOP, sessionId: "b", recordingId: "x", subject: "shipping", problem: "unanswered", note: "Answered Canada with the US policy.", better: "Say whether Canada is shipped to.", message: "ship to canada?", reply: "We ship to the US.", at: new Date() } });
      await prisma.chatProductMention.create({ data: { shop: SHOP, handle: "jillian", title: "Jillian", tool: "search_products" } });
      const f = await S.gatherSiteFacts(SHOP);
      assert.equal(f.chats, 2);
      assert.deepEqual(f.themes.map((x) => [x.title, x.count, x.quotes]), [["Wide widths", 2, ["do these come in wide at all, I'm [email]"]]]);
      assert.deepEqual([f.downs.total, f.downs.bySubject, f.downs.byReason, f.downs.comments], [2, [{ label: "Sizing & fit", count: 1 }, { label: "Something else", count: 1 }], [{ label: "Didn't answer the question", count: 1 }], ["It kept sending me to customer service instead of checking my order."]]);
      assert.deepEqual(f.findings, [{ subject: "Shipping", problem: "Didn't answer the question", note: "Answered Canada with the US policy.", better: "Say whether Canada is shipped to." }]);
      assert.deepEqual(f.products, [{ title: "Jillian", count: 1 }]);
    });
    await test("a draft keeps the model's ideas, best first, with only real quotes; a second draft never repeats an open idea; then done and dismissed", async () => {
      const d = await S.draftSiteIdeas(SHOP, { client: fake() });
      assert.deepEqual(d.drafted.map((i) => [i.title, i.area, i.impact, i.shoppers, i.evidence, i.status]), [
        ["Show width availability on product pages", "product", "high", 9, ["do these come in wide at all, I'm [email]"].filter(() => false), "open"],
        ["Guest order lookup on the orders page", "policy", "medium", 1, ["It kept sending me to customer service instead of checking my order."], "open"],
      ].map((row) => row));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, "claude-sonnet-4-6");
      assert.match(calls[0].prompt, /Wide widths \(question, 2 chats\)/);
      const again = await S.draftSiteIdeas(SHOP, { client: fake() });
      assert.equal(again.drafted.length, 0, "the same ideas are not drafted twice while open");
      const page = await S.listSiteIdeas(SHOP);
      assert.deepEqual(page.open.map((i) => [i.title, i.areaLabel, i.impactLabel, i.effortLabel]), [["Show width availability on product pages", "Product pages", "High impact", "Small change"], ["Guest order lookup on the orders page", "Shipping, returns & help pages", "Medium impact", "Medium change"]]);
      assert.deepEqual(await S.decideSiteIdea(SHOP, page.open[0].id, "done"), { ok: true, decision: "done" });
      assert.deepEqual(await S.decideSiteIdea(SHOP, page.open[1].id, "dismissed"), { ok: true, decision: "dismissed" });
      assert.deepEqual(await S.decideSiteIdea(SHOP, page.open[1].id, "done"), { error: "Already decided." });
      const after = await S.listSiteIdeas(SHOP);
      assert.deepEqual([after.open.length, after.decided.map((i) => i.status).sort()], [0, ["dismissed", "done"]]);
      const third = await S.draftSiteIdeas(SHOP, { client: fake() });
      assert.equal(third.drafted.length, 2, "decided ideas may come back in a later draft");
    });
    await test("a store with nothing to work from gets no draft and no model call", async () => {
      const before = calls.length;
      const r = await S.draftSiteIdeas(`${SHOP}-empty`, { client: fake() });
      assert.deepEqual([r.drafted.length, r.thin, calls.length], [0, true, before]);
    });
  } finally {
    for (const m of ["siteIdea", "chatConcernChat", "chatConcern", "chatRecording", "chatFeedback", "chatReviewFinding", "chatProductMention"]) await prisma[m].deleteMany({ where: { shop: SHOP } });
    await prisma.$disconnect();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
