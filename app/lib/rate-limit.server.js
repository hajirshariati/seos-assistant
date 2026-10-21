// Per-shopper rate limit for the storefront routes that cost the store money
// (chat, See It Styled, feedback). In memory, per server instance.
//
// The shopper's IP comes from X-Forwarded-For, which a determined visitor can
// vary, so chat also has store-wide ceilings (per minute and per hour) that
// no header can get around: they bound what a bot farm can spend.

const RATE_LIMIT_PER_IP_SHOP = parseInt(process.env.RATE_LIMIT_PER_IP_SHOP, 10) || 20;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS, 10) || 10_000;
export const CHAT_STORE_PER_MIN = parseInt(process.env.CHAT_STORE_PER_MIN, 10) || 60;
export const CHAT_STORE_PER_HOUR = parseInt(process.env.CHAT_STORE_PER_HOUR, 10) || 1500;
const ipShopBuckets = new Map();

export function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

export function checkIpShopRate(shop, ip, { scope = "chat", limit = RATE_LIMIT_PER_IP_SHOP, windowMs = RATE_LIMIT_WINDOW_MS } = {}) {
  const key = `${scope}|${shop}|${ip}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = (ipShopBuckets.get(key) || []).filter((t) => t > cutoff);
  if (bucket.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket[0] + windowMs - now) / 1000));
    ipShopBuckets.set(key, bucket);
    return { ok: false, retryAfter };
  }
  bucket.push(now);
  ipShopBuckets.set(key, bucket);
  if (ipShopBuckets.size > RATE_LIMIT_MAX_KEYS) {
    let evict = ipShopBuckets.size - RATE_LIMIT_MAX_KEYS;
    for (const k of ipShopBuckets.keys()) {
      if (evict <= 0) break;
      if (k === key || k.startsWith("chat-store-")) continue;
      ipShopBuckets.delete(k);
      evict -= 1;
    }
  }
  return { ok: true };
}

// Store-wide chat ceilings. Checked after the per-shopper limit, so one busy
// visitor doesn't use up the store's allowance.
export function checkStoreChatRate(shop) {
  const minute = checkIpShopRate(shop, "*", { scope: "chat-store-min", limit: CHAT_STORE_PER_MIN });
  if (!minute.ok) return minute;
  return checkIpShopRate(shop, "*", { scope: "chat-store-hour", limit: CHAT_STORE_PER_HOUR, windowMs: 60 * 60_000 });
}

if (!globalThis.__shopagentRateSweeper) {
  globalThis.__shopagentRateSweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of ipShopBuckets) {
      const cutoff = now - (key.startsWith("chat-store-hour|") ? 60 * 60_000 : RATE_LIMIT_WINDOW_MS);
      const filtered = bucket.filter((t) => t > cutoff);
      if (filtered.length === 0) ipShopBuckets.delete(key);
      else ipShopBuckets.set(key, filtered);
    }
  }, RATE_LIMIT_WINDOW_MS);
  globalThis.__shopagentRateSweeper.unref?.();
}
