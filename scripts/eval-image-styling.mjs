// "See It Styled" image requests — checked against stand-in provider APIs
// (no network): which model is tried first, what falls back, what's sent.
//
// Run: node scripts/eval-image-styling.mjs

import assert from "node:assert/strict";
import { generateStyledImage, buildStylistPrompt } from "../app/lib/image-styling.server.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const calls = [];
function stub(handler) {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://cdn.example/")) {
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return handler(String(url), init);
  };
}
const ok = (json) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
const geminiImage = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }] };
const base = { productTitle: "Carly Arch Support Sneaker - Wine Sparkle", productImageUrls: ["https://cdn.example/1.png", "https://cdn.example/2.png", "https://cdn.example/3.png", "https://cdn.example/4.png"] };

console.log("\nprompt");
await test("a calm worn shot from the product's own angle — no forced walking pose", () => {
  const p = buildStylistPrompt({ productTitle: "Carly", styleContext: "" });
  assert.match(p, /relaxed, natural stance/);
  assert.match(p, /angle that matches the main reference photo/);
  assert.match(p, /Exactly two feet/);
  assert.doesNotMatch(p, /mid-stride|WALKING/);
});
await test("fine details are named so they aren't smoothed away", () => {
  assert.match(buildStylistPrompt({ productTitle: "x" }), /sparkle, sole color and logo/);
});

console.log("\ngemini");
await test("the newer model first, portrait, three product photos", async () => {
  stub(() => ok(geminiImage));
  const r = await generateStyledImage({ provider: "gemini", geminiApiKey: "k", ...base });
  assert.equal(r.imageDataUrl, "data:image/png;base64,AAAA");
  const api = calls.filter((c) => c.url.includes("generativelanguage"));
  assert.equal(api.length, 1);
  assert.match(api[0].url, /gemini-3\.1-flash-image-preview/);
  const body = JSON.parse(api[0].init.body);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "2:3");
  assert.equal(body.contents[0].parts.filter((p) => p.inline_data).length, 3);
});
await test("a key without the newer model falls back to the previous one", async () => {
  stub((url) => url.includes("gemini-3.1")
    ? new Response(JSON.stringify({ error: { message: "models/gemini-3.1-flash-image-preview is not found" } }), { status: 404 })
    : ok(geminiImage));
  const r = await generateStyledImage({ provider: "gemini", geminiApiKey: "k", ...base });
  assert.ok(r.imageDataUrl);
  assert.match(calls.filter((c) => c.url.includes("generativelanguage")).at(-1).url, /gemini-2\.5-flash-image/);
});
await test("a real failure (server error) isn't retried on another model", async () => {
  stub(() => new Response("boom", { status: 500 }));
  await assert.rejects(generateStyledImage({ provider: "gemini", geminiApiKey: "k", ...base }), /500/);
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 1);
});

console.log("\nopenai");
await test("gpt-image-1.5 at medium quality, portrait, all reference photos", async () => {
  stub(() => ok({ data: [{ b64_json: "BBBB" }] }));
  await generateStyledImage({ provider: "openai", openaiApiKey: "k", ...base });
  const form = calls.find((c) => c.url.includes("openai")).init.body;
  assert.equal(form.get("model"), "gpt-image-1.5");
  assert.equal(form.get("quality"), "medium");
  assert.equal(form.get("size"), "1024x1536");
  assert.equal(form.getAll("image[]").length, 3);
});
await test("a model that rejects the fidelity option is retried without it, same model", async () => {
  let n = 0;
  stub(() => (++n === 1
    ? new Response(JSON.stringify({ error: { message: "Unknown parameter: 'input_fidelity'." } }), { status: 400 })
    : ok({ data: [{ b64_json: "CCCC" }] })));
  await generateStyledImage({ provider: "openai", openaiApiKey: "k", ...base });
  const api = calls.filter((c) => c.url.includes("openai"));
  assert.equal(api.length, 2);
  assert.equal(api[1].init.body.get("model"), "gpt-image-1.5");
  assert.equal(api[1].init.body.get("input_fidelity"), null);
});
await test("no access to gpt-image-1.5 → gpt-image-1 (one image, low quality)", async () => {
  stub((url, init) => (init.body.get("model") === "gpt-image-1.5"
    ? new Response(JSON.stringify({ error: { message: "The model gpt-image-1.5 does not exist or you do not have access to it." } }), { status: 404 })
    : ok({ data: [{ b64_json: "DDDD" }] })));
  await generateStyledImage({ provider: "openai", openaiApiKey: "k", ...base });
  const last = calls.filter((c) => c.url.includes("openai")).at(-1).init.body;
  assert.equal(last.get("model"), "gpt-image-1");
  assert.equal(last.get("quality"), "low");
  assert.equal(last.getAll("image").length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
