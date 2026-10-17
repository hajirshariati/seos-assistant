// Lean engine — one customer turn.
//
//   Claude decides → tools return facts → fact check → (one rewrite if needed)
//
// No pre-classification, no rewriting of Claude's searches, no editing of its
// words. The only code-owned additions are the product cards Claude chose
// (from show_products) and the medical note. Pure apart from the injected
// `anthropic` client and `lookupStoreInfo` function, so it runs in tests with
// stubs.

import { leanSearch, productDetails, similarProducts } from "./search.js";
import { buildLeanTools } from "./tools.js";
import { buildLeanSystemPrompt } from "./prompt.js";
import { verifyLeanAnswer, buildFamilyIndex } from "./verify.js";
import { resolvePreselect } from "./variant-choice.js";
import { applyMedicalDisclaimer, medicalDisclaimerRequired, disclaimerAlreadyShown } from "../medical-disclaimer.js";

const MAX_HOPS = 8;
const MAX_CARDS = 4;
const MAX_HISTORY_MESSAGES = 24;
const TURN_DEADLINE_MS = 45000;

// Quick-reply chips must be short, plain, and distinct.
export function cleanFollowUps(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const q = String(raw || "").replace(/[<>*_`#]/g, "").replace(/\s+/g, " ").trim();
    if (q.length < 3 || q.length > 70) continue;
    if (out.some((x) => x.toLowerCase() === q.toLowerCase())) continue;
    out.push(q);
    if (out.length === 3) break;
  }
  return out;
}

// Product handles anywhere in a tool result (orders, recommender, fit report).
function collectHandles(value, out = new Set(), depth = 0) {
  if (!value || depth > 6) return out;
  if (Array.isArray(value)) { for (const v of value) collectHandles(v, out, depth + 1); return out; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "handle" || k === "productHandle") && typeof v === "string") out.add(v);
      else if (v && typeof v === "object") collectHandles(v, out, depth + 1);
    }
  }
  return out;
}

// Titles of cards shown in earlier turns — sanitizeHistory appends them to the
// assistant text as "[Product cards displayed with this reply: 1. Title ($x); …]".
export function extractPriorShownTitles(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    for (const block of m.content.matchAll(/\[Product cards displayed with this reply: ([^\]]+)\]/g)) {
      // Keep "Title ($99.95)" — the price stays usable by the fact check.
      for (const item of block[1].split(/;\s*/)) {
        const entry = item.trim().replace(/^\d+\.\s*/, "");
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

// Anthropic needs user/assistant alternation starting with a user turn.
export function normalizeConversation(messages = []) {
  const conv = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) continue;
    if (conv.length === 0 && m.role !== "user") continue;
    const last = conv[conv.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else conv.push({ role: m.role, content });
  }
  return conv;
}

// Cache the conversation up to its newest message, so each later call in the
// turn (search → show → answer) reads what came before at the cached rate —
// cheaper and faster. Only the newest message carries the marker (the API
// allows four; tools and system use two).
export function withConversationCache(conv) {
  if (conv.length === 0) return conv;
  const last = conv[conv.length - 1];
  const blocks = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : Array.isArray(last.content) ? last.content : [];
  if (blocks.length === 0) return conv;
  const marked = [...blocks.slice(0, -1), { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } }];
  return [...conv.slice(0, -1), { ...last, content: marked }];
}

function addUsage(total, u = {}) {
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    total[k] = (total[k] || 0) + (Number(u[k]) || 0);
  }
}

export function toCard(p, preselect = null) {
  // Options the shopper has to pick before adding (e.g. Size, Width) — the
  // card's button reads "Select size" until they're chosen.
  const choose = Object.entries(p.options || {})
    .filter(([name, values]) => values.length > 1 && !/^title$/i.test(name))
    .map(([name]) => name);
  return {
    ...(preselect ? { preselect } : {}),
    ...(choose.length ? { choose } : {}),
    title: p.title,
    url: p.url,
    handle: p.handle,
    image: p.image || "",
    price: Number.isFinite(p.price) ? p.price.toFixed(2) : "",
    price_formatted: p.priceLabel,
    compare_at_price: p.onSale ? Math.round(p.compareAtPrice * 100) : undefined,
  };
}

export async function runLeanTurn({
  anthropic,
  model,
  shop = "",
  config = {},
  catalog,
  messages = [],
  latestUserMessage = "",
  lookupStoreInfo = async () => ({ found: false }),
  primaryGender = "women",
  // Store-specific tools (orders, fit predictor, recommenders, reviews):
  // [{ definition, run: async (input) => result }]. A result may carry
  // `_events` (widget events, e.g. fit_report) which are passed through.
  extraTools = [],
  // Per-request context (promotions, logged-in customer, store team rules).
  extraSystem = "",
  // Qualities "similar" means for this store; empty → no similar tool.
  similarAttributes = [],
  deadlineMs = TURN_DEADLINE_MS,
  log = (line) => console.log(line),
  callModel = null, // test seam: (request) => response
}) {
  const started = Date.now();
  const products = catalog?.products || [];
  const byHandle = new Map(products.map((p) => [p.handle, p]));
  const byTitle = new Map(products.map((p) => [p.title.toLowerCase(), p]));
  const familyIndex = buildFamilyIndex(products);

  const baseTools = buildLeanTools(catalog?.vocab || {}, { similar: similarAttributes.length > 0 });
  baseTools[baseTools.length - 1] = { ...baseTools[baseTools.length - 1], cache_control: { type: "ephemeral" } };
  const extraByName = new Map(extraTools.filter((t) => t?.definition?.name && typeof t.run === "function").map((t) => [t.definition.name, t]));
  const tools = [...baseTools, ...[...extraByName.values()].map((t) => t.definition)];
  const system = [{
    type: "text",
    text: buildLeanSystemPrompt({ config, vocab: catalog?.vocab || {}, shop, primaryGender }),
    cache_control: { type: "ephemeral" },
  }];
  if (String(extraSystem || "").trim()) system.push({ type: "text", text: String(extraSystem).trim() });

  const conv = normalizeConversation(messages.slice(-MAX_HISTORY_MESSAGES));
  const priorTitles = extractPriorShownTitles(messages);
  const priorProducts = priorTitles
    .map((t) => byTitle.get(t.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase()))
    .filter(Boolean);

  const seen = new Map(priorProducts.map((p) => [p.handle, p])); // handles Claude may show
  // Styles the customer already saw as cards (any colorway of them counts).
  const priorStyles = new Set(priorProducts.map((p) => p.style.toLowerCase()));
  const seenThisTurn = new Map();
  let shown = [];
  let preselects = new Map();
  let followUps = [];
  let supportRequested = null;
  const events = [];
  // Facts the reply may quote: store info, promotions, order/recommender output.
  let knowledgeText = String(extraSystem || "");
  const usage = {};
  let toolCalls = 0;
  let retried = false;
  let text = "";
  let finalIssues = [];
  const searches = [];
  // For analytics: what this turn was about (no customer text) and which
  // products were searched / opened.
  const topics = [];
  const mentions = [];
  const topic = (kind, value) => {
    const v = String(value ?? "").trim().slice(0, 80);
    if (!topics.some((t) => t.kind === kind && t.value === v)) topics.push({ kind, value: v });
  };

  const markSeen = (handles) => {
    for (const h of handles) {
      const p = byHandle.get(h);
      if (p) { seen.set(h, p); seenThisTurn.set(h, p); }
    }
  };

  const runTool = async (name, input = {}) => {
    if (name === "search_products") {
      const result = leanSearch(catalog, input);
      markSeen(result.products.map((p) => p.handle));
      searches.push({ input, handles: new Set(result.products.map((p) => p.handle)) });
      for (const c of input.categories || []) topic("category", c);
      for (const c of input.conditions || []) topic("condition", c);
      for (const c of input.colors || []) topic("color", c);
      for (const c of input.activities || []) topic("activity", c);
      if (input.on_sale) topic("sale", "");
      // Top results only, once per turn — enough to rank what people look for.
      for (const p of result.products.slice(0, 3)) {
        if (!mentions.some((m) => m.handle === p.handle && m.tool === "search_products")) mentions.push({ handle: p.handle, title: p.title, tool: "search_products" });
      }
      log(`[lean] search ${JSON.stringify(input)} → total=${result.total_matches} returned=${result.products.length}${result.if_relaxed ? ` if_relaxed=${JSON.stringify(result.if_relaxed)}` : ""}`);
      return result;
    }
    if (name === "get_product_details") {
      const d = productDetails(catalog, String(input.handle || ""));
      if (!d) return { error: "No product with that handle. Search first." };
      markSeen([d.handle, ...d.style_colorways.map((c) => c.handle)]);
      topic("product", d.title);
      mentions.push({ handle: d.handle, title: d.title, tool: "get_product_details" });
      log(`[lean] details ${input.handle}`);
      return d;
    }
    if (name === "find_similar_products") {
      const r = similarProducts(catalog, { ...input, attributes: similarAttributes });
      if (!r.error) markSeen(r.products.map((p) => p.handle));
      log(`[lean] similar ${input.handle} → ${r.error ? r.error : r.products.length}`);
      return r;
    }
    if (name === "show_products") {
      const handles = (Array.isArray(input.handles) ? input.handles : []).map(String);
      const ok = handles.filter((h) => seen.has(h)).slice(0, MAX_CARDS);
      const rejected = handles.filter((h) => !seen.has(h));
      shown = ok;
      // Size/width the customer stated → exact option values for one-tap Add to cart.
      preselects = new Map();
      for (const h of ok) {
        const want = input.options && typeof input.options === "object" ? input.options[h] : null;
        const pre = want ? resolvePreselect(byHandle.get(h), want) : null;
        if (pre) preselects.set(h, pre);
      }
      followUps = cleanFollowUps(input.follow_ups);
      log(`[lean] show ${JSON.stringify(ok)}${rejected.length ? ` rejected=${JSON.stringify(rejected)}` : ""}${preselects.size ? ` preselect=${JSON.stringify(Object.fromEntries(preselects))}` : ""}`);
      return {
        showing: ok.map((h) => byHandle.get(h).title),
        ...(rejected.length ? { rejected, note: "Rejected handles weren't returned by a tool in this conversation — search first." } : {}),
      };
    }
    if (name === "search_store_info") {
      const r = await lookupStoreInfo(String(input.query || ""));
      if (r?.text) knowledgeText += `\n${r.text}`;
      topic(r?.found ? "store_question" : "unanswered", String(input.query || "").toLowerCase());
      log(`[lean] store-info found=${Boolean(r?.found)}`);
      return r?.found ? { found: true, info: r.text } : { found: false, note: "No store info on this. Say you're not sure and point to customer service." };
    }
    if (name === "contact_support") {
      supportRequested = String(input.reason || "").slice(0, 200) || "customer needs help";
      topic("support", "");
      log(`[lean] support button: ${supportRequested}`);
      return { ok: true, note: "A button to reach customer service is shown under your reply. Tell the customer briefly." };
    }
    const ext = extraByName.get(name);
    if (ext) {
      const raw = await ext.run(input);
      const { _events, ...result } = raw && typeof raw === "object" ? raw : { result: raw };
      if (Array.isArray(_events)) events.push(..._events);
      topic("tool", name);
      markSeen([...collectHandles(result)]);
      knowledgeText += `\n${JSON.stringify(result).slice(0, 6000)}`;
      // Input keys only: store tools take order numbers and other customer details.
      log(`[lean] ${name} {${Object.keys(input || {}).join(",")}} → ${result.error ? `error: ${String(result.error).slice(0, 120)}` : "ok"}`);
      return result;
    }
    return { error: `Unknown tool ${name}` };
  };

  const call = callModel || ((req) => anthropic.messages.create(req));
  // Claude often writes its reply in the same step as showing cards ("Here's
  // the Felicity in burgundy" + show_products) and then ends with nothing
  // more to say — that text is the reply. Text written alongside a lookup
  // ("Let me check…") is not: new facts are on the way.
  let draft = "";
  let askedForText = false;
  const PRESENTING = new Set(["show_products", "contact_support"]);

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // Last hop, or running out of time: no more tools — answer with what we have.
    const mustAnswer = hop === MAX_HOPS - 1 || Date.now() - started > deadlineMs;
    if (mustAnswer) log(`[lean] hop=${hop} forcing a final answer (${hop === MAX_HOPS - 1 ? "hop limit" : "time limit"})`);
    const resp = await call({
      model, max_tokens: 900, system, tools, messages: withConversationCache(conv),
      ...(mustAnswer ? { tool_choice: { type: "none" } } : {}),
    });
    addUsage(usage, resp.usage);
    const content = Array.isArray(resp.content) ? resp.content : [];
    conv.push({ role: "assistant", content });
    const said = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (toolUses.some((t) => !PRESENTING.has(t.name))) draft = "";
    else if (said) draft = said;
    if (toolUses.length > 0) {
      const results = [];
      for (const tu of toolUses) {
        toolCalls += 1;
        let out;
        try { out = await runTool(tu.name, tu.input || {}); }
        catch (err) { out = { error: String(err?.message || err) }; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      conv.push({ role: "user", content: results });
      if (resp.stop_reason === "tool_use" && !mustAnswer) continue;
    }

    text = said || draft;
    if (!text && !askedForText && hop < MAX_HOPS - 1 && Date.now() - started < deadlineMs) {
      // Ended without a word for the customer: ask once for the reply.
      askedForText = true;
      if (content.length === 0) conv.pop(); // the API rejects empty assistant turns
      const ask = { type: "text", text: "(Now write your reply to the customer. Any cards you chose are shown under it.)" };
      const last = conv[conv.length - 1];
      if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), ask];
      else conv.push({ role: "user", content: [ask] });
      log("[lean] no reply text — asking for it");
      continue;
    }
    const issues = verifyLeanAnswer({
      text,
      shownHandles: shown,
      seenProducts: [...seen.values()],
      freshProducts: [...seenThisTurn.values()].filter((p) => !priorStyles.has(p.style.toLowerCase())),
      priorTitles,
      familyIndex,
      knowledgeText,
    });
    // A rewrite needs a step left to happen in; on the last step the issues stand.
    if (issues.length > 0 && !retried && hop < MAX_HOPS - 1 && Date.now() - started < deadlineMs) {
      retried = true;
      draft = ""; // the rejected reply must not come back as the answer
      log(`[lean] fact-check failed → rewrite: ${issues.map((i) => i.code).join(",")}`);
      conv.push({
        role: "user",
        content: `[Automatic fact check — the customer has not seen your reply yet.] ${issues.map((i) => i.detail).join(" ")} Write your reply to the customer again, corrected. You may use tools.`,
      });
      continue;
    }
    finalIssues = issues;
    break;
  }

  if (!text) {
    log("[lean] no reply text — sent the fallback message");
    text = "Sorry — I couldn't finish that one. Could you try asking again?";
  }

  // The note is for customers who brought up pain, a condition or orthotics —
  // not for a fashion question whose answer happens to mention orthotics — and
  // once per conversation, not under every reply.
  if (
    medicalDisclaimerRequired({ workflow: "condition_recommendation", message: latestUserMessage, text: "" }) &&
    !disclaimerAlreadyShown(messages)
  ) {
    text = applyMedicalDisclaimer({ workflow: "condition_recommendation", message: latestUserMessage, text }).text;
  }

  const cards = shown.map((h) => byHandle.get(h)).filter(Boolean).map((p) => toCard(p, preselects.get(p.handle) || null));
  // The search that found the shown cards — the "View all" link repeats it.
  const shopAllSearch = cards.length
    ? [...searches].reverse().find((s) => shown.some((h) => s.handles.has(h)))?.input || null
    : null;
  log(
    `[lean] final textLen=${text.length} cards=${cards.length} tools=${toolCalls} rewrite=${retried} ` +
    `unresolved=${finalIssues.map((i) => i.code).join(",") || "-"} ms=${Date.now() - started}`,
  );
  return {
    text,
    cards,
    followUps: cards.length ? followUps : [],
    supportRequested,
    shopAllSearch,
    topics,
    mentions,
    events,
    usage,
    toolCalls,
    retried,
    issues: finalIssues,
    newSeen: [...seenThisTurn.keys()],
  };
}
