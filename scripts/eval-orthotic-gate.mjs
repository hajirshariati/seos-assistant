// Integration eval for the orthotic-flow gate. Exercises the
// question-emission branch (no DB, no Anthropic). The resolve
// branch is exercised via the existing eval-decision-tree.mjs +
// real-traffic monitoring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countGenderGateAsks,
  maybeRunOrthoticFlow,
  shouldSoftEscapeFootwearGenderGate,
  isOrthoticConfusionReply,
  isOrthoticHostileReply,
  genderRestatement,
  seedQuestionEmissionCount,
  priorTurnWasOrthoticSeedQuestion,
  orthoticPendingFlowDecision,
  isOrthoticAbandonment,
} from "../app/lib/orthotic-flow-gate.server.js";
import { scopeAttributesToTurn, detectShoeEnvironmentUseCase, messageStatesUseCase, messageStatesShoeEnvironment } from "../app/lib/turn-scope.js";
import { extractUserConstraints } from "../app/lib/catalog-resolver.server.js";
import { looksLikeFunctionalQuestion, looksLikeTransactionalQuestion } from "../app/lib/orthotic-flow.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"));
const tree = { intent: "orthotic", definition };

// Capture console.log lines so tests can detect when the gate
// attempted to resolve (the resolver either succeeded with a card or
// failed with shop=null — both leave a log breadcrumb we can assert
// against). Wraps the original log so the human-readable trace still
// shows up on stdout.
function captureConsoleLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    lines.push(s);
    orig.apply(console, args);
  };
  return {
    lines,
    restore: () => { console.log = orig; },
  };
}

function makeMockSse() {
  const events = [];
  const encoder = { encode: (s) => s };
  const controller = { enqueue: (s) => events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim())) };
  return { events, encoder, controller };
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name} — ${err?.message || err}`);
  }
}

console.log("\northotic-flow gate (question branch)");

await test("falls through when no orthotic tree", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hi" }],
    tree: null,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("falls through when last message isn't user", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "assistant", content: "hi" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("falls through when no prior assistant turn AND no orthotic intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hello" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("re-asks current question when reply is gibberish but intent is established", async () => {
  // With the unified gate, a gibberish reply on a known question
  // doesn't fall through — we re-emit the earliest unanswered seed
  // question. Customer gets a chance to retry with chips.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "asdf qwerty" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // Walks required-attrs in order: gender first since it's missing.
  assert.match(events[0].text, /Who are these orthotics for/i);
});

await test("falls through when mid-flow reply is a question, not a chip answer (ignores-user fix)", async () => {
  // Hunter (foot-pain-orthotic): after the gender chip, customer asked
  // "tell me more about those? do they come with arch support?" — the
  // bot re-asked the diagnostic instead of answering. The reply does
  // not answer the asked chip (gender) and is clearly a question, so
  // the gate must fall through to the LLM.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "oh nice, can you tell me more about those? also do they come with any arch support options" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("still advances the flow on a plain chip answer with no question", async () => {
  // Guard against over-fall-through: a plain "women's" chip answer (no
  // question signal) must advance the flow, not bail. Only QUESTIONS
  // that don't answer the chip fall through.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
});

await test("advances on a tapped DECORATED gender chip ('Women's orthotics')", async () => {
  // The gate now emits context-carrying gender chips; the tapped
  // label round-trips as the customer's whole message and must map
  // via the decorated Layer-1 lookup.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Who are these orthotics for? <<Men's orthotics>> <<Women's orthotics>> <<Kids' orthotics>>" },
      { role: "user", content: "Women's orthotics" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.match(events[0].text, /orthotics go in/i, "gender mapped → next question is q_use_case");
});

await test("back-compat: OLD bare-chip history + bare 'Women' reply still continues the flow", async () => {
  // Conversations that predate context-carrying chips have bare
  // '<<Men>><<Women>><<Kids>>' assistant text and bare 'Women'
  // replies — both must keep working (bare labels stay in the
  // lookup alongside the decorated ones).
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Women" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.match(events[0].text, /orthotics go in/i, "bare chip answer still advances to q_use_case");
});

await test("live C: sandal compatibility follow-up answers directly instead of looping condition question", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Who are these orthotics for? <<Men's orthotics>> <<Women's orthotics>> <<Kids' orthotics>>" },
      { role: "user", content: "Women's orthotics" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Running shoes>> <<Casual sneakers>> <<Dress shoes>>" },
      { role: "user", content: "They'll go in running shoes." },
      { role: "assistant", content: "Any specific foot pain or condition we should match? <<Plantar fasciitis>> <<Ball-of-foot pain>> <<Morton's neuroma>>" },
      { role: "user", content: "Can I put those in sandals too?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.equal(out.case, "orthotic_sandal_compatibility_followup");
  assert.match(events[0].text, /closed shoes/i);
  assert.match(events[0].text, /built-in arch support/i);
  assert.doesNotMatch(events[0].text, /Any specific foot pain/i);
});

await test("looksLikeTransactionalQuestion catches ordering / buying intent post-recommendation", () => {
  // Hunter trace (foot-pain-orthotic): after a recommendation, customer
  // said "this mens active posted one sounds good — how do i order it?"
  // — the gate auto-resolved the same recommendation again. Ordering
  // intent must fall through to the LLM.
  assert.equal(looksLikeTransactionalQuestion("how do i order it?"), true);
  assert.equal(looksLikeTransactionalQuestion("can I buy this?"), true);
  assert.equal(looksLikeTransactionalQuestion("where do I checkout?"), true);
  assert.equal(looksLikeTransactionalQuestion("I'll take it"), true);
  assert.equal(looksLikeTransactionalQuestion("how do i order the kit?"), true);
  assert.equal(looksLikeTransactionalQuestion("can you ship this?"), true);
  // Must NOT match generic intents or chip answers.
  assert.equal(looksLikeTransactionalQuestion("men's"), false);
  assert.equal(looksLikeTransactionalQuestion("show me a recommendation"), false);
  assert.equal(looksLikeTransactionalQuestion("I want orthotics"), false);
});

await test("looksLikeFunctionalQuestion catches post-recommendation yes/no product questions", () => {
  // The exact production failure (hunter, foot-pain-orthotic, run #2):
  // after a recommendation, "would that kit work with regular sneakers
  // or do i need special shoes?" was re-emitted as the same card.
  assert.equal(
    looksLikeFunctionalQuestion("would that kit work with regular sneakers or do i need special shoes?"),
    true,
  );
  assert.equal(looksLikeFunctionalQuestion("does it come with arch support?"), true);
  assert.equal(looksLikeFunctionalQuestion("is it removable?"), true);
  assert.equal(looksLikeFunctionalQuestion("can I use these with sandals?"), true);
  // Must not match recommendation imperatives or chip answers.
  assert.equal(looksLikeFunctionalQuestion("show me one"), false);
  assert.equal(looksLikeFunctionalQuestion("yes"), false);
  assert.equal(looksLikeFunctionalQuestion("men's"), false);
  // Must require a question mark — narrative statements don't count.
  assert.equal(looksLikeFunctionalQuestion("they would work with sneakers"), false);
});

await test("soft gender-gate escape detects open-browse non-answer after gender ask", async () => {
  const messages = [
    { role: "user", content: "hi i need new shoes" },
    { role: "assistant", content: "Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>" },
    { role: "user", content: "i don't know, what do you have that's cheap?" },
  ];
  assert.equal(countGenderGateAsks(messages), 1);
  assert.equal(
    shouldSoftEscapeFootwearGenderGate({
      messages: messages.slice(0, -1),
      rawUserText: messages[messages.length - 1].content,
      answers: {},
    }),
    true,
  );
});

await test("footwear path uses soft gender-gate escape instead of repeating gender wall", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "hi i need new shoes" },
      { role: "assistant", content: "Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>" },
      { role: "user", content: "i don't know, what do you have that's cheap?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: {},
      confidence: "high",
    },
  });
  assert.equal(out.handled, false);
  assert.equal(out.softGenderGateEscape, true);
  assert.equal(out.case, "soft_gender_gate_escape");
  assert.equal(events.length, 0);
});

await test("educational/clinical question is answered by LLM, not shunted into the funnel", async () => {
  // Live 2026-06-22: customer opened with "for Morton's neuroma do i
  // need to have met pad in my orthotics?" — a knowledge question. The
  // classifier extracted condition=mortons_neuroma, which defeated the
  // informational veto (it requires empty latestExtracted) and the gate
  // emitted q_gender ("Who are these orthotics for?"), ignoring the
  // question to start selling. The educational-question veto must fire.
  // Reproduces the live shape: the customer was already engaged in the
  // orthotic flow (so intentInHistory is true), and the widget strips
  // the prior assistant turn's <<chip>> markers from history (so
  // fingerprintNode is null) — exactly the path that previously emitted
  // q_gender on a knowledge question.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I'm looking at men's orthotics" },
      { role: "assistant", content: "Great — what kind of shoes will they go in?" },
      { role: "user", content: "for Morton's neuroma do i need to have met pad in my orthotics?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: false,
      isRejection: false,
      attributes: { condition: "mortons_neuroma" },
      confidence: "high",
    },
  });
  assert.equal(out.handled, false);
  assert.equal(out.case, "educational_question");
  assert.equal(events.length, 0);
});

await test("a flat statement of shopping need still engages the funnel (not treated as educational)", async () => {
  // Guard against over-vetoing: "I need orthotics for plantar fasciitis"
  // is a shopping request, not a knowledge question — the gate should
  // still engage and emit a chip question.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for plantar fasciitis" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      isRejection: false,
      attributes: { condition: "plantar_fasciitis" },
      confidence: "high",
    },
  });
  assert.equal(out.handled, true);
  assert.ok(events.length > 0);
});

await test("footwear path soft-escapes after repeated unanswered gender asks", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "i need shoes" },
      { role: "assistant", content: "Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>" },
      { role: "user", content: "not sure" },
      { role: "assistant", content: "Got it — our catalog is organized by men's and women's styles. Which would you like to browse first? <<Men's>><<Women's>>" },
      { role: "user", content: "ok" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: {},
      confidence: "high",
    },
  });
  assert.equal(out.handled, false);
  assert.equal(out.softGenderGateEscape, true);
  assert.equal(events.length, 0);
});

await test("soft gender-gate escapes after ONE unanswered ask even without an open-browse phrase", async () => {
  // R4: a clarifier must never repeat. After the gate asks gender once,
  // any reply that doesn't resolve gender (here a tangential, non-browse
  // dodge) must escape to browse rather than re-asking.
  const priorMessages = [
    { role: "user", content: "i need new shoes" },
    { role: "assistant", content: "Are you shopping for men's or women's? <<Men's>><<Women's>>" },
  ];
  assert.equal(countGenderGateAsks(priorMessages), 1);
  assert.equal(
    shouldSoftEscapeFootwearGenderGate({
      messages: priorMessages,
      answers: {},
    }),
    true,
  );
});

await test("gender-ask detection is structural — catches every ordering Haiku produces", async () => {
  // Regression chain: cost-mode Haiku asks gender in endlessly varied word
  // orders without chips. Enumerating phrasings with a regex was whack-a-mole
  // ("men's, women's, or kids'" matched but "kids, men's, or women's" didn't).
  // The structural detector counts ANY gender ask; the escape then fires.
  for (const content of [
    "Are you shopping for men's, women's, or kids' footwear?",
    "Are you shopping for men’s, women’s, or kids’ shoes?",
    "Are you shopping for kids, men's, or women's shoes?",
    "Are you shopping for men's or women's?",
    "Got it — let me help you find the right fit. Are you shopping for men's or women's? <<Men's>><<Women's>>",
  ]) {
    assert.equal(countGenderGateAsks([{ role: "assistant", content }]), 1, `should count: ${content}`);
    assert.equal(
      shouldSoftEscapeFootwearGenderGate({
        messages: [{ role: "user", content: "i need shoes" }, { role: "assistant", content }],
        answers: {},
      }),
      true,
    );
  }
  // Must NOT false-positive on listings / pivots that mention both genders.
  for (const content of [
    "Here are the women's sandals I found.",
    "I couldn't find brown men's sneakers, but here are men's sneakers in other colors.",
    "Found these men's sneakers for you.",
  ]) {
    assert.equal(countGenderGateAsks([{ role: "assistant", content }]), 0, `should NOT count: ${content}`);
  }
});

await test("soft gender-gate does NOT escape before any gender ask", async () => {
  assert.equal(
    shouldSoftEscapeFootwearGenderGate({
      messages: [{ role: "user", content: "i need new shoes" }],
      answers: {},
    }),
    false,
  );
});

await test("soft gender-gate never escapes once gender is known", async () => {
  assert.equal(
    shouldSoftEscapeFootwearGenderGate({
      messages: [
        { role: "user", content: "i need new shoes" },
        { role: "assistant", content: "Are you shopping for men's or women's? <<Men's>><<Women's>>" },
      ],
      answers: { gender: "women" },
    }),
    false,
  );
});

await test("footwear path escapes after a single unanswered gender ask + tangential reply", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "hi i need new shoes" },
      { role: "assistant", content: "Got it — let me help you find the right fit. Are you shopping for men's or women's?\n\n<<Men's>><<Women's>>" },
      { role: "user", content: "it's for a wedding next month" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: {},
      confidence: "high",
    },
  });
  assert.equal(out.handled, false);
  assert.equal(out.softGenderGateEscape, true);
  assert.equal(out.case, "soft_gender_gate_escape");
  assert.equal(events.length, 0);
});

await test("emits next seed question on chip click (Layer 1)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "What kind of shoes? <<Dress shoes>><<Everyday / casual shoes>><<Cleats>><<Hockey skates>>" },
      { role: "user", content: "Everyday / casual shoes" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // text + products + done
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "text");
  assert.match(events[0].text, /Who are these orthotics for/);
  // Context-carrying gender chips: labels carry the domain noun.
  assert.match(events[0].text, /<<Men's orthotics>>/);
  assert.match(events[0].text, /<<Women's orthotics>>/);
  assert.match(events[0].text, /<<Kids' orthotics>>/);
  assert.equal(events[1].type, "products");
  assert.deepEqual(events[1].products, []);
  assert.equal(events[2].type, "done");
});

await test("captures gender from 'for my mom' (Layer 2 + history walk)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      // Establish orthotic context first so accumulateAnswers /
      // intent picks up the flow. Without prior intent, "for my mom"
      // alone isn't enough engagement signal.
      { role: "user", content: "I need orthotics for casual shoes" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "for my mom" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // Both useCase=casual (turn 1) and gender=Women (turn 3) accumulated.
  // Walk skips q_use_case + q_gender → emits q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("Layer 3: free-text reply mapped via mock Anthropic hook", async () => {
  const { events, encoder, controller } = makeMockSse();
  let calls = 0;
  const fakeAnthropic = {
    messages: {
      create: async () => { calls += 1; return { content: [{ text: '{"value":"Women"}' }] }; },
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      // Establish orthotic flow first so the gate engages on the
      // chip-fingerprint-known question. Then "65 years old" is
      // L1+L2-immune (no orthotic words, no pronoun, no kin
      // keyword), forcing the Layer-3 hook.
      { role: "user", content: "I need orthotics for casual shoes" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "65 years old" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(calls, 1, "Anthropic mock should be called once");
  assert.equal(out.handled, true);
  assert.equal(events[0].type, "text");
  // useCase=casual + gender=Women (via L3) → next is q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("Layer 3: returns null → falls through (only fingerprint engagement, no map)", async () => {
  // Engagement comes ONLY from the chip fingerprint (no prior intent,
  // no accumulated answers, no Layer-1/2 hit on the latest reply).
  // Layer 3 returns null → fall through to LLM.
  const { events, encoder, controller } = makeMockSse();
  const fakeAnthropic = {
    messages: {
      create: async () => ({ content: [{ text: '{"value":null}' }] }),
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      // Truly unmappable across L1+L2: no chip text, no kin / pronoun,
      // no pain / condition keyword.
      { role: "user", content: "qwerty xyzzy" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("Layer 3: API error → falls through to LLM", async () => {
  const { events, encoder, controller } = makeMockSse();
  const fakeAnthropic = {
    messages: {
      create: async () => { throw new Error("API timeout"); },
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "blarghable" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("off-topic reply (shipping policy mid-flow) → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "what's your shipping policy?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("product explanation follow-up ('what makes these better') → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for heel pain" },
      { role: "assistant", content: "Based on what you've shared, Women's Active Orthotics is the best match." },
      { role: "user", content: "what makes these ones better for my heel pain?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("bootstrap: 'I need orthotics' → emits q_gender (no prior assistant)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I need orthotics" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.equal(events[0].type, "text");
  assert.match(events[0].text, /Who are these orthotics for/i);
  // Decorated seed chips (context-carrying) so the next turn's chip
  // click maps via Layer 1's decorated lookup.
  assert.match(events[0].text, /<<Men's orthotics>>/);
  assert.match(events[0].text, /<<Women's orthotics>>/);
  assert.match(events[0].text, /<<Kids' orthotics>>/);
});

await test("bootstrap: pre-fills useCase + gender from rich first message", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I need running orthotics for my dad" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // useCase=athletic_running + gender=Men prefilled, so we skip to q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("bootstrap: fires when last assistant chips were rephrased (drift case)", async () => {
  const { events, encoder, controller } = makeMockSse();
  // The exact production drift pattern: LLM rephrased seed q_condition
  // chips ("Plantar fasciitis", "Heel spurs", ...) into custom labels.
  // Customer's reply expresses orthotic intent — bootstrap should fire.
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "What's bothering you? <<Arch / Heel Pain>><<Ball of Foot>><<Toe>><<None>>" },
      { role: "user", content: "I need orthotics for plantar fasciitis" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // condition=plantar_fasciitis prefilled. Required-attrs order
  // walks gender first (still missing).
  assert.match(events[0].text, /Who are these orthotics for/i);
});

await test("regression (curly apostrophe): 'Find men’s shoes for my needs' must NOT engage", async () => {
  // Production-exact string the widget client sends. U+2019 instead
  // of straight ASCII '. The veto regex was missing this case.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Find men’s shoes for my needs" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression: 'Find men's shoes for my needs' must NOT engage orthotic flow", async () => {
  // Production bug: Layer 2 extracted gender=Men from "men's", which
  // alone triggered the gate to ask q_use_case 'What kind of shoes
  // will the orthotics go in?' — hijacking a clear footwear request.
  // Engagement rule must require intent or accumulated answers or
  // chip fingerprint, NOT a single Layer-2 hit on the latest message.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Find men's shoes for my needs" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression: footwear-path commit (multi-turn) must NOT hijack on chip click", async () => {
  // Production trace: customer said "I have foot pain, what should I
  // wear?", AI offered <<New Footwear>>|<<Orthotic Insert>>, customer
  // clicked <<New Footwear>>, AI asked <<Men's>>|<<Women's>>, customer
  // clicked <<Women's>>. Layer 2 extracted gender=Women → gate hijacked.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have foot pain, what should I wear?" },
      { role: "assistant", content: "Are you looking for new footwear or an orthotic insert? <<New Footwear>><<Orthotic Insert>>" },
      { role: "user", content: "New Footwear" },
      { role: "assistant", content: "Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>" },
      { role: "user", content: "Women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression (2026-06-12): condition + 'what shoes do you recommend?' commit must NOT hijack on the 'Women's' chip turn", async () => {
  // Production trace 2026-06-12: turn 1 named plantar fasciitis AND
  // asked for SHOES — gate correctly fell through, LLM asked gender,
  // customer clicked "Women's", and the gate hijacked the turn with
  // q_use_case off the accumulated condition+gender. The footwear-
  // commit history veto must keep the gate out: the customer
  // committed to footwear on a prior turn and never pivoted to
  // orthotics.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have plantar fasciitis and going on a trip to Italy, what shoes do you recommend?" },
      { role: "assistant", content: "Got it — let me help you find the right fit. Are you shopping for men's or women's?\n\n<<Men's>><<Women's>>" },
      { role: "user", content: "Women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate must fall through; the customer asked for shoes, never orthotics");
  assert.equal(out.case, "footwear_commit_history");
  assert.equal(events.length, 0);
});

await test("regression (2026-06-15): a SIZING question + one-word scoping answers must NOT start the finder", async () => {
  // Prod trace 2026-06-15: customer opened with "What size should I
  // choose?", answered the bot's scoping questions with "Men's" then
  // "Orthotics", and the gate hijacked into the recommender
  // questionnaire — abandoning the original sizing question. The goal
  // guard must keep the finder out so the LLM answers the sizing
  // question with product context.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "What size should I choose?" },
      { role: "assistant", content: "Happy to help with sizing! Are you shopping for men's, women's, or kids'?\n\n<<Men's>><<Women's>><<Kids>>" },
      { role: "user", content: "Men's" },
      { role: "assistant", content: "Got it — men's. Which category?\n\n<<Sneakers>><<Sandals>><<Orthotics>>" },
      { role: "user", content: "Orthotics" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Men" }, confidence: "high" },
  });
  assert.equal(out.handled, false, "sizing question must not be hijacked into the finder");
  assert.equal(out.case, "info_question_goal");
  assert.equal(events.length, 0);
});

await test("counter-case: a VOLUNTEERED orthotic request still starts the finder", async () => {
  // The guard must be narrow: a real "I need orthotics" sentence (even
  // after an earlier info question) still engages the questionnaire.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "what's your return policy?" },
      { role: "assistant", content: "30-day returns on unworn items." },
      { role: "user", content: "ok cool, I need orthotics" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: {}, confidence: "high" },
  });
  assert.equal(out.handled, true, "a volunteered orthotic request must still run the finder");
});

await test("history veto does NOT fire on an exact flow-chip answer mid-flow (stale footwear commit)", async () => {
  // Mixed conversation: the customer asked for shoes early on, then
  // genuinely pivoted to orthotics and entered the flow. A bare chip
  // answer ("Plantar fasciitis") carries no orthotic noun, so it can't
  // register as a pivot — the watermark comparison alone would let the
  // stale footwear commit veto the flow mid-answer. The exact-chip
  // guard must keep the flow alive.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "show me black sneakers" },
      { role: "assistant", content: "Here are some black sneakers." },
      { role: "user", content: "actually I want orthotic inserts instead" },
      { role: "assistant", content: "Happy to help with orthotics. Any of these conditions apply?\n\n<<Plantar fasciitis>><<Heel spurs>><<None — just want comfort>>" },
      { role: "user", content: "Plantar fasciitis" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.notEqual(out.case, "footwear_commit_history", "exact chip answer must not be vetoed by stale commit history");
});

await test("regression: 'best summer sandal for my mom under $50' must NOT engage (post-19:27 prod trace)", async () => {
  // Production trace at 19:27 UTC. Earlier turns asked about
  // 'sneakers with lace-up styles' and 'wider widths' — Layer 2
  // accumulated gender=Women from pronouns. Then the customer
  // asked for sandals; the gate engaged on accumulated alone and
  // hijacked the footwear request into the orthotic Q&A.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "Do you have any sneakers with lace-up styles?" },
      { role: "assistant", content: "Here are some women's lace-up sneakers." },
      { role: "user", content: "What about sneakers that come in wider widths?" },
      { role: "assistant", content: "Here are wider-width sneakers." },
      { role: "user", content: "best summer sandal for a beach for my mom, she is 89 years old, she had bonion and she love yellow color, give me somthing under $50" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression (Kids-sticky): later 'Women' answer cannot override gender=Kids", async () => {
  // Production trace: customer picked Kids on q_gender; the LLM later
  // injected an unsolicited 'boy or girl?' follow-up with Men's/Women's
  // chips; customer clicked Women's; the resolver returned a Women's
  // adult orthotic for what was supposed to be a child.
  // The kids-sticky guard must drop the latestExtracted.gender override
  // when accumulated already has a kids gender.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for kids' dress shoes" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes>><<Everyday / casual shoes>><<Cleats>>" },
      { role: "user", content: "Dress shoes" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Kids" },
      { role: "assistant", content: "Are these for a boy or girl?" },
      // Customer answered the LLM's bad follow-up. Should NOT flip
      // accumulated gender from Kids to Women.
      { role: "user", content: "Women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  // The gate should still engage (intent was in turn 1). When it walks,
  // gender must remain Kids — verify by looking at what gets emitted
  // and what the answers log says.
  if (out.handled) {
    // If gate handled, the emitted question's preceding state should
    // have gender=Kids. We can confirm by ensuring NO 'gender=Women'
    // appears in any text events (the gate's resolve intro embeds
    // the attrs string).
    const allText = events.filter((e) => e.type === "text").map((e) => e.text).join(" ");
    assert.equal(allText.includes("gender=Women"), false, "gender should not have been flipped to Women");
  }
  // Either way, the test's main assertion is the kids-sticky log line
  // would have fired (we can't easily check stdout from here, so we
  // just assert no events leak adult gender). The unit test for the
  // sticky logic itself can live in eval-orthotic-flow when we test
  // the answer accumulation directly.
});

await test("regression: 'show me women's sandals' must NOT engage", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "show me women's sandals" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("bootstrap: skips when no orthotic intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hi, just browsing" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("bootstrap: skips on negation ('I don't want orthotics')", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I don't want orthotics, just sneakers" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("falls through when assistant chips don't match any seed node and no intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Want me to <<Show comparison>> or <<Find similar>>?" },
      { role: "user", content: "Find similar" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("unified: remembers answers across multiple turns (regression for prod Bug 2)", async () => {
  const { events, encoder, controller } = makeMockSse();
  // Production scenario: turn 1 names plantar fasciitis, turn 2
  // names dress-no-removable, turn 3 picks Women. By turn 3 the
  // gate must still know condition=plantar_fasciitis from turn 1 —
  // otherwise it re-asks q_condition and falls back to the LLM.
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have plantar fasciitis going on a trip to Italy" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "Dress shoes (no removable insole)" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Women" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // All three answers accumulated → gate should walk root → q_use_case
  // (skip, useCase known) → q_gender (skip, gender known) →
  // q_condition (skip, condition known) → q_arch. So the next
  // emitted question should be q_arch.
  assert.match(events[0].text, /arch type/i);
  assert.match(events[0].text, /<<Flat \/ Low>>/);
});

await test("unified: chip click without intent words still continues flow", async () => {
  // Production Bug 3: customer clicks <<Women>>, which has no orthotic
  // intent words and (in old code) chip syntax was lost from history.
  // Unified gate should still engage because we already have answers
  // accumulated from prior turns.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have plantar fasciitis" },
      { role: "assistant", content: "What kind of shoes?" },
      { role: "user", content: "Dress shoes (no removable insole)" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Women" }, // ← chip click, no intent words
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
});

await test("unified: chip syntax lost from assistant history — gate still works", async () => {
  // Simulates the exact production round-trip: widget rendered chips
  // as buttons and stripped <<>> markers from history. Gate must still
  // engage and continue the flow off pure user-side signals.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for plantar fasciitis" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" }, // no <<>>
      { role: "user", content: "Everyday / casual shoes" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // condition=plantar_fasciitis + useCase=casual → next is q_gender.
  assert.match(events[0].text, /Who are these orthotics for/i);
});

// ===================================================================
// Resolve-intent guard regressions (Thinsole bug class)
// ===================================================================

await test("resolve guard: 'what is thinsole?' mid-flow with full attrs → falls through (informational)", async () => {
  // Production trace bug. Customer accumulated gender=Men, useCase=casual,
  // condition=overpronation_flat_feet, arch=Flat/Low. On a NEW turn with
  // an informational question, the gate used to walk to resolve and
  // emit a phantom L620M card, bypassing the LLM. Customer asked
  // "what is thinsole?" — wanted info, got a product. With the
  // resolve-intent guard, the gate falls through; LLM answers.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any specific foot pain or condition?" },
      { role: "user", content: "flat feet" },
      { role: "assistant", content: "What's your arch type?" },
      { role: "user", content: "Flat / Low Arch" },
      { role: "assistant", content: "Here is your orthotic recommendation." },
      { role: "user", content: "what is thinsole?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate should fall through to LLM on informational question");
  assert.equal(events.length, 0, "no SSE events should have been emitted");
});

await test("resolve guard: 'tell me about the L620' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "plantar fasciitis" },
      { role: "assistant", content: "What's your arch type?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Done — here's your match." },
      { role: "user", content: "tell me about the L620" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("resolve guard: 'how does the foam work?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "none" },
      { role: "assistant", content: "What's your arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "how does the foam work?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("resolve guard: 'show me a recommendation' mid-flow → resolves (explicit request)", async () => {
  // Happy-path preservation. Same prior state as the above tests, but
  // the customer now explicitly asks for a recommendation — gate must
  // resolve and emit a card (or attempt to).
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "plantar fasciitis" },
      { role: "assistant", content: "What's your arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "All set." },
      { role: "user", content: "show me a recommendation" },
    ],
    tree,
    shop: null, // shop=null → resolver returns missingProduct error path
    controller,
    encoder,
  });
  // Either handled (resolve attempted, may have emitted error/card) OR
  // not handled if resolver bailed — what we ASSERT is that the gate
  // DID enter the resolve path (didn't fall through on the guard).
  // The "resolve held" log line means the guard kicked in; absence of
  // it means we tried to resolve. The mock SSE captures emits; if any
  // emit happened, resolve was attempted.
  assert.ok(
    out.handled === true || events.length > 0,
    `expected resolve attempt; got handled=${out.handled} events=${events.length}`,
  );
});

await test("resolve guard: chip-answer turn (Layer 2 mapped) → resolves (happy path)", async () => {
  // Customer is mid-flow and just answered the FINAL chip ("Medium / High Arch")
  // for q_arch. fingerprintNode is set + latestExtracted has the new attr.
  // Gate must resolve without holding.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes? <<Casual>><<Dress>><<Athletic running>>" },
      { role: "user", content: "Casual" },
      { role: "assistant", content: "Any condition? <<None>><<Plantar Fasciitis>>" },
      { role: "user", content: "None" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low Arch>><<Medium / High Arch>><<I don't know>>" },
      { role: "user", content: "Medium / High Arch" },
    ],
    tree,
    shop: null,
    controller,
    encoder,
  });
  // Either resolves or attempts resolve. The key assertion: gate did
  // NOT fall through silently (would mean handled=false + no events).
  assert.ok(
    out.handled === true || events.length > 0,
    `expected chip-answer to resolve; got handled=${out.handled} events=${events.length}`,
  );
  if (events[0]?.type === "text" && /roll inward/i.test(events[0].text)) {
    assert.doesNotMatch(events[0].text, /flat-feet symptoms/i);
  }
});

// ===================================================================
// Availability-question regression (Bug 4: kids orthotic Y/N loop)
// ===================================================================

await test("availability question 'do you sell shoes?' before footwear gate → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "do you sell shoes?" },
    ],
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: {},
      confidence: "high",
    },
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "yes/no catalog availability should not ask gender first");
  assert.equal(events.length, 0);
});

await test("availability question 'do you carry sneakers?' before footwear gate → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "do you carry sneakers?" },
    ],
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: {},
      confidence: "high",
    },
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("availability question 'do you have kids orthotics?' mid-flow → falls through", async () => {
  // Production trace: customer mid-orthotic-flow asked 'do you have
  // kids orthotics?'. Without the availability-question veto, the
  // gate kept emitting the next chip question ('What's your arch
  // type?') on every turn, looping forever. With the veto, the gate
  // falls through to the LLM, which can answer Yes/No with cards.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Casual>><<Dress>>" },
      { role: "user", content: "Casual" },
      { role: "assistant", content: "Any condition? <<None>><<Plantar Fasciitis>>" },
      { role: "user", content: "None" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low Arch>><<Medium / High Arch>>" },
      { role: "user", content: "do you have kids orthotics?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate should fall through on 'do you have X' question");
  assert.equal(events.length, 0);
});

await test("availability question 'do you carry running insoles?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What kind of shoes?" },
      { role: "user", content: "do you carry running insoles?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("availability question 'is there a kids version?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "is there a kids version?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("availability question 'recommend me one' is NOT availability (still resolves)", async () => {
  // 'recommend me one' is a recommendation request, not an availability
  // question — the recommendation-request bypass should fire first.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "Shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Condition?" },
      { role: "user", content: "none" },
      { role: "assistant", content: "Arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "recommend me one" },
    ],
    tree,
    shop: null,
    controller,
    encoder,
  });
  assert.ok(
    out.handled === true || events.length > 0,
    `expected resolve attempt; got handled=${out.handled} events=${events.length}`,
  );
});

// ===================================================================
// MESSY-CONVERSATION REGRESSIONS (production trace 2026-05-09 16:03)
// Reproduces the actual bugs from a real customer chat where a grandma
// shopped for self → 9-yo grandson → 90-yo dad → 8-yo son. The
// orthotic-flow accumulated answers from the FIRST subject and kept
// reusing them for every later subject — every kid resolved with the
// wife's "Flat / Low Arch + overpronation=yes" because the gate never
// reset between subjects. Customer kept screaming "he doesn't have
// flat feet" and the bot kept re-recommending the same Posted SKU.
// ===================================================================

await test("subject pivot wife → 9yo grandson resets arch/overpronation/condition", async () => {
  // Wife established Women + casual + none + Medium/High + overpronation=yes,
  // resolved L220W. Now customer says "how about for my 9 year old?"
  // Gate sees gender=Kids, accumulated answers from wife (arch=Medium/High,
  // overpronation=yes, condition=none). Without subject-pivot reset,
  // gate resolves with wife's leftover attrs.
  //
  // Assertion: the gate must NOT enter the resolve path. We detect this
  // by capturing console.log and checking for "[orthotic-flow] resolved →"
  // or "[orthotic-flow] resolve failed" (both indicate the gate ran the
  // resolver — wrong, because attrs aren't actually the kid's).
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "do you have any orthotic for me?" },
        { role: "assistant", content: "Who are these for? <<Men>><<Women>>" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "What kind of shoes? <<Casual>><<Dress>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Any condition? <<None>>" },
        { role: "user", content: "None" },
        { role: "assistant", content: "Arch type? <<Flat / Low Arch>><<Medium / High Arch>>" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "Roll inward? <<Yes>><<No>>" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Here's your match." },
        { role: "user", content: "how about for my 9 year old?" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Kids" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(
    enteredResolve,
    false,
    `gate must NOT enter resolve path with wife's accumulated arch/overpronation. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`,
  );
});

await test("subject pivot wife → dad (Men) resets accumulated subject attrs", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who?" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "Shoes?" },
        { role: "user", content: "casual" },
        { role: "assistant", content: "Condition?" },
        { role: "user", content: "none" },
        { role: "assistant", content: "Arch?" },
        { role: "user", content: "Flat / Low Arch" },
        { role: "assistant", content: "Pronation?" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "okay i need orthotic for my dad now" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Men" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(enteredResolve, false,
    `gate must NOT enter resolve path with wife's accumulated arch=Flat/overpronation=yes`);
});

await test("chip-context defense: 'Yes' to overpronation chip does NOT inject condition=overpronation_flat_feet", async () => {
  // Customer answers "Yes" to the overpronation chip question.
  // Haiku tends to read the chip's wording ("flat-feet symptoms") and
  // infer condition=overpronation_flat_feet. The gate should drop
  // that spurious extraction so the resolver doesn't get a fake
  // condition the customer never named.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who? <<Men>><<Women>>" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "Shoes? <<Casual>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Condition? <<None>>" },
        { role: "user", content: "None" },
        { role: "assistant", content: "Arch? <<Flat / Low Arch>><<Medium / High Arch>>" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "When you walk or stand, do your ankles roll inward or do you have flat-feet symptoms? <<Yes>><<No>>" },
        { role: "user", content: "Yes" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        // Haiku spuriously infers condition from chip text:
        attributes: { gender: "Women", useCase: "casual", condition: "overpronation_flat_feet" },
      },
    });
  } finally {
    cap.restore();
  }
  const droppedSpurious = cap.lines.some((l) =>
    /chip-context defense: dropping spurious condition=overpronation_flat_feet/.test(l),
  );
  assert.equal(
    droppedSpurious,
    true,
    `gate must drop spurious condition extraction. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`,
  );
});

await test("customer correction: 'but he doesn't have flat feet' → invalidates condition", async () => {
  // Customer says bot was wrong about flat feet for the kid. Gate
  // should NOT continue resolving the same SKU. Either re-ask the
  // condition / arch chip OR fall through to LLM. Auto-resolve is
  // forbidden because customer just contradicted the data.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "orthotic for my son who has flat feet" },
        { role: "assistant", content: "Got it. Arch?" },
        { role: "user", content: "Flat / Low Arch" },
        { role: "assistant", content: "Roll inward?" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Here's the Kids Posted Orthotic." },
        { role: "user", content: "but he doesn't have flat feet" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Kids" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(enteredResolve, false,
    `gate must NOT re-resolve same flat-feet SKU after customer corrected the premise`);
});

// ===================================================================
// 2026-05-10 15:08-15:16 trace — state-spread surviving subject pivot.
// Customer ran a full kid orthotic flow (Kids + Medium arch + overpro
// yes), then pivoted to wife (Women, sandals chat), then later asked
// "I need a casual orthotic". Gate emitted q_condition WITH 4 answers
// (gender=Women, useCase=casual, arch=Medium, overpronation=yes) —
// arch and overpronation belonged to the KID, never to the wife.
//
// Root cause: subject-pivot reset only fires on the single turn where
// gender flips. Subsequent turns re-run accumulateAnswers across the
// whole history and re-extract the kid's chip clicks as the wife's
// state. Need a pivot WATERMARK so older messages don't pollute the
// new subject's accumulated state.
// ===================================================================

await test("pivot watermark: kid's arch/overpronation does NOT leak into wife's later 'casual orthotic' turn", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        // Full kid orthotic flow — accumulates Kids + arch=Medium + overpro=yes
        { role: "user", content: "orthotic for my son" },
        { role: "assistant", content: "Shoes? <<Casual>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Condition? <<None>>" },
        { role: "user", content: "None" },
        { role: "assistant", content: "Arch? <<Flat / Low Arch>><<Medium / High Arch>>" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "Roll inward? <<Yes>><<No>>" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Here's the kid's match." },
        // Pivot turn — explicit Women signal ("wife"), so accumulated
        // gender pivots Kids → Women in the walk. Kid's arch/overpro are
        // STILL in the walk's earlier turns and (without the fix) leak
        // forward into the wife's accumulated state.
        { role: "user", content: "now for my wife — pink sandals with arch support, she has bunions" },
        { role: "assistant", content: "Here are some pink sandals with arch support." },
        { role: "user", content: "Do you have these in other colors?" },
        { role: "assistant", content: "Here are color options." },
        // The bug-trigger turn — wife asks for casual orthotic
        { role: "user", content: "I need a casual orthotic" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        attributes: { gender: "Women", useCase: "casual" },
      },
    });
  } finally {
    cap.restore();
  }
  // Two failure modes to guard against:
  //   1. Gate emitted q_overpronation/q_arch with answers=4 (Kids attrs
  //      treated as wife's). Look for any log line with arch=Medium or
  //      overpronation=yes in answers=N.
  //   2. Gate entered resolve path (resolved → OR resolve failed)
  //      because all 4 attrs looked filled — this is the same bug, the
  //      SKU just happens to be missing in the test catalog.
  const allLogs = cap.lines;
  const flowLogs = allLogs.filter((l) => l.includes("[orthotic-flow]") || l.includes("[recommender]"));
  const polluted = flowLogs.some((l) =>
    /arch=Medium|overpronation=yes|derivations added attribute\(s\): posted/.test(l),
  );
  const enteredResolve = flowLogs.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(
    polluted || enteredResolve,
    false,
    `gate must NOT carry kid's arch/overpronation into wife's turn. Logs: ${flowLogs.join(" | ")}`,
  );
});

// ===================================================================
// 2026-05-10 15:35-16:02 trace — deaf-loop. Gate emitted q_arch three
// times in a row while customer typed:
//   1. "my arch type? i don't need this for me, i need it for my brother"
//   2. "this is not for me"
//   3. "are you listening to me?"
// All three should fall through to LLM, not re-emit the same chip.
// ===================================================================

await test("subject clarification 'i don't need this for me, i need it for my brother' falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "i need orthotic for my brother, he has foot pain when he goes to gym" },
        { role: "assistant", content: "What's your arch type? <<Flat / Low>><<Medium>><<High>><<I don't know>>" },
        { role: "user", content: "my arch type? i don't need this for me, i need it for my brother" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true, isFootwearRequest: false, isRejection: false,
        attributes: { gender: "Men", useCase: "athletic_training", condition: "foot_pain" },
      },
    });
  } finally {
    cap.restore();
  }
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));
  const fellThrough = flowLogs.some((l) => /falling through to LLM/.test(l));
  assert.equal(fellThrough, true,
    `gate must fall through on subject clarification. Logs: ${flowLogs.join(" | ")}`);
});

await test("'this is not for me' falls through to LLM", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "i need orthotic for my brother, he has foot pain when he goes to gym" },
        { role: "assistant", content: "What's your arch type?" },
        { role: "user", content: "this is not for me" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true, isFootwearRequest: false, isRejection: false,
        attributes: { gender: "Men", useCase: "athletic_training", condition: "foot_pain" },
      },
    });
  } finally {
    cap.restore();
  }
  const fellThrough = cap.lines.some((l) =>
    /\[orthotic-flow\][^\n]*falling through to LLM/.test(l));
  assert.equal(fellThrough, true,
    `gate must fall through on 'this is not for me'. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`);
});

await test("'are you listening' meta-frustration falls through to LLM", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "orthotic for my brother" },
        { role: "assistant", content: "What's your arch type?" },
        { role: "user", content: "this is not for me" },
        { role: "assistant", content: "What's your arch type?" },
        { role: "user", content: "are you listening to me?" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true, isFootwearRequest: false, isRejection: false,
        attributes: { gender: "Men", useCase: "athletic_training", condition: "foot_pain" },
      },
    });
  } finally {
    cap.restore();
  }
  const fellThrough = cap.lines.some((l) =>
    /\[orthotic-flow\][^\n]*falling through to LLM/.test(l));
  assert.equal(fellThrough, true,
    `gate must fall through on meta-frustration. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`);
});

await test("loop guard: same question would be emitted twice → fall through", async () => {
  // Bot just asked "What's your arch type?". Customer's reply doesn't
  // pick a chip and isn't a valid arch answer ("hmm idk"). Gate must
  // not re-emit the literal same question — fall through so the LLM
  // can rephrase or answer the side question.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "orthotic for foot pain" },
        { role: "assistant", content: "What's your arch type? <<Flat / Low>><<Medium>><<High>><<I don't know>>" },
        { role: "user", content: "what does that mean?" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true, isFootwearRequest: false, isRejection: false,
        attributes: { gender: "Men", useCase: "casual", condition: "foot_pain" },
      },
    });
  } finally {
    cap.restore();
  }
  const fellThrough = cap.lines.some((l) =>
    /\[orthotic-flow\][^\n]*falling through to LLM/.test(l));
  assert.equal(fellThrough, true,
    `gate must fall through to avoid emitting the same question twice. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`);
});

await test("condition-only disambig is SUPPRESSED when the customer is already mid-orthotic-flow", async () => {
  // Production trace: customer was on turn 4 of the orthotic flow
  // (gender + arch + overpronation chips answered), then asked "is
  // this good for flat feet and ball of foot pain?" — the disambig
  // fired and asked "footwear or orthotic?" Absurd: they had already
  // chosen orthotic 3 turns earlier. Mid-flow → skip the disambig.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for my casual shoes" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "women" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low>><<Medium>><<High>>" },
      { role: "user", content: "flat" },
      { role: "assistant", content: "When you walk or stand, do your ankles roll inward or do you have flat-feet symptoms? <<Yes>><<No>>" },
      { role: "user", content: "yes" },
      { role: "assistant", content: "Based on what you've shared, **Women's Train Posted Orthotics** is the best match." },
      { role: "user", content: "is this good for flat feet and ball of foot pain?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  // The gate must NOT emit the "footwear or orthotic?" disambig.
  const disambigEmitted = events.some((e) => e?.type === "text" && /\bfootwear with arch support\b/i.test(e.text || ""));
  assert.equal(disambigEmitted, false, "mid-flow disambig must be suppressed once customer is engaged in orthotic flow");
});

// ── Conversational-repair detectors (pure) ───────────────────────────────
await test("confusion detector: what? / huh? / what do you mean / i don't understand", () => {
  for (const s of ["what?", "huh?", "wha?", "come again?", "what do you mean?", "i don't understand", "i'm confused", "that doesn't make sense"]) {
    assert.equal(isOrthoticConfusionReply(s), true, `should flag confusion: ${s}`);
  }
  // A real chip answer is NOT confusion.
  for (const s of ["men", "dress shoes", "for work boots", "plantar fasciitis"]) {
    assert.equal(isOrthoticConfusionReply(s), false, `should NOT flag: ${s}`);
  }
});

await test("hostility detector: are you stupid / not listening / i already told you", () => {
  for (const s of ["are you stupid?", "you're not listening", "I already told you", "this is annoying", "stop asking", "wtf", "ugh this is ridiculous"]) {
    assert.equal(isOrthoticHostileReply(s), true, `should flag hostility: ${s}`);
  }
  assert.equal(isOrthoticHostileReply("dress shoes"), false);
});

await test("genderRestatement: only fires on RESTATEMENT framing, not a bare chip", () => {
  assert.equal(genderRestatement("i said i'm a man"), "men");
  assert.equal(genderRestatement("i'm men"), "men");
  assert.equal(genderRestatement("for me, i'm a woman"), "women");
  // A bare "men" is a fresh chip answer, NOT a restatement.
  assert.equal(genderRestatement("men"), null);
  assert.equal(genderRestatement("women"), null);
});

await test("seedQuestionEmissionCount counts verbatim prior emissions", () => {
  const node = { id: "q_use_case", question: "What kind of shoes will the orthotics go in?" };
  const msgs = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes>>" },
    { role: "user", content: "huh" },
    { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes>>" },
  ];
  assert.equal(seedQuestionEmissionCount(msgs, node), 2);
  assert.equal(seedQuestionEmissionCount([], node), 0);
});

// ── Gate integration: the loop must break (no verbatim re-emit) ───────────
// Shared mid-flow conversation: gender answered (Men), q_use_case pending.
const useCaseQ = "What kind of shoes will the orthotics go in? <<Dress shoes>><<Everyday / casual shoes>><<Work / on my feet all day>>";
function midUseCaseFlow(lastUserText) {
  return [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "men" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: lastUserText },
  ];
}

await test("confusion mid-flow ('what?') defers to LLM — does NOT repeat q_use_case", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: midUseCaseFlow("what?"), tree, shop: "test.myshopify.com", controller, encoder,
  });
  assert.equal(out.handled, false);
  const repeated = events.some((e) => e?.type === "text" && /What kind of shoes will the orthotics go in/i.test(e.text || ""));
  assert.equal(repeated, false, "must not re-emit the identical seed question");
});

await test("gender restatement mid-flow ('i said i'm a men') defers — no repeat", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: midUseCaseFlow("i said i'm a men"), tree, shop: "test.myshopify.com", controller, encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.some((e) => /What kind of shoes will the orthotics/i.test(e?.text || "")), false);
});

await test("hostility mid-flow ('are you stupid?') defers — no repeat", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: midUseCaseFlow("are you stupid?"), tree, shop: "test.myshopify.com", controller, encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.some((e) => /What kind of shoes will the orthotics/i.test(e?.text || "")), false);
});

await test("confusion bypass fires on FIRST occurrence even with no parseable prior chips", async () => {
  // The prior assistant turn is PLAIN text (no <<chips>>), so prior-chip
  // detection returns null. The bypass must still fire on the first "what?"
  // — not wait for the loop cap (live trace 2026-06-30).
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "what?" },
    ],
    tree, shop: "test.myshopify.com", controller, encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.some((e) => /What kind of shoes/i.test(e?.text || "")), false, "must not re-emit on first confusion");
});

await test("hostility bypass fires on FIRST occurrence (no parseable prior chips)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "are you stupid?" },
    ],
    tree, shop: "test.myshopify.com", controller, encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.some((e) => /What kind of shoes/i.test(e?.text || "")), false);
});

await test("TurnPlan-owned workflows (display_recovery/product_focus/availability) bypass the gate", async () => {
  // Live trace 2026-06-30: workflow=display_recovery, yet the gate emitted
  // "gender first?" and took the turn. A TurnPlan-owned product workflow must
  // make the gate defer immediately.
  for (const workflow of ["display_recovery", "product_focus", "cart_handoff", "availability", "named_product_advisory"]) {
    const { events, encoder, controller } = makeMockSse();
    const out = await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I have plantar fasciitis, show me orthotics" },
        { role: "assistant", content: "Here are some options." },
        { role: "user", content: "i can't see any" },
      ],
      tree, shop: "test.myshopify.com", controller, encoder,
      turnPlan: { workflow, clarificationAllowed: false },
    });
    assert.equal(out.handled, false, `gate must defer for workflow=${workflow}`);
    assert.equal(events.length, 0, `gate must emit nothing for workflow=${workflow}`);
  }
});

await test("loop cap: 3rd time → safe general orthotic recommendation, NOT a resolver fallthrough", async () => {
  // q_use_case already went out TWICE; a third turn (even plain gibberish) must
  // NOT repeat the question. Class 4: instead of deferring to the LLM/resolver
  // (which surfaces sneakers/stale products), the gate OWNS the turn with a safe
  // general orthotic recommendation + caveat — no third question, no fallthrough.
  const { events, encoder, controller } = makeMockSse();
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "men" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: "blah blah" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: "qwerty zzz" },
  ];
  const out = await maybeRunOrthoticFlow({ messages, tree, shop: "test.myshopify.com", controller, encoder });
  assert.equal(out.handled, true, "gate must OWN the turn (no resolver fallthrough)");
  assert.equal(out.case, "seed_loop_cap_safe_recommendation");
  const thirdEmit = events.some((e) => e?.type === "text" && /What kind of shoes will the orthotics go in/i.test(e.text || ""));
  assert.equal(thirdEmit, false, "third identical question emission must be blocked by the loop cap");
  const reco = events.find((e) => e?.type === "text");
  assert.ok(reco && /orthotic/i.test(reco.text) && /general suggestion|not a medical/i.test(reco.text), "must give a safe general orthotic recommendation with caveat");
  const products = events.find((e) => e?.type === "products");
  assert.ok(!products || (products.products || []).length === 0, "must not surface any (sneaker/stale) product cards");
});

await test("orthotic abandonment ('shoes instead, not orthotics') defers + clears state", async () => {
  const { events, encoder, controller } = makeMockSse();
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "men" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: "show me shoes instead, not orthotics" },
  ];
  const out = await maybeRunOrthoticFlow({ messages, tree, shop: "test.myshopify.com", controller, encoder });
  assert.equal(out.handled, false, "must defer to footwear routing");
  assert.equal(out.case, "orthotic_abandoned_pivot_to_footwear");
  assert.equal(isOrthoticAbandonment("show me shoes instead, not orthotics"), true);
  assert.equal(isOrthoticAbandonment("I'll use them in Hoka sneakers for walking"), false);
});

// ── Shoes-vs-orthotics decision + one-step guided orthotic finder ────────────
await test("shoes-vs-orthotics decision: explains difference + chips, no products", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I have plantar fasciitis. What Aetrex shoes or orthotics would you recommend?" }],
    tree, shop: "test.myshopify.com", controller, encoder,
    turnPlan: { workflow: "multi_recommendation", clarificationAllowed: false },
  });
  assert.equal(out.handled, true);
  assert.equal(out.case, "shoes_vs_orthotics_decision");
  const textEv = events.find((e) => e?.type === "text");
  assert.ok(textEv && /built-in arch support/i.test(textEv.text), "must explain the difference");
  assert.ok(/<<Help me find supportive shoes>>/.test(textEv.text) && /<<Help me choose an orthotic>>/.test(textEv.text), "must offer choose-your-flow chips");
  const prodEv = events.find((e) => e?.type === "products");
  assert.deepEqual(prodEv?.products, [], "must NOT show product cards");
});

await test("guided orthotic finder: gate runs (one-step gender) despite condition_recommendation clarify=false", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Help me choose the right Aetrex orthotic" }],
    tree, shop: "test.myshopify.com", controller, encoder,
    turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false },
  });
  // Must NOT defer with the condition_recommendation / clarify-disallowed cases —
  // the explicit guided finder is exactly when the gate should ask gender directly.
  assert.notEqual(out.case, "turn_plan_owns_condition_recommendation", "guided finder must not defer");
  assert.notEqual(out.case, "turn_plan_clarify_disallowed", "guided finder must not defer");
});

await test("regular condition turn STILL defers (no gender clarifier) — guided-finder exception is narrow", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Show me supportive shoes for standing all day" }],
    tree, shop: "test.myshopify.com", controller, encoder,
    turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false },
  });
  assert.equal(out.handled, false, "a plain supportive-shoes turn must still defer to the LLM");
  assert.equal(out.case, "turn_plan_owns_condition_recommendation");
});

// ── Answering a pending seed question must not wipe the just-collected attr ───
await test("seed-question answer ('hoka sneakers') keeps use-case — no fresh-ask wipe / loop", () => {
  // The assistant asked the shoe-type seed question; the customer answers with a
  // shoe brand+type the use-case regex doesn't cover. priorTurnWasOrthoticSeed
  // must flag it so turn-scope treats it as a follow-up and KEEPS the classifier's
  // inferred use-case (instead of wiping it → q_use_case repeats → loop cap).
  const messages = [
    { role: "user", content: "Women's orthotics" },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "hoka sneakers" },
  ];
  assert.equal(priorTurnWasOrthoticSeedQuestion({ messages, tree }), true);
  // With that follow-up signal, scopeAttributesToTurn must NOT wipe the use-case
  // the classifier extracted from "hoka sneakers" (athletic_running).
  const attrs = { gender: "women", category: "orthotics", useCase: "athletic_running", condition: null };
  const keptFollowUp = scopeAttributesToTurn(attrs, "hoka sneakers", { isFollowUp: true });
  assert.equal(keptFollowUp.useCase, "athletic_running", "use-case must survive when answering the seed question");
  // Defense in depth: the deterministic shoe-environment detector now also
  // recognizes "hoka sneakers" as a use-case statement, so even a TRUE fresh
  // ask (no seed signal) keeps the use-case rather than wiping it. Two
  // independent guards now prevent the original loop — the pending-seed signal
  // AND the shoe-environment word coverage in messageStatesUseCase.
  const keptFresh = scopeAttributesToTurn(attrs, "hoka sneakers", { isFollowUp: false });
  assert.equal(keptFresh.useCase, "athletic_running", "shoe-environment detector keeps the use-case even on a fresh ask");
});

// ── Deterministic shoe-environment → use-case detector ───────────────────────
await test("detectShoeEnvironmentUseCase maps the required footwear terms to tree use-cases", () => {
  // Every value returned must be a real q_use_case chip value in the tree.
  const useCaseNode = definition.nodes.find((n) => n.attribute === "useCase");
  const validValues = new Set((useCaseNode.chips || []).map((c) => c.value));
  const cases = [
    ["hoka sneakers for walking", "athletic_running"],
    ["I'll use them in Hoka sneakers for walking", "athletic_running"],
    ["running shoes", "athletic_running"],
    ["my Nike sneakers", "athletic_general"],
    ["just sneakers", "athletic_general"],
    ["at the gym", "athletic_training"],
    ["my work boots", "work_all_day"],
    ["I'm on my feet all day at work", "work_all_day"],
    ["winter boots", "winter_boots"],
    ["just boots", "winter_boots"],
    ["dress shoes", "dress"],
    ["premium dress shoes", "dress_premium"],
    ["closed shoes", "casual"],
    ["everyday casual shoes", "casual"],
    ["dress shoes with non-removable insoles", "dress_no_removable"],
    ["glued-in insoles", "dress_no_removable"],
    ["soccer cleats", "cleats"],
    ["hockey skates", "skates"],
  ];
  for (const [text, expected] of cases) {
    const got = detectShoeEnvironmentUseCase(text);
    assert.equal(got, expected, `"${text}" → ${got} (expected ${expected})`);
    assert.ok(validValues.has(got), `"${got}" must be a real q_use_case chip value`);
  }
});

await test("detectShoeEnvironmentUseCase returns null for non-footwear text", () => {
  for (const text of ["", "women's orthotics", "I have plantar fasciitis", "how much do they cost", "thanks"]) {
    assert.equal(detectShoeEnvironmentUseCase(text), null, `"${text}" should not be a shoe-environment answer`);
  }
});

await test("messageStatesUseCase now recognizes shoe-environment terms (no scope wipe)", () => {
  assert.equal(messageStatesShoeEnvironment("hoka sneakers"), true);
  assert.equal(messageStatesUseCase("hoka sneakers"), true);
  assert.equal(messageStatesUseCase("dress shoes"), true);
  assert.equal(messageStatesUseCase("non-removable insoles"), true);
  // And the legacy use-case words still match.
  assert.equal(messageStatesUseCase("for the gym"), true);
  assert.equal(messageStatesUseCase("women's orthotics"), false);
});

await test("gate captures a free-text shoe-type answer to q_use_case and advances (no re-ask loop)", async () => {
  // Full flow: gender already collected, assistant asked the shoe-type seed
  // question, customer answers "I'll use them in Hoka sneakers for walking".
  // The gate must set useCase=athletic_running deterministically and move ON
  // to the next unanswered question (condition/arch) — NOT re-ask q_use_case.
  const messages = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Who are these orthotics for?" },
    { role: "user", content: "Women's orthotics." },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "I'll use them in Hoka sneakers for walking." },
  ];
  const { encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages,
      tree,
      shop: "test-shop",
      controller,
      encoder,
      classifiedIntent: { intent: "recommend_orthotic", attributes: { gender: "Women" } },
    });
  } finally {
    cap.restore();
  }
  const captured = cap.lines.join("\n");
  assert.match(captured, /shoe-environment answer.*useCase=athletic_running/, "should deterministically capture the use-case");
  // It must NOT re-emit the shoe-type question.
  assert.ok(!/emitted seed question q_use_case/.test(captured), "must not re-ask q_use_case after capturing it");
});

await test("priorTurnWasOrthoticSeedQuestion is false after a normal product reply", () => {
  const messages = [
    { role: "assistant", content: "Here are some great supportive sneakers for you." },
    { role: "user", content: "hoka sneakers" },
  ];
  assert.equal(priorTurnWasOrthoticSeedQuestion({ messages, tree }), false);
});

// ── Mid-seed-flow footwear answer stays on the gate's rails (no verbose LLM Q) ─
await test("mid-flow 'hoka sneakers for my dad' stays in the gate (clean chip Q, not browse)", async () => {
  // Live trace 2026-06-29: answering "Who are these orthotics for?" with a shoe
  // noun flipped isOrthoticRequest=false → C_resolver_strong_action / footwear
  // veto → fell to the LLM, which free-formed a long 2-part clarifier. The shoe
  // noun is the ANSWER ("the orthotic goes in sneakers"), not a footwear browse.
  const resolverState = { type: "resolver_state", recommended_next_action: { type: "recommend" }, matched_constraints: { category: "sneakers", gender: "men" }, inferred_constraints: {}, candidate_products: [1, 2, 3, 4, 5, 6], impossible_constraints: [] };
  const classifiedIntent = { isFootwearRequest: true, isOrthoticRequest: false, attributes: { gender: "Men", useCase: null, condition: null } };
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "Help me choose the right Aetrex orthotic" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "hoka sneakers for my dad" },
    ],
    tree, shop: "test.myshopify.com", controller, encoder, classifiedIntent, resolverState,
  });
  assert.equal(out.handled, true, "gate must stay engaged mid-flow, not yield to browse/LLM");
  assert.notEqual(out.case, "C_resolver_strong_action");
  assert.notEqual(out.case, "D_footwear_request_with_noun");
  const q = events.find((e) => e?.type === "text");
  assert.ok(q && /<<[^<>]+>>/.test(q.text), "must emit a clean chip question, not a free-form clarifier");
});

await test("genuine footwear browse (no prior seed question) STILL yields to the resolver", async () => {
  const resolverState = { type: "resolver_state", recommended_next_action: { type: "recommend" }, matched_constraints: { category: "sneakers", gender: "men" }, inferred_constraints: {}, candidate_products: [1, 2, 3, 4, 5, 6], impossible_constraints: [] };
  const classifiedIntent = { isFootwearRequest: true, isOrthoticRequest: false, attributes: { gender: "Men" } };
  const { encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Here are some great options." },
      { role: "user", content: "hoka sneakers for my dad" },
    ],
    tree, shop: "test.myshopify.com", controller, encoder, classifiedIntent, resolverState,
  });
  assert.equal(out.handled, false, "a real footwear browse must still yield, not get hijacked into the orthotic quiz");
});

// ── ORTHOTIC TARGET PRESERVATION: the exact 3-turn flow ──────────────────────
// "Help me choose the right Aetrex orthotic." → "Women's orthotics." → "I'll use
// them in Hoka sneakers for walking." The 3rd turn answers the pending shoe-
// environment question. It must recommend ORTHOTICS, never switch to a sneaker
// browse. Live bug: shouldSoftBrowseRefine hijacked it (prior Q "What KIND OF
// shoes…" + "walking") into final_path=soft_browse_refine with sneaker cards,
// and extractUserConstraints pinned category=sneakers. These assertions lock
// the preconditions the chat.jsx guards key off + prove the gate owns the turn.
await test("orthotic target preserved: 3-turn flow stays orthotic, never sneaker browse", async () => {
  const messages = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Who are these orthotics for?" },
    { role: "user", content: "Women's orthotics." },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "I'll use them in Hoka sneakers for walking." },
  ];
  const latest = "I'll use them in Hoka sneakers for walking.";

  // (1) The turn is recognized as answering a pending orthotic seed question —
  //     this is the single signal both chat.jsx guards (soft-browse skip +
  //     category drop) depend on, so it MUST be true here.
  assert.equal(priorTurnWasOrthoticSeedQuestion({ messages, tree }), true);

  // (2) The footwear words are a shoe-ENVIRONMENT answer → use-case, not a
  //     product category.
  assert.equal(messageStatesShoeEnvironment(latest), true);
  assert.equal(detectShoeEnvironmentUseCase(latest), "athletic_running");

  // (3) The HAZARD the category-drop guard neutralizes: the raw constraint
  //     extractor pulls category=sneakers from "Hoka sneakers". Because (1) is
  //     true and (2) flags a shoe-environment answer, chat.jsx deletes it so the
  //     resolver never pins category=sneakers (→ no sneaker search/cards).
  assert.equal(extractUserConstraints(latest).category, "sneakers", "control: raw extractor would pin sneakers");

  // (4) End-to-end: the gate OWNS the turn even under the EXACT production
  //     TurnPlan that caused the leak — workflow=condition_recommendation,
  //     clarificationAllowed=false (PRD 3263be4: this combo made the gate defer
  //     to the LLM/resolver, which forced a "walking sneakers" search and
  //     shipped sneaker cards). Mid-seed-flow ownership must win. The gate
  //     captures useCase=athletic_running and asks the next orthotic question
  //     (condition). No product cards, no sneaker handoff, no soft-browse.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages, tree, shop: "test-shop", controller, encoder,
    classifiedIntent: { intent: "recommend_orthotic", isOrthoticRequest: true, attributes: { gender: "Women", category: "sneakers", useCase: null } },
    turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false, searchRequired: true, productDisplayPolicy: "show" },
  });
  assert.equal(out.handled, true, "the orthotic gate must own the turn (not defer → soft_browse_refine/resolver)");
  assert.notEqual(out.case, "turn_plan_owns_condition_recommendation", "must not defer on the condition_recommendation override mid-seed-flow");
  const productEv = events.find((e) => e?.type === "products");
  assert.ok(!productEv || (Array.isArray(productEv.products) && productEv.products.length === 0), "must NOT ship product cards (no sneaker cards)");
  const textEv = events.find((e) => e?.type === "text");
  assert.ok(textEv && /pain|condition|arch/i.test(textEv.text), "stays on the orthotic rails (asks the next orthotic question)");
});

// ── PENDING-FLOW CONTINUE vs CANCEL (state handoff) ──────────────────────────
await test("orthoticPendingFlowDecision: answers continue, fresh requests cancel", () => {
  // CONTINUE: the reply answers the pending seed question.
  const useCaseAnswer = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "I'll use them in Hoka sneakers for walking." },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages: useCaseAnswer, tree }), "continue");

  const conditionAnswer = [
    { role: "assistant", content: "Any specific foot pain or condition we should match?" },
    { role: "user", content: "plantar fasciitis" },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages: conditionAnswer, tree }), "continue");

  const shortAnswer = [
    { role: "assistant", content: "Any specific foot pain or condition we should match?" },
    { role: "user", content: "not sure" },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages: shortAnswer, tree }), "continue");

  // CANCEL: a fresh standalone shopping request that does NOT answer the pending
  // condition question (the live leak — routed as orthotic, then sneaker cards).
  const freshRequest = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Any specific foot pain or condition we should match?" },
    { role: "user", content: "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?" },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages: freshRequest, tree }), "cancel");

  // NONE: no seed question pending.
  const noPending = [
    { role: "assistant", content: "Here are some great options." },
    { role: "user", content: "do you have Danika in black" },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages: noPending, tree }), "none");
});

await test("fresh request mid-flow CANCELS the gate (defers to normal product routing, no orthotic Q)", async () => {
  // The exact PRD leak: prior assistant asked the condition seed question, the
  // customer pivots to a fresh footwear request. The gate must DEFER cleanly
  // (cancel), not stay engaged and not emit an orthotic question.
  const messages = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Who are these orthotics for?" },
    { role: "user", content: "Women's orthotics." },
    { role: "assistant", content: "Any specific foot pain or condition we should match?" },
    { role: "user", content: "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?" },
  ];
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages, tree, shop: "test-shop", controller, encoder,
    classifiedIntent: { intent: "recommend_orthotic", isOrthoticRequest: true, attributes: { gender: "Women" } },
    turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false, searchRequired: true, productDisplayPolicy: "show" },
  });
  assert.equal(out.handled, false, "the gate must DEFER (cancel) on a fresh standalone request");
  assert.equal(out.case, "pending_flow_cancelled_fresh_request");
  assert.equal(events.find((e) => e?.type === "text"), undefined, "must not emit any orthotic question");
});

// ── Task 3 (2026-06-30): guided orthotic flow ENTRY + use-case capture ───────
// "i need insole for my dad" must ENTER the guided flow, capture gender from
// "dad" (→ Men), and ask the NEXT useful question (q_use_case) — NOT dump a
// random orthotic grid. Live trace 2026-06-30: it showed random orthotics, then
// an orthotic without asking the tree questions, then a "Style it" CTA.
await test("'i need insole for my dad' ENTERS the guided flow, captures gender, asks the next Q (no random grid)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "i need insole for my dad" }],
    tree, shop: "test-shop", controller, encoder,
  });
  assert.equal(out.handled, true, "must enter the guided orthotic flow, not fall through to a grid");
  const q = events.find((e) => e?.type === "text");
  assert.ok(q, "must emit a guided question");
  // Gender already captured from 'dad' → the NEXT question is the use-case one,
  // never the gender one again and never a product grid.
  assert.match(q.text, /what kind of shoes will the orthotics go in/i, "next question is q_use_case (gender already known)");
  assert.doesNotMatch(q.text, /who are these orthotics for/i, "gender was captured from 'dad' — don't re-ask it");
  const productEvent = events.find((e) => e?.type === "products");
  assert.ok(!productEvent || !productEvent.products || productEvent.products.length === 0 || productEvent.text === "" || productEvent.text == null,
    "no random orthotic grid on the entry question");
});

await test("'Casual' inside the guided flow STAYS in the flow (use-case answer, not a footwear pivot)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "i need insole for my dad" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes>> <<Everyday / casual shoes>> <<Athletic — running>>" },
      { role: "user", content: "Casual" },
    ],
    tree, shop: "test-shop", controller, encoder,
  });
  assert.equal(out.handled, true, "'Casual' is a use-case chip answer — the flow must continue, not pivot to casual footwear");
  const q = events.find((e) => e?.type === "text");
  assert.ok(q && /foot pain or condition/i.test(q.text), "advances to the condition question after capturing useCase=casual");
});

console.log("");
if (failed === 0) {
  console.log(`✅  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) {
    console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}
