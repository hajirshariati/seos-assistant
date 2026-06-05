// Policy / Knowledge Engine.
//
// Owns turns where the customer is asking about merchant policy or
// service information — return policy, shipping, warranty,
// exchanges, tracking, discounts, services, store terms. The
// answer comes from the merchant's admin-uploaded KnowledgeFile /
// KnowledgeChunk rows (via the existing retrieveRelevantChunks
// path), NEVER from hardcoded code constants and NEVER from a
// product search. If the relevant knowledge is absent or weakly
// matched, the engine says so honestly and points the customer at
// support — it does NOT invent specifics like fee amounts or
// return windows.
//
// Flag PRODUCT_TURN_ENGINE_ENABLED gates production use (same flag
// as the product engine). Default OFF.
//
// Pipeline:
//   1. detectPolicyIntent — classify the turn shape (generic
//      patterns, no shop-specific terms).
//   2. retrieveFn — caller supplies the chunks (the existing
//      retrieveRelevantChunks call already runs once per request;
//      caller passes its result in via options.retrievedChunks
//      OR via options.retrieveFn for fixture tests).
//   3. selectRelevantChunks — pick the chunk(s) whose similarity
//      crosses a confidence floor AND whose fileType is policy-
//      adjacent (faqs / policy / shipping / returns / etc).
//   4. composePolicyAnswer — name the topic, quote the strongest
//      match, cite the source section title, OR admit gracefully.

const POLICY_INTENT_PATTERNS = {
  return_policy: /\b(?:return\s+policy|can\s+i\s+return|how\s+(?:do\s+i\s+)?return|do\s+you\s+(?:have|accept|allow|take|do)\s+returns?|returns?\s+(?:work|process|window|period|policy)|how\s+long\s+(?:do\s+i\s+have\s+)?to\s+return)\b/i,
  return_fee:    /\b(?:return\s+fee|restocking\s+fee|returns?\s+(?:charge|cost)|do\s+you\s+charge\s+(?:a\s+)?(?:fee|for\s+returns?)|free\s+returns?|return\s+shipping\s+cost)\b/i,
  shipping:      /\b(?:shipping(?:\s+(?:policy|cost|fee|time|takes?|options?|rate))?|how\s+(?:long|much)\s+(?:does\s+|is\s+)?(?:shipping|delivery)|delivery(?:\s+(?:time|cost|fee))?|how\s+long\s+(?:does\s+it\s+take|until\s+(?:i\s+get|it\s+arrives?))|free\s+shipping)\b/i,
  warranty:      /\b(?:warranty|guarantee(?:d)?\b|defects?|covered\s+for|how\s+long\s+(?:is|does)\s+(?:the\s+)?warranty)\b/i,
  exchanges:     /\b(?:exchange|swap|trade(?:\s+in)?|wrong\s+size|different\s+size|change\s+(?:the\s+|my\s+)?size|change\s+(?:the\s+|my\s+)?order|cancel\s+(?:and\s+reorder|my\s+order|the\s+order|this\s+order|my\s+(?:existing\s+)?order)|modify\s+(?:my\s+|the\s+)?order|refund\s+(?:will\s+|show\s+)|order\s+change|reorder)\b/i,
  tracking:      /\b(?:track(?:ing)?\s+(?:my\s+)?(?:order|package|shipment)|where(?:'s|\s+is)\s+my\s+order|order\s+(?:status|tracking)|tracking\s+(?:number|info))\b/i,
  // Discounts policy — limited to questions about discount/promo/coupon
  // MECHANISMS (codes, eligibility, terms). Product-browse questions
  // like "what's on sale" / "show me sale shoes" must NOT match: those
  // are product retrieval turns the engine answers with actual cards
  // filtered by _onSale=true. Live failure 2026-06-04: "What's
  // currently on sale?" was matching this regex via bare \bsales?\b
  // and getting a "I don't have discount policy details" admit
  // instead of a list of on-sale products.
  //
  // Keeps in scope:
  //   "promo code" / "coupon" / "coupons"
  //   "first-time customer discount"
  //   "discount policy" / "discount code"
  //   "do you offer/have any discount/promo/coupon"
  //   "how do I apply / use / enter a discount"
  //   "what's your discount" (asking about policy)
  // Lets fall through to product engine:
  //   "what's on sale?"  "show me sale items"  "anything on sale"
  //   "sale shoes"  "on-sale wedges"  "clearance shoes"
  discounts:     /\b(?:promo(?:tion)?s?\s+code|coupons?\b|first[\s-]?(?:time\s+)?(?:order|customer)\s+(?:discount|off)|discount\s+(?:policy|code|details|window)|do\s+you\s+(?:offer|have)\s+(?:any\s+)?(?:discounts?|promos?|coupons?)|how\s+(?:do\s+i|can\s+i|to)\s+(?:get|use|apply|enter)\s+(?:a\s+|the\s+)?(?:discount|coupon|promo)|what(?:'s|\s+is)\s+your\s+discount)\b/i,
  services:      /\b(?:do\s+you\s+(?:offer|have)\s+(?:fitting|measurement|consultation|service|in[\s-]store)|services?\b|fittings?|consultation|in[\s-]store\s+(?:experience|visit|pickup))\b/i,
  terms:         /\b(?:terms\s+(?:of\s+(?:service|use)|and\s+conditions)|privacy\s+policy|cookie\s+policy|legal)\b/i,
};

// Keys that map to the KnowledgeFile.fileType / KnowledgeChunk.fileType
// the chunks live under. Defaults — merchant can upload knowledge
// under any fileType; the policy engine accepts a chunk as
// policy-adjacent if its fileType is in this list OR if its
// section title obviously matches the intent.
const POLICY_FILE_TYPES = new Set([
  "faqs", "policy", "policies", "returns", "shipping", "warranty",
  "terms", "support", "info", "service",
]);

// Similarity floors. Above HIGH we treat the chunk as a confident
// answer and quote it. Between LOW and HIGH we use it but caveat.
// Below LOW we admit we don't have the specific detail.
const HIGH_CONFIDENCE = 0.55;
const LOW_CONFIDENCE  = 0.35;

export function detectPolicyIntent(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const matches = [];
  for (const [key, re] of Object.entries(POLICY_INTENT_PATTERNS)) {
    if (re.test(text)) matches.push(key);
  }
  if (matches.length === 0) return null;
  // Most specific first when multiple match (e.g. "return fee"
  // also matches return_policy). Order via the keys array so the
  // more-specific intents win.
  const priority = ["return_fee", "return_policy", "exchanges", "tracking", "discounts", "shipping", "warranty", "services", "terms"];
  const primary = priority.find((k) => matches.includes(k)) || matches[0];
  return { primary, matches };
}

// Public entry.
// Args:
//   ctx                 — { shop, latestUserMessage, ... }
//   options.retrievedChunks — chunks the request already retrieved
//                             (chat.jsx runs retrieveRelevantChunks
//                             once per request and forwards the
//                             result).
//   options.retrieveFn  — optional async (query) => chunks[],
//                         used by the fixture tests. Falls back
//                         to retrievedChunks when absent.
//   options.forceEnable — bypass env flag for eval mode.
export async function runPolicyTurn(ctx = {}, options = {}) {
  const forceEnable = !!options.forceEnable;
  if (!forceEnable && String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() !== "true") {
    return null;
  }

  const diagnostics = { rungs: [] };
  const intent = detectPolicyIntent(ctx.latestUserMessage || "");
  if (!intent) {
    diagnostics.rungs.push("declined:not_policy");
    return { decline: true, diagnostics };
  }
  diagnostics.intent = intent;

  // Pull chunks. Caller passes the pre-resolved result OR a fetch
  // function for offline tests.
  let chunks = Array.isArray(options.retrievedChunks) ? options.retrievedChunks : null;
  if (chunks == null && typeof options.retrieveFn === "function") {
    try {
      chunks = await options.retrieveFn(ctx.latestUserMessage || "");
    } catch (err) {
      console.warn(`[policy-engine] retrieveFn failed: ${err?.message || err}`);
      chunks = [];
    }
  }
  if (!Array.isArray(chunks)) chunks = [];
  diagnostics.rungs.push(`chunks:${chunks.length}`);

  const relevant = selectRelevantChunks(chunks, intent);
  diagnostics.rungs.push(`relevant:${relevant.length}`);
  diagnostics.topSimilarity = relevant[0]?.similarity ?? null;

  const composed = await composePolicyAnswer({
    intent,
    relevant,
    latestUserMessage: ctx.latestUserMessage || "",
    supportUrl: ctx.supportUrl || "",
    supportLabel: ctx.supportLabel || "",
    trackingPageUrl: ctx.trackingPageUrl || "",
    returnsPageUrl: ctx.returnsPageUrl || "",
    synthesizeFn: typeof options.synthesizeFn === "function" ? options.synthesizeFn : null,
  });
  diagnostics.composer = composed.reason;

  // Deterministic per-intent follow-up suggestions. These are
  // shaped like the LLM follow-up generator's output so the SSE
  // contract is identical — widget renders them as quick-reply
  // chips. NEVER product-specific. NEVER medical advice.
  const followUps = buildPolicyFollowUps(intent.primary);
  diagnostics.followUps = followUps.length;

  // Policy turns NEVER emit product cards. Always set products=[]
  // so the SSE stream clears any stale carded state.
  return {
    decline: false,
    intent,
    products: [],
    answerText: composed.text,
    cta: composed.cta || null,
    followUps,
    diagnostics,
  };
}

// Per-intent generic next-question chips. Code-owned (deterministic),
// merchant-agnostic, and NEVER reference specific products. They give
// the customer a natural next step after a policy answer without
// requiring an LLM call.
//
// Intent shapes are organized so the next likely customer move is
// covered. Add more here if a merchant flags a pattern as missing.
const POLICY_FOLLOW_UPS = {
  return_policy: [
    "Is there a return fee?",
    "Can I exchange instead?",
    "How do I start a return?",
  ],
  return_fee: [
    "What's your return window?",
    "Do you offer free returns on defective items?",
    "How do I start a return?",
  ],
  shipping: [
    "Do you offer expedited shipping?",
    "Can I track my order?",
    "Do you ship internationally?",
  ],
  warranty: [
    "What does the warranty cover?",
    "How do I file a warranty claim?",
    "Is there a guarantee on fit?",
  ],
  exchanges: [
    "How long do I have to exchange?",
    "Is there an exchange fee?",
    "What's your return policy?",
  ],
  tracking: [
    "When will my order arrive?",
    "Can I change my delivery address?",
    "What if my package is lost?",
  ],
  discounts: [
    "Do you have a first-time customer discount?",
    "Is there a sale or clearance section?",
    "Do you offer free shipping?",
  ],
  services: [
    "Do you offer fitting consultations?",
    "Where are your stores located?",
    "What's your warranty policy?",
  ],
  terms: [
    "What's your return policy?",
    "What's your privacy policy?",
    "How do I contact support?",
  ],
};

function buildPolicyFollowUps(intentKey) {
  const list = POLICY_FOLLOW_UPS[intentKey];
  return Array.isArray(list) ? list.slice(0, 3) : [];
}

export function selectRelevantChunks(chunks = [], intent) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const ranked = chunks
    .filter((c) => {
      // Treat any chunk that scored above LOW_CONFIDENCE as a
      // candidate. Then prefer policy-adjacent fileTypes / titles.
      const sim = Number(c?.similarity);
      return Number.isFinite(sim) && sim >= LOW_CONFIDENCE;
    })
    .map((c) => {
      const sim = Number(c.similarity);
      const ftype = String(c.fileType || "").toLowerCase().trim();
      const title = String(c.sectionTitle || "").toLowerCase();
      const policyAdjacent =
        POLICY_FILE_TYPES.has(ftype) ||
        intentMatchesTitle(intent.primary, title);
      // Boost policy-adjacent chunks so a returns FAQ section
      // ranks above a product description that incidentally
      // mentioned "return."
      return { ...c, _adjBoost: policyAdjacent ? 0.15 : 0, _score: sim + (policyAdjacent ? 0.15 : 0) };
    })
    .sort((a, b) => b._score - a._score);
  return ranked.slice(0, 3);
}

function intentMatchesTitle(intentKey, lowerTitle) {
  if (!lowerTitle) return false;
  const map = {
    return_policy: /returns?\b/,
    return_fee:    /returns?\s+(?:fee|cost|charge)|restocking/,
    shipping:      /shipping|delivery/,
    warranty:      /warranty|guarantee/,
    exchanges:     /exchange/,
    tracking:      /track|order\s+status/,
    discounts:     /discount|promo|coupon|sale/,
    services:      /service|fitting|in[\s-]?store/,
    terms:         /terms|privacy|legal/,
  };
  const re = map[intentKey];
  return re ? re.test(lowerTitle) : false;
}

export async function composePolicyAnswer({
  intent, relevant, supportUrl = "", supportLabel = "", trackingPageUrl = "", returnsPageUrl = "",
  latestUserMessage = "", synthesizeFn = null,
}) {
  // Contact-support CTA (rendered as a button by the widget).
  // ONLY when supportUrl is configured — we NEVER invent a URL.
  // Kind "external_link" tells the dispatcher to forward this
  // {url,label} verbatim into the SSE link chunk (no URL building).
  //
  // Label normalization (2026-06-03 live failure: button rendered
  // "Contact Contact customer service" because the merchant's
  // supportLabel already starts with "Contact"):
  //   - If supportLabel is configured AND begins with "Contact",
  //     use it verbatim (no double-prefix).
  //   - If supportLabel is configured but doesn't start with
  //     "Contact", prepend "Contact " so the button reads as a
  //     call to action.
  //   - If supportLabel is missing, fall back to a neutral
  //     "Contact customer support".
  const contactCta = supportUrl
    ? {
        kind: "external_link",
        label: normalizeContactLabel(supportLabel),
        url: supportUrl,
        scopeSource: "policy_support_url",
      }
    : null;

  const trackingUrl = String(trackingPageUrl || "").trim();
  if (intent?.primary === "tracking" && trackingUrl) {
    return {
      text:
        `You can track your order from the tracking page. ` +
        `Use the button below, and have your order number or confirmation email handy if the page asks for it.`,
      reason: "tracking_page_url",
      cta: {
        kind: "external_link",
        label: "Track order",
        url: trackingUrl,
        scopeSource: "policy_tracking_page_url",
      },
    };
  }

  const returnsUrl = String(returnsPageUrl || "").trim();
  const returnPortalIntents = new Set(["return_policy", "return_fee", "exchanges"]);
  const returnPortalCta = returnsUrl && returnPortalIntents.has(intent?.primary)
    ? {
        kind: "external_link",
        label: intent.primary === "exchanges" ? "Start exchange or return" : "Start a return",
        url: returnsUrl,
        scopeSource: "policy_returns_page_url",
      }
    : null;
  const primaryCta = returnPortalCta || contactCta;

  // No relevant chunks → honest "I don't have that specific
  // detail" line. Avoid putting the raw URL in the body when a CTA
  // button is emitted — duplicate URLs look broken. When CTA
  // exists, just refer to the button; otherwise fall back to a
  // generic "contact support" line.
  if (!relevant || relevant.length === 0) {
    const supportSuffix = returnPortalCta
      ? ` For an authoritative answer, please use the button below.`
      : contactCta
        ? ` For an authoritative answer, please use the contact button below.`
        : ` For an authoritative answer, please contact support directly.`;
    const topic = humanizeIntent(intent.primary);
    return {
      text:
        `I don't have the specific ${topic} detail in my notes.` +
        supportSuffix,
      reason: "no_relevant_knowledge",
      cta: primaryCta,
    };
  }

  const top = relevant[0];
  const topSim = Number(top.similarity);
  const confident = topSim >= HIGH_CONFIDENCE;

  // Targeted synthesis. When the dispatcher provides a synth function
  // (Haiku-backed in production), use it to author a SHORT answer
  // that addresses the customer's specific question instead of dumping
  // the entire Q&A block. Customer feedback 2026-06-03: verbatim
  // policy block-dumps read as walls of text and don't answer
  // compound questions ("warranty + exchange + return shipping") in
  // a focused way. Falls back to the verbatim stitch when synth is
  // unavailable, errors, or returns nothing.
  if (typeof synthesizeFn === "function" && latestUserMessage) {
    try {
      const synth = await synthesizeFn({
        latestUserMessage,
        intent,
        relevantChunks: relevant,
        haveContactButton: !!primaryCta,
      });
      const synthText = String(synth || "").trim();
      if (synthText && synthText.length >= 20) {
        return {
          text: synthText,
          reason: confident ? "knowledge_synthesized" : "knowledge_synthesized_weak",
          cta: primaryCta,
        };
      }
    } catch (err) {
      // Synth failure falls through to verbatim stitch — never
      // blocks the answer.
      console.warn(`[policy-engine] synthesizeFn failed: ${err?.message || err}`);
    }
  }

  // Fallback: stitch chunks verbatim with a short lead. Authoritative
  // merchant wording, capped so very long policies don't dump the
  // whole file. Reached when synth isn't configured (eval mode) or
  // synth threw.
  const body = stitchChunkContent(relevant, { maxChars: 600 });

  const lead = confident
    ? `Here's what we have on ${humanizeIntent(intent.primary)}:`
    : `Here's the closest detail I have on ${humanizeIntent(intent.primary)} — let me know if you want me to confirm anything specifically:`;

  const text = `${lead}\n\n${body}`.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text,
    reason: confident ? "knowledge_confident" : "knowledge_weak_match",
    cta: primaryCta,
  };
}

function stitchChunkContent(relevant, { maxChars = 600 } = {}) {
  const parts = [];
  let used = 0;
  for (const c of relevant) {
    const heading = c.sectionTitle ? `**${c.sectionTitle}**\n` : "";
    const content = String(c.content || "").trim();
    if (!content) continue;
    const segment = heading + content;
    if (used + segment.length > maxChars && parts.length > 0) break;
    parts.push(segment);
    used += segment.length;
    if (used >= maxChars) break;
  }
  return parts.join("\n\n");
}

// Normalize a merchant's support label into a button-ready string.
// Used by composePolicyAnswer + the dispatcher fallback. Pure
// string handling — no env reads, no other dependencies.
export function normalizeContactLabel(supportLabel) {
  const raw = String(supportLabel || "").trim();
  if (!raw) return "Contact customer support";
  // Merchant configured "Contact …" already — use verbatim. Covers
  // "Contact us", "Contact customer service", "Contact support", etc.
  if (/^contact\b/i.test(raw)) return raw;
  return `Contact ${raw}`;
}

function humanizeIntent(intentKey) {
  const map = {
    return_policy: "our return policy",
    return_fee:    "return fees",
    shipping:      "shipping",
    warranty:      "warranty",
    exchanges:     "exchanges",
    tracking:      "order tracking",
    discounts:     "discounts and promotions",
    services:      "our services",
    terms:         "terms of service",
  };
  return map[intentKey] || "that topic";
}

// Exported for tests.
export const __internals = {
  POLICY_INTENT_PATTERNS,
  POLICY_FILE_TYPES,
  HIGH_CONFIDENCE,
  LOW_CONFIDENCE,
  detectPolicyIntent,
  selectRelevantChunks,
  composePolicyAnswer,
  intentMatchesTitle,
  humanizeIntent,
};
