// Resilience helpers for Anthropic API calls.
//
// Production failures observed in Railway logs:
//   - Transient 5xx (Anthropic upstream blip): ~1-3 per 1000 calls
//   - 429 rate-limit (concurrent traffic spike): rare but bursts
//   - Network reset / ECONNRESET: rare
//
// Without retry, every one of these surfaces as the generic "I'm having
// trouble" message to the customer. With a short retry on safe-to-retry
// errors, most of them recover invisibly.
//
// What we retry:
//   - HTTP 5xx (server errors) and 529 (overloaded)
//   - HTTP 429 (rate limit), waiting at least as long as the API's
//     retry-after asks — unless that's longer than a shopper should wait
//   - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, network) — and
//     the SDK's own "Connection error." / "Request timed out." (no status;
//     the real network error is its cause, or its cause's cause)
//
// What we do NOT retry:
//   - HTTP 4xx other than 429 (auth, validation, billing) — retry won't
//     help and just delays the customer's error
//   - Errors after partial output (would duplicate to the customer)

import { APIConnectionError } from "@anthropic-ai/sdk";

const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504, 522, 524, 529]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  // Node's fetch (undici): the other side closed a kept-alive socket, or
  // connecting took too long.
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// A network failure before any answer: the SDK's APIConnectionError
// ("Connection error.", or "Request timed out."), or a network code
// anywhere down the error's causes.
function isConnectionFailure(err) {
  if (err instanceof APIConnectionError) return true;
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (e.code && RETRYABLE_NETWORK_CODES.has(e.code)) return true;
  }
  return false;
}

// The first error code down the causes (for the log): "UND_ERR_SOCKET", …
function failureCode(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) if (e.code) return e.code;
  return err instanceof APIConnectionError ? err.constructor.name : "";
}

function isRetryableError(err) {
  if (!err) return false;
  // Anthropic SDK exposes `.status` on APIError instances.
  const status = err.status ?? err.response?.status;
  if (typeof status === "number" && RETRYABLE_HTTP_CODES.has(status)) return true;
  if (isConnectionFailure(err)) return true;
  // Fallback: message includes a retry-eligible signal.
  const msg = String(err.message || "").toLowerCase();
  if (/network|timeout|econnreset|temporarily|overloaded|retry/.test(msg)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long the API asked us to wait before trying again (retry-after-ms or
// retry-after, in seconds), in ms — or null.
export function retryAfterMs(err) {
  const h = err?.headers;
  const get = (k) => (h && typeof h.get === "function" ? h.get(k) : h?.[k]);
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const sec = Number(get("retry-after"));
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  return null;
}

// Exponential backoff with jitter. Defaults: 2 retries, 500ms then 1500ms,
// or the API's retry-after when that's longer. No retry waits past
// maxWaitMs, or past deadlineAt (the end of the shopper's turn) — then the
// original error is rethrown at once.
//
// Use ONLY for non-streaming calls or stream-init that hasn't emitted
// tokens to the customer yet. Retrying mid-stream would duplicate text.
export async function withAnthropicRetry(fn, opts = {}) {
  const { maxRetries = 2, baseDelayMs = 500, label = "anthropic", maxWaitMs = 10_000, deadlineAt = 0 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryableError(err)) throw err;
      const backoff = baseDelayMs * Math.pow(3, attempt) + Math.floor(Math.random() * 200);
      const delay = Math.max(backoff, retryAfterMs(err) || 0);
      if (delay > maxWaitMs) throw err;
      // Leave the retry a few seconds to run before the turn's end.
      if (deadlineAt && Date.now() + delay + 3000 > deadlineAt) throw err;
      console.log(`[${label}] retry ${attempt + 1}/${maxRetries} after ${delay}ms — ${err?.status || failureCode(err) || "unknown"}: ${String(err?.message || err).slice(0, 120)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Classify an error so the customer-facing message can be specific.
// Used by the chat route's stream-error handler.
export function classifyAnthropicError(err) {
  const status = err?.status ?? err?.response?.status;
  const raw = String(err?.message || "").toLowerCase();
  if (raw.includes("credit balance") || raw.includes("billing") || raw.includes("insufficient")) {
    return { kind: "billing", retryable: false };
  }
  if (status === 429 || raw.includes("rate limit")) {
    return { kind: "rate_limit", retryable: true };
  }
  if (status && status >= 500 && status < 600) {
    return { kind: "upstream", retryable: true };
  }
  if (isConnectionFailure(err)) {
    return { kind: "network", retryable: true };
  }
  // This server already has as many AI requests running as it allows.
  if (err?.code === "AI_BUSY") {
    return { kind: "busy", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

// Customer-facing message for a classified failure. Kept here (not inline
// in the route) so it is the single, unit-tested source of truth for what
// the shopper sees when the model call ultimately fails. A "billing"/down
// failure points the customer to human support rather than dead-ending.
export function customerFacingFailureMessage(kind) {
  switch (kind) {
    case "billing":
      return "I'm temporarily unavailable right now. Please try again shortly, or reach out to our customer service team and they'll be glad to help.";
    case "rate_limit":
    case "busy":
      return "I'm getting a lot of questions right now! Please try again in a moment.";
    case "upstream":
    case "network":
      return "I'm having trouble reaching my service right now. Please try again in a moment.";
    default:
      return "I'm sorry, I'm having trouble right now. Please try again in a moment.";
  }
}
