// FITFinder in the chat (app/lib/lean/fit-finder.js): the open_fit_finder
// tool, its card, and the fact check that sends a reply back when it asks
// the arch / ball-of-foot questions in words while the finder could take them.
import assert from "node:assert/strict";
import { FIT_FINDER_TOOL, FIT_FINDER_TOOL_DEF, fitFinderToolResult, fitFinderNativeNote, asksFitQuestion, fitFinderIssues, FOOT_SCAN_TOOL, FOOT_SCAN_TOOL_DEF, footScanToolResult, asksForOwnScan, deniesScan, footScanIssues } from "../app/lib/lean/fit-finder.js";

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

console.log("\nthe in-store foot scan");
test("one tool, no input, whose answer puts the scan card under the reply and never says it can't see a scan", () => {
  assert.equal(FOOT_SCAN_TOOL, "open_foot_scan");
  assert.equal(FOOT_SCAN_TOOL_DEF.name, FOOT_SCAN_TOOL);
  assert.deepEqual(FOOT_SCAN_TOOL_DEF.input_schema, { type: "object", properties: {} });
  assert.match(FOOT_SCAN_TOOL_DEF.description, /Never tell them you can't access or see their scan/);
  assert.match(FOOT_SCAN_TOOL_DEF.description, /even when they already have a FIT saved/);
  assert.match(FOOT_SCAN_TOOL_DEF.description, /Not for where to get scanned/);
  const r = footScanToolResult();
  assert.deepEqual(r._events, [{ type: "fitfinder_scan" }]);
  assert.match(r.note, /sign-in with the email they gave at the scan/);
  assert.match(r.note, /Don't say you can't access the scan/);
});
test("asking for a scan they had — not where to get one", () => {
  for (const t of ["can you pull up my foot scan", "do you have my scan on file?", "I was scanned at your store last week, what's my fit?", "I got scanned in one of your stores", "where are my scan results", "I had my feet scanned at the mall", "can you see my Albert scan", "use our scans please"]) assert.equal(asksForOwnScan(t), true, t);
  for (const t of ["where can I get my feet scanned?", "is there a scanner near me", "can you scan my feet?", "what does the scanner measure", "I want to get scanned", "which orthotic should I get"]) assert.equal(asksForOwnScan(t), false, t);
});
test("a reply that says the scan can't be reached", () => {
  for (const t of ["I'm not able to access foot scan data directly in this chat — that's stored with the retailer.", "I can't pull up your scan here.", "Unfortunately I don't have access to your foot scan.", "I’m unable to see scan results."]) assert.equal(deniesScan(t), true, t);
  for (const t of ["Your scan is right here — tap below.", "I can't find that style.", "Here's what the scan found."]) assert.equal(deniesScan(t), false, t);
});
const scanBase = { available: ["search_products", "recommend_orthotic", FIT_FINDER_TOOL, FOOT_SCAN_TOOL], called: [] };
test("their scan asked for, or the reply denying it, with the card unused → sent back with the card", () => {
  const a = footScanIssues({ ...scanBase, latestUserMessage: "can you pull up my foot scan", text: "I can't access scan data here. You have a FIT D on file though." });
  assert.equal(a.length, 1);
  assert.equal(a[0].code, "foot_scan_not_offered");
  assert.match(a[0].detail, new RegExp(`Call ${FOOT_SCAN_TOOL} so its card goes under your reply`));
  assert.match(a[0].detail, /never say you can't access or see it/);
  assert.match(a[0].detail, /Keep the rest of your reply/);
  assert.equal(footScanIssues({ ...scanBase, latestUserMessage: "can you pull up my foot scan", text: "Sure — what size do you wear?" }).length, 1, "asked, and answered with something else");
  assert.equal(footScanIssues({ ...scanBase, latestUserMessage: "what's my fit?", text: "I'm not able to see your foot scan in this chat." }).length, 1, "the denial alone");
});
test("fine: the card was called, the tool isn't there, or neither the ask nor a denial", () => {
  assert.deepEqual(footScanIssues({ ...scanBase, latestUserMessage: "pull up my scan", text: "Right here — tap below.", called: [FOOT_SCAN_TOOL] }), []);
  assert.deepEqual(footScanIssues({ ...scanBase, available: ["search_products", FIT_FINDER_TOOL], latestUserMessage: "pull up my scan", text: "I can't access your scan." }), [], "the store's widget doesn't run the lookup");
  assert.deepEqual(footScanIssues({ ...scanBase, latestUserMessage: "where can I get my feet scanned?", text: "Here's the map of scanner locations near 07666." }), []);
  assert.deepEqual(footScanIssues({ ...scanBase, latestUserMessage: "which orthotic should I get", text: "Do you have flat feet?" }), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
