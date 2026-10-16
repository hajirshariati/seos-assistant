// Lean engine — one customer turn.
//
//   Claude decides → tools return facts → fact check → (one rewrite if needed)
//
// No pre-classification, no rewriting of Claude's searches, no editing of its
// words. The only code-owned additions are the product cards Claude chose
// (from show_products) and the medical note. Pure apart from the injected
// `anthropic` client and `lookupStoreInfo` function, so it runs in tests with
// stubs.

import { leanSearch, productDetails } from "./search.js";
import { buildLeanTools } from "./tools.js";
import { buildLeanSystemPrompt } from "./prompt.js";
import { verifyLeanAnswer, buildFamilyIndex } from "./verify.js";
import { applyMedicalDisclaimer } from "../medical-disclaimer.js";

const MAX_HOPS = 8;
const MAX_CARDS = 4;

// Titles of cards shown in earlier turns — sanitizeHistory appends them to the
// assistant text as "[Product cards displayed with this reply: 1. Title ($x); …]".
export function extractPriorShownTitles(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    for (const block of m.content.matchAll(/\[Product cards displayed with this reply: ([^\]]+)\]/g)) {
      // Keep "Title ($99.95)" — the price stays usable by the fact check.
      for (const item of block[1].split(/;\s*/)) {
        const entry = item.trim().replace(/^\d+\.\s*/, "");
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

// Anthropic needs user/assistant alternation starting with a user turn.
export function normalizeConversation(messages = []) {
  const conv = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) continue;
    if (conv.length === 0 && m.role !== "user") continue;
    const last = conv[conv.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else conv.push({ role: m.role, content });
  }
  return conv;
}

function addUsage(total, u = {}) {
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    total[k] = (total[k] || 0) + (Number(u[k]) || 0);
  }
}

export function toCard(p) {
  return {
    title: p.title,
    url: p.url,
    handle: p.handle,
    image: p.image || "",
    price: Number.isFinite(p.price) ? p.price.toFixed(2) : "",
    price_formatted: p.priceLabel,
    compare_at_price: p.onSale ? Math.round(p.compareAtPrice * 100) : undefined,
  };
}

export async function runLeanTurn({
  anthropic,
  model,
  shop = "",
  config = {},
  catalog,
  messages = [],
  latestUserMessage = "",
  lookupStoreInfo = async () => ({ found: false }),
  primaryGender = "women",
  log = (line) => console.log(line),
  callModel = null, // test seam: (request) => response
}) {
  const started = Date.now();
  const products = catalog?.products || [];
  const byHandle = new Map(products.map((p) => [p.handle, p]));
  const byTitle = new Map(products.map((p) => [p.title.toLowerCase(), p]));
  const familyIndex = buildFamilyIndex(products);

  const tools = buildLeanTools(catalog?.vocab || {});
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  const system = [{
    type: "text",
    text: buildLeanSystemPrompt({ config, vocab: catalog?.vocab || {}, shop, primaryGender }),
    cache_control: { type: "ephemeral" },
  }];

  const conv = normalizeConversation(messages);
  const priorTitles = extractPriorShownTitles(messages);
  const priorProducts = priorTitles
    .map((t) => byTitle.get(t.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase()))
    .filter(Boolean);

  const seen = new Map(priorProducts.map((p) => [p.handle, p])); // handles Claude may show
  const seenThisTurn = new Map();
  let shown = [];
  let knowledgeText = "";
  const usage = {};
  let toolCalls = 0;
  let retried = false;
  let text = "";
  let finalIssues = [];

  const markSeen = (handles) => {
    for (const h of handles) {
      const p = byHandle.get(h);
      if (p) { seen.set(h, p); seenThisTurn.set(h, p); }
    }
  };

  const runTool = async (name, input = {}) => {
    if (name === "search_products") {
      const result = leanSearch(catalog, input);
      markSeen(result.products.map((p) => p.handle));
      log(`[lean] search ${JSON.stringify(input)} → total=${result.total_matches} returned=${result.products.length}${result.if_relaxed ? ` if_relaxed=${JSON.stringify(result.if_relaxed)}` : ""}`);
      return result;
    }
    if (name === "get_product_details") {
      const d = productDetails(catalog, String(input.handle || ""));
      if (!d) return { error: "No product with that handle. Search first." };
      markSeen([d.handle, ...d.style_colorways.map((c) => c.handle)]);
      log(`[lean] details ${input.handle}`);
      return d;
    }
    if (name === "show_products") {
      const handles = (Array.isArray(input.handles) ? input.handles : []).map(String);
      const ok = handles.filter((h) => seen.has(h)).slice(0, MAX_CARDS);
      const rejected = handles.filter((h) => !seen.has(h));
      shown = ok;
      log(`[lean] show ${JSON.stringify(ok)}${rejected.length ? ` rejected=${JSON.stringify(rejected)}` : ""}`);
      return {
        showing: ok.map((h) => byHandle.get(h).title),
        ...(rejected.length ? { rejected, note: "Rejected handles weren't returned by a tool in this conversation — search first." } : {}),
      };
    }
    if (name === "search_store_info") {
      const r = await lookupStoreInfo(String(input.query || ""));
      if (r?.text) knowledgeText += `\n${r.text}`;
      log(`[lean] store-info "${String(input.query || "").slice(0, 60)}" found=${Boolean(r?.found)}`);
      return r?.found ? { found: true, info: r.text } : { found: false, note: "No store info on this. Say you're not sure and point to customer service." };
    }
    return { error: `Unknown tool ${name}` };
  };

  const call = callModel || ((req) => anthropic.messages.create(req));

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const resp = await call({ model, max_tokens: 900, system, tools, messages: conv });
    addUsage(usage, resp.usage);
    const content = Array.isArray(resp.content) ? resp.content : [];
    conv.push({ role: "assistant", content });
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (toolUses.length > 0) {
      const results = [];
      for (const tu of toolUses) {
        toolCalls += 1;
        let out;
        try { out = await runTool(tu.name, tu.input || {}); }
        catch (err) { out = { error: String(err?.message || err) }; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      conv.push({ role: "user", content: results });
      if (resp.stop_reason === "tool_use") continue;
    }

    text = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const issues = verifyLeanAnswer({
      text,
      shownHandles: shown,
      seenProducts: [...seen.values()],
      priorTitles,
      familyIndex,
      knowledgeText,
    });
    if (issues.length > 0 && !retried) {
      retried = true;
      log(`[lean] fact-check failed → rewrite: ${issues.map((i) => i.code).join(",")}`);
      conv.push({
        role: "user",
        content: `[Automatic fact check — the customer has not seen your reply yet.] ${issues.map((i) => i.detail).join(" ")} Write your reply to the customer again, corrected. You may use tools.`,
      });
      continue;
    }
    finalIssues = issues;
    break;
  }

  if (!text) {
    log(`[lean] no final text after ${MAX_HOPS} hops`);
    text = "Sorry — I couldn't finish that one. Could you try asking again?";
  }

  const md = applyMedicalDisclaimer({ workflow: "condition_recommendation", message: latestUserMessage, text });
  text = md.text;

  const cards = shown.map((h) => byHandle.get(h)).filter(Boolean).map(toCard);
  log(
    `[lean] final textLen=${text.length} cards=${cards.length} tools=${toolCalls} rewrite=${retried} ` +
    `unresolved=${finalIssues.map((i) => i.code).join(",") || "-"} ms=${Date.now() - started}`,
  );
  return { text, cards, usage, toolCalls, retried, issues: finalIssues, newSeen: [...seenThisTurn.keys()] };
}
