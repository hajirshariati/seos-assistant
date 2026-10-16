// Lean engine — HTTP/SSE wrapper. Emits the same events the widget already
// understands (text → products → done), so no storefront change is needed.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../../db.server.js";
import { getKnowledgeFilesWithContent } from "../../models/ShopConfig.server.js";
import { recordChatUsage } from "../../models/ChatUsage.server.js";
import { retrieveRelevantChunks, lexicalRetrieveChunks } from "../knowledge-chunks.server.js";
import { withAnthropicRetry, classifyAnthropicError, customerFacingFailureMessage } from "../anthropic-resilience.server.js";
import { loadLeanCatalog } from "./catalog.server.js";
import { runLeanTurn } from "./engine.js";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// Which engine answers this request. LEAN_CHAT_SHOPS="shop-a.myshopify.com,…"
// (or "*") switches storefront traffic; admin test/compare calls can pick
// either engine explicitly with body.engine.
export function leanEngineSelected({ shop, internal = false, body = {} } = {}) {
  if (internal && body?.engine === "lean") return true;
  if (internal && body?.engine === "current") return false;
  const list = String(process.env.LEAN_CHAT_SHOPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(shop);
}

function makeStoreInfoLookup({ shop, config }) {
  let files = null;
  return async (query) => {
    if (!query.trim()) return { found: false };
    let chunks = null;
    if (config.knowledgeRagEnabled === true) {
      try { chunks = await retrieveRelevantChunks(prisma, { shop, query, config, limit: 4 }); }
      catch (err) { console.error("[lean] store-info rag failed:", err?.message || err); }
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      if (!files) files = await getKnowledgeFilesWithContent(shop);
      chunks = lexicalRetrieveChunks(files, query, { limit: 4, minOverlap: 0.25 });
    }
    if (!chunks || chunks.length === 0) return { found: false };
    const text = chunks
      .map((c) => `${c.sectionTitle ? `${c.sectionTitle}: ` : ""}${String(c.content || "").trim()}`)
      .join("\n\n")
      .slice(0, 6000);
    return { found: true, text };
  };
}

export function leanChatResponse({ shop, config, messages, latestUserMessage, internal = false }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(sse(obj)));
      try {
        const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
        const model = config.anthropicModel || "claude-sonnet-4-6";
        const catalog = await loadLeanCatalog(shop);
        console.log(`[lean] turn shop=${shop} internal=${internal} msg="${String(latestUserMessage).slice(0, 80)}"`);
        const result = await runLeanTurn({
          shop,
          config,
          model,
          catalog,
          messages,
          latestUserMessage,
          lookupStoreInfo: makeStoreInfoLookup({ shop, config }),
          callModel: (req) => withAnthropicRetry(() => anthropic.messages.create(req)),
        });
        send({ type: "text", text: result.text });
        send({ type: "products", products: result.cards });
        send({ type: "done" });
        if (!internal) {
          recordChatUsage({ shop, model, usage: result.usage, toolCalls: result.toolCalls })
            .catch((err) => console.error("[lean] usage log error:", err?.message));
        }
      } catch (err) {
        console.error("[lean] turn failed:", err?.message || err);
        const classified = classifyAnthropicError(err);
        send({ type: "error", message: customerFacingFailureMessage(classified.kind) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
