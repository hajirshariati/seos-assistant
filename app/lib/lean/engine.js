// Lean engine — one customer turn.
//
//   Claude decides → tools return facts → fact check → (one rewrite if needed)
//
// No pre-classification, no rewriting of Claude's searches, no editing of its
// words. The only code-owned additions are the product cards Claude chose
// (from show_products) and the medical note. Pure apart from the injected
// `anthropic` client and `lookupStoreInfo` function, so it runs in tests with
// stubs.

import { leanSearch, allMatches, productDetails, similarProducts, styleColorways, resultHandles } from "./search.js";
import { viewAllWords, cleanViewAllSearch, pageOf } from "./shop-all.js";
import { buildViewAllIndex } from "./view-all-index.js";
import { buildComparison, comparisonFacts } from "./compare.js";
import { buildLeanTools } from "./tools.js";
import { buildLeanSystemPrompt } from "./prompt.js";
import { storeLocatorConfig } from "../feedback-survey.js";
import { verifyLeanAnswer, buildFamilyIndex, misappliedShipping, productLineNames } from "./verify.js";
import { resolvePreselect, preselectAvailable, availableAlternatives } from "./variant-choice.js";
import { productKind, codesInText } from "./catalog.js";
import { containsColorWord } from "../color-match.js";
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
// What the customer's message says they're shopping for, in the catalog's
// own words ("sneakers", "orthotics") — "" when it names none.
export function shoppingFor(message, vocab = {}) {
  const text = ` ${String(message || "").toLowerCase()} `;
  const words = [...(vocab.categories || []), ...(vocab.productTypes || [])].map((r) => String(r?.value || "").toLowerCase().trim()).filter((w) => w.length >= 4);
  for (const w of [...new Set(words)].sort((a, b) => b.length - a.length)) {
    const stem = w.replace(/(es|s)$/, "");
    if (new RegExp(`[^a-z]${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)?[^a-z]`).test(text)) return w;
  }
  return "";
}

// Stores whose locator shows foot-scanning locations (Settings → Store
// locator → "Have our foot scanner"): the first time a shopper asks to try
// on or buy a style in person, the answer is help buying here — never the
// map or the scanner locations. Later (they insist), or for a scan or
// orthotics, the map is right. Pure.
const STORE_ASK = /\b(stores?|shops?|retailers?|dealers?|boutiques?|in[- ]person|near me|nearby|close to me|try (?:\w+ ){0,4}on|where can i (?:try|see|feel))\b/i;
const SCAN_ASK = /\b(scan(?:ner|ned|ning|s)?|fitting|fitted|orthotics?|insoles?|arch supports?|locator|map)\b/i;
const INSIST = /\b(still|anyway|anyways|insist|rather|really (?:want|need|would like)|prefer (?:to )?(?:try|see|go))\b/i;
const LOCATOR_SAID = /\b(foot[- ]?scanners?|scanner locations?|scanning locations?|store locator|store map|find a store|stores? near you|locations? near you|nearby (?:stores?|locations?)|retail locations?)\b/i;
const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b) => (b?.type === "text" ? b.text : "")).join(" ") : "");
// The first ask, at such a store, to try on or buy a style in person.
export function firstStoreAsk({ scannerStores = false, messages = [], latestUserMessage = "" } = {}) {
  if (!scannerStores) return false;
  const latest = String(latestUserMessage || "");
  if (!STORE_ASK.test(latest) || SCAN_ASK.test(latest) || INSIST.test(latest)) return false;
  // Asked about stores before in this conversation: now they insist.
  const users = messages.filter((m) => m?.role === "user").map(textOf);
  if (users.length && users[users.length - 1].trim() === latest.trim()) users.pop();
  return !users.some((u) => STORE_ASK.test(u) || SCAN_ASK.test(u));
}
export function storeTooSoon({ text = "", mapShown = false, ...ask } = {}) {
  return firstStoreAsk(ask) && (mapShown || LOCATOR_SAID.test(String(text || "")));
}
// The answer a sales associate gives that first time: it shows they heard
// the question ("totally understand wanting to try it on…") and takes the
// risk away (the returns). Which of the two the reply leaves out.
const HEARD = /\b(understand|totally|of course|makes (?:total |perfect )?sense|i get (?:it|that)|get it|fair enough|great question|good question|love that|want(?:ing)? to (?:try|see|feel)|try (?:\w+ ){0,3}on|in person|before (?:you )?(?:buy|order|commit|decide))\b/i;
const RETURNS = /\b(returns?|returned|returning|exchanges?|guarantee|money[- ]back|risk[- ]free)\b/i;
export function storeAskMisses({ text = "", ...ask } = {}) {
  if (!firstStoreAsk(ask)) return [];
  const t = String(text || "");
  return [...(HEARD.test(t) ? [] : ["heard"]), ...(RETURNS.test(t) ? [] : ["returns"])];
}

// The catalog's product line names, worked out once per catalog.
const lineNameCache = new WeakMap();
function lineNamesOf(catalog) {
  if (!catalog) return [];
  if (!lineNameCache.has(catalog)) lineNameCache.set(catalog, productLineNames(catalog.products || []));
  return lineNameCache.get(catalog);
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
  const titles = (products) => [...new Set(products.map((p) => p.title))].slice(0, 4).join("; ");
  const exact = found.filter((f) => !f.close);
  if (exact.length) {
    const lines = exact.slice(0, 3).map(({ code, products }) => `"${code.toUpperCase()}" is this store's product code for: ${titles(products)}`);
    return `(${lines.join(". ")}. It's a product, not an order number — search it with product search, query "${exact[0].code}".)`;
  }
  // Not one of the store's codes, but one typo away from some: the closest.
  const typed = found[0].typed.toUpperCase();
  const lines = found.slice(0, 3).map(({ code, products }) => `"${code.toUpperCase()}": ${titles(products)}`);
  return `("${typed}" isn't exactly one of this store's product codes. The closest ${found.length === 1 ? "is" : "are"} ${lines.join("; ")}. It's most likely a product code with a small difference (a box or an old order can print it slightly differently) — search the closest with product search, query "${found[0].code}", show it, and say it's the closest match to "${typed}". Don't say nothing matched.)`;
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

// Only questions (tap choices allowed at the end): "Want help finding shoes
// for it?" — a closing line, not an answer.
const sentencesOf = (t) => String(t || "").replace(/<<[^>]*>>/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
const onlyQuestions = (t) => { const s = sentencesOf(t); return s.length > 0 && s.every((x) => /\?["'”’)]*$/.test(x.trim())); };
// Text that says a lookup is coming ("Great question — let me check").
const ANNOUNCES = /\b(let me|i'?ll (check|look|pull|find|search|grab|see)|one (moment|sec)|just a (moment|sec)|give me a (moment|sec)|checking|looking (that|this|it|those|these) up)\b/i;

// The reply written with the cards ("It works in everyday shoes and
// sneakers…") is often followed by one more step's short closing question
// ("Want help finding shoes to go with it?"). That question alone would drop
// the answer, so the two are kept together. A full new reply replaces it.
export function joinClosingQuestion(prior, said) {
  const p = String(prior || "").trim();
  const t = String(said || "").trim();
  if (!p || !t || p === t || p.includes(t) || t.includes(p)) return t;
  if (FILLER.test(p) || ANNOUNCES.test(p) || onlyQuestions(p)) return t;
  if (t.length > 220 || !onlyQuestions(t)) return t;
  return `${p}\n\n${t}`;
}

// The customer asked something and the reply only asks back, with no tap
// choices ("Would you like help finding shoes?" to "What shoes does this
// work in?"). A real clarifying question comes with choices to tap.
const ASKED = /\?\s*$|^(what|which|how|does|do|is|are|can|could|will|would|should|where|when|why|who)\b/i;
export function onlyAsksBack(text, latestUserMessage) {
  const t = String(text || "").trim();
  const u = String(latestUserMessage || "").trim();
  if (!ASKED.test(u) || u.split(/\s+/).length < 3) return false;
  if (/<<[^>]+>>/.test(t) || t.length > 220) return false;
  return onlyQuestions(t);
}

// Colors the shopper named this turn ("the Rebecca in size 10 burgundy") that
// the reply neither mentions nor shows — swapped for other colors in their
// size without a word about the one they asked for. Live store, 2026-10-27:
// Burgundy was sold out in 10; the reply showed Black, Dark Brown and Leopard
// "ready in size 10" and never said so. The store's own color names, longest
// first ("dark brown" before "brown"); "not black", "other than black" and
// "Black Friday" don't count.
const normWords = (s) => String(s || "").toLowerCase().replace(/[_\-–—/]+/g, " ").replace(/\s+/g, " ").trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w) => new RegExp(`(^|[^a-z])${escRe(w).replace(/ /g, "\\s+")}([^a-z]|$)`);
export function missedColors({ message, text, shownColors = [], colorNames = [] }) {
  let rest = normWords(message).replace(/\bblack friday\b/g, " ");
  if (!rest) return [];
  const names = [...new Set(colorNames.map(normWords).filter((c) => c.length >= 3 && containsColorWord(c)))].sort((a, b) => b.length - a.length);
  const asked = [];
  for (const c of names) {
    if (!wordRe(c).test(rest)) continue;
    const negated = new RegExp(`\\b(?:not|no|except|besides|without|other than|anything but|instead of)\\s+(?:the\\s+|a\\s+|in\\s+)?${escRe(c).replace(/ /g, "\\s+")}\\b`).test(rest);
    if (!negated) asked.push(c);
    rest = rest.replace(new RegExp(wordRe(c).source, "g"), " ");
  }
  const said = normWords(text);
  const shown = shownColors.map(normWords).join(" | ");
  return asked.filter((c) => !wordRe(c).test(said) && !wordRe(c).test(shown));
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

// One page of "View all", for the sheet's page buttons: the same search,
// ranked the same way, as cards.
export function viewAllPage(catalog, search, page) {
  const r = pageOf(allMatches(catalog, search), page);
  return { page: r.page, pages: r.pages, total: r.total, pageSize: r.pageSize, products: r.items.map((p) => toCard(p)) };
}

// The sheet's filters: every match, indexed (view-all-index.js).
export function viewAllIndex(catalog, search) {
  return buildViewAllIndex(allMatches(catalog, search));
}

// Cards for the handles the sheet is about to show (after filtering), in
// the order asked. Unknown handles are left out.
export const VIEW_ALL_CARDS_MAX = 48;
export function viewAllCards(catalog, handles = []) {
  const byHandle = new Map((catalog?.products || []).map((p) => [p.handle, p]));
  const seen = new Set();
  const out = [];
  for (const h of handles) {
    if (out.length >= VIEW_ALL_CARDS_MAX) break;
    const p = typeof h === "string" && !seen.has(h) ? byHandle.get(h) : null;
    if (!p) continue;
    seen.add(h);
    out.push(toCard(p));
  }
  return out;
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
    // Fit confidence: the style's score ({ s, l, r, n }), when there is one.
    ...(p.fit ? { fit: p.fit } : {}),
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
  // The seasonal button's collection { handle, title, label } when its
  // products are known (catalog.collections), else null.
  featured = null,
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

  const featuredOn = Boolean(featured?.handle && catalog?.collections?.has(featured.handle));
  const baseTools = buildLeanTools(catalog?.vocab || {}, { similar: similarAttributes.length > 0, collection: featuredOn ? featured : null });
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
      // Its own products and the ones it offers for wide (or narrow) feet.
      markSeen(resultHandles(result));
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
      const feet = Object.entries(result).find(([k]) => /^also_for_\w+_feet$/.test(k));
      log(`[lean] search ${JSON.stringify(input)} → total=${result.total_matches} returned=${result.products.length}${result.if_relaxed ? ` if_relaxed=${JSON.stringify(result.if_relaxed)}` : ""}${feet ? ` ${feet[0]}=${feet[1].styles}` : ""}`);
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
    if (name === "get_colorways") {
      const r = styleColorways(catalog, input);
      markSeen(r.styles.flatMap((st) => [...st.colors, ...(st.also_for_wide_feet || []), ...(st.also_for_narrow_feet || [])].map((c) => c.handle)));
      for (const st of r.styles) topic("product", st.style);
      log(`[lean] colorways ${JSON.stringify(input)} → ${r.styles.map((st) => `${st.style}: ${st.colors.length}`).join("; ") || "none"}`);
      return {
        ...r,
        note: "Each color is its own product: show the ones the customer wants with show_products (up to 4 cards). For other or more colors, show colors they haven't seen yet.",
      };
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
      return r?.found ? { found: true, info: r.text } : { found: false, note: "No store info for these words. If it could be worded differently (another word, the policy's name), search once more. If there's still nothing, say plainly you don't have that detail — don't guess — share what you do know that helps, and offer customer service." };
    }
    if (name === "contact_support") {
      supportRequested = String(input.reason || "").slice(0, 200) || "customer needs help";
      topic("support", "");
      log(`[lean] support button: ${supportRequested}`);
      return { ok: true, note: "A button to reach customer service is shown under your reply. Tell the customer briefly." };
    }
    const ext = extraByName.get(name);
    // "L820" is a product code here, not an order number: send Claude to the product.
    const codeAsOrder = name === "get_my_orders" && input?.orderNumber ? codesInText(catalog, input.orderNumber, { close: false }) : [];
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
    // The reply written in an earlier step — with the cards, or alongside a
    // lookup when cards came after it — kept if this step only adds a
    // closing question.
    const before = draft || (shown.length ? earlier : "");
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

    text = said ? joinClosingQuestion(before, joinContinuation(earlier, said)) : draft;
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
    if (onlyAsksBack(text, latestUserMessage)) {
      const asked = String(latestUserMessage).trim().replace(/[<>]/g, "").slice(0, 120);
      issues.push({
        code: "unanswered_question",
        detail: `The customer asked "${asked}" and your reply only asks them something back. Answer their question first, in a sentence or two from the facts (look them up if you need to) — then offer a next step if you like. If you truly can't answer without knowing something, ask it with tap choices.`,
      });
    }
    // Only colors the shown styles are made in: the shopper asked for this
    // style in that color, and the reply went to its other colors.
    const shownStyles = new Set(shown.map((h) => String(byHandle.get(h)?.style || "").toLowerCase()).filter(Boolean));
    const missed = shownStyles.size ? missedColors({
      message: latestUserMessage,
      text,
      shownColors: shown.flatMap((h) => byHandle.get(h)?.colors || []),
      colorNames: (catalog?.products || []).filter((p) => shownStyles.has(String(p.style || "").toLowerCase())).flatMap((p) => p.colors || []),
    }) : [];
    if (missed.length) {
      const c = missed.join(" / ");
      issues.push({
        code: "missed_color",
        detail: `The customer asked for ${c}, but your reply doesn't mention ${c} and none of the cards is ${c}. If they want ${c}: look it up (get_product_details, or get_colorways with their size) and say plainly in your first sentence whether it comes in their size — if it's sold out in their size, say so and name the sizes it does have in stock — and show it; then offer other colors in their size. Don't swap their color for others without saying so. If they didn't mean the color (e.g. "not ${c}"), keep your reply.`,
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
    // Asked about stores for something the store sells, got the locator but
    // no products: the full range is online — show some they can order now.
    const shopping = events.some((e) => e?.type === "map_cta") && shown.length === 0 ? shoppingFor(latestUserMessage, catalog?.vocab) : "";
    if (shopping) {
      issues.push({
        code: "locator_without_products",
        detail: storeLocatorConfig(config)?.stores === "scanner"
          // Its stores have the foot scanner; only some sell the shoes.
          ? `You showed the store locator, but no products. They're shopping for ${shopping}: also show a few they can order online right now (search_products, then show_products), and keep the door open online in one short sentence — the full range, every style, color, size and width, is online, ready to order right here.`
          : `You showed the store locator, but no products. They're shopping for ${shopping}: also show a few they can order online right now (search_products, then show_products), and say warmly that each store picks its own selection while the full range — every style, color, size and width — is online, ready to order right here.`,
      });
    }
    // A first ask to try on or buy a style in person, at a store whose
    // locator shows foot-scanning locations: help buying here — no map, no
    // scanner locations (a map already shown is taken back).
    if (storeTooSoon({ scannerStores: storeLocatorConfig(config)?.stores === "scanner", messages, latestUserMessage, text, mapShown: events.some((e) => e?.type === "map_cta") })) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "map_cta") events.splice(i, 1);
      issues.push({
        code: "store_too_soon",
        detail: "They asked about trying on or buying a style in person, for the first time. Don't mention stores, the store locator, the map, foot scanners or scanner locations in this reply — its locations are for foot scans and orthotics, and most don't carry the shoes (the map is only for when they insist, or want a scan). Help them buy with confidence right here, like the store's best associate: if it's the size or fit they want to be sure of, you can help now — True Fit for their size in the shoe (open_true_fit, when you have it); easy returns as the store's info says them (search_store_info); the style itself, ready to order; then an inviting next step with tap choices.",
      });
    }
    // That first ask deserves a person's answer: heard, and the risk taken
    // away — never just "tap the button".
    const misses = storeAskMisses({ scannerStores: storeLocatorConfig(config)?.stores === "scanner", messages, latestUserMessage, text });
    if (misses.length) {
      issues.push({
        code: "store_ask_reply",
        detail: `They'd like to try it on in person, and your reply ${misses.includes("heard") ? "doesn't show you heard that" : ""}${misses.length === 2 ? " and " : ""}${misses.includes("returns") ? "doesn't take the risk away" : ""}. Answer like a friendly, professional associate, in 3-4 short, warm sentences: first acknowledge it in your own words ("Totally understand wanting to try the Charlotte on first — fit is everything with shoes."); then, if it's the size or fit they're unsure about, you can help right now — True Fit finds their size in that shoe in about a minute; then that ordering here is easy to undo — the returns as the store's info says them (search_store_info, only what it actually says); then a warm next step with tap choices. Never just "tap the button".`,
      });
    }
    // Free shipping said of a product the store's offer doesn't name.
    for (const m of misappliedShipping({ text, knowledgeText, lineNames: lineNamesOf(catalog) })) {
      issues.push({
        code: "offer_wrong_product",
        detail: `Your reply says ${m.line} ships free, but the store's free-shipping offer covers only the products it names: "${m.offers.join(" / ").slice(0, 300)}". ${m.line} isn't one of them — don't say it ships free. Quote the offer as written (which products it covers), or leave it out.`,
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
  // that search in the chat, a page at a time (each with its own Add to cart).
  let viewAll = null;
  if (shopAllSearch) {
    const all = allMatches(catalog, shopAllSearch);
    const shownSet = new Set(cards.map((c) => c.handle));
    if (all.length > cards.length && all.some((p) => !shownSet.has(p.handle))) {
      const first = pageOf(all, 1);
      viewAll = {
        ...viewAllWords(shopAllSearch, all.length, { collectionTitle: shopAllSearch.collection ? catalog.collections?.get(shopAllSearch.collection)?.title || "" : "" }),
        total: all.length,
        pageSize: first.pageSize,
        search: cleanViewAllSearch(shopAllSearch),
        products: first.items.map((p) => toCard(p)),
      };
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
