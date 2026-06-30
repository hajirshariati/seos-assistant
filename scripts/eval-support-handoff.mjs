// Support-handoff safety layer — when the bot genuinely can't finish, hand off
// to customer service instead of dead-ending; never on a successful turn.
//
// Run: node scripts/eval-support-handoff.mjs

import assert from "node:assert/strict";
import {
  detectSupportHandoffNeed,
  buildSupportHandoffText,
  supportConfigured,
  normalizedSupportLabel,
  supportChatLabel,
  handoffMetaTextLeak,
  isAccountSupportHandoffRequest,
  buildAccountSupportHandoffText,
  applySupportHandoffContract,
} from "../app/lib/support-handoff.js";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";

// Mirror of the widget's openSupportChat provider priority (Zendesk > Intercom >
// Gorgias > fallback URL). Kept here as the documented contract — the widget IIFE
// can't be imported, so this locks the decision the widget must implement.
function pickSupportTarget({ hasZendesk = false, hasIntercom = false, hasGorgias = false, fallbackUrl = "" } = {}) {
  if (hasZendesk) return "zendesk";
  if (hasIntercom) return "intercom";
  if (hasGorgias) return "gorgias";
  if (fallbackUrl) return { url: fallbackUrl };
  return null;
}

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const ctxOf = (workflow, msg, extra = {}) => ({
  latestUserMessage: msg,
  turnPlan: { workflow },
  supportUrl: "https://aetrex.example/support",
  supportLabel: "Visit Support Hub",
  ...extra,
});
const CARD = { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" };

// ── 1. Explicit human/support request → hard, drop cards ──────────────
check("'I want to talk to customer service' → hard explicit_human_request", () => {
  const h = detectSupportHandoffNeed({ text: "Sure!", ctx: ctxOf("clarification", "I want to talk to customer service"), pool: [CARD] });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "explicit_human_request");
});
check("'can I speak to a human' / 'connect me to customer service' → hard", () => {
  for (const m of ["can I speak to a human?", "connect me to customer service", "I want to contact support"]) {
    assert.equal(detectSupportHandoffNeed({ ctx: ctxOf("browse", m), pool: [] }).mode, "hard", m);
  }
});

// ── 1c. Repeated frustration → hard repeated_frustration ──────────────
check("frustrated + escalated → hard repeated_frustration", () => {
  for (const m of ["are you stupid?", "you're not listening", "I already told you", "this is so annoying", "stop asking"]) {
    const h = detectSupportHandoffNeed({ ctx: ctxOf("condition_recommendation", m), pool: [], frustrationEscalated: true });
    assert.equal(h.mode, "hard", m);
    assert.equal(h.reason, "repeated_frustration", m);
  }
});
check("frustration on the FIRST occurrence (not escalated) does NOT hand off", () => {
  const h = detectSupportHandoffNeed({ ctx: ctxOf("clarification", "this is annoying"), pool: [], frustrationEscalated: false });
  assert.equal(h.mode, null);
});
check("explicit human request still wins over the frustration path", () => {
  const h = detectSupportHandoffNeed({ ctx: ctxOf("browse", "this is annoying, get me a human"), pool: [], frustrationEscalated: true });
  assert.equal(h.reason, "explicit_human_request");
});

// ── 2. Unknown policy → hard policy_no_answer ─────────────────────────
check("unknown policy ('I don't have access') → hard policy_no_answer", () => {
  const h = detectSupportHandoffNeed({
    text: "I don't have access to that information.",
    ctx: ctxOf("policy_account", "Can I use three promo codes with my insurance reimbursement?"),
    pool: [],
  });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "policy_no_answer");
});

// ── 3. Failed product/data answer, no cards → hard dead_end ───────────
check("dead-end text + no cards → hard dead_end_no_answer", () => {
  const h = detectSupportHandoffNeed({
    text: "I don't have access to that information.",
    ctx: ctxOf("named_product_advisory", "is the Xyz any good?"),
    pool: [],
  });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "dead_end_no_answer");
});

// ── 4. Partial availability (width not tracked) → soft, keep card ─────
check("partial availability (width not listed) + card → soft, keep card", () => {
  const text = "I can find the Savannah in Champagne in size 7, but I don't see Wide listed as a separate width option in the data.";
  const h = detectSupportHandoffNeed({ text, ctx: ctxOf("availability", "Do you have Savannah in champagne size 7 wide?"), pool: [CARD] });
  assert.equal(h.mode, "soft");
  assert.equal(h.reason, "partial_availability");
});
check("UNKNOWN availability ('can't verify size … open the product page') + card → soft", () => {
  const text = "I can find the Lina in Navy, but I can't verify size 7 from the data I have here. Open the product page to confirm current size availability.";
  assert.equal(detectSupportHandoffNeed({ text, ctx: ctxOf("availability", "do you have the Lina in a 7?"), pool: [CARD] }).mode, "soft");
});

// ── 5/6/7. Successful / clarification turns → NO handoff ──────────────
check("generic sizing clarification → no handoff", () => {
  const h = detectSupportHandoffNeed({ text: "Which product are you sizing for, and what's your usual size?", ctx: ctxOf("sizing_help", "I need help choosing the right size"), pool: [] });
  assert.equal(h.mode, null);
});
check("successful sale_browse → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Here are some sandals on sale right now.", ctx: ctxOf("sale_browse", "Show me current sales and promotions"), pool: [CARD, CARD] }).mode, null);
});
check("successful comparison → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Pick Savannah for all-day walking — more supportive. Choose Jillian for style.", ctx: ctxOf("comparison", "Which is better, Jillian or Savannah?"), pool: [CARD, CARD] }).mode, null);
});
check("successful exact availability (AVAILABLE) → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Yes — the Jillian is available in Black, size 8.", ctx: ctxOf("availability", "Jillian black size 8?"), pool: [CARD] }).mode, null);
});
check("successful condition recommendation → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "For plantar fasciitis, these have great arch support.", ctx: ctxOf("condition_recommendation", "what helps plantar fasciitis?"), pool: [CARD, CARD] }).mode, null);
});

// ── 8. Validation failure → hard validation_failed ───────────────────
check("validator ok=false → hard validation_failed (even on an answer workflow)", () => {
  const h = detectSupportHandoffNeed({ text: "some uncertain draft", ctx: ctxOf("named_product_advisory", "is the Reagan worth it?"), pool: [], validation: { ok: false } });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "validation_failed");
});
check("qualitySignals.supportHandoffReason=validation_failed → hard", () => {
  assert.equal(detectSupportHandoffNeed({ text: "x", ctx: ctxOf("comparison", "a vs b"), pool: [CARD], qualitySignals: { supportHandoffReason: "validation_failed" } }).mode, "hard");
});

// ── text builder + CTA config ─────────────────────────────────────────
check("hard text is a clean handoff, names customer service, no button word", () => {
  const t = buildSupportHandoffText({ ctx: ctxOf("policy_account", "x"), reason: "dead_end_no_answer", partial: false });
  assert.match(t, /Aetrex customer service/);
  assert.doesNotMatch(t, /\bhttps?:\/\//);
});
check("soft partial text mentions exact fit/width confirmation", () => {
  const t = buildSupportHandoffText({ ctx: ctxOf("availability", "x"), reason: "partial_availability", partial: true });
  assert.match(t, /Aetrex customer service/);
  assert.match(t, /fit or width/i);
});
check("supportConfigured: blank url → false (no fake CTA), real url → true", () => {
  assert.equal(supportConfigured({ supportUrl: "" }), false);
  assert.equal(supportConfigured({ supportUrl: "   " }), false);
  assert.equal(supportConfigured({ supportUrl: "https://x/support" }), true);
});
check("normalizedSupportLabel: custom honored, legacy/blank → 'Visit Support Hub'", () => {
  assert.equal(normalizedSupportLabel({ supportLabel: "Chat with us" }), "Chat with us");
  assert.equal(normalizedSupportLabel({ supportLabel: "Contact customer service" }), "Visit Support Hub");
  assert.equal(normalizedSupportLabel({}), "Visit Support Hub");
});
check("blank supportUrl → text still names customer service (no button implied)", () => {
  const t = buildSupportHandoffText({ ctx: { supportUrl: "" }, reason: "validation_failed", partial: false });
  assert.match(t, /Aetrex customer service/);
});

// ── live-chat button label + provider priority (widget contract) ──────
check("supportChatLabel: link-style defaults → 'Chat with Aetrex Support'", () => {
  assert.equal(supportChatLabel({ supportLabel: "Visit Support Hub" }), "Chat with Aetrex Support");
  assert.equal(supportChatLabel({ supportLabel: "Contact customer service" }), "Chat with Aetrex Support");
  assert.equal(supportChatLabel({}), "Chat with Aetrex Support");
});
check("supportChatLabel: a meaningful custom label is honored", () => {
  assert.equal(supportChatLabel({ supportLabel: "Message our team" }), "Message our team");
});
check("widget openSupportChat priority: Zendesk wins when present", () => {
  assert.equal(pickSupportTarget({ hasZendesk: true, fallbackUrl: "https://x/support" }), "zendesk");
  assert.equal(pickSupportTarget({ hasZendesk: true, hasIntercom: true, hasGorgias: true }), "zendesk");
});
check("widget openSupportChat priority: Intercom/Gorgias before URL", () => {
  assert.equal(pickSupportTarget({ hasIntercom: true, fallbackUrl: "https://x/support" }), "intercom");
  assert.equal(pickSupportTarget({ hasGorgias: true, fallbackUrl: "https://x/support" }), "gorgias");
});
check("widget openSupportChat: falls back to URL only when no provider exists", () => {
  assert.deepEqual(pickSupportTarget({ fallbackUrl: "https://x/support" }), { url: "https://x/support" });
  assert.equal(pickSupportTarget({}), null);
});

// ── 2026-07: support/handoff TEXT CONTRACT (no UI-meta leak, real CTA) ────────
// Bug: "verify I'm a teacher" shipped "[Support Hub button is available above]"
// (internal UI text) and no reliable CTA. The contract makes policy_account /
// customer_service turns deterministic: clean text, no cards, real support CTA,
// no product quick replies.

// Customer-visible text must never carry brackets / button words / UI directions.
function assertCleanHandoffText(t, label) {
  assert.doesNotMatch(t, /[\[\]]/, `${label}: no brackets in "${t}"`);
  assert.doesNotMatch(t, /\bbutton\b/i, `${label}: no "button" in "${t}"`);
  assert.doesNotMatch(t, /\bavailable\s+(?:above|below)\b/i, `${label}: no "available above/below" in "${t}"`);
  assert.doesNotMatch(t, /\b(?:click|use|tap|press|hit)\s+the\s+(?:button|link)\b/i, `${label}: no UI instruction in "${t}"`);
  assert.doesNotMatch(t, /\b(?:button|link|cta)\s+(?:above|below)\b/i, `${label}: no "button above/below" in "${t}"`);
}

check("handoffMetaTextLeak: flags the exact PRD leak + the whole banned list", () => {
  for (const t of [
    "Our team is happy to help with account verification questions. [Support Hub button is available above]",
    "The Support Hub button is available above.",
    "Click the button below to chat.",
    "Use the button above to reach support.",
    "[button] to continue",
    "See the link above for details.",
    "The chat button is available above to talk to us.",
  ]) {
    assert.equal(handoffMetaTextLeak(t), true, `should flag: "${t}"`);
  }
  for (const t of [
    "Aetrex support can help confirm the exact verification requirements for teacher discounts.",
    "Our return policy is 30 days from delivery.",
    "I can help you find supportive sandals.",
  ]) {
    assert.equal(handoffMetaTextLeak(t), false, `should NOT flag: "${t}"`);
  }
});

check("buildAccountSupportHandoffText: context-aware, clean, names Aetrex support", () => {
  const teacher = buildAccountSupportHandoffText({ msg: "What information do I need to provide to verify I'm a teacher?" });
  assert.match(teacher, /teacher discounts/i);
  assert.match(teacher, /Aetrex support/i);
  assertCleanHandoffText(teacher, "teacher");
  const student = buildAccountSupportHandoffText({ msg: "How do I verify a student discount?" });
  assert.match(student, /student discounts/i);
  const order = buildAccountSupportHandoffText({ msg: "I need help with an order that says delivered but I didn't get it." });
  assert.match(order, /order/i);
  const account = buildAccountSupportHandoffText({ msg: "Can someone help me with my account?" });
  assert.match(account, /account/i);
  for (const t of [teacher, student, order, account]) assertCleanHandoffText(t, "handoff copy");
});

// The 4 required regressions. Each asserts the full deterministic contract,
// including the case where the LLM draft LEAKED UI-meta text (the live bug).
// Each routes to a SUPPORT workflow (policy_account or customer_service) — the
// contract handles both identically. `accountSupport` flags the phrasing the
// account/verification/order detector must recognize.
const HANDOFF_CASES = [
  { msg: "What information do I need to provide to verify I'm a teacher?", expect: /teacher/i, accountSupport: true },
  { msg: "I need help with an order that says delivered but I didn't get it.", expect: /order/i, accountSupport: true },
  { msg: "How do I verify a student discount?", expect: /student/i, accountSupport: true },
  { msg: "Can someone help me with my account?", expect: /account/i, accountSupport: true },
];
const SUPPORT_WORKFLOWS = new Set([WORKFLOWS.POLICY_ACCOUNT, WORKFLOWS.CUSTOMER_SERVICE]);
const SUPPORT_CTX = { supportUrl: "https://aetrex.example/support", supportLabel: "Visit Support Hub" };
// The leaky draft an LLM might produce (the exact failure shape).
const LEAKY_DRAFT = "Our team is happy to help with account verification questions. [Support Hub button is available above]";

for (const c of HANDOFF_CASES) {
  check(`handoff contract: "${c.msg.slice(0, 38)}…" → policy/cs route, no search`, () => {
    const plan = planTurn({ message: c.msg });
    assert.ok(SUPPORT_WORKFLOWS.has(plan.workflow), `workflow for "${c.msg}" must be a support workflow, got ${plan.workflow}`);
    assert.equal(plan.searchRequired, false, "searchAttempted/searchRequired must be false");
    assert.equal(plan.productDisplayPolicy, "suppress", "no product cards");
  });

  check(`handoff contract: "${c.msg.slice(0, 38)}…" → clean text + real CTA + no product chips (leaky draft)`, () => {
    const workflow = planTurn({ message: c.msg }).workflow;
    const r = applySupportHandoffContract({ workflow, msg: c.msg, text: LEAKY_DRAFT, ctx: SUPPORT_CTX });
    assert.equal(r.applies, true);
    assert.equal(r.engaged, true, "an account/verification/order turn must engage the contract");
    assert.equal(r.metaLeak, true, "the leaky draft must be detected");
    assert.deepEqual(r.cards, [], "cards.length === 0");
    assert.equal(r.suppressProductQuickReplies, true, "no product-shopping quick replies");
    assert.ok(r.supportCta && r.supportCta.label && r.supportCta.fallbackUrl, "actual support CTA exists");
    assert.equal(r.supportCta.fallbackUrl, SUPPORT_CTX.supportUrl, "CTA falls back to the configured support URL");
    assert.match(r.text, c.expect, `deterministic text mentions the topic`);
    assertCleanHandoffText(r.text, c.msg);
  });

  check(`handoff contract: "${c.msg.slice(0, 38)}…" → clean even when the draft is already clean`, () => {
    const cleanDraft = "Sure, I can point you in the right direction.";
    const workflow = planTurn({ message: c.msg }).workflow;
    const r = applySupportHandoffContract({ workflow, msg: c.msg, text: cleanDraft, ctx: SUPPORT_CTX });
    assert.equal(r.engaged, true);
    assert.deepEqual(r.cards, []);
    assert.ok(r.supportCta, "CTA attached on the engaged handoff");
    assertCleanHandoffText(r.text, c.msg);
  });
}

check("isAccountSupportHandoffRequest: the 4 cases true; a return-policy question false", () => {
  for (const c of HANDOFF_CASES) {
    assert.equal(isAccountSupportHandoffRequest(c.msg), true, `account-support: "${c.msg}"`);
  }
  // An informational policy question is NOT an account-support handoff.
  assert.equal(isAccountSupportHandoffRequest("What is your return policy?"), false);
  assert.equal(isAccountSupportHandoffRequest("How long does shipping take?"), false);
});

check("contract: informational policy answer keeps its text (no leak) but still drops product chips/cards", () => {
  const informative = "Our return policy is 30 days from the delivery date for unworn shoes.";
  const r = applySupportHandoffContract({ workflow: WORKFLOWS.POLICY_ACCOUNT, msg: "What is your return policy?", text: informative, ctx: SUPPORT_CTX });
  assert.equal(r.applies, true);
  assert.equal(r.engaged, false, "a plain informational policy answer does not engage the handoff");
  assert.equal(r.text, informative, "informational text is preserved verbatim");
  assert.deepEqual(r.cards, [], "still no product cards on a policy turn");
  assert.equal(r.suppressProductQuickReplies, true, "still no product quick replies on a policy turn");
});

check("contract: does NOT apply to commerce workflows (browse/availability/comparison)", () => {
  for (const wf of ["browse", "availability", "comparison", "condition_recommendation", "sale_browse"]) {
    assert.equal(applySupportHandoffContract({ workflow: wf, msg: "show me sandals", text: "Here are some sandals." }).applies, false, wf);
  }
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
