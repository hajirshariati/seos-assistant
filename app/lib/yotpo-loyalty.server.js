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

// Keyed by the customer's email and holds their points and referral link, so
// it stays small: expired entries are dropped as new ones come in, and the
// oldest go first past the limit.
const CACHE_MAX = 500;
function cacheSet(key, v) {
  const now = Date.now();
  CACHE.set(key, { v, t: now });
  if (CACHE.size <= CACHE_MAX) return;
  for (const [k, e] of CACHE) if (now - e.t > TTL_MS) CACHE.delete(k);
  for (const k of CACHE.keys()) {
    if (CACHE.size <= CACHE_MAX) break;
    CACHE.delete(k);
  }
}

// A customer's points history, as Yotpo lists it (history_items): newest
// first, each entry's day, what it was for, the points (negative when spent
// or taken back), its status (e.g. pending until the return window passes)
// and the order it belongs to. Field names vary across Yotpo's versions, so
// each is read from the names it's known by; entries without points or a
// day are skipped. Pure.
const pick = (o, keys) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
export function loyaltyHistory(data, max = 30) {
  const raw = [data?.history_items, data?.history, data?.points_history].find(Array.isArray) || [];
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const pv = pick(h, ["points", "points_earned", "amount", "points_amount"]);
    const points = typeof pv === "number" ? pv : Number.parseFloat(String(pv ?? "").replace(/,/g, ""));
    const when = Date.parse(String(pick(h, ["date", "created_at", "completed_at", "updated_at"]) || ""));
    if (!Number.isFinite(points) || !Number.isFinite(when)) continue;
    const date = new Date(when).toISOString().slice(0, 10);
    const action = String(pick(h, ["action", "action_name", "action_display_name", "description", "title", "name"]) || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const status = String(pick(h, ["status", "state"]) || "").trim().slice(0, 30);
    const order = pick(h, ["order_id", "order_ids", "order_name", "order_number"]);
    out.push({
      date,
      action: action || (points < 0 ? "Points taken" : "Points added"),
      points,
      ...(status ? { status } : {}),
      ...(order !== undefined ? { order: (Array.isArray(order) ? order.join(", ") : String(order)).slice(0, 60) } : {}),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, max);
}

export async function fetchYotpoLoyalty({ apiKey, guid, email, history = false }) {
  if (!apiKey || !email) return null;
  const cacheKey = `${apiKey.slice(0, 8)}:${history ? "h:" : ""}${email}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const url = `${YOTPO_API}/customers?customer_email=${encodeURIComponent(email)}${history ? "&with_history=true" : ""}`;
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
    // The history's shape (field names only, never values), to confirm it in the logs.
    if (history) {
      const items = [data?.history_items, data?.history, data?.points_history].find(Array.isArray);
      console.log(`[yotpo-loyalty] history: ${items ? `${items.length} items, fields=${Object.keys(items[0] || {}).slice(0, 15).join(",")}` : `none (keys=${Object.keys(data || {}).slice(0, 25).join(",")})`}`);
    }
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
      ...(history ? { history: loyaltyHistory(data), historyListed: [data?.history_items, data?.history, data?.points_history].some(Array.isArray) } : {}),
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    // Not "no account": the lookup itself failed (the chat says it couldn't check).
    console.warn(`[yotpo-loyalty] lookup failed: ${e.message}`);
    const failed = { unavailable: true };
    cacheSet(cacheKey, failed);
    return failed;
  }
}
