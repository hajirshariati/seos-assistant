// Fetches a customer's loyalty status from Yotpo Loyalty & Referrals so the
// AI can reference points, tier, and a personal referral link in the chat.
//
// Uses the Yotpo Loyalty API (loyalty.yotpo.com). The merchant's Loyalty
// Merchant API Key is stored encrypted in ShopConfig.yotpoLoyaltyApiKey.
// This is a different key from the reviews API key (yotpoApiKey).

const YOTPO_API = "https://loyalty.yotpo.com/api/v2";

const CACHE = new Map();
const TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.t > TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return e.v;
}

function cacheSet(key, v) {
  CACHE.set(key, { v, t: Date.now() });
}

export async function fetchYotpoLoyalty({ apiKey, guid, email }) {
  if (!apiKey || !email) return null;
  const cacheKey = `${apiKey.slice(0, 8)}:${email}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const url = `${YOTPO_API}/customers?customer_email=${encodeURIComponent(email)}`;
    const headers = {
      "x-api-key": apiKey,
      accept: "application/json",
    };
    if (guid) headers["x-guid"] = guid;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      if (res.status === 404) {
        cacheSet(cacheKey, null);
        return null;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`Yotpo Loyalty ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // Don't log raw email — Shopify reviewers inspect logs for PII.
    console.log(`[yotpo-loyalty] points=${data?.points_balance ?? "?"} tier=${data?.vip_tier_name || data?.tier || "none"} hasReferral=${Boolean(data?.perkea_referral_link || data?.referral_url || data?.referralUrl || data?.referral_link)}`);
    const result = {
      pointsBalance: data?.points_balance ?? null,
      creditBalance: data?.credit_balance ?? null,
      tier: data?.vip_tier_name || data?.tier || null,
      tierProgress: data?.vip_tier_progress_percentage ?? null,
      referralUrl:
        data?.perkea_referral_link ||
        data?.referral_url ||
        data?.referralUrl ||
        data?.referral_link ||
        data?.share_link ||
        data?.shareable_link ||
        null,
      availableRewards: Array.isArray(data?.redemption_options)
        ? data.redemption_options
            .filter((r) => r?.is_redeemable)
            .slice(0, 3)
            .map((r) => ({ name: r.name, cost: r.cost_text || `${r.cost_in_points} pts` }))
        : [],
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    console.warn(`[yotpo-loyalty] lookup failed: ${e.message}`);
    cacheSet(cacheKey, null);
    return null;
  }
}
