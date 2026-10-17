// Storefront hardening — limits on what a shopper's browser can send, and
// the URL check for merchant-entered endpoints the server calls.
//
// Run: node scripts/eval-hardening.mjs

import assert from "node:assert/strict";
import { sanitizeHistory, withoutTrailingCopy, HISTORY_MAX_TURNS, HISTORY_MAX_TURN_CHARS, HISTORY_MAX_TOTAL_CHARS } from "../app/lib/lean/history.js";
import { safeExternalUrl } from "../app/lib/external-url.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
