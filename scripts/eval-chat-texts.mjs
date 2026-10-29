// The chat's own words (Settings → Look & feel → Chat text): tidied and
// capped, only the ones set reach the widget, a blank one keeps the theme
// editor's. Whatever name the chat shows, the assistant says it's Ava, the
// Aetrex Virtual Assistant (built into the system prompt).
//
// Run: node scripts/eval-chat-texts.mjs
import assert from "node:assert/strict";

const { CHAT_TEXT_FIELDS, ASSISTANT_NAME, ASSISTANT_TITLE, parseChatTexts, chatTextsFromForm, chatTextsForForm, cleanChatText } = await import("../app/lib/chat-texts.js");
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
await test("the cards' fit & size button: short words, set like the rest, & kept", () => {
  assert.deepEqual(CHAT_TEXT_FIELDS.find(([k]) => k === "fitButton"), ["fitButton", "textFitButton", 24, "Check fit & size"]);
  assert.deepEqual(parseChatTexts('{"fitButton":"  Does   this fit? "}'), { fitButton: "Does this fit?" });
  assert.deepEqual(parseChatTexts('{"fitButton":"Fit & size"}'), { fitButton: "Fit & size" });
});
await test("the assistant is Ava, the Aetrex Virtual Assistant — whatever name the chat shows", () => {
  assert.equal(ASSISTANT_NAME, "Ava");
  assert.equal(ASSISTANT_TITLE, "Aetrex Virtual Assistant");
  for (const config of [{}, { chatTexts: '{"name":"Aetrex Shopping Assistant"}' }, { assistantName: "Fit Pro", chatTexts: "{}" }]) {
    const p = buildLeanSystemPrompt({ shop: "x", config });
    assert.match(p, /^You are Ava, the Aetrex Virtual Assistant — the shopping assistant for x\./);
    assert.match(p, /Your name is Ava, short for Aetrex Virtual Assistant\. When asked who or what you are, say so; you're an AI assistant, never a person\./);
    assert.doesNotMatch(p, /Aetrex Shopping Assistant|Fit Pro|AI Shopping Assistant/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
