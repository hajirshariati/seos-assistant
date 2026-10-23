// Lean engine — the store's own capabilities, offered to Claude as tools, plus
// per-request context (promotions, logged-in customer, store team rules).
//
// This file only decides which tools this store and this customer get; it
// adds no routing of its own — Claude decides when to call them.

import { returnPolicy } from "../orders.server.js";
import {
  FIT_PREDICTOR_TOOL,
  REVIEWS_TOOL,
  getFitRecommendation,
  getProductReviews,
} from "./store-actions.server.js";
import { buildRecommenderTools, executeRecommenderTool } from "../recommender-tools.server.js";
import { fetchCustomerContext } from "../customer-context.server.js";
import { fetchYotpoLoyalty } from "../yotpo-loyalty.server.js";
import { getActiveCampaigns } from "../../models/Campaign.server.js";
import { getKnowledgeFilesWithContent } from "../../models/ShopConfig.server.js";
import { trueFitTool } from "./size-finder.server.js";
import { ordersTool } from "./orders-tool.server.js";
import { MAX_RULES_CHARS } from "../knowledge-check.js";

function parseJson(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return fallback; }
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(d); }
}

// Loyalty balance in the store's chosen unit (points or reward dollars).
export function formatLoyalty(loyalty, config = {}) {
  if (!loyalty) return "";
  const dollars = config.loyaltyDisplay === "dollars";
  const ratio = Math.max(1, parseInt(config.loyaltyPointsPerDollar, 10) || 100);
  const balance = (points) => {
    if (!dollars) return `${points} points`;
    const v = points / ratio;
    if (config.loyaltyRounding === "up") return `$${Math.ceil(v)} in rewards`;
    if (config.loyaltyRounding === "down") return `$${Math.floor(v)} in rewards`;
    return `$${v.toFixed(2)} in rewards`;
  };
  const bits = [];
  if (loyalty.pointsBalance != null) bits.push(balance(loyalty.pointsBalance));
  if (loyalty.tier) bits.push(`tier: ${loyalty.tier}`);
  if (loyalty.creditBalance > 0) bits.push(`$${loyalty.creditBalance} store credit`);
  const lines = [];
  if (bits.length) lines.push(`Loyalty: ${bits.join(", ")}.`);
  if (loyalty.availableRewards?.length) {
    lines.push(`Rewards they can redeem: ${loyalty.availableRewards.map((r) => `${r.name} (${r.cost})`).join(", ")}.`);
  }
  if (loyalty.referralUrl) lines.push(`Their personal referral link: ${loyalty.referralUrl}`);
  if (config.referralPageUrl) lines.push(`Referral program page: ${config.referralPageUrl}`);
  return lines.join("\n");
}

// Pure: the per-request system block. Exported for tests.
export function buildStoreContextBlock({ rules = [], campaigns = [], customer = null, loyaltyText = "" } = {}) {
  const parts = [];
  const ruleText = rules.map((r) => String(r || "").trim()).filter(Boolean).join("\n\n").slice(0, MAX_RULES_CHARS);
  if (ruleText) parts.push(`INSTRUCTIONS FROM THE STORE TEAM (apply them to what the customer means in this conversation)\n${ruleText}`);
  if (campaigns.length) {
    parts.push(
      "ACTIVE PROMOTIONS (live right now — quote only these)\n" +
      campaigns.map((c) => `- ${c.name} (${fmtDate(c.startsAt)} – ${fmtDate(c.endsAt)}): ${String(c.content || "").trim()}`).join("\n"),
    );
  } else {
    // Codes and store-wide offers only — marked-down products are found with
    // the product search (on_sale), so "none" here never means "nothing on sale".
    parts.push("ACTIVE PROMOTIONS\nNo discount codes or store-wide offers right now. Marked-down products may still be on sale — find them with the product search (on_sale: true).");
  }
  if (customer?.firstName) {
    const lines = [`The customer is logged in. First name: ${customer.firstName} (use it at most once, naturally).`];
    if (customer.numberOfOrders) lines.push(`They've placed ${customer.numberOfOrders} order(s) with us — welcome them back warmly.`);
    if (loyaltyText) lines.push(loyaltyText);
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
  fitfinder = null, // the shopper's FITFinder data, from the widget (sanitized)
  sizeFinder = null, // True Fit on this store's shoe pages, from the widget (sanitized)
  sizeLookup, // tests: product lookup for the True Fit tool
  log = (l) => console.log(l),
}) {
  const vip = Boolean(loggedInCustomerId && accessToken && config.vipModeEnabled === true);
  const fitPredictorConfig = parseJson(config.fitPredictorConfig, {});
  // What the shopper said — never the assistant's own questions, whose
  // options ("Ball-of-foot pain?") would read as the shopper's answers.
  const conversationText = messages
    .filter((m) => m?.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
  const similarAttributes = parseJson(config.similarMatchAttributes, []);
  const ctx = {
    shop,
    accessToken,
    loggedInCustomerId,
    vipModeEnabled: config.vipModeEnabled === true,
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    fitPredictorConfig,
    yotpoApiKey: config.yotpoApiKey || "",
    aftershipApiKey: config.aftershipApiKey || "",
    trackingPageUrl: config.trackingPageUrl || "",
    returnsPageUrl: config.returnsPageUrl || "",
    returnsInChat: config.returnsInChat !== false,
    returnPolicy: returnPolicy(config),
  };

  const [rulesRes, campaignsRes, customerRes, recRes] = await Promise.allSettled([
    getKnowledgeFilesWithContent(shop),
    getActiveCampaigns(shop),
    vip ? fetchCustomerContext({ shop, accessToken, customerId: loggedInCustomerId, orderLimit: 5 }) : Promise.resolve(null),
    buildRecommenderTools(shop, { decisionTreeEnabled: config.decisionTreeEnabled === true, fitfinder, shopperText: `${conversationText} ${latestUserMessage || ""}` }),
  ]);
  for (const [label, r] of [["rules", rulesRes], ["campaigns", campaignsRes], ["customer", customerRes], ["recommenders", recRes]]) {
    if (r.status === "rejected") log(`[lean] store extras: ${label} unavailable — ${r.reason?.message || r.reason}`);
  }

  const rules = (rulesRes.value || []).filter((f) => f?.fileType === "rules").map((f) => f.content);
  const campaigns = campaignsRes.value || [];
  const customer = customerRes.value || null;
  let loyaltyText = "";
  if (customer?._email && config.yotpoLoyaltyApiKey) {
    const loyalty = await fetchYotpoLoyalty({ apiKey: config.yotpoLoyaltyApiKey, guid: config.yotpoLoyaltyGuid, email: customer._email })
      .catch((err) => { log(`[lean] loyalty unavailable — ${err?.message || err}`); return null; });
    loyaltyText = formatLoyalty(loyalty, config);
  }

  const tools = [];
  const wrap = (definition, run) => tools.push({
    definition,
    run: async (input) => {
      try { return (await run(input)) ?? { error: "No result." }; }
      catch (err) { return { error: `Tool failed: ${err?.message || err}` }; }
    },
  });

  // Orders and returns for every shopper: signed in → their order cards;
  // signed out → a sign-in button (no VIP mode needed — it's their own data).
  const orders = ordersTool({ shop, accessToken, loggedInCustomerId, trackingPageUrl: ctx.trackingPageUrl, returnsPageUrl: ctx.returnsPageUrl, returnsInChat: ctx.returnsInChat, policy: ctx.returnPolicy });
  wrap(orders.definition, orders.run);

  if (config.fitPredictorEnabled === true) {
    wrap(FIT_PREDICTOR_TOOL, async (input) => {
      const r = await getFitRecommendation(input || {}, ctx);
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

  // Newsletter signup form in the chat (Klaviyo), when the store set it up.
  if (config.klaviyoCompanyId && config.klaviyoListId) {
    wrap({
      name: "show_newsletter_signup",
      description: "Show the store's newsletter signup form in the chat. Use when the customer wants deals, discount codes for signing up, restock or launch news.",
      input_schema: { type: "object", properties: {} },
    }, async () => ({ ok: true, note: "The signup form appears under your reply.", _events: [{ type: "klaviyo_form" }] }));
  }

  const trueFit = trueFitTool({ shop, sizeFinder, ...(sizeLookup ? { lookup: sizeLookup } : {}) });
  if (trueFit) wrap(trueFit.definition, trueFit.run);

  if (ctx.yotpoApiKey) wrap(REVIEWS_TOOL, (input) => getProductReviews(input || {}, ctx));

  const rec = recRes.value || { tools: [], trees: [] };
  for (const def of rec.tools || []) {
    wrap(def, (input) => executeRecommenderTool({
      toolName: def.name,
      input: input || {},
      shop,
      trees: rec.trees || [],
      conversationText: `${conversationText} ${latestUserMessage || ""}`,
      latestUserText: latestUserMessage,
      fitfinder,
    }));
  }

  log(
    `[lean] store extras: tools=[${tools.map((t) => t.definition.name).join(",") || "-"}] ` +
    `rules=${rules.length} promos=${campaigns.length} customer=${customer?.firstName ? "yes" : "no"}`,
  );
  return {
    tools,
    similarAttributes: Array.isArray(similarAttributes) ? similarAttributes.map(String).filter(Boolean) : [],
    systemBlock: buildStoreContextBlock({ rules, campaigns, customer, loyaltyText }),
  };
}
