// Deals — what the card shows (see deals.js): the running offers from the
// promotions page and dated campaigns, and the products on sale. The page's
// text is structured by a small model once per change of the text (cached by
// its hash) and checked against the text; the whole answer is kept a few
// minutes per store so a busy day costs one read, not one per shopper.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { CHECK_MODEL } from "./claude-models.js";
import { getPagePromos } from "./promo-page.server.js";
import { promoLines } from "./memory.js";
import { getActiveCampaigns } from "../models/Campaign.server.js";
import { loadLeanCatalog } from "./lean/catalog.server.js";
import { toCard } from "./lean/engine.js";
import { dealsConfig, saleProducts, offerFromCampaign, offersFromLines, validateOffers, structurePrompt, parseStructured, MAX_OFFERS } from "./deals.js";

const ANSWER_MS = 5 * 60 * 1000;
const answers = new Map(); // shop → { at, value }
const structured = new Map(); // text hash → offers (validated)
const STRUCTURED_MAX = 200;

const hashOf = (s) => createHash("sha1").update(String(s)).digest("hex");

// The page's text → offers: the model once per text, then from cache. No
// key, or the model fails: the page's lines as they are.
export async function structureOffers({ text, apiKey, client = null, log = console.warn }) {
  const lines = promoLines(text);
  if (!lines.length) return [];
  const key = hashOf(lines.join("\n"));
  if (structured.has(key)) return structured.get(key);
  let offers = [];
  if (apiKey || client) {
    try {
      const ai = client || new Anthropic({ apiKey, timeout: 12000, maxRetries: 0 });
      const resp = await ai.messages.create({ model: CHECK_MODEL, max_tokens: 700, messages: [{ role: "user", content: structurePrompt(lines.join("\n")) }] }, { timeout: 12000 });
      const answer = (resp?.content || []).map((c) => (c?.type === "text" ? c.text : "")).join("");
      offers = validateOffers(parseStructured(answer), lines.join("\n"));
    } catch (err) {
      log(`[deals] structuring failed — ${err?.message || err}`);
      offers = [];
    }
  }
  if (!offers.length) offers = offersFromLines(lines);
  if (structured.size >= STRUCTURED_MAX) structured.delete(structured.keys().next().value);
  structured.set(key, offers);
  return offers;
}

export async function getDeals({ shop, accessToken, config = {}, now = Date.now(), client = null }) {
  const conf = dealsConfig(config);
  if (!conf) return null;
  const hit = answers.get(shop);
  if (hit && now - hit.at < ANSWER_MS) return hit.value;
  const [pageRes, campaignsRes, catalogRes] = await Promise.allSettled([
    config.promoPageUrl && config.promoPageStop ? getPagePromos({ shop, accessToken, url: config.promoPageUrl, stopLine: config.promoPageStop }) : Promise.resolve(""),
    getActiveCampaigns(shop, new Date(now)),
    loadLeanCatalog(shop),
  ]);
  const pageText = pageRes.status === "fulfilled" ? pageRes.value || "" : "";
  const campaigns = campaignsRes.status === "fulfilled" ? campaignsRes.value || [] : [];
  const catalog = catalogRes.status === "fulfilled" ? catalogRes.value : null;
  const fromCampaigns = campaigns.map(offerFromCampaign).filter((o) => o.title);
  const fromPage = pageText ? await structureOffers({ text: pageText, apiKey: config.anthropicApiKey, client }) : [];
  const seen = new Set();
  const offers = [...fromCampaigns, ...fromPage].filter((o) => { const k = o.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_OFFERS);
  const products = catalog ? saleProducts(catalog).map((p) => toCard(p)) : [];
  const value = { offers, products, url: conf.url, label: conf.label, asOf: new Date(now).toISOString() };
  answers.set(shop, { at: now, value });
  return value;
}

export const clearDealsCache = () => { answers.clear(); structured.clear(); };
