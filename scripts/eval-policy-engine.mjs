// Policy / Knowledge Engine eval.
//
// Pure-offline. retrievedChunks are passed in directly so we
// exercise the engine's intent classification, chunk selection,
// and composer without touching the DB or the embedding service.
//
// Key invariants under test:
//   1. Policy intent shapes are detected as policy turns (not
//      product searches).
//   2. The engine pulls answers FROM the chunks the caller
//      provides — never invents fees, windows, or covered defects.
//   3. When the relevant knowledge is missing or weakly matched,
//      the engine admits the limit honestly and points at support.
//   4. Patterns are GENERIC English — no merchant-specific terms.
//   5. Non-policy turns (product searches) cleanly decline.

import assert from "node:assert/strict";
import {
  runPolicyTurn,
  detectPolicyIntent,
  composePolicyAnswer,
  selectRelevantChunks,
  __internals,
} from "../app/lib/policy-engine.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Policy / Knowledge Engine eval\n");

const ctxBase = {
  shop: "fixture.myshopify.com",
  supportUrl: "https://example.com/support",
  supportLabel: "our support team",
  trackingPageUrl: "https://example.com/track-order",
};

// Chunk fixture — the shape retrieveRelevantChunks returns. These
// are NOT real Aetrex policies; they're test fixtures that prove
// the engine reads FROM the chunks instead of from code constants.
const chunk = ({ similarity, fileType = "faqs", sectionTitle = "", content }) => ({
  id: `chunk-${Math.random().toString(36).slice(2, 8)}`,
  fileType, sectionTitle, content,
  similarity,
});

// ─── intent detection ─────────────────────────────────────────

await test("PE-1 — detects return-policy shape", () => {
  const i = detectPolicyIntent("what is your return policy?");
  assert.equal(i?.primary, "return_policy");
});

await test("PE-2 — 'return fee' is detected as return_fee (more specific than return_policy)", () => {
  const i = detectPolicyIntent("is there a return fee?");
  assert.equal(i?.primary, "return_fee");
});

await test("PE-3 — shipping shapes detect shipping intent", () => {
  for (const q of [
    "how long does shipping take?",
    "what's the shipping cost?",
    "do you offer free shipping?",
    "how much is delivery?",
  ]) {
    const i = detectPolicyIntent(q);
    assert.equal(i?.primary, "shipping", `failed for "${q}"`);
  }
});

await test("PE-4 — warranty / guarantee shapes detect warranty", () => {
  for (const q of [
    "do you have a warranty?",
    "what's your guarantee?",
    "are the shoes guaranteed against defects?",
  ]) {
    const i = detectPolicyIntent(q);
    assert.equal(i?.primary, "warranty", `failed for "${q}"`);
  }
});

await test("PE-5 — 'do you offer discounts?' detects discounts", () => {
  const i = detectPolicyIntent("do you offer any discount?");
  assert.equal(i?.primary, "discounts");
});

await test("PE-6 — 'do you have returns?' (yes/no shape) still detects return_policy", () => {
  const i = detectPolicyIntent("do you have returns?");
  assert.equal(i?.primary, "return_policy");
});

await test("PE-7 — non-policy turns are NOT detected", () => {
  for (const q of [
    "show me sandals for plantar fasciitis",
    "i want pink sandals with arch support",
    "which has the most cushioning like the Jillian?",
    "what other shoes have same support as Danika",
  ]) {
    assert.equal(detectPolicyIntent(q), null, `false positive for "${q}"`);
  }
});

// ─── engine reads FROM chunks (not hardcoded) ──────────────────

await test("PE-8 — return-policy turn quotes the merchant's chunk verbatim", async () => {
  // Fixture: merchant-specific policy. Engine output MUST contain
  // the merchant's wording. If the engine made up a 30-day window
  // instead, this test would fail.
  const merchantPolicy = "We accept returns within 45 days of delivery. A $9 restocking fee applies to non-defective returns.";
  const chunks = [
    chunk({
      similarity: 0.72,
      fileType: "faqs",
      sectionTitle: "RETURN POLICY",
      content: merchantPolicy,
    }),
  ];
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "what is your return policy?" },
    { forceEnable: true, retrievedChunks: chunks },
  );
  assert.ok(!out.decline);
  assert.ok(out.answerText.includes(merchantPolicy),
    `merchant policy text must appear verbatim; got "${out.answerText}"`);
  assert.equal(out.products.length, 0, "policy turns must NOT carry product cards");
});

await test("PE-9 — return-fee question pulls a different merchant chunk (different fee number)", async () => {
  // Different merchant → different fee → composer output differs.
  // Proves the engine never substitutes hardcoded policy facts.
  const chunks = [
    chunk({
      similarity: 0.68,
      fileType: "faqs",
      sectionTitle: "RETURN FEES",
      content: "Returns are free for defective items. A $15 restocking fee applies otherwise.",
    }),
  ];
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "is there a return fee?" },
    { forceEnable: true, retrievedChunks: chunks },
  );
  assert.ok(out.answerText.includes("$15"));
});

await test("PE-10 — different merchant data → different composer output", async () => {
  // Same intent, different merchant chunks → different answer.
  // No hardcoded shipping window survives anywhere in the engine.
  const a = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "shipping?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.7,
          fileType: "faqs",
          sectionTitle: "SHIPPING",
          content: "Standard shipping is 3-5 business days within the US.",
        }),
      ],
    },
  );
  const b = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "shipping?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.7,
          fileType: "faqs",
          sectionTitle: "SHIPPING",
          content: "Express shipping arrives in 1-2 business days for a $25 fee.",
        }),
      ],
    },
  );
  assert.match(a.answerText, /3-5 business days/);
  assert.match(b.answerText, /1-2 business days/);
  assert.notEqual(a.answerText, b.answerText);
});

// ─── honest admission when knowledge is missing ────────────────

await test("PE-11 — discount question with NO matching chunks → admits + emits CTA (no raw URL in text)", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "do you offer any discounts?" },
    { forceEnable: true, retrievedChunks: [] },
  );
  assert.ok(!out.decline);
  assert.match(out.answerText, /don't have/i);
  assert.match(out.answerText, /discounts and promotions/i);
  // The CTA carries the URL — the text should refer to the button,
  // NOT include the raw URL (which would render duplicated and
  // look broken next to the actual button).
  assert.match(out.answerText, /contact button below/i);
  assert.doesNotMatch(out.answerText, /https?:\/\//,
    `text must not include the raw URL when CTA is emitted; got "${out.answerText}"`);
  assert.equal(out.cta?.url, ctxBase.supportUrl);
  assert.equal(out.diagnostics.composer, "no_relevant_knowledge");
});

await test("PE-12 — weak similarity (below floor) → admits", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "what's your warranty?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.22, // below LOW_CONFIDENCE
          fileType: "faqs",
          sectionTitle: "PRODUCT DETAILS",
          content: "Made with premium leather and rubber outsoles.",
        }),
      ],
    },
  );
  assert.match(out.answerText, /don't have/i);
});

await test("PE-13 — weak-but-above-floor → uses with caveat phrasing", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "what's your warranty?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.44, // between LOW and HIGH
          fileType: "faqs",
          sectionTitle: "WARRANTY",
          content: "Defects covered for 12 months from purchase.",
        }),
      ],
    },
  );
  assert.match(out.answerText, /closest detail/i);
  assert.match(out.answerText, /12 months/);
  assert.equal(out.diagnostics.composer, "knowledge_weak_match");
});

// ─── chunk selection prefers policy-adjacent fileType ───────────

await test("PE-14 — policy-adjacent fileType outranks a higher-sim non-policy chunk", () => {
  const ranked = selectRelevantChunks(
    [
      // Higher raw similarity but non-policy fileType.
      chunk({ similarity: 0.62, fileType: "product_descriptions", sectionTitle: "Maui Sandal", content: "Returns? Sure, the Maui returns to the same fit every time." }),
      // Lower raw similarity but a faqs chunk titled "Returns".
      chunk({ similarity: 0.55, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window…" }),
    ],
    { primary: "return_policy" },
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].fileType, "faqs", "policy-adjacent chunk should rank first via adjacency boost");
});

// ─── flag OFF → null ───────────────────────────────────────────

await test("PE-15 — flag unset returns null (production unchanged)", async () => {
  const prev = process.env.PRODUCT_TURN_ENGINE_ENABLED;
  delete process.env.PRODUCT_TURN_ENGINE_ENABLED;
  try {
    const out = await runPolicyTurn(
      { ...ctxBase, latestUserMessage: "what is your return policy?" },
      { retrievedChunks: [chunk({ similarity: 0.9, content: "yo" })] },
    );
    assert.equal(out, null);
  } finally {
    if (prev === undefined) delete process.env.PRODUCT_TURN_ENGINE_ENABLED;
    else process.env.PRODUCT_TURN_ENGINE_ENABLED = prev;
  }
});

// ─── product turn must decline cleanly ──────────────────────────

await test("PE-16 — product-search turn cleanly declines (so product engine takes over)", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "i want pink sandals with arch support" },
    { forceEnable: true, retrievedChunks: [] },
  );
  assert.ok(out.decline);
  assert.ok(out.diagnostics.rungs.includes("declined:not_policy"));
});

// ─── support link omitted gracefully when not configured ────────

await test("PE-17 — no supportUrl configured → still admits, generic suffix", async () => {
  const out = await runPolicyTurn(
    { shop: "fixture.myshopify.com", latestUserMessage: "do you have a return policy?" },
    { forceEnable: true, retrievedChunks: [] },
  );
  assert.ok(!out.decline);
  assert.match(out.answerText, /contact support directly/i);
  assert.doesNotMatch(out.answerText, /https?:\/\//, "must not invent a support URL");
});

// ─── intent priority — fee beats general policy ─────────────────

await test("PE-18 — 'do you charge a return fee?' is return_fee, not return_policy", () => {
  const i = detectPolicyIntent("do you charge a return fee?");
  assert.equal(i?.primary, "return_fee");
});

// ─── compose API direct tests ──────────────────────────────────

await test("PE-19 — composePolicyAnswer with relevant chunk renders title + content", () => {
  const out = composePolicyAnswer({
    intent: { primary: "return_policy" },
    relevant: [
      chunk({ similarity: 0.72, sectionTitle: "RETURN POLICY", content: "Our 30-day window applies." }),
    ],
    supportUrl: "",
    supportLabel: "",
  });
  assert.match(out.text, /RETURN POLICY/);
  assert.match(out.text, /Our 30-day window applies\./);
  assert.equal(out.reason, "knowledge_confident");
});

await test("PE-20 — composePolicyAnswer empty + supportUrl emits CTA, no raw URL in text", () => {
  const out = composePolicyAnswer({
    intent: { primary: "return_policy" },
    relevant: [],
    supportUrl: "https://shop.example/support",
    supportLabel: "Customer Care",
  });
  // CTA carries label + URL; text refers to the button.
  assert.equal(out.cta?.kind, "external_link");
  assert.match(out.cta.label, /Customer Care/);
  assert.equal(out.cta.url, "https://shop.example/support");
  assert.match(out.text, /contact button below/i);
  assert.doesNotMatch(out.text, /shop\.example\/support/,
    `raw URL must not duplicate in text when CTA is emitted; got "${out.text}"`);
});

// ──────────────────────────────────────────────────────────────
// PE-21..PE-24 — Live 2026-06-03 missing-CTA / no-quick-replies bug.
// Policy answers shipped with no Contact-support button and no
// follow-up chips, so the customer had no obvious next action.
// ──────────────────────────────────────────────────────────────

await test("PE-21 — runPolicyTurn emits an EXTERNAL-LINK CTA when supportUrl is configured", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "what is your return policy?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window." }),
      ],
    },
  );
  assert.ok(out.cta, `expected a CTA when supportUrl is configured; got null`);
  // The CTA must use the "external_link" kind so the dispatcher
  // forwards it verbatim as { type:"link", url, label } — the only
  // shape the widget renders as a button. Live failure: previous
  // kind="cta" never rendered.
  assert.equal(out.cta.kind, "external_link");
  assert.equal(out.cta.url, ctxBase.supportUrl);
  assert.match(out.cta.label, /support|customer/i);
});

await test("PE-22 — no supportUrl configured → no CTA emitted (we don't invent a URL)", async () => {
  const out = await runPolicyTurn(
    { shop: "fixture.myshopify.com", latestUserMessage: "what is your return policy?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window." }),
      ],
    },
  );
  assert.equal(out.cta, null,
    `with no supportUrl configured, CTA must be null (we don't invent URLs); got ${JSON.stringify(out.cta)}`);
});

await test("PE-23 — runPolicyTurn emits deterministic per-intent follow-up suggestions", async () => {
  for (const [q, intentKey] of [
    ["what is your return policy?", "return_policy"],
    ["how long does shipping take?", "shipping"],
    ["do you have a warranty?", "warranty"],
    ["do you offer discounts?", "discounts"],
  ]) {
    const out = await runPolicyTurn(
      { ...ctxBase, latestUserMessage: q },
      { forceEnable: true, retrievedChunks: [] },
    );
    assert.ok(Array.isArray(out.followUps),
      `${intentKey}: expected followUps array; got ${typeof out.followUps}`);
    assert.ok(out.followUps.length >= 2,
      `${intentKey}: expected ≥2 follow-up chips; got ${out.followUps.length}`);
    for (const chip of out.followUps) {
      assert.equal(typeof chip, "string");
      assert.ok(chip.length > 5);
    }
  }
});

await test("PE-24 — follow-up chips are generic, NEVER product-specific or merchant-named", async () => {
  // Audit the static chip lists for tokens that would lock the
  // suggestions to a specific shop or product (Aetrex / sneaker /
  // sandal / Maui / etc.). If a chip slips into that shape, this
  // test catches it.
  const FORBIDDEN_TOKENS = [
    /\baetrex\b/i,
    /\bsneakers?\b/i, /\bsandals?\b/i, /\bboots?\b/i, /\bwedges?\b/i,
    /\bmaui\b/i, /\bjillian\b/i, /\bdanika\b/i,
    /\bplantar\b/i, /\bbunions?\b/i, // medical claims belong in product turns
  ];
  const { POLICY_INTENT_PATTERNS } = __internals;
  for (const intentKey of Object.keys(POLICY_INTENT_PATTERNS)) {
    const out = await runPolicyTurn(
      { ...ctxBase, latestUserMessage: synthMessage(intentKey) },
      { forceEnable: true, retrievedChunks: [] },
    );
    for (const chip of out.followUps || []) {
      for (const re of FORBIDDEN_TOKENS) {
        assert.doesNotMatch(chip, re,
          `intent=${intentKey} chip="${chip}" must not contain merchant/product-specific token ${re}`);
      }
    }
  }
});

function synthMessage(intentKey) {
  return {
    return_policy: "what's your return policy?",
    return_fee:    "is there a return fee?",
    shipping:      "how long does shipping take?",
    warranty:      "do you have a warranty?",
    exchanges:     "can I exchange?",
    tracking:      "where's my order?",
    discounts:     "do you offer any discounts?",
    services:      "do you offer fittings?",
    terms:         "what are your terms of service?",
  }[intentKey] || intentKey;
}

// ──────────────────────────────────────────────────────────────
// PE-25 — SSE event contract. Codex audit (2026-06-03): widget
// only handles `{ type:"link", url, label }`. `{ type:"cta", cta }`
// silently drops. Test the engine output against the EXACT shape
// the dispatcher will emit and the widget consumes.
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// PE-26..PE-29 — Live 2026-06-03 button label duplication.
// Merchant's supportLabel was "Contact customer service".
// Composer was `Contact ${supportLabel}` → rendered as
// "Contact Contact customer service". Fix normalizes labels that
// already start with "Contact".
// ──────────────────────────────────────────────────────────────

await test("PE-26 — supportLabel='Contact customer service' renders verbatim (no double prefix)", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, supportLabel: "Contact customer service", latestUserMessage: "what is your return policy?" },
    { forceEnable: true, retrievedChunks: [
      chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window." }),
    ] },
  );
  assert.equal(out.cta?.label, "Contact customer service",
    `label must not be double-prefixed; got "${out.cta?.label}"`);
});

await test("PE-27 — supportLabel='customer service' (no Contact prefix) → 'Contact customer service'", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, supportLabel: "customer service", latestUserMessage: "what is your return policy?" },
    { forceEnable: true, retrievedChunks: [
      chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window." }),
    ] },
  );
  assert.equal(out.cta?.label, "Contact customer service");
});

await test("PE-28 — missing supportLabel → default 'Contact customer support'", async () => {
  const out = await runPolicyTurn(
    { shop: "fixture.myshopify.com", supportUrl: "https://x/support", latestUserMessage: "return policy?" },
    { forceEnable: true, retrievedChunks: [
      chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day window." }),
    ] },
  );
  assert.equal(out.cta?.label, "Contact customer support");
});

await test("PE-29 — supportLabel='Contact Us' (capital U) renders verbatim", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, supportLabel: "Contact Us", latestUserMessage: "return policy?" },
    { forceEnable: true, retrievedChunks: [
      chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day." }),
    ] },
  );
  assert.equal(out.cta?.label, "Contact Us");
});

await test("PE-25 — engine CTA shape must be convertible to widget-renderable {type:link,url,label}", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "what is your return policy?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({ similarity: 0.7, fileType: "faqs", sectionTitle: "Returns", content: "30-day return window." }),
      ],
    },
  );
  // Simulate the dispatcher's emit step. This MUST produce a
  // payload the widget would render. Codex confirmed widget JS:
  //   if (p.type === 'link' && p.url) linkCTA = { url, label }
  const ctaForSse = out.cta && out.cta.url
    ? { type: "link", url: out.cta.url, label: out.cta.label || `Contact ${ctxBase.supportLabel}` }
    : null;
  assert.ok(ctaForSse, "CTA must be emittable as a link payload");
  assert.equal(ctaForSse.type, "link");
  assert.ok(typeof ctaForSse.url === "string" && /^https?:\/\//.test(ctaForSse.url));
  assert.ok(typeof ctaForSse.label === "string" && ctaForSse.label.length > 0);
});

await test("PE-30 — tracking intent prefers configured tracking page over generic shipping knowledge", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "Can I track my order?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.4,
          fileType: "faqs",
          sectionTitle: "SHIPPING & DELIVERY",
          content: "Q: How long?\nA: 3-7 business days standard.",
        }),
      ],
    },
  );
  assert.ok(!out.decline);
  assert.equal(out.diagnostics?.composer, "tracking_page_url");
  assert.equal(out.cta?.kind, "external_link");
  assert.equal(out.cta?.label, "Track order");
  assert.equal(out.cta?.url, ctxBase.trackingPageUrl);
  assert.match(out.answerText, /track your order/i);
  assert.doesNotMatch(out.answerText, /3-7 business days/i,
    `tracking should not dump generic shipping timelines when trackingPageUrl exists; got "${out.answerText}"`);
});

await test("PE-31 — tracking without trackingPageUrl can still use tracking-specific knowledge", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, trackingPageUrl: "", latestUserMessage: "Can I track my order?" },
    {
      forceEnable: true,
      retrievedChunks: [
        chunk({
          similarity: 0.72,
          fileType: "faqs",
          sectionTitle: "ORDER STATUS",
          content: "Track your order from your account or with the tracking number we email.",
        }),
      ],
    },
  );
  assert.ok(!out.decline);
  assert.equal(out.diagnostics?.composer, "knowledge_confident");
  assert.match(out.answerText, /ORDER STATUS/);
  assert.match(out.answerText, /tracking number we email/i);
});

// ──────────────────────────────────────────────────────────────
console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  process.exit(1);
}
