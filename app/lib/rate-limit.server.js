// Per-shopper rate limit for the storefront routes that cost the store money
// (chat, See It Styled, feedback). In memory, per server instance.
//
// The shopper's IP comes from X-Forwarded-For, which a determined visitor can
// vary, so chat also has store-wide ceilings (per minute and per hour) that
// no header can get around: they bound what a bot farm can spend. The store
// sets them in Settings → Peak Mode (peak-mode.js); 0 means no limit.

const RATE_LIMIT_PER_IP_SHOP = parseInt(process.env.RATE_LIMIT_PER_IP_SHOP, 10) || 20;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS, 10) || 10_000;
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
// visitor doesn't use up the store's allowance. Both windows are checked
// before either is counted, so a message turned away by the hourly limit
// doesn't use up a slot in the minute. limits: { perMin, perHour }, 0 = none.
export function checkStoreChatRate(shop, { perMin = 0, perHour = 0 } = {}) {
  const now = Date.now();
  const windows = [
    { key: `chat-store-min|${shop}|*`, limit: perMin, windowMs: RATE_LIMIT_WINDOW_MS },
    { key: `chat-store-hour|${shop}|*`, limit: perHour, windowMs: 60 * 60_000 },
  ];
  for (const w of windows) {
    if (!(w.limit > 0)) { ipShopBuckets.delete(w.key); continue; }
    const bucket = (ipShopBuckets.get(w.key) || []).filter((t) => t > now - w.windowMs);
    ipShopBuckets.set(w.key, bucket);
    // A lowered limit frees its next slot when the message `limit` places
    // from the newest ages out.
    if (bucket.length >= w.limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket[bucket.length - w.limit] + w.windowMs - now) / 1000)) };
    }
  }
  for (const w of windows) if (w.limit > 0) ipShopBuckets.get(w.key).push(now);
  return { ok: true };
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
