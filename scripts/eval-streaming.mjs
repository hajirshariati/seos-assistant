// Streamed model calls (app/lib/lean/stream-call.server.js): the words reach
// the draft callback as they are written, the call still resolves to the
// complete message, a client without streaming is called the plain way,
// and the drafts are throttled with the latest always sent.
//
// Run: node scripts/eval-streaming.mjs
import assert from "node:assert/strict";
import { streamModelCall, draftThrottle } from "../app/lib/lean/stream-call.server.js";

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };

// A stand-in for the SDK's stream: emits text events, then resolves the message.
const fakeStream = (pieces, final) => {
  const handlers = {};
  return {
    on(ev, fn) { handlers[ev] = fn; return this; },
    async finalMessage() {
      let so = "";
      for (const p of pieces) { so += p; handlers.text?.(p, so); await new Promise((r) => setTimeout(r, 2)); }
      return final;
    },
  };
};

console.log("\nthe streamed call");
await test("the words arrive as they are written (the whole text so far), and the call resolves to the complete message with its tool calls and usage", async () => {
  const final = { content: [{ type: "text", text: "Here are two boots." }, { type: "tool_use", id: "t1", name: "show_products", input: { handles: ["a"] } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } };
  const seen = [];
  const client = { messages: { stream: (req, opts) => { seen.push(["stream", req.model, opts.timeout]); return fakeStream(["Here ", "are two ", "boots."], final); } } };
  const drafts = [];
  const out = await streamModelCall(client, { model: "m", messages: [] }, { timeout: 1234, onDraft: (t) => drafts.push(t) });
  assert.deepEqual(drafts, ["Here ", "Here are two ", "Here are two boots."]);
  assert.equal(out, final);
  assert.deepEqual(seen, [["stream", "m", 1234]]);
});
await test("a client without streaming (the evals' stand-ins) is called the plain way, no drafts", async () => {
  const final = { content: [{ type: "text", text: "Plain." }] };
  const client = { messages: { create: async (req, opts) => { assert.equal(opts.timeout, 99); return final; } } };
  const drafts = [];
  assert.equal(await streamModelCall(client, { model: "m" }, { timeout: 99, onDraft: (t) => drafts.push(t) }), final);
  assert.deepEqual(drafts, []);
});
await test("a draft callback that throws never breaks the call", async () => {
  const final = { content: [] };
  const client = { messages: { stream: () => fakeStream(["a", "b"], final) } };
  assert.equal(await streamModelCall(client, {}, { onDraft: () => { throw new Error("boom"); } }), final);
});

console.log("\nthe throttle");
await test("at most one draft per window, the latest words always, the last on flush", () => {
  let t = 1000;
  const timers = [];
  const sent = [];
  const th = draftThrottle((x) => sent.push([t, x]), { everyMs: 80, now: () => t, schedule: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; } });
  const tick = (to) => { t = to; for (const h of timers.splice(0)) if (h.at <= t) h.fn(); };
  th.push("H");
  assert.deepEqual(sent, [[1000, "H"]], "the first goes at once");
  t = 1010; th.push("He"); t = 1020; th.push("Hel");
  assert.equal(sent.length, 1, "inside the window nothing more is sent");
  tick(1080);
  assert.deepEqual(sent.at(-1), [1080, "Hel"], "the latest words when the window ends");
  t = 1100; th.push("Hell");
  th.flush();
  assert.deepEqual(sent.at(-1), [1100, "Hell"], "flush sends what's pending");
  th.flush();
  assert.equal(sent.length, 3, "nothing twice");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
