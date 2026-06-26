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
} from "../app/lib/support-handoff.server.js";

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

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
