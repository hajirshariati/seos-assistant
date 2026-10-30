// Unit tests for Anthropic failure classification + the customer-facing
// fallback message. Pure functions — no network, no API.

import assert from "node:assert/strict";
import { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import {
  classifyAnthropicError,
  customerFacingFailureMessage,
  withAnthropicRetry,
} from "../app/lib/anthropic-resilience.server.js";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); failures.push({ name, err }); failed++; }
}

console.log("Anthropic resilience eval\n");

test("classifies a credit/billing 400 as billing (non-retryable)", () => {
  const err = Object.assign(new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "billing");
  assert.equal(c.retryable, false);
});

test("classifies 429 as rate_limit (retryable)", () => {
  const c = classifyAnthropicError(Object.assign(new Error("rate limit"), { status: 429 }));
  assert.equal(c.kind, "rate_limit");
  assert.equal(c.retryable, true);
});

test("classifies 5xx as upstream (retryable)", () => {
  const c = classifyAnthropicError(Object.assign(new Error("503 upstream down"), { status: 503 }));
  assert.equal(c.kind, "upstream");
  assert.equal(c.retryable, true);
});

test("classifies ECONNRESET as network (retryable)", () => {
  const c = classifyAnthropicError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  assert.equal(c.kind, "network");
  assert.equal(c.retryable, true);
});

test("classifies an unknown 400 as unknown (non-retryable)", () => {
  const c = classifyAnthropicError(Object.assign(new Error("bad request"), { status: 400 }));
  assert.equal(c.kind, "unknown");
  assert.equal(c.retryable, false);
});

// Production 2026-10-30: "[lean] turn failed: Error: Connection error." — the
// SDK's APIConnectionError (no status; the socket error two causes down)
// wasn't retried, and the shopper saw the generic "having trouble" note.
const sdkConnectionError = () => {
  const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  const fetchFailed = new TypeError("fetch failed", { cause: socket });
  return new APIConnectionError({ cause: fetchFailed });
};
test("the SDK's \"Connection error.\" is a network failure (retryable)", () => {
  const err = sdkConnectionError();
  assert.equal(err.message, "Connection error.");
  assert.deepEqual(classifyAnthropicError(err), { kind: "network", retryable: true });
  assert.deepEqual(classifyAnthropicError(new APIConnectionTimeoutError()), { kind: "network", retryable: true });
  assert.deepEqual(classifyAnthropicError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })), { kind: "network", retryable: true }, "a code down the causes");
});
const retried = async (makeErr) => {
  let calls = 0;
  const out = await withAnthropicRetry(async () => { calls++; if (calls === 1) throw makeErr(); return "ok"; }, { baseDelayMs: 1, label: "test" }).catch((e) => e);
  return { calls, out };
};
const asyncTests = [];
asyncTests.push(["a dropped connection is tried again, and the turn goes on", async () => {
  const r = await retried(sdkConnectionError);
  assert.equal(r.calls, 2);
  assert.equal(r.out, "ok");
  const t = await retried(() => new APIConnectionTimeoutError());
  assert.equal(t.calls, 2);
  assert.equal(t.out, "ok");
}]);
asyncTests.push(["a bad request is not tried again", async () => {
  const r = await retried(() => Object.assign(new Error("400 invalid"), { status: 400 }));
  assert.equal(r.calls, 1);
  assert.equal(r.out.status, 400);
}]);

test("billing/down message points the customer to human support", () => {
  const m = customerFacingFailureMessage("billing");
  assert.match(m, /customer service|support/i);
  assert.ok(m.length > 0);
});

test("every kind yields a non-empty, leak-free customer message", () => {
  for (const kind of ["billing", "rate_limit", "upstream", "network", "unknown", "anything-else"]) {
    const m = customerFacingFailureMessage(kind);
    assert.ok(typeof m === "string" && m.trim().length > 0, `empty for ${kind}`);
    assert.doesNotMatch(m, /\b(?:status|stack|api|token|anthropic|400|429|500)\b/i, `leaks internals for ${kind}: ${m}`);
  }
});

for (const [name, fn] of asyncTests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); failures.push({ name, err }); failed++; }
}

console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`  ${f.name}: ${f.err?.stack || f.err}`);
  process.exit(1);
}
