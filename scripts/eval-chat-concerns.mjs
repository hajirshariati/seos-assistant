// Top shopper issues & questions (top of Test recordings): which chats are
// read, what the model is shown, how its answers are checked, and how
// themes are counted, ranked and quoted. With TEST_DATABASE_URL set, the
// whole read also runs against a migrated Postgres with a stand-in model.
//
// Run: node scripts/eval-chat-concerns.mjs
//      TEST_DATABASE_URL=postgresql://... node scripts/eval-chat-concerns.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { groupSessions } from "../app/lib/chat-recording.js";
import {
  shopperSessions, pendingSessions, chatDigest, spread, keyThemes, themesPrompt, parseProposedThemes, assignPrompt, parseAssignments,
  describePrompt, parseDescription, needsDescribing, rankConcerns, pickQuote, MAX_THEMES, MAX_NEW_THEMES, MIN_CHATS, KIND_LABELS, SYSTEM_PROMPT,
  isButtonMessage, offeredReplies, buttonSet, themeButtonTexts, normalizeMessage, DEFAULT_BUTTON_MESSAGES,
} from "../app/lib/chat-concerns.js";
import { describeExtras } from "../app/lib/chat-recording.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`); }
}

const at = (min) => new Date(Date.UTC(2026, 9, 20, 12, min));
let rowId = 0;
const turn = (sessionId, message, { tester = "", min = 0, reply = "Sure — here are a few.", ok = true, typed = null, extras = "" } = {}) => ({ id: `r${++rowId}`, sessionId, tester, message, reply, ok, typed, extras, createdAt: at(min) });

console.log("\nwhich chats are read");
await test("shopper chats only: testers, the app's Test chat, chats without an id and empty chats are left out", () => {
  const rows = [
    turn("s1", "Do you have wide sandals?"),
    turn("s2", "test", { tester: "Ann" }),
    turn("s3", "hello", { tester: "Test chat" }),
    turn("unknown", "where is my order"),
    turn("s4", "   "),
    turn("s5", "ok", { tester: "" }), turn("s5", "more", { tester: "Bo", min: 1 }),
  ];
  assert.deepEqual(shopperSessions(groupSessions(rows)).map((s) => s.sessionId), ["s1"]);
});
await test("pending: never read, or carried on after it was read", () => {
  const rows = [turn("a", "hi", { min: 1 }), turn("b", "wide?", { min: 2 }), turn("b", "size 9", { min: 9 }), turn("c", "returns?", { min: 3 })];
  const sessions = shopperSessions(groupSessions(rows));
  const links = [{ sessionId: "b", lastTurnAt: at(2) }, { sessionId: "c", lastTurnAt: at(3) }];
  assert.deepEqual(pendingSessions(sessions, links).map((s) => s.sessionId).sort(), ["a", "b"]);
  assert.deepEqual(pendingSessions(sessions, [...links, { sessionId: "a", lastTurnAt: at(1) }, { sessionId: "b", lastTurnAt: at(9) }]), []);
});

console.log("\nonly what shoppers type");
await test("the widget's mark wins: a button's message is skipped, a typed one kept even if it reads like a button", () => {
  const sessions = shopperSessions(groupSessions([
    turn("a", "Help me find my orthotic FIT.", { typed: true }),
    turn("a", "I need wide sandals", { min: 1, typed: false }),
    turn("b", "Show me the most popular Aetrex products.", { typed: false }),
  ]));
  assert.deepEqual(sessions.map((s) => [s.sessionId, s.turns.map((t) => t.message)]), [["a", ["Help me find my orthotic FIT."]]], "a chat with nothing typed isn't read at all");
});
await test("before the mark: the widget's own button lines are skipped", () => {
  const is = (m) => isButtonMessage({ message: m, typed: null });
  for (const m of [
    "Help me find my orthotic FIT.", "help me find my orthotic fit", "I'd like to retake my orthotic FIT.", "I’d like to retake my orthotic FIT.",
    "Show me orthotics in my FIT 2343.", "Help me find my shoe size with True Fit.", "True Fit recommends size 9.5 for me.",
    "True Fit recommends size 8 W for me in the Chase Arch Support Sneaker.",
  ]) assert.equal(is(m), true, m);
  for (const m of ["I need help with my orthotic fit, my arch hurts", "what size should I get in the Chase?", "Where's my order?", "show me orthotics for flat feet"]) assert.equal(is(m), false, m);
});
await test("before the mark: the store's buttons (theme, defaults, seasonal) and the quick replies just offered are skipped", () => {
  const buttons = buttonSet(["Find me shoes for standing all day", "Fall favorites"]);
  const is = (m, extras = "") => isButtonMessage({ message: m, typed: null }, { buttons, offered: offeredReplies(extras) });
  assert.equal(is("Find me shoes for standing all day"), true, "a theme button");
  assert.equal(is("fall favorites"), true, "the seasonal button");
  assert.equal(is("Help me check the status of my order."), true, "a default button");
  assert.equal(is("What's currently on sale?"), true, "an earlier default");
  const extras = describeExtras([{ type: "suggestions", questions: ["Do these come in wide?", "Show me the navy one"] }]);
  assert.equal(is("Do these come in wide?", extras), true, "a quick reply it had just offered");
  assert.equal(is("Do these come in wide?"), false, "typed when nothing offered it");
  assert.equal(is("Find me shoes for standing all day and my heel hurts"), false, "more than the button's words is typed");
});
await test("before the mark: a True Fit shoe tile the reply showed is skipped", () => {
  const extras = describeExtras([{ type: "size_intro", line: "w", lines: [{ k: "w", l: "Women's", tiles: [{ l: "Sneakers" }, { l: "Dress Shoes" }] }] }]);
  const offered = offeredReplies(extras);
  const is = (m) => isButtonMessage({ message: m, typed: null }, { offered });
  assert.equal(is("Show me women's sneakers"), true);
  assert.equal(is("Show me dress shoes"), true);
  assert.equal(is("Show me men's dress shoes"), true);
  assert.equal(is("Show me wide sneakers in 10"), false);
});
await test("a chat's turns are judged against the reply before each one; lastAt is the last typed turn", () => {
  const rows = [
    turn("q", "my feet hurt after work", { min: 0, typed: null, extras: describeExtras([{ type: "suggestions", questions: ["Show me work shoes"] }]) }),
    turn("q", "Show me work shoes", { min: 1, typed: null }),
    turn("q", "Help me find my orthotic FIT.", { min: 2, typed: null }),
  ];
  const [s] = shopperSessions(groupSessions(rows));
  assert.deepEqual(s.turns.map((t) => t.message), ["my feet hurt after work"]);
  assert.equal(s.lastAt.getTime(), at(0).getTime(), "button taps afterwards don't make it new again");
});
await test("the theme's button messages come from the chat's app embed, wherever the theme keeps its settings", () => {
  const block = { type: "shopify://apps/seos-assistant/blocks/hajirai_chat/abc-123", disabled: false, settings: { cta1_message: "Find my fit", qp2_message: " New in ", cta1_label: "Fit", greeting: "Hi" } };
  const other = { type: "shopify://apps/reviews/blocks/stars/1", settings: { cta1_message: "not ours" } };
  assert.deepEqual(themeButtonTexts({ current: { blocks: { a: block, b: other } } }).sort(), ["Find my fit", "New in"]);
  assert.deepEqual(themeButtonTexts({ current: "Default", presets: { Default: { blocks: { a: block } } } }).sort(), ["Find my fit", "New in"]);
  assert.deepEqual(themeButtonTexts(null), []);
});
await test("kept in step with the widget and the theme block: every button line and default is known", () => {
  const widget = readFileSync(new URL("../extensions/hajirai-chat-widget/assets/hajirai-chat-widget.js", import.meta.url), "utf8");
  for (const lit of ["'Help me find my orthotic FIT.'", "'I\\'d like to retake my orthotic FIT.'", "'Show me orthotics in my '", "'Help me find my shoe size with True Fit.'", "'True Fit recommends size '", "' for me'", "' in the '", "data-tfi-ask=\"'+esc('Show me '+word+t.l.toLowerCase())"]) {
    assert.ok(widget.includes(lit), `the widget still sends ${lit} — if it changed, update WIDGET_BUTTON_MESSAGES`);
  }
  assert.ok(widget.includes("body.typed=SENT_TYPED"), "the widget says how each message was sent");
  // Every send goes through a button (BTN_SEND) or is the shopper's own (send button, Enter, voice).
  const sends = widget.split("\n").filter((l) => /sendMessage\(\)/.test(l) && !/^function sendMessage/.test(l));
  for (const l of sends) {
    const own = /sendBtn\.addEventListener\('click'|e\.key==='Enter'|if\(heard\)/.test(l);
    assert.ok(own || /BTN_SEND=/.test(l) || l.trim() === "BTN_SEND=true;sendMessage();", `a send without a mark: ${l.trim().slice(0, 90)}`);
  }
  const liquid = readFileSync(new URL("../extensions/hajirai-chat-widget/blocks/hajirai_chat.liquid", import.meta.url), "utf8");
  const schema = JSON.parse(liquid.match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/)[1]);
  const known = new Set(DEFAULT_BUTTON_MESSAGES.map(normalizeMessage));
  for (const st of schema.settings.filter((x) => /^(?:cta|qp)\d+_message$/.test(x.id) && x.default)) assert.ok(known.has(normalizeMessage(st.default)), st.default);
});

console.log("\nwhat the model is shown");
await test("a chat's shopper messages are numbered, replies cut short, a failed reply says so", () => {
  const s = groupSessions([turn("x", "First question", { reply: "R".repeat(400) }), turn("x", "Second", { min: 1, reply: "", ok: false })])[0];
  const d = chatDigest(s);
  assert.match(d, /1\. Shopper: First question/);
  assert.match(d, /2\. Shopper: Second/);
  assert.match(d, /\(the reply failed\)/);
  assert.ok(!d.includes("R".repeat(200)), "long reply is cut");
  assert.ok(d.includes("…"));
});
await test("theme finding lists tracked themes by key and says how many may be added", () => {
  const themes = [{ id: "A", title: "Wide widths", summary: "Want wide.", kind: "request" }];
  const sessions = groupSessions([turn("x", "Do you have the Chase in wide?")]);
  const p = themesPrompt(themes, sessions);
  assert.match(p, /t1 — Wide widths: Want wide\. \(request\)/);
  assert.match(p, new RegExp(`at most ${MAX_NEW_THEMES}`));
  assert.match(p, /\[1\] Do you have the Chase in wide\?/);
  assert.match(themesPrompt([], sessions), /doesn't track any themes yet/);
  const full = Array.from({ length: MAX_THEMES }, (_, i) => ({ id: `t${i}`, title: `Theme ${i}`, kind: "question" }));
  assert.match(themesPrompt(full, sessions), /at most 0/);
});
await test("issues, needs and questions only: everyday browsing is never a theme, but a need inside it counts", () => {
  const p = themesPrompt([], groupSessions([turn("x", "show me shoes")]));
  assert.match(SYSTEM_PROMPT, /not everyday browsing/);
  for (const example of ["Wide shoes for wide feet", "Wants free shipping", "Order hasn't arrived"]) assert.ok(p.includes(example), example);
  assert.match(p, /Leave out everyday shopping/);
  assert.match(p, /"show me shoes"/);
  assert.match(p, /Those are never themes/);
  assert.match(p, /"sneakers for my wide feet" → wide feet/);
  const a = assignPrompt([{ id: "A", title: "Wide feet", kind: "request" }], groupSessions([turn("x", "show me shoes")]));
  assert.match(a, /only asks to see, find or compare products — gets an empty list/);
  assert.deepEqual(KIND_LABELS, { complaint: "Issue", question: "Question", request: "Need" });
});
await test("assignment shows every chat in [brackets] with its theme keys; describe shows replies", () => {
  const themes = [{ id: "A", title: "Wide widths", kind: "request" }, { id: "B", title: "Order late", kind: "complaint" }];
  const sessions = groupSessions([turn("x", "wide 9?"), turn("y", "my order is late", { min: 1 })]);
  const p = assignPrompt(themes, sessions);
  assert.match(p, /t2 — Order late \(complaint\)/);
  assert.match(p, /\[1\]\n {2}1\. Shopper:/);
  assert.match(p, /all 2 chats/);
  assert.match(describePrompt(themes[1], sessions), /Assistant: Sure/);
});
await test("a spread keeps the first chat and stays within the limit", () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  const s = spread(list, 10);
  assert.equal(s.length, 10);
  assert.equal(s[0], 0);
  assert.deepEqual(spread([1, 2], 10), [1, 2]);
});

console.log("\nthe model's answers are checked");
await test("new themes: repeats of tracked ones dropped (case, punctuation), unknown kind → question, capped by room", () => {
  const existing = [{ title: "Wide widths out of stock" }];
  const out = parseProposedThemes({ themes: [
    { title: "wide widths — out of stock!", summary: "x", kind: "request" },
    { title: "Order hasn't arrived", summary: "Late\npackages", kind: "complaint" },
    { title: "Order hasnt arrived", summary: "dup", kind: "complaint" },
    { title: "Half sizes", summary: "", kind: "worry" },
    { title: "", summary: "no title", kind: "question" },
  ] }, existing);
  assert.deepEqual(out.map((t) => t.title), ["Order hasn't arrived", "Half sizes"]);
  assert.equal(out[0].summary, "Late packages");
  assert.equal(out[1].kind, "question");
  const full = Array.from({ length: MAX_THEMES - 1 }, (_, i) => ({ title: `T${i}` }));
  assert.equal(parseProposedThemes({ themes: [{ title: "A", kind: "question" }, { title: "B", kind: "question" }] }, full).length, 1);
  assert.deepEqual(parseProposedThemes(null, []), []);
});
await test("assignments: bad chat numbers, unknown keys and repeats dropped; bad message → first; skipped chats stay unread", () => {
  const themes = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];
  const sessions = groupSessions([turn("x", "one"), turn("x", "two", { min: 1 }), turn("y", "three", { min: 2 }), turn("z", "four", { min: 3 })]);
  const order = sessions.map((s) => s.sessionId);
  const xi = order.indexOf("x") + 1;
  const yi = order.indexOf("y") + 1;
  const out = parseAssignments({ chats: [
    { chat: xi, themes: [{ theme: "t1", message: 2 }, { theme: "T1", message: 1 }, { theme: "t9", message: 1 }, { theme: "t2", message: 7 }, { theme: "t3", message: 1 }, { theme: "t4", message: 1 }] },
    { chat: yi, themes: [] },
    { chat: 0, themes: [{ theme: "t1", message: 1 }] },
    { chat: 99, themes: [{ theme: "t1", message: 1 }] },
    { chat: xi, themes: [{ theme: "t4", message: 1 }] },
  ] }, themes, sessions);
  assert.deepEqual(out.map((o) => o.sessionId), ["x", "y"], "z was skipped, so it's read again next time");
  const x = out[0];
  const xTurns = sessions.find((s) => s.sessionId === "x").turns;
  assert.deepEqual(x.themes.map((t) => t.id), ["A", "B", "C"], "at most 3, no repeats, unknown key dropped");
  assert.equal(x.themes[0].turnId, xTurns[1].id, "the message the model pointed at");
  assert.equal(x.themes[1].turnId, xTurns[0].id, "an out-of-range message falls back to the first");
  assert.equal(x.lastTurnAt.getTime(), xTurns[1].createdAt.getTime());
  assert.deepEqual(out[1].themes, []);
});
await test("a description keeps the theme's name and falls back to what it had", () => {
  const t = { title: "Wide", summary: "Old", kind: "request" };
  assert.deepEqual(parseDescription({ title: "Renamed", summary: "", look_at: "Restock 9W", kind: "nope" }, t), { summary: "Old", lookAt: "Restock 9W", kind: "request" });
  assert.equal(parseDescription({ summary: "s", look_at: "l", kind: "complaint" }, t).kind, "complaint");
  assert.ok(!/title:/.test(describePrompt(t, [])), "the model isn't asked to rename it");
});
await test("a top theme is described again once it has grown by a quarter (at least 3 chats)", () => {
  assert.equal(needsDescribing({ lookAt: "", describedAt: 0 }, 2), true);
  assert.equal(needsDescribing({ lookAt: "x", describedAt: 4 }, 6), false);
  assert.equal(needsDescribing({ lookAt: "x", describedAt: 4 }, 7), true);
  assert.equal(needsDescribing({ lookAt: "x", describedAt: 40 }, 49), false);
  assert.equal(needsDescribing({ lookAt: "x", describedAt: 40 }, 50), true);
});

console.log("\ncounts, ranking and quotes");
const T = [
  { id: "W", title: "Wide widths", kind: "request", createdAt: at(1) },
  { id: "O", title: "Order late", kind: "complaint", createdAt: at(2) },
  { id: "S", title: "Sizing", kind: "question", createdAt: at(3) },
  { id: "R", title: "Rare", kind: "question", createdAt: at(4) },
];
const L = [
  { sessionId: "a", concernIds: ["W", "S"], quoteIds: ["q1", "q2"], lastTurnAt: at(10) },
  { sessionId: "b", concernIds: ["W"], quoteIds: ["q3"], lastTurnAt: at(30) },
  { sessionId: "c", concernIds: ["O"], quoteIds: ["q4"], lastTurnAt: at(20) },
  { sessionId: "d", concernIds: ["O", "W"], quoteIds: ["q5", "q6"], lastTurnAt: at(40) },
  { sessionId: "e", concernIds: ["S", "R", "GONE"], quoteIds: ["q7", "q8", "q9"], lastTurnAt: at(5) },
  { sessionId: "f", concernIds: [], quoteIds: [], lastTurnAt: at(6) },
];
await test("counted per chat; themes under the minimum left out; ties put complaints first", () => {
  const r = rankConcerns(T, L);
  assert.deepEqual(r.map((t) => [t.id, t.count]), [["W", 3], ["O", 2], ["S", 2]]);
  assert.equal(MIN_CHATS, 2);
  assert.deepEqual(r[0].chats.map((c) => c.sessionId), ["d", "b", "a"], "newest chat first");
  assert.equal(r[0].chats[0].turnId, "q6");
  assert.deepEqual(rankConcerns(T, L, { min: 1 }).map((t) => t.id), ["W", "O", "S", "R"]);
});
await test("the quote is a shopper's own words from the newest kept chat, short ones first", () => {
  const w = rankConcerns(T, L)[0];
  assert.equal(pickQuote(w, new Map([["q3", "Do you have the Chase in 9 wide?"], ["q1", "wide please"]])), "Do you have the Chase in 9 wide?", "q6 (newest) expired, so the next kept one");
  const long = "x".repeat(300);
  assert.equal(pickQuote(w, new Map([["q6", long], ["q3", "short one"]])), "short one");
  assert.equal(pickQuote(w, new Map([["q6", long]])).length, 180);
  assert.equal(pickQuote(w, new Map()), "", "nothing kept, no quote");
});
await test("keys follow the stored order", () => {
  assert.deepEqual(keyThemes(T).map((t) => t.key), ["t1", "t2", "t3", "t4"]);
});

// ── the whole read, against Postgres ──
if (!process.env.TEST_DATABASE_URL) {
  console.log("\n(skipped the database read: set TEST_DATABASE_URL to a migrated test database)");
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
  const C = await import("../app/lib/chat-concerns.server.js");
  const SHOP = `eval-concerns-${Date.now()}.myshopify.com`;
  const OTHER = `eval-concerns-other-${Date.now()}.myshopify.com`;

  // A stand-in model: themes by keyword, chats tagged by keyword.
  const calls = [];
  const fake = ({ failAssign = false, delayMs = 0, status = 0, priceTheme = false } = {}) => ({
    messages: {
      async create(req) {
        const tool = req.tool_choice?.name;
        const prompt = req.messages[0].content;
        calls.push({ tool, prompt, model: req.model });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (status) throw Object.assign(new Error("refused"), { status });
        const answer = (input) => ({ content: [{ type: "tool_use", id: "tu", name: tool, input }], stop_reason: "tool_use" });
        if (tool === "propose_themes") {
          return answer({ themes: [
            { title: "Wide widths out of stock", summary: "Shoppers want wide widths that are sold out.", kind: "request" },
            { title: "Order hasn't arrived", summary: "Packages are late.", kind: "complaint" },
            ...(priceTheme ? [{ title: "Price matching", summary: "Shoppers ask if prices are matched.", kind: "question" }] : []),
          ] });
        }
        if (tool === "assign_chats") {
          if (failAssign) throw Object.assign(new Error("overloaded"), { status: 400 });
          const keys = Object.fromEntries([...prompt.matchAll(/^(t\d+) — ([^:(]+)/gm)].map((m) => [m[2].trim(), m[1]]));
          const chats = [...prompt.matchAll(/^\[(\d+)\]\n([\s\S]*?)(?=\n\n\[|\n\nFor every chat)/gm)].map((m) => {
            const text = m[2];
            const themes = [];
            const msgNo = (re) => Number((text.match(new RegExp(`(\\d+)\\. Shopper: [^\\n]*${re}`, "i")) || [])[1] || 1);
            if (/wide/i.test(text) && keys["Wide widths out of stock"]) themes.push({ theme: keys["Wide widths out of stock"], message: msgNo("wide") });
            if (/arriv|late/i.test(text) && keys["Order hasn't arrived"]) themes.push({ theme: keys["Order hasn't arrived"], message: msgNo("arriv|late") });
            if (/price match/i.test(text) && keys["Price matching"]) themes.push({ theme: keys["Price matching"], message: msgNo("price match") });
            return { chat: Number(m[1]), themes };
          });
          return answer({ chats });
        }
        if (tool === "describe_theme") {
          const wide = /Wide widths/.test(prompt);
          return answer({ summary: wide ? "Shoppers ask for wide sizes that are gone." : "Orders arrive late.", look_at: wide ? "Restock wide sizes." : "Check the carrier.", kind: wide ? "request" : "complaint" });
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    },
  });
  const rec = (sessionId, message, { tester = "", minutesAgo = 60, shop = SHOP, typed = null } = {}) => prisma.chatRecording.create({
    data: { shop, sessionId, tester, typed, message, reply: "Here's what I found.", products: [], createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
  const summary = async () => C.concernSummary(SHOP, groupSessions(await prisma.chatRecording.findMany({ where: { shop: SHOP } })));
  const cleanup = async () => {
    for (const shop of [SHOP, OTHER]) {
      await prisma.chatRecording.deleteMany({ where: { shop } });
      await C.resetConcerns(shop);
    }
  };

  console.log("\nthe whole read (database)");
  try {
    await rec("w1", "Do you have the Chase in wide 9?", { minutesAgo: 300 });
    await rec("w1", "ok what about black", { minutesAgo: 299 });
    await rec("w2", "hi", { minutesAgo: 200 });
    await rec("w2", "Any wide sandals in 10?", { minutesAgo: 199 });
    await rec("o1", "My order still hasn't arrived", { minutesAgo: 150 });
    await rec("o2", "It's late again, where is it", { minutesAgo: 100 });
    await rec("b1", "show me sneakers", { minutesAgo: 90 });
    await rec("t1", "wide wide wide tester", { tester: "Ann", minutesAgo: 80 });
    await rec("t2", "wide test chat", { tester: "Test chat", minutesAgo: 70 });
    await rec("x1", "wide in another store", { shop: OTHER, minutesAgo: 60 });

    await test("one read: themes found, every shopper chat tagged, top themes described; testers never sent", async () => {
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake() });
      assert.equal(C.concernRunState(SHOP).running, true);
      assert.equal(C.startConcernRead(SHOP, { client: fake() }).running, true, "a second start joins the running read");
      await C.settleConcernRead(SHOP);
      const st = C.concernRunState(SHOP);
      assert.equal(st.running, false);
      assert.equal(st.error, "");
      assert.equal(st.done, 5);
      assert.deepEqual(calls.map((c) => c.tool), ["propose_themes", "assign_chats", "describe_theme", "describe_theme"]);
      assert.ok(calls.every((c) => !/tester|test chat|another store/i.test(c.prompt)), "testers' chats and other stores never reach the model");
      assert.ok(calls.every((c) => c.model === "claude-sonnet-4-6"));
      const s = await summary();
      assert.equal(s.read, 5);
      assert.equal(s.pending, 0);
      assert.deepEqual(s.top.map((t) => [t.title, t.count, t.kind]), [["Order hasn't arrived", 2, "complaint"], ["Wide widths out of stock", 2, "request"]], "tie: the complaint first");
      const wide = s.top[1];
      assert.equal(wide.summary, "Shoppers ask for wide sizes that are gone.");
      assert.equal(wide.lookAt, "Restock wide sizes.");
      assert.equal(wide.share, 2 / 5);
      assert.ok(["Do you have the Chase in wide 9?", "Any wide sandals in 10?"].includes(wide.quote), `verbatim quote, got: ${wide.quote}`);
      assert.deepEqual([...wide.sessionIds].sort(), ["w1", "w2"]);
      assert.equal((await prisma.chatConcernChat.count({ where: { shop: OTHER } })), 0);
    });
    await test("nothing new: no model calls", async () => {
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake() });
      await C.settleConcernRead(SHOP);
      assert.equal(calls.length, 0);
    });
    await test("a chat that carries on is read again, alone, and its themes replaced", async () => {
      await rec("b1", "actually I need them in wide", { minutesAgo: 10 });
      assert.equal((await summary()).pending, 1);
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake() });
      await C.settleConcernRead(SHOP);
      const assign = calls.filter((c) => c.tool === "assign_chats");
      assert.equal(assign.length, 1);
      assert.equal((assign[0].prompt.match(/^\[\d+\]$/gm) || []).length, 1, "only the chat that carried on");
      const s = await summary();
      assert.deepEqual(s.top.map((t) => [t.count, t.kind]), [[3, "request"], [2, "complaint"]]);
      assert.equal(s.read, 5, "still five chats");
      assert.equal(await prisma.chatConcern.count({ where: { shop: SHOP } }), 2, "the same themes again aren't added twice");
    });
    await test("the page's own reads wait 30 minutes between them; Refresh doesn't", async () => {
      await rec("n1", "wide 11?", { minutesAgo: 5 });
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake(), auto: true });
      await C.settleConcernRead(SHOP);
      assert.ok(calls.length > 0, "the first page read runs");
      await rec("n2", "wide 12?", { minutesAgo: 4 });
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake(), auto: true });
      await C.settleConcernRead(SHOP);
      assert.equal(calls.length, 0, "a second page read inside 30 minutes doesn't");
      C.startConcernRead(SHOP, { client: fake() });
      await C.settleConcernRead(SHOP);
      assert.ok(calls.length > 0, "Refresh reads at once");
      assert.equal((await summary()).pending, 0);
    });
    await test("a failed read says why in plain words and leaves the chats to read again", async () => {
      await rec("e1", "wide 8?", { minutesAgo: 3 });
      C.startConcernRead(SHOP, { client: fake({ status: 401 }) });
      await C.settleConcernRead(SHOP);
      assert.equal(C.concernRunState(SHOP).error, "Claude refused the API key. Check it in Settings → API keys.");
      C.startConcernRead(SHOP, { client: fake({ failAssign: true }) });
      await C.settleConcernRead(SHOP);
      assert.equal(C.concernRunState(SHOP).error, "Couldn't read the chats just now. Try again.");
      assert.equal((await summary()).pending, 1, "still waiting to be read");
      assert.equal(C.readError({ status: 529 }), "Claude is busy right now. Try again in a few minutes.");
    });
    await test("counts last after the recordings expire; quotes and View chats go with them", async () => {
      const before = (await summary()).top.map((t) => [t.id, t.count]);
      await prisma.chatRecording.deleteMany({ where: { shop: SHOP, sessionId: { in: ["o1", "o2"] } } });
      const s = await summary();
      assert.deepEqual(s.top.map((t) => [t.id, t.count]), before);
      const late = s.top.find((t) => t.kind === "complaint");
      assert.equal(late.quote, "");
      assert.deepEqual(late.sessionIds, []);
    });
    await test("a deleted chat no longer counts — even one deleted while a read is running", async () => {
      const wide = (await summary()).top.find((t) => t.kind === "request");
      await C.forgetConcernChat(SHOP, "w1");
      assert.equal((await summary()).top.find((t) => t.id === wide.id).count, wide.count - 1);
      await rec("d1", "wide 7 please", { minutesAgo: 2 });
      C.startConcernRead(SHOP, { client: fake({ delayMs: 300 }) });
      await new Promise((r) => setTimeout(r, 50));
      await prisma.chatRecording.deleteMany({ where: { shop: SHOP, sessionId: "d1" } });
      await C.forgetConcernChat(SHOP, "d1");
      await C.settleConcernRead(SHOP);
      assert.equal(await prisma.chatConcernChat.count({ where: { shop: SHOP, sessionId: "d1" } }), 0);
    });
    await test("a chat that raised no theme is read again when a new theme comes up, so a need asked once a day still counts", async () => {
      await rec("p1", "Do you price match?", { minutesAgo: 2 });
      C.startConcernRead(SHOP, { client: fake() });
      await C.settleConcernRead(SHOP);
      const link = await prisma.chatConcernChat.findUnique({ where: { shop_sessionId: { shop: SHOP, sessionId: "p1" } } });
      assert.deepEqual(link.concernIds, [], "no theme for it yet");
      await rec("p2", "Will you price match another site?", { minutesAgo: 1 });
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake({ priceTheme: true }) });
      await C.settleConcernRead(SHOP);
      assert.match(calls[0].prompt, /Do you price match\?/, "theme finding sees the earlier chat too");
      const price = (await summary()).top.concat((await summary()).more).find((t) => t.title === "Price matching");
      assert.ok(price, "the new theme shows");
      assert.equal(price.count, 2, "both chats count");
    });
    await test("button taps never reach the model, and a chat with only taps isn't counted", async () => {
      const before = (await summary()).read;
      await rec("k1", "Help me find my orthotic FIT.", { minutesAgo: 2 });
      await rec("k1", "Show me the most popular Aetrex products.", { minutesAgo: 1, typed: false });
      await rec("k2", "I need wide shoes for work", { minutesAgo: 2, typed: false });
      await rec("k2", "is the arch support firm?", { minutesAgo: 1, typed: true });
      calls.length = 0;
      C.startConcernRead(SHOP, { client: fake() });
      await C.settleConcernRead(SHOP);
      const sent = calls.map((c) => c.prompt).join("\n");
      assert.ok(!/orthotic FIT|most popular|wide shoes for work/.test(sent), "no button's words were sent");
      assert.ok(/arch support firm/.test(sent), "what was typed was");
      const s = await summary();
      assert.equal(s.read, before + 1, "only the chat with something typed counts");
      assert.equal(s.pending, 0);
      assert.equal(await prisma.chatConcernChat.count({ where: { shop: SHOP, sessionId: "k1" } }), 0);
    });
    await test("the store's buttons are read from the live theme, with the defaults and the seasonal label; a failed read falls back", async () => {
      const settings = `/* auto-generated */ ${JSON.stringify({ current: { blocks: { x: { type: "shopify://apps/seos/blocks/hajirai_chat/1", settings: { cta2_message: "Find shoes for my bunions" } } } } })}`;
      const asked = [];
      const admin = { graphql: async (q, opts) => {
        asked.push(opts?.variables || null);
        const body = /themes\(first: 1/.test(q) ? { data: { themes: { nodes: [{ id: "gid://shopify/OnlineStoreTheme/9" }] } } } : { data: { theme: { files: { nodes: [{ body: { content: settings } }] } } } };
        return { json: async () => body };
      } };
      const texts = await C.storeButtonTexts(`btn-${Date.now()}.myshopify.com`, { admin, config: { seasonalCtaLabel: "Fall Favorites" } });
      assert.ok(texts.has("find shoes for my bunions"), "the theme's own button");
      assert.ok(texts.has("fall favorites"), "the seasonal button");
      assert.ok(texts.has("help me check the status of my order."), "the defaults");
      assert.deepEqual(asked[1], { id: "gid://shopify/OnlineStoreTheme/9" });
      const broken = { graphql: async () => { throw new Error("Access denied for themes"); } };
      const fallback = await C.storeButtonTexts(`btn2-${Date.now()}.myshopify.com`, { admin: broken });
      assert.ok(fallback.has("help me find the right aetrex shoe size and fit."));
    });
    await test("Delete all starts over, and a read in progress writes nothing after it", async () => {
      await rec("z1", "wide again", { minutesAgo: 2 });
      C.startConcernRead(SHOP, { client: fake({ delayMs: 300 }) });
      await new Promise((r) => setTimeout(r, 50));
      await C.resetConcerns(SHOP);
      assert.equal(C.concernRunState(SHOP).running, false);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(await prisma.chatConcern.count({ where: { shop: SHOP } }), 0);
      assert.equal(await prisma.chatConcernChat.count({ where: { shop: SHOP } }), 0);
      const s = await summary();
      assert.equal(s.read, 0);
      assert.deepEqual(s.top, []);
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
