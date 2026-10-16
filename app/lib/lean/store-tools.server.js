// Lean engine — the store's own capabilities, offered to Claude as tools, plus
// per-request context (promotions, logged-in customer, store team rules).
//
// Every tool here reuses the existing, tested executor from chat-tools /
// recommender-tools; this file only decides which ones this store and this
// customer get, and adds no routing of its own — Claude decides when to call.

import { executeTool, TOOLS, CUSTOMER_ORDERS_TOOL, FIT_PREDICTOR_TOOL } from "../chat-tools.server.js";
import { buildRecommenderTools } from "../recommender-tools.server.js";
import { fetchCustomerContext } from "../customer-context.server.js";
import { getActiveCampaigns } from "../../models/Campaign.server.js";
import { getKnowledgeFilesWithContent } from "../../models/ShopConfig.server.js";

const REVIEWS_TOOL = {
  name: "get_product_reviews",
  description:
    "What customers say about one product: rating, review count, fit (runs small / true to size / large) and recent review snippets. Use for questions about fit, comfort, quality or what other buyers think.",
  input_schema: {
    type: "object",
    properties: { handle: { type: "string", description: "Product handle from a search result or shown card." } },
    required: ["handle"],
  },
};

const MAX_RULES_CHARS = 6000;

function parseJson(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return fallback; }
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(d); }
}

// Pure: the per-request system block. Exported for tests.
export function buildStoreContextBlock({ rules = [], campaigns = [], customer = null } = {}) {
  const parts = [];
  const ruleText = rules.map((r) => String(r || "").trim()).filter(Boolean).join("\n\n").slice(0, MAX_RULES_CHARS);
  if (ruleText) parts.push(`INSTRUCTIONS FROM THE STORE TEAM\n${ruleText}`);
  if (campaigns.length) {
    parts.push(
      "ACTIVE PROMOTIONS (live right now — quote only these)\n" +
      campaigns.map((c) => `- ${c.name} (${fmtDate(c.startsAt)} – ${fmtDate(c.endsAt)}): ${String(c.content || "").trim()}`).join("\n"),
    );
  } else {
    parts.push("ACTIVE PROMOTIONS\nNone are running right now.");
  }
  if (customer?.firstName) {
    const lines = [`The customer is logged in. First name: ${customer.firstName} (use it at most once, naturally).`];
    if (customer.numberOfOrders) lines.push(`They've placed ${customer.numberOfOrders} order(s) with us — welcome them back warmly.`);
    parts.push(`CUSTOMER\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function buildLeanStoreExtras({
  shop,
  config = {},
  accessToken = null,
  loggedInCustomerId = null,
  messages = [],
  latestUserMessage = "",
  log = (l) => console.log(l),
}) {
  const vip = Boolean(loggedInCustomerId && accessToken && config.vipModeEnabled === true);
  const fitPredictorConfig = parseJson(config.fitPredictorConfig, {});
  const conversationText = messages.map((m) => (typeof m?.content === "string" ? m.content : "")).join(" ");
  const ctx = {
    shop,
    accessToken,
    loggedInCustomerId,
    vipModeEnabled: config.vipModeEnabled === true,
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    fitPredictorConfig,
    yotpoApiKey: config.yotpoApiKey || "",
    aftershipApiKey: config.aftershipApiKey || "",
    deduplicateColors: config.deduplicateColors,
    similarMatchAttributes: parseJson(config.similarMatchAttributes, []),
    trackingPageUrl: config.trackingPageUrl || "",
    returnsPageUrl: config.returnsPageUrl || "",
    conversationText,
    userText: messages.filter((m) => m?.role === "user").map((m) => String(m.content || "")).join(" "),
    latestUserMessage,
    messages,
  };

  const [rulesRes, campaignsRes, customerRes, recRes] = await Promise.allSettled([
    getKnowledgeFilesWithContent(shop),
    getActiveCampaigns(shop),
    vip ? fetchCustomerContext({ shop, accessToken, customerId: loggedInCustomerId, orderLimit: 5 }) : Promise.resolve(null),
    buildRecommenderTools(shop, { decisionTreeEnabled: config.decisionTreeEnabled === true }),
  ]);
  for (const [label, r] of [["rules", rulesRes], ["campaigns", campaignsRes], ["customer", customerRes], ["recommenders", recRes]]) {
    if (r.status === "rejected") log(`[lean] store extras: ${label} unavailable — ${r.reason?.message || r.reason}`);
  }

  const rules = (rulesRes.value || []).filter((f) => f?.fileType === "rules").map((f) => f.content);
  const campaigns = campaignsRes.value || [];
  const customer = customerRes.value || null;

  const tools = [];
  const wrap = (definition, run) => tools.push({
    definition,
    run: async (input) => {
      try { return (await run(input)) ?? { error: "No result." }; }
      catch (err) { return { error: `Tool failed: ${err?.message || err}` }; }
    },
  });

  if (vip) wrap(CUSTOMER_ORDERS_TOOL, (input) => executeTool("get_customer_orders", input, ctx));

  if (config.fitPredictorEnabled === true) {
    wrap(FIT_PREDICTOR_TOOL, async (input) => {
      const r = await executeTool("get_fit_recommendation", input, ctx);
      if (r && !r.error && r.recommendation?.shouldDisplay) {
        const display = typeof fitPredictorConfig.display === "string" ? fitPredictorConfig.display : "bar";
        return {
          ...r,
          _events: [{
            type: "fit_report",
            handle: r.handle,
            productTitle: r.productTitle,
            recommendedSize: r.recommendation.recommendedSize,
            confidence: r.recommendation.confidence,
            reasons: r.recommendation.reasons || [],
            sizesAvailable: r.recommendation.sizesAvailable || [],
            display,
          }],
        };
      }
      return r;
    });
  }

  // "Something like the Savannah" — only when the store picked what
  // "similar" means (Rules → "Show me something similar").
  const similarDef = TOOLS.find((t) => t.name === "find_similar_products");
  if (similarDef && Array.isArray(ctx.similarMatchAttributes) && ctx.similarMatchAttributes.length > 0) {
    wrap(similarDef, (input) => executeTool("find_similar_products", input, ctx));
  }

  if (ctx.yotpoApiKey) wrap(REVIEWS_TOOL, (input) => executeTool("get_product_reviews", input, ctx));

  const rec = recRes.value || { tools: [], trees: [] };
  ctx.recommenderTrees = rec.trees || [];
  for (const def of rec.tools || []) wrap(def, (input) => executeTool(def.name, input, ctx));

  log(
    `[lean] store extras: tools=[${tools.map((t) => t.definition.name).join(",") || "-"}] ` +
    `rules=${rules.length} promos=${campaigns.length} customer=${customer?.firstName ? "yes" : "no"}`,
  );
  return { tools, systemBlock: buildStoreContextBlock({ rules, campaigns, customer }) };
}
