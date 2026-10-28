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
import { chatModel, CHECK_MODEL } from "../claude-models.js";
import { saveRecording } from "../../models/ChatRecording.server.js";
import { describeExtras } from "../chat-recording.js";
import { createLimiter } from "../concurrency.js";
import { seasonalForTurn, seasonalTapNote } from "../seasonal-cta.js";
import { featuredCollection, collectionView } from "./collections.server.js";
import { trueFitIntro, TRUE_FIT_INTRO_TEXT, TRUE_FIT_PICK_NOTE } from "./true-fit-intro.js";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// At most this many AI calls run at once on this server; the rest wait their
// turn (a busy day's burst, not a stream of rate-limit errors).
const aiCalls = createLimiter(Number.parseInt(process.env.AI_MAX_CONCURRENT, 10) || 64);
// A turn ends by this time whatever happens: each AI call gets only the time
// that's left (the engine stops using tools after 45s and answers).
const TURN_HARD_LIMIT_MS = 75_000;
const callTimeout = (endAt) => Math.max(5_000, Math.min(40_000, endAt - Date.now()));

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
  // The shopper tapped the seasonal button (Settings → Seasonal button).
  seasonalTap = false,
  // The shopper tapped "Find my shoe size" without a shoe picked yet.
  sizeIntroTap = false,
  // A style tile from that answer ("Show me women's sneakers").
  sizePickTap = false,
}) {
  const encoder = new TextEncoder();
  // Test recordings: each turn (and anything shown with it) is saved for
  // review while the store has recording on — never blocks the reply.
  const shown = [];
  const keep = ({ reply, products = [], ok = true }) => {
    if (!record) return;
    saveRecording({ shop, sessionId: record.sessionId, tester: record.tester, page: record.page, typed: record.typed, message: latestUserMessage, reply, products, extras: describeExtras(shown), ok })
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

        const model = chatModel(config.anthropicModel);
        // "Find my shoe size" with no shoe picked yet: the same clear answer
        // every time, straight from the catalog — True Fit sizes one shoe at
        // a time, and here are the store's kinds of shoes to start from. No
        // model call; if the catalog can't offer that, the assistant answers.
        if (sizeIntroTap && sizeFinder) {
          const intro = trueFitIntro(await loadLeanCatalog(shop), { primaryLine: "women" });
          if (intro) {
            send({ type: "text", text: TRUE_FIT_INTRO_TEXT });
            send({ type: "products", products: [] });
            send(intro);
            send({ type: "done" });
            keep({ reply: TRUE_FIT_INTRO_TEXT });
            health(true);
            // Counted as a message (analytics, the daily limit), at no cost.
            recordChatUsage({ shop, model, usage: {}, toolCalls: 0, internal })
              .catch((err) => console.error("[lean] usage log error:", err?.message));
            return;
          }
        }

        // Retries happen once, in withAnthropicRetry — not again inside the SDK.
        const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 40000, maxRetries: 0 });
        // The seasonal button's collection, for the reply to the tap only:
        // its products come from Shopify (kept 10 minutes), so that search
        // can keep to them. Every later message is searched as usual — the
        // collection never narrows a follow-up ("any men's styles?").
        const seasonal = seasonalForTurn(config, { tapped: seasonalTap });
        const [baseCatalog, extras, seasonalRead] = await Promise.all([
          loadLeanCatalog(shop),
          buildLeanStoreExtras({ shop, config, accessToken, loggedInCustomerId, messages, latestUserMessage, fitfinder, sizeFinder })
            .catch((err) => {
              console.error("[lean] store extras failed:", err?.message || err);
              return { tools: [], similarAttributes: [], systemBlock: "", pageBlock: "", turnNote: "" };
            }),
          seasonal ? featuredCollection({ shop, accessToken, handle: seasonal.handle }).catch(() => null) : null,
        ]);
        const seasonalView = seasonal ? collectionView(seasonalRead, baseCatalog) : null;
        const catalog = seasonalView ? { ...baseCatalog, collections: new Map([[seasonal.handle, seasonalView]]) } : baseCatalog;
        const featured = seasonalView ? { ...seasonal, title: seasonalView.title || seasonal.title } : null;
        if (seasonalTap) console.log(`[lean] seasonal button tapped shop=${shop} collection=${featured ? `${featured.handle} (${seasonalView.order.size})` : "unavailable"}`);
        // No message text in the logs — shoppers type emails, order numbers, health details.
        console.log(`[lean] turn shop=${shop} internal=${internal} products=${catalog?.products?.length || 0} chars=${String(latestUserMessage).length}`);
        const support = resolveSupport({ adminUrl: config.supportUrl, adminLabel: config.supportLabel, themeUrl: supportUrl, themeLabel: supportLabel });
        // Quick yes/no meaning checks on the cheap model. A failure or a slow
        // answer is "can't tell" (null): the engine then doesn't force a rewrite.
        const checkUsage = {};
        // The 6s limit stops the call itself, so a slow check isn't billed.
        const askYesNo = async (question) => {
          if (abort.signal.aborted) return null;
          const resp = await anthropic.messages
            .create({ model: CHECK_MODEL, max_tokens: 5, messages: [{ role: "user", content: question }] }, { signal: abort.signal, timeout: 6000 })
            .catch(() => null);
          if (!resp) return null;
          for (const k of ["input_tokens", "output_tokens"]) checkUsage[k] = (checkUsage[k] || 0) + (Number(resp.usage?.[k]) || 0);
          const word = (Array.isArray(resp.content) ? resp.content : []).filter((b) => b.type === "text").map((b) => b.text).join("").trim().toUpperCase();
          return word.startsWith("YES") ? true : word.startsWith("NO") ? false : null;
        };
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
          pageSystem: extras.pageBlock,
          turnNote: [extras.turnNote, seasonalTap && featured ? seasonalTapNote(featured) : "", sizePickTap && sizeFinder ? TRUE_FIT_PICK_NOTE : ""].filter(Boolean).join("\n"),
          similarAttributes: extras.similarAttributes,
          featured,
          liveStock: makeLiveStock({ shop, accessToken }),
          viewingHandle,
          askYesNo,
          callModel: (req) => {
            if (abort.signal.aborted) throw new Error("client disconnected");
            const endAt = turnStarted + TURN_HARD_LIMIT_MS;
            return aiCalls.run(
              () => withAnthropicRetry(() => anthropic.messages.create(req, { signal: abort.signal, timeout: callTimeout(endAt) }), { deadlineAt: endAt }),
              { waitMs: Math.min(15_000, Math.max(0, endAt - Date.now() - 20_000)) },
            );
          },
        });
        send({ type: "text", text: result.text });
        send({ type: "products", products: result.cards });
        for (const ev of result.events || []) send(ev);
        // More matches than the cards show: the full list, opened in the chat.
        if (result.viewAll) send({ type: "view_all", ...result.viewAll });
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
        recordChatUsage({ shop, model, usage: result.usage, toolCalls: result.toolCalls, internal, checks: checkUsage.input_tokens ? { model: CHECK_MODEL, usage: checkUsage } : null })
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
