// Lean engine — HTTP/SSE wrapper. Emits the same events the widget already
// understands (text → products → done), so no storefront change is needed.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../../db.server.js";
import { getKnowledgeFilesWithContent, incrementRateLimitHits } from "../../models/ShopConfig.server.js";
import { recordChatUsage } from "../../models/ChatUsage.server.js";
import { retrieveRelevantChunks, lexicalRetrieveChunks } from "../knowledge-chunks.server.js";
import { withAnthropicRetry, classifyAnthropicError, customerFacingFailureMessage } from "../anthropic-resilience.server.js";
import { loadLeanCatalog } from "./catalog.server.js";
import { buildLeanStoreExtras } from "./store-tools.server.js";
import { logMentions } from "../../models/ChatProductMention.server.js";
import { logTopics } from "../../models/ChatTopic.server.js";
import { getActiveCampaigns, formatCampaignsForCS } from "../../models/Campaign.server.js";
import { supportChatLabel } from "../support-handoff.js";
import { buildVisualizeCtaEvent } from "../visualize-cta.server.js";
import { lexicalStoreKnowledge } from "../store-knowledge/sync.server.js";
import { runLeanTurn } from "./engine.js";
import { buildShopAllLink } from "./shop-all.js";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// Store info for Claude: the store team's uploaded notes first (they win if
// anything differs), then what was learned from the store's own website
// (policies + pages, store-knowledge sync).
function makeStoreInfoLookup({ shop, config }) {
  let files = null;
  const fmt = (c) => `${c.sectionTitle ? `${c.sectionTitle}: ` : ""}${String(c.content || "").trim()}`;
  return async (query) => {
    if (!query.trim()) return { found: false };
    if (!files) files = await getKnowledgeFilesWithContent(shop);
    const uploaded = lexicalRetrieveChunks(files, query, { limit: 3, minOverlap: 0.25 });
    let website = [];
    {
      // Semantic lookup whenever the store has an embedding provider; it
      // returns nothing otherwise and keyword matching carries the answer.
      try {
        const semantic = await retrieveRelevantChunks(prisma, { shop, query, config, limit: 5 });
        for (const c of semantic || []) {
          if (String(c.fileType || "").startsWith("store_")) website.push(c);
          else if (!uploaded.some((u) => u.content === c.content)) uploaded.push(c);
        }
      } catch (err) {
        console.error("[lean] store-info rag failed:", err?.message || err);
      }
    }
    if (website.length === 0) website = await lexicalStoreKnowledge(shop, query, { limit: 4 }).catch(() => []);
    if (uploaded.length === 0 && website.length === 0) return { found: false };
    const parts = [];
    if (uploaded.length) parts.push(`STORE TEAM NOTES (uploaded by the store — these win if anything differs):\n${uploaded.map(fmt).join("\n\n")}`);
    if (website.length) parts.push(`FROM THE STORE'S WEBSITE:\n${website.map(fmt).join("\n\n")}`);
    return { found: true, text: parts.join("\n\n").slice(0, 7000) };
  };
}

export function leanChatResponse({
  shop,
  config,
  messages,
  latestUserMessage,
  internal = false,
  accessToken = null,
  loggedInCustomerId = null,
  supportUrl = "",
  supportLabel = "",
  fitfinder = null,
}) {
  const encoder = new TextEncoder();
  // When the shopper leaves (closes the tab, the widget gives up), the turn
  // stops: no more model calls are made or billed.
  const abort = new AbortController();
  const stream = new ReadableStream({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(encoder.encode(sse(obj))); } catch { /* client gone */ }
      };
      // The answer arrives in one piece after the tool calls; until then a
      // comment line every few seconds keeps proxies from dropping a silent
      // connection. SSE clients (the widget) ignore comment lines.
      const ping = () => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* client gone */ } };
      ping();
      const heartbeat = setInterval(ping, 8000);
      try {
        // CS-team cheat code: exact phrase → list every live promotion.
        const cheat = String(config.campaignCheatCode || "").trim().toLowerCase();
        if (cheat && String(latestUserMessage).trim().toLowerCase() === cheat) {
          send({ type: "text", text: formatCampaignsForCS(await getActiveCampaigns(shop), new Date()) });
          send({ type: "products", products: [] });
          send({ type: "done" });
          return;
        }

        // Retries happen once, in withAnthropicRetry — not again inside the SDK.
        const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 40000, maxRetries: 0 });
        const model = config.anthropicModel || "claude-sonnet-4-6";
        const [catalog, extras] = await Promise.all([
          loadLeanCatalog(shop),
          buildLeanStoreExtras({ shop, config, accessToken, loggedInCustomerId, messages, latestUserMessage, fitfinder })
            .catch((err) => {
              console.error("[lean] store extras failed:", err?.message || err);
              return { tools: [], similarAttributes: [], systemBlock: "" };
            }),
        ]);
        // No message text in the logs — shoppers type emails, order numbers, health details.
        console.log(`[lean] turn shop=${shop} internal=${internal} products=${catalog?.products?.length || 0} chars=${String(latestUserMessage).length}`);
        const result = await runLeanTurn({
          shop,
          config: { ...config, supportUrl: supportUrl || config.supportUrl, supportLabel: supportLabel || config.supportLabel },
          model,
          catalog,
          messages,
          latestUserMessage,
          lookupStoreInfo: makeStoreInfoLookup({ shop, config }),
          extraTools: extras.tools,
          extraSystem: extras.systemBlock,
          similarAttributes: extras.similarAttributes,
          callModel: (req) => {
            if (abort.signal.aborted) throw new Error("client disconnected");
            return withAnthropicRetry(() => anthropic.messages.create(req, { signal: abort.signal }));
          },
        });
        send({ type: "text", text: result.text });
        send({ type: "products", products: result.cards });
        for (const ev of result.events || []) send(ev);
        if (result.cards.length > 1) {
          const link = buildShopAllLink(result.shopAllSearch, { pattern: config.storefrontSearchUrlPattern });
          if (link) send({ type: "link", ...link });
        }
        if (result.cards.length === 1) {
          const card = result.cards[0];
          const product = catalog.products.find((p) => p.handle === card.handle);
          const viz = buildVisualizeCtaEvent({
            config,
            product: { ...card, category: product?.category || "", productType: product?.productType || "" },
            messages,
            isInsoleRecommendation: /orthotic|insole/i.test(`${product?.category || ""} ${product?.productType || ""}`),
          });
          if (viz) send(viz);
        }
        if (result.followUps?.length && config.showFollowUps !== false) {
          send({ type: "suggestions", questions: result.followUps });
        }
        if (result.supportRequested) {
          send({
            type: "support_cta",
            label: supportChatLabel({ supportLabel: supportLabel || config.supportLabel }),
            fallbackUrl: supportUrl || config.supportUrl || "",
            context: { reason: result.supportRequested, engine: "lean" },
          });
        }
        send({ type: "done" });
        // Test chats are recorded for the cost estimate only (internal flag).
        recordChatUsage({ shop, model, usage: result.usage, toolCalls: result.toolCalls, internal })
          .catch((err) => console.error("[lean] usage log error:", err?.message));
        if (!internal) {
          logMentions(shop, [
            ...(result.mentions || []),
            ...result.cards.map((c) => ({ handle: c.handle, title: c.title, tool: "show_products" })),
          ]).catch(() => {});
          logTopics(shop, result.topics).catch(() => {});
        }
      } catch (err) {
        if (abort.signal.aborted) {
          console.log(`[lean] turn stopped shop=${shop}: the shopper left`);
          return;
        }
        console.error("[lean] turn failed:", err?.stack || err?.message || err);
        const classified = classifyAnthropicError(err);
        if (classified.kind === "rate_limit" && !internal) incrementRateLimitHits(shop).catch(() => {});
        send({ type: "error", message: customerFacingFailureMessage(classified.kind) });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
