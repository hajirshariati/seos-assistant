// Central customer-service handoff safety layer.
//
// When the bot genuinely CANNOT complete a task — an explicit human request, a
// dead-end "I can't verify" with no product to show, an exhausted validator, or
// a policy question with no confident answer — it should hand off to Aetrex
// customer service instead of dead-ending with "I don't know". When it has a
// PARTIAL answer (a product card but one unconfirmable detail), it keeps the
// card and ADDS a soft handoff line.
//
// This is NOT a replacement for good product answers. It must NEVER fire on a
// successful browse / advisory / comparison / sale / exact-availability turn, or
// on a normal clarification — only when the bot is actually unable to finish.
//
// Pure + testable: no DB, no streaming. The chat route owns the side effects
// (text/pool/CTA mutation + SSE); this module only decides and phrases.

const SUPPORT_TEAM = "Aetrex customer service";

// 1. Explicit human / support request.
const HUMAN_REQUEST_RE = new RegExp(
  "\\b(?:talk|speak|chat|connect\\s+me|get\\s+me|put\\s+me\\s+through)\\b[^.?!\\n]{0,30}\\b(?:a\\s+)?(?:human|person|agent|representative|rep|someone|somebody|real\\s+person|customer\\s+(?:service|support|care)|support\\s+team)\\b" + "|" +
  "\\b(?:contact|reach|call|email|message)\\b[^.?!\\n]{0,20}\\b(?:customer\\s+(?:service|support|care)|support|a\\s+human|an\\s+agent|your\\s+team)\\b" + "|" +
  "\\b(?:customer\\s+(?:service|support|care)|support\\s+team|live\\s+(?:agent|chat)|human\\s+agent)\\b",
  "i",
);

// 2/4. Dead-end / non-answer phrasing the model falls back to when it's stuck.
const DEAD_END_RE = new RegExp(
  "\\bi\\s+don'?t\\s+know\\b" + "|" +
  "\\bi\\s+don'?t\\s+have\\s+(?:access|enough\\s+(?:information|info|detail)|that\\s+information|the\\s+details?|a\\s+(?:clear\\s+)?answer)\\b" + "|" +
  "\\bi\\s+can'?t\\s+(?:verify|confirm|access|determine|tell|answer)\\b" + "|" +
  "\\bi'?m\\s+not\\s+able\\s+to\\b" + "|" +
  "\\bi'?m\\s+not\\s+finding\\b[^.?!\\n]{0,30}\\b(?:clean\\s+)?match\\b" + "|" +
  "\\bi\\s+(?:can'?t|cannot)\\s+help\\s+with\\s+that\\b" + "|" +
  "\\bcheck\\s+the\\s+product\\s+page\\s+directly\\b" + "|" +
  "\\bcontact\\s+support\\b|\\bsupport\\s+team\\s+can\\s+help\\b|\\breach\\s+out\\s+to\\s+(?:our|the)\\s+(?:support|customer)\\b",
  "i",
);

// 5. Partial answer — we HAVE a product but flagged one detail we can't confirm.
const PARTIAL_RE = new RegExp(
  "\\bisn'?t\\s+listed\\s+as\\s+a\\s+separate\\b" + "|" +
  "\\bdon'?t\\s+see\\b[^.?!\\n]{0,30}\\b(?:listed\\s+as\\s+a\\s+separate|width\\s+option|as\\s+a\\s+separate\\s+width)\\b" + "|" +
  "\\bcan'?t\\s+(?:verify|confirm)\\b[^.?!\\n]{0,40}\\b(?:size|width|fit|from\\s+the\\s+data|here)\\b" + "|" +
  "\\bopen\\s+the\\s+product\\s+page\\s+to\\s+confirm\\b" +
  "",
  "i",
);

export function supportConfigured(ctx) {
  return Boolean(ctx?.supportUrl && String(ctx.supportUrl).trim());
}

// ── Handoff META-TEXT leak (UI mechanics the LLM must never narrate) ──────────
// The model sometimes describes the widget UI to the customer — "[Support Hub
// button is available above]", "click the button below" (live trace 2026-06-30).
// That bracketed/UI-instruction text is internal and must never ship. This pure
// detector flags it; the chat route replaces the whole reply with deterministic
// handoff copy, attaches the real support CTA, and fires handoff_meta_text_leak.
const HANDOFF_META_TEXT_RE = new RegExp(
  "\\[\\s*support\\s+hub" + "|" +                 // "[Support Hub …"
  "\\[\\s*button" + "|" +                          // "[button …"
  "\\bbutton\\s+is\\s+available\\b" + "|" +
  "\\b(?:available|shown|listed|located)\\s+(?:above|below)\\b" + "|" +
  "\\b(?:click|tap|use|press|hit|see)\\s+(?:the|this)\\s+(?:button|link|cta|chat\\s+button)\\b" + "|" +
  "\\b(?:button|link|cta)\\s+(?:above|below)\\b" + "|" +
  "\\[[^\\]]*\\b(?:button|link|cta|support\\s+hub|live\\s+chat)\\b[^\\]]*\\]",  // any bracketed UI ref
  "i",
);
export function handoffMetaTextLeak(text) {
  return HANDOFF_META_TEXT_RE.test(String(text || ""));
}

// A SUPPORT / VERIFICATION / ACCOUNT / ORDER request that the bot can't answer
// from catalog or policy knowledge and must deterministically hand to a human:
// discount-program verification/eligibility (teacher/student/nurse/military/
// ID.me), account access/help, or an order problem. These get clean deterministic
// copy + the real support CTA (never an LLM-authored answer that invents
// verification steps or narrates the UI). A plain INFORMATIONAL policy question
// ("what's your return policy?") is NOT this — it keeps its informative answer.
const ACCOUNT_SUPPORT_RE = new RegExp(
  // discount / program eligibility & verification
  "\\b(?:verif\\w*|verified|prove|proof|eligib\\w*|qualif\\w*|provide|how\\s+do\\s+i\\s+(?:get|become|sign\\s+up|apply))\\b[^.?!\\n]{0,40}\\b(?:teacher|student|nurse|military|veteran|first[-\\s]?responder|senior|healthcare|educator|id\\.me|sheerid|discount)\\b" + "|" +
  "\\b(?:teacher|student|nurse|military|veteran|first[-\\s]?responder|senior|healthcare|educator)\\b[^.?!\\n]{0,40}\\b(?:verif\\w*|verified|proof|eligib\\w*|qualif\\w*|discount|id\\.me|sheerid)\\b" + "|" +
  // account help / access
  "\\b(?:help|issue|problem|trouble)\\b[^.?!\\n]{0,20}\\bmy\\s+account\\b" + "|" +
  "\\bcan\\s+(?:someone|anyone|you)\\s+help\\s+me\\b[^.?!\\n]{0,25}\\b(?:account|order)\\b" + "|" +
  "\\b(?:log\\s*in|sign\\s*in|reset\\s+my\\s+password|forgot\\s+my\\s+password|locked\\s+out\\s+of\\s+my\\s+account)\\b" + "|" +
  // order help / problem
  "\\b(?:help|issue|problem|trouble|where(?:'?s| is))\\b[^.?!\\n]{0,20}\\b(?:my\\s+)?(?:order|package|shipment|delivery|refund)\\b" + "|" +
  "\\border\\b[^.?!\\n]{0,40}\\b(?:delivered|didn'?t\\s+(?:get|arrive|receive)|never\\s+(?:arrived|came|got)|missing|wrong)\\b",
  "i",
);
export function isAccountSupportHandoffRequest(text) {
  return ACCOUNT_SUPPORT_RE.test(String(text || ""));
}

// THE deterministic support/policy/handoff TEXT CONTRACT (pure). Given the
// workflow, the customer message, the LLM's drafted text, and ctx (for support
// config), decides the final customer-facing shape for policy_account /
// customer_service turns:
//   - applies:false   → not a support/policy turn; caller leaves it alone.
//   - cards:[]                       → these turns never show product cards.
//   - suppressProductQuickReplies    → never "Show me sneakers" chips here.
//   - supportCta                     → the live-chat CTA when ENGAGED + support
//                                      is configured (else null).
//   - text                           → deterministic handoff copy when the turn
//     is an account/verification/order request OR the LLM leaked UI-meta text;
//     otherwise the LLM's (informational) text is kept verbatim.
//   - metaLeak                       → true when the draft contained bracket/UI
//                                      meta text (caller fires handoff_meta_text_leak).
export function applySupportHandoffContract({ workflow = "", msg = "", text = "", ctx = {} } = {}) {
  if (workflow !== "customer_service" && workflow !== "policy_account") {
    return { applies: false };
  }
  const metaLeak = handoffMetaTextLeak(text);
  const isAccountSupport = workflow === "customer_service" || isAccountSupportHandoffRequest(msg);
  const engaged = metaLeak || isAccountSupport;
  // Deterministic copy when the turn is an account/verification/order handoff,
  // OR whenever the draft leaked UI-meta text (we must replace it). A plain
  // informational policy answer with no leak keeps its text.
  const useDeterministicText = metaLeak || (engaged && workflow === "policy_account");
  return {
    applies: true,
    engaged,
    metaLeak,
    isAccountSupport,
    cards: [],
    suppressProductQuickReplies: true,
    supportCta: engaged && supportConfigured(ctx)
      ? { label: supportChatLabel(ctx), fallbackUrl: ctx.supportUrl }
      : null,
    text: useDeterministicText ? buildAccountSupportHandoffText({ msg }) : String(text || ""),
  };
}

// Deterministic, customer-facing handoff copy for an account/verification/order
// support turn. Context-aware (teacher vs student vs order vs account) but never
// names a button or invents the actual verification mechanics — it points to
// the human and the route attaches the live-chat CTA.
export function buildAccountSupportHandoffText({ msg = "" } = {}) {
  const m = String(msg).toLowerCase();
  const team = "Aetrex support";
  const verifyish = /\b(verif\w*|verified|eligib\w*|qualif\w*|discount|proof|prove|provide|id\.me|sheerid|requirement)\b/.test(m);
  if (verifyish && /\b(teacher|educator)\b/.test(m)) {
    return `${team} can help confirm the exact verification requirements for teacher discounts.`;
  }
  if (verifyish && /\bstudent\b/.test(m)) {
    return `${team} can help confirm the exact verification requirements for student discounts.`;
  }
  if (verifyish && /\b(nurse|healthcare|medical)\b/.test(m)) {
    return `${team} can help confirm the exact verification requirements for healthcare discounts.`;
  }
  if (verifyish && /\b(military|veteran|first[-\s]?responder)\b/.test(m)) {
    return `${team} can help confirm the exact verification requirements for that discount program.`;
  }
  if (verifyish && /\bdiscount\b/.test(m)) {
    return `${team} can confirm the exact verification requirements for that discount.`;
  }
  if (/\b(order|package|shipment|delivery|deliver\w*|refund|tracking)\b/.test(m)) {
    return `${team} can look into your order and help sort this out.`;
  }
  if (/\b(account|log\s*in|sign\s*in|password|locked)\b/.test(m)) {
    return `${team} can help you with your account directly.`;
  }
  return `${team} can help you with that directly.`;
}

// Normalize the support CTA label (mirrors the chat-route default): honor a
// real custom label, otherwise the "Visit Support Hub" default. Never the
// stale legacy "Contact customer service" string.
export function normalizedSupportLabel(ctx) {
  const raw = String(ctx?.supportLabel || "").trim();
  const legacy = "Contact customer service";
  if (raw && raw !== legacy) return raw;
  return "Visit Support Hub";
}

// Label for the LIVE-CHAT handoff button (a button that opens Zendesk/Intercom/
// Gorgias, falling back to the Support Hub URL). Honors a meaningful custom
// label, but replaces the link-style defaults with a chat-oriented one.
export function supportChatLabel(ctx) {
  const raw = String(ctx?.supportLabel || "").trim();
  const linkDefaults = new Set(["Contact customer service", "Visit Support Hub"]);
  if (raw && !linkDefaults.has(raw)) return raw;
  return "Chat with Aetrex Support";
}

// Workflows where a question-shaped reply is the bot DOING ITS JOB (asking which
// product to size, etc.), not failing — never a handoff unless the customer
// explicitly asked for a human (handled before this guard).
const CLARIFY_WORKFLOWS = new Set(["clarification", "sizing_help"]);

// Catalog discovery workflows. A 0-card result here is a NO-MATCH to refine
// (closest matches / "tell me more"), NEVER a support handoff. Only true
// order/support/policy turns or repeated unrecoverable failures reach a human.
// Class 5 fix: "show me sandals, not shoes" returned 0 cards (over-rejection,
// now fixed in Class 1) and hard-handed-off to support — wrong for a browse.
const CATALOG_BROWSE_WORKFLOWS = new Set([
  "browse", "sale_browse", "condition_recommendation", "multi_recommendation",
]);

// INVARIANT detector (handoff_on_catalog_browse): a HARD support handoff must
// never be the answer to a normal catalog browse/search turn (other than the
// always-valid explicit-human / repeated-frustration / validation-failed
// reasons, which are intent-driven not browse-driven).
export function handoffOnCatalogBrowse({ mode = null, reason = "", workflow = "" } = {}) {
  if (mode !== "hard") return false;
  if (["explicit_human_request", "repeated_frustration", "validation_failed"].includes(reason)) return false;
  return CATALOG_BROWSE_WORKFLOWS.has(String(workflow || ""));
}

// Decide whether this turn needs a handoff, and which mode.
//   { mode: "hard", reason }  — no reliable answer / no useful cards → replace
//   { mode: "soft", reason }  — partial answer with a card → keep card, add line
//   { mode: null }            — the bot handled it; do nothing
// Bot-directed frustration/abuse. Combined with the caller's escalation flag
// (the customer has been frustrated more than once) this triggers a human
// handoff instead of looping — e.g. a rigid orthotic question chain the
// customer keeps pushing back on (live trace 2026-06-29).
const FRUSTRATION_RE = new RegExp(
  "\\bare\\s+you\\s+(?:stupid|dumb|broken|serious|kidding)\\b" + "|" +
  "\\byou(?:'?re| are)\\s+(?:not\\s+listening|useless|stupid|broken|repeating\\s+yourself)\\b" + "|" +
  "\\bthis\\s+is\\s+(?:so\\s+)?(?:annoying|ridiculous|frustrating|useless|pointless)\\b" + "|" +
  "\\bstop\\s+(?:asking|repeating)\\b" + "|" +
  "\\bi\\s+(?:already\\s+)?(?:told|said)\\s+(?:you|that)\\b" + "|" +
  "\\bwtf\\b",
  "i",
);

export function detectSupportHandoffNeed({
  text = "",
  ctx = {},
  pool = [],
  validation = null,
  qualitySignals = {},
  productSearchAttempted = false,
  frustrationEscalated = false,
} = {}) {
  const msg = String(ctx?.latestUserMessage || "");
  const wf = ctx?.turnPlan?.workflow || "";
  const hasCards = Array.isArray(pool) && pool.length > 0;
  const t = String(text || "");

  // 1. Explicit human/support request — always a hard handoff, any workflow.
  if (HUMAN_REQUEST_RE.test(msg)) return { mode: "hard", reason: "explicit_human_request" };

  // 1b. Repeated frustration — the customer has pushed back more than once AND
  // the latest message is frustrated/abusive toward the bot. Stop looping and
  // offer a human. Checked before the clarify-workflow exemption so a stuck
  // orthotic/clarification chain can still escalate.
  if (frustrationEscalated && FRUSTRATION_RE.test(msg)) {
    return { mode: "hard", reason: "repeated_frustration" };
  }

  // 3. Validator exhausted (ok=false after retries) — hand off rather than ship
  // a bad/uncertain answer. Checked before the clarify-workflow exemption: an
  // exhausted answer-workflow is a real failure, not a clarification.
  if ((validation && validation.ok === false) || qualitySignals?.supportHandoffReason === "validation_failed") {
    return { mode: "hard", reason: "validation_failed" };
  }

  // A normal clarification/sizing question is the bot working, not failing.
  if (CLARIFY_WORKFLOWS.has(wf)) return { mode: null, reason: null };

  // 5. Partial: a product/card exists but the text flagged one unconfirmable
  // detail (width not tracked, can't verify size from the data). Keep the card.
  if (hasCards && PARTIAL_RE.test(t)) return { mode: "soft", reason: "partial_availability" };

  // 4b. Catalog browse/search with no cards is a NO-MATCH to REFINE, never a
  // hard support handoff (Class 5). The explicit-human / repeated-frustration /
  // validation-failed escalations above already covered the real support cases.
  if (!hasCards && CATALOG_BROWSE_WORKFLOWS.has(wf)) {
    return { mode: null, reason: "catalog_no_match_refine" };
  }

  // 2/4. Hard dead-end: non-answer text AND no useful cards to fall back on.
  // (Reached only for non-browse workflows now — policy_account, customer_service, …)
  if (!hasCards && DEAD_END_RE.test(t)) {
    return { mode: "hard", reason: wf === "policy_account" ? "policy_no_answer" : "dead_end_no_answer" };
  }

  return { mode: null, reason: null };
}

// The customer-facing handoff text. HARD = full replacement; SOFT = a sentence
// appended to the existing (kept) answer. Phrasing never names a button — the
// route attaches the CTA only when supportUrl is configured.
export function buildSupportHandoffText({ ctx = {}, reason = "", partial = false } = {}) {
  if (partial) {
    if (reason === "partial_availability") {
      return `For exact fit or width confirmation, ${SUPPORT_TEAM} can help.`;
    }
    return `I can help with the product info I have here, but ${SUPPORT_TEAM} is the best place to confirm that specific detail.`;
  }
  if (reason === "policy_no_answer") {
    return `I don't have a confident answer on that one. ${SUPPORT_TEAM} can sort it out for you and point you to the next step.`;
  }
  if (reason === "explicit_human_request") {
    return `Of course — ${SUPPORT_TEAM} can help you directly from here.`;
  }
  if (reason === "repeated_frustration") {
    return `I'm sorry — I should have been clearer. Let me get ${SUPPORT_TEAM} to help you directly so we can sort this out quickly.`;
  }
  return `I don't want to guess on that. ${SUPPORT_TEAM} can confirm it for you and help with the next step.`;
}
