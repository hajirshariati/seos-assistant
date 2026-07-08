// ANSWER SOURCE / KNOWLEDGE / SUPPORT CTA cleanup.
// Policy/account/discount/verification/order/support turns must prefer, in order:
//   1. RAG semantic knowledge
//   2. lexical knowledge fallback
//   3. deterministic policy/account tools
//   4. support handoff (only when nothing above answered)
// with a REAL "Chat with Aetrex Support" CTA (never bracket/UI text), and zero
// product cards. Current-promotions/sale questions are a COMMERCE turn (search
// sale products), not a support punt.
//
// Run: node scripts/eval-answer-source.mjs

import assert from "node:assert/strict";
import {
  applyAnswerSourceContract, normalizeAnswerSource, ANSWER_SOURCES,
  handoffMetaTextLeak, supportChatLabel, buildAccountSupportHandoffText,
} from "../app/lib/support-handoff.js";
import { planTurn, WORKFLOWS, workflowSuppressesCards } from "../app/lib/turn-plan.server.js";
import { lexicalRetrieveChunks } from "../app/lib/knowledge-chunks.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const W = WORKFLOWS;
const CTX = { supportUrl: "https://aetrex.example/support", supportLabel: "Visit Support Hub" };
// A merchant knowledge corpus that DOES cover teacher verification + returns.
const KNOWLEDGE = [
  { fileType: "faqs", content:
    "Teacher & Student Discounts\nTo verify you're a teacher, upload your school-issued ID or employment verification through SheerID at checkout. Verified teachers get 15% off.\n\n" +
    "Returns\nWe accept returns within 30 days of delivery for unworn shoes in original packaging.\n\n" +
    "Shipping\nOrders ship within 2 business days." },
];
const knowledgeText = KNOWLEDGE.map((k) => k.content).join("\n");
// Text-only assertions: never bracket/UI-meta, never a plain "Support Hub" line.
function assertRealCtaNoMeta(r) {
  assert.ok(r.supportCta && r.supportCta.label && r.supportCta.fallbackUrl, "real support CTA object");
  assert.equal(handoffMetaTextLeak(r.text), false, "no bracket/UI-meta text in the answer");
  assert.doesNotMatch(r.text, /\[/, "no bracket text");
  assert.doesNotMatch(r.text, /support hub button/i, "no 'Support Hub button' plain text");
}

console.log("\nanswer-source / knowledge / support-CTA cleanup\n");

check("taxonomy: the 4 answer sources + normalizer", () => {
  assert.deepEqual(
    Object.values(ANSWER_SOURCES).sort(),
    ["deterministic_policy", "lexical", "rag", "support_handoff"],
  );
  assert.equal(normalizeAnswerSource("rag"), "rag");
  assert.equal(normalizeAnswerSource("lexical"), "lexical");
  assert.equal(normalizeAnswerSource("static_knowledge"), "rag", "full-dump knowledge folds to rag");
  assert.equal(normalizeAnswerSource("deterministic_policy"), "deterministic_policy");
  assert.equal(normalizeAnswerSource("support_handoff"), "support_handoff");
});

check("supportChatLabel is the real live-chat label, never a 'Support Hub' link default", () => {
  assert.equal(supportChatLabel({ supportLabel: "Visit Support Hub" }), "Chat with Aetrex Support");
  assert.equal(supportChatLabel({}), "Chat with Aetrex Support");
  assert.doesNotMatch(buildAccountSupportHandoffText({ msg: "help with my order" }), /\[|button/i);
});

// 1 — teacher verification: uploaded knowledge answers it (RAG → lexical), no cards.
check("1. 'verify I'm a teacher' answers from knowledge (lexical), no cards, no handoff", () => {
  const q = "What information do I need to provide to verify I'm a teacher?";
  const plan = planTurn({ message: q });
  assert.equal(plan.workflow, W.POLICY_KNOWLEDGE);
  assert.equal(plan.productDisplayPolicy, "suppress");
  // RAG missed → lexical fallback surfaces the teacher section.
  const lex = lexicalRetrieveChunks(KNOWLEDGE, q, { limit: 3 });
  assert.ok(lex.length > 0 && /SheerID|school-issued/i.test(lex[0].content));
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q,
    text: "To verify as a teacher, upload your school-issued ID through SheerID at checkout.",
    ctx: CTX, retrievedChunks: lex, knowledgeText,
  });
  assert.equal(normalizeAnswerSource(r.source), ANSWER_SOURCES.LEXICAL);
  assert.equal(r.handoff, false, "answered from knowledge — no support handoff");
  assert.deepEqual(r.cards, []);
});

// 2 — teacher discount: knowledge answers it too.
check("2. 'Do teachers get a discount?' answers from knowledge, no cards", () => {
  const q = "Do teachers get a discount?";
  const plan = planTurn({ message: q });
  assert.equal(plan.workflow, W.POLICY_KNOWLEDGE);
  assert.equal(plan.productDisplayPolicy, "suppress");
  const lex = lexicalRetrieveChunks(KNOWLEDGE, q, { limit: 3 });
  assert.ok(lex.length > 0, "knowledge covers teacher discounts");
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q,
    text: "Yes — verified teachers get 15% off through SheerID at checkout.",
    ctx: CTX, retrievedChunks: lex, knowledgeText,
  });
  assert.ok([ANSWER_SOURCES.RAG, ANSWER_SOURCES.LEXICAL].includes(normalizeAnswerSource(r.source)));
  assert.equal(r.handoff, false);
  assert.deepEqual(r.cards, []);
});

// 3 — delivered-but-not-received: private order issue → real support CTA.
check("3. 'delivered but I didn't get it' → support handoff with real CTA, no cards", () => {
  const q = "I need help with an order that says delivered but I didn't get it.";
  const plan = planTurn({ message: q });
  assert.equal(plan.workflow, W.ACCOUNT_PRIVATE_HANDOFF);
  assert.equal(plan.productDisplayPolicy, "suppress");
  const r = applyAnswerSourceContract({ workflow: plan.workflow, msg: q, text: "Our team can help. [Support Hub button is available above]", ctx: CTX, retrievedChunks: undefined });
  assert.equal(normalizeAnswerSource(r.source), ANSWER_SOURCES.SUPPORT_HANDOFF);
  assert.equal(r.handoff, true);
  assert.deepEqual(r.cards, []);
  assertRealCtaNoMeta(r);
  assert.match(r.text, /order/i);
});

// 4 — return policy: knowledge answers it, no cards.
check("4. 'What is your return policy?' answers from knowledge, no cards", () => {
  const q = "What is your return policy?";
  const plan = planTurn({ message: q });
  assert.equal(plan.workflow, W.POLICY_KNOWLEDGE);
  assert.equal(plan.productDisplayPolicy, "suppress");
  const lex = lexicalRetrieveChunks(KNOWLEDGE, q, { limit: 3 });
  assert.ok(lex.length > 0);
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q,
    text: "We accept returns within 30 days of delivery for unworn shoes.",
    ctx: CTX, retrievedChunks: lex, knowledgeText,
  });
  assert.ok([ANSWER_SOURCES.RAG, ANSWER_SOURCES.LEXICAL].includes(normalizeAnswerSource(r.source)));
  assert.equal(r.handoff, false);
  assert.deepEqual(r.cards, []);
});

// 5 — current sales/promotions: a COMMERCE turn (search sale products), NOT support.
check("5. 'Show me current sales and promotions' → sale_browse (search products), not support", () => {
  const plan = planTurn({ message: "Show me current sales and promotions" });
  assert.equal(plan.workflow, W.SALE_BROWSE, "sale question searches products, not a support punt");
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.productDisplayPolicy, "show");
  // sale_browse is NOT a card-suppressing / knowledge workflow.
  assert.equal(workflowSuppressesCards(W.SALE_BROWSE), false);
  assert.equal(applyAnswerSourceContract({ workflow: W.SALE_BROWSE, msg: "what's on sale?", text: "Here are sale items." }).applies, false, "the answer-source contract does not claim a commerce turn");
});

// 6 — unknown policy question with NO knowledge → real support CTA.
check("6. unknown policy question with no knowledge → support handoff + real CTA", () => {
  const q = "Do you deliver to the international space station?";
  assert.deepEqual(lexicalRetrieveChunks(KNOWLEDGE, q, { limit: 3 }), [], "corpus has no answer");
  const r = applyAnswerSourceContract({
    workflow: W.POLICY_KNOWLEDGE, msg: q, text: "I don't have that information.",
    ctx: CTX, retrievedChunks: [], knowledgeText,
  });
  assert.equal(normalizeAnswerSource(r.source), ANSWER_SOURCES.SUPPORT_HANDOFF);
  assert.equal(r.handoff, true);
  assert.equal(r.prematureHandoff, false, "genuine no-knowledge, not a premature punt");
  assertRealCtaNoMeta(r);
});

// 7 — no product cards on ANY policy/account/support turn.
check("7. no product cards on any policy/account/support turn (planner + contract)", () => {
  const turns = [
    "What information do I need to provide to verify I'm a teacher?",
    "Do teachers get a discount?",
    "I need help with an order that says delivered but I didn't get it.",
    "What is your return policy?",
    "How long does shipping take?",
    "Can someone help me with my account?",
    "Why was my teacher verification rejected?",
  ];
  for (const q of turns) {
    const plan = planTurn({ message: q });
    assert.equal(plan.productDisplayPolicy, "suppress", `"${q}" must suppress cards`);
    assert.equal(workflowSuppressesCards(plan.workflow), true, `"${q}" (${plan.workflow}) is a card-suppressing workflow`);
    // the contract, whatever the branch, returns zero cards on these turns.
    const r = applyAnswerSourceContract({ workflow: plan.workflow, msg: q, text: "some answer", ctx: CTX, retrievedChunks: [], knowledgeText });
    if (r.applies) assert.deepEqual(r.cards, [], `"${q}" contract yields no cards`);
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
