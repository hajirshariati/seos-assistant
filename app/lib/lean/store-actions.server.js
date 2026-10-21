// Store actions the assistant can take beyond the catalog: the logged-in
// customer's orders, size advice (fit predictor), Yotpo reviews and
// AfterShip return insights. Offered to Claude as tools by store-tools.server.js.

import { safeExternalUrl } from "../external-url.js";
import prisma from "../../db.server.js";
import { fetchCustomerContext } from "../customer-context.server.js";
import {
  inStockSizes,
  inStockWidths,
  isSizeAvailable,
  normalizeVariantWidth,
} from "../variant-matcher.server.js";

const HIDDEN_PRODUCT_STATUSES = ["DRAFT", "draft", "ARCHIVED", "archived"];

function activeProductWhere(shop, extra = {}) {
  return { ...extra, shop, NOT: { status: { in: HIDDEN_PRODUCT_STATUSES } } };
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

export const FIT_PREDICTOR_TOOL = {
  name: "get_fit_recommendation",
  description:
    "Recommend a specific size with a confidence score for a single product, aggregating review fit signals, return sizing data, customer order history, and any merchant-configured external fit API. Use this INSTEAD of get_product_reviews + get_return_insights whenever the customer asks 'what size should I get', 'do these run small', 'should I size up/down', 'fit for [product]', or anything where the answer is a specific size. Returns a structured report that the widget renders as a visual fit-confidence card.",
  input_schema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "The product handle to recommend a size for.",
      },
      customerSizeHint: {
        type: "string",
        description: "Optional. If the customer mentioned their usual size (e.g. '9', '8.5', 'W9', 'M10.5'), pass it so the predictor can anchor the recommendation.",
      },
    },
    required: ["handle"],
  },
};

function numericShopifyId(gid) {
  if (!gid) return null;
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : null;
}

const FIT_PATTERNS = [
  { key: "runs_small", regex: /\b(runs? small|too small|tight|size up|order.{0,6}size up|half size up|one size up)\b/i },
  { key: "runs_large", regex: /\b(runs? (?:big|large)|too (?:big|large)|loose|size down|order.{0,6}size down|half size down|one size down)\b/i },
  { key: "true_to_size", regex: /\b(true to size|fits (?:well|perfectly|great)|perfect fit|right size|accurate sizing)\b/i },
  { key: "narrow", regex: /\b(too narrow|narrow fit|feels? narrow)\b/i },
  { key: "wide", regex: /\b(too wide|wide fit|feels? wide|roomy)\b/i },
];

function classifyFit(text) {
  const hits = [];
  for (const { key, regex } of FIT_PATTERNS) {
    if (regex.test(text)) hits.push(key);
  }
  return hits;
}

async function getProductReviews({ handle }, { shop, yotpoApiKey }) {
  if (!yotpoApiKey) {
    return { error: "Yotpo reviews are not configured for this store." };
  }
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const product = await prisma.product.findFirst({
    where: activeProductWhere(shop, { handle: h }),
    select: { shopifyId: true, title: true },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const productId = numericShopifyId(product.shopifyId);
  if (!productId) return { error: "Could not resolve Shopify product id." };

  const url = `https://api.yotpo.com/v1/widget/${encodeURIComponent(yotpoApiKey)}/products/${encodeURIComponent(productId)}/reviews.json?per_page=30&page=1&sort=date&direction=desc`;
  let data;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `Yotpo request failed (${res.status}).` };
    data = await res.json();
  } catch (err) {
    return { error: `Yotpo fetch error: ${err?.message || "unknown"}` };
  }

  const reviews = data?.response?.reviews || [];
  const bottomline = data?.response?.bottomline || {};

  const fitCounts = { runs_small: 0, runs_large: 0, true_to_size: 0, narrow: 0, wide: 0 };
  const snippets = [];
  // Pick the strongest 4-5 star quote (highest rating, longest body)
  // to highlight in chat — "Diana said this fits true to size and is
  // her go-to walking shoe" reads like a real associate. Reviewer
  // name comes from Yotpo's display field (typically first name +
  // last initial); we never use it without a positive rating.
  let topPositive = null;
  for (const r of reviews) {
    const content = `${r.title || ""} ${r.content || ""}`.trim();
    const hits = classifyFit(content);
    for (const k of hits) fitCounts[k] = (fitCounts[k] || 0) + 1;
    if (snippets.length < 8 && content.length > 20) {
      const name = String(r?.user?.display_name || r?.user?.name || r?.name || "").trim();
      snippets.push({
        rating: r.score,
        name: name || null,
        text: truncate(content.replace(/\s+/g, " "), 220),
      });
    }
    if ((r.score >= 4) && content.length >= 40 && content.length <= 220) {
      const cand = {
        rating: r.score,
        name: String(r?.user?.display_name || r?.user?.name || r?.name || "").trim() || null,
        text: content.replace(/\s+/g, " "),
      };
      if (!topPositive
        || cand.rating > topPositive.rating
        || (cand.rating === topPositive.rating && cand.text.length > topPositive.text.length)) {
        topPositive = cand;
      }
    }
  }

  let fitSummary = "Not enough reviews mention fit.";
  const totalFit = fitCounts.runs_small + fitCounts.runs_large + fitCounts.true_to_size;
  if (totalFit >= 3) {
    if (fitCounts.true_to_size >= fitCounts.runs_small && fitCounts.true_to_size >= fitCounts.runs_large) {
      fitSummary = `Most reviewers say it fits true to size (${fitCounts.true_to_size} of ${totalFit} fit mentions).`;
    } else if (fitCounts.runs_small > fitCounts.runs_large && fitCounts.runs_small > fitCounts.true_to_size) {
      fitSummary = `Tends to run small — reviewers suggest sizing up (${fitCounts.runs_small} of ${totalFit} fit mentions).`;
    } else if (fitCounts.runs_large > fitCounts.runs_small && fitCounts.runs_large > fitCounts.true_to_size) {
      fitSummary = `Tends to run large — reviewers suggest sizing down (${fitCounts.runs_large} of ${totalFit} fit mentions).`;
    } else {
      fitSummary = `Fit reviews are mixed — consider trying your usual size (${totalFit} fit mentions).`;
    }
  }

  return {
    handle: h,
    title: product.title,
    totalReviews: bottomline.total_review ?? reviews.length,
    averageScore: bottomline.average_score ?? undefined,
    fitSummary,
    fitCounts,
    sampleReviews: snippets,
    topPositiveReview: topPositive
      ? { rating: topPositive.rating, name: topPositive.name, text: topPositive.text }
      : null,
  };
}

async function getReturnInsights({ handle }, { shop, aftershipApiKey }) {
  if (!aftershipApiKey) {
    return { error: "Aftership returns are not configured for this store." };
  }
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const product = await prisma.product.findFirst({
    where: activeProductWhere(shop, { handle: h }),
    select: { title: true },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const url = `https://api.aftership.com/returns-center/v1/returns?search=${encodeURIComponent(product.title)}&limit=50`;
  let data;
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "aftership-api-key": aftershipApiKey,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `Aftership request failed (${res.status}).` };
    data = await res.json();
  } catch (err) {
    return { error: `Aftership fetch error: ${err?.message || "unknown"}` };
  }

  const returns = data?.data?.returns || data?.returns || [];
  if (!Array.isArray(returns) || returns.length === 0) {
    return {
      handle: h,
      title: product.title,
      totalReturns: 0,
      note: "No return data available for this product.",
    };
  }

  const reasonCounts = {};
  const sizingReasons = { too_small: 0, too_big: 0, other_fit: 0 };
  for (const r of returns) {
    const items = r?.items || r?.return_items || [];
    const matches = items.filter((it) => {
      const name = (it?.product_name || it?.name || "").toLowerCase();
      return name && name.includes(product.title.toLowerCase().slice(0, 20));
    });
    if (matches.length === 0 && items.length > 0) continue;
    for (const it of (matches.length ? matches : items)) {
      const reason = String(it?.return_reason || it?.reason || r?.reason || "unspecified").toLowerCase();
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      if (/too small|size up|smaller/i.test(reason)) sizingReasons.too_small++;
      else if (/too (?:big|large)|size down|larger/i.test(reason)) sizingReasons.too_big++;
      else if (/fit|size/i.test(reason)) sizingReasons.other_fit++;
    }
  }

  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  let sizingAdvice = null;
  const totalSizing = sizingReasons.too_small + sizingReasons.too_big;
  if (totalSizing >= 2) {
    if (sizingReasons.too_small > sizingReasons.too_big * 1.5) {
      sizingAdvice = "Returns skew toward 'too small' — recommend sizing up.";
    } else if (sizingReasons.too_big > sizingReasons.too_small * 1.5) {
      sizingAdvice = "Returns skew toward 'too big' — recommend sizing down.";
    } else {
      sizingAdvice = "Return data is mixed on sizing — likely true to size.";
    }
  }

  return {
    handle: h,
    title: product.title,
    totalReturns: returns.length,
    sizingReasons,
    topReasons,
    sizingAdvice,
  };
}

// Merchant-gated tool. Only added to the tools list when the shop has
// fitPredictorEnabled=true. Aggregates review fit data, return sizing reasons,
// customer order history, and an optional merchant-configured external fit
// API into a single size recommendation with a confidence score.

function roundToHalf(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 2) / 2;
}

function parseSize(raw) {
  if (raw == null) return null;
  const str = String(raw);
  // Prefer explicit "Size: 9.5" or "size 9" phrasings if present.
  const labeled = str.match(/\bsize[^0-9]{0,6}(\d+(?:\.\d+)?)/i);
  if (labeled) {
    const n = parseFloat(labeled[1]);
    if (Number.isFinite(n) && n >= 3 && n <= 18) return n;
  }
  // Otherwise scan all numbers and pick the first one that falls in the
  // plausible US shoe-size range (3–18). Keeps SKUs like "L1305" from
  // being read as size 1305.
  const matches = str.match(/\d+(?:\.\d+)?/g) || [];
  for (const m of matches) {
    const n = parseFloat(m);
    if (Number.isFinite(n) && n >= 3 && n <= 18) return n;
  }
  return null;
}

function formatSize(n) {
  if (n == null) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

async function getFitRecommendation({ handle, customerSizeHint }, ctx) {
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const cfg = (ctx && typeof ctx.fitPredictorConfig === "object" && ctx.fitPredictorConfig) || {};
  const weights = {
    reviews: Number.isFinite(cfg.reviewsWeight) ? cfg.reviewsWeight : 0.4,
    returns: Number.isFinite(cfg.returnsWeight) ? cfg.returnsWeight : 0.2,
    history: Number.isFinite(cfg.historyWeight) ? cfg.historyWeight : 0.3,
    external: Number.isFinite(cfg.externalWeight) ? cfg.externalWeight : 0.1,
  };
  const minConfidence = Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : 50;
  // Re-checked here too: settings saved before the check existed.
  const externalUrl = safeExternalUrl(cfg.externalUrl) || "";
  const externalAuthHeader = typeof cfg.externalAuthHeader === "string" ? cfg.externalAuthHeader.trim() : "";

  const product = await prisma.product.findFirst({
    where: activeProductWhere(ctx.shop, { handle: h }),
    include: {
      variants: {
        select: {
          sku: true,
          title: true,
          price: true,
          optionsJson: true,
          attributesJson: true,
          inventoryQty: true,
        },
      },
    },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const requestedWidth = normalizeVariantWidth(customerSizeHint);
  const sizesAvailable = inStockSizes(product, { width: requestedWidth });
  const widthsAvailable = inStockWidths(product);

  // Parallel-fetch every signal. Every call is guarded so a failure in one
  // source never takes down the recommendation.
  const [reviewRes, returnRes] = await Promise.all([
    ctx.yotpoApiKey
      ? getProductReviews({ handle: h }, { shop: ctx.shop, yotpoApiKey: ctx.yotpoApiKey }).catch(() => null)
      : Promise.resolve(null),
    ctx.aftershipApiKey
      ? getReturnInsights({ handle: h }, { shop: ctx.shop, aftershipApiKey: ctx.aftershipApiKey }).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Optional external fit API.
  let externalRes = null;
  if (externalUrl) {
    try {
      const body = {
        shop: ctx.shop,
        productHandle: h,
        customerId: ctx.loggedInCustomerId || null,
      };
      const headers = { "Content-Type": "application/json", accept: "application/json" };
      if (externalAuthHeader) {
        const idx = externalAuthHeader.indexOf(":");
        if (idx > 0) {
          headers[externalAuthHeader.slice(0, idx).trim()] = externalAuthHeader.slice(idx + 1).trim();
        }
      }
      const r = await fetch(externalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) externalRes = await r.json();
    } catch {
      externalRes = null;
    }
  }

  // Customer history: if VIP + logged in, look at recent orders for sizes
  // worn in the same category. Never expose PII.
  let historyRes = null;
  if (ctx.loggedInCustomerId && ctx.vipModeEnabled && ctx.accessToken) {
    try {
      const ctxData = await fetchCustomerContext({
        shop: ctx.shop,
        accessToken: ctx.accessToken,
        customerId: ctx.loggedInCustomerId,
        orderLimit: 10,
      });
      if (ctxData?.recentOrders?.length) {
        const sizes = [];
        for (const o of ctxData.recentOrders) {
          for (const item of o.items || []) {
            const s = parseSize(typeof item === "string" ? item : item?.title || item?.variantTitle || "");
            if (s != null) sizes.push(s);
          }
        }
        if (sizes.length > 0) {
          const freq = new Map();
          for (const s of sizes) freq.set(s, (freq.get(s) || 0) + 1);
          const modal = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
          historyRes = { modalSize: modal[0], orders: sizes.length };
        }
      }
    } catch {
      historyRes = null;
    }
  }

  // Anchor size: customer hint > history > null.
  const hinted = parseSize(customerSizeHint);
  const baseSize = hinted != null ? hinted : (historyRes?.modalSize ?? null);

  // Score directional fit signals. Positive = size up, negative = size down.
  const signals = [];
  let directionalNumerator = 0;
  let directionalDenominator = 0;

  // Always surface where the base size came from, so the card has at least
  // one explanatory line even when no review/return/external data exists.
  if (hinted != null) {
    signals.push({
      source: "customer_hint",
      weight: 0,
      direction: "base",
      summary: `Based on the size you mentioned (${formatSize(hinted)}).`,
    });
  }

  if (reviewRes && !reviewRes.error) {
    const fc = reviewRes.fitCounts || {};
    const total = (fc.runs_small || 0) + (fc.runs_large || 0) + (fc.true_to_size || 0);
    if (total >= 3) {
      const raw = ((fc.runs_small || 0) - (fc.runs_large || 0)) / total;
      directionalNumerator += raw * weights.reviews;
      directionalDenominator += weights.reviews;
      const direction = raw > 0.15 ? "up" : raw < -0.15 ? "down" : "base";
      signals.push({
        source: "reviews",
        weight: weights.reviews,
        direction,
        summary:
          direction === "up"
            ? `Reviewers say it runs small (${fc.runs_small}/${total} fit mentions).`
            : direction === "down"
            ? `Reviewers say it runs large (${fc.runs_large}/${total} fit mentions).`
            : `Reviewers say it's true to size (${fc.true_to_size}/${total} fit mentions).`,
      });
    }
  }

  if (returnRes && !returnRes.error && returnRes.sizingReasons) {
    const sr = returnRes.sizingReasons;
    const total = (sr.too_small || 0) + (sr.too_big || 0);
    if (total >= 2) {
      const raw = ((sr.too_small || 0) - (sr.too_big || 0)) / total;
      directionalNumerator += raw * weights.returns;
      directionalDenominator += weights.returns;
      const direction = raw > 0.2 ? "up" : raw < -0.2 ? "down" : "base";
      signals.push({
        source: "returns",
        weight: weights.returns,
        direction,
        summary:
          direction === "up"
            ? `Returns skew "too small" (${sr.too_small} vs ${sr.too_big}).`
            : direction === "down"
            ? `Returns skew "too big" (${sr.too_big} vs ${sr.too_small}).`
            : `Return data is balanced on sizing.`,
      });
    }
  }

  if (historyRes?.modalSize != null) {
    signals.push({
      source: "history",
      weight: weights.history,
      direction: "base",
      summary: `Your usual size across ${historyRes.orders} past item(s) is ${formatSize(historyRes.modalSize)}.`,
    });
  }

  if (externalRes && externalRes.size != null) {
    const sizeNum = parseSize(externalRes.size);
    if (sizeNum != null) {
      signals.push({
        source: "external",
        weight: weights.external,
        direction: "base",
        summary: String(externalRes.summary || `Scan/fit data suggests size ${formatSize(sizeNum)}.`),
      });
    }
  }

  // Aggregate.
  const directional = directionalDenominator > 0 ? directionalNumerator / directionalDenominator : 0;
  const adjustment = directional > 0.4 ? 0.5 : directional < -0.4 ? -0.5 : 0;

  let recommendedSizeNum = null;
  // Prefer external absolute recommendation if confident.
  if (externalRes?.size != null && parseSize(externalRes.size) != null) {
    recommendedSizeNum = parseSize(externalRes.size);
  } else if (baseSize != null) {
    recommendedSizeNum = roundToHalf(baseSize + adjustment);
  }

  // Confidence scoring.
  let confidence = 30;
  if (reviewRes && !reviewRes.error && reviewRes.fitCounts) {
    const totalFit = (reviewRes.fitCounts.runs_small || 0) + (reviewRes.fitCounts.runs_large || 0) + (reviewRes.fitCounts.true_to_size || 0);
    if (totalFit >= 10) confidence += 20;
    else if (totalFit >= 3) confidence += 10;
  }
  if (returnRes && !returnRes.error && returnRes.sizingReasons) {
    const totalRet = (returnRes.sizingReasons.too_small || 0) + (returnRes.sizingReasons.too_big || 0);
    if (totalRet >= 5) confidence += 15;
    else if (totalRet >= 2) confidence += 8;
  }
  if (historyRes?.orders >= 3) confidence += 20;
  else if (historyRes?.orders >= 1) confidence += 10;
  if (externalRes?.confidence != null && Number.isFinite(externalRes.confidence)) {
    confidence = Math.max(confidence, Math.min(100, Math.round(externalRes.confidence)));
  }
  // Agreement bonus.
  if (signals.length >= 2) {
    const nonBase = signals.filter((s) => s.direction === "up" || s.direction === "down");
    if (nonBase.length >= 2) {
      const allSame = nonBase.every((s) => s.direction === nonBase[0].direction);
      if (allSame) confidence += 10;
    }
  }
  confidence = Math.max(0, Math.min(95, confidence));

  const recommendedSize = recommendedSizeNum != null ? formatSize(recommendedSizeNum) : null;
  const recommendedVariantInStock = recommendedSize
    ? isSizeAvailable(product, recommendedSize, { width: requestedWidth })
    : false;
  const reasons = signals.map((s) => s.summary);
  if (recommendedSize && !recommendedVariantInStock) {
    const widthText = requestedWidth ? ` ${requestedWidth}` : "";
    reasons.push(`Size ${recommendedSize}${widthText} is not currently in stock for this product.`);
  }
  const shouldDisplay = recommendedSize != null && recommendedVariantInStock && confidence >= minConfidence;

  if (adjustment !== 0 && baseSize != null) {
    reasons.push(adjustment > 0
      ? `Applied +0.5 adjustment from your usual size.`
      : `Applied -0.5 adjustment from your usual size.`);
  }

  console.log(
    `[fit] handle=${h} base=${baseSize ?? "-"} adj=${adjustment} rec=${recommendedSizeNum ?? "-"} conf=${confidence} signals=${signals.map((s) => s.source).join(",") || "-"}`,
  );

  return {
    handle: h,
    productTitle: product.title,
    recommendation: {
      recommendedSize: recommendedSizeNum != null ? formatSize(recommendedSizeNum) : null,
      baseSize: baseSize != null ? formatSize(baseSize) : null,
      adjustment,
      confidence,
      signals,
      reasons,
      sizesAvailable,
      widthsAvailable,
      requestedWidth,
      recommendedVariantInStock,
      shouldDisplay,
    },
  };
}

// VIP-only tool. Only added to the tools list when the customer is logged in
// and the shop has vipModeEnabled. Operates strictly on the HMAC-verified
// loggedInCustomerId from the request context — never accepts a customer id
// from the AI's arguments.

export const REVIEWS_TOOL = {
  name: "get_product_reviews",
  description:
    "What customers say about one product: rating, review count, fit (runs small / true to size / large) and recent review snippets. Use for questions about fit, comfort, quality or what other buyers think.",
  input_schema: {
    type: "object",
    properties: { handle: { type: "string", description: "Product handle from a search result or shown card." } },
    required: ["handle"],
  },
};

export { getProductReviews, getReturnInsights, getFitRecommendation };
