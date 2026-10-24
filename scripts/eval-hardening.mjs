// Storefront hardening — limits on what a shopper's browser can send, and
// the URL check for merchant-entered endpoints the server calls.
//
// Run: node scripts/eval-hardening.mjs

import { readdirSync } from "node:fs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sanitizeHistory, withoutTrailingCopy, HISTORY_MAX_TURNS, HISTORY_MAX_TURN_CHARS, HISTORY_MAX_TOTAL_CHARS } from "../app/lib/lean/history.js";
import { safeExternalUrl } from "../app/lib/external-url.js";
import { chatModel, ALLOWED_MODELS } from "../app/lib/claude-models.js";
import { typeformId, feedbackSurveyConfig } from "../app/lib/feedback-survey.js";
import { appearDelayConfig, clampDelay, startTheme, parseCountries, internationalConfig } from "../app/lib/appear-delay.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log("\nconversation history from the browser");
test("an oversized history is cut to the most recent turns that fit", () => {
  const big = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ` + "x".repeat(25000) }));
  const h = sanitizeHistory(big);
  assert.ok(h.length <= HISTORY_MAX_TURNS);
  assert.ok(h.every((t) => t.content.length <= HISTORY_MAX_TURN_CHARS));
  assert.ok(h.reduce((n, t) => n + t.content.length, 0) <= HISTORY_MAX_TOTAL_CHARS);
  assert.match(h.at(-1).content, /^199 /, "keeps the newest turn");
});
test("a normal conversation passes through unchanged", () => {
  const h = sanitizeHistory([{ role: "user", content: "sandals" }, { role: "assistant", content: "Here are a few." }]);
  assert.deepEqual(h, [{ role: "user", content: "sandals" }, { role: "assistant", content: "Here are a few." }]);
});
test("the message being sent isn't counted twice", () => {
  const h = [{ role: "assistant", content: "Hi" }, { role: "user", content: "wide sneakers " }];
  assert.equal(withoutTrailingCopy(h, "wide sneakers").length, 1);
  assert.equal(withoutTrailingCopy(h, "boots").length, 2);
});

console.log("\nmerchant-entered endpoints");
test("public https endpoints are allowed", () => {
  assert.equal(safeExternalUrl("https://fit.example.com/v1?a=1"), "https://fit.example.com/v1?a=1");
});
test("http, credentials and internal addresses are refused", () => {
  for (const u of ["http://fit.example.com", "https://localhost/x", "https://169.254.169.254/latest/meta-data",
    "https://10.1.2.3/", "https://192.168.0.1/", "https://172.20.0.1/", "https://[::1]/", "https://2130706433/",
    "https://u:p@fit.example.com/", "https://db.internal/", "not a url", ""]) {
    assert.equal(safeExternalUrl(u), null, u);
  }
});

console.log("\nClaude model ids");
test("deprecated stored models run on the current model of the same tier", () => {
  assert.equal(chatModel("claude-sonnet-4-20250514"), "claude-sonnet-4-6");
  assert.equal(chatModel("claude-opus-4-20250514"), "claude-opus-4-7");
  assert.equal(chatModel(""), "claude-sonnet-4-6");
  assert.equal(chatModel("made-up-model"), "claude-sonnet-4-6");
  for (const m of ALLOWED_MODELS) assert.equal(chatModel(m), m);
});

// Shopify refuses to deploy other file types in a theme app extension's
// assets ("Only these filetypes are supported in assets: …").
test("theme extension assets use only file types Shopify accepts", () => {
  const dir = new URL("../extensions/hajirai-chat-widget/assets/", import.meta.url);
  const bad = readdirSync(dir).filter((f) => !/\.(jpe?g|json|js|css|png|svg|wasm)$/i.test(f));
  assert.deepEqual(bad, [], `not allowed in assets/: ${bad.join(", ")}`);
});

// Shopify refuses to release the theme block otherwise ("must have a maximum
// of 6 for non-interactive settings"); this catches it before a deploy does.
test("the chat block's settings stay within Shopify's limits", () => {
  const liquid = fs.readFileSync(new URL("../extensions/hajirai-chat-widget/blocks/hajirai_chat.liquid", import.meta.url), "utf8");
  const schema = JSON.parse(liquid.slice(liquid.indexOf("{% schema %}") + 12, liquid.indexOf("{% endschema %}")));
  const nonInteractive = schema.settings.filter((s) => s.type === "header" || s.type === "paragraph").length;
  // Theme check: "declares 41 settings, which exceeds the maximum of 40".
  const inputs = schema.settings.length - nonInteractive;
  assert.ok(inputs <= 40, `${inputs} input settings — Shopify allows 40 per block`);
  assert.ok(nonInteractive <= 6, `${nonInteractive} headers/paragraphs (max 6)`);
  const ids = schema.settings.filter((s) => s.id).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "setting ids are unique");
  for (const id of ids) assert.match(liquid, new RegExp(`block\\.settings\\.${id}\\b`), `setting "${id}" is used`);
});

console.log("\nfeedback survey setting");
test("takes a Typeform ID or any of its links, and nothing else", () => {
  assert.equal(typeformId("jdXBrXMa"), "jdXBrXMa");
  assert.equal(typeformId(" https://form.typeform.com/to/jdXBrXMa?utm=x "), "jdXBrXMa");
  assert.equal(typeformId("https://aetrex.typeform.com/to/jdXBrXMa#a=1"), "jdXBrXMa");
  for (const bad of ["", "x", "jdX BrXMa", "javascript:alert(1)", "https://evil.example/to/abc", "<b>"]) assert.equal(typeformId(bad), "", bad);
});
test("the widget gets the button only when it's on and has a survey", () => {
  assert.deepEqual(feedbackSurveyConfig({ feedbackSurveyOn: true, feedbackSurvey: "https://form.typeform.com/to/jdXBrXMa", feedbackSurveyLabel: "" }), { on: true, form: "jdXBrXMa", label: "Share feedback" });
  assert.equal(feedbackSurveyConfig({ feedbackSurveyOn: true, feedbackSurvey: "" }).on, false);
  assert.equal(feedbackSurveyConfig({ feedbackSurveyOn: false, feedbackSurvey: "jdXBrXMa" }).on, false);
  assert.equal(feedbackSurveyConfig({ feedbackSurveyOn: true, feedbackSurvey: "jdXBrXMa", feedbackSurveyLabel: "x".repeat(90) }).label.length, 40);
  assert.deepEqual(feedbackSurveyConfig(), { on: false, form: "", label: "Share feedback" });
});

console.log("\nshowing the chat after a delay");
test("whole seconds from 1 to 60; off unless switched on", () => {
  assert.deepEqual(appearDelayConfig(), { on: false, sec: 3 });
  assert.deepEqual(appearDelayConfig({ appearDelayOn: true, appearDelaySec: 5 }), { on: true, sec: 5 });
  assert.equal(clampDelay(0), 1);
  assert.equal(clampDelay(999), 60);
  assert.equal(clampDelay("7.9"), 7);
  assert.equal(clampDelay("abc"), 3);
});
test("international: hidden by default; home countries are clean two-letter codes", () => {
  assert.deepEqual(internationalConfig(), { hide: true, home: ["US"] });
  assert.deepEqual(internationalConfig({ hideInternational: false, homeCountries: "US" }), { hide: false, home: ["US"] });
  assert.deepEqual(parseCountries(" us, pr ;ca,US, USA, x"), ["US", "PR", "CA"]);
  assert.deepEqual(parseCountries(""), ["US"]);
});
test("the chat starts dark unless the store picks light", () => {
  assert.equal(startTheme("light"), "light");
  for (const v of ["dark", "", undefined, "LIGHT", "blue"]) assert.equal(startTheme(v), "dark", String(v));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
