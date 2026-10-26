// Lean engine — one customer turn.
//
//   Claude decides → tools return facts → fact check → (one rewrite if needed)
//
// No pre-classification, no rewriting of Claude's searches, no editing of its
// words. The only code-owned additions are the product cards Claude chose
// (from show_products) and the medical note. Pure apart from the injected
// `anthropic` client and `lookupStoreInfo` function, so it runs in tests with
// stubs.

import { leanSearch, allMatches, productDetails, similarProducts } from "./search.js";
import { viewAllWords, VIEW_ALL_MAX } from "./shop-all.js";
import { buildComparison, comparisonFacts } from "./compare.js";
import { buildLeanTools } from "./tools.js";
import { buildLeanSystemPrompt } from "./prompt.js";
import { verifyLeanAnswer, buildFamilyIndex } from "./verify.js";
import { resolvePreselect, preselectAvailable, availableAlternatives } from "./variant-choice.js";
import { productKind, codesInText } from "./catalog.js";
import { applyMedicalDisclaimer, medicalDisclaimerRequired, disclaimerAlreadyShown, footConditionQuestion } from "../medical-disclaimer.js";

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
    for (const block of m.content.matchAll(/\[(?:Product cards displayed|Products compared side by side) with this reply: ([^\]]+)\]/g)) {
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

// The tap suggestions are written in the customer's voice ("Do these come in
// wide?"). A reply that repeats them reads as the assistant asking the
// customer the customer's own questions.
export function echoesFollowUps(text, followUps = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(text);
  if (!t) return false;
  const hits = followUps.map(norm).filter((f) => f.length > 8 && t.includes(f));
  return hits.length >= 2 || (hits.length === 1 && t.length < hits[0].length * 2);
}

// A short reply in the middle of choosing an orthotic usually answers the last
// question ("boots" = orthotics for boots). If the turn ends up showing only
// shoes, Claude is asked to look again — it decides; this only spots the switch.
const ORTHOTIC_TALK = /orthotic|insole|insert|footbed|\bfit [abcd]\b/i;
// Shoes that carry the word in their name or copy ("Milos Orthotic Slide",
// "built-in orthotic footbed") aren't an orthotic conversation.
const SHOE_ORTHOTIC = /\b(?:built[- ]in|removable|cushioned|contoured|supportive)\s+(?:orthotic|footbed|insole)s?(?:\s+footbeds?)?|\borthotic\s+(?:slides?|flip[- ]?flops?|sandals?|thongs?|clogs?|sneakers?|shoes?|boots?|loafers?|wedges?|footbeds?)\b/gi;
// "Shoes that fit your own orthotics" is a shoe chat, not an orthotic one.
const OWN_ORTHOTIC = /\b(?:your|my|their|her|his)\s+own\s+(?:custom\s+)?(?:orthotics?|insoles?|inserts?)\b/gi;
// "What type of shoe are you looking for?" asks about shoes, whatever came before it.
const SHOE_QUESTION = /\b(?:shoes?|styles?|footwear)\b[^?]*\b(?:looking for|shopping for|in the market for)\b/i;
function askedAboutOrthotic(text) {
  // The last reply talked about an orthotic and asked the shopper something.
  const t = String(text || "").replace(SHOE_ORTHOTIC, " ").replace(OWN_ORTHOTIC, " ");
  if (!t.includes("?") || !ORTHOTIC_TALK.test(t)) return false;
  const questions = t.match(/[^.!?\n]*\?/g) || [];
  return !questions.some((q) => SHOE_QUESTION.test(q) && !ORTHOTIC_TALK.test(q));
}
export function leftOrthoticChat({ lastAssistantText = "", latestUserMessage = "", shownProducts = [] } = {}) {
  const said = String(latestUserMessage || "").trim();
  if (!said || said.split(/\s+/).length > 3 || ORTHOTIC_TALK.test(said)) return false;
  if (!askedAboutOrthotic(lastAssistantText)) return false;
  return shownProducts.length > 0 && shownProducts.every((p) => productKind(p) === "footwear");
}

// "Show me current sales and promotions": the running offers (free gifts,
// codes, free shipping, referral) come first, then marked-down products.
// Telling Claude in the prompt wasn't enough — it answered with sale cards
// only — so the turn carries a note, and a reply with no offer is rewritten.
const OFFER_QUESTION = /\b(sales|deals?|discounts?|promos?|promotions?|offers?|coupons?|specials|promo codes?|on sale)\b|\bsale\b/i;
const ONE_PRODUCT = /\b(this|these|that|those|it)\b/i;
// "What styles offer removable insoles?" uses offer as a verb.
const OFFER_VERB = /\boffers?\s+(?!(?:on|for|codes?|right|today|now|running|available|going|do|are|you|that|this|in|at|with|and|or|to|i|we|is)\b)[a-z]+/gi;
// "Boots on sale" / "more sale sneakers" asks for marked-down shoes, not the
// store-wide offer list (orthotics stay: their offers are about orthotics).
const SHOE_WORD = /\b(boots?|booties?|sneakers?|sandals?|shoes?|loafers?|flats|heels?|wedges?|slippers?|clogs?|mules?|slides?|flip[- ]?flops?|oxfords?|mary janes?|footwear)\b/i;
export function asksAboutOffers(text) {
  const t = String(text || "").replace(OFFER_VERB, " ");
  return OFFER_QUESTION.test(t) && !ONE_PRODUCT.test(t) && !SHOE_WORD.test(t);
}
// The offers were already listed earlier in this chat: don't list them again.
export function offersAlreadyListed(messages = []) {
  return messages.some((m) => {
    if (m?.role !== "assistant") return false;
    const t = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((b) => b?.text || "").join("\n") : "");
    if (/Here's what's running right now|See full offer details/i.test(t)) return true;
    return t.split("\n").filter((l) => /^\s*[-•*]\s+\*\*/.test(l) && OFFER_WORDS.test(l)).length >= 2;
  });
}
export function hasRunningOffers(extraSystem) {
  const s = String(extraSystem || "");
  return s.includes("PROMOTIONS FROM THE STORE'S PROMOTIONS PAGE") || s.includes("ACTIVE PROMOTIONS (live right now");
}
const OFFER_WORDS = /\bfree\b|\d+\s*%\s*off|\$\d+(?:\.\d+)?\s+off|\b(codes?|referr\w*|refer a friend|price match\w*|gifts?|flash sale|bogo|buy one|rewards?|points)\b/i;
export function mentionsOffer(text) {
  return OFFER_WORDS.test(String(text || ""));
}
// Product codes the customer typed ("L820"), with the products they name — so
// a code is searched as the product it is, never taken for an order number.
export function codesNote(found) {
  if (!found.length) return "";
  const lines = found.slice(0, 3).map(({ code, products }) =>
    `"${code.toUpperCase()}" is this store's product code for: ${[...new Set(products.map((p) => p.title))].slice(0, 4).join("; ")}`);
  return `(${lines.join(". ")}. It's a product, not an order number — search it with product search, query "${found[0].code}".)`;
}

// Text written alongside a lookup is usually filler ("Let me check…"), but a
// real answer followed by "And don't forget…" must not lose its first half.
const FILLER = /^(let me|i'?ll|i will|one (moment|sec)|just a (moment|sec)|checking|give me|hang on|sure[,!.]? let me)/i;
const CONTINUES = /^(and|also|plus|oh,? and|by the way|p\.?s\.?)\b/i;
export function joinContinuation(earlier, said) {
  const e = String(earlier || "").trim();
  const t = String(said || "").trim();
  if (!e || !t || FILLER.test(e) || !CONTINUES.test(t) || t.includes(e)) return t;
  return `${e}\n\n${t}`;
}

// The message has a sales word in it: Claude decides what it means.
const OFFERS_NOTE = "(If the customer is asking which sales, deals or offers are running, start your reply with every offer that's running from ACTIVE PROMOTIONS and the store's promotions page — check each one's end date against right now and skip ended ones — one short line each (a bold name and a few words, no fine print), then the marked-down products: product search with on_sale: true. If they only want marked-down products of one kind (\"boots on sale\"), or use \"offer\" another way (\"styles that offer removable insoles\"), just answer that — no offer list.)";

// Yes/no questions for a quick check model. They decide what a message
// means where a word list can't ("sale" in "boots on sale" vs "any sales?").
export function offersQuestion(lastAssistantText, message) {
  return [
    "A shopper is chatting with a shoe and orthotic store's assistant.",
    lastAssistantText ? `The assistant last said: """${String(lastAssistantText).slice(0, 600)}"""` : "",
    `The shopper now wrote: """${String(message).slice(0, 400)}"""`,
    "Is the shopper asking which promotions, deals, discounts, coupon codes or store-wide offers are running (for example \"any deals?\", \"what's on sale?\", \"do you have a promo code?\")?",
    "Answer NO if they want marked-down products of one kind (\"boots on sale\", \"more sale sneakers\"), ask about one product's price, or use \"offer\" another way (\"styles that offer removable insoles\").",
    "Reply with YES or NO only.",
  ].filter(Boolean).join("\n");
}
export function orthoticAnswerQuestion(lastAssistantText, message) {
  return [
    "A shopper is chatting with a shoe and orthotic store's assistant.",
    `The assistant last said: """${String(lastAssistantText).slice(0, 600)}"""`,
    `The shopper replied: """${String(message).slice(0, 200)}"""`,
    "Was the assistant helping the shopper choose an orthotic (an insole or insert), and is the reply most likely an answer to that — for example naming the shoes they'll wear the orthotic in — rather than asking to see shoes?",
    "Answer NO if the chat is about finding shoes (for example shoes that fit the shopper's own orthotics).",
    "Reply with YES or NO only.",
  ].join("\n");
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
    // footwear / orthotic / other — decides which fit helper the card offers.
    kind: productKind(p),
  };
}

// A reply that hands the customer to a person or team. "Tap the button below"
// alone isn't enough — that can mean Add to cart or See It Styled.
const SUPPORT_POINTER = /\b(customer (service|care|support|experience)|support team|service team|care team|(reach|contact|message|email|call) (us|support|our team|the team)|talk to (someone|a person|a human|an agent|our team)|live (chat|agent))\b/i;
export function pointsToSupport(text) {
  return SUPPORT_POINTER.test(String(text || ""));
}

// What the model is told about the product page the shopper is on: the
// catalog's own facts, nothing more.
export function viewingNote(p) {
  const price = Number.isFinite(p.price) ? ` — $${p.price.toFixed(2)}${Number.isFinite(p.maxPrice) && p.maxPrice > p.price ? `–$${p.maxPrice.toFixed(2)}` : ""}` : "";
  const sizeKey = Object.keys(p.options || {}).find((k) => /^size$/i.test(k));
  const sizes = sizeKey && p.options[sizeKey].length ? ` Sizes listed: ${p.options[sizeKey].slice(0, 30).join(", ")}.` : "";
  return `THE PAGE THE CUSTOMER IS ON\nThey're looking at this product's page right now: ${p.title} (handle: ${p.handle})${price}.${sizes} When they say "this", "these", "it" or "this shoe" without naming a product, they most likely mean this one. They can already see its page, so you don't need to show its card unless it helps; use get_product_details for anything more (stock by size, details). Don't assume they want it if they ask about something else.`;
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
  // This shopper and page (the shoe page they're on, their saved FIT) — after
  // the cached prompt, so the shared part reads the same for every shopper.
  pageSystem = "",
  // Sent with the latest message only (the current time, for offers' dates).
  turnNote = "",
  // Qualities "similar" means for this store; empty → no similar tool.
  similarAttributes = [],
  deadlineMs = TURN_DEADLINE_MS,
  log = (line) => console.log(line),
  callModel = null, // test seam: (request) => response
  // Live stock for one product: async (handle) → [{ Size, Width }] in stock, or null.
  liveStock = null,
  // The product page the shopper is on, if any (handle from the page URL).
  viewingHandle = "",
  // Quick yes/no check: async (question) → true / false / null (couldn't
  // tell). Without it, the word-based checks stand in (tests).
  askYesNo = null,
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
  // The product page the shopper is on: "this", "these", "it" usually mean it.
  const viewing = viewingHandle ? byHandle.get(viewingHandle) || null : null;
  if (viewing) system.push({ type: "text", text: viewingNote(viewing) });
  if (String(pageSystem || "").trim()) system.push({ type: "text", text: String(pageSystem).trim() });

  const conv = normalizeConversation(messages.slice(-MAX_HISTORY_MESSAGES));
  const lastAssistantText = [...messages].reverse().find((m) => m?.role === "assistant" && typeof m.content === "string")?.content || "";
  // A sales word, offers running, not listed yet in this chat → Claude is
  // told how to answer either meaning, and the check model says which it is.
  const offersMaybe = (askYesNo ? OFFER_QUESTION.test(latestUserMessage) : asksAboutOffers(latestUserMessage)) &&
    hasRunningOffers(extraSystem) && !offersAlreadyListed(messages.slice(0, -1));
  const offersCheck = offersMaybe && askYesNo
    ? Promise.resolve().then(() => askYesNo(offersQuestion(lastAssistantText, latestUserMessage))).catch(() => null)
    : Promise.resolve(offersMaybe);
  let offersAsked = null; // resolved at the first fact check
  // Pain or a condition named and the health note not given yet in this chat
  // → the check model says whether the shopper wants help with it (vs.
  // returning an orthotic named after it). Read when the reply is done.
  const conditionMaybe = medicalDisclaimerRequired({ workflow: "condition_recommendation", message: latestUserMessage, text: "" }) &&
    !disclaimerAlreadyShown(messages);
  const conditionCheck = conditionMaybe && askYesNo
    ? Promise.resolve().then(() => askYesNo(footConditionQuestion(lastAssistantText, latestUserMessage))).catch(() => null)
    : Promise.resolve(conditionMaybe);
  if (offersMaybe) {
    const last = conv[conv.length - 1];
    const note = { type: "text", text: OFFERS_NOTE };
    if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), note];
  }
  if (String(turnNote || "").trim()) {
    const last = conv[conv.length - 1];
    if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), { type: "text", text: String(turnNote).trim() }];
  }
  const typedCodes = codesInText(catalog, latestUserMessage);
  if (typedCodes.length) {
    const last = conv[conv.length - 1];
    const note = { type: "text", text: codesNote(typedCodes) };
    if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), note];
    log(`[lean] product codes typed: ${typedCodes.map((c) => c.code).join(",")}`);
  }
  const priorTitles = extractPriorShownTitles(messages);
  const priorProducts = priorTitles
    .map((t) => byTitle.get(t.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase()))
    .filter(Boolean);

  const seen = new Map(priorProducts.map((p) => [p.handle, p])); // handles Claude may show
  // The product on the shopper's screen counts as already seen: it can be
  // named and priced without showing its card again.
  if (viewing) seen.set(viewing.handle, viewing);
  // Styles the customer already saw as cards (any colorway of them counts).
  const priorStyles = new Set([...priorProducts, ...(viewing ? [viewing] : [])].map((p) => p.style.toLowerCase()));
  const seenThisTurn = new Map();
  let shown = [];
  let preselects = new Map();
  let followUps = [];
  let supportRequested = null;
  let ordersLooked = false;
  let compared = []; // handles in this reply's comparison table
  let soldOut = []; // sizes the customer asked for that aren't in stock
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
      soldOut = [];
      for (const h of ok) {
        const want = input.options && typeof input.options === "object" ? input.options[h] : null;
        const pre = want ? resolvePreselect(byHandle.get(h), want) : null;
        if (!pre) continue;
        // The card offers one-tap Add to cart in this size only if it's in
        // stock right now — the store's live stock when we can read it.
        let stock = byHandle.get(h).stock;
        if (liveStock) {
          const live = await liveStock(h).catch(() => null);
          if (Array.isArray(live)) stock = live;
        }
        if (preselectAvailable(stock, pre)) preselects.set(h, pre);
        else soldOut.push({ title: byHandle.get(h).title, wanted: pre, in_stock: availableAlternatives(stock, pre) });
      }
      followUps = cleanFollowUps(input.follow_ups);
      log(`[lean] show ${JSON.stringify(ok)}${rejected.length ? ` rejected=${JSON.stringify(rejected)}` : ""}${preselects.size ? ` preselect=${JSON.stringify(Object.fromEntries(preselects))}` : ""}`);
      return {
        showing: ok.map((h) => byHandle.get(h).title),
        ...(soldOut.length ? {
          sold_out: soldOut,
          sold_out_note: "Those sizes are sold out right now, so the cards don't pre-pick them. Tell the customer plainly and name the closest sizes in `in_stock` (or other styles) — don't say it's ready to add.",
        } : {}),
        ...(rejected.length ? { rejected, note: "Rejected handles weren't returned by a tool in this conversation — search first." } : {}),
      };
    }
    if (name === "compare_products") {
      const handles = (Array.isArray(input.handles) ? input.handles : []).map(String);
      const known = handles.filter((h) => seen.has(h));
      const rejected = handles.filter((h) => !seen.has(h));
      const cmp = buildComparison(catalog, known);
      if (cmp.error) {
        log(`[lean] compare ${JSON.stringify(handles)} → ${cmp.error}`);
        return { error: rejected.length ? "Only handles returned by a tool in this conversation can be compared — search for each product first." : cmp.error };
      }
      // One table per reply: the last one asked for.
      for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "comparison") events.splice(i, 1);
      events.push({ type: "comparison", comparison: cmp });
      compared = cmp.products.map((p) => p.handle);
      const factsText = comparisonFacts(cmp);
      knowledgeText += `\nCOMPARISON\n${factsText}`;
      for (const p of cmp.products) {
        topic("compare", p.title);
        mentions.push({ handle: p.handle, title: p.title, tool: "compare_products" });
      }
      log(`[lean] compare ${JSON.stringify(cmp.products.map((p) => p.handle))} differences=${cmp.differences}`);
      return {
        comparing: cmp.products.map((p) => p.title),
        same_style: cmp.sameStyle || undefined,
        facts: factsText,
        note: "The comparison table is shown under your reply with all of these details. Reply in 1-2 sentences: the difference that matters most for this customer, or your pick and why, using only these facts.",
        ...(cmp.note ? { limit: cmp.note } : {}),
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
    // "L820" is a product code here, not an order number: send Claude to the product.
    const codeAsOrder = name === "get_my_orders" && input?.orderNumber ? codesInText(catalog, input.orderNumber) : [];
    if (codeAsOrder.length) {
      log(`[lean] get_my_orders refused: "${codeAsOrder[0].code}" is a product code`);
      return { error: `"${input.orderNumber}" isn't an order number — it's this store's product code for ${codeAsOrder[0].products[0].title}. Search it with product search (query "${codeAsOrder[0].code}") and show it.` };
    }
    if (ext) {
      if (name === "get_my_orders") ordersLooked = true;
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
  let earlier = ""; // the last text written alongside a lookup (kept if the reply continues it)
  let askedForText = false;
  const PRESENTING = new Set(["show_products", "compare_products", "contact_support"]);

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
    if (toolUses.some((t) => !PRESENTING.has(t.name))) { draft = ""; if (said) earlier = said; }
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

    text = said ? joinContinuation(earlier, said) : draft;
    if (!text && !askedForText && hop < MAX_HOPS - 1 && Date.now() - started < deadlineMs) {
      // Ended without a word for the customer: ask once for the reply.
      askedForText = true;
      if (content.length === 0) conv.pop(); // the API rejects empty assistant turns
      const ask = { type: "text", text: "(Now write your reply to the customer in your own voice — a sentence or two on what you're showing and why it suits them. The cards and the suggested tap questions are shown separately: don't repeat the suggestions.)" };
      const last = conv[conv.length - 1];
      if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), ask];
      else conv.push({ role: "user", content: [ask] });
      log("[lean] no reply text — asking for it");
      continue;
    }
    const issues = [];
    if (echoesFollowUps(text, followUps)) {
      issues.push({
        code: "echoed_follow_ups",
        detail: "Your reply repeated the suggested tap questions — they're written in the customer's voice and are already shown as buttons. Write your own short reply: what you're showing and why it fits what they asked.",
      });
    }
    let orthoticAnswer = leftOrthoticChat({ lastAssistantText, latestUserMessage, shownProducts: shown.map((h) => byHandle.get(h)).filter(Boolean) });
    if (orthoticAnswer && askYesNo) {
      const said = await Promise.resolve().then(() => askYesNo(orthoticAnswerQuestion(lastAssistantText, latestUserMessage))).catch(() => null);
      orthoticAnswer = said === true;
      log(`[lean] orthotic-answer check: ${said === null ? "unsure" : said ? "yes" : "no"}`);
    }
    if (orthoticAnswer) {
      const said = String(latestUserMessage).trim().replace(/[<>]/g, "").slice(0, 40);
      issues.push({
        code: "left_orthotic_chat",
        detail: `You were helping choose an orthotic and the customer answered "${said}" — you're now showing shoes. A short answer mid-conversation usually answers your last question ("boots" = orthotics for boots). Unless they clearly asked for shoes, keep helping with the orthotic; if it could mean either, ask with <<Orthotics for ${said}>><<Show me ${said}>>. If they did want shoes, keep your reply.`,
      });
    }
    if (soldOut.length && !/sold out|out of stock|not in stock|isn['’]t available|not available|unavailable|no longer|don['’]t have|out in/i.test(text)) {
      issues.push({
        code: "sold_out_size",
        detail: `The size you picked is sold out: ${soldOut.map((s) => `${s.title} in ${Object.values(s.wanted).join(" / ")}${s.in_stock.length ? ` (in stock: ${s.in_stock.join(", ")})` : ""}`).join("; ")}. Say so and offer what's in stock — the card can't add a sold-out size.`,
      });
    }
    if (offersAsked === null) {
      offersAsked = (await offersCheck) === true;
      if (offersMaybe) log(`[lean] offers question: ${offersAsked ? "yes" : "no"}`);
    }
    if (offersAsked && !mentionsOffer(text)) {
      issues.push({
        code: "missing_offers",
        detail: "The customer asked about sales and promotions, and offers are running (ACTIVE PROMOTIONS / the store's promotions page), but your reply lists none. Start with every offer that's still running — check each end date against right now — one short line each (a bold name and a few words, no fine print). Then the marked-down products.",
      });
    }
    issues.push(...verifyLeanAnswer({
      text,
      // The comparison table presents its products, as cards would.
      shownHandles: [...shown, ...compared],
      seenProducts: [...seen.values()],
      freshProducts: [...seenThisTurn.values()].filter((p) => !priorStyles.has(p.style.toLowerCase())),
      priorTitles,
      familyIndex,
      knowledgeText,
    }));
    // A rewrite needs a step left to happen in; on the last step the issues stand.
    if (issues.length > 0 && !retried && hop < MAX_HOPS - 1 && Date.now() - started < deadlineMs) {
      retried = true;
      draft = ""; // the rejected reply must not come back as the answer
      earlier = "";
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

  if (finalIssues.some((i) => i.code === "missing_offers")) log(`[lean] reply without offers: ${JSON.stringify(text.slice(0, 160))}`);

  const fellBack = !text;
  if (!text) {
    log("[lean] no reply text — sent the fallback message");
    text = "Sorry — I couldn't finish that one. Could you try asking again?";
  }

  // The reply sends the customer to a person ("tap below to reach customer
  // service") but contact_support wasn't called: show the support button
  // anyway, so that promise always has a button under it.
  if (!supportRequested && pointsToSupport(text)) {
    supportRequested = "reply points to customer service";
    topic("support", "");
    log("[lean] support button: the reply points to customer service");
  }

  // The health note is for customers asking for help with pain or a
  // condition — not for a fashion question whose answer mentions orthotics,
  // and not under an order, return or customer-service reply — and once per
  // conversation, not under every reply.
  if (conditionMaybe && !fellBack) {
    const said = await conditionCheck;
    const supportTurn = Boolean(supportRequested) || (ordersLooked && !shown.length);
    log(`[lean] condition check: ${said === null ? "unsure" : said ? "yes" : "no"}${supportTurn ? " — order/support reply, no note" : ""}`);
    if (said !== false && !supportTurn) text = applyMedicalDisclaimer({ workflow: "condition_recommendation", message: latestUserMessage, text }).text;
  }

  // Products in the comparison table aren't repeated as cards.
  const cards = shown.filter((h) => !compared.includes(h)).map((h) => byHandle.get(h)).filter(Boolean).map((p) => toCard(p, preselects.get(p.handle) || null));
  // The search that found the shown cards — the "View all" link repeats it.
  const shopAllSearch = cards.length
    ? [...searches].reverse().find((s) => shown.some((h) => s.handles.has(h)))?.input || null
    : null;
  // More matches than the cards show → "View all N …" opens every match of
  // that search in the chat (each with its own Add to cart).
  let viewAll = null;
  if (shopAllSearch) {
    const all = allMatches(catalog, shopAllSearch);
    const shownSet = new Set(cards.map((c) => c.handle));
    if (all.length > cards.length && all.some((p) => !shownSet.has(p.handle))) {
      viewAll = { ...viewAllWords(shopAllSearch, all.length), total: all.length, products: all.slice(0, VIEW_ALL_MAX).map((p) => toCard(p)) };
      log(`[lean] view all: ${all.length} matches (${cards.length} shown)`);
    }
  }
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
    viewAll,
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
