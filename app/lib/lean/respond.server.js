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
import { resolveSupport } from "../support-handoff.js";
import { buildVisualizeCtaEvent } from "../visualize-cta.server.js";
import { lexicalStoreKnowledge } from "../store-knowledge/sync.server.js";
import { runLeanTurn } from "./engine.js";
import { makeLiveStock } from "./live-stock.server.js";
import { recordHealth } from "../../models/ChatHealth.server.js";
import { chatModel } from "../claude-models.js";
import { buildShopAllLink } from "./shop-all.js";
import { saveRecording } from "../../models/ChatRecording.server.js";
import { describeExtras } from "../chat-recording.js";

// The "View all …" button under a set of product cards (opens the store's
// search for the same thing). Paused for now; flip to true to bring it back.
const SHOW_SHOP_ALL_LINK = false;

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// Store info for Claude: the store team's uploaded notes first (they win if
// anything differs), then what was learned from the store's own website
// (policies, pages, blog articles — store-knowledge sync). Semantic matches
// come first; keyword matches fill in, so exact names ("Premium Memory Foam",
// "clinical study") are found even when the meaning search misses them.
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
        const semantic = await retrieveRelevantChunks(prisma, { shop, query, config, limit: 6 });
        for (const c of semantic || []) {
          if (String(c.fileType || "").startsWith("store_")) website.push(c);
          else if (!uploaded.some((u) => u.content === c.content)) uploaded.push(c);
        }
      } catch (err) {
        console.error("[lean] store-info rag failed:", err?.message || err);
      }
    }
    if (website.length < 3) {
      const lexical = await lexicalStoreKnowledge(shop, query, { limit: 5 }).catch(() => []);
      for (const c of lexical) {
        if (website.length >= 5) break;
        if (!website.some((w) => w.content === c.content)) website.push(c);
      }
    }
    if (uploaded.length === 0 && website.length === 0) return { found: false };
    const parts = [];
    if (uploaded.length) parts.push(`STORE TEAM NOTES (reference from the store team — these win over the website if they differ; products, prices and stock still come from the product tools):\n${uploaded.map(fmt).join("\n\n")}`);
    if (website.length) parts.push(`FROM THE STORE'S WEBSITE:\n${website.map(fmt).join("\n\n")}`);
    return { found: true, text: parts.join("\n\n").slice(0, 9000) };
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
  sizeFinder = null,
  viewingHandle = "",
  record = null,
}) {
  const encoder = new TextEncoder();
  // Test recordings: each turn (and anything shown with it) is saved for
  // review while the store has recording on — never blocks the reply.
  const shown = [];
  const keep = ({ reply, products = [], ok = true }) => {
    if (!record) return;
    saveRecording({ shop, sessionId: record.sessionId, tester: record.tester, page: record.page, message: latestUserMessage, reply, products, extras: describeExtras(shown), ok })
      .catch((err) => console.error("[recordings] save failed:", err?.message || err));
  };
  // When the shopper leaves (closes the tab, the widget gives up), the turn
  // stops: no more model calls are made or billed.
  const abort = new AbortController();
  const stream = new ReadableStream({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      const send = (obj) => {
        if (record && obj && obj.type && obj.type !== "text" && obj.type !== "products" && obj.type !== "done") shown.push(obj);
        try { controller.enqueue(encoder.encode(sse(obj))); } catch { /* client gone */ }
      };
      // The answer arrives in one piece after the tool calls; until then a
      // comment line every few seconds keeps proxies from dropping a silent
      // connection. SSE clients (the widget) ignore comment lines.
      const ping = () => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* client gone */ } };
      ping();
      const heartbeat = setInterval(ping, 8000);
      const turnStarted = Date.now();
      const health = (ok, errorKind = null) => recordHealth({ shop, route: "chat", ok, errorKind, internal, latencyMs: Date.now() - turnStarted });
      try {
        // CS-team cheat code: exact phrase → list every live promotion.
        const cheat = String(config.campaignCheatCode || "").trim().toLowerCase();
        if (cheat && String(latestUserMessage).trim().toLowerCase() === cheat) {
          send({ type: "text", text: formatCampaignsForCS(await getActiveCampaigns(shop), new Date()) });
          send({ type: "products", products: [] });
          send({ type: "done" });
          health(true);
          return;
        }

        // Retries happen once, in withAnthropicRetry — not again inside the SDK.
        const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 40000, maxRetries: 0 });
        const model = chatModel(config.anthropicModel);
        const [catalog, extras] = await Promise.all([
          loadLeanCatalog(shop),
          buildLeanStoreExtras({ shop, config, accessToken, loggedInCustomerId, messages, latestUserMessage, fitfinder, sizeFinder })
            .catch((err) => {
              console.error("[lean] store extras failed:", err?.message || err);
              return { tools: [], similarAttributes: [], systemBlock: "" };
            }),
        ]);
        // No message text in the logs — shoppers type emails, order numbers, health details.
        console.log(`[lean] turn shop=${shop} internal=${internal} products=${catalog?.products?.length || 0} chars=${String(latestUserMessage).length}`);
        const support = resolveSupport({ adminUrl: config.supportUrl, adminLabel: config.supportLabel, themeUrl: supportUrl, themeLabel: supportLabel });
        const result = await runLeanTurn({
          shop,
          config: { ...config, supportUrl: support.url, supportLabel: support.label },
          model,
          catalog,
          messages,
          latestUserMessage,
          lookupStoreInfo: makeStoreInfoLookup({ shop, config }),
          extraTools: extras.tools,
          extraSystem: extras.systemBlock,
          similarAttributes: extras.similarAttributes,
          liveStock: makeLiveStock({ shop, accessToken }),
          viewingHandle,
          callModel: (req) => {
            if (abort.signal.aborted) throw new Error("client disconnected");
            return withAnthropicRetry(() => anthropic.messages.create(req, { signal: abort.signal }));
          },
        });
        send({ type: "text", text: result.text });
        send({ type: "products", products: result.cards });
        for (const ev of result.events || []) send(ev);
        if (SHOW_SHOP_ALL_LINK && result.cards.length > 1) {
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
            label: support.label,
            fallbackUrl: support.url,
            context: { reason: result.supportRequested, engine: "lean" },
          });
        }
        send({ type: "done" });
        keep({ reply: result.text, products: result.cards.map((c) => c.title) });
        health(true);
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
          health(false, "client_left");
          return;
        }
        console.error("[lean] turn failed:", err?.stack || err?.message || err);
        const classified = classifyAnthropicError(err);
        if (classified.kind === "rate_limit" && !internal) incrementRateLimitHits(shop).catch(() => {});
        health(false, classified.kind);
        send({ type: "error", message: customerFacingFailureMessage(classified.kind) });
        keep({ reply: `[failed: ${classified.kind}] ${customerFacingFailureMessage(classified.kind)}`, ok: false });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", Connection: "keep-alive" },
  });
}
