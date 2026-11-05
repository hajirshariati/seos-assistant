// FITFinder in the chat (app/lib/lean/fit-finder.js): the open_fit_finder
// tool, its card, and the fact check that sends a reply back when it asks
// the arch / ball-of-foot questions in words while the finder could take them.
import assert from "node:assert/strict";
import { FIT_FINDER_TOOL, FIT_FINDER_TOOL_DEF, fitFinderToolResult, fitFinderNativeNote, asksFitQuestion, fitFinderIssues } from "../app/lib/lean/fit-finder.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name} — ${err.message}`); }
}

console.log("\nthe tool");
test("one tool, no input, whose answer puts the card under the reply", () => {
  assert.equal(FIT_FINDER_TOOL, "open_fit_finder");
  assert.equal(FIT_FINDER_TOOL_DEF.name, FIT_FINDER_TOOL);
  assert.deepEqual(FIT_FINDER_TOOL_DEF.input_schema, { type: "object", properties: {} });
  assert.match(FIT_FINDER_TOOL_DEF.description, /instead of asking those two questions/);
  assert.match(FIT_FINDER_TOOL_DEF.description, /not twice in one conversation/);
  const r = fitFinderToolResult(2);
  assert.deepEqual(r._events, [{ type: "fitfinder_cta" }]);
  assert.match(r.note, /2 quick questions/);
  assert.match(r.note, /don't ask arch or ball-of-foot pain in this reply/);
  assert.match(fitFinderToolResult(1).note, /1 quick question;/);
  assert.match(fitFinderToolResult("nope").note, /2 quick questions/);
  assert.match(fitFinderNativeNote(2), /2 quick taps/);
});

console.log("\nthe reply guard");
const questions = [{ text: "Do you have flat feet?" }, { text: "Do you have pain beneath the ball of your foot?" }];
const base = { available: ["search_products", "recommend_orthotic", FIT_FINDER_TOOL], called: [], fitfinder: { fits: [{ key: "A" }], questions, saved: null, native: true, offered: false } };
test("the arch or ball-of-foot question in words, the finder unused → sent back with the card", () => {
  for (const text of [
    "Happy to help! First, do you have flat feet or a low arch?",
    "Got it — running shoes. Any pain under the ball of your foot?",
    "Which best describes your arches: flat, medium or high?",
    "Do you have flat feet? <<Yes>><<No>>",
    "Do your feet roll inward when you walk?",
  ]) {
    const r = fitFinderIssues({ ...base, text });
    assert.equal(r.length, 1, text);
    assert.equal(r[0].code, "fit_finder_not_offered");
    assert.match(r[0].detail, new RegExp(`call ${FIT_FINDER_TOOL} so its card goes under your reply`));
    assert.match(r[0].detail, /keep the rest of your reply/);
  }
});
test("the store's own question, in its words, counts too", () => {
  assert.equal(fitFinderIssues({ ...base, fitfinder: { ...base.fitfinder, questions: [{ text: "Where does your footprint look widest?" }] }, text: "Quick one: where does your footprint look widest?" }).length, 1);
  assert.equal(asksFitQuestion("Where does your footprint look widest?", [{ text: "Where does your footprint look widest?" }]), true);
  assert.equal(asksFitQuestion("Where does your footprint look widest.", []), false, "not a question");
});
test("fine: the card was called, or offered earlier, or they have a FIT, or the finder isn't in the chat, or no such question", () => {
  const text = "Do you have flat feet?";
  assert.deepEqual(fitFinderIssues({ ...base, text, called: [FIT_FINDER_TOOL] }), [], "called this turn");
  assert.deepEqual(fitFinderIssues({ ...base, text, fitfinder: { ...base.fitfinder, offered: true } }), [], "offered earlier in this chat: words are fine now");
  assert.deepEqual(fitFinderIssues({ ...base, text, fitfinder: { ...base.fitfinder, saved: "B" } }), [], "they have a FIT");
  assert.deepEqual(fitFinderIssues({ ...base, text, fitfinder: { ...base.fitfinder, native: false } }), [], "the finder can't run in this widget");
  assert.deepEqual(fitFinderIssues({ ...base, text, available: ["search_products", "recommend_orthotic"] }), [], "the tool isn't there");
  assert.deepEqual(fitFinderIssues({ ...base, text: "Who are the orthotics for — you, or someone else?" }), [], "another question");
  assert.deepEqual(fitFinderIssues({ ...base, text: "Which shoes will you wear them in: sneakers, dress shoes or boots?" }), []);
  assert.deepEqual(fitFinderIssues({ ...base, text: "Flat feet are really common, and easy to support." }), [], "a statement, not a question");
  assert.deepEqual(fitFinderIssues({ ...base, text, fitfinder: null }), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
