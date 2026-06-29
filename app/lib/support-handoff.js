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

  // 2/4. Hard dead-end: non-answer text AND no useful cards to fall back on.
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
