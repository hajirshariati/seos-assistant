// The chat's own words (Settings → Look & feel → Chat text): tidied and
// capped, only the ones set reach the widget, a blank one keeps the theme
// editor's, and the assistant goes by the name set here.
//
// Run: node scripts/eval-chat-texts.mjs
import assert from "node:assert/strict";

const { CHAT_TEXT_FIELDS, parseChatTexts, chatTextsFromForm, chatTextsForForm, cleanChatText } = await import("../app/lib/chat-texts.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

await test("only the texts set reach the widget, tidied; anything else is dropped", () => {
  assert.deepEqual(parseChatTexts('{"startHeading":"  Get   started ","popularHeading":"","name":"Aetrex Shopping Assistant","bogus":"x"}'),
    { startHeading: "Get started", name: "Aetrex Shopping Assistant" });
  assert.deepEqual(parseChatTexts("not json"), {});
  assert.deepEqual(parseChatTexts(null), {});
  assert.deepEqual(parseChatTexts("[1,2]"), {});
  assert.deepEqual(parseChatTexts("{}"), {});
});
await test("each text is capped at its length; markup characters can't get in", () => {
  for (const [key, , max] of CHAT_TEXT_FIELDS) {
    assert.equal(parseChatTexts(JSON.stringify({ [key]: "x".repeat(300) }))[key].length, max, key);
  }
  assert.equal(cleanChatText("<script>Hi</script>", 60), "scriptHi/script");
});
await test("the Settings form round trip: what's typed is what's shown back; blank stays blank", () => {
  const typed = { textName: " Aetrex Shopping Assistant ", textStartHeading: "Get started", textPopularHeading: "", textInput: "Ask me anything" };
  const json = chatTextsFromForm((f) => typed[f] ?? null);
  assert.deepEqual(JSON.parse(json), { name: "Aetrex Shopping Assistant", startHeading: "Get started", input: "Ask me anything" });
  const back = chatTextsForForm(json);
  assert.equal(back.textName, "Aetrex Shopping Assistant");
  assert.equal(back.textPopularHeading, "");
  assert.equal(Object.keys(back).length, CHAT_TEXT_FIELDS.length, "every field");
  assert.equal(chatTextsFromForm(() => ""), "{}", "all blank → nothing set");
});
await test("the assistant goes by the name set here; otherwise as before", () => {
  assert.match(buildLeanSystemPrompt({ shop: "x", config: { chatTexts: '{"name":"Aetrex Shopping Assistant"}' } }), /^You are Aetrex Shopping Assistant,/);
  assert.match(buildLeanSystemPrompt({ shop: "x", config: { assistantName: "Fit Pro", chatTexts: "{}" } }), /^You are Fit Pro,/);
  assert.match(buildLeanSystemPrompt({ shop: "x" }), /^You are AI Shopping Assistant,/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
