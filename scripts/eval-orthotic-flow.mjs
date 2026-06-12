// Eval suite for the orthotic-flow state-machine module.
// Tests pure functions only — no Anthropic, no DB. Mirrors
// the style of eval-decision-tree.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeText,
  buildChipLookup,
  findNodeById,
  getRootNode,
  extractChipLabelsFromText,
  findNodeByChipsInText,
  nextNodeFromTransition,
  detectFlowState,
  mapAnswerToEnum,
  getNextStep,
  buildConstrainedAnswerPrompt,
  parseConstrainedAnswerResponse,
  isOffTopicReply,
  detectOrthoticIntent,
  preExtractAnswers,
  accumulateAnswers,
  looksLikeRecommendationRequest,
  looksLikeInformationalQuestion,
  looksLikeAvailabilityQuestion,
  decorateGenderChipLabel,
  getGenderChipContextNoun,
  messageCommitsToFootwear,
  messagePivotsToOrthotic,
  mentionsNonOrthoticFootwear,
} from "../app/lib/orthotic-flow.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const tree = JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      failures.push({ name, err });
      console.log(`  ✗ ${name} — ${err?.message || err}`);
    }
  });
}

function section(label) {
  queue.push(async () => { console.log(`\n${label}`); });
}

section("helpers");

test("normalizeText lowercases + collapses whitespace", () => {
  assert.equal(normalizeText("  Athletic — Gym / Training  "), "athletic - gym / training");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
});

test("buildChipLookup maps labels to enum values", () => {
  const node = findNodeById(tree, "q_gender");
  const lookup = buildChipLookup(node);
  assert.equal(lookup.get("women"), "Women");
  assert.equal(lookup.get("men"), "Men");
  assert.equal(lookup.get("kids"), "Kids");
});

test("buildChipLookup returns null for resolve nodes", () => {
  const node = findNodeById(tree, "q_resolve");
  assert.equal(buildChipLookup(node), null);
});

test("findNodeById returns null on miss", () => {
  assert.equal(findNodeById(tree, "nonexistent"), null);
});

test("getRootNode returns q_gender", () => {
  const root = getRootNode(tree);
  assert.equal(root?.id, "q_gender");
});

section("chip extraction + matching");

test("extractChipLabelsFromText pulls all chips, deduped", () => {
  const labels = extractChipLabelsFromText(
    "Pick one: <<Men>> <<Women>> <<Kids>> or <<Women>>",
  );
  assert.deepEqual(labels, ["men", "women", "kids"]);
});

test("findNodeByChipsInText identifies q_gender from chips", () => {
  const node = findNodeByChipsInText(
    "Who's this for? <<Men>><<Women>><<Kids>>",
    tree,
  );
  assert.equal(node?.id, "q_gender");
});

test("findNodeByChipsInText identifies q_use_case", () => {
  const node = findNodeByChipsInText(
    "Pick: <<Dress shoes>><<Cleats>><<Hockey skates>>",
    tree,
  );
  assert.equal(node?.id, "q_use_case");
});

test("findNodeByChipsInText returns null when no chips", () => {
  assert.equal(findNodeByChipsInText("Just plain text", tree), null);
});

section("transitions");

test("nextNodeFromTransition follows _default", () => {
  const node = findNodeById(tree, "q_use_case");
  assert.equal(nextNodeFromTransition(node, "casual"), "q_condition");
});

test("nextNodeFromTransition branches by value (q_arch)", () => {
  const node = findNodeById(tree, "q_arch");
  assert.equal(nextNodeFromTransition(node, "Flat / Low Arch"), "q_resolve");
  assert.equal(nextNodeFromTransition(node, "Medium / High Arch"), "q_overpronation");
});

test("nextNodeFromTransition returns null on missing branch", () => {
  const fakeNode = { next: { only: "x" } };
  assert.equal(nextNodeFromTransition(fakeNode, "nonexistent"), null);
});

section("detectFlowState");

test("empty messages → state at root, no answers", () => {
  const state = detectFlowState([], tree);
  assert.equal(state.currentNodeId, "q_gender");
  assert.deepEqual(state.answers, {});
});

test("after gender + useCase answers, state advances to q_condition", () => {
  // Real seed flow: root is q_gender → q_use_case → q_condition.
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "Women" },
    { role: "assistant", content: "What kind of shoes? <<Dress shoes>><<Everyday / casual shoes>><<Cleats>><<Hockey skates>>" },
    { role: "user", content: "Everyday / casual shoes" },
  ];
  const state = detectFlowState(messages, tree);
  assert.equal(state.currentNodeId, "q_condition");
  assert.equal(state.answers.useCase, "casual");
  assert.equal(state.answers.gender, "Women");
});

test("unmapped free-text answer leaves state unchanged + counts", () => {
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "uhh I'm not really sure" },
  ];
  const state = detectFlowState(messages, tree);
  assert.equal(state.currentNodeId, "q_gender"); // didn't advance
  assert.equal(state.unmappedTurns, 1);
});

section("mapAnswerToEnum (Layer 1 + 2)");

test("Layer 1: exact chip click maps directly", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("Women", node, tree);
  assert.equal(r.value, "Women");
  assert.equal(r.layer, 1);
});

test("Layer 1: case insensitive", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("women", node, tree);
  assert.equal(r.value, "Women");
});

test("Layer 2: 'for my mom' → Women (gender)", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("for my mom", node, tree);
  assert.equal(r.value, "Women");
  assert.equal(r.layer, 2);
});

test("Layer 2: 'for my dad' → Men", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("for my dad", node, tree);
  assert.equal(r.value, "Men");
});

test("Layer 2: 'for my niece' → Kids (Kids before Women in pattern table)", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("for my niece", node, tree);
  assert.equal(r.value, "Kids");
});

test("Layer 2: 'running orthotic' → athletic_running (useCase)", async () => {
  const node = findNodeById(tree, "q_use_case");
  const r = await mapAnswerToEnum("running orthotic", node, tree);
  assert.equal(r.value, "athletic_running");
});

test("Layer 2: 'just want comfort' → comfort", async () => {
  const node = findNodeById(tree, "q_use_case");
  const r = await mapAnswerToEnum("I just want comfort", node, tree);
  assert.equal(r.value, "comfort");
});

test("Layer 2: 'plantar fasciitis' typo → plantar_fasciitis (condition)", async () => {
  const node = findNodeById(tree, "q_condition");
  const r1 = await mapAnswerToEnum("plantar fasciitis", node, tree);
  assert.equal(r1.value, "plantar_fasciitis");
  const r2 = await mapAnswerToEnum("plantarfaciitis", node, tree);
  assert.equal(r2.value, "plantar_fasciitis");
});

test("Layer 2: 'ball of foot pain' → metatarsalgia", async () => {
  const node = findNodeById(tree, "q_condition");
  const r = await mapAnswerToEnum("ball of foot pain", node, tree);
  assert.equal(r.value, "metatarsalgia");
});

test("Layer 2: 'no pain' → none (condition)", async () => {
  const node = findNodeById(tree, "q_condition");
  const r = await mapAnswerToEnum("no pain", node, tree);
  assert.equal(r.value, "none");
});

test("Layer 2: 'flat feet' → Flat / Low Arch (arch question)", async () => {
  const node = findNodeById(tree, "q_arch");
  const r = await mapAnswerToEnum("flat feet", node, tree);
  assert.equal(r.value, "Flat / Low Arch");
});

test("Layer 2: 'don't know' → Medium / High Arch (arch fallback)", async () => {
  const node = findNodeById(tree, "q_arch");
  const r = await mapAnswerToEnum("i don't know", node, tree);
  assert.equal(r.value, "Medium / High Arch");
});

test("Layer 2: scoped — 'running' on condition question doesn't match", async () => {
  const node = findNodeById(tree, "q_condition");
  const r = await mapAnswerToEnum("running", node, tree);
  // 'running' isn't in the condition keyword table, AND wouldn't
  // match condition's chip values, so should return unmapped.
  assert.equal(r.value, null);
  assert.equal(r.layer, "unmapped");
});

test("Layer 3 hook fires when L1+L2 miss", async () => {
  const node = findNodeById(tree, "q_gender");
  let llmCalled = 0;
  // Truly L1+L2-immune: no chip text, no pronoun, no kin keyword.
  const r = await mapAnswerToEnum("65 years old", node, tree, {
    askLLM: async () => { llmCalled += 1; return { value: "Women" }; },
  });
  assert.equal(llmCalled, 1);
  assert.equal(r.value, "Women");
  assert.equal(r.layer, 3);
});

test("Layer 3: rejected if returns invalid enum", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("???", node, tree, {
    askLLM: async () => ({ value: "Bogus" }),
  });
  assert.equal(r.value, null);
});

test("Layer 3: handles thrown errors gracefully", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("???", node, tree, {
    askLLM: async () => { throw new Error("api timeout"); },
  });
  assert.equal(r.value, null);
  assert.equal(r.layer, "llm-error");
});

section("getNextStep");

test("empty state → first question (root)", () => {
  const step = getNextStep({ currentNodeId: null, answers: {} }, tree);
  assert.equal(step.type, "question");
  assert.equal(step.node.id, "q_gender");
});

test("after q_gender answered → q_use_case", () => {
  const step = getNextStep({
    currentNodeId: "q_use_case",
    answers: { gender: "Women" },
  }, tree);
  assert.equal(step.type, "question");
  assert.equal(step.node.id, "q_use_case");
});

test("at resolve node → resolve step with attrs", () => {
  const step = getNextStep({
    currentNodeId: "q_resolve",
    answers: { useCase: "casual", gender: "Women", condition: "none", arch: "Flat / Low Arch" },
  }, tree);
  assert.equal(step.type, "resolve");
  assert.equal(step.attrs.useCase, "casual");
  assert.equal(step.attrs.gender, "Women");
});

test("skipIfKnown skips q_gender if gender already in answers", () => {
  const step = getNextStep({
    currentNodeId: "q_gender",
    answers: { gender: "Women", useCase: "casual" },
  }, tree);
  // With skipIfKnown=true on q_gender + answer present, we
  // transition past it without re-asking.
  assert.notEqual(step.node?.id, "q_gender");
});

section("Layer 3 prompt + parser");

test("buildConstrainedAnswerPrompt includes question + options", () => {
  const node = findNodeById(tree, "q_gender");
  const p = buildConstrainedAnswerPrompt("she's 65", node);
  assert.match(p, /\bWomen\b/);
  assert.match(p, /\bMen\b/);
  assert.match(p, /\bKids\b/);
  assert.match(p, /she's 65/);
  assert.match(p, /JSON/);
});

test("buildConstrainedAnswerPrompt returns null for resolve nodes", () => {
  const node = findNodeById(tree, "q_resolve");
  assert.equal(buildConstrainedAnswerPrompt("anything", node), null);
});

test("parseConstrainedAnswerResponse parses clean JSON", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(parseConstrainedAnswerResponse('{"value":"Women"}', node), "Women");
});

test("parseConstrainedAnswerResponse handles code-fenced JSON", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(
    parseConstrainedAnswerResponse('```json\n{"value":"Men"}\n```', node),
    "Men",
  );
});

test("parseConstrainedAnswerResponse rejects hallucinated values", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(parseConstrainedAnswerResponse('{"value":"Other"}', node), null);
});

test("parseConstrainedAnswerResponse returns null for {value:null}", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(parseConstrainedAnswerResponse('{"value":null}', node), null);
});

section("orthotic-intent detector");

test("intent: 'I need orthotics' → true", () => {
  assert.equal(detectOrthoticIntent("I need orthotics for everyday shoes"), true);
});
test("intent: 'recommend an insole' → true", () => {
  assert.equal(detectOrthoticIntent("can you recommend an insole?"), true);
});
test("intent: 'plantar fasciitis help' → true (condition signal)", () => {
  assert.equal(detectOrthoticIntent("I have plantar fasciitis"), true);
});
test("intent: 'flat feet' → true", () => {
  assert.equal(detectOrthoticIntent("my dad has flat feet"), true);
});
test("intent: 'I don't want orthotics' → false (negation)", () => {
  assert.equal(detectOrthoticIntent("I don't want orthotics, just shoes"), false);
});
test("intent: 'shoes with arch support' → false (footwear feature)", () => {
  assert.equal(detectOrthoticIntent("show me shoes with arch support"), false);
});
test("intent: 'orthotic-friendly shoes' → false", () => {
  assert.equal(detectOrthoticIntent("any orthotic-friendly shoes?"), false);
});
test("intent: 'show me sandals' → false (no signal)", () => {
  assert.equal(detectOrthoticIntent("show me sandals"), false);
});
test("intent: empty / null → false", () => {
  assert.equal(detectOrthoticIntent(""), false);
  assert.equal(detectOrthoticIntent(null), false);
});

test("intent: curly apostrophe normalization (don’t want orthotics → false)", () => {
  // U+2019 RIGHT SINGLE QUOTATION MARK — what most widget chat
  // clients emit instead of a straight ASCII apostrophe.
  assert.equal(detectOrthoticIntent("I don’t want orthotics"), false);
});

section("preExtractAnswers");

test("extracts useCase from 'running orthotics'", () => {
  const a = preExtractAnswers("I need running orthotics", tree);
  assert.equal(a.useCase, "athletic_running");
});
test("extracts gender from 'for my dad'", () => {
  const a = preExtractAnswers("I need orthotics for my dad", tree);
  assert.equal(a.gender, "Men");
});
test("extracts gender=Kids from 'for my 9yr old son' (production bug 2026-05-10)", () => {
  // Bare \bson\b matched the Men pattern, so "9yr old son" was
  // misclassified as Men and the wife's flow ended up resolving
  // L220M (Men's Conform Posted) for the kid. The new Kids pattern
  // catches "9yr old son" / "my son" / "young son" first.
  const a = preExtractAnswers("how about for my 9yr old son, do you have any insoles for him?", tree);
  assert.equal(a.gender, "Kids", `expected Kids, got ${a.gender}`);
});
test("extracts gender=Kids from 'my son'", () => {
  const a = preExtractAnswers("orthotic for my son", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts gender=Kids from 'my daughter'", () => {
  const a = preExtractAnswers("for my daughter", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts gender=Kids from '9-year-old son' (hyphenated age)", () => {
  const a = preExtractAnswers("9-year-old son needs orthotics", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts gender=Kids from '12 year old daughter'", () => {
  const a = preExtractAnswers("12 year old daughter has flat feet", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts gender=Kids from 'young son'", () => {
  const a = preExtractAnswers("orthotic for my young son", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts gender=Kids from 'toddler son'", () => {
  const a = preExtractAnswers("toddler son", tree);
  assert.equal(a.gender, "Kids");
});
test("extracts useCase + gender + condition from rich message", () => {
  const a = preExtractAnswers("plantar fasciitis running orthotics for my mom", tree);
  assert.equal(a.useCase, "athletic_running");
  assert.equal(a.gender, "Women");
  assert.equal(a.condition, "plantar_fasciitis");
});
test("returns {} on no signals", () => {
  assert.deepEqual(preExtractAnswers("hello", tree), {});
});

section("accumulateAnswers");

test("merges signals across multiple user turns", () => {
  const messages = [
    { role: "user", content: "I have plantar fasciitis and am going to Italy" },
    { role: "assistant", content: "What kind of shoes?" },
    { role: "user", content: "Dress shoes (no removable insole)" },
    { role: "assistant", content: "Who's it for?" },
    { role: "user", content: "Women" },
  ];
  const a = accumulateAnswers(messages, tree);
  // condition from turn 1, useCase from turn 2, gender from turn 3 — all preserved.
  assert.equal(a.condition, "plantar_fasciitis");
  assert.equal(a.useCase, "dress_no_removable");
  assert.equal(a.gender, "Women");
});

test("later turn overrides earlier on same attribute", () => {
  const messages = [
    { role: "user", content: "for my dad" },
    { role: "user", content: "actually for my mom" },
  ];
  const a = accumulateAnswers(messages, tree);
  assert.equal(a.gender, "Women");
});

test("ignores assistant messages", () => {
  const messages = [
    { role: "assistant", content: "Plantar fasciitis is common" },
  ];
  assert.deepEqual(accumulateAnswers(messages, tree), {});
});

test("returns {} on empty history", () => {
  assert.deepEqual(accumulateAnswers([], tree), {});
});

section("off-topic detection");

test("off-topic: customer asks about shipping mid-flow", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(isOffTopicReply("what's your shipping policy?", node), true);
});

test("off-topic: customer asks about returns", () => {
  const node = findNodeById(tree, "q_condition");
  assert.equal(isOffTopicReply("how do returns work", node), true);
});

test("not off-topic: 'yes' to overpronation question", () => {
  const node = findNodeById(tree, "q_overpronation");
  assert.equal(isOffTopicReply("yes", node), false);
});

test("not off-topic: 'for my mom' on gender (Layer 2 catches)", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(isOffTopicReply("for my mom", node), false);
});

test("not off-topic: empty string", () => {
  const node = findNodeById(tree, "q_gender");
  assert.equal(isOffTopicReply("", node), false);
});

section("looksLikeRecommendationRequest");

test("'show me an orthotic' → true", () => {
  assert.equal(looksLikeRecommendationRequest("show me an orthotic"), true);
});
test("'recommend one' → true", () => {
  assert.equal(looksLikeRecommendationRequest("recommend one for me"), true);
});
test("'find me one' → true", () => {
  assert.equal(looksLikeRecommendationRequest("can you find me one"), true);
});
test("'pick one' → true", () => {
  assert.equal(looksLikeRecommendationRequest("just pick one for me"), true);
});
test("'I'll take it' → true", () => {
  assert.equal(looksLikeRecommendationRequest("ok I'll take it"), true);
});
test("'go ahead' → true", () => {
  assert.equal(looksLikeRecommendationRequest("go ahead"), true);
});
test("'sounds good' → true", () => {
  assert.equal(looksLikeRecommendationRequest("sounds good"), true);
});
test("'what's the best orthotic for me' → true", () => {
  assert.equal(looksLikeRecommendationRequest("what's the best orthotic for me"), true);
});
test("'what's the best insole for plantar fasciitis' → true", () => {
  assert.equal(looksLikeRecommendationRequest("what's the best insole for plantar fasciitis"), true);
});
test("'what is thinsole' → false (informational)", () => {
  assert.equal(looksLikeRecommendationRequest("what is thinsole?"), false);
});
test("'what brand are these' → false", () => {
  assert.equal(looksLikeRecommendationRequest("what brand are these?"), false);
});
test("plain greeting → false", () => {
  assert.equal(looksLikeRecommendationRequest("hello there"), false);
});
test("empty → false", () => {
  assert.equal(looksLikeRecommendationRequest(""), false);
});

section("looksLikeInformationalQuestion");

test("'what is thinsole?' → true", () => {
  assert.equal(looksLikeInformationalQuestion("what is thinsole?"), true);
});
test("'what are Thinsoles?' → true", () => {
  assert.equal(looksLikeInformationalQuestion("what are Thinsoles?"), true);
});
test("'tell me about the L620' → true", () => {
  assert.equal(looksLikeInformationalQuestion("tell me about the L620"), true);
});
test("'how does the foam work?' → true", () => {
  assert.equal(looksLikeInformationalQuestion("how does the foam work?"), true);
});
test("'explain the difference between posted and non-posted' → true", () => {
  assert.equal(looksLikeInformationalQuestion("explain the difference between posted and non-posted"), true);
});
test("'difference between A and B?' → true", () => {
  assert.equal(looksLikeInformationalQuestion("what's the difference between A and B?"), true);
});
test("'show me an orthotic' → false (recommendation, not info)", () => {
  assert.equal(looksLikeInformationalQuestion("show me an orthotic"), false);
});
test("'recommend one' → false", () => {
  assert.equal(looksLikeInformationalQuestion("recommend one for me"), false);
});
test("'I have plantar fasciitis' → false (statement, not question)", () => {
  assert.equal(looksLikeInformationalQuestion("I have plantar fasciitis"), false);
});
test("'what should I get?' → false (recommendation request)", () => {
  // 'what should i get' starts with 'what' BUT doesn't match the
  // INFORMATIONAL pattern — no 'is/are/does/exactly' and no
  // 'what's the X'. So returns false. (This message is captured
  // by looksLikeRecommendationRequest's "what should I get/buy/wear" rule.)
  assert.equal(looksLikeInformationalQuestion("what should I get?"), false);
});
test("empty → false", () => {
  assert.equal(looksLikeInformationalQuestion(""), false);
});

section("looksLikeAvailabilityQuestion");

test("'do you have kids orthotics?' → true", () => {
  assert.equal(looksLikeAvailabilityQuestion("do you have kids orthotics?"), true);
});
test("'do you carry mens sneakers?' → true", () => {
  assert.equal(looksLikeAvailabilityQuestion("do you carry mens sneakers?"), true);
});
test("'do you sell sandals?' → true", () => {
  assert.equal(looksLikeAvailabilityQuestion("do you sell sandals?"), true);
});
test("'is there a kids version?' → true", () => {
  assert.equal(looksLikeAvailabilityQuestion("is there a kids version?"), true);
});
test("'are there any in red?' → true", () => {
  assert.equal(looksLikeAvailabilityQuestion("are there any in red?"), true);
});
test("'do you ship internationally?' → true (caught by /do you (ship/)", () => {
  assert.equal(looksLikeAvailabilityQuestion("do you ship internationally?"), true);
});
test("'so you don't have kids orthotics' → false (statement, not Q)", () => {
  // Note: the prefix 'so you don't have' doesn't match the regex (we
  // require 'do you have'); the trailing period/no-question-mark also
  // means it's a statement. Fine — gate's other vetoes catch it via
  // looksLikeInformationalQuestion if needed.
  assert.equal(looksLikeAvailabilityQuestion("so you don't have kids orthotics"), false);
});
test("'I need orthotics' → false (statement)", () => {
  assert.equal(looksLikeAvailabilityQuestion("I need orthotics"), false);
});
test("'recommend one for me' → false (recommendation request)", () => {
  assert.equal(looksLikeAvailabilityQuestion("recommend one for me"), false);
});
test("empty → false", () => {
  assert.equal(looksLikeAvailabilityQuestion(""), false);
});

section("context-carrying gender chips (decorate + match)");

test("decorateGenderChipLabel possessive join: Men/Women → 's, Kids → s'", () => {
  assert.equal(decorateGenderChipLabel("Men", "orthotics"), "Men's orthotics");
  assert.equal(decorateGenderChipLabel("Women", "orthotics"), "Women's orthotics");
  assert.equal(decorateGenderChipLabel("Kids", "orthotics"), "Kids' orthotics");
});

test("decorateGenderChipLabel: empty noun / label are no-ops", () => {
  assert.equal(decorateGenderChipLabel("Women", ""), "Women");
  assert.equal(decorateGenderChipLabel("Women", null), "Women");
  assert.equal(decorateGenderChipLabel("", "orthotics"), "");
});

test("decorateGenderChipLabel: already-possessive label just appends the noun", () => {
  assert.equal(decorateGenderChipLabel("Men's", "shoes"), "Men's shoes");
  assert.equal(decorateGenderChipLabel("Kids'", "orthotics"), "Kids' orthotics");
});

test("getGenderChipContextNoun defaults to 'orthotics' when vocabulary absent", () => {
  assert.equal(getGenderChipContextNoun({}), "orthotics");
  assert.equal(getGenderChipContextNoun(null), "orthotics");
  assert.equal(
    getGenderChipContextNoun({ vocabulary: { genderChipContextNoun: "insoles" } }),
    "insoles",
  );
});

test("buildChipLookup with context noun accepts BOTH bare and decorated labels", () => {
  const node = findNodeById(tree, "q_gender");
  const lookup = buildChipLookup(node, "orthotics");
  // Bare labels keep working (typed answers, old histories).
  assert.equal(lookup.get("women"), "Women");
  assert.equal(lookup.get("men"), "Men");
  assert.equal(lookup.get("kids"), "Kids");
  // Decorated labels (tapped chips) map to the same enum values.
  assert.equal(lookup.get("women's orthotics"), "Women");
  assert.equal(lookup.get("men's orthotics"), "Men");
  assert.equal(lookup.get("kids' orthotics"), "Kids");
});

test("buildChipLookup does NOT decorate non-gender nodes", () => {
  const node = findNodeById(tree, "q_use_case");
  const lookup = buildChipLookup(node, "orthotics");
  assert.equal(lookup.get("dress shoes / heels orthotics"), undefined);
});

test("Layer 1: tapped decorated chip 'Women's orthotics' maps to gender=Women", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("Women's orthotics", node, tree);
  assert.equal(r.value, "Women");
  assert.equal(r.layer, 1);
});

test("Layer 1: tapped decorated chip 'Kids' orthotics' maps to gender=Kids", async () => {
  const node = findNodeById(tree, "q_gender");
  const r = await mapAnswerToEnum("Kids' orthotics", node, tree);
  assert.equal(r.value, "Kids");
  assert.equal(r.layer, 1);
});

test("findNodeByChipsInText identifies q_gender from DECORATED emitted chips", () => {
  const node = findNodeByChipsInText(
    "Who are these orthotics for? <<Men's orthotics>><<Women's orthotics>><<Kids' orthotics>>",
    tree,
  );
  assert.equal(node?.id, "q_gender");
});

test("detectFlowState advances on decorated emit + decorated tap", () => {
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men's orthotics>><<Women's orthotics>><<Kids' orthotics>>" },
    { role: "user", content: "Women's orthotics" },
  ];
  const state = detectFlowState(messages, tree);
  assert.equal(state.answers.gender, "Women");
  assert.equal(state.currentNodeId, "q_use_case");
});

test("detectFlowState back-compat: bare emit + bare tap still advances (old history)", () => {
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "Women" },
  ];
  const state = detectFlowState(messages, tree);
  assert.equal(state.answers.gender, "Women");
  assert.equal(state.currentNodeId, "q_use_case");
});

test("preExtractAnswers: 'Women's orthotics' → gender=Women (Layer-1 decorated)", () => {
  const out = preExtractAnswers("Women's orthotics", tree);
  assert.equal(out.gender, "Women");
});

test("accumulateAnswers harvests gender from a decorated tapped chip in history", () => {
  const messages = [
    { role: "user", content: "I have plantar fasciitis" },
    { role: "assistant", content: "Who are these orthotics for? <<Men's orthotics>><<Women's orthotics>><<Kids' orthotics>>" },
    { role: "user", content: "Women's orthotics" },
  ];
  const out = accumulateAnswers(messages, tree);
  assert.equal(out.gender, "Women");
  assert.equal(out.condition, "plantar_fasciitis");
});

test("'Women's orthotics' is NOT a footwear commit (no footwear noun)", () => {
  assert.equal(messageCommitsToFootwear("Women's orthotics"), false);
  assert.equal(mentionsNonOrthoticFootwear("Women's orthotics"), false);
  // Bonus: the orthotic noun in the tapped text marks the turn as
  // orthotic-domain for the latest-message detectors.
  assert.equal(detectOrthoticIntent("Women's orthotics"), true);
  assert.equal(messagePivotsToOrthotic("Women's orthotics"), true);
});

async function run() {
  for (const fn of queue) await fn();
  console.log("");
  if (failed === 0) {
    console.log(`✅  ${passed} passed, 0 failed\n`);
    process.exit(0);
  } else {
    console.log(`❌  ${passed} passed, ${failed} failed\n`);
    for (const f of failures) {
      console.log(`  ${f.name}:`);
      console.log(`    ${f.err?.stack || f.err}`);
    }
    process.exit(1);
  }
}

run();
