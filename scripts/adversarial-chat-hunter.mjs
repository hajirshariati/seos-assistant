#!/usr/bin/env node

// Adversarial chat hunter. Spawns AI customer agents that try to break
// the live /chat endpoint, judges each turn, tags failures by seam, and
// appends every break to a JSON file as a future regression test.
//
// USAGE
//   ANTHROPIC_API_KEY=... \
//   CHAT_TRANSCRIPT_BASE_URL=https://...up.railway.app \
//   SHOPIFY_API_SECRET=... \
//     node scripts/adversarial-chat-hunter.mjs --convos=5 --concurrency=2
//
// FLAGS
//   --convos=N          Number of conversations to run (default 50)
//   --concurrency=N     Parallel convos (default 4)
//   --min-turns=N       Minimum customer turns per convo (default 4)
//   --max-turns=N       Maximum customer turns per convo (default 7)
//   --output=PATH       Where to write broken-convo JSON (default reports/broken-convos.json)
//   --report=PATH       Where to write cluster report (default reports/cluster-report.md)
//   --verbose           Log every turn
//   --persona=NAME      Only run a specific persona (default: rotate all)
//
// COST
//   Per convo: 5-7 turns × (customer Sonnet ~$0.005 + live chat ~$0.02 + judge Haiku ~$0.002)
//   ≈ $0.15-0.25 per convo. 500 convos ≈ $75-125.

import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------- args ----------
const args = process.argv.slice(2);
const arg = (k, d) => {
  const p = `--${k}=`;
  const v = args.find((a) => a.startsWith(p));
  return v ? v.slice(p.length) : d;
};
const flag = (k) => args.includes(`--${k}`);

const NUM_CONVOS = parseInt(arg("convos", "50"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "1"), 10);
const INTER_TURN_DELAY_MS = parseInt(arg("turn-delay-ms", "1500"), 10);
const MAX_RATE_LIMIT_RETRIES = parseInt(arg("rate-limit-retries", "3"), 10);
const MIN_TURNS = parseInt(arg("min-turns", "4"), 10);
const MAX_TURNS = parseInt(arg("max-turns", "7"), 10);
const OUTPUT = path.resolve(ROOT, arg("output", "reports/broken-convos.json"));
const REPORT = path.resolve(ROOT, arg("report", "reports/cluster-report.md"));
const VERBOSE = flag("verbose");
const ONLY_PERSONA = arg("persona", null);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const CUSTOMER_MODEL = process.env.CUSTOMER_MODEL || "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-haiku-4-5-20251001";

// ---------- request signing (mirrors eval-chat-transcripts.mjs) ----------
function signAppProxyParams(params, secret) {
  const pairs = [...params.entries()]
    .filter(([key]) => key !== "signature" && key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function buildSignedChatUrl() {
  const provided = process.env.CHAT_TRANSCRIPT_URL;
  if (provided) return provided;
  const base = process.env.CHAT_TRANSCRIPT_BASE_URL;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!base || !secret) throw new Error("Set CHAT_TRANSCRIPT_BASE_URL + SHOPIFY_API_SECRET");
  const url = new URL(process.env.CHAT_TRANSCRIPT_PATH || "/chat", base);
  const params = new URLSearchParams();
  params.set("shop", process.env.CHAT_TRANSCRIPT_SHOP || "f031fc-3.myshopify.com");
  params.set("logged_in_customer_id", process.env.CHAT_TRANSCRIPT_CUSTOMER_ID || "");
  params.set("path_prefix", process.env.CHAT_TRANSCRIPT_PREFIX || "/apps/hajirai");
  params.set("timestamp", String(Math.floor(Date.now() / 1000)));
  params.set("signature", signAppProxyParams(params, secret));
  url.search = params.toString();
  return url.toString();
}

function parseSse(raw) {
  const events = [];
  for (const chunk of String(raw || "").split(/\n\n+/)) {
    const lines = chunk.split(/\n/).filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data:\s?/, ""));
    if (!lines.length) continue;
    const payload = lines.join("\n").trim();
    if (!payload) continue;
    try { events.push(JSON.parse(payload)); }
    catch (err) { events.push({ type: "parse_error", raw: payload, error: err?.message }); }
  }
  return events;
}

function visiblePayload(events) {
  const text = events.filter((e) => e?.type === "text").map((e) => String(e.text || "")).join("\n").trim();
  let products = [];
  const links = [], suggestions = [], errors = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "products") products = Array.isArray(e.products) ? e.products : products;
    if (e.type === "link") links.push({ url: e.url || "", label: e.label || "" });
    if (e.type === "suggestions") suggestions.push(...(Array.isArray(e.questions) ? e.questions : []));
    if (e.type === "error") errors.push(e.message || e.error || "unknown");
  }
  return { text, products, links, suggestions, errors, events };
}

async function postTurn({ message, history, sessionId }) {
  const url = buildSignedChatUrl();
  const shop = new URL(url).searchParams.get("shop") || "f031fc-3.myshopify.com";
  const body = {
    message,
    session_id: sessionId,
    shop_domain: shop,
    assistant_name: process.env.CHAT_TRANSCRIPT_ASSISTANT_NAME || "The Fit Concierge",
    // Same shape the storefront widget sends: cards shown under each reply ride along.
    history: history.slice(-20).map((m) => ({ role: m.role, content: m.content, ...(m.products?.length ? { products: m.products } : {}) })),
  };

  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (res.ok) return visiblePayload(parseSse(raw));

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      let waitSec = 35;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.retryAfter) waitSec = Math.max(5, Math.min(120, Number(parsed.retryAfter) + 2));
      } catch { /* keep default */ }
      const headerWait = parseInt(res.headers.get("retry-after") || "", 10);
      if (Number.isFinite(headerWait) && headerWait > 0) waitSec = Math.max(waitSec, headerWait + 2);
      attempt++;
      console.log(`  [rate-limited] sleeping ${waitSec}s (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})…`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
}

// ---------- personas ----------
// Each persona has: name, opening (first message), goal (what the customer wants),
// strategy (how they evolve over turns), traps (things they'll try to break).
const PERSONAS = [
  // ── Multi-topic sessions: footwear ⇄ orthotics, several people, returning to earlier items ──
  {
    name: "shoes-orthotics-shoes",
    opening: "i need comfortable women's sneakers for walking",
    goal: "One session: sneakers, then orthotics for them, then back to the SAME sneakers. The bot must keep each topic's facts straight.",
    strategy: "Turn 2 'do you also have orthotics? i have plantar fasciitis'. Answer any orthotic questions briefly (women's, everyday sneakers, medium arch). Then 'ok back to the sneakers you showed first — the second one, does it come in wide?'. Then 'and in black?'.",
  },
  {
    name: "two-people-two-topics",
    opening: "sandals for me, i'm a women's 8",
    goal: "Shop for self then husband then back to self. Each person's line (women's/men's) must never leak into the other's products.",
    strategy: "Turn 2 'now my husband needs sneakers, he's a 10.5'. Turn 3 'and orthotics for him for those sneakers'. Turn 4 'back to my sandals, anything in navy?'. Turn 5 'what size did i say i was?'.",
  },
  {
    name: "orthotic-then-matching-shoe",
    opening: "which orthotic is best for flat feet? it's for me, a man",
    goal: "Orthotic first, then a shoe that fits it, then a question tying the two together.",
    strategy: "Answer the orthotic questions. Then 'what sneakers would that orthotic fit in?'. Then 'will it fit in the first one you showed?'. Then 'ok what about sandals instead'.",
  },
  {
    name: "topic-whiplash",
    opening: "do you have red wedges?",
    goal: "Rapid topic changes; every answer must address the LATEST request, not an earlier one.",
    strategy: "Turn 2 'what's your return policy'. Turn 3 'orthotics for heel pain?'. Turn 4 'nevermind, the wedges — any in black?'. Turn 5 'is the first wedge you showed on sale?'.",
  },
  {
    name: "confused-first-timer",
    opening: "hi i need new shoes",
    goal: "Browse vaguely. Doesn't know category, size, or gender. Replies short.",
    strategy: "Stay vague. If asked 'what type?', say 'i don't know'. If shown products, ask 'do you have anything cheaper?' or 'something else'.",
  },
  {
    name: "gender-pivot-shopper",
    opening: "looking for women's black sandals",
    goal: "Verify gender pivot keeps category and color.",
    strategy: "Turn 2 say 'how about mens?'. Turn 3 ask 'any in size 10?'. Turn 4 say 'actually back to women's'.",
  },
  {
    name: "color-iteration",
    opening: "i want sneakers for women",
    goal: "Iterate colors rapidly to test scope memory.",
    strategy: "Turn 2 'any in pink?'. Turn 3 'red?'. Turn 4 'actually do you have purple?'. Turn 5 'show me all of them'.",
  },
  {
    name: "foot-pain-orthotic",
    opening: "my feet hurt at the end of the day",
    goal: "Trigger orthotic flow, then jump out mid-flow.",
    strategy: "Answer the first orthotic question. Then turn 3 say 'wait do you have men's sneakers too?'. Then turn 4 'ok back to orthotics'.",
  },
  {
    name: "gift-shopper-pivot",
    opening: "shopping for a gift for my mom",
    goal: "Multiple gender pivots from gift framing.",
    strategy: "Turn 2 'actually for my dad'. Turn 3 'wait for my teenage daughter'. Turn 4 'show me everything'.",
  },
  {
    name: "size-grilling",
    opening: "do you have women's sneakers in size 9 wide?",
    goal: "Test size/width handling.",
    strategy: "Turn 2 'what about size 10?'. Turn 3 'do you have 11 narrow?'. Turn 4 'what's your widest width'.",
  },
  {
    name: "policy-mixed-shopper",
    opening: "do you ship to Canada? also show me men's boots",
    goal: "Mix policy + product questions.",
    strategy: "Turn 2 'what's your return policy and do you have these in brown?'. Turn 3 'any discount codes?'.",
  },
  {
    name: "typo-storm",
    opening: "wmens sandls in blak",
    goal: "Hammer with typos.",
    strategy: "Every message has typos. 'how abot mens snekrs'. 'whats your retrn policy'. 'i nee sze 8'. Test typo resilience.",
  },
  {
    name: "spanish-mix",
    opening: "hola, busco sandalias para mujer",
    goal: "Switch between Spanish and English.",
    strategy: "Turn 2 in English 'do you have black?'. Turn 3 'en color rojo?'. Turn 4 'tambien para hombre'.",
  },
  {
    name: "comparison-shopper",
    opening: "show me women's running sneakers",
    goal: "Ask to compare specific products.",
    strategy: "Turn 2 'compare the first two'. Turn 3 'which is better for flat feet?'. Turn 4 'is the second one waterproof?'.",
  },
  {
    name: "rejector",
    opening: "i need men's loafers",
    goal: "Reject every option to test no-match handling.",
    strategy: "Each turn say 'not those, anything else?' or 'i don't like any of these'. After 4 turns say 'fine show me what you have in any color'.",
  },
  {
    name: "scope-creep",
    opening: "i want women's sandals",
    goal: "Pile constraints until impossible.",
    strategy: "Turn 2 'in pink'. Turn 3 'size 11 wide'. Turn 4 'with arch support'. Turn 5 'under $50'. Turn 6 'do you have any?'.",
  },
  {
    name: "out-of-scope",
    opening: "hi! what's the weather like in NYC today?",
    goal: "Off-topic baiting.",
    strategy: "Turn 2 'lol ok then tell me a joke'. Turn 3 'whatever, do you sell socks?'. Turn 4 'what's 2+2'. Test out-of-domain handling.",
  },
  {
    name: "ambiguous-pronoun",
    opening: "do you have it in black?",
    goal: "No referent. Force chatbot to ask for clarification.",
    strategy: "Turn 2 'the thing'. Turn 3 'you know what i mean'. Turn 4 'the sandals'. Test ambiguity handling.",
  },
  {
    name: "single-word",
    opening: "shoes",
    goal: "Minimal input each turn.",
    strategy: "Reply only 1-2 words. 'mens'. 'black'. 'size 10'. 'cheaper'. Test short-input handling.",
  },
  {
    name: "chip-masher",
    opening: "show me men's sneakers",
    goal: "Only ever tap the bot's own quick-reply buttons. Tests whether the chips the bot suggests are actually answerable.",
    strategy: "EVERY turn, pick one of the quick-reply buttons the bot just offered and reply with its EXACT text. Never type your own question. If no quick replies were offered, reply 'show me more'. Keep tapping whatever it suggests, turn after turn. The whole point is to see if the bot can answer the questions it suggests.",
  },
  {
    name: "chip-masher-orthotic",
    opening: "i have foot pain",
    goal: "Tap only quick replies, starting from the orthotic/foot-pain path.",
    strategy: "EVERY turn, reply with the EXACT text of one of the quick-reply buttons the bot offered. Never invent your own message. If none offered, reply 'what else'. Follow the bot's own suggestions wherever they lead and check it can deliver on each one.",
  },
  {
    name: "orthotic-freetext-condition",
    opening: "the bottom of my heel kills me first thing in the morning",
    goal: "Go through the orthotic flow answering every question in natural free text, never tapping a chip. Reach a grounded recommendation with no internal enum tokens (no underscores, no q_ ids) in any reply.",
    strategy: "Always answer in your own words, never the exact chip label. If asked about arch, say 'pretty high arches I think'. If asked how you'll use them, say 'mostly walking around all day at work'. If asked about activity, 'I'm on my feet on hard floors'. Watch for any weird code-like words (overpronation_flat_feet, comfort_walking_everyday, q_arch) — those are bugs.",
  },
  {
    name: "orthotic-uncovered-condition",
    opening: "i need a custom orthotic for my severe diabetic neuropathy and a leg-length discrepancy",
    goal: "Push the orthotic flow toward a condition the catalog likely does NOT cover. The bot must give an honest no-match / see-a-specialist answer, never invent a product or loop.",
    strategy: "Insist on the unusual medical need. Turn 2 'it has to be a prescription medical device'. Turn 3 'so do you have one or not?'. Turn 4 'what would you actually recommend then'. The bot must be honest about limits, not fabricate.",
  },
  {
    name: "orthotic-midflow-jump",
    opening: "i think i need orthotics, my arches ache",
    goal: "Start the orthotic flow, jump to a shopping question mid-flow, then return — the flow must resume where it left off, not restart or lose state.",
    strategy: "Answer the first orthotic question. Turn 3 abruptly ask 'wait, do you also have women's sneakers in black?'. Turn 4 'ok that's cool, anyway back to the orthotics'. Check it resumes the orthotic questions instead of re-asking from the top.",
  },
  {
    name: "orthotic-vague-answers",
    opening: "my feet just feel tired and achy",
    goal: "Answer every orthotic question vaguely/uncertainly. The bot must not re-ask the same question repeatedly and must still reach a sensible recommendation or honest browse.",
    strategy: "Be unsure on everything. 'I'm not really sure about my arches'. 'I guess just normal walking?'. 'I dunno, whatever you think'. The bot should infer sensibly or advance, never loop the same question.",
  },
  {
    name: "orthotic-condition-switch",
    opening: "i have plantar fasciitis",
    goal: "Change the stated condition mid-flow. The bot must follow the new condition cleanly, not blend the two or keep the stale one.",
    strategy: "Answer one question. Turn 3 'actually it's not the heel, it's ball-of-foot pain / metatarsal'. Turn 4 'and it's for running, not walking'. Check the recommendation reflects the LATEST condition + use, with no stale carryover and no enum leaks.",
  },
  {
    name: "category-question",
    opening: "what categories do you carry?",
    goal: "Probe catalog truthfulness.",
    strategy: "Turn 2 'do you carry slippers?'. Turn 3 'mens slippers?'. Turn 4 'kids sandals?'. Trick: ask about categories the store might not carry.",
  },
  {
    name: "specific-product",
    opening: "do you have the Lynco L420?",
    goal: "Specific SKU/model lookup.",
    strategy: "Turn 2 'how about the L425?'. Turn 3 'whats the difference?'. Turn 4 'is it for men or women?'.",
  },
  {
    name: "reset-pivot",
    opening: "show me black sandals for women",
    goal: "Explicit reset mid-convo.",
    strategy: "Turn 2 'never mind, start over'. Turn 3 'i actually want orthotics for plantar fasciitis'. Turn 4 'wait show me sandals again'.",
  },
  {
    name: "sarcastic-impatient",
    opening: "let me see your bestsellers",
    goal: "Push back hard on every answer.",
    strategy: "Turn 2 'those are ugly, anything else'. Turn 3 'are you sure thats all you have'. Turn 4 'why are these so expensive'. Maintain attitude.",
  },
  {
    name: "ambiguous-category",
    opening: "i need something comfortable for walking",
    goal: "Vague category that could match sneakers, walking shoes, orthotics.",
    strategy: "Don't specify category. Turn 2 'something supportive'. Turn 3 'for long walks'. Test how it disambiguates.",
  },
];

// ---------- customer agent ----------
async function nextCustomerMessage(persona, history, turnIndex, availableSuggestions = []) {
  if (turnIndex === 0) return persona.opening;
  const chips = Array.isArray(availableSuggestions) ? availableSuggestions.filter(Boolean) : [];
  const chipBlock = chips.length
    ? `\nThe chatbot offered these quick-reply buttons:\n${chips.map((c) => `- ${c}`).join("\n")}\nIf your strategy says to tap a quick reply, reply with the EXACT text of one of these buttons, verbatim.\n`
    : "";
  const system = `You are roleplaying a real online shopper testing a footwear store's chatbot. Stay in character.

PERSONA: ${persona.name}
GOAL: ${persona.goal}
STRATEGY: ${persona.strategy}
${chipBlock}
Reply with ONLY the next thing the customer would type. No quotes, no explanation. Keep it short (1-2 sentences max). Make it sound like a real lowercase chat message, typos included if your persona has them.

The chatbot just said:
"""${history[history.length - 1].content.slice(0, 1500)}"""

What does the customer type next?`;

  const resp = await anthropic.messages.create({
    model: CUSTOMER_MODEL,
    max_tokens: 120,
    system,
    messages: [{ role: "user", content: "Reply as the customer (1-2 sentences, lowercase, in character)." }],
  });
  const text = resp.content?.[0]?.text?.trim() || "";
  return text.replace(/^["']|["']$/g, "").slice(0, 400);
}

// ---------- judge: structural detectors (free, fast) ----------
const ENUM_LEAK_RE = /\b(overpronation_flat_feet|athletic_training_sports|q_arch|q_gender|q_category|q_use_case|q_condition|memory_foam_arch|plantar_fasciitis_arch|flat_low_arch|high_arch_neutral)\b/i;
const DENIAL_RE = /\b(we (?:don'?t|do not|cannot|can'?t) (?:have|carry|sell|stock|offer)|sorry,? (?:we |I |I'?m )?(?:don'?t|do not|can'?t|cannot) (?:have|carry|stock|offer|find)|no (?:matches|results|products|items|options) (?:available|found|in stock)|out of stock|none available|not (?:available|in stock|in our catalog))\b/i;
const CHIP_RE = /<<\s*([^<>|]+?)\s*>>/g;
const SKU_RE = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;
const POOR_REQUEST_RE = /\b(what (?:type|category|kind|sort) (?:are you|of (?:shoe|footwear|product))|which category|browse our (?:categories|sections))\b/i;
const APOLOGY_RE = /^(i'?m sorry|sorry,?|apolog)/i;

function structuralBugs({ payload, lastUserMessage, fullHistory }) {
  const bugs = [];
  const { text, products, errors, suggestions } = payload;
  const lowerText = (text || "").toLowerCase();

  if (errors.length > 0) bugs.push({ seam: "backend-error", detail: errors.join(" | ") });
  if (!text && (!products || products.length === 0) && suggestions.length === 0)
    bugs.push({ seam: "empty-response", detail: "no text, no products, no suggestions" });
  if (text && text.length > 2500) bugs.push({ seam: "runaway-length", detail: `length=${text.length}` });
  if (ENUM_LEAK_RE.test(text || "")) bugs.push({ seam: "enum-leak", detail: text.match(ENUM_LEAK_RE)[0] });
  if (DENIAL_RE.test(text || "") && products && products.length > 0)
    bugs.push({ seam: "false-denial-with-pool", detail: `pool=${products.length} but denial in text` });

  const chips = [...((text || "").matchAll(CHIP_RE))].map((m) => m[1].trim());
  if (chips.length > 0 && products && products.length > 0) {
    const looksLikeCategoryQuestion = POOR_REQUEST_RE.test(text || "") || chips.some((c) => /\b(sneaker|sandal|boot|loafer|clog|orthotic|footwear)\b/i.test(c));
    if (looksLikeCategoryQuestion) bugs.push({ seam: "chip-card-contradiction", detail: `${products.length} cards but chips=${JSON.stringify(chips.slice(0, 4))}` });
  }

  if (products && products.length > 0) {
    const titles = products.map((p) => `${p.title || ""} ${p.handle || ""}`.toLowerCase());
    const skusInPool = new Set(titles.flatMap((t) => (t.match(SKU_RE) || []).map((s) => s.toUpperCase())));
    const skusInText = [...(text || "").matchAll(SKU_RE)].map((m) => m[0].toUpperCase());
    const orphan = skusInText.filter((s) => !skusInPool.has(s));
    if (orphan.length > 0) bugs.push({ seam: "hallucinated-sku", detail: orphan.join(",") });
  }

  // gender contradiction: user explicitly said 'women' last 2 turns, products are men
  const recentUser = fullHistory.filter((m) => m.role === "user").slice(-2).map((m) => m.content.toLowerCase()).join(" ");
  if (/\b(women|women'?s|woman|female|ladies|girls?)\b/.test(recentUser) && !/\b(men|men'?s|man|male|guys?|boys?|dad|husband|brother|son|him|he)\b/.test(recentUser)) {
    const menCards = (products || []).filter((p) => /\bmen'?s?\b/i.test(p.title || "")).length;
    if (menCards > 0 && menCards === products.length) bugs.push({ seam: "wrong-gender-cards", detail: `asked women, all ${menCards} cards are men` });
  }
  if (/\b(men|men'?s|man|male|guys?|boys?|dad|husband|brother)\b/.test(recentUser) && !/\b(women|women'?s|woman|female|ladies|girls?|mom|wife|sister|daughter|her|she)\b/.test(recentUser)) {
    const womenCards = (products || []).filter((p) => /\bwomen'?s?\b/i.test(p.title || "")).length;
    if (womenCards > 0 && womenCards === products.length) bugs.push({ seam: "wrong-gender-cards", detail: `asked men, all ${womenCards} cards are women` });
  }

  // chatbot asked "what type?" when user JUST said a specific category in the same convo
  if (POOR_REQUEST_RE.test(text || "")) {
    const userTextAll = fullHistory.filter((m) => m.role === "user").map((m) => m.content.toLowerCase()).join(" ");
    const categoriesNamed = ["sneaker", "sandal", "boot", "loafer", "slipper", "clog", "wedge", "heel", "flat"].filter((c) => new RegExp(`\\b${c}s?\\b`).test(userTextAll));
    if (categoriesNamed.length > 0) bugs.push({ seam: "category-asked-after-named", detail: `user said ${categoriesNamed.join(",")} but bot asked for category` });
  }

  return bugs;
}

// ---------- judge: subtle bugs (LLM, called only when structural is clean) ----------
async function llmJudge({ lastUserMessage, payload, fullHistory, wasChipTap = false }) {
  const compactHistory = fullHistory.slice(-6).map((m) => `${m.role === "user" ? "CUSTOMER" : "BOT"}: ${String(m.content).slice(0, 400)}`).join("\n");
  const productsSummary = (payload.products || []).slice(0, 5).map((p) => `- ${p.title || p.handle}`).join("\n") || "(none)";
  const chipNote = wasChipTap
    ? `\nIMPORTANT: the customer's message was them TAPPING A QUICK-REPLY BUTTON THE BOT ITSELF SUGGESTED. If the bot now cannot actually answer its own suggested question (vague non-answer, "tell me more", no data, deflection, or unrelated reply), that is a "chip-unanswerable" bug — the bot must never suggest a question it cannot fulfill.\n`
    : "";
  const system = `You audit a footwear shopping chatbot. Read one exchange and decide if the bot's response has a bug.

OUTPUT FORMAT (strict JSON only, no prose):
{"ok": true} OR {"ok": false, "seam": "<one of: scope-loss|contradicts-self|ignores-user|wrong-topic|hallucinated-fact|repetitive|confusing|chip-unanswerable|other>", "detail": "<one short sentence>"}

Be strict but reasonable. If the bot's response makes sense given the customer's message and history, return {"ok": true}. Only flag clear bugs.

Common bugs to look for:
- scope-loss: bot forgot a constraint the customer mentioned (category, color, gender, size)
- contradicts-self: text says one thing, products/chips show another
- ignores-user: bot answered a different question than asked
- wrong-topic: pivoted off the customer's question
- hallucinated-fact: claimed a feature/policy/product that wasn't established
- repetitive: same question/answer as a prior turn
- confusing: response is unclear or self-contradictory
- chip-unanswerable: bot suggested a quick-reply it then can't actually answer`;

  const user = `RECENT HISTORY:\n${compactHistory}\n${chipNote}\nCUSTOMER JUST SAID: "${lastUserMessage}"\n\nBOT RESPONDED WITH:\nTEXT: ${(payload.text || "(empty)").slice(0, 1500)}\nPRODUCTS SHOWN:\n${productsSummary}\nSUGGESTIONS: ${JSON.stringify(payload.suggestions.slice(0, 5))}\n\nIs the bot's response OK? Reply with only the JSON.`;

  try {
    const resp = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: user }],
    });
    const raw = resp.content?.[0]?.text?.trim() || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: true };
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.ok ? { ok: true } : { ok: false, seam: parsed.seam || "other", detail: parsed.detail || "" };
  } catch (err) {
    return { ok: true, _judgeError: err.message };
  }
}

// ---------- run one conversation ----------
async function runConversation(persona, convoIndex) {
  const sessionId = `adv-hunt-${Date.now()}-${convoIndex}-${Math.random().toString(36).slice(2, 8)}`;
  const turns = Math.floor(MIN_TURNS + Math.random() * (MAX_TURNS - MIN_TURNS + 1));
  const history = []; // {role, content}
  const turnLogs = []; // each: {userMessage, payload, bugs}
  let firstBugTurn = -1;
  let lastSuggestions = []; // quick-reply chips the bot offered last turn

  for (let t = 0; t < turns; t++) {
    let userMessage;
    try { userMessage = await nextCustomerMessage(persona, history, t, lastSuggestions); }
    catch (e) { return { persona: persona.name, sessionId, turnLogs, fatalError: `customer-agent: ${e.message}` }; }
    if (!userMessage) break;
    const norm = (s) => String(s || "").trim().toLowerCase();
    const wasChipTap = lastSuggestions.some((s) => norm(s) === norm(userMessage));
    const prevUserMsg = [...history].reverse().find((m) => m.role === "user")?.content;
    const customerRepeatedSelf = prevUserMsg != null && norm(prevUserMsg) === norm(userMessage);
    history.push({ role: "user", content: userMessage });

    let payload;
    try { payload = await postTurn({ message: userMessage, history: history.slice(0, -1), sessionId }); }
    catch (e) {
      turnLogs.push({ userMessage, payload: null, bugs: [{ seam: "endpoint-error", detail: e.message.slice(0, 300) }] });
      if (firstBugTurn < 0) firstBugTurn = t;
      break;
    }

    const botText = payload.text || "";
    history.push({ role: "assistant", content: botText, products: payload.products || [] });
    lastSuggestions = Array.isArray(payload.suggestions) ? payload.suggestions : [];

    let bugs = structuralBugs({ payload, lastUserMessage: userMessage, fullHistory: history });
    if (bugs.length === 0) {
      const judged = await llmJudge({ lastUserMessage: userMessage, payload, fullHistory: history, wasChipTap });
      // Don't blame the bot for repeating when the CUSTOMER repeated itself verbatim
      // (test-agent artifact, not a real bot bug).
      if (!judged.ok && !(judged.seam === "repetitive" && customerRepeatedSelf)) {
        bugs = [{ seam: judged.seam, detail: judged.detail, source: "llm-judge" }];
      }
    }

    turnLogs.push({ userMessage, payload: { text: payload.text, products: payload.products?.map((p) => ({ title: p.title, handle: p.handle })), suggestions: payload.suggestions, links: payload.links, errors: payload.errors }, bugs });
    if (bugs.length > 0 && firstBugTurn < 0) firstBugTurn = t;

    if (VERBOSE) console.log(`  [${persona.name} t${t}] user="${userMessage.slice(0, 80)}" → bugs=${bugs.length}`);

    if (INTER_TURN_DELAY_MS > 0 && t < turns - 1) {
      await new Promise((r) => setTimeout(r, INTER_TURN_DELAY_MS));
    }
  }

  return { persona: persona.name, sessionId, turnLogs, firstBugTurn };
}

// ---------- write results ----------
function appendBrokenConvo(convo) {
  let existing = [];
  if (fs.existsSync(OUTPUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT, "utf8")); }
    catch { existing = []; }
  }
  existing.push({ ...convo, timestamp: new Date().toISOString() });
  fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));
}

function writeClusterReport(allConvos) {
  const broken = allConvos.filter((c) => c.turnLogs?.some((t) => t.bugs?.length > 0) || c.fatalError);
  const seamCounts = new Map();
  const seamExamples = new Map();
  const personaBugCounts = new Map();

  for (const c of broken) {
    personaBugCounts.set(c.persona, (personaBugCounts.get(c.persona) || 0) + 1);
    for (const turn of c.turnLogs || []) {
      for (const b of turn.bugs || []) {
        seamCounts.set(b.seam, (seamCounts.get(b.seam) || 0) + 1);
        if (!seamExamples.has(b.seam)) seamExamples.set(b.seam, []);
        if (seamExamples.get(b.seam).length < 3) {
          seamExamples.get(b.seam).push({ persona: c.persona, user: turn.userMessage, botText: (turn.payload?.text || "").slice(0, 200), detail: b.detail });
        }
      }
    }
  }

  const lines = [];
  lines.push(`# Adversarial Chat Hunter — Cluster Report`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`**Conversations run:** ${allConvos.length}`);
  lines.push(`**Conversations with at least one bug:** ${broken.length} (${((broken.length / allConvos.length) * 100).toFixed(1)}%)`);
  lines.push(``);
  lines.push(`## Bug seams (sorted by frequency)`);
  lines.push(``);
  lines.push(`| Seam | Count | Owner file (best guess) |`);
  lines.push(`|---|---:|---|`);
  const seamOwner = {
    "chip-unanswerable": "app/lib/chip-filter.server.js + response-contract (suggestions must be answerable from facts)",
    "false-denial-with-pool": "app/lib/response-contract.server.js + app/lib/catalog-resolver.server.js",
    "enum-leak": "app/lib/orthotic-flow.server.js + app/lib/response-contract.server.js",
    "chip-card-contradiction": "app/lib/chip-filter.server.js + chat.jsx turn assembly",
    "hallucinated-sku": "app/lib/chat-postprocessing.js + response-contract",
    "wrong-gender-cards": "app/lib/catalog-resolver.server.js + chat-tool-rewrite",
    "category-asked-after-named": "app/lib/session-memory.server.js + category-intent",
    "scope-loss": "app/lib/session-memory.server.js (pivot rules)",
    "contradicts-self": "app/lib/response-contract.server.js (turn assembly)",
    "ignores-user": "app/lib/chat-prompt.server.js + agentic loop",
    "wrong-topic": "app/lib/category-intent.server.js + router",
    "hallucinated-fact": "app/lib/chat-prompt.server.js (grounding)",
    "repetitive": "app/lib/orthotic-flow.server.js or system prompt",
    "confusing": "AI prose layer",
    "empty-response": "agentic loop / model overload",
    "backend-error": "infrastructure / route handler",
    "runaway-length": "chat-prompt response shape rules",
    "endpoint-error": "infrastructure / signing",
    "other": "uncategorized",
  };
  const sortedSeams = [...seamCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [seam, count] of sortedSeams) lines.push(`| ${seam} | ${count} | ${seamOwner[seam] || "?"} |`);
  lines.push(``);
  lines.push(`## Bugs by persona (which customer types broke the bot)`);
  lines.push(``);
  lines.push(`| Persona | Broken convos |`);
  lines.push(`|---|---:|`);
  for (const [p, n] of [...personaBugCounts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${p} | ${n} |`);
  lines.push(``);
  lines.push(`## Examples per seam (up to 3)`);
  lines.push(``);
  for (const [seam, examples] of seamExamples.entries()) {
    lines.push(`### ${seam}`);
    for (const ex of examples) {
      lines.push(`- **persona:** ${ex.persona}`);
      lines.push(`  - **user:** "${ex.user}"`);
      lines.push(`  - **bot:** "${ex.botText.replace(/\n/g, " ")}"`);
      lines.push(`  - **why flagged:** ${ex.detail}`);
    }
    lines.push(``);
  }
  fs.writeFileSync(REPORT, lines.join("\n"));
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);

  const eligiblePersonas = ONLY_PERSONA ? PERSONAS.filter((p) => p.name === ONLY_PERSONA) : PERSONAS;
  if (eligiblePersonas.length === 0) { console.error(`No persona matches ${ONLY_PERSONA}`); process.exit(1); }

  const jobs = [];
  for (let i = 0; i < NUM_CONVOS; i++) jobs.push({ persona: eligiblePersonas[i % eligiblePersonas.length], i });

  console.log(`[hunter] Running ${NUM_CONVOS} convos × ${MIN_TURNS}-${MAX_TURNS} turns @ concurrency=${CONCURRENCY}`);
  console.log(`[hunter] Inter-turn delay: ${INTER_TURN_DELAY_MS}ms · rate-limit retries: ${MAX_RATE_LIMIT_RETRIES}`);
  console.log(`[hunter] Note: your /chat route limits ~20 req/min per IP+shop. Keep concurrency low (1 is safe).`);
  console.log(`[hunter] Output: ${path.relative(ROOT, OUTPUT)}`);
  console.log(`[hunter] Report: ${path.relative(ROOT, REPORT)}`);

  const allConvos = [];
  let inFlight = 0;
  let cursor = 0;
  let done = 0;
  const t0 = Date.now();

  await new Promise((resolve) => {
    const launch = () => {
      while (inFlight < CONCURRENCY && cursor < jobs.length) {
        const { persona, i } = jobs[cursor++];
        inFlight++;
        runConversation(persona, i)
          .then((convo) => {
            allConvos.push(convo);
            const broke = (convo.turnLogs || []).some((t) => t.bugs?.length > 0) || !!convo.fatalError;
            if (broke) appendBrokenConvo(convo);
            done++;
            const pct = ((done / NUM_CONVOS) * 100).toFixed(1);
            const rate = done / ((Date.now() - t0) / 1000);
            const eta = Math.round((NUM_CONVOS - done) / Math.max(rate, 0.01));
            console.log(`[${done}/${NUM_CONVOS} ${pct}%] ${persona.name} broke=${broke} (rate=${rate.toFixed(2)}/s eta=${eta}s broken_total=${allConvos.filter((c) => (c.turnLogs || []).some((t) => t.bugs?.length > 0) || c.fatalError).length})`);
          })
          .catch((err) => {
            allConvos.push({ persona: persona.name, fatalError: err.message });
            done++;
            console.log(`[${done}/${NUM_CONVOS}] ${persona.name} FATAL: ${err.message.slice(0, 200)}`);
          })
          .finally(() => {
            inFlight--;
            if (done >= NUM_CONVOS) resolve();
            else launch();
          });
      }
    };
    launch();
  });

  writeClusterReport(allConvos);
  console.log(`\n[hunter] Done. ${allConvos.length} convos. Report: ${path.relative(ROOT, REPORT)}`);
  const broken = allConvos.filter((c) => (c.turnLogs || []).some((t) => t.bugs?.length > 0) || c.fatalError);
  console.log(`[hunter] Broken: ${broken.length}/${allConvos.length} (${((broken.length / allConvos.length) * 100).toFixed(1)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
