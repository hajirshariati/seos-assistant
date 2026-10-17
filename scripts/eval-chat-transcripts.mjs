#!/usr/bin/env node

// Live transcript evaluator for the storefront chat endpoint.
//
// This is intentionally different from the unit-ish evals:
//   - It POSTs to the real /chat route.
//   - It parses the streamed SSE payload the widget receives.
//   - It asserts on visible text, final product cards, chips, links, and errors.
//   - It preserves conversation history across turns.
//
// Usage:
//   npm run eval:chat-transcripts -- --list
//   CHAT_TRANSCRIPT_BASE_URL=https://your-app.up.railway.app \
//   CHAT_TRANSCRIPT_SHOP=f031fc-3.myshopify.com \
//   SHOPIFY_API_SECRET=... \
//     npm run eval:chat-transcripts
//
// You can also pass a fully signed URL:
//   CHAT_TRANSCRIPT_URL='https://your-app.up.railway.app/chat?...&signature=...' \
//     npm run eval:chat-transcripts

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIOS = path.join(__dirname, "chat-transcripts.aetrex.json");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const scenarioFile = path.resolve(arg("file", DEFAULT_SCENARIOS));
const filter = String(arg("filter", "") || "").toLowerCase();
const stopOnFail = hasFlag("stop-on-fail");
const verbose = hasFlag("verbose");
const listOnly = hasFlag("list");
const help = hasFlag("help") || hasFlag("h");

if (help) {
  console.log(`
Live chat transcript evaluator

Options:
  --file=PATH        Transcript JSON file. Default: scripts/chat-transcripts.aetrex.json
  --filter=TEXT      Run scenarios whose name contains TEXT.
  --list             Print scenario names and exit.
  --stop-on-fail     Stop after the first failing scenario.
  --verbose          Print parsed SSE payloads.

Endpoint configuration:
  CHAT_TRANSCRIPT_URL       Full signed /chat URL. If set, used as-is.
  CHAT_TRANSCRIPT_BASE_URL  App base URL, e.g. https://x.up.railway.app or http://localhost:8080.
  CHAT_TRANSCRIPT_PATH      Chat route path. Default: /chat.
  CHAT_TRANSCRIPT_SHOP      Shop domain. Default: f031fc-3.myshopify.com.
  CHAT_TRANSCRIPT_PREFIX    App proxy path_prefix. Default: /apps/hajirai.
  CHAT_TRANSCRIPT_CUSTOMER_ID Optional logged_in_customer_id.
  SHOPIFY_API_SECRET        Required when CHAT_TRANSCRIPT_URL is not provided.
`);
  process.exit(0);
}

function loadScenarios() {
  const raw = fs.readFileSync(scenarioFile, "utf8");
  const scenarios = JSON.parse(raw);
  if (!Array.isArray(scenarios)) {
    throw new Error(`Scenario file must contain a JSON array: ${scenarioFile}`);
  }
  return scenarios.filter((s) => !filter || String(s.name || "").toLowerCase().includes(filter));
}

const scenarios = loadScenarios();

if (listOnly) {
  console.log(`Scenarios in ${path.relative(process.cwd(), scenarioFile)}:`);
  scenarios.forEach((s, i) => console.log(`${String(i + 1).padStart(2, " ")}. ${s.name}`));
  process.exit(0);
}

function signAppProxyParams(params, secret) {
  const pairs = [...params.entries()]
    .filter(([key]) => key !== "signature" && key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join("");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function buildSignedChatUrl() {
  const provided = process.env.CHAT_TRANSCRIPT_URL;
  if (provided) return provided;

  const base = process.env.CHAT_TRANSCRIPT_BASE_URL;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!base || !secret) {
    throw new Error(
      "Missing endpoint config. Set CHAT_TRANSCRIPT_URL, or set CHAT_TRANSCRIPT_BASE_URL + SHOPIFY_API_SECRET.",
    );
  }

  const url = new URL(process.env.CHAT_TRANSCRIPT_PATH || "/chat", base);
  const params = new URLSearchParams();
  params.set("shop", process.env.CHAT_TRANSCRIPT_SHOP || "f031fc-3.myshopify.com");
  params.set("logged_in_customer_id", process.env.CHAT_TRANSCRIPT_CUSTOMER_ID || "");
  params.set("path_prefix", process.env.CHAT_TRANSCRIPT_PREFIX || "/apps/hajirai");
  params.set("timestamp", String(Math.floor(Date.now() / 1000)));
  params.set("signature", signAppProxyParams(params, secret));
  url.search = params.toString();
  return url.toString();
}

function shopFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.searchParams.get("shop") || process.env.CHAT_TRANSCRIPT_SHOP || "f031fc-3.myshopify.com";
  } catch {
    return process.env.CHAT_TRANSCRIPT_SHOP || "f031fc-3.myshopify.com";
  }
}

function parseSse(raw) {
  const events = [];
  const chunks = String(raw || "").split(/\n\n+/);
  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch (err) {
      events.push({ type: "parse_error", raw: payload, error: err?.message || String(err) });
    }
  }
  return events;
}

function visiblePayload(events) {
  const text = events
    .filter((e) => e?.type === "text")
    .map((e) => String(e.text || ""))
    .join("\n")
    .trim();

  let products = [];
  const links = [];
  const suggestions = [];
  const errors = [];
  const fitReports = [];

  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "products") products = Array.isArray(e.products) ? e.products : [];
    if (e.type === "link") links.push({ url: e.url || "", label: e.label || "" });
    if (e.type === "suggestions") suggestions.push(...(Array.isArray(e.questions) ? e.questions : []));
    if (e.type === "error") errors.push(e.message || e.error || "unknown error");
    if (e.type === "fit_report") fitReports.push(e);
  }

  return { text, products, links, suggestions, errors, fitReports, events };
}

async function postTurn({ message, history, sessionId }) {
  const url = buildSignedChatUrl();
  const shop = shopFromUrl(url);
  const body = {
    message,
    session_id: sessionId,
    shop_domain: shop,
    assistant_name: process.env.CHAT_TRANSCRIPT_ASSISTANT_NAME || "The Fit Concierge",
    // Same shape the storefront widget sends: cards shown under each reply ride along.
    history: history.slice(-20).map((m) => ({ role: m.role, content: m.content, ...(m.products?.length ? { products: m.products } : {}) })),
  };
  if (process.env.CHAT_TRANSCRIPT_SUPPORT_URL) body.support_url = process.env.CHAT_TRANSCRIPT_SUPPORT_URL;
  if (process.env.CHAT_TRANSCRIPT_SUPPORT_LABEL) body.support_label = process.env.CHAT_TRANSCRIPT_SUPPORT_LABEL;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 800)}`);
  }
  const events = parseSse(raw);
  return visiblePayload(events);
}

function includesCI(text, phrase) {
  return String(text || "").toLowerCase().includes(String(phrase || "").toLowerCase());
}

function matchRe(text, pattern) {
  return new RegExp(pattern, "i").test(String(text || ""));
}

function productNeedle(product) {
  return [
    product?.title,
    product?.handle,
    product?.url,
    product?.image,
    product?.price,
  ].filter(Boolean).join(" ").toLowerCase();
}

function extractChips(text) {
  const chips = [];
  const re = /<<\s*([^<>]+?)\s*>>/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) chips.push(m[1].trim());
  return chips;
}

function assertText(expect = {}, payload, failures) {
  const text = payload.text || "";
  for (const phrase of expect.mustInclude || []) {
    if (!includesCI(text, phrase)) failures.push(`text missing "${phrase}"`);
  }
  if (expect.mustIncludeAny?.length) {
    const ok = expect.mustIncludeAny.some((phrase) => includesCI(text, phrase));
    if (!ok) failures.push(`text missing any of: ${expect.mustIncludeAny.map((p) => JSON.stringify(p)).join(", ")}`);
  }
  for (const phrase of expect.mustNotInclude || []) {
    if (includesCI(text, phrase)) failures.push(`text contains forbidden "${phrase}"`);
  }
  if (expect.mustMatch && !matchRe(text, expect.mustMatch)) {
    failures.push(`text did not match /${expect.mustMatch}/i`);
  }
  if (expect.mustNotMatch && matchRe(text, expect.mustNotMatch)) {
    failures.push(`text matched forbidden /${expect.mustNotMatch}/i`);
  }
  if (typeof expect.maxLength === "number" && text.length > expect.maxLength) {
    failures.push(`text length ${text.length} > max ${expect.maxLength}`);
  }
  if (typeof expect.maxSentences === "number") {
    const count = (text.match(/[.!?](?:\s|$)/g) || []).length;
    if (count > expect.maxSentences) failures.push(`text sentence count ~${count} > max ${expect.maxSentences}`);
  }
}

function assertProducts(expect = {}, payload, failures) {
  const products = payload.products || [];
  if (typeof expect.min === "number" && products.length < expect.min) {
    failures.push(`products length ${products.length} < min ${expect.min}`);
  }
  if (typeof expect.max === "number" && products.length > expect.max) {
    failures.push(`products length ${products.length} > max ${expect.max}`);
  }
  if (expect.allTitleOrHandleMustMatch && products.length > 0) {
    const re = new RegExp(expect.allTitleOrHandleMustMatch, "i");
    const bad = products.filter((p) => !re.test(productNeedle(p)));
    if (bad.length > 0) {
      failures.push(
        `products not matching /${expect.allTitleOrHandleMustMatch}/i: ` +
          bad.map((p) => p.title || p.handle || "?").join(" | "),
      );
    }
  }
  if (expect.allTitleOrHandleMustNotMatch && products.length > 0) {
    const re = new RegExp(expect.allTitleOrHandleMustNotMatch, "i");
    const bad = products.filter((p) => re.test(productNeedle(p)));
    if (bad.length > 0) {
      failures.push(
        `products matched forbidden /${expect.allTitleOrHandleMustNotMatch}/i: ` +
          bad.map((p) => p.title || p.handle || "?").join(" | "),
      );
    }
  }
  if (expect.atLeastOneTitleOrHandleMustMatch && products.length > 0) {
    const re = new RegExp(expect.atLeastOneTitleOrHandleMustMatch, "i");
    if (!products.some((p) => re.test(productNeedle(p)))) {
      failures.push(`no product matched /${expect.atLeastOneTitleOrHandleMustMatch}/i`);
    }
  }
}

function assertChips(expect = {}, payload, failures) {
  const chips = extractChips(payload.text);
  if (expect.none === true && chips.length > 0) {
    failures.push(`expected no chips, got: ${chips.join(", ")}`);
  }
  for (const chip of expect.mustInclude || []) {
    if (!chips.some((c) => c.toLowerCase() === String(chip).toLowerCase())) {
      failures.push(`chip missing "${chip}"`);
    }
  }
  if (expect.mustIncludeAny?.length) {
    const ok = expect.mustIncludeAny.some((chip) =>
      chips.some((c) => c.toLowerCase() === String(chip).toLowerCase()),
    );
    if (!ok) failures.push(`chips missing any of: ${expect.mustIncludeAny.join(", ")} (got: ${chips.join(", ")})`);
  }
  for (const chip of expect.mustNotInclude || []) {
    if (chips.some((c) => c.toLowerCase() === String(chip).toLowerCase())) {
      failures.push(`chip contains forbidden "${chip}"`);
    }
  }
}

function assertLinks(expect = {}, payload, failures) {
  if (typeof expect.min === "number" && payload.links.length < expect.min) {
    failures.push(`links length ${payload.links.length} < min ${expect.min}`);
  }
  if (typeof expect.max === "number" && payload.links.length > expect.max) {
    failures.push(`links length ${payload.links.length} > max ${expect.max}`);
  }
  if (expect.labelMustInclude) {
    const ok = payload.links.some((l) => includesCI(l.label, expect.labelMustInclude));
    if (!ok) failures.push(`no link label included "${expect.labelMustInclude}"`);
  }
}

function assertPayload(expect = {}, payload) {
  const failures = [];
  if (payload.errors.length > 0) failures.push(`SSE error: ${payload.errors.join(" | ")}`);
  assertText(expect.text, payload, failures);
  assertProducts(expect.products, payload, failures);
  assertChips(expect.chips, payload, failures);
  assertLinks(expect.links, payload, failures);
  return failures;
}

async function runScenario(scenario, index) {
  const history = [];
  const sessionId = `transcript-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
  const turnResults = [];

  for (let i = 0; i < scenario.turns.length; i += 1) {
    const turn = scenario.turns[i];
    const payload = await postTurn({ message: turn.user, history, sessionId });
    const failures = assertPayload(turn.expect || {}, payload);
    turnResults.push({ turn: i + 1, user: turn.user, payload, failures });

    history.push({ role: "user", content: String(turn.user) });
    history.push({ role: "assistant", content: payload.text || "", products: payload.products || [] });

    if (verbose || failures.length > 0) {
      console.log(`\n[${scenario.name}] turn ${i + 1}: ${turn.user}`);
      console.log(`text: ${JSON.stringify(payload.text).slice(0, 800)}`);
      console.log(`products(${payload.products.length}): ${payload.products.map((p) => p.title || p.handle || "?").join(" | ")}`);
      const chips = extractChips(payload.text);
      if (chips.length) console.log(`chips: ${chips.join(", ")}`);
      if (payload.links.length) console.log(`links: ${payload.links.map((l) => l.label || l.url).join(" | ")}`);
      for (const f of failures) console.log(`  - ${f}`);
    }
  }

  const failures = turnResults.flatMap((r) => r.failures.map((f) => `turn ${r.turn}: ${f}`));
  return { name: scenario.name, ok: failures.length === 0, failures, turnResults };
}

if (scenarios.length === 0) {
  console.error(`No scenarios matched${filter ? ` filter="${filter}"` : ""}.`);
  process.exit(1);
}

console.log(`Running ${scenarios.length} live chat transcript scenario(s) from ${path.relative(process.cwd(), scenarioFile)}`);

let passed = 0;
let failed = 0;
const failedResults = [];

for (let i = 0; i < scenarios.length; i += 1) {
  const scenario = scenarios[i];
  try {
    const result = await runScenario(scenario, i + 1);
    if (result.ok) {
      passed += 1;
      console.log(`  PASS ${scenario.name}`);
    } else {
      failed += 1;
      failedResults.push(result);
      console.log(`  FAIL ${scenario.name}`);
      if (stopOnFail) break;
    }
  } catch (err) {
    failed += 1;
    const result = { name: scenario.name, ok: false, failures: [err?.message || String(err)] };
    failedResults.push(result);
    console.log(`  ERROR ${scenario.name}: ${err?.message || err}`);
    if (stopOnFail) break;
  }
}

console.log(`\nLive transcript result: ${passed} passed, ${failed} failed`);
if (failedResults.length > 0) {
  console.log("\nFailures:");
  for (const r of failedResults) {
    console.log(`- ${r.name}`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
