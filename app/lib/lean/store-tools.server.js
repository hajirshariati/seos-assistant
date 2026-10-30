// Lean engine — the store's own capabilities, offered to Claude as tools, plus
// per-request context (promotions, logged-in customer, store team rules).
//
// This file only decides which tools this store and this customer get; it
// adds no routing of its own — Claude decides when to call them.

import { returnPolicy, getCustomerEmail } from "../orders.server.js";
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
import { getPagePromos } from "../promo-page.server.js";
import { promoPageBlock, nowNote } from "../promo-page.js";
import { savedFitNote } from "../orthotic-finder.server.js";
import { getKnowledgeFilesWithContent } from "../../models/ShopConfig.server.js";
import { trueFitTool } from "./size-finder.server.js";
import { ordersTool } from "./orders-tool.server.js";
import { MAX_RULES_CHARS } from "../knowledge-check.js";
import { whichOrthoticConfig, storeLocatorConfig } from "../feedback-survey.js";
import { storeWebsite } from "./prompt.js";

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

export const REWARDS_TOOL = {
  name: "get_my_rewards",
  description:
    "The customer's own rewards account (loyalty points): their points balance, tier, and points history — each entry's date, what it was for (a purchase, a reward redeemed, points taken back after a refund…), its points (negative when spent or taken back), its status (pending points haven't posted yet) and its order. " +
    "Use for any question about their points or rewards: how many they have, missing or pending points, whether points came back after a return or a cancelled order, why a balance changed, expiring points. " +
    "Look into it together with their orders (get_my_orders, intent \"refunds\") and the store's rewards policy (search_store_info), then answer from what the records show.",
  input_schema: { type: "object", properties: {} },
};

// Points in the store's chosen unit, for one history entry or the balance.
function pointsWords(n, config = {}) {
  if (config.loyaltyDisplay !== "dollars") return `${n} points`;
  const ratio = Math.max(1, parseInt(config.loyaltyPointsPerDollar, 10) || 100);
  return `${n} points ($${(n / ratio).toFixed(2)})`;
}

export function rewardsTool({ shop, accessToken, loggedInCustomerId, config = {}, fetchLoyalty = fetchYotpoLoyalty, emailOf = getCustomerEmail }) {
  return {
    definition: REWARDS_TOOL,
    run: async () => {
      if (!loggedInCustomerId) {
        return {
          signed_in: false,
          note: "They aren't signed in, so their points can't be seen here. A card under your reply lets them sign in; once they do, the chat picks their question back up with their points and orders. Say so in one sentence. Don't ask for their email, and don't send them to customer service for this.",
          _events: [{ type: "login_prompt", intent: "rewards" }],
        };
      }
      const email = await emailOf({ shop, accessToken, customerId: loggedInCustomerId }).catch(() => "");
      if (!email) return { signed_in: true, error: "Their rewards account can't be looked up right now." };
      const r = await fetchLoyalty({ apiKey: config.yotpoLoyaltyApiKey, guid: config.yotpoLoyaltyGuid, email, history: true });
      if (r?.unavailable) return { signed_in: true, error: "The rewards system didn't answer just now — you can't see their points this time. Say so plainly; don't guess a balance or what happened to points." };
      if (!r) return { signed_in: true, member: false, note: "No rewards account was found for the email on their store account. Say so plainly; if they joined with another email, that account's points aren't visible here." };
      const history = (r.history || []).map((h) => ({ ...h, points: pointsWords(h.points, config) }));
      return {
        signed_in: true,
        member: true,
        balance: r.pointsBalance != null ? pointsWords(r.pointsBalance, config) : undefined,
        tier: r.tier || undefined,
        store_credit: r.creditBalance > 0 ? `$${r.creditBalance}` : undefined,
        history: history.length ? history : undefined,
        note: history.length
          ? "Their points history is above, newest first. Answer from these entries: name the ones that matter (date, what for, points, status) and connect them to their orders and the store's policy. If an entry they expect isn't there, say plainly that it isn't in their history — don't guess why."
          : r.historyListed
          ? "Their points history has no entries. Answer from the balance, and say plainly there are no points entries yet."
          : "Only their balance is available here, not the history. Answer from the balance and say plainly you can't see the individual entries.",
      };
    },
  };
}

// Pure: the per-request system block. Exported for tests.
export function buildStoreContextBlock({ rules = [], campaigns = [], customer = null, loyaltyText = "", pagePromos = "", promoPageUrl = "" } = {}) {
  const parts = [];
  const ruleText = rules.map((r) => String(r || "").trim()).filter(Boolean).join("\n\n").slice(0, MAX_RULES_CHARS);
  if (ruleText) parts.push(`INSTRUCTIONS FROM THE STORE TEAM (apply them to what the customer means in this conversation)\n${ruleText}`);
  if (campaigns.length) {
    parts.push(
      "ACTIVE PROMOTIONS (live right now — quote only these)\n" +
      campaigns.map((c) => `- ${c.name} (${fmtDate(c.startsAt)} – ${fmtDate(c.endsAt)}): ${String(c.content || "").trim()}`).join("\n"),
    );
  } else if (!String(pagePromos || "").trim()) {
    // Codes and store-wide offers only — marked-down products are found with
    // the product search (on_sale), so "none" here never means "nothing on sale".
    parts.push("ACTIVE PROMOTIONS\nNo discount codes or store-wide offers right now. Marked-down products may still be on sale — find them with the product search (on_sale: true).");
  }
  // The store's promotions page, read live (Settings → Promotions page).
  const pageBlock = promoPageBlock({ text: pagePromos, url: promoPageUrl });
  if (pageBlock) parts.push(`${pageBlock}\nWhen the customer asks about sales, promotions or deals, list the running offers above first, then marked-down products (product search, on_sale: true).`);
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
    guestOrderLookup: config.guestOrderLookup !== false,
    returnPolicy: returnPolicy(config),
  };

  const [rulesRes, campaignsRes, customerRes, recRes, pagePromosRes] = await Promise.allSettled([
    getKnowledgeFilesWithContent(shop),
    getActiveCampaigns(shop),
    vip ? fetchCustomerContext({ shop, accessToken, customerId: loggedInCustomerId, orderLimit: 5 }) : Promise.resolve(null),
    buildRecommenderTools(shop, { decisionTreeEnabled: config.decisionTreeEnabled === true, fitfinder, shopperText: `${conversationText} ${latestUserMessage || ""}` }),
    getPagePromos({ shop, accessToken, url: config.promoPageUrl, stopLine: config.promoPageStop }),
  ]);
  for (const [label, r] of [["rules", rulesRes], ["campaigns", campaignsRes], ["customer", customerRes], ["recommenders", recRes], ["promotions page", pagePromosRes]]) {
    if (r.status === "rejected") log(`[lean] store extras: ${label} unavailable — ${r.reason?.message || r.reason}`);
  }

  const rules = (rulesRes.value || []).filter((f) => f?.fileType === "rules").map((f) => f.content);
  const campaigns = campaignsRes.value || [];
  const pagePromos = pagePromosRes.value || "";
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
  // signed out → sign in, or look one order up with its number and email
  // (no VIP mode needed — it's their own data).
  const orders = ordersTool({ shop, accessToken, loggedInCustomerId, trackingPageUrl: ctx.trackingPageUrl, returnsPageUrl: ctx.returnsPageUrl, returnsInChat: ctx.returnsInChat, guestLookup: ctx.guestOrderLookup, policy: ctx.returnPolicy });
  wrap(orders.definition, orders.run);

  // Their rewards account (Yotpo Loyalty): balance, tier and points history,
  // for the signed-in shopper — so a points question is looked into, not
  // passed to customer service.
  if (config.yotpoLoyaltyApiKey) {
    const rewards = rewardsTool({ shop, accessToken, loggedInCustomerId, config });
    wrap(rewards.definition, rewards.run);
  }

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

  // "Which orthotic do I have?" — the store's visual quiz (Typeform), opened
  // in the chat from a button under the reply.
  const which = whichOrthoticConfig(config);
  if (which) {
    wrap({
      name: "show_which_orthotic_quiz",
      description:
        "Show a button that opens a short visual quiz (pictures of the top, color and logo) that tells the customer which Aetrex orthotic they already own. " +
        "Use when the customer wants to reorder or replace an orthotic they have but doesn't know its name or model, or asks which orthotic they have. " +
        "If they're signed in, check their past orders first (get_my_orders) and name the orthotic if it's there; offer the quiz when it isn't, or if they're unsure it's the same pair. " +
        "If they can name it, don't use this — find that orthotic instead. Not for choosing a new orthotic (use the orthotic recommender for that). " +
        "Not for a customer who has their own orthotics (custom, from a doctor, or another brand) and wants shoes to wear them in — show shoes with a removable footbed instead.",
      input_schema: { type: "object", properties: {} },
    }, async () => ({
      ok: true,
      note: `A "${which.label}" button appears under your reply and opens the quiz in the chat. Say in one short sentence what it does; don't add a link.`,
      _events: [{ type: "form_cta", form: which.form, label: which.label }],
    }));
  }

  // The store locator (Storepoint), opened in the chat from a button. Its
  // stores either sell the store's products, or (Settings) have its foot
  // scanner — then the map is for scans and fittings, never for buying.
  const locator = storeLocatorConfig(config);
  if (locator && locator.stores === "scanner") {
    const site = storeWebsite(config);
    const online = site ? `online at ${site}` : "online";
    wrap({
      name: "show_store_locator",
      description:
        "Show a button that opens the store locator map right inside the chat. Its locations have the store's foot scanner — for getting feet scanned or fitted — and some also carry orthotics; not every one sells the store's shoes. " +
        "Use it when the customer asks where to get their feet scanned or fitted, about the scanner, or about trying orthotics in person, or asks for the store locator — or when they still want a store after you've offered help online. " +
        "Not the first answer to trying on or buying a style in person — most locations don't carry the shoes: first help them buy with confidence right here (the right-size help you have — True Fit for a shoe, the orthotic finder or their FIT for orthotics — the store's returns as its info says them, the style itself), and don't mention the map or the scanner locations in that reply. Never promise a product is in stock at a location.",
      input_schema: { type: "object", properties: {} },
    }, async () => ({
      ok: true,
      note: `A "${locator.label}" button appears under your reply and opens the store map in the chat. In your reply, warmly and honestly, in short paragraphs: the map shows the brand's scanner locations near them (name the ZIP code or city they gave) — and they can always check their local shoe stores for the shoes; a quick heads-up that those locations offer the foot scanning and some carry the orthotics, but most may not carry the shoes, so it's worth calling ahead; then, in the meantime, one short, warm offer — their size in the style they named, or its other colors (the full range is all in one place ${online}). Don't add the store locator link, never say a location has a product in stock, and never name or guess which stores carry the brand.`,
      _events: [{ type: "map_cta", mapId: locator.mapId, label: locator.label, url: locator.url }],
    }));
  } else if (locator) {
    const site = storeWebsite(config);
    wrap({
      name: "show_store_locator",
      description:
        "Show a button that opens the store locator map (stores and retailers, searchable by location) right inside the chat. " +
        "Use it when the customer asks about stores, retailers or dealers, buying or trying on in person, getting fitted or having their feet scanned, or for the store locator. " +
        "Always pair it with the online option: each store picks its own selection, so not every style, color, size or width is there — the full range is online, and they can order right here in the chat; show a few products for what they're shopping for. " +
        "Not the answer to \"where can I buy these?\" when they haven't asked about a store: they can buy right here, online — show the product with its Add to cart. Never promise a product is in stock at a location.",
      input_schema: { type: "object", properties: {} },
    }, async () => ({
      ok: true,
      note: `A "${locator.label}" button appears under your reply and opens the store map in the chat. In your reply, warmly: a short sentence that they can find a store near them there; then that each store picks its own selection, so for every style, color, size and width the full range is ${site ? `online at ${site}` : "online"} — and they can order right here in the chat. Then show a few products for what they're shopping for (search, then show_products), or ask what with tap choices. Don't add the store locator link, and never say a store has a product in stock.`,
      _events: [{ type: "map_cta", mapId: locator.mapId, label: locator.label, url: locator.url }],
    }));
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

  // The orthotic finder's tool reads the same for every shopper; their saved
  // FIT (if any) is told alongside.
  const fitNote = (rec.tools || []).some((d) => d?.input_schema?.properties?.fit) ? savedFitNote(fitfinder) : "";

  log(
    `[lean] store extras: tools=[${tools.map((t) => t.definition.name).join(",") || "-"}] ` +
    `rules=${rules.length} promos=${campaigns.length} pagePromos=${pagePromos ? pagePromos.length : 0} customer=${customer?.firstName ? "yes" : "no"}`,
  );
  return {
    tools,
    similarAttributes: Array.isArray(similarAttributes) ? similarAttributes.map(String).filter(Boolean) : [],
    systemBlock: buildStoreContextBlock({ rules, campaigns, customer, loyaltyText, pagePromos, promoPageUrl: config.promoPageUrl || "" }),
    // This shopper and page (after the cached prompt), and the current time
    // with their latest message, so offers' end dates can be checked.
    pageBlock: [trueFit?.pageNote, fitNote].filter(Boolean).join("\n\n"),
    turnNote: campaigns.length || pagePromos ? nowNote() : "",
  };
}
